"""Replaceable local inference for V4 entity, relevance and semantics providers."""

from functools import lru_cache
from threading import RLock
from typing import Protocol
import json

import numpy as np
from scipy.special import softmax

from cpu_runtime import check_cancelled, cpu_workers, managed_job, operator

from .model_profiles import MODELS, ROOT, weights_installed


class ContextProvider(Protocol):
    def rank(self, pairs: list[tuple[str, str]]) -> np.ndarray: ...
    def classify(self, sentences: list[str]) -> list[dict]: ...
    def sentiment(self, sentences: list[str]) -> list[dict]: ...
    def embed(self, sentences: list[str]) -> np.ndarray: ...
    def entities(self, sentences: list[str], *, targeted: bool = True) -> list[list[dict]]: ...


PROPOSITIONS = {
    "explicit_need": "The author says they need or want a solution to a problem.",
    "recommendation_request": "The author asks other people to recommend a product or solution.",
    "unmet_need": "The author has not found an existing solution that meets the need.",
    "partial_solution": "The author has a solution that meets only some important requirements.",
    "solution_satisfied": "The author actually tried something that fully solved the problem for them.",
    "solution_recommended": "The author recommends a specific option to someone else.",
    "solution_rejected": "The author says that a proposed solution did not work for them.",
    "purchase_intent": "The author is planning or considering a purchase in the future.",
    "purchased": "The author reports that they already paid for or bought the product.",
    "workaround": "The author describes a stopgap or an alternative way to get around a problem.",
}

ENTITY_TYPES = {
    "brand": "commercial name under which a product is sold, excluding stores and manufacturers used as such",
    "company": "manufacturer, publisher or legal company name",
    "product": "a named product rather than an entire product category",
    "series": "commercial family or generation of related products",
    "model": "a specific commercial product model or model identifier",
    "category": "generic category or subcategory of a commercial or open-source product",
    "attribute": "quality or technical characteristic of a product",
    "feature": "named functionality that the product provides",
    "workaround": "a concrete alternate or temporary solution to a problem",
}


class OnnxModel:
    def __init__(self, key, max_tokens):
        import onnxruntime as ort
        from tokenizers import Tokenizer

        root = ROOT / key
        self.config = json.loads((root / "config.json").read_text(encoding="utf-8"))
        self.tokenizer = Tokenizer.from_file(str(root / "tokenizer.json"))
        pad = int(self.config.get("pad_token_id") or 0)
        self.tokenizer.enable_padding(pad_id=pad, pad_token=self.tokenizer.id_to_token(pad) or "[PAD]")
        self.tokenizer.enable_truncation(max_length=max_tokens)
        options = ort.SessionOptions()
        options.intra_op_num_threads = cpu_workers()
        options.inter_op_num_threads = 1
        options.add_session_config_entry("session.intra_op.allow_spinning", "0")
        options.add_session_config_entry("session.inter_op.allow_spinning", "0")
        self.session = ort.InferenceSession(str(root / MODELS[key].file), sess_options=options,
                                           providers=["CPUExecutionProvider"])
        self.inputs = {item.name for item in self.session.get_inputs()}

    def infer(self, passages):
        for start in range(0, len(passages), 12):
            check_cancelled()
            encoded = self.tokenizer.encode_batch(passages[start:start + 12])
            mask = np.array([item.attention_mask for item in encoded], dtype=np.int64)
            inputs = {"input_ids": np.array([item.ids for item in encoded], dtype=np.int64),
                      "attention_mask": mask,
                      "token_type_ids": np.array([item.type_ids for item in encoded], dtype=np.int64)}
            yield self.session.run(None, {k: v for k, v in inputs.items() if k in self.inputs})[0], mask

    @managed_job("local_onnx")
    def logits(self, passages):
        with operator("onnx_batch", cpu_workers()):
            return np.concatenate([out for out, _ in self.infer(passages)])


class LocalContext:
    def __init__(self):
        self.lock = RLock()

    @lru_cache(maxsize=4)
    def _onnx(self, key):
        return OnnxModel(key, {"nli": 144, "rerank": 256, "context": 128, "sentiment": 192}[key])

    @lru_cache(maxsize=1)
    def _entities(self):
        import torch
        from gliner2 import AutoExtractor

        torch.set_num_threads(cpu_workers())
        return AutoExtractor.from_pretrained(str(ROOT / "entities"), local_files_only=True).eval()

    @managed_job("reranker")
    def rank(self, pairs):
        if not pairs:
            return np.empty(0)
        with self.lock:
            return self._onnx("rerank").logits(pairs).ravel()

    @managed_job("nli")
    def classify(self, sentences):
        if not sentences:
            return []
        names = list(PROPOSITIONS)
        with self.lock:
            model = self._onnx("nli")
            index = model.config["label2id"]["entailment"]
            pairs = [(sentence, proposition) for sentence in sentences for proposition in PROPOSITIONS.values()]
            probabilities = softmax(model.logits(pairs), axis=1)[:, index].reshape(-1, len(names))
        return [dict(zip(names, map(float, values))) for values in probabilities]

    @managed_job("contextual_sentiment")
    def sentiment(self, sentences):
        if not sentences:
            return []
        clean = [" ".join("@user" if word.startswith("@") and len(word) > 1 else "http" if word == "<url>"
                          else word for word in sentence.split()) for sentence in sentences]
        with self.lock:
            model = self._onnx("sentiment")
            labels = model.config["id2label"]
            probabilities = softmax(model.logits(clean), axis=1)
        return [dict((labels[str(i)], float(value)) for i, value in enumerate(row)) for row in probabilities]

    @managed_job("contextual_embedding")
    def embed(self, sentences):
        if not sentences:
            return np.empty((0, 384), dtype=np.float32)
        with self.lock, operator("onnx_context", cpu_workers()):
            vectors = []
            for embeddings, mask in self._onnx("context").infer(sentences):
                vectors.append((embeddings * mask[..., None]).sum(axis=1) / np.maximum(1, mask.sum(axis=1, keepdims=True)))
            return np.concatenate(vectors).astype(np.float32)

    @managed_job("open_entities")
    def entities(self, sentences, *, targeted=True):
        if not sentences:
            return []
        schema = ENTITY_TYPES if targeted else ["person", "organization", "product", "location"]
        with self.lock:
            rows = self._entities().batch_extract_entities(
                sentences, schema, batch_size=8, threshold=.62, include_confidence=True, include_spans=True,
                max_len=300, overlap_policy="nested")
        return [[{"text": value["text"], "type": label, "start": value["start"], "end": value["end"],
                  "score": float(value["confidence"]), "method": "gliner2.5_targeted" if targeted else "gliner2.5_generic"}
                 for label, values in row.get("entities", {}).items() for value in values
                 if isinstance(value, dict) and value.get("start") is not None and value.get("end") is not None]
                for row in rows]


@lru_cache(maxsize=1)
def local_context():
    return LocalContext()


def enabled(profile, key, override=None):
    return bool(getattr(profile, key) and (override is not None or weights_installed(key)))

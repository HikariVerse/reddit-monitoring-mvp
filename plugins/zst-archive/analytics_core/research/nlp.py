"""Optional linguistic providers. Statistical features remain separate from model/FTS tokens."""

from collections import defaultdict
from functools import lru_cache
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path
import re
from threading import RLock
from typing import Protocol

import textproc

from .intents import split_sentences


class LinguisticProvider(Protocol):
    def analyze(self, texts: list[str]) -> list[dict]: ...


class OpenEntityProvider(Protocol):
    def extract(self, text: str) -> list[dict]: ...


NAMES = ("spacy", "en-core-web-sm", "lingua-language-detector", "jieba",
         "vaderSentiment", "rapidfuzz", "pyahocorasick", "networkx", "datasketch", "gliner", "gliner2",
         "onnxruntime", "statsmodels", "ruptures", "mlxtend", "pint", "scipy", "scikit-learn")


def installed_versions():
    versions = {}
    for name in NAMES:
        try:
            versions[name] = version(name)
        except PackageNotFoundError:
            versions[name] = None
    return versions


def baseline_record(text):
    lang, confidence = textproc.detect_language(text)
    return {"language": lang, "language_confidence": confidence,
            "language_method": "script_stopword", "sentences": split_sentences(text, 24),
            "tokens": [], "noun_phrases": [], "entities": [], "topic_tokens": [],
            "sentiment": None, "syntax": "not_available"}


class SpaCyProvider:
    def __init__(self):
        import spacy
        from .semantics import dependency_matcher
        self.pipeline = spacy.load("en_core_web_sm")
        if not {"tagger", "parser", "lemmatizer", "ner"} <= set(self.pipeline.pipe_names):
            raise RuntimeError("英文语言学配置需要 tagger/parser/lemmatizer/ner")
        versions = installed_versions()
        self.lock = RLock()
        self.matcher = dependency_matcher(self.pipeline)
        self.detector = self._language_detector() if versions["lingua-language-detector"] else None
        self.vader = self._vader() if versions["vaderSentiment"] else None
        self.zh_tokenizer = self._jieba() if versions["jieba"] else None

    @staticmethod
    def _language_detector():
        from lingua import LanguageDetectorBuilder
        return LanguageDetectorBuilder.from_all_languages().with_low_accuracy_mode().build()

    @staticmethod
    def _vader():
        from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
        return SentimentIntensityAnalyzer()

    @staticmethod
    def _jieba():
        from jieba import Tokenizer
        return Tokenizer()

    def analyze(self, texts):
        from .semantics import dependency_records
        records = [baseline_record(text) for text in texts]
        if self.detector:
            for text, record in zip(texts, records):
                if sum(ch.isalpha() for ch in text) < 10 or (
                    record["language"] == "en" and len(re.findall(r"[^\W\d_]+", text)) < 8
                ):
                    continue
                confidence = self.detector.compute_language_confidence_values(text[:4000])
                if confidence:
                    best = confidence[0]
                    margin = best.value - (confidence[1].value if len(confidence) > 1 else 0)
                    suggested = best.language.iso_code_639_1.name.lower()
                    record["language_candidate"] = {"code": suggested, "score": best.value, "margin": margin}
                    if margin >= .15 and (suggested == record["language"] or record["language_confidence"] < .66):
                        record["language"] = suggested
                        record["language_confidence"] = best.value
                        record["language_method"] = "lingua"
        en = [i for i, record in enumerate(records) if record["language"] == "en"]
        with self.lock:
            parsed = self.pipeline.pipe((texts[i][:12000] for i in en), batch_size=64)
            for i, doc in zip(en, parsed):
                record = records[i]
                record.update(syntax="spacy_en_core_web_sm", sentences=[s.text.strip() for s in doc.sents if s.text.strip()],
                              dependencies=dependency_records(self.matcher, doc),
                              tokens=[{"text": t.text, "lemma": t.lemma_, "pos": t.pos_, "dep": t.dep_,
                                       "head": t.head.i, "start": t.idx, "end": t.idx + len(t)} for t in doc],
                              noun_phrases=[{"text": span.text, "start": span.start_char, "end": span.end_char,
                                             "label": " ".join(t.text.casefold() for t in span if not t.is_stop
                                                               and (t.pos_ in {"NOUN", "PROPN", "ADJ"}
                                                                    or t.dep_ in {"amod", "compound"})),
                                             "head": span.root.lemma_, "head_pos": span.root.pos_}
                                            for span in doc.noun_chunks],
                              entities=[{"text": ent.text, "type": ent.label_, "start": ent.start_char,
                                         "end": ent.end_char, "method": "spacy_ner"} for ent in doc.ents],
                              topic_tokens=[t.lemma_.lower() for t in doc if t.is_alpha and not t.is_stop
                                            and t.pos_ in {"NOUN", "PROPN", "ADJ", "VERB"}])
                if self.vader:
                    record["sentiment"] = self.vader.polarity_scores(texts[i])
            for text, record in zip(texts, records):
                if record["language"] == "zh" and self.zh_tokenizer:
                    record["topic_tokens"] = [word for word in self.zh_tokenizer.cut(text, HMM=False)
                                              if len(word) > 1 and any(c.isalpha() for c in word)]
                    record["word_segmentation"] = "jieba"
        return records


class GLiNERProvider:
    LABELS = ["brand", "product model", "product category", "product attribute",
              "organization", "budget", "purchase price", "workaround"]

    def __init__(self, model_dir):
        path = Path(model_dir)
        if not path.is_dir():
            raise ValueError("GLiNER 需要本地模型目录")
        from gliner import GLiNER
        onnx = path / "model_quantized.onnx"
        options = {"load_onnx_model": True, "onnx_model_file": onnx.name} if onnx.is_file() else {}
        self.model = GLiNER.from_pretrained(str(path.resolve()), local_files_only=True, **options)

    def extract(self, text):
        return [{"text": row["text"], "type": row["label"], "start": row["start"], "end": row["end"],
                 "score": float(row["score"]), "method": "gliner_local"}
                for row in self.model.predict_entities(text[:2200], self.LABELS, threshold=.55)]


@lru_cache(maxsize=2)
def get_provider(profile):
    from .model_profiles import PROFILES, profile_name
    if not PROFILES[profile_name(profile)].syntax:
        return None
    try:
        return SpaCyProvider()
    except (ImportError, OSError) as exc:
        raise RuntimeError("语言学配置需要 spaCy 及本地英文模型 en_core_web_sm") from exc


def phrase_support(records, seed_terms):
    """Rank corpus noun phrases with their syntactic head and observed document support."""
    roots = {seed.lower().split()[-1].removesuffix("s") for seed in seed_terms if seed.strip()}
    evidence = defaultdict(set)
    for doc_id, record in records.items():
        for phrase in record["noun_phrases"]:
            if phrase["head"].lower() in roots and phrase["head_pos"] in {"NOUN", "PROPN"}:
                text = (phrase.get("label") or phrase["text"]).casefold().strip()
                if 1 < len(text.split()) <= 5 and len(text) <= 45:
                    evidence[text].add(doc_id)
    return [{"term": term, "df": len(ids), "evidence_ref": sorted(ids)[:5]}
            for term, ids in sorted(evidence.items(), key=lambda pair: (-len(pair[1]), pair[0]))
            if len(ids) >= 2][:40]


def annotate_span(text, record, start, end):
    """Return an overlapping open entity and local dependency evidence for a source span."""
    tokens = [t for t in record.get("tokens", ()) if t["end"] > start and t["start"] < end]
    entity = next((e for e in record.get("entities", ()) if e["end"] > start and e["start"] < end), None)
    if not tokens and entity is None:
        return {}
    sentence = next((s for s in record.get("sentences", ()) if text[start:end] in s), "")
    return {"tokens": tokens[:12], "entity_candidate": entity, "sentence": sentence[:350]}

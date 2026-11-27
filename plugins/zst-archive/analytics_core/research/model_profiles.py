"""Offline model catalog and explicit cost budgets for the V4 engine."""

from dataclasses import dataclass
from pathlib import Path
import hashlib
import json
import os


@dataclass(frozen=True)
class ModelSpec:
    repo: str
    revision: str
    license: str
    file: str
    auxiliary: tuple[str, ...] = ("config.json", "tokenizer.json")

    @property
    def files(self):
        return (self.file, *self.auxiliary)


MODELS = {
    "entities": ModelSpec("fastino/gliner2.5-small-v1", "b5d42bf7dc7d01c40304ae4ed43c2f13c325a75b", "Apache-2.0",
                          "model.safetensors", ("config.json", "encoder_config/config.json", "tokenizer.json", "tokenizer_config.json")),
    "rerank": ModelSpec("cross-encoder/ms-marco-MiniLM-L6-v2", "233902d25c440f23af6f7d6e94d2946bac0bee0a", "Apache-2.0",
                        "onnx/model_quint8_avx2.onnx"),
    "nli": ModelSpec("onnx-community/mDeBERTa-v3-base-xnli-multilingual-nli-2mil7-ONNX",
                     "cdc8277b4682665e2f2e87cd83da7da07b153d75", "MIT", "onnx/model_int8.onnx"),
    "context": ModelSpec("sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2",
                         "e8f8c211226b894fcb81acc59f3b34ba3efd5f42", "Apache-2.0", "onnx/model_quint8_avx2.onnx"),
    "sentiment": ModelSpec("Xenova/twitter-roberta-base-sentiment-latest", "f3ec4d0925f90c3ca7ee7814f52d6ee7cf180445",
                           "See CardiffNLP upstream model card", "onnx/model_int8.onnx"),
}


@dataclass(frozen=True)
class Profile:
    syntax: bool = False
    knowledge: bool = False
    entities: int = 0
    rerank: int = 0
    nli: int = 0
    context: int = 0
    sentiment: int = 0


PROFILES = {
    "fast": Profile(),
    "balanced": Profile(syntax=True, knowledge=True),
    "deep": Profile(True, True, 240, 180, 96, 320, 240),
    "experimental": Profile(True, True, 600, 400, 240, 600, 500),
}
LEGACY_NAMES = {"baseline": "fast", "linguistic": "balanced", "recommended": "balanced"}
ROOT = Path(os.environ.get("RESEARCH_V4_MODEL_HOME", Path(__file__).resolve().parents[2] / "models" / "v4"))


def profile_name(name):
    name = LEGACY_NAMES.get(name, name)
    if name not in PROFILES:
        raise ValueError(f"unknown analysis profile {name!r}")
    return name


def weights_installed(key):
    spec = MODELS[key]
    root = ROOT / key
    try:
        record = json.loads((root / "deployment.json").read_text(encoding="utf-8"))
        return record["revision"] == spec.revision and all(
            (root / path).stat().st_size == record["files"][path]["bytes"] > 0 for path in spec.files)
    except (OSError, KeyError, TypeError, ValueError):
        return False


def profile_manifest(name):
    name = profile_name(name)
    profile = PROFILES[name]
    models = {
        key: {"repo": spec.repo, "revision": spec.revision, "budget": getattr(profile, key),
              "installed": weights_installed(key)} for key, spec in MODELS.items() if getattr(profile, key)
    }
    manifest = {"profile": name, "syntax": profile.syntax, "knowledge": profile.knowledge, "models": models}
    if models:
        manifest["routing_revision"] = "context-evidence-4.1"
    return manifest


def profile_fingerprint(name):
    return hashlib.sha256(json.dumps(profile_manifest(name), sort_keys=True).encode()).hexdigest()[:16]

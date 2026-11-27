"""Programmatic entry points. Callers provide standardized documents and an encoder."""

from dataclasses import asdict, dataclass, field
from typing import Iterable, Protocol
import hashlib
import json
import time

import numpy as np
import pandas as pd
from cpu_runtime import managed_job

from . import common as CM, mod_listening, mod_market, mod_opportunity, mod_product, mod_social
from . import quality, registry, relevance, segments
from .scope import ScopeData


class Encoder(Protocol):
    def encode(self, texts: list[str], *, batch_size: int, max_tokens: int) -> np.ndarray: ...


@dataclass(frozen=True)
class Document:
    source_id: str
    source_type: str
    dataset_id: str
    document_id: str
    text: str
    thread_id: str = ""
    parent_id: str = ""
    title: str = ""
    created_utc: int | None = None
    kind: str = "post"
    community: str = ""
    author_key: str = ""
    engagement: int = 0
    language: str = ""
    url: str = ""
    platform: str = ""
    metadata: dict = field(default_factory=dict)
    domain: str = ""
    content_type: str = ""
    observed_at: int | None = None
    thread_created_utc: int | None = None


@dataclass(frozen=True)
class AnalysisConfig:
    name: str
    seeds: list[str]
    months: list[str] = field(default_factory=list)
    sampling: str = "provided"
    sample_seed: int = 42
    kind: str = "all"
    min_score: int = -1000
    min_chars: int = 1
    near_dup: bool = True
    lang: str = ""
    n_clusters: int = 8
    clustering: str = "kmeans"
    nlp_profile: str = "baseline"


class DataAdapter(Protocol):
    def load(self, config: AnalysisConfig) -> Iterable[Document]: ...


MODULES = {"product": mod_product, "listening": mod_listening, "social": mod_social,
           "opportunity": mod_opportunity, "market": mod_market}


def extract_features(documents, config: AnalysisConfig, encoder: Encoder, *, data_version: str,
                     linguistic_provider=None, open_entity_provider=None, context_provider=None, domain_provider=None):
    if not config.seeds or not data_version:
        raise ValueError("分析主题及输入数据版本不能为空")
    values = []
    if hasattr(documents, "load"):
        documents = documents.load(config)
    for document in documents:
        ns = json.dumps([document.source_id, document.dataset_id], ensure_ascii=False, separators=(",", ":"))
        values.append({**asdict(document), "doc_id": ns + ":" + document.document_id,
                       "thread_id": ns + ":" + (document.thread_id or document.document_id),
                       "parent_id": ns + ":" + document.parent_id if document.parent_id else "",
                       "author": ns + ":" + document.author_key if document.author_key else "",
                       "score": document.engagement, "thread_title": document.title})
    frame = pd.DataFrame(values)
    if not frame.empty:
        if frame.doc_id.duplicated().any():
            raise ValueError("输入文档 ID 重复")
        dates = pd.to_datetime(frame["created_utc"], unit="s", utc=True, errors="coerce")
        frame["date"], frame["month"] = dates.dt.date, dates.dt.strftime("%Y-%m")
        frame["hour"], frame["dow"] = dates.dt.hour, dates.dt.day_of_week
        if config.months:
            frame = frame[frame["month"].isin(config.months)].reset_index(drop=True)
    frame.attrs["version"] = data_version
    data = relevance.extract_scope(frame, config, encoder, ScopeData, linguistic_provider=linguistic_provider,
                                   open_entity_provider=open_entity_provider, context_provider=context_provider,
                                   domain_provider=domain_provider)
    from .scope import VERSIONS
    providers = {k: getattr(provider, "revision", type(provider).__qualname__) for k, provider in {
        "linguistic": linguistic_provider, "open_entity": open_entity_provider, "context": context_provider,
        "encoder": encoder}.items() if provider is not None}
    revisions = {k: v() if callable(v) else v for k, v in providers.items()}
    raw = json.dumps([data_version, VERSIONS, asdict(config), values, data.meta["provider_manifest"],
                      data.meta["domain_version"], revisions, data.meta["model"]], sort_keys=True, ensure_ascii=False, default=str)
    data.meta.update(scope_id=hashlib.sha256(raw.encode()).hexdigest()[:20], build_seconds=0, versions=VERSIONS)
    if context_provider:
        data.cache["context_provider"] = context_provider
    return data


@managed_job("v4_analysis")
def run(analysis_id, features, encoder, config: AnalysisConfig | None = None, *, refresh=False):
    definition = registry.REGISTRY.get(analysis_id)
    module = definition["module"] if definition else analysis_id
    if module not in MODULES:
        raise KeyError(analysis_id)
    parameters = {"k": config.n_clusters if config else 8, "method": config.clustering if config else "kmeans"}
    key = (module, *parameters.values())
    cached = features.cache.get(key)
    if cached is None or refresh:
        t0 = time.perf_counter()
        if features.n:
            kwargs = {}
            if module in {"product", "opportunity"}:
                segment_key = ("segments", *parameters.values())
                if segment_key not in features.cache:
                    features.cache[segment_key] = segments.build_segments(features, encoder, **parameters)
                kwargs["seg_data"] = {"segments": [dict(s) for s in features.cache[segment_key]["segments"]],
                                      **{k: v for k, v in features.cache[segment_key].items() if k != "segments"}}
            out = MODULES[module].compute(features, encoder, **kwargs)
            from . import v4_metrics
            v4_metrics.enhance(module, features, encoder, out)
        else:
            out = {"module": module, "metrics": {}, "charts": {}, "insight": []}
            mid = {"listening": "SL02", "market": "MI03"}.get(module)
            if mid:
                from .populations import archive_attention
                out["metrics"][mid] = archive_attention(features, mid, 1 if mid == "SL02" else 1_000_000)
        out["runtime_ms"] = round((time.perf_counter() - t0) * 1000, 1)
        cached = quality.finalize(features, module, out, out["runtime_ms"], parameters)
        features.cache[key] = cached
    return cached["metrics"][analysis_id] if definition else cached


def resolve_evidence(features, evidence_ref, limit=12):
    if isinstance(evidence_ref, dict):
        from .evidence import replay
        return replay(features, evidence_ref, limit)
    return features.evidence(list(evidence_ref), k=max(0, min(limit, 100)))


def comparison_row(features):
    df = features.docs
    if not len(df):
        return None
    from .stats import hhi
    counts = CM.brand_counts(df)
    return {"scope_id": features.meta["scope_id"], "name": features.meta["spec"]["name"], "docs": features.n,
            "need_density": float(CM.need_mask(df).mean()), "neg_rate": CM.sent_distribution(df)["neg_rate"],
            "brand_coverage": float(CM.known_brand_mask(df).mean()), "brand_hhi": hhi(list(counts.values())),
            "communities": features.meta["quality"]["communities"],
            "avg_chars": features.meta["quality"]["avg_chars"],
            "top_brands": [{"brand": CM.brand_label(b), "docs": n} for b, n in counts.most_common(5)],
            "sampling": features.meta["spec"]["sampling"]}

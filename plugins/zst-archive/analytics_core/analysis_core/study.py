"""Headless execution, scoped populations and exact evidence membership."""

from collections import Counter, defaultdict
from copy import deepcopy
from dataclasses import asdict
from datetime import date, datetime, timezone
import hashlib
import json
from time import perf_counter

from cpu_runtime import configure_cpu

configure_cpu()

import numpy as np
import pandas as pd

from cpu_runtime import AnalysisCancelled, SCHEDULER, check_cancelled, managed_job, operator
from research import features, relevance
from research.batching import ordered_map

from .catalog import ALIASES, CONDITIONAL, PANELS, SELECTED, VERSION
from .inputs import Config, Filters, channels, from_document, identity, utc_seconds


class UnavailableDependency(RuntimeError):
    pass


def stable_id(value):
    raw = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"), allow_nan=False)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:24]


def utc_day(value):
    return datetime.fromtimestamp(value, timezone.utc).date().isoformat() if value is not None else None


def maybe_timestamp(value):
    return int(value) if pd.notna(value) else None


def groups_for(rows, ids, key, *, known=True):
    groups = defaultdict(list)
    for i in ids:
        value = rows[i][key]
        if not known or value is not None and value != "":
            groups[value].append(i)
    return groups


def as_text(value):
    return str(value) if pd.notna(value) else ""


import re

_CODING_SEEDS = {"cursor", "windsurf", "claude", "codex", "agent", "coding", "ide", "copilot"}
_MOUSE_NOISE_RE = re.compile(
    r"\b(?:mouse|mouse cursor|cursor (?:speed|size|blink|block|beam|shape|disappear\w*|stuck|flicker\w*|invisible|lag\w*|moves?|moving|position|icon|arrow|jumps?|jumping|freez\w*|drifts?)|"
    r"move (?:the |my )?cursor|number key cursor|normal mode and a beam|trackpad|touchpad|pointer|crosshair|gamepad|joystick|controller|"
    r"hover(?:ing)?|left[- ]?click|right[- ]?click|middle[- ]?click|dpi|logitech|razer|screen edge|second monitor|dual monitor)\b",
    re.I,
)
_CODING_CTX_RE = re.compile(
    r"\b(?:ai|llm|agent|claude|gpt|openai|anthropic|windsurf|copilot|codebase|prompt|coding|ide|tabnine|vscode|vs code|repo|pull request|token|mcp|composer|sonnet|opus|deepseek|gemini|typescript|python|refactor\w*)\b",
    re.I,
)
_POWER_SEEDS = {"ecoflow", "jackery", "bluetti", "power", "station", "portable", "solar"}
_GRID_WAR_NOISE_RE = re.compile(
    r"\b(?:nuclear (?:power|plant|waste|reactor)|ukraine|ukrainian|russia|russian|missile|drone strike|coal[- ]fired|hydroelectric|power plant|substation)\b",
    re.I,
)
_PORTABLE_POWER_CTX_RE = re.compile(
    r"\b(?:portable|ecoflow|jackery|bluetti|anker|delta|river|explorer|ac70|ac200|lifepo4|camping|vanlife|cpap|inverter|solar panel|watt[- ]?hour|wh\b)\b",
    re.I,
)
_AUDIO_SEEDS = {"shokz", "openfit", "openrun", "aerofit", "earbuds", "headphones", "ear"}
_DATING_TRADING_NOISE_RE = re.compile(
    r"\b(?:\d{2}\s*\[[mf]4[mfa]\]|m4f|f4m|r4r|trade for other|trading card)\b",
    re.I,
)
_GEMINI_SEEDS = {"gemini"}
_ZODIAC_NOISE_RE = re.compile(
    r"\b(?:horoscope|zodiac|astrology|aries|taurus|scorpio|aquarius|pisces|virgo|libra|sagittarius|capricorn|birth chart|rising sign)\b",
    re.I,
)


def _polysemy_exclusion_reason(norm: str, seeds: tuple[str, ...]) -> str | None:
    """General domain-context polysemy guard (S1-05): filters clear cross-domain collisions transparently."""
    if not seeds:
        return None
    seed_set = {s.lower().strip('"\'() ') for s in seeds}
    if (seed_set & _CODING_SEEDS) and _MOUSE_NOISE_RE.search(norm) and not _CODING_CTX_RE.search(norm):
        return "polysemy_mouse_cursor"
    if (seed_set & _POWER_SEEDS) and _GRID_WAR_NOISE_RE.search(norm) and not _PORTABLE_POWER_CTX_RE.search(norm):
        return "polysemy_utility_grid"
    if (seed_set & _AUDIO_SEEDS) and _DATING_TRADING_NOISE_RE.search(norm):
        return "polysemy_offtopic_personal"
    if (seed_set & _GEMINI_SEEDS) and _ZODIAC_NOISE_RE.search(norm) and not _CODING_CTX_RE.search(norm):
        return "polysemy_zodiac"
    return None


def _plain_admission(texts):
    normalized = relevance.normalize_batch(texts)
    return [(norm, {"focus": norm, "method": "provided_scope", "focus_coordinates": [
        {"focus": [0, len(norm)], "normalized": [0, len(norm)]}]}) for norm in normalized]


class Study:
    """An immutable input population and lazily calculated, reusable artifacts."""

    def __init__(self, rows, core, *, config, data_version, study_id, dedupe, coverage_days=None,
                 archive_meta=None, archive_resolver=None, encoder=None, vectors=None, features_by_index=None):
        self.rows = rows
        self.core = tuple(core)
        self.config = config
        self.data_version = data_version
        self.id = study_id
        self.dedupe = dedupe
        self.coverage_days = dict(coverage_days or {})
        if any(date.fromisoformat(day).isoformat() != day or state not in {"complete", "partial", "missing"}
               for day, state in self.coverage_days.items()):
            raise ValueError("Invalid collection coverage")
        self.archive_meta = archive_meta or {}
        self.archive_resolver = archive_resolver
        self.encoder = encoder
        self.initial_vectors = vectors
        self.v4_features = features_by_index or {}
        self.by_id = {row["document_id"]: i for i, row in enumerate(self.rows)}
        if len(self.by_id) != len(self.rows):
            raise ValueError("Duplicate canonical document ID")
        self._artifacts = {}
        self._results = {}
        self._evidence = {}
        self._vector_cache = {}
        self._counts = Counter()
        self._timings = defaultdict(float)

    @classmethod
    @managed_job("first_batch_ingest")
    def ingest(cls, documents, *, data_version, config=None, coverage_days=None, encoder=None):
        if not isinstance(data_version, str) or not data_version:
            raise ValueError("data_version is required")
        config = config or Config()
        items = documents.load(config) if hasattr(documents, "load") else documents
        rows = []
        from textproc import detect_language
        for value in items:
            document = from_document(value)
            fields = asdict(document)
            if any(not isinstance(v, str) for key, v in fields.items()
                   if key not in {"created_utc", "observed_at", "engagement_channels"}) or any(
                       not fields[key] for key in ("source_id", "source_type", "dataset_id", "document_id")):
                raise ValueError("Document identifiers and text must be strings, with source and IDs present")
            ns = (document.source_id, document.dataset_id)
            stamp = utc_seconds(document.created_utc)
            group = fields[{"source": "source_id", "dataset": "dataset_id"}.get(config.group_by, config.group_by)]
            if config.group_by == "language" and not group:
                group = detect_language(document.text)[0]
            rows.append({**fields, "source_document_id": document.document_id,
                         "document_id": identity(*ns, document.document_id), "thread_id": identity(*ns, document.thread_id),
                         "parent_id": identity(*ns, document.parent_id), "author_key": identity(*ns, document.author_key),
                         "created_utc": stamp, "observed_at": utc_seconds(document.observed_at),
                         "day": utc_day(stamp), "group": group, "engagement_channels": channels(document.engagement_channels)})
        rows.sort(key=lambda row: row["document_id"])
        study_id = stable_id([VERSION, data_version, asdict(config), coverage_days, rows])
        texts = [row["text"] for row in rows]
        args = (config.seeds,) if config.seeds else ()
        batches = ordered_map(relevance.admit_batch if args else _plain_admission, texts, *args, label="selected_relevance")
        candidates = []
        polysemy_excluded = Counter()
        for index, (norm, admitted) in enumerate(pair for batch in batches for pair in batch):
            row = rows[index]
            excl = _polysemy_exclusion_reason(norm, config.seeds)
            if excl:
                polysemy_excluded[excl] += 1
                row.update(norm=norm, focus="", admission=f"excluded:{excl}", focus_coordinates=())
                continue
            row.update(norm=norm, focus=admitted["focus"], admission=admitted["method"],
                       focus_coordinates=admitted.get("focus_coordinates", ()))
            if row["focus"] and len(norm) >= config.min_chars:
                candidates.append({"doc_id": row["document_id"], "norm": norm, "text": row["text"]})
        with operator("selected_dedupe"):
            kept, dedupe = features.dedupe(pd.DataFrame(candidates, columns=["doc_id", "norm", "text"]),
                                           near=config.near_duplicates)
        keep = set(kept.doc_id)
        return cls(rows, (i for i, row in enumerate(rows) if row["document_id"] in keep), config=config,
                   data_version=data_version, study_id=study_id, dedupe=dedupe, coverage_days=coverage_days,
                   encoder=encoder)

    @classmethod
    @managed_job("first_batch_load_v4")
    def from_v4(cls, scope, *, config=None, encoder=None, archive_resolver=None):
        """Reuse archived V4 population and unchanged Potion document vectors."""
        meta = scope.meta
        config = config or Config(tuple(meta.get("spec", {}).get("seeds", ())))
        rows, parsed = [], {}
        for frame in (scope.docs, scope.context):
            for record in frame.itertuples(index=False):
                stamp = maybe_timestamp(record.created_utc)
                source = as_text(getattr(record, "source_type", None) or "reddit_archive")
                dataset = as_text(getattr(record, "dataset_id", "")) or "reddit_open_archive"
                group = {"group": as_text(record.community), "source": source, "dataset": dataset,
                         "kind": as_text(record.kind), "language": as_text(getattr(record, "lang", ""))}[config.group_by]
                score = maybe_timestamp(record.score)
                values = {"score": score} if score is not None else {}
                if record.kind == "post" and pd.notna(getattr(record, "n_comments", None)):
                    values["reported_comments"] = int(record.n_comments)
                relevance_record = record.relevance or {}
                focus = as_text(record.focus)
                rows.append({"source_id": source, "source_type": source, "dataset_id": dataset,
                             "source_document_id": record.doc_id, "document_id": record.doc_id,
                             "thread_id": record.thread_id, "parent_id": as_text(getattr(record, "parent_id", "")),
                             "author_key": as_text(record.author), "group": group, "kind": as_text(record.kind),
                             "created_utc": stamp, "observed_at": maybe_timestamp(getattr(record, "observed_at", None)),
                             "day": utc_day(stamp), "title": as_text(record.title), "url": as_text(getattr(record, "url", "")),
                             "language": as_text(getattr(record, "lang", "")), "engagement_channels": values,
                             "text": as_text(record.text), "norm": as_text(record.norm), "focus": focus,
                             "admission": relevance_record.get("method"), "focus_coordinates": relevance_record.get("focus_coordinates", ())})
                if frame is scope.docs:
                    parsed[len(rows) - 1] = {"entities": getattr(record, "entities", []) or [],
                                             "attrs": record.attrs or []}
        coverage = {row["date"]: "complete" for row in meta.get("archive_daily", ())}
        source_version = meta.get("data_version", "archive")
        study_id = stable_id([VERSION, meta.get("scope_id"), source_version, asdict(config)])
        return cls(rows, range(scope.n), config=config, data_version=source_version, study_id=study_id,
                   dedupe=meta.get("dedupe", {}), coverage_days=coverage, archive_meta=meta,
                   archive_resolver=archive_resolver, encoder=encoder, vectors=np.asarray(scope.emb), features_by_index=parsed)

    def _artifact(self, name, build):
        check_cancelled()
        if name not in self._artifacts:
            start = perf_counter()
            self._artifacts[name] = build()
            self._counts[name] += 1
            self._timings[name] += perf_counter() - start
        return self._artifacts[name]

    def _view(self, filters):
        return self._artifact(("view", filters), lambda: tuple(i for i in self.core if self.matches(i, filters)))

    def matches(self, index, filters):
        row = self.rows[index]
        day = row["day"]
        return ((not filters.start or day is not None and day >= filters.start)
                and (not filters.end or day is not None and day <= filters.end)
                and (not filters.groups or row["group"] in filters.groups)
                and (not filters.sources or row["source_id"] in filters.sources)
                and (not filters.kinds or row["kind"] in filters.kinds))

    def evidence(self, ids, **predicate):
        indices = tuple(sorted(set(map(int, ids))))
        key = (indices, stable_id(predicate))
        return self._put_evidence(key, indices, predicate, len(indices))

    def _put_evidence(self, key, indices, predicate, count):
        ref = "ev:" + stable_id([self.id, key])
        self._evidence.setdefault(ref, (indices, predicate, count))
        return {"id": ref, "member_count": count, "predicate": predicate}

    def external_evidence(self, count, **query):
        return self._put_evidence(("query", query), None, query, count)

    @managed_job("first_batch_evidence")
    def resolve_evidence(self, evidence_ref, *, offset=0, limit=30):
        key = evidence_ref if isinstance(evidence_ref, str) else evidence_ref["id"]
        if key not in self._evidence:
            raise KeyError(key)
        if not isinstance(offset, int) or not isinstance(limit, int) or offset < 0 or not 1 <= limit <= 100:
            raise ValueError("Evidence pages require offset >= 0 and 1 <= limit <= 100")
        indices, predicate, count = self._evidence[key]
        if indices is None:
            if self.archive_resolver is None:
                return {"id": key, "state": "unavailable_dependency", "total": count, "offset": offset,
                        "predicate": predicate, "items": [], "reason": "Archive evidence resolver required"}
            items = self.archive_resolver(predicate, offset, limit)
        else:
            page = indices[offset:offset+limit]
            items = [deepcopy(self.rows[i]) for i in page]
            needs_features = any(name in predicate for name in ("amount_role", "stage", "sentiment", "state"))
            if items and (needs_features or "span" in predicate):
                from .semantic import replay_claim
                for i, item in zip(page, items, strict=True):
                    item["claim"] = replay_claim(self, i, predicate)
        return {"id": key, "state": "ready", "total": count, "offset": offset, "predicate": deepcopy(predicate), "items": items,
                "has_more": offset + len(items) < count}

    @staticmethod
    def _encoder_identity(encoder):
        return (getattr(encoder, "model_id", None) or type(encoder).__qualname__) if encoder is not None else "potion-int8"

    def embed(self, texts, max_tokens):
        if self.encoder is None:
            try:
                from research.deps import get_encoder
                self.encoder = get_encoder()
            except (ImportError, OSError) as exc:
                raise UnavailableDependency("Potion model files are unavailable") from exc
        keys = [(max_tokens, text) for text in texts]
        missing = list(dict.fromkeys(key for key in keys if key not in self._vector_cache))
        if missing:
            vectors = self.encoder.encode([key[1] for key in missing], batch_size=128, max_tokens=max_tokens)
            if vectors.ndim != 2 or len(vectors) != len(missing) or not np.isfinite(vectors).all():
                raise ValueError("Encoder returned invalid vectors")
            for key, value in zip(missing, vectors, strict=True):
                self._vector_cache[key] = value
        return np.stack([self._vector_cache[key] for key in keys]) if keys else np.empty((0, 0), dtype=np.float32)

    def model(self):
        return self.archive_meta.get("model") or {"name": self._encoder_identity(self.encoder),
                                                  "profile": self.config.profile}

    def vectors(self):
        if self.initial_vectors is not None:
            return self.initial_vectors
        return self._artifact("document_vectors", lambda: self.embed([self.rows[i]["focus"] for i in self.core], 256))

    def run(self, metric_id, filters=None, *, refresh=False, cancel=None):
        with SCHEDULER.job("first_batch_metric", cancel):
            return self._run(metric_id, filters or Filters(), refresh)

    def _run(self, metric_id, filters, refresh):
        from . import recipes

        canonical = ALIASES.get(metric_id, metric_id)
        spec = SELECTED.get(canonical) or CONDITIONAL[canonical]
        key = (canonical, filters)
        if refresh or key not in self._results:
            indices = self._view(filters)
            start = perf_counter()
            try:
                state, reason, data = recipes.calculate(self, canonical, indices, filters)
            except UnavailableDependency as exc:
                state, reason, data = "unavailable_dependency", str(exc), {}
            except AnalysisCancelled:
                raise
            except Exception as exc:
                state, reason, data = "failed", f"{type(exc).__name__}: {exc}", {}
            result = {"schema_version": VERSION, "metric_id": canonical, "title": spec.title,
                      "state": state, "reason": reason, "unit": spec.unit, "method": spec.method,
                      "study_id": self.id, "data_version": self.data_version, "filters": asdict(filters),
                      "selected_documents": len(indices), "sample_unit": "deduplicated_document",
                      "elapsed_seconds": round(perf_counter() - start, 6), "data": data}
            if state not in {"failed", "unavailable_dependency"}:
                self._results[key] = result
        else:
            result = self._results[key]
        return {**result, "requested_metric": metric_id}

    def panel(self, panel_id, filters=None, *, refresh=False, cancel=None):
        panel = PANELS[panel_id]
        with SCHEDULER.job("first_batch_panel", cancel):
            return {"schema_version": VERSION, "panel_id": panel_id, "title": panel.title, "chart": panel.chart,
                    "filters": asdict(filters or Filters()), "study_id": self.id,
                    "metrics": [self._run(mid, filters or Filters(), refresh) for mid in panel.metrics]}

    def run_all(self, filters=None, *, refresh=False, cancel=None):
        with SCHEDULER.job("first_batch_all", cancel):
            return {mid: self._run(mid, filters or Filters(), refresh) for mid in SELECTED}

    def timings(self):
        return [{"artifact": str(key), "builds": int(count), "seconds": self._timings[key]}
                for key, count in self._counts.items() if not isinstance(key, tuple)]

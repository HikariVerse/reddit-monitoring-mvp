"""ResearchScope：统一研究范围 + 全量语料定向建库（FTS5 加速）。

为什么不用"全域随机抽样"：
    选品/舆情永远从一个具体品类出发，全域抽样下一个品类只剩几十条，结论不可用。
    因此本项目采用 **query-first**：先用 DuckDB/FTS 在全量归档里召回相关讨论，
    形成"定向语料库"，再在库内做分析。

FTS 加速：
    index/fts_*.sqlite 是 FTS5 表 docs(title, body, comments_text)，rowid = posts.doc_id。
    单词命中查询 1–3 ms（4.4k 命中），远快于 parquet LIKE 全扫。
    短语查询不支持（detail=none），因此多词种子用 AND 组合。
"""

from __future__ import annotations

import hashlib
from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
import json
import os
import re
import sqlite3
import threading
import time
from dataclasses import dataclass, field, asdict
from pathlib import Path

import duckdb
import numpy as np
import pandas as pd
from cpu_runtime import AnalysisCancelled, SCHEDULER, check_cancelled, cpu_workers, managed_job, operator

from . import entities as E
from . import features as F
from . import lexicon as L
from . import populations as P
from . import relevance as R
from .model_profiles import profile_fingerprint, profile_name

VERSIONS = {'engine': 'v4.0.1', 'preprocess': 'p4', 'lexicon': 'l4', 'rules': 'r4.1', 'features': 'f4.1',
            'entities': 'e4', 'evidence': 'ev4', 'model': 'potion-int8-v1', 'metrics': 'v4'}

ROOT = Path(__file__).resolve().parents[2]
ARCHIVE = Path(os.environ.get("BI_ARCHIVE_ROOT", "D:/reddit-data/open-packages"))
SCOPES = ROOT / "data" / "scopes-v4"

MONTHS_ALL = ["2026-08", "2026-09", "2026-10"]
_TOK = re.compile(r"[^\W_]{2,}", re.UNICODE)


@dataclass
class ScopeSpec:
    name: str
    seeds: list[str]
    months: list[str] = field(default_factory=lambda: list(MONTHS_ALL))
    subreddits: list[str] = field(default_factory=list)
    kind: str = "all"                  # all | post | comment
    min_score: int = -1000
    lang: str = ""                     # "" = all
    max_threads_per_month: int = 2500
    min_chars: int = 40
    near_dup: bool = True
    synonyms: bool = True
    sample_seed: int = 42
    notes: str = ""

    sampling: str = "month"
    nlp_profile: str = "baseline"

    def __post_init__(self):
        if not self.months or not all(re.fullmatch(r"\d{4}-(?:0[1-9]|1[0-2])", m) for m in self.months):
            raise ValueError("月份应使用 YYYY-MM 格式")
        if self.sampling not in {"full", "fts_only", "random", "month", "date", "community"}:
            raise ValueError("未知抽样策略")
        self.nlp_profile = profile_name(self.nlp_profile)
        if self.max_threads_per_month < 1 or self.min_chars < 0:
            raise ValueError("线程上限应大于零，最小长度不能为负")
        self.months = sorted(set(self.months))
        self.subreddits = sorted({x.strip().lower() for x in self.subreddits if x.strip()})

    def key(self) -> str:
        from .nlp import installed_versions

        params = {k: v for k, v in asdict(self).items() if k != "notes"}
        params["profile_manifest"] = profile_fingerprint(self.nlp_profile)
        packages = installed_versions()
        params["feature_packages"] = {name: packages[name] for name in ("pyahocorasick", "pint")}
        if self.nlp_profile != "fast":
            from .knowledge import DomainProvider
            params["nlp_packages"] = packages
            params["domain_provider"] = DomainProvider().revision()
        raw = json.dumps([params, VERSIONS, archive_version(self.months)], sort_keys=True, ensure_ascii=False)
        return hashlib.sha256(raw.encode("utf-8")).hexdigest()[:20]


def archive_version(months):
    manifest_hashes = []
    for month in months:
        manifest = ARCHIVE / month / "manifest.json"
        manifest_hashes.append(hashlib.sha256(manifest.read_bytes()).hexdigest() if manifest.exists() else month)
    return hashlib.sha256("|".join([str(ARCHIVE.resolve()), *manifest_hashes]).encode()).hexdigest()[:20]


# --------------------------------------------------------------------------- #
# FTS 召回
# --------------------------------------------------------------------------- #
def _fts_query(seeds: list[str]) -> str:
    parts = {}
    for s in seeds:
        toks = list(dict.fromkeys(_TOK.findall(s.casefold())))
        if not toks:
            continue
        terms = ' AND '.join(f'"{token}"' for token in toks)
        parts[terms if len(toks) == 1 else f"({terms})"] = None
    return " OR ".join(parts)


def _fts_shard(task):
    month, shard, query = task
    path = ARCHIVE / month / "index" / f"fts_{shard}.sqlite"
    if not path.is_file():
        raise FileNotFoundError(f"缺少归档 FTS 分片 {path}")
    with closing(sqlite3.connect(path.resolve().as_uri() + "?mode=ro", uri=True, timeout=5)) as con:
        return [row[0] for row in con.execute("SELECT rowid FROM docs WHERE docs MATCH ?", (query,))]


@managed_job("archive_fts")
def fts_candidates(seeds: list[str], months: list[str], progress=None) -> dict[str, list[int]]:
    """返回 {month: [post_doc_id, ...]}。"""
    q = _fts_query(seeds)
    if not q:
        return {}
    tasks = [(month, shard, q) for month in months for shard in range(4)]
    if not tasks:
        return {}
    out = {month: set() for month in months}
    with operator("sqlite_fts_read_only", min(cpu_workers(), len(tasks))) as workers:
        with ThreadPoolExecutor(max_workers=workers) as pool:
            consume = pool.map(_fts_shard, tasks) if workers > 1 else map(_fts_shard, tasks)
            for done, ((month, shard, _), rows) in enumerate(zip(tasks, consume, strict=True), 1):
                check_cancelled()
                overlap = out[month].intersection(rows)
                if overlap or len(set(rows)) != len(rows):
                    raise ValueError(f"FTS 线程重复 {month} shard{shard}")
                out[month].update(rows)
                if progress:
                    progress("fts", 0.05 + 0.15 * done / len(tasks),
                             f"FTS 召回 {month} shard{shard} 累计 {len(out[month])}")
    return {month: sorted(ids) for month, ids in out.items()}


# --------------------------------------------------------------------------- #
# 语料装配
# --------------------------------------------------------------------------- #
def _posts_file(month):
    return str(ARCHIVE / month / "corpus" / "posts.parquet")


def _ids_frame(ids):
    return pd.DataFrame({"id": np.asarray(ids, dtype=np.uint64)})


def _fetch_posts(con, month, ids):
    con.register("_ids", _ids_frame(ids))
    return con.execute("""
        SELECT p.doc_id, p.content_key, p.community, coalesce(p.score,0) AS score, p.created_utc,
               coalesce(p.title,'') AS title, coalesce(p.body,'') AS body,
               coalesce(p.content_type,'self') AS content_type,
               coalesce(p.domain,'') AS domain, coalesce(p.flair,'') AS flair,
               coalesce(p.is_truncated, false) AS is_truncated,
               coalesce(p.author_key,'') AS author, coalesce(p.reported_comments,0) AS n_comments
        FROM read_parquet(?) p JOIN _ids i ON i.id = p.doc_id
        ORDER BY p.doc_id
    """, [_posts_file(month)]).fetchdf()


def _fetch_comments(con, month, post_ids):
    con.register("_ids", _ids_frame(post_ids))
    return con.execute("""
        SELECT c.comment_id, c.post_doc_id, CAST(c.parent_key AS VARCHAR) AS parent_key,
               coalesce(c.score,0) AS score, c.created_utc, coalesce(c.body,'') AS body,
               coalesce(c.is_op,false) AS is_op, coalesce(c.author_key,'') AS author
        FROM read_parquet(?) c JOIN _ids i ON i.id = c.post_doc_id
        ORDER BY c.post_doc_id, c.created_utc, c.comment_id
    """, [str(ARCHIVE / month / "corpus" / "comments.parquet")]).fetchdf()


@managed_job("assemble_archive")
def assemble(spec: ScopeSpec, progress=None) -> tuple[pd.DataFrame, dict]:
    t0 = time.perf_counter()
    cands = fts_candidates(spec.seeds, spec.months, progress)
    fts_seconds = time.perf_counter() - t0
    frames = []
    threads = []
    with operator("duckdb_archive", cpu_workers()) as workers, duckdb.connect(config={"threads": workers}) as con:
        con.execute("SET memory_limit='6GB'")
        for month in spec.months:
            check_cancelled()
            if not cands.get(month):
                continue
            con.register("_ids", _ids_frame(cands[month]))
            hits = con.execute("""
                SELECT p.doc_id, coalesce(lower(p.community), 'unknown') AS community,
                       CAST(to_timestamp(p.created_utc) AT TIME ZONE 'UTC' AS DATE) AS date
                FROM read_parquet(?) p JOIN _ids i ON p.doc_id = i.id ORDER BY p.doc_id
            """, [_posts_file(month)]).fetchdf()
            if len(hits) != len(cands[month]) or hits.doc_id.duplicated().any():
                raise ValueError(f"{month} FTS rowid 与 posts.doc_id 无法一对一对账")
            if spec.subreddits:
                hits = hits[hits.community.isin(spec.subreddits)]
            threads.append(hits.assign(month=month))
        hits = pd.concat(threads, ignore_index=True) if threads else pd.DataFrame(
            columns=["doc_id", "community", "date", "month"])
        picked = P.sample(hits, spec.sampling, spec.max_threads_per_month, spec.sample_seed)
        for mi, (month, sub) in enumerate(picked.groupby("month", sort=True)):
            check_cancelled()
            if progress:
                progress("posts", 0.22 + 0.45 * mi / len(spec.months), f"{month} 装配 {len(sub)} 个线程")
            posts = _fetch_posts(con, month, sub.doc_id.tolist())
            frames.append(_posts_to_docs(posts, month))
            comms = _fetch_comments(con, month, posts["doc_id"].tolist())
            if not comms.empty:
                title_map = dict(zip(posts["doc_id"], posts["title"]))
                comm_map = dict(zip(posts["doc_id"], posts["community"].fillna("unknown").str.lower()))
                parent_map = dict(zip(posts["content_key"], "post:" + month + ":" + posts["doc_id"].astype(str)))
                parent_map.update(zip(comms["comment_id"], "c:" + month + ":" + comms["comment_id"].astype(str)))
                frames.append(_comments_to_docs(comms, month, title_map, comm_map, parent_map,
                                                dict(zip(posts.doc_id, posts.created_utc))))

    version = archive_version(spec.months)
    archive_daily = []
    for month in spec.months:
        ledger = ARCHIVE / month / "base" / "population_ledger.parquet"
        communities = tuple(spec.subreddits)
        if ledger.is_file():
            archive_daily.extend(P.ledger_total(((str(ledger), ledger.stat().st_mtime_ns),), communities))
        else:
            posts = Path(_posts_file(month))
            archive_daily.extend(P.parquet_thread_total((str(posts), posts.stat().st_mtime_ns), month, communities))
    filters = {"months": spec.months, "communities": spec.subreddits, "admission": "indexed_admitted_posts"}
    archive_n = sum(n for _, _, n in archive_daily)
    retrieved = P.Population("retrieval", "reddit_archive", version, "thread", len(hits), filters).record()
    archive = P.Population("archive", "reddit_archive", version, "thread", archive_n, filters).record()
    retrieved["query"] = _fts_query(spec.seeds)
    retrieved["index_contract"] = {"engine": "SQLite FTS5", "tokenizer": "unicode61", "detail": "none", "contentless": True,
                                  "or_between_seeds": True, "and_between_words": True, "positions": False,
                                  "column_filters": False, "scope": "whole indexed thread"}
    picked_counts = P.counts(picked)
    prob = picked["selection_probability"]
    population = {"archive": archive, "retrieval": retrieved}
    report = {"populations": population, "retrieval_counts": P.counts(hits),
              "assembly_timing": {"fts_seconds": fts_seconds,
                                  "total_seconds": time.perf_counter() - t0},
              "archive_daily": [{"month": m, "date": day, "count": n} for m, day, n in archive_daily],
              "sampled_threads": len(picked), "sampled_counts": picked_counts,
              "sampling": spec.sampling, "seed": spec.sample_seed,
              "selection_probability_range": [float(prob.min()), float(prob.max())] if len(prob) else None,
              "sampling_fraction": len(picked) / len(hits) if len(hits) else None}
    if not frames:
        return pd.DataFrame(), report
    df = pd.concat(frames, ignore_index=True)
    by_thread = picked.assign(thread_id=picked.month + ":" + picked.doc_id.astype(str)).set_index("thread_id")
    df["selection_probability"] = df["thread_id"].map(by_thread.selection_probability)
    df["sample_stratum"] = df["thread_id"].map(by_thread.sample_stratum)
    report["assembled"] = {str(k): int(v) for k, v in df.kind.value_counts().items()}
    stamps = pd.to_datetime(df["created_utc"], unit="s", errors="coerce", utc=True)
    df["date"], df["hour"], df["dow"] = stamps.dt.date, stamps.dt.hour, stamps.dt.day_of_week
    return df, report


def _posts_to_docs(posts: pd.DataFrame, month: str) -> pd.DataFrame:
    text = (posts["title"].fillna("") + "\n\n" + posts["body"].fillna(""))
    return pd.DataFrame({
        "doc_id": "post:" + month + ":" + posts["doc_id"].astype(str),
        "thread_id": month + ":" + posts["doc_id"].astype(str),
        "month": month,
        "kind": "post",
        "parent_id": "",
        "community": posts["community"].fillna("unknown").str.lower(),
        "author": posts["author"].fillna(""),
        "score": posts["score"].fillna(0).astype(int),
        "created_utc": posts["created_utc"].astype("int64"),
        "thread_created_utc": posts["created_utc"].astype("int64"),
        "title": posts["title"].fillna(""),
        "thread_title": posts["title"].fillna(""),
        "text": text,
        "n_comments": posts["n_comments"].fillna(0).astype(int),
        "is_op": False,
        "source_type": "reddit_archive",
        "content_type": posts.content_type,
        "domain": posts.domain,
        "flair": posts.flair,
        "is_truncated": posts.is_truncated,
    })


def _comments_to_docs(comms: pd.DataFrame, month: str, title_map: dict, comm_map: dict, parent_map=None, timestamps=None) -> pd.DataFrame:
    return pd.DataFrame({
        "doc_id": "c:" + month + ":" + comms["comment_id"].astype(str),
        "parent_id": comms["parent_key"].map(parent_map or {}).fillna(""),
        "raw_parent_id": comms["parent_key"].fillna(""),
        "thread_id": month + ":" + comms["post_doc_id"].astype(str),
        "month": month,
        "kind": "comment",
        "community": comms["post_doc_id"].map(comm_map).fillna("unknown"),
        "author": comms["author"].fillna(""),
        "score": comms["score"].fillna(0).astype(int),
        "created_utc": comms["created_utc"].astype("int64"),
        "thread_created_utc": comms["post_doc_id"].map(timestamps or {}),
        "title": comms["post_doc_id"].map(title_map).fillna(""),
        "thread_title": comms["post_doc_id"].map(title_map).fillna(""),
        "text": comms["body"].fillna(""),
        "n_comments": 0,
        "is_op": comms["is_op"].fillna(False).astype(bool),
        "source_type": "reddit_archive",
        "content_type": "comment",
        "domain": "",
    })


# --------------------------------------------------------------------------- #
# 语料对象
# --------------------------------------------------------------------------- #
class ScopeData:
    """内存中的研究语料：文档表 + 特征 + 向量 + 词典。"""

    def __init__(self, meta: dict, docs: pd.DataFrame, emb: np.ndarray, dictionary: E.Dictionary,
                 discovery: dict | None = None, context: pd.DataFrame | None = None):
        self.meta = meta
        self.docs = docs
        self.emb = emb
        self.dict = dictionary
        self.discovery = discovery or {}
        self.context = context if context is not None else docs.iloc[:0]
        self._emb_unit = None
        self.cache = {}

    # --- 便捷访问 ---
    @property
    def n(self) -> int:
        return len(self.docs)

    @property
    def unit_emb(self) -> np.ndarray:
        if self._emb_unit is None:
            e = self.emb
            self._emb_unit = e / np.maximum(np.linalg.norm(e, axis=1, keepdims=True), 1e-9)
        return self._emb_unit

    def docs_by_intent(self, *names: str) -> pd.DataFrame:
        s = set(names)
        mask = self.docs["intent_names"].map(lambda x: bool(s & set(x)))
        return self.docs[mask]

    def evidence(self, doc_ids: list[str], k: int = 8) -> list[dict]:
        if not doc_ids or k <= 0:
            return []
        d = self.docs
        sub = pd.concat([d[d["doc_id"].isin(doc_ids)],
                         self.context[self.context["doc_id"].isin(doc_ids)]], ignore_index=True).head(k * 3)
        if sub.empty:
            return []
        # 优先不同线程
        seen, rows = set(), []
        for r in sub.itertuples(index=False):
            if r.thread_id in seen and len(rows) >= k // 2:
                continue
            seen.add(r.thread_id)
            rows.append({
                "doc_id": r.doc_id, "thread_id": r.thread_id, "community": r.community,
                "date": str(r.date), "score": int(r.score), "kind": r.kind,
                "text": r.text[:600], "normalized_text": r.norm[:600], "intents": r.intent_names[:6],
                "source": getattr(r, "source_type", "reddit_archive"), "url": getattr(r, "url", ""),
                "parent_id": getattr(r, "parent_id", ""),
                "relevance": r.relevance, "demand_states": r.demand_states,
                "sent": r.sent_label, "brands": r.brands[:5], "attrs": r.attrs[:5],
                "entity_spans": getattr(r, "entities", [])[:8] if isinstance(getattr(r, "entities", None), list) else [],
                "opinions": getattr(r, "aspects", [])[:5] if isinstance(getattr(r, "aspects", None), list) else [],
                "relations": getattr(r, "relations", [])[:5] if isinstance(getattr(r, "relations", None), list) else [],
            })
            if len(rows) >= k:
                break
        return rows

    def embeddings_for(self, texts: list[str], encoder) -> np.ndarray:
        if not texts:
            return np.zeros((0, self.emb.shape[1] if self.emb.size else 256), dtype=np.float32)
        return encoder.encode(texts, batch_size=128, max_tokens=256)


# --------------------------------------------------------------------------- #
# 构建 / 缓存
# --------------------------------------------------------------------------- #
def _scope_dir(key: str) -> Path:
    p = SCOPES / key
    p.mkdir(parents=True, exist_ok=True)
    return p


def load_scope(key: str) -> ScopeData | None:
    if not re.fullmatch(r"[0-9a-f]{20}", key):
        return None
    d = SCOPES / key
    meta_p = d / "meta.json"
    if not meta_p.exists():
        return None
    meta = json.loads(meta_p.read_text(encoding="utf-8"))
    if meta.get("versions") != VERSIONS or ScopeSpec(**meta["spec"]).key() != key:
        return None
    docs = pd.read_parquet(d / "docs.parquet")
    docs = _parse_json_cols(docs)
    emb = np.load(d / "emb.npy")
    dict_p = d / "dict.json"
    dictionary = E.base_dictionary()
    if dict_p.exists():
        extra = json.loads(dict_p.read_text(encoding="utf-8"))
        dictionary = E.Dictionary(extra)
    disc_p = d / "discovery.json"
    disc = json.loads(disc_p.read_text(encoding="utf-8")) if disc_p.exists() else {}
    context = _parse_json_cols(pd.read_parquet(d / "context.parquet"))
    return ScopeData(meta, docs, emb, dictionary, disc, context)


JSON_COLS = ["tokens", "sentences", "intents", "intent_names", "entities", "aspects",
             "prices", "relations", "brands", "attrs", "scenarios", "models", "pains",
             "relevance", "demand_states", "solution_refs", "solution_links", "sent", "linguistic", "measurements", "raw_metadata"]


def _parse_json_cols(df: pd.DataFrame) -> pd.DataFrame:
    for c in JSON_COLS:
        if c in df.columns:
            df[c] = df[c].map(lambda x: json.loads(x) if isinstance(x, str) else (x if x is not None else []))
    if "date" in df.columns:
        df["date"] = pd.to_datetime(df["date"]).dt.date
    return df


def save_scope(key: str, data: ScopeData) -> None:
    d = _scope_dir(key)
    for filename, frame in (("docs.parquet", data.docs), ("context.parquet", data.context)):
        out = frame.copy()
        for c in JSON_COLS:
            if c in out.columns:
                out[c] = out[c].map(lambda x: json.dumps(x, ensure_ascii=False))
        out.to_parquet(d / filename, index=False)
    np.save(d / "emb.npy", data.emb.astype(np.float32))
    (d / "dict.json").write_text(json.dumps(data.dict.entries, ensure_ascii=False), encoding="utf-8")
    (d / "discovery.json").write_text(json.dumps(data.discovery, ensure_ascii=False, default=str), encoding="utf-8")
    temp = d / "meta.tmp"
    temp.write_text(json.dumps(data.meta, ensure_ascii=False, indent=1), encoding="utf-8")
    temp.replace(d / "meta.json")


JOBS: dict[str, dict] = {}
_BUILD_LOCK = threading.Lock()
_SCOPE_LOCKS = {}


@managed_job("build_v4_scope")
def build_scope(spec: ScopeSpec, encoder, progress=None) -> tuple[str, ScopeData]:
    key = spec.key()
    with _BUILD_LOCK:
        lock = _SCOPE_LOCKS.setdefault(key, threading.Lock())
    with lock:
        return _build_scope(spec, encoder, key, progress)


def _build_scope(spec, encoder, key, progress):
    t0 = time.time()
    cached = load_scope(key)
    if cached is not None:
        if progress:
            progress("cache", 1.0, "命中缓存")
        return key, cached

    if progress:
        progress("start", 0.02, f"研究范围：{spec.name}")

    raw, counts = assemble(spec, progress)
    data = R.extract_scope(raw, spec, encoder, ScopeData, counts, progress)
    data.meta.update(scope_id=key, built_at=time.strftime("%Y-%m-%d %H:%M:%S"),
                     build_seconds=round(time.time() - t0, 2), versions=VERSIONS)
    check_cancelled()
    save_scope(key, data)
    if progress:
        progress("done", 1.0, f"完成：{data.n} 篇 / {data.meta['build_seconds']}s")
    return key, data


def list_scopes() -> list[dict]:
    valid = []
    for meta_path in SCOPES.glob("*/meta.json"):
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if meta.get("versions") == VERSIONS and ScopeSpec(**meta["spec"]).key() == meta["scope_id"]:
            spec = meta["spec"]
            valid.append({"scope_id": meta["scope_id"], "name": spec["name"], "seeds": spec["seeds"],
                          "docs": meta["quality"]["docs"], "built_at": meta["built_at"],
                          "nlp_profile": spec.get("nlp_profile", "baseline"),
                          "build_seconds": meta["build_seconds"], "months": spec["months"]})
    return sorted(valid, key=lambda x: x["built_at"], reverse=True)


_CANCEL_EVENTS = {}


def cancel_scope_job(job_id):
    event = _CANCEL_EVENTS.get(job_id)
    if event is not None:
        event.set()
        return True
    return False


def create_scope_async(spec: ScopeSpec, encoder) -> str:
    job_id = hashlib.sha1(f"{time.time()}-{spec.key()}".encode()).hexdigest()[:10]
    cancel = _CANCEL_EVENTS[job_id] = threading.Event()
    JOBS[job_id] = {"job_id": job_id, "status": "queued", "pct": 0.0, "msg": "排队中",
                    "scope_id": spec.key(), "started": time.time(), "error": None}

    def progress(stage, pct, msg):
        JOBS[job_id].update({"pct": round(pct, 3), "msg": msg, "stage": stage})

    def run():
        try:
            with SCHEDULER.job("build_v4_scope", cancel):
                JOBS[job_id].update(status="running")
                key, _ = build_scope(spec, encoder, progress)
            JOBS[job_id].update({"status": "done", "pct": 1.0, "scope_id": key, "msg": "完成",
                                 "elapsed": round(time.time() - JOBS[job_id]["started"], 1)})
        except AnalysisCancelled:
            JOBS[job_id].update(status="cancelled", msg="已取消")
        except Exception as e:  # noqa
            JOBS[job_id].update({"status": "error", "error": str(e), "msg": str(e)})
        finally:
            _CANCEL_EVENTS.pop(job_id, None)

    threading.Thread(target=run, daemon=True).start()
    return job_id

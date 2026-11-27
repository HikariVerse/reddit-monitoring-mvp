"""FastAPI 路由：v2 研究范围 / 五大模块 / 实验室 / 指标中心 / 证据。"""

from __future__ import annotations

import json
import time
import threading
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel, Field
from cpu_runtime import managed_job

from . import common as CM
from . import engine
from . import lab as LAB
from .populations import attention_series
from . import registry as REG
from . import scope as SC
from . import topics
from .model_profiles import PROFILES, profile_manifest, profile_name

ROOT = Path(__file__).resolve().parents[2]
RUNS = ROOT / "data" / "runs-v4.json"
_RUN_LOCK = threading.Lock()
router = APIRouter(prefix="/api/v2", tags=["v2"])

MODULES = engine.MODULES

class ScopeIn(BaseModel):
    name: str = ""
    seeds: list[str] = Field(default_factory=list)
    months: list[str] = Field(default_factory=lambda: ["2026-08", "2026-09", "2026-10"])
    subreddits: list[str] = Field(default_factory=list)
    kind: Literal["all", "post", "comment"] = "all"
    min_score: int = -1000
    lang: str = ""
    max_threads: int = 2500
    min_chars: int = 40
    near_dup: bool = True
    sampling: Literal["month", "random", "date", "community", "full", "fts_only"] = "month"
    sample_seed: int = 42
    nlp_profile: Literal["fast", "balanced", "deep", "experimental", "baseline", "linguistic"] = "fast"


def _encoder():
    from research.deps import get_encoder  # 延迟导入，避免循环
    return get_encoder()


# --------------------------------------------------------------------------- #
# 数据资产
# --------------------------------------------------------------------------- #
@router.get("/assets")
def assets():
    meta_p = ROOT / "data" / "artifacts" / "meta.json"
    meta = json.loads(meta_p.read_text(encoding="utf-8")) if meta_p.exists() else {}
    ds = meta.get("dataset", {})
    daily = ds.get("daily", {})
    days = sorted(set(daily.get("dates", []) + daily.get("comments_dates", [])))
    return {
        "archive": {
            "path": str(SC.ARCHIVE),
            "months": ds.get("months", []),
            "totals": ds.get("totals", {}),
            "days": len(days),
            "date_range": [days[0], days[-1]] if days else None,
            "communities": len(ds.get("communities", [])),
            "manifest": ds.get("manifest", {}),
        },
        "schema": {
            "posts": ["doc_id", "community", "author_key", "score", "created_utc", "title", "body",
                      "content_type", "domain", "flair", "reported_comments", "is_truncated"],
            "comments": ["comment_id", "post_doc_id", "parent_key", "author_key", "score", "created_utc", "is_op", "body"],
            "ledger": ["month", "day_utc", "community", "total_posts", "valid_non_nsfw_posts", "admitted_posts"],
        },
        "index": {
            "fts": "index/fts_0..3.sqlite（FTS5，rowid = posts.doc_id，含 title/body/comments_text）",
            "vectors": f"{meta.get('index', {}).get('docs', 0)} × {meta.get('index', {}).get('dim', 256)}（全局样本）",
            "derived": "data/scopes-v4/{scope_id}/docs.parquet + context.parquet + emb.npy + meta.json",
        },
        "model": meta.get("model", {}).get("meta", {}),
        "baseline_sample": meta.get("sample", {}),
        "scope_count": len(SC.list_scopes()),
    }


@router.get("/nlp/profiles")
def nlp_profiles():
    from .nlp import installed_versions
    packages = installed_versions()
    linguistic = bool(packages["spacy"] and packages["en-core-web-sm"])
    manifest = {name: profile_manifest(name) for name in PROFILES}
    readiness = {name: (not item["syntax"] or linguistic) and all(m["installed"] for m in item["models"].values())
                 and (not item["models"] or bool(packages["gliner2"] and packages["onnxruntime"]))
                 for name, item in manifest.items()}
    return {"profiles": {**readiness, "baseline": True, "linguistic": linguistic},
            "manifests": manifest, "packages": packages}


@router.get("/scopes")
def scopes():
    return {"scopes": SC.list_scopes()}


@router.post("/scope")
def create_scope(body: ScopeIn):
    seeds = [s.strip() for s in body.seeds if s.strip()]
    if not seeds:
        raise HTTPException(400, "请至少输入一个关键词/品类/品牌")
    if not body.months or any(month not in SC.MONTHS_ALL for month in body.months):
        raise HTTPException(422, "请选择当前归档覆盖的月份")
    if not nlp_profiles()["profiles"][profile_name(body.nlp_profile)]:
        raise HTTPException(422, "当前配置所需的本地 Python 组件或模型权重未就绪")
    spec = SC.ScopeSpec(
        name=body.name or " / ".join(seeds[:3]), seeds=seeds, months=body.months,
        subreddits=body.subreddits, kind=body.kind, min_score=body.min_score, lang=body.lang,
        max_threads_per_month=max(1, min(8000, body.max_threads)), min_chars=max(0, body.min_chars),
        near_dup=body.near_dup, sampling=body.sampling, sample_seed=body.sample_seed, nlp_profile=body.nlp_profile,
    )
    if any(row["scope_id"] == spec.key() for row in SC.list_scopes()):
        return {"cached": True, "scope_id": spec.key()}
    job = SC.create_scope_async(spec, _encoder())
    return {"cached": False, "job_id": job, "scope_id": spec.key()}


@router.get("/scope/job/{job_id}")
def job_status(job_id: str):
    j = SC.JOBS.get(job_id)
    if not j:
        raise HTTPException(404, "job not found")
    return j


@router.post("/scope/job/{job_id}/cancel")
def cancel_job(job_id: str):
    if job_id not in SC.JOBS:
        raise HTTPException(404, "job not found")
    return {"requested": SC.cancel_scope_job(job_id), "status": SC.JOBS[job_id]["status"]}


def _sent(df):
    c = df["sent_label"].value_counts().to_dict()
    total = sum(c.values()) or 1
    return [{"label": k, "n": int(v), "pct": round(v / total * 100, 2)} for k, v in c.items()]


@lru_cache(maxsize=3)
def _get(sid: str) -> SC.ScopeData:
    d = SC.load_scope(sid)
    if d is None:
        raise HTTPException(404, f"scope {sid} 不存在，请先创建")
    return d


class FirstBatchView(BaseModel):
    start: str | None = None
    end: str | None = None
    groups: list[str] = Field(default_factory=list)
    sources: list[str] = Field(default_factory=list)
    kinds: list[str] = Field(default_factory=list)

    def filters(self):
        from analysis_core import Filters
        try:
            return Filters(**self.model_dump())
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc


@managed_job("first_batch_workbench_prepare")
@lru_cache(maxsize=2)
def _first_batch(sid, profile, group_by):
    from analysis_core import Config, Study
    from analysis_core.archive import resolve_archive
    scope = _get(sid)
    return Study.from_v4(scope, config=Config(tuple(scope.meta["spec"]["seeds"]), profile, group_by=group_by),
                         archive_resolver=resolve_archive)


@router.get("/first-batch/catalog")
def first_batch_catalog():
    from analysis_core import manifest
    return manifest()


@router.post("/scope/{sid}/first-batch/{item_id}")
def first_batch_result(sid: str, item_id: str, view: FirstBatchView, profile: Literal["fast", "balanced"] = "fast",
                       group_by: Literal["group", "source", "dataset", "kind", "language"] = "group"):
    from analysis_core import ALIASES, CONDITIONAL, PANELS, SELECTED
    if item_id not in PANELS and item_id not in SELECTED and item_id not in ALIASES and item_id not in CONDITIONAL:
        raise HTTPException(404, "Unknown metric or panel")
    filters = view.filters()
    study = _first_batch(sid, profile, group_by)
    return study.panel(item_id, filters) if item_id in PANELS else study.run(item_id, filters)


@router.get("/scope/{sid}/first-batch/evidence/{evidence_id}")
def first_batch_evidence(sid: str, evidence_id: str, offset: int = Query(0, ge=0), limit: int = Query(20, ge=1, le=100),
                         profile: Literal["fast", "balanced"] = "fast",
                         group_by: Literal["group", "source", "dataset", "kind", "language"] = "group"):
    try:
        return _first_batch(sid, profile, group_by).resolve_evidence(evidence_id, offset=offset, limit=limit)
    except KeyError as exc:
        raise HTTPException(404, "Evidence expired or is outside this study; reproduce the same metric and filters") from exc


@router.get("/scope/{sid}/summary")
def summary(sid: str):
    d = _get(sid)
    meta = d.meta
    df = d.docs
    return CM.clean_json({
        "scope_id": sid,
        "spec": meta["spec"],
        "populations": meta["populations"],
        "retrieval_counts": meta.get("retrieval_counts"),
        "archive_daily": meta.get("archive_daily"),
        "archive_attention": attention_series(meta),
        "sampled_threads": meta.get("sampled_threads"),
        "relevant_threads": meta.get("relevant_threads"),
        "provider_manifest": meta.get("provider_manifest"),
        "model_usage": meta.get("model_usage"),
        "context_docs": meta.get("context_docs"),
        "assembled": meta.get("assembled"),
        "sampling_fraction": meta.get("sampling_fraction"),
        "built_at": meta["built_at"],
        "build_seconds": meta["build_seconds"],
        "quality": meta["quality"],
        "dedupe": meta["dedupe"],
        "discovery": {k: v for k, v in (meta.get("discovery") or {}).items() if k != "all_scored"},
        "dict_size": meta.get("dict_size"),
        "months": sorted(df["month"].unique()),
        "by_month": [{"month": m, "docs": int(v)} for m, v in df.groupby("month").size().items()],
        "sentiment": _sent(df),
        "need_density": float(CM.need_mask(df).mean()),
        "brand_coverage": float((df["brands"].map(len) > 0).mean()),
        "date_range": [str(df["date"].min()), str(df["date"].max())],
        "top_communities": [{"community": k, "docs": int(v)} for k, v in df["community"].value_counts().head(10).items()],
        "top_brands": [{"brand": CM.brand_label(b), "docs": c} for b, c in CM.brand_counts(df).most_common(10)],
        "langs": [{"lang": k, "docs": int(v)} for k, v in df["lang"].value_counts().head(8).items()],
        "intent_coverage": float(df["intent_names"].map(lambda x: x != ["一般讨论"]).mean()),
        "sent_coverage": float((df["sent_label"] != "未知").mean()),
    })


@router.get("/scope/{sid}/topics")
def scope_topics(sid: str):
    rows, _ = topics.discover(_get(sid))
    return CM.clean_json({"items": rows})


@router.get("/scope/{sid}/topic/{topic_id}/evidence")
def topic_evidence(sid: str, topic_id: int, k: int = Query(10, ge=1, le=100)):
    from .evidence import membership, replay

    scope = _get(sid)
    rows, labels = topics.discover(scope)
    if topic_id not in {row["id"] for row in rows}:
        raise HTTPException(404, "未知子主题")
    return replay(scope, membership(scope, scope.docs.loc[labels == topic_id, "doc_id"], f"topic_id={topic_id}"), k)


@router.get("/scope/{sid}/module/{module}")
def module_view(sid: str, module: str, refresh: bool = False, topic: str = ""):
    if module not in MODULES:
        raise HTTPException(404, "未知模块")
    d = _get(sid)
    if topic:
        try:
            d = topics.subset(d, [int(value) for value in topic.split(",")])
        except ValueError as exc:
            raise HTTPException(422, str(exc))
    if module == "product" and not topic:
        others = [row for row in SC.list_scopes() if row["scope_id"] != sid]
        d.meta["comparisons"] = compare_scopes(sid, others)
    out = dict(engine.run(module, d, _encoder() if d.n else None, refresh=refresh))
    out["scope"] = {
        "scope_id": sid, "name": d.meta["spec"]["name"], "docs": len(d.docs),
        "threads": int(d.docs["thread_id"].nunique()), "authors": d.meta["quality"]["authors"],
        "date_range": [str(d.docs["date"].min()), str(d.docs["date"].max())],
        "quality_status": d.meta["quality"].get("status"),
        "build_seconds": d.meta["build_seconds"],
        "selected_topics": d.meta.get("selected_topics", []),
    }
    out = CM.clean_json(out)
    _save_run(sid, module, out)
    return out


def compare_scopes(sid, records):
    results = []
    target = _get(sid).meta["spec"]
    for key in [sid, *[r["scope_id"] for r in records[:5]]]:
        scope = _get(key)
        if all(scope.meta["spec"].get(field) == target.get(field) for field in ("months", "subreddits", "lang", "kind", "min_score")):
            row = _comparison_row(key)
            if row:
                results.append(row)
    return results


@lru_cache(maxsize=24)
def _comparison_row(sid):
    return engine.comparison_row(_get(sid))


@router.get("/scope/{sid}/evidence")
def evidence(sid: str, doc_ids: str = Query("", description="逗号分隔的 doc_id"), k: int = Query(10, ge=1, le=100)):
    d = _get(sid)
    ids = [x for x in doc_ids.split(",") if x]
    return {"items": d.evidence(ids, k=k)}


@router.get("/scope/{sid}/metric/{mid}/evidence")
def metric_evidence(sid: str, mid: str, topic: str = "", execute_archive: bool = False, k: int = Query(10, ge=1, le=100)):
    from .evidence import replay

    if mid not in REG.REGISTRY:
        raise HTTPException(404, "未知指标")
    scope = _get(sid)
    if topic:
        try:
            scope = topics.subset(scope, [int(item) for item in topic.split(",")])
        except ValueError as exc:
            raise HTTPException(422, str(exc)) from exc
    row = engine.run(mid, scope, _encoder() if scope.n else None)
    links = row["evidence_contract"]
    if links["query"] or links["membership"]:
        return CM.clean_json(replay(scope, links["query"] or links["membership"], k, execute_archive=execute_archive))
    selected = row["evidence_ref"] or list(dict.fromkeys(doc_id for obj in links["nested"]["items"] for doc_id in obj["doc_ids"]))
    return CM.clean_json({"items": scope.evidence(selected, k=k), "kind": "sample", "count": len(selected)})


@router.get("/scope/{sid}/doc/{doc_id}")
def doc_detail(sid: str, doc_id: str):
    d = _get(sid)
    hit = d.docs[d.docs["doc_id"] == doc_id]
    if hit.empty:
        hit = d.context[d.context["doc_id"] == doc_id]
    if hit.empty:
        raise HTTPException(404, "doc not found")
    r = hit.iloc[0]
    fields = ("doc_id", "thread_id", "parent_id", "community", "author", "kind", "score", "text",
              "norm", "lang", "chars", "intents", "entities", "aspects", "prices", "relations",
              "brands", "attrs", "scenarios", "sent", "pains", "relevance", "demand_states", "solution_refs", "linguistic",
              "solution_links", "measurements", "raw_metadata", "observed_at", "thread_created_utc", "created_utc", "domain", "content_type")
    from .evidence import document_spans
    spans = document_spans(r.text, r.norm, r.relevance, {kind: r.get(kind, []) for kind in ("entities", "aspects", "prices", "relations", "demand_states")})
    return CM.clean_json({**{key: r[key] for key in fields if key in r}, "date": str(r["date"]), "source_spans": spans})


# --------------------------------------------------------------------------- #
# 实验室 / 指标 / 记录
# --------------------------------------------------------------------------- #
@router.post("/scope/{sid}/lab/{exp}")
def run_lab(sid: str, exp: str, params: dict = Body(default_factory=dict)):
    d = _get(sid)
    try:
        out = LAB.run(exp, d, _encoder(), params or {})
    except Exception as e:  # noqa
        raise HTTPException(400, f"实验失败：{e}")
    out = CM.clean_json(out)
    _append_run({"id": f"exp-{time.time_ns()}", "kind": "lab", "scope_id": sid,
                    "name": exp, "params": params, "ran_at": out["ran_at"],
                    "runtime_ms": out["runtime_ms"]})
    return out


@router.get("/metrics")
def metrics(scope: str = Query("", description="可选：合并该 scope 的计算结果")):
    defs = REG.all_defs()
    values = {}
    if scope:
        for m in MODULES:
            try:
                view = module_view(scope, m)
                values.update(view.get("metrics", {}))
            except HTTPException:
                continue
    rows = []
    for d_ in defs:
        v = values.get(d_["metric_id"], {})
        rows.append({**d_, "value": v.get("value"), "numerator": v.get("numerator"),
                     "denominator": v.get("denominator"), "sample_size": v.get("sample_size"),
                     "status": v.get("quality_status", "未计算"), "note": v.get("reason") or v.get("note", ""),
                     "population": v.get("population"), "quality_flags": v.get("quality_flags", []),
                     "actual_method": v.get("method"), "evidence": {k: bool(x) for k, x in v.get("evidence_contract", {}).items()},
                     "output_type": v.get("output_type", d_["output_type"])})
    done = sum(1 for r in rows if r["status"] in {"available", "exploratory"})
    return {"total": len(rows), "computed": done, "rows": rows}


@router.get("/baseline")
def baseline():
    report = ROOT / "reports" / "acceptance_v4.json"
    if not report.exists():
        return {"cases": [], "status": "awaiting_acceptance"}
    results = json.loads(report.read_text(encoding="utf-8"))
    return {"status": "measured", "cases": [{key: row[key] for key in
            ("name", "historical", "current", "comparison", "same_documents") if key in row} for row in results["cases"]]}


@router.get("/runs")
def runs():
    return {"runs": _load_runs()[:80]}


def _load_runs() -> list[dict]:
    if not RUNS.exists():
        return []
    try:
        return json.loads(RUNS.read_text(encoding="utf-8"))
    except Exception:
        return []


def _save_run(sid: str, module: str, out: dict) -> None:
    _append_run({"id": f"mod-{time.time_ns()}", "kind": "module", "scope_id": sid,
                 "name": module, "ran_at": time.strftime("%Y-%m-%d %H:%M:%S"),
                 "runtime_ms": out.get("runtime_ms"), "docs": out.get("scope", {}).get("docs")})


def _append_run(record):
    with _RUN_LOCK:
        rs = [record, *_load_runs()][:200]
        RUNS.parent.mkdir(parents=True, exist_ok=True)
        temp = RUNS.with_suffix(".tmp")
        temp.write_text(json.dumps(rs, ensure_ascii=False, indent=1), encoding="utf-8")
        temp.replace(RUNS)


@router.get("/lab/list")
def lab_list():
    return {"experiments": [
        {"id": "entity", "name": "实体识别与自动词典", "params": ["sim_threshold", "min_df"]},
        {"id": "intent", "name": "多标签意图识别", "params": []},
        {"id": "sentiment", "name": "情感算法对比", "params": ["window"]},
        {"id": "embedding", "name": "Embedding 与检索", "params": ["query", "k"]},
        {"id": "clustering", "name": "聚类与主题建模", "params": ["k", "sample"]},
        {"id": "timeseries", "name": "时间序列与异常", "params": ["series", "window", "threshold"]},
        {"id": "cooccurrence", "name": "共现与关系强度", "params": ["min_support"]},
        {"id": "scoring", "name": "综合评分对比", "params": ["k"]},
        {"id": "demand", "name": "需求状态与方案证据", "params": []},
        {"id": "population", "name": "统计总体与线程重采样", "params": ["seed", "draws"]},
    ]}

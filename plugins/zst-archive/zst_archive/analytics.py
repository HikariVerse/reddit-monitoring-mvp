"""First-batch business analytics adapter (potion-analysis-core) for R4 & Explore service."""
from __future__ import annotations

from collections import OrderedDict
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import threading
import time
from typing import Any

from .packages import MonthPackage
from .query import QuerySpec, select_archive_for_analysis

MAX_ARCHIVE_ANALYSIS_DOCS = 10000
MAX_STUDY_CACHE = 4
MAX_RESULT_CACHE = 8
MAX_PROGRESS_CACHE = 32
PANEL_IDS = ("P01", "P02", "P03", "P04", "P05", "P06", "P07", "P08", "P09", "P10", "P11", "P12")
PANEL_TITLES = {
    "P01": "讨论规模与覆盖",
    "P02": "语料去重与质量",
    "P03": "分组与互动分布",
    "P04": "特征词与多词搭配",
    "P05": "主题结构与代表内容",
    "P06": "主题时间分布",
    "P07": "声量异常与事件",
    "P08": "异常事件生命周期",
    "P09": "情感与正负口碑",
    "P10": "主动需求与显式诉求",
    "P11": "需求与痛点聚类",
    "P12": "价格与购买决策",
}

_CORE_DIR = Path(__file__).resolve().parent.parent / "analytics_core"
_STUDY_LOCK = threading.Lock()
_STUDY_CACHE: OrderedDict[str, Any] = OrderedDict()
_RESULT_LOCK = threading.Lock()
_RESULT_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()
_PROGRESS_LOCK = threading.Lock()
_PROGRESS_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()
_ENCODER_LOCK = threading.Lock()
_ENCODER_LOADED = False
_ENCODER: Any = None


def _update_progress(run_id: str | None, **fields: Any) -> None:
    if not run_id:
        return
    with _PROGRESS_LOCK:
        entry = _PROGRESS_CACHE.get(run_id) or {
            "runId": run_id,
            "stage": "retrieving",
            "stageLabel": "正在召回匹配数据",
            "percent": 5,
            "completedPanels": [],
            "totalPanels": len(PANEL_IDS),
            "currentPanel": None,
            "rawDocuments": None,
            "analyzedDocuments": None,
            "startedAt": time.time(),
        }
        entry.update(fields)
        entry["elapsedMs"] = int((time.time() - entry["startedAt"]) * 1000)
        _PROGRESS_CACHE[run_id] = entry
        _PROGRESS_CACHE.move_to_end(run_id)
        while len(_PROGRESS_CACHE) > MAX_PROGRESS_CACHE:
            _PROGRESS_CACHE.popitem(last=False)


def get_analysis_progress(run_id: str) -> dict[str, Any] | None:
    with _PROGRESS_LOCK:
        entry = _PROGRESS_CACHE.get(run_id)
        if entry is None:
            return None
        snapshot = dict(entry)
        snapshot["elapsedMs"] = int((time.time() - snapshot["startedAt"]) * 1000)
        snapshot.pop("startedAt", None)
        return snapshot


def _ensure_core_path() -> None:
    core_str = str(_CORE_DIR)
    if _CORE_DIR.is_dir() and core_str not in sys.path:
        sys.path.insert(0, core_str)


def analytics_runtime_status() -> dict[str, Any]:
    """Report whether the optional potion-analysis-core dependencies and Potion model are ready."""
    _ensure_core_path()
    try:
        import analysis_core  # noqa: F401
        deps_ok = True
    except Exception:
        deps_ok = False
    try:
        import spacy  # noqa: F401
        import vaderSentiment  # noqa: F401
        import jieba  # noqa: F401
        balanced_ok = True
    except Exception:
        balanced_ok = False
    model_dir = _resolve_model_dir()
    return {
        "available": deps_ok,
        "potionModelReady": bool(model_dir),
        "balancedReady": balanced_ok,
        "panels": list(PANEL_IDS),
    }


def _resolve_model_dir() -> Path | None:
    candidates: list[Path] = []
    env_dir = os.environ.get("EXPLORE_POTION_MODEL_DIR") or os.environ.get("POTION_MODEL_DIR")
    if env_dir:
        candidates.append(Path(env_dir))
    plugin_root = Path(__file__).resolve().parent.parent
    candidates.append(plugin_root / "models" / "potion-int8")
    candidates.append(plugin_root.parent.parent / "output" / "首批分析能力集成交接" / "models" / "potion-int8")
    for path in candidates:
        if (path / "model.safetensors").is_file() and (path / "tokenizer.json").is_file():
            return path
    return None


def _get_encoder() -> Any:
    global _ENCODER_LOADED, _ENCODER
    with _ENCODER_LOCK:
        if _ENCODER_LOADED:
            return _ENCODER
        _ENCODER_LOADED = True
        model_dir = _resolve_model_dir()
        if not model_dir:
            _ENCODER = None
            return None
        try:
            _ensure_core_path()
            from model_runtime import PotionINT8Encoder

            _ENCODER = PotionINT8Encoder(str(model_dir))
        except Exception:
            _ENCODER = None
        return _ENCODER


def _cache_study(study: Any) -> None:
    with _STUDY_LOCK:
        _STUDY_CACHE[study.id] = study
        _STUDY_CACHE.move_to_end(study.id)
        while len(_STUDY_CACHE) > MAX_STUDY_CACHE:
            _STUDY_CACHE.popitem(last=False)


def _load_cached_study(study_id: str) -> Any | None:
    with _STUDY_LOCK:
        study = _STUDY_CACHE.get(study_id)
        if study is not None:
            _STUDY_CACHE.move_to_end(study_id)
        return study


def _run_panels(study: Any, panel_ids: tuple[str, ...] = PANEL_IDS, run_id: str | None = None) -> list[dict[str, Any]]:
    results = []
    completed: list[str] = []
    total = max(1, len(panel_ids))
    for idx, pid in enumerate(panel_ids):
        pct = 30 + int((idx / total) * 65)
        _update_progress(
            run_id,
            stage="computing_panels",
            stageLabel=f"正在计算 {pid} · {PANEL_TITLES.get(pid, pid)}（{idx + 1}/{total}）",
            percent=pct,
            currentPanel=pid,
            completedPanels=list(completed),
            totalPanels=total,
        )
        results.append(study.panel(pid))
        completed.append(pid)
    _update_progress(
        run_id,
        stage="finalizing",
        stageLabel="正在整理分析结果与动态引导",
        percent=98,
        currentPanel=None,
        completedPanels=list(completed),
        totalPanels=total,
    )
    return results


def analyze_documents_payload(payload: dict[str, Any]) -> dict[str, Any]:
    """Run potion-analysis-core over canonical InputDocument records supplied by the API."""
    t0 = time.perf_counter()
    run_id = str(payload.get("runId") or "") or None
    _ensure_core_path()
    from analysis_core import Config, InputDocument, Study

    raw_docs = payload.get("documents")
    if not isinstance(raw_docs, list):
        raise ValueError("documents must be a list")
    _update_progress(run_id, stage="ingesting", stageLabel=f"已载入 {len(raw_docs)} 条授权文档，正在清洗与去重", percent=20, rawDocuments=len(raw_docs))
    data_version = str(payload.get("dataVersion") or "explore-v1")
    seeds = tuple(str(s).strip() for s in (payload.get("seeds") or []) if str(s).strip())
    profile = payload.get("profile") if payload.get("profile") in ("fast", "balanced") else "fast"
    group_by = payload.get("groupBy") if payload.get("groupBy") in ("group", "source", "dataset", "kind", "language") else "group"
    coverage_days = payload.get("coverageDays") if isinstance(payload.get("coverageDays"), dict) else None
    requested_panels = payload.get("panels")
    panel_ids = tuple(p for p in requested_panels if p in PANEL_IDS) if isinstance(requested_panels, list) and requested_panels else PANEL_IDS

    docs = []
    for item in raw_docs:
        if not isinstance(item, dict):
            continue
        docs.append(
            InputDocument(
                source_id=str(item.get("source_id") or "system"),
                source_type=str(item.get("source_type") or "unknown"),
                dataset_id=str(item.get("dataset_id") or "default"),
                document_id=str(item.get("document_id") or ""),
                text=str(item.get("text") or ""),
                thread_id=str(item.get("thread_id") or ""),
                parent_id=str(item.get("parent_id") or ""),
                author_key=str(item.get("author_key") or ""),
                group=str(item.get("group") or ""),
                kind=str(item.get("kind") or "post"),
                created_utc=item.get("created_utc"),
                observed_at=item.get("observed_at"),
                title=str(item.get("title") or ""),
                url=str(item.get("url") or ""),
                language=str(item.get("language") or ""),
                engagement_channels=item.get("engagement_channels") if isinstance(item.get("engagement_channels"), dict) else None,
            )
        )

    config = Config(seeds=seeds, profile=profile, group_by=group_by)
    study = Study.ingest(docs, data_version=data_version, config=config, coverage_days=coverage_days, encoder=_get_encoder())
    _update_progress(run_id, stage="computing_panels", stageLabel=f"去重完成（保留 {len(study.core)} 条有效样本），开始计算分析面板", percent=30, rawDocuments=len(docs), analyzedDocuments=len(study.core))
    panels = _run_panels(study, panel_ids, run_id=run_id)
    _cache_study(study)
    _update_progress(run_id, stage="completed", stageLabel="分析完成", percent=100, analyzedDocuments=len(study.core))

    return {
        "studyId": study.id,
        "dataVersion": study.data_version,
        "engine": "python_potion_worker",
        "potionModelReady": _get_encoder() is not None,
        "analyzedDocuments": len(study.core),
        "rawDocuments": len(docs),
        "elapsedMs": round((time.perf_counter() - t0) * 1000),
        "panels": panels,
    }


def _build_archive_ledger_meta(
    packages: list[MonthPackage],
    retrieval_by_day: list[dict[str, Any]],
    *,
    version: str,
    query: str,
    subreddits: tuple[str, ...],
    from_iso: str | None,
    to_iso: str | None,
    seeds: tuple[str, ...],
) -> tuple[dict[str, Any], dict[str, str]]:
    """Build comparable daily archive population & exact full retrieval census for SL02."""
    from research.populations import parquet_thread_total

    comm_key = tuple(sorted(subreddits))
    from_day = from_iso[:10] if from_iso else None
    to_day = to_iso[:10] if to_iso else None

    archive_daily: list[dict[str, Any]] = []
    coverage_days: dict[str, str] = {}
    total_admitted = 0
    for pkg in packages:
        rows = parquet_thread_total((pkg.posts_parquet.as_posix(), version[:16]), pkg.month, comm_key)
        for month, day, count in rows:
            if from_day and day < from_day:
                continue
            if to_day and day > to_day:
                continue
            archive_daily.append({"month": month, "date": day, "count": int(count)})
            coverage_days[day] = "complete"
            total_admitted += int(count)

    filtered_retrieval = [
        row for row in retrieval_by_day
        if (not from_day or row["date"] >= from_day) and (not to_day or row["date"] <= to_day)
    ]
    total_matched = sum(int(row["count"]) for row in filtered_retrieval)
    common_filters = {"subreddits": list(comm_key), "from": from_day, "to": to_day}
    meta = {
        "populations": {
            "archive": {
                "source": "reddit_archive",
                "unit": "thread",
                "version": version[:16],
                "size": total_admitted,
                "filters": common_filters,
            },
            "retrieval": {
                "source": "reddit_archive",
                "unit": "thread",
                "version": version[:16],
                "size": total_matched,
                "filters": common_filters,
                "query": query,
            },
        },
        "archive_daily": archive_daily,
        "retrieval_counts": {"by_day": filtered_retrieval},
        "spec": {"seeds": list(seeds)},
    }
    return meta, coverage_days


def analyze_archive_scope(
    packages: list[MonthPackage],
    *,
    version: str,
    query: str,
    subreddits: tuple[str, ...],
    from_iso: str | None,
    to_iso: str | None,
    include_comments: bool,
    group_by: str,
    profile: str,
    limit: int,
    duckdb_config: dict[str, Any],
    run_id: str | None = None,
) -> dict[str, Any]:
    """Query open-corpus-v1 via DuckDB + FTS5 and run first-batch analytics over matched documents."""
    t0 = time.perf_counter()
    _ensure_core_path()
    from analysis_core import Config, InputDocument, Study

    cache_key = json.dumps(
        [
            version[:16],
            sorted(pkg.month for pkg in packages),
            query,
            sorted(subreddits),
            from_iso,
            to_iso,
            include_comments,
            group_by,
            profile,
            limit,
        ],
        ensure_ascii=False,
    )
    with _RESULT_LOCK:
        cached = _RESULT_CACHE.get(cache_key)
        if cached is not None:
            _RESULT_CACHE.move_to_end(cache_key)
            _update_progress(run_id, stage="completed", stageLabel="命中分析缓存，立即返回", percent=100, analyzedDocuments=cached["analyzedDocuments"])
            return {**cached, "elapsedMs": round((time.perf_counter() - t0) * 1000)}

    _update_progress(run_id, stage="retrieving", stageLabel=f"正在通过 DuckDB + FTS5 检索 {len(packages)} 个月归档并执行按日分层抽样", percent=10)
    capped_limit = max(25, min(limit, MAX_ARCHIVE_ANALYSIS_DOCS))
    selection = select_archive_for_analysis(
        packages,
        QuerySpec(
            query=query,
            subreddits=subreddits,
            from_iso=from_iso,
            to_iso=to_iso,
            limit=capped_limit,
            include_comments=include_comments,
            max_comments_per_post=5,
            allow_unscoped=True,
        ),
        config=duckdb_config,
    )
    total_matched = int(selection.stats.get("totalMatched") or len(selection.posts))
    retrieval_by_day = selection.stats.get("retrievalByDay") or []
    is_sampled = total_matched > len(selection.posts)
    _update_progress(
        run_id,
        stage="ingesting",
        stageLabel=(
            f"全库命中 {total_matched:,} 篇（按日均匀抽样 {len(selection.posts)} 篇），正在构建日账本与去重"
            if is_sampled
            else f"归档召回 {len(selection.posts)} 篇帖子，正在构建全库日账本与执行去重"
        ),
        percent=22,
        rawDocuments=total_matched,
    )

    docs: list[InputDocument] = []
    coverage_days: dict[str, str] = {}
    for post in selection.posts:
        created = post.get("created_utc")
        if isinstance(created, (int, float)):
            day = datetime.fromtimestamp(created, timezone.utc).date().isoformat()
            coverage_days[day] = "complete"
        title = str(post.get("title") or "").strip()
        body = str(post.get("body") or "").strip()
        text = f"{title}\n\n{body}".strip() if title and body else (title or body)
        if not text:
            continue
        channels: dict[str, int | float] = {}
        if post.get("score") is not None:
            channels["score"] = post["score"]
        if post.get("reported_comments") is not None:
            channels["reported_comments"] = post["reported_comments"]
        doc_key = f"{post['month']}:{post['doc_id']}"
        docs.append(
            InputDocument(
                source_id="reddit_archive",
                source_type="reddit_archive",
                dataset_id=f"open-corpus-v1:{version[:12]}",
                document_id=doc_key,
                thread_id=str(post.get("content_key") or doc_key),
                author_key=str(post.get("author_key") or ""),
                group=str(post.get("community") or ""),
                kind="post",
                created_utc=int(created) if isinstance(created, (int, float)) else None,
                title=title,
                text=text,
                engagement_channels=channels or None,
            )
        )

    for comment in selection.comments:
        body = str(comment.get("body") or "").strip()
        if not body:
            continue
        created = comment.get("created_utc")
        if isinstance(created, (int, float)):
            day = datetime.fromtimestamp(created, timezone.utc).date().isoformat()
            coverage_days[day] = "complete"
        channels = {}
        if comment.get("score") is not None:
            channels["score"] = comment["score"]
        docs.append(
            InputDocument(
                source_id="reddit_archive",
                source_type="reddit_archive",
                dataset_id=f"open-corpus-v1:{version[:12]}",
                document_id=f"{comment['month']}:c:{comment['comment_id']}",
                thread_id=f"{comment['month']}:{comment['post_doc_id']}",
                parent_id=str(comment.get("parent_key") or ""),
                author_key=str(comment.get("author_key") or ""),
                group="",
                kind="comment",
                created_utc=int(created) if isinstance(created, (int, float)) else None,
                text=body,
                engagement_channels=channels or None,
            )
        )

    seeds = tuple(tok for tok in query.replace('"', " ").split() if tok.upper() not in {"AND", "OR", "NOT"} and len(tok) >= 2)[:8]
    archive_meta, ledger_coverage = _build_archive_ledger_meta(
        packages,
        retrieval_by_day,
        version=version,
        query=query,
        subreddits=subreddits,
        from_iso=from_iso,
        to_iso=to_iso,
        seeds=seeds,
    )
    merged_coverage = {**ledger_coverage, **coverage_days}
    resolved_group = group_by if group_by in ("group", "source", "dataset", "kind", "language") else "group"
    resolved_profile = profile if profile in ("fast", "balanced") else "fast"
    config = Config(seeds=seeds, profile=resolved_profile, group_by=resolved_group)
    study = Study.ingest(
        docs,
        data_version=f"archive:{version[:16]}",
        config=config,
        coverage_days=merged_coverage or None,
        encoder=_get_encoder(),
    )
    study.archive_meta = archive_meta
    _update_progress(
        run_id,
        stage="computing_panels",
        stageLabel=f"去重完成（保留 {len(study.core)} 条有效样本），开始运行 12 项业务分析",
        percent=30,
        rawDocuments=total_matched,
        analyzedDocuments=len(study.core),
    )
    panels = _run_panels(study, PANEL_IDS, run_id=run_id)
    _cache_study(study)
    _update_progress(run_id, stage="completed", stageLabel="分析完成", percent=100, analyzedDocuments=len(study.core))

    payload = {
        "studyId": study.id,
        "dataVersion": study.data_version,
        "engine": "duckdb_potion_worker",
        "potionModelReady": _get_encoder() is not None,
        "analyzedDocuments": len(study.core),
        "rawDocuments": total_matched,
        "matchedPosts": len(selection.posts),
        "matchedComments": len(selection.comments),
        "isTruncated": is_sampled,
        "elapsedMs": round((time.perf_counter() - t0) * 1000),
        "panels": panels,
    }
    with _RESULT_LOCK:
        _RESULT_CACHE[cache_key] = payload
        _RESULT_CACHE.move_to_end(cache_key)
        while len(_RESULT_CACHE) > MAX_RESULT_CACHE:
            _RESULT_CACHE.popitem(last=False)
    return payload


def resolve_study_evidence(study_id: str, evidence_id: str, *, offset: int = 0, limit: int = 20) -> dict[str, Any]:
    study = _load_cached_study(study_id)
    if study is None:
        raise KeyError("study_not_found")
    capped_limit = max(1, min(int(limit), 100))
    safe_offset = max(0, int(offset))
    return study.resolve_evidence(evidence_id, offset=safe_offset, limit=capped_limit)

"""Population identity, probability sampling and comparable archive rates."""

import hashlib
import json
from dataclasses import asdict, dataclass
from datetime import datetime
from functools import lru_cache

import duckdb
import numpy as np
from cpu_runtime import cpu_workers


@dataclass(frozen=True)
class Population:
    level: str
    source: str
    version: str
    unit: str
    size: int
    filters: dict
    sampling: str = "census"

    def record(self):
        record = asdict(self)
        raw = json.dumps(record, sort_keys=True, ensure_ascii=False)
        return {"population_id": hashlib.sha256(raw.encode()).hexdigest()[:20], **record}


def counts(frame):
    result = {}
    for column in ("month", "date", "community"):
        result[column] = {str(k): int(v) for k, v in frame[column].value_counts().sort_index().items()}
    result["by_day"] = [{"month": str(m), "date": str(d), "count": int(n)}
                        for (m, d), n in frame.groupby(["month", "date"]).size().items()]
    return result


def sample(frame, strategy, cap, seed):
    rng = np.random.default_rng(seed)
    if strategy == "fts_only":
        return frame.iloc[:0].assign(selection_probability=0.0)
    if strategy == "full":
        return frame.assign(selection_probability=1.0, sample_stratum="census")
    columns = {"month": ["month"], "date": ["month", "date"],
               "community": ["month", "community"]}
    groups = frame.groupby(columns[strategy], sort=True) if strategy in columns else [(None, frame)]
    strata_count = (frame.groupby("month")[columns[strategy][1]].nunique().to_dict()
                    if strategy in {"date", "community"} else {})
    selected = []
    for key, group in groups:
        limit = cap
        if strategy == "random":
            limit *= max(frame["month"].nunique(), 1)
        elif strategy in {"date", "community"}:
            limit = max(1, cap // strata_count[key[0]])
        n = min(limit, len(group))
        if n:
            indices = rng.choice(len(group), n, replace=False)
            selected.append(group.iloc[sorted(indices)].assign(selection_probability=n / len(group), sample_stratum=str(key)))
    if not selected:
        return frame.iloc[:0].assign(selection_probability=0.0)
    import pandas as pd
    return pd.concat(selected, ignore_index=True)


def relevant_thread_estimate(raw, eligible, report):
    """Estimate admitted, retrieved threads with observed eligible phrase relevance."""
    observed = set(eligible.thread_id)
    relevant = {"observed": len(observed), "sampled": int(raw.thread_id.nunique()),
                "estimate": None, "ci95": None, "estimator": "stratified Horvitz-Thompson",
                "definition": "FTS retrieved threads with an eligible, directly grounded document before deduplication"}
    if not len(raw) or "selection_probability" not in raw:
        return relevant
    sample = raw.drop_duplicates("thread_id").assign(has_core=lambda frame: frame.thread_id.isin(observed))
    retrieval_n = report.get("populations", {}).get("retrieval", {}).get("size")
    if sample.selection_probability.isna().any() or (sample.selection_probability <= 0).any() or retrieval_n is None:
        return relevant
    estimated = (sample.has_core / sample.selection_probability).sum()
    reference_size = float((1 / sample.selection_probability).sum())
    if not np.isclose(reference_size, retrieval_n):
        return relevant
    variances = []
    for _, stratum in sample.groupby("sample_stratum", sort=True):
        n = len(stratum)
        f = stratum.selection_probability.iloc[0]
        if f == 1:
            variances.append(0.)
        elif n >= 2 and 0 < stratum.has_core.sum() < n:
            variances.append(float((1 - f) * (n / f) ** 2 * stratum.has_core.var(ddof=1) / n))
        else:
            # No within-stratum variability can be measured. Keep the point estimate explicit.
            variances.append(None)
    relevant["estimate"] = round(float(estimated), 2)
    if all(value is not None for value in variances):
        margin = 1.96 * np.sqrt(sum(variances))
        relevant["ci95"] = [round(max(0, estimated - margin), 2), round(min(retrieval_n, estimated + margin), 2)]
    return relevant


@lru_cache(maxsize=48)
def ledger_total(files, communities):
    with duckdb.connect(config={"threads": cpu_workers()}) as con:
        rows = con.execute("""
            SELECT CAST(month AS VARCHAR), CAST(day_utc AS VARCHAR), SUM(admitted_posts)
            FROM read_parquet(?)
            WHERE (NOT ? OR lower(community) IN (SELECT unnest(?::VARCHAR[])))
            GROUP BY 1, 2 ORDER BY 1, 2
        """, [[p for p, _ in files], bool(communities), list(communities)]).fetchall()
    return tuple((m, day, int(n)) for m, day, n in rows)


@lru_cache(maxsize=48)
def parquet_thread_total(file, month, communities):
    path, _version = file
    with duckdb.connect(config={"threads": cpu_workers()}) as con:
        rows = con.execute("""
            SELECT CAST(CAST(to_timestamp(created_utc) AT TIME ZONE 'UTC' AS DATE) AS VARCHAR), count(*)
            FROM read_parquet(?)
            WHERE (NOT ? OR lower(community) IN (SELECT unnest(?::VARCHAR[])))
            GROUP BY 1 ORDER BY 1
        """, [path, bool(communities), list(communities)]).fetchall()
    return tuple((month, day, int(n)) for day, n in rows)


def attention_series(meta):
    # Cached DuckDB dates were serialized as midnight timestamps while the
    # population ledger uses ISO dates. Compare the same UTC calendar unit.
    def day_key(value):
        return datetime.fromisoformat(str(value)).date().isoformat()

    retrieval = {}
    for row in meta.get("retrieval_counts", {}).get("by_day", []):
        key = (row["month"], day_key(row["date"]))
        retrieval[key] = retrieval.get(key, 0) + row["count"]
    rows = []
    for item in meta.get("archive_daily", []):
        day = day_key(item["date"])
        den = item["count"]
        num = retrieval.get((item["month"], day), 0)
        rows.append({"date": day, "matched_threads": num, "admitted_posts": den,
                     "relative_attention": num / den if 0 < den and num <= den else None})
    return rows


def archive_attention(scope, mid, scale):
    from .common import M

    populations = scope.meta.get("populations", {})
    archive, retrieval = populations.get("archive"), populations.get("retrieval")
    compatible = (archive and retrieval and archive["size"] > 0
                  and archive["unit"] == retrieval["unit"]
                  and archive["source"] == retrieval["source"]
                  and archive["version"] == retrieval["version"]
                  and archive["filters"] == retrieval["filters"]
                  and 0 <= retrieval["size"] <= archive["size"])
    method = "FTS 关键词命中线程数 / 同期同社区准入归档帖子数"
    if not compatible:
        return M(mid, None, n=scope.n, method=method, reason="缺少同口径的归档帖子总体或 FTS 命中总体")
    num, den = retrieval["size"], archive["size"]
    return M(mid, round(num / den * scale, 6), num=num, den=den, n=den, method=method,
             unit="threads/M" if scale > 1 else "ratio",
             population=archive, numerator_population=retrieval, scale=scale,
             note="关键词命中包括帖子和索引中的评论，按线程去重")

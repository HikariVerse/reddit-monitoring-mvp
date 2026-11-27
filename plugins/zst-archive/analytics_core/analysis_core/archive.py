"""Optional read-only Reddit archive bridge. The core does not need an archive."""

import duckdb

from cpu_runtime import check_cancelled, cpu_workers, managed_job, operator
from research import scope


@managed_job("archive_evidence_page")
def resolve_archive(predicate, offset, limit):
    spec = predicate["archive_filters"]
    if scope.archive_version(spec["months"]) != predicate["archive_version"]:
        raise ValueError("Archive version changed; rebuild the study before resolving evidence")
    remaining_offset = offset
    items = []
    with operator("duckdb_archive_evidence", cpu_workers()) as workers, duckdb.connect(config={"threads": workers}) as con:
        for month in sorted(spec["months"]):
            check_cancelled()
            if predicate["start"] and month < predicate["start"][:7] or predicate["end"] and month > predicate["end"][:7]:
                continue
            root = scope.ARCHIVE / month / "corpus" / "posts.parquet"
            expressions, params = [], [str(root)]
            if predicate["kind"] == "matched_threads":
                query = scope._fts_query(predicate["seeds"])
                if not query or query != predicate["query"]:
                    raise ValueError("Archive evidence query differs from the original retrieval")
                candidates = scope.fts_candidates(predicate["seeds"], [month]).get(month, ())
                if not candidates:
                    continue
                con.register("evidence_ids", scope._ids_frame(candidates))
                expressions.append("p.doc_id IN (SELECT id FROM evidence_ids)")
            if spec["communities"]:
                expressions.append("lower(p.community) IN (SELECT unnest(?))")
                params.append(spec["communities"])
            date_expr = "CAST(to_timestamp(p.created_utc) AT TIME ZONE 'UTC' AS DATE)"
            for name, comparison in (("start", ">="), ("end", "<=")):
                if predicate[name]:
                    expressions.append(f"{date_expr} {comparison} CAST(? AS DATE)")
                    params.append(predicate[name])
            where = " WHERE " + " AND ".join(expressions) if expressions else ""
            source = " FROM read_parquet(?) p" + where
            available, = con.execute("SELECT count(*)" + source, params).fetchone()
            if available <= remaining_offset:
                remaining_offset -= available
                continue
            found = con.execute("SELECT p.doc_id, p.content_key, p.community, p.created_utc, p.title, p.body" + source
                                + " ORDER BY p.doc_id LIMIT ? OFFSET ?", [*params, limit - len(items), remaining_offset]).fetchall()
            remaining_offset = 0
            for key, content_key, group, stamp, title, body in found:
                items.append({"document_id": f"post:{month}:{key}", "thread_id": f"{month}:{key}", "source_id": "reddit_archive",
                              "source_document_id": str(content_key), "group": group, "created_utc": stamp,
                              "text": f"{title or ''}\n\n{body or ''}", "kind": "post", "archive_partition": month})
            if len(items) == limit:
                break
    return items

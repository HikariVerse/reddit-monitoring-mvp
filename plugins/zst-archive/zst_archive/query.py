"""Two-stage FTS5 + DuckDB query and thread retrieval over open-corpus-v1 packages."""

from __future__ import annotations

import math
import os
import re
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

import duckdb
import pyarrow as pa

from .packages import MonthPackage


def _parallel_budget() -> int:
    """Global heavy-analysis parallel budget = detected logical CPUs minus 1 (keeps UI/OS responsive)."""
    raw = os.environ.get("ARCHIVE_PARALLEL_BUDGET")
    if raw and raw.isdigit() and int(raw) >= 1:
        return int(raw)
    return max(1, (os.cpu_count() or 4) - 1)


def _duckdb_config(config: dict[str, str] | None = None) -> dict[str, str]:
    budget = _parallel_budget()
    # Keep per-query DuckDB threads bounded so 2-3 concurrent runs stay <= global parallel budget (CPUs - 1)
    default_threads = min(6, max(2, budget // 3))
    threads = os.environ.get("ARCHIVE_DUCKDB_THREADS") or str(default_threads)
    memory_limit = os.environ.get("ARCHIVE_DUCKDB_MEMORY_LIMIT") or ("4GB" if budget >= 8 else "1536MB")
    return {
        "threads": threads,
        "memory_limit": memory_limit,
        "preserve_insertion_order": "false",
        "autoload_known_extensions": "false",
        "autoinstall_known_extensions": "false",
        **(config or {}),
    }

STOPWORDS = frozenset({
    "the", "be", "to", "of", "and", "a", "in", "that", "have", "i", "it", "for",
    "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his",
    "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my",
    "one", "all", "would", "there", "their", "what", "so", "up", "out", "if",
    "about", "who", "get", "which", "go", "me", "when", "make", "can", "like",
    "time", "no", "just", "him", "know", "take", "into", "year", "your", "good",
    "some", "could", "them", "see", "other", "than", "then", "now", "look",
    "only", "come", "its", "over", "think", "also", "back", "after", "use",
    "two", "how", "our", "work", "first", "well", "way", "even", "new", "want",
    "because", "any", "these", "give", "day", "most", "us", "is", "are", "was",
    "were", "been", "has", "had", "did", "does", "am", "im", "ive", "dont",
    "cant", "wont", "didnt", "isnt", "arent", "wasnt", "werent", "youre", "thats",
    "whats", "heres", "theres", "http", "https", "www", "com", "org", "net",
    "reddit", "redd", "webp", "png", "jpg", "jpeg", "gif", "mp4",
})

ALL_SCOPES = ("title", "body", "comments_text")
MAX_SHARD_RECALL = 125_000
MAX_TOTAL_RECALL = 500_000


@dataclass(frozen=True)
class QuerySpec:
    query: str = ""
    subreddits: tuple[str, ...] = ()
    from_iso: str | None = None
    to_iso: str | None = None
    min_score: int | None = None
    min_comments: int | None = None
    limit: int = 50
    include_comments: bool = True
    max_comments_per_post: int = 15
    scopes: tuple[str, ...] = ALL_SCOPES
    allow_unscoped: bool = False


@dataclass(frozen=True)
class SelectionResult:
    posts: list[dict[str, Any]]
    comments: list[dict[str, Any]]
    stats: dict[str, Any]


def _parse_iso_to_epoch(value: str | None, *, ceil: bool = False) -> int | None:
    if value is None or not value.strip():
        return None
    raw = value.strip()
    if raw.endswith("Z"):
        raw = raw[:-1] + "+00:00"
    dt = datetime.fromisoformat(raw)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return math.ceil(dt.timestamp()) if ceil else int(dt.timestamp())


def parse_boolean_query(text: str) -> Any:
    """Parse boolean query syntax matching open_corpus detail=none FTS5 index."""
    if not text.strip():
        return None
    if len(text) > 256:
        raise ValueError("Query expression exceeds 256 characters")
    tokens = re.findall(r'"[^"\n]*"|[()]|(?<!\S)-(?=\S)|[^\s()"]+', text)
    if text.count('"') % 2 or len(tokens) > 64:
        raise ValueError("Unbalanced quotes or too many tokens in query")
    pos = 0

    def peek() -> str | None:
        return tokens[pos].upper() if pos < len(tokens) else None

    def atom() -> Any:
        nonlocal pos
        tok = peek()
        if tok in ("NOT", "-"):
            pos += 1
            return ("NOT", atom())
        if tok == "(":
            pos += 1
            res = disjunction()
            if peek() != ")":
                raise ValueError("Unbalanced parentheses in query")
            pos += 1
            return res
        if tok is None or tok in ("AND", "OR", ")"):
            raise ValueError("Missing search term around boolean operator")
        raw = tokens[pos]
        pos += 1
        phrase = raw.startswith('"')
        words = re.findall(r"[a-z0-9_]{2,32}", raw.lower())
        searchable = [w for w in words if w not in STOPWORDS and not w.isdigit()]
        if not searchable:
            raise ValueError("Terms must contain >=2 Latin alphanumeric chars and not only stopwords/digits")
        return ("TERM", raw.strip('"'), tuple(searchable), phrase, raw.endswith("*") and not phrase)

    def conjunction() -> Any:
        nonlocal pos
        res = atom()
        while peek() not in (None, "OR", ")"):
            if peek() == "AND":
                pos += 1
            res = ("AND", res, atom())
        return res

    def disjunction() -> Any:
        nonlocal pos
        res = conjunction()
        while peek() == "OR":
            pos += 1
            res = ("OR", res, conjunction())
        return res

    tree = disjunction()
    if pos != len(tokens):
        raise ValueError("Unbalanced parentheses in query")
    return tree


def _fts_expr(tree: Any, *, relaxed: bool) -> str:
    def compile_node(node: Any) -> str | None:
        if node[0] == "TERM":
            parts = [f'"{w}"' + ("*" if node[4] else "") for w in node[2]]
            return "(" + " AND ".join(parts) + ")" if len(parts) > 1 else parts[0]
        if node[0] == "NOT":
            return None
        left, right = compile_node(node[1]), compile_node(node[2])
        if node[0] == "OR" and (left is None or right is None):
            raise ValueError("Each OR branch must contain a positive term")
        if node[0] == "AND" and node[2][0] == "NOT" and not relaxed:
            neg = compile_node(node[2][1])
            if left and neg:
                return f"({left} NOT {neg})"
        if node[0] == "AND" and node[1][0] == "NOT" and not relaxed:
            neg = compile_node(node[1][1])
            if right and neg:
                return f"({right} NOT {neg})"
        if left is None:
            return right
        if right is None:
            return left
        return f"({left} {node[0]} {right})"

    expr = compile_node(tree)
    if not expr:
        raise ValueError("At least one positive search term is required")
    return expr


def _has_negation(tree: Any) -> bool:
    if tree[0] == "TERM":
        return False
    if tree[0] == "NOT":
        return True
    return _has_negation(tree[1]) or _has_negation(tree[2])


def _has_phrase(tree: Any) -> bool:
    if tree is None:
        return False
    if tree[0] == "TERM":
        return bool(tree[3])
    if tree[0] == "NOT":
        return _has_phrase(tree[1])
    return _has_phrase(tree[1]) or _has_phrase(tree[2])


def _verification_sql(tree: Any, scopes: tuple[str, ...], comments_union: str) -> tuple[str, list[str]]:
    params: list[str] = []

    def compile_node(node: Any) -> str:
        op = node[0]
        if op == "NOT":
            return f"(NOT {compile_node(node[1])})"
        if op in ("AND", "OR"):
            return f"({compile_node(node[1])} {op} {compile_node(node[2])})"
        if node[3]:
            patterns = [r"(?i)(^|[^\p{L}\p{N}_])" + re.escape(node[1]) + r"($|[^\p{L}\p{N}_])"]
        else:
            patterns = [
                r"(?i)(^|[^\p{L}\p{N}_])" + re.escape(w) + (r"[\p{L}\p{N}_]*" if node[4] else "") + r"($|[^\p{L}\p{N}_])"
                for w in node[2]
            ]
        terms: list[str] = []
        for pattern in patterns:
            fields: list[str] = []
            for scope in scopes:
                if scope == "comments_text":
                    fields.append(
                        f"EXISTS (SELECT 1 FROM ({comments_union}) c "
                        "WHERE c.month = p.month AND c.post_doc_id = p.doc_id "
                        "AND regexp_matches(COALESCE(c.body, ''), ?))"
                    )
                else:
                    fields.append(f"regexp_matches(COALESCE(p.{scope}, ''), ?)")
                params.append(pattern)
            terms.append("(" + " OR ".join(fields) + ")")
        return "(" + " AND ".join(terms) + ")"

    return compile_node(tree), params


def _query_shard(args: tuple[str, str, str, int | None]) -> list[tuple[str, int]]:
    month, uri, expr, doc_id = args
    conn = sqlite3.connect(uri, uri=True, check_same_thread=False)
    try:
        deadline = time.monotonic() + 20.0
        conn.set_progress_handler(lambda: int(time.monotonic() > deadline), 10_000)
        clause = " AND rowid = ?" if doc_id is not None else ""
        params = (expr, doc_id) if doc_id is not None else (expr,)
        rows = conn.execute(
            f"SELECT rowid FROM docs WHERE docs MATCH ?{clause} LIMIT {MAX_SHARD_RECALL + 1}",
            params,
        ).fetchall()
        if len(rows) > MAX_SHARD_RECALL:
            raise ValueError("FTS shard recall exceeded 125,000 candidates; narrow your query")
        return [(month, int(r[0])) for r in rows]
    finally:
        conn.close()


def _recall_candidates(packages: list[MonthPackage], fts_expr: str, doc_id: int | None = None, *, immutable: bool = False) -> list[tuple[str, int]]:
    tasks = [
        (pkg.month, shard.as_uri() + ("?mode=ro&immutable=1" if immutable else "?mode=ro"), fts_expr, doc_id)
        for pkg in packages
        for shard in pkg.fts_shards
    ]
    matched: list[tuple[str, int]] = []
    with ThreadPoolExecutor(max_workers=min(_parallel_budget(), max(1, len(tasks)))) as pool:
        for part in pool.map(_query_shard, tasks):
            matched.extend(part)
            if len(matched) > MAX_TOTAL_RECALL:
                raise ValueError("Total FTS recall exceeded 500,000 candidates; narrow your query")
    return matched


def _union_sql(packages: list[MonthPackage], attr: str, cols: str) -> tuple[str, list[str]]:
    parts: list[str] = []
    params: list[str] = []
    for pkg in packages:
        parts.append(f"SELECT ? AS month, {cols} FROM read_parquet(?)")
        params.append(pkg.month)
        params.append(getattr(pkg, attr).as_posix())
    return " UNION ALL ".join(parts), params


def select_archive_threads(
    packages: list[MonthPackage],
    spec: QuerySpec,
    *,
    additional_query: str = "",
    after: tuple[int, str, int] | None = None,
    evidence: tuple[str, int, str | None] | None = None,
    direct: bool = False,
    config: dict[str, str] | None = None,
) -> SelectionResult:
    """Query open-corpus-v1 packages and return matched posts + bounded comment threads."""
    if not packages:
        raise ValueError("No open-corpus-v1 packages found")
    if spec.limit < 1:
        raise ValueError("limit must be >= 1")
    if any(s not in ALL_SCOPES for s in spec.scopes) or not spec.scopes:
        raise ValueError(f"Invalid search scopes: {spec.scopes}")

    normalized_subs = tuple(dict.fromkeys(s.strip().lower() for s in spec.subreddits if s.strip()))
    if not spec.query.strip() and not normalized_subs and not spec.allow_unscoped:
        raise ValueError("Provide at least --query or --subreddits (or pass --allow-unscoped)")

    from_epoch = _parse_iso_to_epoch(spec.from_iso, ceil=direct)
    to_epoch = _parse_iso_to_epoch(spec.to_iso, ceil=direct)
    if from_epoch is not None and to_epoch is not None and from_epoch >= to_epoch and not direct:
        raise ValueError("--from must be strictly earlier than --to")

    trees = [tree for query in (spec.query, additional_query) if (tree := parse_boolean_query(query)) is not None]
    candidates: list[tuple[str, int]] | None = None
    verification: list[str] = []
    verify_params: list[str] = []

    posts_cols = (
        "doc_id, content_key, created_utc, community, author_key, "
        "score, reported_comments, content_type, domain, flair, title, body, is_truncated"
    )
    comments_cols = "comment_id, post_doc_id, parent_key, created_utc, author_key, score, is_op, body"
    posts_union, posts_union_params = _union_sql(packages, "posts_parquet", posts_cols)
    comments_union, comments_union_params = _union_sql(packages, "comments_parquet", comments_cols)

    for tree in trees:
        narrow = set(spec.scopes) != set(ALL_SCOPES)
        # FTS evaluates plain terms directly. Verify phrases and complex negation over Parquet.
        need_verify = _has_phrase(tree) or narrow or (direct and _has_negation(tree))
        expr = _fts_expr(tree, relaxed=need_verify)
        recalled = _recall_candidates(packages, expr, evidence[1] if evidence else None, immutable=direct)
        if candidates is None:
            candidates = list(dict.fromkeys(recalled))
        else:
            candidates = list(set(candidates).intersection(recalled))
        if not candidates:
            return SelectionResult(posts=[], comments=[], stats={"ftsCandidates": 0, "matchedPosts": 0, "matchedComments": 0})
        if need_verify:
            verify_scopes = spec.scopes if spec.include_comments else tuple(s for s in spec.scopes if s != "comments_text") or ("title", "body")
            clause, extra = _verification_sql(tree, verify_scopes, comments_union if "comments_text" in verify_scopes else "")
            verification.append(clause)
            verify_params.extend(
                _interleave_verify_params(clause, comments_union, comments_union_params, extra)
                if "comments_text" in verify_scopes
                else extra
            )

    con = duckdb.connect(config=_duckdb_config(config))
    try:
        where_clauses: list[str] = []
        params: list[Any] = []

        if candidates is not None:
            cand_tbl = pa.table({
                "month": pa.array([m for m, _ in candidates], type=pa.string()),
                "doc_id": pa.array([d for _, d in candidates], type=pa.uint32()),
            })
            con.register("fts_candidates", cand_tbl)
            by_month: dict[str, list[int]] = {}
            for m, d in candidates:
                by_month.setdefault(m, []).append(d)
            pruned_parts: list[str] = []
            pruned_params: list[Any] = []
            for pkg in packages:
                m_ids = by_month.get(pkg.month)
                if not m_ids:
                    continue
                lo, hi = min(m_ids), max(m_ids)
                pruned_parts.append(
                    f"SELECT ? AS month, {posts_cols} FROM read_parquet(?) "
                    f"WHERE doc_id BETWEEN ? AND ? "
                    f"AND doc_id IN (SELECT doc_id FROM fts_candidates WHERE month = ?)"
                )
                pruned_params.extend([pkg.month, pkg.posts_parquet.as_posix(), lo, hi, pkg.month])
            if not pruned_parts:
                return SelectionResult(posts=[], comments=[], stats={"ftsCandidates": len(candidates), "matchedPosts": 0, "matchedComments": 0})
            from_sql = f"FROM ({' UNION ALL '.join(pruned_parts)}) p"
            params.extend(pruned_params)
        else:
            from_sql = f"FROM ({posts_union}) p"
            params.extend(posts_union_params)

        if normalized_subs:
            placeholders = ",".join("?" for _ in normalized_subs)
            where_clauses.append(f"p.community IN ({placeholders})")
            params.extend(normalized_subs)
        if from_epoch is not None:
            where_clauses.append("p.created_utc >= ?")
            params.append(from_epoch)
        if to_epoch is not None:
            where_clauses.append("p.created_utc < ?")
            params.append(to_epoch)
        if spec.min_score is not None:
            where_clauses.append("p.score >= ?")
            params.append(spec.min_score)
        if spec.min_comments is not None:
            where_clauses.append("p.reported_comments >= ?")
            params.append(spec.min_comments)
        where_clauses.extend(verification)
        params.extend(verify_params)
        if after is not None:
            created, month, doc_id = after
            where_clauses.append("(p.created_utc < ? OR (p.created_utc = ? AND (p.month, p.doc_id) > (?, ?)))")
            params.extend((created, created, month, doc_id))
        if evidence is not None:
            where_clauses.append("p.month = ? AND p.doc_id = ?")
            params.extend(evidence[:2])

        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""
        order = "p.created_utc DESC, p.month ASC, p.doc_id ASC" if direct else "p.created_utc DESC, p.content_key ASC"
        title = "left(p.title, 1024)" if direct else "p.title"
        body_limit = 24000 if evidence else 360
        body = f"left(p.body, {body_limit})" if direct else "p.body"
        truncated = f"COALESCE(p.is_truncated, false) OR COALESCE(length(p.body), 0) > {body_limit} OR COALESCE(length(p.title), 0) > 1024" if direct else "p.is_truncated"
        post_sql = f"""
            SELECT p.month, p.doc_id, p.content_key, p.created_utc, p.community,
                   p.author_key, p.score, p.reported_comments, p.content_type,
                   p.domain, p.flair, {title} AS title, {body} AS body, COALESCE({truncated}, false) AS is_truncated
            {from_sql}
            {where_sql}
            ORDER BY {order}
            LIMIT ?
        """
        params.append(spec.limit)

        cur = con.execute(post_sql, params)
        col_names = [d[0] for d in cur.description]
        posts = [dict(zip(col_names, row)) for row in cur.fetchall()]

        comments: list[dict[str, Any]] = []
        archived_comments = 0
        selected_comment = None
        if evidence is not None and posts:
            month, doc_id, comment_id = evidence
            cursor = con.execute(f"""
                SELECT month, comment_id, post_doc_id, parent_key, created_utc, author_key, score,
                       left(body, 12000) AS body, length(body) > 12000 AS is_truncated,
                       count(*) OVER () AS total
                FROM ({comments_union}) c
                WHERE month = ? AND post_doc_id = ?
                ORDER BY is_op DESC, score DESC, created_utc ASC, comment_id ASC
                LIMIT ?
            """, [*comments_union_params, month, doc_id, spec.max_comments_per_post])
            columns = [d[0] for d in cursor.description]
            comments = [dict(zip(columns, row)) for row in cursor.fetchall()]
            if comments:
                archived_comments = comments[0]["total"]
                for comment in comments:
                    del comment["total"]
            if comment_id is not None:
                cursor = con.execute(f"""
                    SELECT month, comment_id, post_doc_id, parent_key, created_utc, author_key, score,
                           left(body, 12000) AS body, length(body) > 12000 AS is_truncated
                    FROM ({comments_union}) c
                    WHERE month = ? AND post_doc_id = ? AND comment_id = ?
                    LIMIT 1
                """, [*comments_union_params, month, doc_id, comment_id])
                row = cursor.fetchone()
                if row is not None:
                    selected_comment = dict(zip([d[0] for d in cursor.description], row))
        elif spec.include_comments and spec.max_comments_per_post > 0 and posts:
            post_keys_tbl = pa.table({
                "month": pa.array([p["month"] for p in posts], type=pa.string()),
                "post_doc_id": pa.array([p["doc_id"] for p in posts], type=pa.uint32()),
                "post_content_key": pa.array([p["content_key"] for p in posts], type=pa.string()),
                "community": pa.array([p["community"] for p in posts], type=pa.string()),
            })
            con.register("matched_posts", post_keys_tbl)
            comment_sql = f"""
                WITH ranked AS (
                    SELECT c.month, c.comment_id, c.post_doc_id, c.parent_key,
                           c.created_utc, c.author_key, c.score, c.is_op, c.body,
                           mp.post_content_key, mp.community,
                           ROW_NUMBER() OVER (
                               PARTITION BY c.month, c.post_doc_id
                               ORDER BY c.is_op DESC, c.score DESC, c.created_utc ASC, c.comment_id ASC
                           ) AS rn
                    FROM ({comments_union}) c
                    INNER JOIN matched_posts mp
                      ON c.month = mp.month AND c.post_doc_id = mp.post_doc_id
                )
                SELECT month, comment_id, post_doc_id, parent_key, created_utc,
                       author_key, score, is_op, body, post_content_key, community
                FROM ranked
                WHERE rn <= ?
                ORDER BY month ASC, post_doc_id ASC, rn ASC
            """
            ccur = con.execute(comment_sql, [*comments_union_params, spec.max_comments_per_post])
            ccols = [d[0] for d in ccur.description]
            comments = [dict(zip(ccols, row)) for row in ccur.fetchall()]

        return SelectionResult(
            posts=posts,
            comments=comments,
            stats={
                "ftsCandidates": len(candidates) if candidates is not None else None,
                "matchedPosts": len(posts),
                "matchedComments": len(comments),
                "months": [p.month for p in packages],
                **({"archivedComments": archived_comments, "comment": selected_comment} if evidence else {}),
            },
        )
    finally:
        con.close()


def _allocate_daily_quotas(daily_counts: list[tuple[str, int]], limit: int) -> dict[str, int]:
    """Allocate exact per-day sample quotas proportional to daily volume, covering every active day when possible."""
    if not daily_counts or limit <= 0:
        return {}
    total = sum(cnt for _, cnt in daily_counts)
    if total <= limit:
        return {day: cnt for day, cnt in daily_counts}
    n_days = len(daily_counts)
    if n_days >= limit:
        # Spread 1 sample evenly across `limit` days spanning the full range.
        quotas: dict[str, int] = {}
        for i in range(limit):
            idx = min(n_days - 1, int(i * n_days / limit))
            day = daily_counts[idx][0]
            quotas[day] = quotas.get(day, 0) + 1
        return quotas

    # Reserve 1 slot per active day so no active day collapses to 0, then distribute remaining proportionally.
    quotas = {day: 1 for day, _ in daily_counts}
    remaining = limit - n_days
    excess = [(day, max(0, cnt - 1)) for day, cnt in daily_counts]
    excess_total = sum(c for _, c in excess)
    if remaining > 0 and excess_total > 0:
        remainders: list[tuple[float, str]] = []
        for day, cap in excess:
            if cap <= 0:
                continue
            exact = remaining * (cap / excess_total)
            add = min(cap, int(exact))
            quotas[day] += add
            remainders.append((exact - add, day))
        used = sum(quotas.values())
        leftover = limit - used
        if leftover > 0:
            cap_map = {day: cnt for day, cnt in daily_counts}
            for _, day in sorted(remainders, key=lambda x: (-x[0], x[1])):
                if leftover <= 0:
                    break
                if quotas[day] < cap_map[day]:
                    quotas[day] += 1
                    leftover -= 1
    return quotas


def select_archive_for_analysis(
    packages: list[MonthPackage],
    spec: QuerySpec,
    *,
    config: dict[str, str] | None = None,
) -> SelectionResult:
    """Select archive posts for analytics with exact full-corpus daily census and stratified-by-day sampling.

    Unlike `select_archive_threads` (which returns the latest `ORDER BY created_utc DESC LIMIT N` posts for
    paginated browsing), analytics needs a temporally representative sample across the entire matched date
    range plus exact daily hit counts for SL02 and anomaly detection.
    """
    if not packages:
        raise ValueError("No open-corpus-v1 packages found")
    if spec.limit < 1:
        raise ValueError("limit must be >= 1")
    if any(s not in ALL_SCOPES for s in spec.scopes) or not spec.scopes:
        raise ValueError(f"Invalid search scopes: {spec.scopes}")

    normalized_subs = tuple(dict.fromkeys(s.strip().lower() for s in spec.subreddits if s.strip()))
    if not spec.query.strip() and not normalized_subs and not spec.allow_unscoped:
        raise ValueError("Provide at least --query or --subreddits (or pass --allow-unscoped)")

    from_epoch = _parse_iso_to_epoch(spec.from_iso, ceil=False)
    to_epoch = _parse_iso_to_epoch(spec.to_iso, ceil=False)
    if from_epoch is not None and to_epoch is not None and from_epoch >= to_epoch:
        raise ValueError("--from must be strictly earlier than --to")

    tree = parse_boolean_query(spec.query)
    candidates: list[tuple[str, int]] | None = None
    verification: list[str] = []
    verify_params: list[str] = []

    posts_cols = (
        "doc_id, content_key, created_utc, community, author_key, "
        "score, reported_comments, content_type, domain, flair, title, body, is_truncated"
    )
    comments_cols = "comment_id, post_doc_id, parent_key, created_utc, author_key, score, is_op, body"
    posts_union, posts_union_params = _union_sql(packages, "posts_parquet", posts_cols)
    comments_union, comments_union_params = _union_sql(packages, "comments_parquet", comments_cols)

    if tree is not None:
        narrow = set(spec.scopes) != set(ALL_SCOPES)
        need_verify = _has_phrase(tree) or narrow
        expr = _fts_expr(tree, relaxed=need_verify)
        recalled = _recall_candidates(packages, expr, None, immutable=False)
        candidates = list(dict.fromkeys(recalled))
        if not candidates:
            return SelectionResult(
                posts=[],
                comments=[],
                stats={
                    "ftsCandidates": 0,
                    "totalMatched": 0,
                    "matchedPosts": 0,
                    "matchedComments": 0,
                    "retrievalByDay": [],
                    "months": [p.month for p in packages],
                    "sampled": False,
                },
            )
        if need_verify:
            verify_scopes = spec.scopes if spec.include_comments else tuple(s for s in spec.scopes if s != "comments_text") or ("title", "body")
            clause, extra = _verification_sql(tree, verify_scopes, comments_union if "comments_text" in verify_scopes else "")
            verification.append(clause)
            verify_params.extend(
                _interleave_verify_params(clause, comments_union, comments_union_params, extra)
                if "comments_text" in verify_scopes
                else extra
            )

    con = duckdb.connect(config=_duckdb_config(config))
    try:
        where_clauses: list[str] = []
        params: list[Any] = []
        pkg_by_month = {pkg.month: pkg for pkg in packages}

        if candidates is not None:
            cand_tbl = pa.table({
                "month": pa.array([m for m, _ in candidates], type=pa.string()),
                "doc_id": pa.array([d for _, d in candidates], type=pa.uint32()),
            })
            con.register("fts_candidates", cand_tbl)
            by_month: dict[str, list[int]] = {}
            for m, d in candidates:
                by_month.setdefault(m, []).append(d)
            pruned_parts: list[str] = []
            pruned_params: list[Any] = []
            for pkg in packages:
                m_ids = by_month.get(pkg.month)
                if not m_ids:
                    continue
                lo, hi = min(m_ids), max(m_ids)
                pruned_parts.append(
                    f"SELECT ? AS month, {posts_cols} FROM read_parquet(?) "
                    f"WHERE doc_id BETWEEN ? AND ? "
                    f"AND doc_id IN (SELECT doc_id FROM fts_candidates WHERE month = ?)"
                )
                pruned_params.extend([pkg.month, pkg.posts_parquet.as_posix(), lo, hi, pkg.month])
            if not pruned_parts:
                return SelectionResult(
                    posts=[],
                    comments=[],
                    stats={
                        "ftsCandidates": len(candidates),
                        "totalMatched": 0,
                        "matchedPosts": 0,
                        "matchedComments": 0,
                        "retrievalByDay": [],
                        "months": [p.month for p in packages],
                        "sampled": False,
                    },
                )
            from_sql = f"FROM ({' UNION ALL '.join(pruned_parts)}) p"
            params.extend(pruned_params)
        else:
            from_sql = f"FROM ({posts_union}) p"
            params.extend(posts_union_params)

        if normalized_subs:
            placeholders = ",".join("?" for _ in normalized_subs)
            where_clauses.append(f"p.community IN ({placeholders})")
            params.extend(normalized_subs)
        if from_epoch is not None:
            where_clauses.append("p.created_utc >= ?")
            params.append(from_epoch)
        if to_epoch is not None:
            where_clauses.append("p.created_utc < ?")
            params.append(to_epoch)
        if spec.min_score is not None:
            where_clauses.append("p.score >= ?")
            params.append(spec.min_score)
        if spec.min_comments is not None:
            where_clauses.append("p.reported_comments >= ?")
            params.append(spec.min_comments)
        where_clauses.extend(verification)
        params.extend(verify_params)
        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

        if candidates is not None:
            # Materialize lightweight matched keys once (<= 500k rows -> a few MB) for census + stratified sampling.
            con.execute(
                f"""
                CREATE TEMP TABLE matched_keys AS
                SELECT p.month, p.doc_id, p.created_utc,
                       strftime(to_timestamp(p.created_utc), '%Y-%m-%d') AS day
                {from_sql}
                {where_sql}
                """,
                params,
            )
            daily_rows = con.execute(
                "SELECT day, COUNT(*)::BIGINT AS cnt FROM matched_keys WHERE day IS NOT NULL GROUP BY day ORDER BY day ASC"
            ).fetchall()
        else:
            # Unscoped full-archive browse: aggregate daily counts without materializing 31M keys.
            daily_rows = con.execute(
                f"""
                SELECT strftime(to_timestamp(p.created_utc), '%Y-%m-%d') AS day, COUNT(*)::BIGINT AS cnt
                {from_sql}
                {where_sql}
                GROUP BY 1
                ORDER BY 1 ASC
                """,
                params,
            ).fetchall()

        daily_counts = [(str(r[0]), int(r[1])) for r in daily_rows if r[0] is not None]
        total_matched = sum(cnt for _, cnt in daily_counts)
        retrieval_by_day = [{"month": day[:7], "date": day, "count": cnt} for day, cnt in daily_counts]

        if total_matched == 0:
            return SelectionResult(
                posts=[],
                comments=[],
                stats={
                    "ftsCandidates": len(candidates) if candidates is not None else None,
                    "totalMatched": 0,
                    "matchedPosts": 0,
                    "matchedComments": 0,
                    "retrievalByDay": [],
                    "months": [p.month for p in packages],
                    "sampled": False,
                },
            )

        quotas = _allocate_daily_quotas(daily_counts, spec.limit)
        quota_tbl = pa.table({
            "day": pa.array(list(quotas.keys()), type=pa.string()),
            "quota": pa.array(list(quotas.values()), type=pa.int64()),
            "day_total": pa.array([dict(daily_counts)[d] for d in quotas.keys()], type=pa.int64()),
        })
        con.register("day_quotas", quota_tbl)

        if candidates is not None:
            if total_matched <= spec.limit:
                selected_keys = con.execute("SELECT month, doc_id FROM matched_keys").fetchall()
            else:
                selected_keys = con.execute(
                    """
                    WITH ranked AS (
                        SELECT mk.month, mk.doc_id, dq.quota,
                               ROW_NUMBER() OVER (
                                   PARTITION BY mk.day
                                   ORDER BY hash(mk.month, mk.doc_id)
                               ) AS rn
                        FROM matched_keys mk
                        INNER JOIN day_quotas dq ON mk.day = dq.day
                    )
                    SELECT month, doc_id
                    FROM ranked
                    WHERE rn <= quota
                    """
                ).fetchall()
        else:
            # Pre-filter deterministically per day with ~4x oversampling margin so DuckDB buffers O(limit) rows.
            selected_keys = con.execute(
                f"""
                WITH pre AS (
                    SELECT p.month, p.doc_id, dq.day, dq.quota, dq.day_total,
                           hash(p.month, p.doc_id) AS h
                    {from_sql}
                    INNER JOIN day_quotas dq
                      ON strftime(to_timestamp(p.created_utc), '%Y-%m-%d') = dq.day
                    {where_sql}
                ),
                filtered AS (
                    SELECT month, doc_id, day, quota, h
                    FROM pre
                    WHERE (h % 1000000) < LEAST(
                        1000000,
                        GREATEST(5000, CAST(CEIL((quota * 4.0 / GREATEST(1, day_total)) * 1000000) AS BIGINT))
                    )
                ),
                ranked AS (
                    SELECT month, doc_id, quota,
                           ROW_NUMBER() OVER (PARTITION BY day ORDER BY h) AS rn
                    FROM filtered
                )
                SELECT month, doc_id
                FROM ranked
                WHERE rn <= quota
                """,
                params,
            ).fetchall()

        if not selected_keys:
            return SelectionResult(
                posts=[],
                comments=[],
                stats={
                    "ftsCandidates": len(candidates) if candidates is not None else None,
                    "totalMatched": total_matched,
                    "matchedPosts": 0,
                    "matchedComments": 0,
                    "retrievalByDay": retrieval_by_day,
                    "months": [p.month for p in packages],
                    "sampled": total_matched > 0,
                },
            )

        sel_tbl = pa.table({
            "month": pa.array([str(m) for m, _ in selected_keys], type=pa.string()),
            "doc_id": pa.array([int(d) for _, d in selected_keys], type=pa.uint32()),
        })
        con.register("sampled_keys", sel_tbl)
        sel_by_month: dict[str, list[int]] = {}
        for m, d in selected_keys:
            sel_by_month.setdefault(str(m), []).append(int(d))

        fetch_parts: list[str] = []
        fetch_params: list[Any] = []
        for month, m_ids in sel_by_month.items():
            pkg = pkg_by_month.get(month)
            if not pkg or not m_ids:
                continue
            lo, hi = min(m_ids), max(m_ids)
            fetch_parts.append(
                f"SELECT ? AS month, {posts_cols} FROM read_parquet(?) "
                f"WHERE doc_id BETWEEN ? AND ? "
                f"AND doc_id IN (SELECT doc_id FROM sampled_keys WHERE month = ?)"
            )
            fetch_params.extend([month, pkg.posts_parquet.as_posix(), lo, hi, month])

        post_sql = f"""
            SELECT p.month, p.doc_id, p.content_key, p.created_utc, p.community,
                   p.author_key, p.score, p.reported_comments, p.content_type,
                   p.domain, p.flair, p.title, p.body, COALESCE(p.is_truncated, false) AS is_truncated
            FROM ({' UNION ALL '.join(fetch_parts)}) p
            ORDER BY p.created_utc DESC, p.month ASC, p.doc_id ASC
        """
        cur = con.execute(post_sql, fetch_params)
        col_names = [d[0] for d in cur.description]
        posts = [dict(zip(col_names, row)) for row in cur.fetchall()]

        comments: list[dict[str, Any]] = []
        if spec.include_comments and spec.max_comments_per_post > 0 and posts:
            post_keys_tbl = pa.table({
                "month": pa.array([p["month"] for p in posts], type=pa.string()),
                "post_doc_id": pa.array([p["doc_id"] for p in posts], type=pa.uint32()),
                "post_content_key": pa.array([p["content_key"] for p in posts], type=pa.string()),
                "community": pa.array([p["community"] for p in posts], type=pa.string()),
            })
            con.register("matched_posts", post_keys_tbl)
            comment_sql = f"""
                WITH ranked AS (
                    SELECT c.month, c.comment_id, c.post_doc_id, c.parent_key,
                           c.created_utc, c.author_key, c.score, c.is_op, c.body,
                           mp.post_content_key, mp.community,
                           ROW_NUMBER() OVER (
                               PARTITION BY c.month, c.post_doc_id
                               ORDER BY c.is_op DESC, c.score DESC, c.created_utc ASC, c.comment_id ASC
                           ) AS rn
                    FROM ({comments_union}) c
                    INNER JOIN matched_posts mp
                      ON c.month = mp.month AND c.post_doc_id = mp.post_doc_id
                )
                SELECT month, comment_id, post_doc_id, parent_key, created_utc,
                       author_key, score, is_op, body, post_content_key, community
                FROM ranked
                WHERE rn <= ?
                ORDER BY month ASC, post_doc_id ASC, rn ASC
            """
            ccur = con.execute(comment_sql, [*comments_union_params, spec.max_comments_per_post])
            ccols = [d[0] for d in ccur.description]
            comments = [dict(zip(ccols, row)) for row in ccur.fetchall()]

        return SelectionResult(
            posts=posts,
            comments=comments,
            stats={
                "ftsCandidates": len(candidates) if candidates is not None else None,
                "totalMatched": total_matched,
                "matchedPosts": len(posts),
                "matchedComments": len(comments),
                "retrievalByDay": retrieval_by_day,
                "earliestDay": daily_counts[0][0] if daily_counts else None,
                "latestDay": daily_counts[-1][0] if daily_counts else None,
                "activeDays": len(daily_counts),
                "months": [p.month for p in packages],
                "sampled": total_matched > len(posts),
            },
        )
    finally:
        con.close()


def discover_archive_fast(
    packages: list[MonthPackage],
    *,
    version: str,
    query: str = "",
    subreddits: tuple[str, ...] = (),
    from_iso: str | None = None,
    to_iso: str | None = None,
    verify_exact: bool = False,
    include_samples: bool = True,
    sample_limit: int = 5,
    include_comments_count: bool = True,
    config: dict[str, str] | None = None,
) -> dict[str, Any]:
    """Fast scalar-only R4 discovery (FTS5 recall + Parquet scalar aggregation).

    Separates fast candidate discovery from expensive exact phrase/body verification so
    discovery endpoints respond in sub-second to low-second latency without reading full text.
    """
    t0 = time.perf_counter()
    if not packages:
        raise ValueError("No open-corpus-v1 packages found")

    normalized_subs = tuple(dict.fromkeys(s.strip().lower() for s in subreddits if s.strip()))
    from_epoch = _parse_iso_to_epoch(from_iso, ceil=False)
    to_epoch = _parse_iso_to_epoch(to_iso, ceil=False)
    if from_epoch is not None and to_epoch is not None and from_epoch >= to_epoch:
        raise ValueError("--from must be strictly earlier than --to")

    tree = parse_boolean_query(query)
    needs_exact_verify = bool(tree is not None and (_has_phrase(tree) or _has_negation(tree)))
    run_verify = bool(verify_exact and needs_exact_verify)
    candidates: list[tuple[str, int]] | None = None

    if tree is not None:
        expr = _fts_expr(tree, relaxed=needs_exact_verify)
        recalled = _recall_candidates(packages, expr, None, immutable=True)
        candidates = list(dict.fromkeys(recalled))
        if not candidates:
            return {
                "status": "exact",
                "version": version,
                "months": [p.month for p in packages],
                "query": query.strip(),
                "ftsCandidates": 0,
                "matchedThreads": 0,
                "associatedComments": 0,
                "reportedCommentsSum": 0,
                "needsExactVerify": False,
                "dateRange": {"earliest": None, "latest": None, "activeDays": 0},
                "byMonth": [],
                "topCommunities": [],
                "samples": [],
                "elapsedMs": round((time.perf_counter() - t0) * 1000),
            }

    con = duckdb.connect(config=_duckdb_config(config))
    try:
        scalar_cols = "doc_id, created_utc, community, score, reported_comments"
        verify_cols = f"{scalar_cols}, title, body" if run_verify else scalar_cols
        where_clauses: list[str] = []
        params: list[Any] = []
        pkg_by_month = {pkg.month: pkg for pkg in packages}

        if candidates is not None:
            cand_tbl = pa.table({
                "month": pa.array([m for m, _ in candidates], type=pa.string()),
                "doc_id": pa.array([d for _, d in candidates], type=pa.uint32()),
            })
            con.register("fts_candidates", cand_tbl)
            by_month: dict[str, list[int]] = {}
            for m, d in candidates:
                by_month.setdefault(m, []).append(d)
            pruned_parts: list[str] = []
            pruned_params: list[Any] = []
            for pkg in packages:
                m_ids = by_month.get(pkg.month)
                if not m_ids:
                    continue
                lo, hi = min(m_ids), max(m_ids)
                pruned_parts.append(
                    f"SELECT ? AS month, {verify_cols} FROM read_parquet(?) "
                    f"WHERE doc_id BETWEEN ? AND ? "
                    f"AND doc_id IN (SELECT doc_id FROM fts_candidates WHERE month = ?)"
                )
                pruned_params.extend([pkg.month, pkg.posts_parquet.as_posix(), lo, hi, pkg.month])
            if not pruned_parts:
                return {
                    "status": "exact",
                    "version": version,
                    "months": [p.month for p in packages],
                    "query": query.strip(),
                    "ftsCandidates": len(candidates),
                    "matchedThreads": 0,
                    "associatedComments": 0,
                    "reportedCommentsSum": 0,
                    "needsExactVerify": False,
                    "dateRange": {"earliest": None, "latest": None, "activeDays": 0},
                    "byMonth": [],
                    "topCommunities": [],
                    "samples": [],
                    "elapsedMs": round((time.perf_counter() - t0) * 1000),
                }
            from_sql = f"FROM ({' UNION ALL '.join(pruned_parts)}) p"
            params.extend(pruned_params)
        else:
            posts_union, posts_union_params = _union_sql(packages, "posts_parquet", verify_cols)
            from_sql = f"FROM ({posts_union}) p"
            params.extend(posts_union_params)

        if normalized_subs:
            placeholders = ",".join("?" for _ in normalized_subs)
            where_clauses.append(f"p.community IN ({placeholders})")
            params.extend(normalized_subs)
        if from_epoch is not None:
            where_clauses.append("p.created_utc >= ?")
            params.append(from_epoch)
        if to_epoch is not None:
            where_clauses.append("p.created_utc < ?")
            params.append(to_epoch)

        if run_verify and tree is not None:
            # Verify against post title/body first (much faster than scanning all comment bodies)
            clause, extra = _verification_sql(tree, ("title", "body"), "")
            where_clauses.append(clause)
            params.extend(extra)

        where_sql = ("WHERE " + " AND ".join(where_clauses)) if where_clauses else ""

        if candidates is not None:
            con.execute(
                f"""
                CREATE TEMP TABLE disc_matched AS
                SELECT p.month, p.doc_id, p.created_utc, p.community, p.score, p.reported_comments
                {from_sql}
                {where_sql}
                """,
                params,
            )
            agg_row = con.execute(
                """
                SELECT COUNT(*)::BIGINT,
                       MIN(created_utc)::BIGINT,
                       MAX(created_utc)::BIGINT,
                       COUNT(DISTINCT strftime(to_timestamp(created_utc), '%Y-%m-%d'))::BIGINT,
                       COALESCE(SUM(COALESCE(reported_comments, 0)), 0)::BIGINT
                FROM disc_matched
                """
            ).fetchone()
            month_rows = con.execute(
                "SELECT month, COUNT(*)::BIGINT AS cnt FROM disc_matched GROUP BY month ORDER BY month ASC"
            ).fetchall()
            comm_rows = con.execute(
                "SELECT community, COUNT(*)::BIGINT AS cnt FROM disc_matched WHERE community IS NOT NULL AND community <> '' GROUP BY community ORDER BY cnt DESC, community ASC LIMIT 15"
            ).fetchall()
            matched_threads = int(agg_row[0] or 0) if agg_row else 0
            associated_comments = 0
            if include_comments_count and matched_threads > 0:
                matched_months = {str(r[0]) for r in month_rows}
                c_parts: list[str] = []
                c_params: list[Any] = []
                for pkg in packages:
                    if pkg.month not in matched_months:
                        continue
                    c_parts.append(
                        "SELECT ? AS month, post_doc_id FROM read_parquet(?) "
                        "WHERE post_doc_id IN (SELECT doc_id FROM disc_matched WHERE month = ?)"
                    )
                    c_params.extend([pkg.month, pkg.comments_parquet.as_posix(), pkg.month])
                if c_parts:
                    c_res = con.execute(f"SELECT COUNT(*)::BIGINT FROM ({' UNION ALL '.join(c_parts)}) c", c_params).fetchone()
                    associated_comments = int(c_res[0] or 0) if c_res else 0

            samples: list[dict[str, Any]] = []
            if include_samples and matched_threads > 0 and sample_limit > 0:
                top_keys = con.execute(
                    "SELECT month, doc_id FROM disc_matched ORDER BY COALESCE(score, 0) DESC, created_utc DESC LIMIT ?",
                    [min(20, max(1, sample_limit))],
                ).fetchall()
                if top_keys:
                    s_parts: list[str] = []
                    s_params: list[Any] = []
                    by_m: dict[str, list[int]] = {}
                    for m, d in top_keys:
                        by_m.setdefault(str(m), []).append(int(d))
                    for m, ids in by_m.items():
                        pkg = pkg_by_month.get(m)
                        if not pkg:
                            continue
                        ph = ",".join("?" for _ in ids)
                        s_parts.append(
                            f"SELECT ? AS month, doc_id, community, created_utc, score, reported_comments, "
                            f"left(COALESCE(title, ''), 240) AS title, left(COALESCE(body, ''), 320) AS snippet "
                            f"FROM read_parquet(?) WHERE doc_id IN ({ph})"
                        )
                        s_params.extend([m, pkg.posts_parquet.as_posix(), *ids])
                    if s_parts:
                        scur = con.execute(
                            f"SELECT month, doc_id, community, created_utc, score, reported_comments, title, snippet "
                            f"FROM ({' UNION ALL '.join(s_parts)}) s ORDER BY COALESCE(score, 0) DESC, created_utc DESC",
                            s_params,
                        )
                        for row in scur.fetchall():
                            samples.append({
                                "month": str(row[0]),
                                "docId": int(row[1]),
                                "community": str(row[2] or ""),
                                "createdUtc": int(row[3]) if row[3] is not None else None,
                                "score": int(row[4]) if row[4] is not None else 0,
                                "reportedComments": int(row[5]) if row[5] is not None else 0,
                                "title": str(row[6] or ""),
                                "snippet": str(row[7] or ""),
                            })
        else:
            agg_row = con.execute(
                f"""
                SELECT COUNT(*)::BIGINT,
                       MIN(p.created_utc)::BIGINT,
                       MAX(p.created_utc)::BIGINT,
                       COUNT(DISTINCT strftime(to_timestamp(p.created_utc), '%Y-%m-%d'))::BIGINT,
                       COALESCE(SUM(COALESCE(p.reported_comments, 0)), 0)::BIGINT
                {from_sql}
                {where_sql}
                """,
                params,
            ).fetchone()
            month_rows = con.execute(
                f"SELECT p.month, COUNT(*)::BIGINT AS cnt {from_sql} {where_sql} GROUP BY p.month ORDER BY p.month ASC",
                params,
            ).fetchall()
            comm_rows = con.execute(
                f"SELECT p.community, COUNT(*)::BIGINT AS cnt {from_sql} {where_sql} GROUP BY p.community ORDER BY cnt DESC LIMIT 15",
                params,
            ).fetchall()
            matched_threads = int(agg_row[0] or 0) if agg_row else 0
            associated_comments = 0
            samples = []

        min_utc = int(agg_row[1]) if agg_row and agg_row[1] is not None else None
        max_utc = int(agg_row[2]) if agg_row and agg_row[2] is not None else None
        active_days = int(agg_row[3] or 0) if agg_row else 0
        reported_sum = int(agg_row[4] or 0) if agg_row else 0

        return {
            "status": "exact" if (not needs_exact_verify or run_verify) else "candidate",
            "version": version,
            "months": [p.month for p in packages],
            "query": query.strip(),
            "ftsCandidates": len(candidates) if candidates is not None else matched_threads,
            "matchedThreads": matched_threads,
            "associatedComments": associated_comments,
            "reportedCommentsSum": reported_sum,
            "needsExactVerify": needs_exact_verify and not run_verify,
            "dateRange": {
                "earliest": datetime.fromtimestamp(min_utc, timezone.utc).isoformat() if min_utc is not None else None,
                "latest": datetime.fromtimestamp(max_utc, timezone.utc).isoformat() if max_utc is not None else None,
                "activeDays": active_days,
            },
            "byMonth": [{"month": str(r[0]), "count": int(r[1])} for r in month_rows],
            "topCommunities": [{"community": str(r[0]), "count": int(r[1])} for r in comm_rows if r[0]],
            "samples": samples,
            "elapsedMs": round((time.perf_counter() - t0) * 1000),
        }
    finally:
        con.close()


def _interleave_verify_params(
    verify_sql: str,
    comments_union: str,
    comments_union_params: list[str],
    regex_params: list[str],
) -> list[str]:
    """Match placeholder order between embedded comments_union subqueries and regex parameters."""
    marker = f"({comments_union})"
    if marker not in verify_sql:
        return list(regex_params)
    segments = verify_sql.split(marker)
    out: list[str] = []
    regex_idx = 0
    for i, seg in enumerate(segments):
        q_count = seg.count("?")
        for _ in range(q_count):
            out.append(regex_params[regex_idx])
            regex_idx += 1
        if i < len(segments) - 1:
            out.extend(comments_union_params)
    return out

"""Private read-only HTTP service over an operator-configured open-corpus-v1 root."""
from __future__ import annotations

import argparse
import base64
import hashlib
import hmac
import json
import logging
import multiprocessing
import os
import re
import socket
import sqlite3
import tempfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import BoundedSemaphore

import duckdb
import pyarrow.parquet as parquet
from pyarrow import ArrowInvalid

from .analytics import (
    analyze_archive_scope,
    analyze_documents_payload,
    analytics_runtime_status,
    get_analysis_progress,
    resolve_study_evidence,
)
from .packages import discover_packages
from .query import QuerySpec, select_archive_threads

ARCHIVE_ID = "reddit-local-corpus"
MONTH = re.compile(r"[0-9]{4}-(?:0[1-9]|1[0-2])")
SUBREDDIT = re.compile(r"[a-zA-Z0-9_]{2,32}")
VERSION = re.compile(r"[a-f0-9]{64}")
PAGE_SIZE = 25
PREVIEW_SIZE = 5
COMMENT_LIMIT = 15
MAX_MONTHS = 120
MAX_BODY_BYTES = 16000
MAX_ANALYTICS_BODY_BYTES = 16 * 1024 * 1024


class ServiceError(Exception):
    def __init__(self, status, code):
        self.status = status
        self.code = code


def _canonical(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":")).encode()


def _catalog(root):
    if not root.is_dir():
        raise ServiceError(503, "directory_unreadable")
    try:
        packages = discover_packages(root, contain_paths=True)
    except (ValueError, OSError, RuntimeError) as error:
        logging.warning("Archive discovery failed: %s", error)
        raise ServiceError(503, "package_invalid") from None
    if not packages:
        raise ServiceError(503, "archive_empty")
    if len(packages) > MAX_MONTHS:
        raise ServiceError(503, "archive_too_many_months")
    months = []
    seen = set()
    fingerprints = []
    for pkg in sorted(packages, key=lambda item: item.month):
        if (not MONTH.fullmatch(pkg.month) or pkg.month.startswith("0000-") or pkg.month in seen
                or pkg.manifest.get("policy_version") != "open-corpus-v1"):
            raise ServiceError(503, "package_invalid")
        seen.add(pkg.month)
        for path, required in (
            (pkg.posts_parquet, {"doc_id", "content_key", "created_utc", "community", "author_key",
                                 "score", "reported_comments", "content_type", "domain", "flair",
                                 "title", "body", "is_truncated"}),
            (pkg.comments_parquet, {"comment_id", "post_doc_id", "parent_key", "created_utc",
                                    "author_key", "score", "is_op", "body"}),
        ):
            try:
                if not required.issubset(parquet.read_schema(path).names):
                    raise ServiceError(503, "package_invalid")
            except ArrowInvalid:
                raise ServiceError(503, "package_invalid") from None
        for shard in pkg.fts_shards:
            connection = sqlite3.connect(shard.as_uri() + "?mode=ro&immutable=1", uri=True)
            try:
                entry = connection.execute("SELECT sql FROM sqlite_schema WHERE name = 'docs' AND type = 'table'").fetchone()
                if not entry or "using fts5" not in entry[0].lower():
                    raise ServiceError(503, "package_invalid")
            finally:
                connection.close()
        files = pkg.manifest.get("files", {})
        if files:
            for path in (pkg.posts_parquet, pkg.comments_parquet, *pkg.fts_shards):
                metadata = files.get(path.relative_to(pkg.root).as_posix(), {})
                if path.stat().st_size != metadata.get("bytes"):
                    raise ServiceError(503, "package_invalid")
        start = datetime.fromisoformat(pkg.month + "-01").replace(tzinfo=timezone.utc)
        end = start.replace(year=start.year + 1, month=1) if start.month == 12 else start.replace(month=start.month + 1)
        counts = pkg.manifest.get("counts") or {}
        months.append({"month": pkg.month, "from": start.isoformat(), "to": end.isoformat(),
                       "postsRows": counts.get("posts_rows"), "commentsRows": counts.get("comments_rows")})
        fingerprints.append(pkg.manifest)
    version = hashlib.sha256(_canonical(fingerprints)).hexdigest()
    return {"archiveId": ARCHIVE_ID, "version": version, "months": months}, packages


def _filters(value, *, select_months=False):
    keys = {"query", "subreddits", "from", "to"} | ({"months"} if select_months else set())
    if not isinstance(value, dict) or value.keys() != keys:
        raise ServiceError(400, "invalid_filters")
    query, subs = value["query"], value["subreddits"]
    if not isinstance(query, str) or len(query) > 256 or not isinstance(subs, list) or len(subs) > 32:
        raise ServiceError(400, "invalid_filters")
    if any(not isinstance(sub, str) or not SUBREDDIT.fullmatch(sub) for sub in subs):
        raise ServiceError(400, "invalid_filters")
    bounds = []
    for key in ("from", "to"):
        timestamp = value[key]
        if timestamp is None:
            bounds.append(None)
            continue
        if not isinstance(timestamp, str) or len(timestamp) > 35:
            raise ServiceError(400, "invalid_time_range")
        parsed = datetime.fromisoformat(timestamp)
        if parsed.tzinfo is None:
            raise ServiceError(400, "invalid_time_range")
        bounds.append(parsed.astimezone(timezone.utc))
    if all(bound is not None for bound in bounds) and bounds[0] >= bounds[1]:
        raise ServiceError(400, "invalid_time_range")
    return query, {sub.lower() for sub in subs}, *bounds


def _cursor(secret, fingerprint, token=None, *, post=None):
    if post is not None:
        payload = _canonical([fingerprint, post["created_utc"], post["month"], post["doc_id"]])
        signature = hmac.digest(secret, payload, "sha256")
        return base64.urlsafe_b64encode(signature + payload).decode()
    try:
        raw = base64.b64decode(token, altchars=b"-_", validate=True)
        signature, payload = raw[:32], raw[32:]
        if not hmac.compare_digest(signature, hmac.digest(secret, payload, "sha256")):
            raise ValueError()
        bound, created, month, doc_id = json.loads(payload)
        if bound != fingerprint:
            raise ValueError()
        return created, month, doc_id
    except (ValueError, TypeError):
        raise ServiceError(409, "cursor_invalid") from None


def execute(root, operation, data, secret, config):
    catalog, packages = _catalog(root)
    if operation == "archives":
        return catalog
    required = {"archiveId", "version", "scope", "filters", "reference"}
    optional = {"search": {"cursor"}, "evidence": {"month", "docId", "commentId"}, "preview": set()}[operation]
    if not isinstance(data, dict) or not required <= data.keys() or data.keys() - required - optional:
        raise ServiceError(400, "invalid_request")
    if data["archiveId"] != ARCHIVE_ID:
        raise ServiceError(404, "archive_not_found")
    if not isinstance(data["version"], str) or not VERSION.fullmatch(data["version"]):
        raise ServiceError(400, "invalid_version")
    if data["version"] != catalog["version"]:
        raise ServiceError(409, "archive_version_changed")
    if not isinstance(data["reference"], str) or len(data["reference"]) > 200:
        raise ServiceError(400, "invalid_reference")
    query, subs, start, end = _filters(data["scope"], select_months=True)
    extra, extra_subs, extra_start, extra_end = _filters(data["filters"])
    months = data["scope"]["months"]
    if (not isinstance(months, list) or not 1 <= len(months) <= MAX_MONTHS
            or any(not isinstance(month, str) or not MONTH.fullmatch(month) for month in months)
            or len(set(months)) != len(months)):
        raise ServiceError(400, "invalid_months")
    if not set(months) <= {pkg.month for pkg in packages}:
        raise ServiceError(409, "archive_month_unavailable")

    fingerprint = hashlib.sha256(_canonical({key: data[key] for key in required})).hexdigest()
    after = None
    if "cursor" in data:
        if not isinstance(data["cursor"], str) or len(data["cursor"]) > 2048:
            raise ServiceError(400, "cursor_invalid")
        after = _cursor(secret, fingerprint, data["cursor"])

    evidence = None
    if operation == "evidence":
        month, doc_id, comment_id = data.get("month"), data.get("docId"), data.get("commentId")
        if month not in months or type(doc_id) is not int or not 0 <= doc_id <= 4294967295:
            raise ServiceError(404, "evidence_not_found")
        if comment_id is not None and (not isinstance(comment_id, str) or not 1 <= len(comment_id) <= 120):
            raise ServiceError(400, "invalid_comment")
        evidence = (month, doc_id, comment_id)

    limit = PREVIEW_SIZE if operation == "preview" else PAGE_SIZE
    lower = max((bound for bound in (start, extra_start) if bound is not None), default=None)
    upper = min((bound for bound in (end, extra_end) if bound is not None), default=None)
    communities = subs & extra_subs if subs and extra_subs else subs or extra_subs
    disjoint = (subs and extra_subs and not communities) or (lower and upper and lower >= upper)
    page = {"posts": [], "nextCursor": None, "totalMatches": 0, "sampleSize": 0,
            "isTruncated": False, "months": months}
    if disjoint:
        if evidence:
            raise ServiceError(404, "evidence_not_found")
        return page

    selected = [pkg for pkg in packages if pkg.month in months and (not evidence or pkg.month == evidence[0])]
    result = select_archive_threads(selected, QuerySpec(
        query=query, subreddits=tuple(sorted(communities)),
        from_iso=lower.isoformat() if lower else None, to_iso=upper.isoformat() if upper else None,
        limit=1 if evidence else limit + 1, include_comments=False, allow_unscoped=True,
        max_comments_per_post=COMMENT_LIMIT,
    ), direct=True, additional_query=extra, after=after, evidence=evidence, config=config)
    if evidence:
        comment = result.stats.get("comment")
        if not result.posts or (evidence[2] is not None and comment is None):
            raise ServiceError(404, "evidence_not_found")
        count = result.stats["archivedComments"]
        return {"post": result.posts[0], "comments": result.comments, "archivedComments": count,
                "commentsTruncated": count > len(result.comments), "comment": comment}
    posts = result.posts[:limit]
    more = len(result.posts) > limit
    return {**page, "posts": posts, "sampleSize": len(posts), "isTruncated": more,
            "totalMatches": None if more or after else len(posts),
            "nextCursor": _cursor(secret, fingerprint, post=posts[-1]) if more and operation == "search" else None}


def _worker(out, root, operation, data, secret, config):
    try:
        out.send((200, execute(root, operation, data, secret, config)))
    except ServiceError as error:
        out.send((error.status, {"code": error.code}))
    except sqlite3.Error as error:
        code = "query_timeout" if getattr(error, "sqlite_errorname", "") == "SQLITE_INTERRUPT" else "package_invalid"
        out.send((503, {"code": code}))
    except ValueError as error:
        if "recall exceeded" in str(error):
            out.send((422, {"code": "recall_limit"}))
        else:
            out.send((400, {"code": "invalid_query"}))
    except duckdb.OutOfMemoryException:
        out.send((503, {"code": "query_resource_limit"}))
    except (OSError, duckdb.Error):
        logging.exception("Archive read failed")
        out.send((503, {"code": "package_invalid"}))
    finally:
        out.close()


class ArchiveServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, root, secret, timeout, concurrency, config):
        self.root = root
        self.secret = secret
        self.timeout = timeout
        self.slots = BoundedSemaphore(concurrency)
        self.config = config
        super().__init__(address, Handler)

    def run_query(self, operation, data):
        if not self.slots.acquire(blocking=False):
            return 503, {"code": "archive_busy"}
        try:
            ctx = multiprocessing.get_context("spawn")
            with tempfile.TemporaryDirectory(prefix="r4-query-") as temp:
                config = {**self.config, "temp_directory": Path(temp).as_posix()}
                receiver, sender = ctx.Pipe(duplex=False)
                worker = ctx.Process(target=_worker, args=(sender, self.root, operation, data, self.secret, config))
                with receiver, sender:
                    worker.start()
                    sender.close()
                    try:
                        if not receiver.poll(self.timeout):
                            return 503, {"code": "query_timeout"}
                        return receiver.recv()
                    except EOFError:
                        return 503, {"code": "query_worker_failed"}
                    finally:
                        worker.join(0.1)
                        if worker.is_alive():
                            worker.kill()
                            worker.join()
                        worker.close()
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    def setup(self):
        self.request.settimeout(5)
        super().setup()

    def log_message(self, _format, *_args):
        # HTTP logs would expose request paths supplied by unauthenticated callers.
        pass

    def _respond(self, status, value):
        payload = _canonical(value)
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def _authorized(self):
        actual = self.headers.get("Authorization", "").encode()
        if hmac.compare_digest(actual, b"Bearer " + self.server.secret):
            return True
        self._respond(401, {"code": "invalid_service_token"})
        return False

    def do_GET(self):
        if not self._authorized():
            return
        if self.path == "/health":
            self._respond(200, {"status": "ok", "analytics": analytics_runtime_status()})
        elif self.path.startswith("/analyze/progress?runId="):
            run_id = self.path.split("runId=", 1)[1].split("&", 1)[0]
            progress = get_analysis_progress(run_id)
            if progress is None:
                self._respond(404, {"code": "progress_not_found"})
            else:
                self._respond(200, progress)
        elif self.path == "/archives":
            self._respond(*self.server.run_query("archives", None))
        else:
            self._respond(404, {"code": "unknown_operation"})

    def do_POST(self):
        if not self._authorized():
            return
        operation = self.path.removeprefix("/")
        if operation in {"analyze/documents", "analyze/archive", "analyze/evidence"}:
            try:
                length = int(self.headers.get("Content-Length", "0"))
                if not 1 <= length <= MAX_ANALYTICS_BODY_BYTES:
                    self._respond(413, {"code": "invalid_body_size"})
                    return
                data = json.loads(self.rfile.read(length))
            except (ValueError, socket.timeout):
                self._respond(400, {"code": "invalid_json"})
                return
            self._handle_analytics(operation, data)
            return
        if operation not in {"preview", "search", "evidence"}:
            self._respond(404, {"code": "unknown_operation"})
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if not 1 <= length <= MAX_BODY_BYTES:
                self._respond(413, {"code": "invalid_body_size"})
                return
            data = json.loads(self.rfile.read(length))
        except (ValueError, socket.timeout):
            self._respond(400, {"code": "invalid_json"})
            return
        self._respond(*self.server.run_query(operation, data))

    def _handle_analytics(self, operation, data):
        if not isinstance(data, dict):
            self._respond(400, {"code": "invalid_request"})
            return
        if not self.server.slots.acquire(blocking=False):
            self._respond(503, {"code": "archive_busy"})
            return
        try:
            if operation == "analyze/documents":
                result = analyze_documents_payload(data)
                self._respond(200, result)
                return
            if operation == "analyze/evidence":
                study_id = str(data.get("studyId") or "")
                evidence_id = str(data.get("evidenceId") or "")
                offset = int(data.get("offset") or 0)
                limit = int(data.get("limit") or 20)
                result = resolve_study_evidence(study_id, evidence_id, offset=offset, limit=limit)
                self._respond(200, result)
                return
            # analyze/archive
            catalog, packages = _catalog(self.server.root)
            req_months = data.get("months")
            selected = [pkg for pkg in packages if pkg.month in req_months] if isinstance(req_months, list) and req_months else packages
            if not selected:
                self._respond(409, {"code": "archive_month_unavailable"})
                return
            subreddits = tuple(str(s).lower() for s in (data.get("subreddits") or []) if isinstance(s, str) and SUBREDDIT.fullmatch(s))
            with tempfile.TemporaryDirectory(prefix="r4-analyze-") as temp:
                duckdb_cfg = {**self.server.config, "temp_directory": Path(temp).as_posix()}
                result = analyze_archive_scope(
                    selected,
                    version=catalog["version"],
                    query=str(data.get("query") or ""),
                    subreddits=subreddits,
                    from_iso=data.get("from") if isinstance(data.get("from"), str) else None,
                    to_iso=data.get("to") if isinstance(data.get("to"), str) else None,
                    include_comments=bool(data.get("includeComments", False)),
                    group_by=str(data.get("groupBy") or "group"),
                    profile=str(data.get("profile") or "fast"),
                    limit=int(data.get("limit") or 1000),
                    duckdb_config=duckdb_cfg,
                    run_id=str(data.get("runId") or "") or None,
                )
            self._respond(200, result)
        except ServiceError as error:
            self._respond(error.status, {"code": error.code})
        except KeyError:
            self._respond(404, {"code": "evidence_not_found"})
        except ValueError as error:
            if "recall exceeded" in str(error):
                self._respond(422, {"code": "recall_limit"})
            else:
                self._respond(400, {"code": "invalid_query"})
        except duckdb.OutOfMemoryException:
            logging.warning("Explore analytics DuckDB OOM")
            self._respond(503, {"code": "query_resource_limit"})
        except BrokenPipeError:
            logging.warning("Explore analytics client disconnected before response completed")
        except Exception as error:
            logging.warning("Explore analytics failed: %s", error)
            self._respond(503, {"code": "analytics_unavailable"})
        finally:
            self.server.slots.release()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8765)
    args = parser.parse_args()
    root = os.environ.get("ARCHIVE_ROOT")
    token = os.environ.get("ARCHIVE_SERVICE_TOKEN", "")
    if not root or len(token) < 32 or not re.fullmatch(r"[!-~]+", token):
        parser.error("Configure ARCHIVE_ROOT and an independent ARCHIVE_SERVICE_TOKEN (32+ printable ASCII characters).")

    def budget(key, default, maximum):
        try:
            value = int(os.environ.get(key, default))
            if 1 <= value <= maximum:
                return value
        except ValueError:
            pass
        parser.error(f"{key} must be an integer in [1, {maximum}]")

    config = {
        "threads": str(budget("ARCHIVE_DUCKDB_THREADS", 2, 32)),
        "memory_limit": os.environ.get("ARCHIVE_DUCKDB_MEMORY_LIMIT", "1536MB"),
        "max_temp_directory_size": os.environ.get("ARCHIVE_DUCKDB_TEMP_LIMIT", "2GB"),
    }
    for setting in ("memory_limit", "max_temp_directory_size"):
        if not re.fullmatch(r"[1-9][0-9]{0,5}(?:MB|GB)", config[setting]):
            parser.error(f"{setting} requires an integer followed by MB or GB")
    with ArchiveServer((args.host, args.port), Path(root).resolve(), token.encode(),
                       budget("ARCHIVE_QUERY_TIMEOUT_SECONDS", 7, 60),
                       budget("ARCHIVE_MAX_CONCURRENT_QUERIES", 1, 4), config) as server:
        server.serve_forever()


if __name__ == "__main__":
    main()

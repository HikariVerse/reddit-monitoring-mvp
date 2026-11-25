import json
from pathlib import Path
from threading import Thread
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import pytest

from fixture_pkg import create_synthetic_package
from zst_archive import service

TOKEN = b"archive-fixture-token-" + b"f" * 32
EMPTY = {"query": "", "subreddits": [], "from": None, "to": None}


@pytest.fixture
def archive(tmp_path, monkeypatch):
    for month in ("2026-09", "2026-10"):
        create_synthetic_package(tmp_path, month)
    monkeypatch.setattr(service, "PAGE_SIZE", 2)
    return tmp_path


def test_query_scope_cursor_version_and_evidence(archive):
    def run(operation, data=None):
        return service.execute(archive, operation, data, TOKEN, {})

    catalog = run("archives")
    assert [month["month"] for month in catalog["months"]] == ["2026-09", "2026-10"]
    request = {
        "archiveId": catalog["archiveId"], "version": catalog["version"], "reference": "first",
        "scope": {**EMPTY, "months": ["2026-09", "2026-10"], "query": "coding", "subreddits": ["LocalLLaMA"]},
        "filters": EMPTY,
    }
    first = run("search", request)
    assert first["totalMatches"] is None and first["isTruncated"] and first["sampleSize"] == 2
    assert [(p["month"], p["doc_id"]) for p in first["posts"]] == [("2026-09", 3), ("2026-10", 3)]
    cursor = first["nextCursor"]
    second = run("search", {**request, "cursor": cursor})
    assert [(p["month"], p["doc_id"]) for p in second["posts"]] == [("2026-09", 1), ("2026-10", 1)]
    assert second["nextCursor"] is None
    for change in ({"reference": "second"}, {"filters": {**EMPTY, "query": "DuckDB"}}):
        with pytest.raises(service.ServiceError, match="cursor_invalid"):
            run("search", {**request, "cursor": cursor, **change})

    narrowed = {**request, "filters": {
        **EMPTY, "query": '"DuckDB benchmark"', "from": "2026-10-03T03:59:59Z",
        "to": "2026-10-03T04:00:01Z",
    }}
    assert run("preview", narrowed)["totalMatches"] == 2
    assert run("preview", {**narrowed, "filters": {**narrowed["filters"], "from": "2026-10-03T04:00:00.001Z"}})["totalMatches"] == 0
    assert run("search", {**request, "filters": {**EMPTY, "subreddits": ["programming"]}})["posts"] == []
    thread = run("evidence", {**request, "month": "2026-10", "docId": 1, "commentId": "reddit:comment:com202"})
    assert thread["archivedComments"] == 3 and thread["post"]["reported_comments"] == 18
    assert thread["comment"]["parent_key"] == "reddit:comment:com201"
    with pytest.raises(service.ServiceError, match="evidence_not_found"):
        run("evidence", {**request, "month": "2026-10", "docId": 2})
    with pytest.raises(service.ServiceError, match="archive_not_found"):
        run("preview", {**request, "archiveId": "../archive"})
    manifest = archive / "2026-10" / "manifest.json"
    data = json.loads(manifest.read_text())
    data["version_marker"] = "new"
    manifest.write_text(json.dumps(data))
    with pytest.raises(service.ServiceError, match="archive_version_changed"):
        run("search", request)


def test_catalog_rejects_empty_or_incomplete_package(tmp_path):
    root = tmp_path / "empty"
    root.mkdir()
    with pytest.raises(service.ServiceError, match="archive_empty"):
        service.execute(root, "archives", None, TOKEN, {})
    package = create_synthetic_package(root)
    (package / "corpus" / "posts.parquet").unlink()
    with pytest.raises(service.ServiceError, match="package_invalid"):
        service.execute(root, "archives", None, TOKEN, {})


def test_catalog_refuses_paths_that_escape_root(tmp_path):
    external = create_synthetic_package(tmp_path)
    root = tmp_path / "archive"
    root.mkdir()
    try:
        (root / "2026-10").symlink_to(external, target_is_directory=True)
    except OSError:
        # A missing Windows symlink privilege does not change the traversal predicate.
        from zst_archive.packages import _load_single_package
        with pytest.raises(ValueError, match="escapes"):
            _load_single_package(external, root)
    else:
        with pytest.raises(service.ServiceError, match="package_invalid"):
            service.execute(root, "archives", None, TOKEN, {})


def test_http_auth_timeout_and_recovery(archive: Path):
    with service.ArchiveServer(("127.0.0.1", 0), archive, TOKEN, 0.001, 1, {}) as server:
        thread = Thread(target=server.serve_forever)
        thread.start()

        def get(operation, token=None):
            headers = {"Authorization": "Bearer " + token.decode()} if token else {}
            with urlopen(Request(f"http://127.0.0.1:{server.server_port}/{operation}", headers=headers)) as result:
                return json.load(result)

        try:
            for token in (None, b"wrong"):
                with pytest.raises(HTTPError) as denied:
                    get("archives", token)
                assert denied.value.code == 401
            assert get("health", TOKEN) == {"status": "ok"}
            with pytest.raises(HTTPError) as expired:
                get("archives", TOKEN)
            assert json.load(expired.value)["code"] == "query_timeout"
            server.timeout = 10
            assert get("archives", TOKEN)["archiveId"] == service.ARCHIVE_ID
        finally:
            server.shutdown()
            thread.join()

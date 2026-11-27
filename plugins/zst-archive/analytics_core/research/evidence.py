"""Replayable evidence contracts for scope, metric and source span inspection."""

from difflib import SequenceMatcher
import hashlib
import json
import re

from .features import normalize_for_analysis

VERSION = "evidence-4.0"


def membership(scope, ids, predicate, *, total=None, unit="document"):
    members = sorted(set(ids))
    digest = hashlib.sha256(json.dumps(members, ensure_ascii=False).encode()).hexdigest()[:20]
    return {"kind": "membership", "version": VERSION, "source": scope.meta.get("populations", {}).get("research", {}).get("source"),
            "data_version": scope.meta.get("data_version"), "scope_id": scope.meta.get("scope_id"),
            "unit": unit, "predicate": predicate, "count": len(members) if total is None else total,
            "complete": total is None or total == len(members), "doc_ids": members, "members_digest": digest}


def archive_query(scope):
    meta = scope.meta
    pops = meta.get("populations", {})
    if not (pops.get("archive") and pops.get("retrieval")):
        return None
    archive, retrieval = pops["archive"], pops["retrieval"]
    return {"kind": "archive_query", "version": VERSION, "source": archive["source"],
            "data_version": archive["version"], "scope_id": meta.get("scope_id"), "unit": "thread",
            "filters": archive["filters"], "fts_query": retrieval.get("query", ""),
            "archive_count": archive["size"], "retrieved_count": retrieval["size"]}


def replay(scope, contract, limit=12, *, execute_archive=False):
    limit = max(0, min(int(limit), 100))
    if contract.get("version") != VERSION or contract.get("scope_id") != scope.meta.get("scope_id") or (
            contract.get("data_version") != scope.meta.get("data_version")):
        raise ValueError("证据描述与当前研究范围或数据版本不一致")
    if contract["kind"] == "membership":
        return {"kind": "membership", "count": contract["count"], "complete": contract["complete"],
                "items": scope.evidence(contract["doc_ids"], k=limit)}
    expected = archive_query(scope)
    if contract == expected:
        result = {"kind": "archive_query", "replayed": False, "archive_count": expected["archive_count"],
                  "retrieved_count": expected["retrieved_count"], "filters": expected["filters"]}
        if execute_archive:
            from .scope import ScopeSpec, assemble

            spec = ScopeSpec(**scope.meta["spec"])
            spec.sampling = "fts_only"
            _, rerun = assemble(spec)
            populations = rerun["populations"]
            result.update(replayed=True, archive_count=populations["archive"]["size"], retrieved_count=populations["retrieval"]["size"],
                          counts_match=populations["archive"]["size"] == expected["archive_count"] and
                          populations["retrieval"]["size"] == expected["retrieved_count"])
        return result
    raise ValueError("无法重放证据描述")


def document_spans(raw, focus, relevance, fields):
    """Map passage spans back to normalized source and exact portions of raw text."""
    normalized = normalize_for_analysis(raw)
    blocks = SequenceMatcher(None, normalized, raw, autojunk=False).get_matching_blocks() if (
        raw != normalized and len(raw) <= 6000) else ()
    ranges = relevance.get("focus_coordinates", ())

    def locate(a, b):
        result = {"focus": [a, b], "text": focus[a:b]}
        for part in ranges:
            start, end = part["focus"]
            if start <= a < b <= end:
                offset = part["normalized"][0] - start
                left, right = a + offset, b + offset
                result["normalized"] = [left, right]
                if raw == normalized:
                    result["raw"] = [left, right]
                else:
                    block = next((x for x in blocks if x.a <= left < right <= x.a + x.size), None)
                    if block:
                        result["raw"] = [left + block.b - block.a, right + block.b - block.a]
                    else:
                        result["raw"] = None
                break
        return result

    result = {}
    for name, items in fields.items():
        records = []
        for item in items or []:
            if not valid_span(focus, item):
                continue
            entry = {"method": item.get("method", item.get("source")), "span": locate(item["start"], item["end"])}
            if name == "relations":
                entry.update(source=locate(item["source"]["start"], item["source"]["end"]),
                             target=locate(item["target"]["start"], item["target"]["end"]), direction=item["directed"])
            if name == "aspects":
                entry.update(target=locate(*item["target_span"]), attribute=locate(*item["attribute_span"]),
                             opinion=locate(*item["opinion_span"]))
            records.append(entry)
        result[name] = records
    return result


def valid_span(text, item):
    a, b = item.get("start"), item.get("end")
    if not isinstance(a, int) or not isinstance(b, int) or not 0 <= a < b <= len(text):
        return False
    expected = item.get("s") or item.get("matched") or item.get("raw") or item.get("sentence")
    if expected is not None and expected != text[a:b]:
        return False
    if "directed" in item:
        x, y = item.get("source", {}), item.get("target", {})
        return x.get("entity_id") != y.get("entity_id") and valid_span(text, x) and valid_span(text, y)
    return True


def nested_contract(data, known):
    """Track per-object evidence, excluding lone module-level samples from nested coverage."""
    records, invalid = [], set()

    def walk(value, path):
        if isinstance(value, dict):
            refs = [value["doc_id"]] if isinstance(value.get("doc_id"), str) else []
            for tag in ("doc_ids", "evidence_ref"):
                if isinstance(value.get(tag), (list, tuple)):
                    refs.extend(x for x in value[tag] if isinstance(x, str))
            if refs:
                invalid.update(set(refs) - known)
                valid = sorted(set(refs) & known)
                if valid:
                    records.append({"path": path, "count": len(valid), "doc_ids": valid[:12]})
            for label, item in value.items():
                if label not in {"evidence", "membership", "evidence_contract", "evidence_ref", "doc_ids"}:
                    walk(item, f"{path}.{label}")
        elif isinstance(value, list):
            for index, item in enumerate(value):
                walk(item, f"{path}[{index}]")

    walk(data, "$result")
    return {"objects": len(records), "items": records[:100], "unresolved": sorted(invalid)}

"""Reusable topic assignments, anomaly windows and observed lifecycles."""

from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from math import sqrt

import numpy as np

from research import common, topics

from .corpus import calendar, support, topic_terms
from .study import groups_for


def _diagnostics(info):
    return {key: int(value) if isinstance(value, np.integer) else value for key, value in info.items()}


def _centroid_ids(vectors, members):
    selected = vectors[members]
    selected = selected / np.maximum(np.linalg.norm(selected, axis=1, keepdims=True), 1e-9)
    center = selected.mean(axis=0)
    center /= max(np.linalg.norm(center), 1e-9)
    best = np.argsort(-(selected @ center), kind="stable")
    return [(members[int(j)], float(selected[j] @ center)) for j in best]


def representatives(study, ranked, limit=6):
    result = []
    used = set()
    for i, similarity in ranked:
        row = study.rows[i]
        key = row["thread_id"] or row["document_id"]
        if key in used:
            continue
        used.add(key)
        result.append({"document_id": row["document_id"], "thread_id": row["thread_id"] or None,
                       "excerpt": row["focus"][:360], "similarity": similarity,
                       "evidence_ref": study.evidence([i], role="representative")})
        if len(result) == limit:
            break
    return result


def _topic_space(study):
    def build():
        ids = list(study.core)
        if len(ids) < 8:
            return {}, {}, {}, {"method": "insufficient_support", "stability_ari": None}
        texts = [study.rows[i]["focus"] for i in ids]
        vectors = study.vectors()
        labels, names, info = topics.cluster_passages(vectors, texts, k=study.config.k_topics,
                                                     enhanced=study.config.profile == "balanced",
                                                     name_builder=lambda labels: topic_terms(study, ids, labels))
        groups = defaultdict(list)
        ranked = {}
        for row, label in enumerate(labels):
            groups[int(label)].append(row)
        for label, members in groups.items():
            if label >= 0:
                ranked[label] = [(ids[i], sim) for i, sim in _centroid_ids(vectors, members)]
        return {i: int(label) for i, label in zip(ids, labels, strict=True)}, names, ranked, _diagnostics(info)
    return study._artifact("common_topic_space", build)


def _topic_key(study, label):
    return f"{study.id}:topic:{label}"


def _topic_name(names, label):
    return " / ".join(row["term"] for row in names.get(label, ())[:3]) or f"Topic {label}"


def _topic_evidence(study, ids, label, **extra):
    return study.evidence(ids, topic_id=_topic_key(study, label), **extra)


def topic(study, mid, ids, filters):
    assignment, names, ranks, info = _topic_space(study)
    if not assignment:
        return "insufficient_data", "At least eight study documents required for topic fitting", {}
    members = defaultdict(list)
    for i in ids:
        members[assignment[i]].append(i)
    topics_summary = []
    for label in sorted(set(members) - {-1}):
        group = members[label]
        group_set = set(group)
        row = {"topic_id": _topic_key(study, label), "topic_label": label, "name": _topic_name(names, label),
               **support(study, group), "share": len(group) / len(ids), "terms": names.get(label, []),
               "evidence_ref": _topic_evidence(study, group, label)}
        if mid == "SR08":
            row["groups"] = [{"group": key, "documents": len(items), "evidence_ref": _topic_evidence(study, items, label, group=key)}
                             for key, items in sorted(groups_for(study.rows, group, "group").items())]
            row["days"] = [{"date": day, "documents": len(items), "evidence_ref": _topic_evidence(study, items, label, day=day)}
                           for day, items in sorted(groups_for(study.rows, group, "day").items())]
        if mid in {"SR08", "SR29"}:
            row["representatives"] = representatives(study, (item for item in ranks[label] if item[0] in group_set))
        topics_summary.append(row)
    # S1-02: Always sort topics descending by document volume with stable topic_label tie-break
    topics_summary.sort(key=lambda item: (-item["documents"], item["topic_label"]))
    if mid == "SR08":
        noise = members.get(-1, [])
        state = "exploratory" if topics_summary else "insufficient_data"
        return state, "" if topics_summary else "The selected view contains noise only", {
            "topics": topics_summary, "diagnostics": info, "model": study.model(),
            "noise": {"documents": len(noise), "share": len(noise) / len(ids), "evidence_ref": _topic_evidence(study, noise, -1)}}
    if mid == "SR29":
        return ("exploratory" if topics_summary else "insufficient_data", "", {"topics": topics_summary,
                "selection": "highest similarity to own topic centroid; distinct known threads"})
    dated = [i for i in ids if study.rows[i]["created_utc"] is not None and assignment[i] >= 0]
    if not dated:
        return "missing_fields", "No assigned topics with a creation timestamp", {}
    if mid == "SR24":
        days = calendar(study, ids, filters)
        by_day_label = defaultdict(list)
        for i in dated:
            by_day_label[study.rows[i]["day"], assignment[i]].append(i)
        cells = []
        for day, _, coverage in days:
            for label in sorted(set(members) - {-1}):
                selected = by_day_label.get((day, label), ())
                cells.append({"date": day, "topic_id": _topic_key(study, label),
                              "documents": len(selected) if coverage != "missing" or selected else None,
                              "collection": coverage, "evidence_ref": _topic_evidence(study, selected, label, day=day)})
        return "exploratory", "", {"cells": cells, "days": len(days), "topics": topics_summary, "timezone": "UTC"}
    grouped = defaultdict(list)
    for i in dated:
        stamp = datetime.fromtimestamp(study.rows[i]["created_utc"], timezone.utc)
        grouped[assignment[i], stamp.weekday(), stamp.hour].append(i)
    cells = [{"weekday": day, "hour": hour, "topic_id": _topic_key(study, label), "documents": len(items),
              "evidence_ref": _topic_evidence(study, items, label, weekday=day, hour=hour)}
             for (label, day, hour), items in sorted(grouped.items())]
    return "exploratory", "", {"cells": cells, "timezone": "UTC", "documents_without_assigned_time": len(ids) - len(dated),
                               "absent_cell": "no observed assigned documents"}


def _alerts(study, ids, filters):
    def build():
        days = calendar(study, ids, filters)
        history = []
        scores = []
        events = []
        trend = None
        for day, members, coverage in days:
            count = len(members) if coverage != "missing" or members else None
            antecedent = history[-30:]
            baseline = score = None
            history_count = len(antecedent)
            earlier = tuple(i for records in antecedent for i in records)
            if coverage == "complete":
                if history_count >= 7:
                    previous = [len(records) for records in antecedent]
                    baseline = float(np.mean(previous))
                    deviation = float(np.std(previous))
                    score = (count - baseline) / (deviation if deviation > 1e-9 else sqrt(max(1, baseline)))
                history.append(members)
            else:
                history.clear()
            direction = 1 if score is not None and score >= 3.0 else -1 if score is not None and score <= -3.0 else None
            if direction is not None and trend == direction:
                events[-1].append((day, members, score))
            elif direction is not None:
                events.append([(day, members, score)])
            trend = direction
            scores.append({"date": day, "documents": count, "collection": coverage, "baseline": baseline,
                           "z": score, "observed_history_days": history_count, "alert": direction,
                           "evidence_ref": study.evidence(members, role="alert_day", day=day),
                           "history_evidence": study.evidence(earlier, role="previous_complete_days", before=day)})
        return scores, events
    return study._artifact(("alerts", filters), build)


def _characteristics(study, ids):
    texts = [study.rows[i]["focus"] for i in ids]
    supported = defaultdict(set)
    for i in ids:
        for entity in study.v4_features.get(i, {}).get("entities", ()):
            if entity.get("entity_id") and entity.get("status") != "unresolved":
                supported[entity.get("canonical") or entity.get("s", entity["entity_id"])].add(i)
    attributes = defaultdict(set)
    for i in ids:
        for item in study.v4_features.get(i, {}).get("attrs", ()):
            attributes[str(item)].add(i)

    def summarize(values, role):
        return [{"label": key, "documents": len(members), "evidence_ref": study.evidence(members, **{role: key})}
                for key, members in sorted(values.items(), key=lambda item: (-len(item[1]), item[0]))[:8]]
    return {"terms": common.top_terms(texts, 8), "entities": summarize(supported, "entity"),
            "attributes": summarize(attributes, "attribute")}


def _event_details(study, windows, filters):
    def build():
        events = []
        lookup = {i: index for index, i in enumerate(study.core)}
        for event in windows:
            group = [i for _, members, _ in event for i in members]
            result = {"event_id": event[0][0], "start": event[0][0], "end": event[-1][0], "documents": len(group),
                      "direction": "surge" if event[0][2] > 0 else "dip",
                      "peak_abs_z": max(abs(score) for _, _, score in event), "alerts": len(event),
                      "evidence_ref": study.evidence(group, role="alert_window", start=event[0][0], end=event[-1][0]),
                      "window_topics": [], **_characteristics(study, group)}
            if len(group) >= 8:
                vectors = study.vectors()[[lookup[i] for i in group]]
                labels, names, info = topics.cluster_passages(vectors, [study.rows[i]["focus"] for i in group],
                                                             k=study.config.k_topics, enhanced=study.config.profile == "balanced",
                                                             name_builder=lambda labels: topic_terms(study, group, labels))
                result["representatives"] = representatives(study, (
                    (group[j], sim) for j, sim in _centroid_ids(vectors, list(range(len(group))))))
                for label in sorted(set(labels) - {-1}):
                    indexes = np.flatnonzero(labels == label).tolist()
                    items = [group[j] for j in indexes]
                    reps = representatives(study, ((group[j], sim) for j, sim in _centroid_ids(vectors, indexes)))
                    result["window_topics"].append({"name": _topic_name(names, label), **support(study, items),
                                                    "terms": names.get(label, ()), "representatives": reps,
                                                    "evidence_ref": study.evidence(items, window=result["start"], cluster=int(label))})
                result["topic_diagnostics"] = _diagnostics(info)
            else:
                result["topic_diagnostics"] = {"method": "insufficient_support"}
                result["representatives"] = representatives(study, ((i, None) for i in group))
            events.append(result)
        return events
    return study._artifact(("event_details", filters), build)


def _lifecycles(study, windows, ids, filters):
    lifecycles = []
    days = calendar(study, ids, filters)
    for index, event in enumerate(windows):
        start, end = event[0][0], event[-1][0]
        group = [i for _, members, _ in event for i in members]
        peak = min(event, key=lambda item: (-abs(item[2]), item[0]))[0]
        onset = (date.fromisoformat(start) - timedelta(days=7)).isoformat()
        tail = (date.fromisoformat(end) + timedelta(days=3)).isoformat()
        previous = windows[index - 1][-1][0] if index else None
        next_window = windows[index + 1][0][0] if index + 1 < len(windows) else None
        phases = defaultdict(list)
        for day, members, coverage in days:
            if onset <= day < start and (previous is None or day > previous):
                phases["before_window"].append((day, members, coverage))
            elif start <= day <= end:
                key = "peak" if day == peak else ("before_peak" if day < peak else "after_peak")
                phases[key].append((day, members, coverage))
            elif end < day <= tail and (next_window is None or day < next_window):
                phases["after_window"].append((day, members, coverage))
        output = []
        for phase, cells in phases.items():
            indices = [i for _, members, _ in cells for i in members]
            output.append({"phase": phase, "start": cells[0][0], "end": cells[-1][0], **support(study, indices),
                           "complete_days": sum(coverage == "complete" for _, _, coverage in cells),
                           "observations": [{"date": day, "documents": len(members) if coverage != "missing" else None,
                                             "collection": coverage, "evidence_ref": study.evidence(members, day=day, phase=phase)}
                                            for day, members, coverage in cells],
                           "evidence_ref": study.evidence(indices, phase=phase, event_id=start)})
        first = min((study.rows[i]["day"] for i in group), default=None)
        earliest = min((study.rows[i]["created_utc"] for i in group), default=None)
        collected = min((study.rows[i]["observed_at"] for i in group if study.rows[i]["observed_at"] is not None), default=None)
        lifecycles.append({"event_id": start, "start": start, "end": end, "peak": peak,
                           "first_observed_day": first, "earliest_created_utc": earliest, "earliest_collection_utc": collected,
                           "phases": output, "first_evidence": study.evidence((i for i in group if study.rows[i]["day"] == first),
                                                                             day=first, event_id=start),
                           "evidence_ref": study.evidence(group, role="alert_window", start=start, end=end)})
    return lifecycles


def temporal(study, mid, ids, filters):
    scores, windows = _alerts(study, ids, filters)
    has_history = any(row["z"] is not None for row in scores)
    state = "ready" if has_history else "insufficient_data"
    reason = "" if has_history else "Seven previous consecutive complete collection days required"
    if mid == "SL04":
        return state, reason, {"days": scores, "anomalies": [row for row in scores if row["alert"]],
                               "window_days": 30, "min_history_days": 7,
                               "flat_history_scale": "sqrt(max(1, historical mean))", "z_threshold": 3}
    if mid == "SL15":
        return state, reason, {"events": _event_details(study, windows, filters)}
    lifecycles = study._artifact(("lifecycles", filters), lambda: _lifecycles(study, windows, ids, filters))
    if mid == "SL17":
        return state, reason, {"lifecycles": lifecycles, "stage_method": "peak absolute anomaly score within each window",
                               "time_semantics": "observed in supplied population"}
    details = _event_details(study, windows, filters)
    return state, reason, {"summaries": [{**event, "first_observed_day": life["first_observed_day"],
                                           "earliest_created_utc": life["earliest_created_utc"], "peak": life["peak"],
                                           "stages": life["phases"]}
                                          for event, life in zip(details, lifecycles, strict=True)],
                           "summary_method": "extractive_terms_entities_attributes_and_source_evidence"}

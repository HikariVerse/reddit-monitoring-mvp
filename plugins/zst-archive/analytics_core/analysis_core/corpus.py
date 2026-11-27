"""Corpus, calendar, interaction and lexical operators."""

from collections import Counter, defaultdict
from calendar import monthrange
from datetime import date, timedelta
from itertools import combinations

import numpy as np
from scipy.sparse import csr_matrix
from sklearn.feature_extraction import DictVectorizer
from sklearn.feature_extraction.text import TfidfTransformer

from cpu_runtime import operator
from research import semantics, stats
from research.batching import ordered_map
from textproc import content_tokens, detect_language, tokenize

from .study import groups_for


def support(study, ids):
    rows = study.rows
    threads = {rows[i]["thread_id"] for i in ids} - {""}
    authors = {rows[i]["author_key"] for i in ids} - {""}
    return {"documents": len(ids), "threads": len(threads), "authors": len(authors),
            "thread_coverage": sum(bool(rows[i]["thread_id"]) for i in ids),
            "author_coverage": sum(bool(rows[i]["author_key"]) for i in ids)}


def calendar(study, ids, filters):
    by_day = groups_for(study.rows, ids, "day")
    observed = {*by_day, *study.coverage_days}
    start = filters.start or min(observed, default=None)
    end = filters.end or max(observed, default=None)
    if start is None or end is None or start > end:
        return []
    since, until = date.fromisoformat(start), date.fromisoformat(end)
    days = ((since + timedelta(days=offset)).isoformat() for offset in range((until - since).days + 1))
    return [(day, tuple(by_day.get(day, ())), study.coverage_days.get(day, "partial" if day in by_day else "missing"))
            for day in days]


def series(study, cells, unit="day", **scope):
    buckets = defaultdict(list)
    for day, ids, coverage in cells:
        parsed = date.fromisoformat(day)
        anchor = day if unit == "day" else (parsed - timedelta(days=parsed.weekday())).isoformat() if unit == "week" else day[:7]
        buckets[anchor].append((ids, coverage))
    rows = []
    previous = None
    for period, members in buckets.items():
        ids = tuple(i for indices, _ in members for i in indices)
        expected = 1 if unit == "day" else 7 if unit == "week" else monthrange(*map(int, period.split("-")))[1]
        complete = sum(status == "complete" for _, status in members)
        any_collected = any(status != "missing" for _, status in members) or bool(ids)
        count = len(ids) if any_collected else None
        usable = count if complete == expected else None
        rows.append({"period": period, "documents": count, "collection": "complete" if usable is not None else
                     "partial" if any_collected else "missing", "complete_days": complete, "expected_days": expected,
                     "delta": usable - previous if usable is not None and previous is not None else None,
                     "growth": (usable - previous) / previous if usable is not None and previous else None,
                     "evidence_ref": study.evidence(ids, period=period, grain=unit, **scope)})
        previous = usable
    return rows


def overview(study, mid, ids, filters):
    if mid == "SL01":
        cells = calendar(study, ids, filters)
        return ("ready" if any(cell[2] == "complete" for cell in cells) else "exploratory" if cells else "missing_fields",
                "" if cells else "No created time or collection coverage",
                {"days": series(study, cells), "weeks": series(study, cells, "week"),
                 "months": series(study, cells, "month"), "documents_without_date": len(ids) - sum(len(cell[1]) for cell in cells)})
    meaningful = [i for i in ids if len(study.rows[i]["focus"].strip()) >= 20
                  and sum(char.isalnum() for char in study.rows[i]["focus"]) >= 12]
    base = support(study, ids)
    if not base["thread_coverage"]:
        base["threads"] = None
    if not base["author_coverage"]:
        base["authors"] = None
    return ("ready" if base["thread_coverage"] == base["author_coverage"] == len(ids) else "exploratory", "",
            {**base, "denominator": len(ids), "meaningful_documents": len(meaningful), "meaningful_rate": len(meaningful) / len(ids),
             "meaningful_rule": "focus ≥20 characters, ≥12 alphanumeric characters",
             "denominator_evidence": study.evidence(ids, role="research_documents"),
             "evidence_ref": study.evidence(meaningful, role="meaningful_discussion"),
             "thread_evidence": study.evidence((i for i in ids if study.rows[i]["thread_id"]), role="thread_coverage"),
             "author_evidence": study.evidence((i for i in ids if study.rows[i]["author_key"]), role="author_coverage")})


def archive(study, mid, ids, filters):
    from research.populations import attention_series

    meta = study.archive_meta
    raw, match = (meta.get("populations", {}).get(key) for key in ("archive", "retrieval"))
    if not raw or not match or any(raw[key] != match[key] for key in ("source", "unit", "version", "filters")):
        return "unsupported_source", "Comparable admitted-thread ledger and retrieval census required", {}
    if filters.groups or filters.kinds or filters.sources and filters.sources != (raw["source"],):
        return "unsupported_source", "This filter has no matching indexed admission denominator", {}
    daily = attention_series(meta)
    if sum(row["matched_threads"] for row in daily) != match["size"] or sum(row["admitted_posts"] for row in daily) != raw["size"]:
        return "failed", "Daily ledger and retrieval counts do not reconcile with the population totals", {}
    days = [row for row in daily if (not filters.start or row["date"] >= filters.start)
            and (not filters.end or row["date"] <= filters.end)]
    num = sum(row["matched_threads"] for row in days) if filters.start or filters.end else match["size"]
    den = sum(row["admitted_posts"] for row in days) if filters.start or filters.end else raw["size"]
    if not 0 <= num <= den:
        return "failed", "Archive census and ledger counts inconsistent", {}
    base = {"archive_version": raw["version"], "archive_filters": raw["filters"], "query": match.get("query"),
            "seeds": meta.get("spec", {}).get("seeds", ())}

    def proof(count, kind, start, end):
        return study.external_evidence(count, **base, kind=kind, start=start, end=end)

    for row in days:
        row["evidence_ref"] = proof(row["matched_threads"], "matched_threads", row["date"], row["date"])
        row["denominator_evidence"] = proof(row["admitted_posts"], "admitted_threads", row["date"], row["date"])
    return ("ready" if den else "insufficient_data", "" if den else "No admitted threads in the interval",
            {"numerator": num, "denominator": den, "rate": num / den if den else None, "per_million": 1e6 * num / den if den else None,
             "population": {"numerator": match, "denominator": raw}, "days": days,
             "evidence_ref": proof(num, "matched_threads", filters.start, filters.end),
             "denominator_evidence": proof(den, "admitted_threads", filters.start, filters.end)})


def quality(study, mid, ids, filters):
    kept = set(ids)
    links = {row["doc_id"]: row["retained_id"] for row in study.dedupe.get("pairs", ())}
    duplicates = defaultdict(list)
    for row in study.dedupe.get("pairs", ()):
        canonical = row["retained_id"]
        while canonical in links:
            canonical = links[canonical]
        root = study.by_id.get(canonical)
        dupe = study.by_id.get(row["doc_id"])
        if root is not None and dupe is not None and study.matches(dupe, filters):
            duplicates[root].append((dupe, row["method"]))
    out = []
    exact = near = 0
    for root, items in sorted(duplicates.items()):
        exact += sum(method == "normalized_exact" for _, method in items)
        near += sum(method == "simhash_hamming" for _, method in items)
        out.append({"retained_id": study.rows[root]["document_id"], "retained_in_view": root in kept, "removed": len(items),
                    "methods": dict(Counter(method for _, method in items)),
                    "evidence_ref": study.evidence([root, *(i for i, _ in items)], role="dedupe_group",
                                                  retained_id=study.rows[root]["document_id"])})
    return "ready", "", {"before": len(ids) + exact + near, "kept": len(ids), "exact": exact, "near": near, "groups": out,
                         "evidence_ref": study.evidence(ids, role="retained_documents")}


def compare(study, mid, ids, filters):
    groups = groups_for(study.rows, ids, "group")
    rows = []
    for key, members in sorted(groups.items()):
        row = {"group": key, **support(study, members), "share": len(members) / len(ids),
               "evidence_ref": study.evidence(members, group=key)}
        row["days"] = series(study, calendar(study, members, filters), group=key)
        rows.append(row)
    return ("ready" if len(groups) > 1 else "exploratory" if groups else "missing_fields",
            "" if groups else "Group field unavailable", {"groups": rows, "unassigned_documents": len(ids) - sum(map(len, groups.values()))})


def engagement(study, mid, ids, filters):
    columns = defaultdict(list)
    population = groups_for(study.rows, ids, "source_id")
    for i in ids:
        row = study.rows[i]
        for channel, value in row["engagement_channels"].items():
            columns[(row["source_id"], row["kind"], row["group"], channel)].append((i, value))
    eligible = {(source, kind, group): len(members) for source, source_ids in population.items()
                for (kind, group), members in _engagement_strata(study, source_ids).items()}
    output = []
    for (source, kind, group, name), records in sorted(columns.items()):
        members, values = zip(*records, strict=True)
        output.append({"source": source, "kind": kind, "channel": name, "group": group, **stats.desc(values),
                       "p25": float(np.quantile(values, .25)), "p75": float(np.quantile(values, .75)),
                       "p95": float(np.quantile(values, .95)), "zero_count": values.count(0),
                       "eligible_documents": eligible[source, kind, group],
                       "missing_documents": eligible[source, kind, group] - len(values),
                       "coverage": len(values) / eligible[source, kind, group],
                       "zero_rate": values.count(0) / len(values),
                       "evidence_ref": study.evidence(members, source=source, kind=kind, group=group, channel=name)})
    return ("ready" if output else "missing_fields", "" if output else "No observed engagement channels",
            {"channels": output, "study_documents": len(ids), "source_normalization": "none; channels separated"})


def _engagement_strata(study, ids):
    groups = defaultdict(list)
    for i in ids:
        groups[study.rows[i]["kind"], study.rows[i]["group"]].append(i)
    return groups


def linguistics(study):
    def build():
        if study.config.profile == "fast":
            return {}
        from research.nlp import get_provider
        from .study import UnavailableDependency
        try:
            provider = get_provider("balanced")
            if provider is None:
                raise UnavailableDependency("Balanced requires spaCy and en_core_web_sm")
            texts = [study.rows[i]["focus"] for i in study.core]
            with operator("spacy_nlp_pipe"):
                return dict(zip(study.core, provider.analyze(texts), strict=True))
        except (ImportError, OSError) as exc:
            raise UnavailableDependency("Balanced requires spaCy and en_core_web_sm") from exc
    return study._artifact("linguistic", build)


def _lexical_rows(items):
    records = []
    for text, lang, parsed in items:
        language = parsed.get("language") or lang or detect_language(text)[0]
        counts = Counter()
        tokens_by_start = {item["start"]: item["lemma"].casefold() for item in parsed.get("tokens", ()) if item["lemma"]}
        for start, _, sentence in semantics.sentences(text[:12000]):
            tokens = [(token, token) for token in tokenize(sentence)]
            if tokens_by_start:
                tokens = [(token["text"].casefold(), tokens_by_start[token["start"]])
                          for token in parsed["tokens"] if start <= token["start"] < start + len(sentence)
                          and token["text"].isalpha()]
            allowed = set(content_tokens((lemma for _, lemma in tokens), language))
            words = [lemma if lemma in allowed else None for _, lemma in tokens]
            for width in (1, 2, 3):
                counts.update(f"{width}:" + " ".join(words[i:i+width]) for i in range(len(words) - width + 1)
                              if all(words[i:i+width]))
        if parsed.get("word_segmentation") == "jieba":
            counts = Counter({key: count for key, count in counts.items() if not key.startswith("1:")})
            counts.update(f"1:{token}" for token in parsed["topic_tokens"])
        counts.update("NP:" + span["label"].casefold() for span in parsed.get("noun_phrases", ()) if span.get("label"))
        records.append(counts)
    return records


def _lexicon(study):
    def build():
        parsed = linguistics(study)
        items = [(study.rows[i]["focus"], study.rows[i]["language"], parsed.get(i, {})) for i in study.core]
        chunks = ordered_map(_lexical_rows, items, label="lexical_tokens", parallel=not parsed)
        docs = [row for batch in chunks for row in batch]
        if not docs:
            return {}, np.array([]), csr_matrix((0, 0)), csr_matrix((0, 0)), 0
        with operator("sparse_lexical_index"):
            df = Counter(term for line in docs for term in line)
            usable = sorted(df, key=lambda term: (-df[term], term))[:60_000]
            keep = set(usable)
            vocabulary = DictVectorizer(dtype=np.int32)
            matrix = vocabulary.fit_transform({term: count for term, count in line.items() if term in keep} for line in docs)
        return ({i: j for j, i in enumerate(study.core)}, vocabulary.get_feature_names_out(), matrix, matrix.tocsc(),
                sum(str(item.get("syntax", "")).startswith("spacy") for item in parsed.values()))
    return study._artifact("lexical_index", build)


def topic_terms(study, ids, labels):
    index, names, matrix, _, _ = _lexicon(study)
    if not matrix.shape[1]:
        return {}
    mask = np.asarray([term.startswith(("1:", "2:", "NP:")) for term in names])
    bins = defaultdict(list)
    for i, label in zip(ids, labels, strict=True):
        if label >= 0:
            bins[int(label)].append(index[i])
    if not bins:
        return {}
    counts = np.vstack([np.asarray(matrix[bins[key]].sum(axis=0)).ravel() for key in bins])[:, mask]
    totals = counts.sum(axis=1)
    weights = np.log1p(max(1., totals.mean()) / np.maximum(counts.sum(axis=0), 1))
    terms = names[mask]
    result = {}
    for row, label in enumerate(bins):
        scores = counts[row] * weights / max(1, totals[row])
        ranked = np.argsort(-scores, kind="stable")
        chosen = {}
        for j in ranked:
            if scores[j] <= 0:
                break
            chosen.setdefault(str(terms[j]).split(":", 1)[1], float(scores[j]))
            if len(chosen) >= 8:
                break
        result[label] = [{"term": term, "weight": score} for term, score in chosen.items()]
    return result


def lexical(study, mid, ids, filters):
    index, names, matrix, postings, syntax_count = _lexicon(study)
    indices = np.array([index[i] for i in ids], dtype=int)
    if not matrix.shape[1]:
        return "insufficient_data", "No lexical support after cleanup", {}
    counts = np.asarray(matrix[indices].sum(axis=0)).ravel()
    member_base = set(indices)

    def term_record(j, scope_indices, weight, **extra):
        token = str(names[j]).split(":", 1)[1]
        begin, end = postings.indptr[j:j+2]
        member_index = [int(k) for k in postings.indices[begin:end] if k in scope_indices]
        return {"term": token, "documents": len(member_index), "weight": float(weight), **extra,
                "evidence_ref": study.evidence((study.core[x] for x in member_index), term=token,
                                               interpretation=str(names[j]).split(":", 1)[0], **{k: extra[k] for k in ("group",) if k in extra})}

    def top(prefix, weights):
        choices = (j for j, name in enumerate(names) if name.startswith(prefix) and counts[j])
        return [term_record(j, member_base, weights[j], occurrences=int(counts[j]))
                for j in sorted(choices, key=lambda j: (-weights[j], names[j]))[:study.config.top]]

    if mid == "SR04":
        weights = study._artifact("lexical_tfidf", lambda: TfidfTransformer(sublinear_tf=True).fit_transform(matrix))
        weights = weights[indices].sum(axis=0)
        by_group = []
        groups = groups_for(study.rows, ids, "group")
        unigrams = np.flatnonzero([key.startswith("1:") for key in names])
        total_words = int(counts[unigrams].sum())
        ranked_groups = sorted(groups, key=lambda key: (-len(groups[key]), key))
        for group in ranked_groups[:study.config.top]:
            group_indices = [index[i] for i in groups[group]]
            group_counts = np.asarray(matrix[group_indices].sum(axis=0)).ravel()
            group_size = int(group_counts[unigrams].sum())
            if not 0 < group_size < total_words:
                continue
            candidates = ((j, stats.log_odds_ratio(int(group_counts[j]), group_size, int(counts[j] - group_counts[j]),
                                                    total_words - group_size, prior=.5))
                          for j in unigrams if group_counts[j] >= 2)
            top_group = sorted((hit for hit in candidates if hit[1] > 0), key=lambda hit: (-hit[1], names[hit[0]]))[:study.config.top]
            group_set = set(group_indices)
            by_group.append({"group": group, "tokens": group_size, "other_tokens": total_words - group_size,
                             "terms": [term_record(j, group_set, score, group=group, occurrences=int(group_counts[j]))
                                       for j, score in top_group], "evidence_ref": study.evidence(groups[group], group=group)})
        return ("ready" if len(ids) >= 50 else "exploratory"), "", {
                                            "terms": top("1:", np.asarray(weights).ravel()), "by_group": by_group,
                             "tokenizers": {"statistics": "stopwords / lemmas / jieba when available",
                                            "linguistics": "spaCy en_core_web_sm in Balanced",
                                            "embedding": "Potion tokenizer", "full_text": "SQLite unicode61 external to core"}}
    if mid == "SR06":
        parsed = linguistics(study)
        completed = sum(str(parsed.get(i, {}).get("syntax", "")).startswith("spacy") for i in ids)
        return ("ready" if completed and len(ids) >= 100 else "exploratory", "" if completed else "Noun phrases require Balanced English coverage",
                {"bigrams": top("2:", counts), "trigrams": top("3:", counts), "noun_phrases": top("NP:", counts),
                 "syntax_documents": completed, "syntax_corpus_documents": syntax_count})
    groups = groups_for(study.rows, ids, "group")
    keys = sorted(groups, key=lambda group: (-len(groups[group]), group))
    # For the selected view, compare supported major groups in both directions.
    scoped = {key: [index[i] for i in groups[key]] for key in keys[:8] if len(groups[key]) >= 2}
    unigram_ids = np.flatnonzero([key.startswith("1:") for key in names])
    comparisons = []
    for left, right in combinations(scoped, 2):
        aa, bb = scoped[left], scoped[right]
        ca, cb = (np.asarray(matrix[scope].sum(axis=0)).ravel() for scope in (aa, bb))
        na, nb = int(ca[unigram_ids].sum()), int(cb[unigram_ids].sum())
        if not na or not nb:
            continue
        candidates = [(j, stats.log_odds_ratio(int(ca[j]), na, int(cb[j]), nb, prior=.5))
                      for j in unigram_ids if ca[j] + cb[j] >= 3]
        for group, other, sign, inc, exc, members, others in ((left, right, 1, ca, cb, aa, bb), (right, left, -1, cb, ca, bb, aa)):
            chosen = sorted((item for item in candidates if sign * item[1] > 0 and inc[item[0]] >= 2),
                            key=lambda item: (-sign * item[1], names[item[0]]))[:study.config.top]
            terms = []
            for j, delta in chosen:
                value = term_record(j, set(members), sign * delta, group=group,
                                    occurrences=int(inc[j]), other_occurrences=int(exc[j]))
                value["other_evidence"] = term_record(j, set(others), -sign * delta, group=other)["evidence_ref"]
                terms.append(value)
            comparisons.append({"group": group, "other_group": other, "documents": len(members), "other_documents": len(others),
                                "tokens": na if sign == 1 else nb, "other_tokens": nb if sign == 1 else na, "terms": terms,
                                "evidence_ref": study.evidence((study.core[i] for i in members), group=group, role="lexical_comparison")})
    minimum = min((min(row["documents"], row["other_documents"]) for row in comparisons), default=0)
    return ("ready" if minimum >= 100 else "exploratory" if comparisons else "insufficient_data" if groups else "missing_fields",
            "" if comparisons else "Two groups with consistent lexical support required",
            {"comparisons": comparisons, "prior": .5, "eligible_groups": len(scoped), "omitted_groups": len(groups) - len(scoped)})

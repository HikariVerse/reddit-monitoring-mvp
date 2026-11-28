"""Shared grounded language signals, need/pain clusters and purchase facts."""

from collections import Counter, defaultdict
from itertools import chain
import re

import numpy as np

from research import demand as states, features, lexicon, semantics, sentiment as legacy_sentiment, stats, topics
from research.batching import ordered_map

from .corpus import linguistics, support
from .structure import _centroid_ids, _diagnostics, _topic_name
from .study import groups_for, stable_id


SENTIMENTS = {"非观点": "non_opinion", "未知": "unknown", "含混": "mixed", "中性": "neutral",
              "正面": "positive", "负面": "negative"}
PURCHASE = {"explicit_need": "need", "recommendation_request": "research", "alternative_considered": "compare",
            "purchase_intent": "intent", "purchased": "purchased", "solution_satisfied": "use",
            "solution_dissatisfied": "use", "solution_rejected": "use"}
ACTIVE = states.ACTIVE | {"solution_search", "alternative_search", "bundled_need"}
INTENT_STATES = {"寻找解决方案": "solution_search", "寻找替代品": "alternative_search", "组合需求": "bundled_need",
                 "求推荐": "recommendation_request", "功能请求": "feature_request"}
USE = re.compile(r"\b(?:i|we|my|our)\b.{0,36}\b(?:use|using|own|owned|used|tested|tried|installed)\b|我用|用了", re.I)
# S1-10: Anchor "how much" to price/cost/purchase verbs so non-price quantity questions
# ("how much sound leakage", "how much of the Excel workbook") are not misclassified.
PRICE_ATTENTION = re.compile(
    r"\b(?:price|pricing|costs?|budget|afford\w*|overpriced|expensive|cheaper|"
    r"list price|subscription|coupon|discount|value for money|msrp|"
    r"spend\s+(?:so\s+)?much\s+money|"
    r"how much\s+(?:does|do|did|is|are|was|were|would|will|to\s+(?:buy|pay|spend|cost)|for\b|it\s+costs?))\b"
    r"|价格|定价|价位|预算|订阅|太贵|便宜|多少钱|性价比|降价|优惠|划算",
    re.I,
)
RETURN = re.compile(r"\b(?:i|we)\s+(?:have\s+)?(?:returned|sent it back|got a refund)\b|已退货|已经退货", re.I)
SUBSCRIPTION = re.compile(r"\b(?:subscription|subscribe|annual billing)\b|订阅", re.I)
PAIN_EXCLUDE_RE = re.compile(
    r"\b(?:open[- ]box|seal(?:ed)?\s+broken|brand new in box|for sale|wtb|wts|"
    r"thanks in advance|this community is amazing|"
    r"to their credit.{0,60}refund|offered to refund|promptly issued a full refund|"
    r"honored the warranty|replaced it for free|great (?:customer )?service)\b|"
    r"免费换新|售后态度点赞|出全新未拆封|出闲置",
    re.I,
)
PAIN_RESOLVED_RE = re.compile(
    r"\b(?:fixed it|solved it|resolved|offered to refund|got a replacement|replaced it|warranty replaced)\b|已解决|已经解决|给退了|换新了",
    re.I,
)


def _sentence_items(text, expression, label):
    for start, _, sentence in semantics.sentences(text):
        for match in expression.finditer(sentence):
            yield {"start": start + match.start(), "end": start + match.end(), "sentence": sentence,
                   "label": label, "method": "bounded_sentence_cue", "coordinate_space": "focus"}


def _semantic_batch(items):
    output = []
    for text, parsed, entities in items:
        # Supply source sentences to the legacy intent extractor so it can
        # return absolute focus offsets even without spaCy.
        anchored = {**parsed, "sentences": parsed.get("sentences") or [sentence for _, _, sentence in semantics.sentences(text)]}
        row = features.semantic_document(text, anchored, entities)
        for fact in row["prices"]:
            clause = fact["context"]
            if fact["kind"] == "订阅" and not SUBSCRIPTION.search(clause):
                # "Per month" supplies the period. A nearby explicit budget
                # or payment cue supplies the amount role independently.
                amount_at = clause.find(fact["raw"])
                cues = [(abs(match.start() - amount_at), role) for role, rx in semantics.PRICE_RE.items()
                        if role != "订阅" for match in rx.finditer(clause)]
                fact["kind"] = min(cues)[1] if cues else "未分类"
        # V4's partial solution also emits an inferred unmet flag. Only
        # direct clauses belong in this contract's explicit-unmet metric.
        row["demand_states"] = [item for item in row["demand_states"]
                                if (item["state"], item["rule_id"]) != ("unmet_need", "partial_solution")]
        present = {item["state"] for item in row["demand_states"]}
        for hit in row["intents"]:
            state = INTENT_STATES.get(hit["intent"])
            if not state or state in present or "end" not in hit or semantics.NEGATE.search(hit["sentence"]):
                continue
            if not 0 <= hit["start"] < hit["end"] <= len(text):
                continue
            row["demand_states"].append({**hit, "state": state, "rule_id": hit["rule"], "method": "business_intent_v4",
                                         "coordinate_space": "focus"})
        pains = []
        for name, rx in lexicon.PAIN_RES:
            for item in _sentence_items(text, rx, name):
                sentence = item["sentence"]
                if re.search(r"\b(?:no|never|not)\s+(?:really\s+)?(?:any\s+)?(?:problems?|issues?|noise|pain|"
                             r"broken|failed|uncomfortable|too expensive)\b", sentence, re.I):
                    continue
                if PAIN_EXCLUDE_RE.search(sentence):
                    continue
                item["resolution_status"] = "resolved" if PAIN_RESOLVED_RE.search(sentence) else "unresolved"
                pains.append(item)
        price = list(_sentence_items(text, PRICE_ATTENTION, "price_attention"))
        stages = [{**item, "stage": PURCHASE[item["state"]]} for item in row["demand_states"] if item["state"] in PURCHASE]
        for label, rx in (("use", USE), ("returned", RETURN)):
            stages.extend({**item, "stage": label} for item in _sentence_items(text, rx, label))
        for fact in row["prices"]:
            if fact["kind"] == "预算":
                stages.append({**fact, "stage": "budget"})
        opinion = list(_sentence_items(text, semantics.OPINION, "opinion_anchor"))
        if not opinion and row["sent"]["label"] != "非观点":
            for start, end, sentence in semantics.sentences(text):
                sentiment = legacy_sentiment.doc_sentiment(sentence)
                if sentiment.get("pos") or sentiment.get("neg"):
                    opinion.append({"start": start, "end": end, "sentence": sentence, "label": "lexicon_clause",
                                    "coordinate_space": "focus", "method": "opinion_lexicon"})
        row.update(pain_spans=pains, price_cues=price, purchase=stages, opinion=opinion,
                   use=list(_sentence_items(text, USE, "usage")))
        output.append(row)
    return output


def _signals(study):
    def build():
        parsed = linguistics(study)
        items = [(study.rows[i]["focus"], parsed.get(i, {}), study.v4_features.get(i, {}).get("entities", ())) for i in study.core]
        chunks = ordered_map(_semantic_batch, items, label="shared_semantic_rules", parallel=not parsed)
        result = dict(zip(study.core, chain.from_iterable(chunks), strict=True))

        # S1-07: Upgrade sentiment consistently across all core docs via V2 multilingual ONNX (CPU INT8 / GPU FP16)
        # No partial random subsampling -> zero silent mixing of lexicon & model labels!
        accel_override = getattr(study.config, "accel_mode", None)
        use_v2_model = getattr(study.config, "use_v2_sentiment", True)
        v2_meta = {"available": False, "device": "rule_fallback", "fallbackReason": "disabled"}
        if use_v2_model and study.core:
            try:
                import v2_runtime

                texts = [study.rows[i]["focus"] for i in study.core]
                sent_preds, v2_meta = v2_runtime.classify_sentiment_batch_v2(texts, accel_override=accel_override)
                if sent_preds and len(sent_preds) == len(study.core):
                    for idx, pred in zip(study.core, sent_preds, strict=True):
                        result[idx]["sent"] = pred
                        # Ensure opinion evidence spans exist for positive/negative/mixed/neutral docs
                        if pred["label"] in ("正面", "负面", "含混", "中性") and not result[idx]["opinion"]:
                            txt = study.rows[idx]["focus"]
                            first_sent = next(semantics.sentences(txt), None)
                            if first_sent:
                                s0, s1, sent_txt = first_sent
                                result[idx]["opinion"] = [{
                                    "start": s0, "end": min(s1, s0 + 260), "sentence": sent_txt[:260],
                                    "label": pred["label"], "coordinate_space": "focus", "method": pred["method"],
                                }]
            except Exception as exc:
                v2_meta = {"available": False, "device": "rule_fallback", "fallbackReason": f"{type(exc).__name__}: {str(exc)[:100]}"}
        study._v2_sentiment_meta = v2_meta
        return result
    return study._artifact("semantic_signals", build)


def replay_claim(study, index, predicate):
    """Reproduce typed feature evidence for a single document in a returned page."""
    focus = study.rows[index]["focus"]
    span = predicate.get("span")
    if span:
        return {"start": span[0], "end": span[1], "excerpt": focus[span[0]:span[1]], "coordinate_space": "focus"}
    signals = _signals(study)[index]
    if "stage" in predicate:
        return {"stage": predicate["stage"], "matches": [hit.copy() for hit in signals["purchase"]
                                                        if hit["stage"] == predicate["stage"]]}
    if "sentiment" in predicate:
        return {"classification": signals["sent"].copy(), "anchors": [hit.copy() for hit in signals["opinion"]]}
    if "state" in predicate:
        return {"state": predicate["state"], "matches": [hit.copy() for hit in signals["demand_states"]
                                                        if hit["state"] == predicate["state"]]}
    if "amount_role" in predicate and "bucket" not in predicate:
        role = predicate["amount_role"]
        matching = []
        for fact in signals["prices"]:
            if any(fact[key] != predicate[key] for key in ("currency", "period", "kind")):
                continue
            if (fact["target_id"] or "unresolved_target") != predicate["target"] or (fact["upper"] is None) != (role == "point"):
                continue
            matching.append({**fact, "amount": fact["upper"] if role == "high" else fact["value"]})
        return {"amount_role": role, "facts": matching}
    return {"amount_role": predicate["amount_role"], "bucket": predicate["bucket"]}


def _span(study, i, hit, **extra):
    start, end = hit["start"], hit["end"]
    doc = study.rows[i]
    return {**hit, **extra, "document_id": doc["document_id"], "excerpt": doc["focus"][start:end],
            "evidence_ref": study.evidence([i], span=[start, end], coordinate_space="focus", **extra)}


def _examples(study, records, limit=6):
    output, seen = [], set()
    for i, hit in records:
        item = study.rows[i]
        key = item["thread_id"] or item["document_id"]
        if key in seen:
            continue
        seen.add(key)
        output.append(_span(study, i, hit))
        if len(output) >= limit:
            break
    return output


def _coverage(study, members, size, examples, **predicate):
    members = list(dict.fromkeys(members))
    counts = support(study, members)
    return {**counts, "denominator": size, "rate": len(members) / size if size else None,
            "evidence_ref": study.evidence(members, **predicate), "examples": _examples(study, examples)}


def sentiment(study, mid, ids, filters):
    sig = _signals(study)

    def row(records, **predicate):
        grouped = defaultdict(list)
        for i in records:
            grouped[SENTIMENTS.get(sig[i]["sent"]["label"], "unknown")].append(i)
        if mid == "SL07":
            confirmed = len(records) - len(grouped["non_opinion"]) - len(grouped["unknown"])
            return {**predicate, "denominator": len(records),
                    "coverage": confirmed / len(records) if records else None,
                    "labels": [{"label": label, **_coverage(study, grouped[label], len(records),
                                 ((i, span) for i in grouped[label] for span in sig[i]["opinion"]),
                                 sentiment=label, **predicate)} for label in SENTIMENTS.values()],
                    "evidence_ref": study.evidence(records, role="sentiment_population", **predicate)}
        pos, neg = grouped["positive"], grouped["negative"]
        den = len(pos) + len(neg)
        polarity = [*pos, *neg]
        return {**predicate, "positive": len(pos), "negative": len(neg), "denominator": den, "research_documents": len(records),
                "unknown": len(grouped["unknown"]), "non_opinion": len(grouped["non_opinion"]),
                "net_sentiment": (len(pos) - len(neg)) / den if den else None,
                "positive_rate": len(pos) / den if den else None, "negative_rate": len(neg) / den if den else None,
                "coverage": den / len(records) if records else None,
                "evidence_ref": study.evidence(polarity, role="positive_or_negative", **predicate),
                "positive_evidence": study.evidence(pos, sentiment="positive", **predicate),
                "negative_evidence": study.evidence(neg, sentiment="negative", **predicate),
                "examples": _examples(study, ((i, span) for i in polarity for span in sig[i]["opinion"]))}

    result = row(ids)
    result["by_group"] = [row(group, group=label) for label, group in sorted(groups_for(study.rows, ids, "group").items())]
    result["by_day"] = [row(group, date=label) for label, group in sorted(groups_for(study.rows, ids, "day").items())]
    result["by_source"] = [row(group, source=label) for label, group in sorted(groups_for(study.rows, ids, "source_id").items())]
    result["methods"] = dict(Counter(sig[i]["sent"]["method"] for i in ids))
    result["runtime"] = getattr(study, "_v2_sentiment_meta", None)
    result["target"] = "in_scope_discussion"
    size = result["denominator"] if mid == "SL09" else sum(item["documents"] for item in result["labels"]
                                                          if item["label"] in {"negative", "positive", "mixed", "neutral"})
    return ("ready" if size >= 100 and result["coverage"] >= .15 else "exploratory" if size else "insufficient_data",
            "" if result["coverage"] else "No supported opinion in the analysis population", result)


REQUESTS = {"PR02": ACTIVE, "PR03": ACTIVE, "OD03": {"feature_request"}, "OD04": {"unmet_need"}}


def demand(study, mid, ids, filters):
    shared = "active_need" if mid in {"PR02", "PR03"} else mid
    return study._artifact(("demand", shared, filters), lambda: _demand(study, mid, ids))


def _demand(study, mid, ids):
    sig = _signals(study)
    accepted = REQUESTS[mid]
    groups = defaultdict(list)
    for i in ids:
        for hit in sig[i]["demand_states"]:
            if hit["state"] in accepted:
                groups[hit["state"]].append((i, hit))
    matches = list(chain.from_iterable(groups.values()))
    key = "active_need" if mid in {"PR02", "PR03"} else mid
    total = _coverage(study, (i for i, _ in matches), len(ids), matches, role=key)
    return ("ready" if total["documents"] >= 100 else "exploratory"), "", {**total, "hits": total["documents"], "states": [
        {"state": name, **_coverage(study, (i for i, _ in group), len(ids), group, state=name)}
        for name, group in sorted(groups.items())], "denominator_evidence": study.evidence(ids, role="demand_population")}


def _candidates(study, ids, mode):
    sig = _signals(study)
    records = {}
    for i in ids:
        hits = sig[i]["pain_spans"] if mode == "pain" else [
            item for item in sig[i]["demand_states"] if item["state"] in ACTIVE]
        for hit in hits:
            sentence = hit.get("sentence", "").strip()
            if len(sentence) < 16:
                continue
            key = (i, sentence.casefold())
            if key not in records or hit.get("state") == "unmet_need":
                records[key] = (i, hit)
    return list(records.values())


def _clusters(study, ids, mode, filters):
    def build():
        candidates = _candidates(study, ids, mode)
        all_support = _coverage(study, (i for i, _ in candidates), len(ids), candidates, role=mode)
        sampled = candidates if len(candidates) <= 6000 else sorted(candidates, key=lambda item: stable_id(
            [study.id, study.rows[item[0]]["document_id"], item[1]["start"]]))[:6000]
        texts = [hit["sentence"][:300] for _, hit in sampled]
        data = {"support": {**all_support, "passages": len(candidates), "clustered_passages": len(sampled) if len(sampled) >= 8 else 0},
                "clusters": [], "noise": None, "diagnostics": {"method": "insufficient_support"}}
        if len(sampled) < 8:
            return data
        vectors = study.embed(texts, 96)
        labels, names, info = topics.cluster_passages(vectors, texts, k=study.config.k_topics,
                                                     enhanced=study.config.profile == "balanced")
        for label in sorted(set(labels) - {-1}):
            members = np.flatnonzero(labels == label).tolist()
            ordered = [sampled[j] for j, _ in _centroid_ids(vectors, members)]
            group = sorted({i for i, _ in ordered})
            states_supported = Counter(hit.get("state") or hit.get("label") for _, hit in ordered)
            unmet = {i for i, hit in ordered if hit.get("state") == "unmet_need"}
            by_group = groups_for(study.rows, group, "group")
            by_day = groups_for(study.rows, group, "day")
            by_source = groups_for(study.rows, group, "source_id")
            data["clusters"].append({"cluster_id": f"{study.id}:{mode}:{int(label)}", "name": _topic_name(names, label),
                                     **support(study, group), "passages": len(members), "terms": names.get(label, []),
                                     "states": dict(states_supported), "representatives": _examples(study, ordered),
                                     "unmet_documents": len(unmet),
                                     "unmet_evidence": study.evidence(unmet, role="explicit_unmet", cluster=int(label)),
                                     "breakdown": {key: [{key: label, "documents": len(items),
                                                          "evidence_ref": study.evidence(items, **{key: label})}
                                                         for label, items in sorted(values.items())]
                                                   for key, values in (("group", by_group), ("day", by_day), ("source", by_source))},
                                     "evidence_ref": study.evidence(group, role=mode, cluster=int(label)),
                                     "document_overlap_possible": True})
        noise = [sampled[j][0] for j in np.flatnonzero(labels < 0)]
        data["noise"] = {"passages": len(noise), "evidence_ref": study.evidence(noise, role=mode + "_noise")}
        data["diagnostics"] = {**_diagnostics(info), "selection_cap": 6000, "model": study.model()}
        return data
    return study._artifact(("passage_clusters", mode, filters), build)


def passages(study, mid, ids, filters):
    if mid == "OD05":
        value = _clusters(study, ids, "need", filters)
    elif mid == "OD06":
        value = _clusters(study, ids, "pain", filters)
    else:
        need, pain = (_clusters(study, ids, mode, filters) for mode in ("need", "pain"))
        sig = _signals(study)
        active = [(i, hit) for i in ids for hit in sig[i]["demand_states"] if hit["state"] in ACTIVE]
        active_ids = {i for i, _ in active}
        need_or_pain = active_ids | {i for i, _ in _candidates(study, ids, "pain")}
        contexts = []
        for name, fields in (("usage", ("use",)), ("price", ("price_cues", "prices"))):
            examples = [(i, hit) for i in ids if i in need_or_pain for field in fields for hit in sig[i][field]]
            contexts.append({"context": name, **_coverage(study, (i for i, _ in examples), len(need_or_pain), examples, role=name)})
        alternatives = [(i, hit) for i in ids for hit in sig[i]["demand_states"]
                        if hit["state"] in {"workaround", "alternative_considered", "alternative_search"}]
        contexts.append({"context": "alternatives_and_workarounds",
                         **_coverage(study, (i for i, _ in alternatives), len(ids), alternatives, role="alternatives")})
        return ("exploratory" if need_or_pain else "insufficient_data", "" if need_or_pain else "No grounded need or pain",
                {"need": need, "pain": pain, "contexts": contexts, "active_need": _coverage(
                    study, active_ids, len(ids), active, role="active_need"), "context_join": "same focus document"})
    return ("exploratory" if value["clusters"] else "insufficient_data",
            "" if value["clusters"] else "Fewer than eight eligible passages or noise-only fit", value)


def _facts(study, ids, sig):
    return [(i, fact) for i in ids for fact in sig[i]["prices"]]


def price(study, mid, ids, filters):
    sig = _signals(study)
    if mid == "MI28":
        stages = defaultdict(list)
        for i in ids:
            for hit in sig[i]["purchase"]:
                stages[hit["stage"]].append((i, hit))
        return ("exploratory" if stages else "insufficient_data", "" if stages else "No grounded purchase stage",
                {"stages": [{"stage": stage, **_coverage(study, (i for i, _ in values), len(ids), values, stage=stage)}
                            for stage, values in sorted(stages.items())], "denominator": len(ids), "overlap_possible": True,
                 "evidence_ref": study.evidence(ids, role="purchase_population")})
    facts = _facts(study, ids, sig)
    if mid == "PR24":
        hits = [(i, hit) for i in ids for hit in sig[i]["price_cues"]] + facts
        value = _coverage(study, (i for i, _ in hits), len(ids), hits, role="price_attention")
        by_role = defaultdict(list)
        for i, fact in facts:
            by_role[fact["kind"]].append((i, fact))
        return "exploratory", "", {**value, "facts": len(facts), "roles": [
            {"role": role, "mentions": len(records), **_coverage(study, (i for i, _ in records), len(ids), records, price_role=role)}
            for role, records in sorted(by_role.items())], "denominator_evidence": study.evidence(ids, role="price_population")}
    cohorts = defaultdict(list)
    omitted = []
    for i, fact in facts:
        if fact["currency"].startswith("unknown") or fact["kind"] == "未分类":
            omitted.append((i, fact))
            continue
        if fact["upper"] is None:
            roles = [("point", fact["value"])]
        else:
            roles = [("low", fact["value"]), ("high", fact["upper"])]
        for role, amount in roles:
            key = (fact["currency"], fact["period"], fact["target_id"] or "unresolved_target", fact["kind"], role)
            cohorts[key].append((i, fact, amount))
    output = []
    for key, observations in sorted(cohorts.items()):
        members, records, values = zip(*observations, strict=True)
        currency, period, target, kind, role = key
        cohort = {"currency": currency, "period": period, "target": target, "kind": kind, "amount_role": role}
        bins = np.histogram_bin_edges(values, bins=min(20, max(1, int(np.sqrt(len(values))))))
        codes = np.clip(np.searchsorted(bins, values, side="right") - 1, 0, len(bins) - 2)
        bucket_rows = []
        for index in range(len(bins) - 1):
            chosen = [n for n in range(len(members)) if codes[n] == index]
            bucket_rows.append({"lower": float(bins[index]), "upper": float(bins[index + 1]),
                                "inclusive_upper": index == len(bins) - 2, "mentions": len(chosen),
                                "evidence_ref": study.evidence((members[n] for n in chosen), bucket=index, **cohort),
                                "examples": _examples(study, ((members[n], records[n]) for n in chosen), limit=2)})
        kde = []
        if len(values) >= 10 and len(set(values)) >= 3:
            from scipy.stats import gaussian_kde
            points = np.linspace(min(values), max(values), 32)
            kde = [{"value": float(point), "density": float(density)} for point, density in zip(
                points, gaussian_kde(values)(points), strict=True)]
        output.append({**cohort, **stats.desc(values), "observations": len(values), "documents": len(set(members)),
                       "buckets": bucket_rows, "kde": kde, "evidence_ref": study.evidence(members, **cohort),
                       "examples": _examples(study, zip(members, records, strict=True))})
    return ("exploratory" if output else "insufficient_data", "" if output else "No amounts with a known currency and price role",
            {"facts": len(facts), "fact_documents": len({i for i, _ in facts}),
             "cohort_keys": ["currency", "period", "target", "kind", "amount_role"], "cohorts": output,
             "omitted_mentions": len(omitted), "omitted_examples": _examples(study, omitted),
             "evidence_ref": study.evidence((i for i, _ in facts), role="money_facts"),
             "omitted_evidence": study.evidence((i for i, _ in omitted), role="ambiguous_currency_or_price_role")})


def entities(study, mid, ids, filters):
    verified_sources = {"v3_alias_migration", "public_catalog_corpus", "cpsc_corpus", "wikidata_corpus"}
    grounded = defaultdict(dict)
    for i in ids:
        text = study.rows[i]["focus"]
        for entity in study.v4_features.get(i, {}).get("entities", ()):
            if (entity.get("kind") != "brand" or entity.get("role") != "domain_brand"
                    or entity.get("source") not in verified_sources or not entity.get("entity_id")):
                continue
            start, end = entity.get("start"), entity.get("end")
            if isinstance(start, int) and isinstance(end, int) and 0 <= start < end <= len(text) and text[start:end] == entity.get("s"):
                grounded[entity["entity_id"]].setdefault(i, entity)
    if not grounded:
        return "unsupported_source", "Verified entity role and grounded spans required", {}
    result = []
    for key, members in sorted(grounded.items()):
        sample = next(iter(members.values()))
        value = {"entity_id": key, "label": sample.get("canonical") or sample.get("s"),
                 "identity_sources": sorted({item["source"] for item in members.values()}),
                 **_coverage(study, members, len(ids), members.items(), entity_id=key)}
        if mid == "MI07":
            value["days"] = [{"date": day, "documents": len(group), "evidence_ref": study.evidence(group, entity_id=key, day=day)}
                             for day, group in sorted(groups_for(study.rows, members, "day").items())]
        result.append(value)
    combined = _coverage(study, (i for records in grounded.values() for i in records), len(ids), (), role="verified_brand_mentions")
    return "exploratory", "", {"entities": result, "covered_documents": combined["documents"], "denominator": len(ids),
                               "rate": combined["rate"], "evidence_ref": combined["evidence_ref"]}

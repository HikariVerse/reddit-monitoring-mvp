"""Budgeted model inference with source coordinates and explicit routing."""

import numpy as np

from .semantics import sentences


def representative_rows(docs, budget, seed):
    if not len(docs):
        return []
    marked = docs[docs.demand_states.map(bool)]
    other = docs.loc[~docs.index.isin(marked.index)]
    first = marked.sample(min(len(marked), budget // 2), random_state=seed)
    second = other.sample(min(len(other), budget - len(first)), random_state=seed)
    if len(first) + len(second) < budget:
        first = marked.sample(min(len(marked), budget - len(second)), random_state=seed)
    return [*first.itertuples(), *second.itertuples()]


def attach(docs, parsed, profile, active, model, seed):
    usage = {}
    if "nli" in active:
        possible = representative_rows(docs, profile.nli, seed)
        passages = []
        for row in possible:
            segments = list(sentences(row.norm))
            if not segments:
                continue
            hits = [item["start"] for item in row.demand_states if item.get("method") in {"demand_rules_v4", "spacy_dependency_matcher"}]
            segment = next((segment for segment in segments if any(segment[0] <= pos < segment[1] for pos in hits)), segments[0])
            passages.append((row, *segment))
        classified = model.classify([passage[3] for passage in passages])
        emitted, rule_hits = 0, 0
        for (row, start, end, sentence), scores in zip(passages, classified, strict=True):
            prior = {item["state"] for item in row.demand_states if start <= item["start"] < end}
            rule_hits += bool(prior)
            parsed[row.doc_id]["nli"] = {"scores": scores, "start": start, "end": end, "rule_or_syntax_hit": bool(prior)}
            for label, score in scores.items():
                if score < .88 or label in prior:
                    continue
                if label in {"purchased", "unmet_need", "solution_satisfied", "solution_rejected"} and not prior:
                    # Preserve high-impact status as a candidate unless a separate extractor established need/solution context.
                    parsed[row.doc_id].setdefault("nli_candidates", []).append(label)
                    continue
                row.demand_states.append({"state": label, "sentence": sentence, "rule_id": label, "start": start, "end": end,
                                          "matched": sentence, "method": "multilingual_nli", "confidence": score,
                                          "coordinate_space": "focus", "constraints": []})
                emitted += 1
        usage["nli"] = {"attempted": len(passages), "with_rule_or_syntax": rule_hits,
                        "without_rule_or_syntax": len(passages) - rule_hits, "emitted": emitted}
    if "sentiment" in active:
        en = docs.loc[docs["lang"].eq("en") & docs.sent_label.ne("非观点")]
        docs_sample = list(en.sample(min(len(en), profile.sentiment), random_state=seed).itertuples())
        units = [(row, aspect) for row in docs_sample for aspect in row.aspects][:profile.sentiment]
        texts = [r.norm for r in docs_sample] + [a["context"] for _, a in units]
        results = model.sentiment(texts)
        changed = 0
        labels = {"positive": "正面", "negative": "负面", "neutral": "中性"}
        for (row, aspect), scores in zip([(row, None) for row in docs_sample] + units, results, strict=True):
            top = max(scores, key=scores.get)
            if scores[top] < .65:
                continue
            labelled = labels[top]
            value = round(scores["positive"] - scores["negative"], 4)
            if aspect is None:
                changed += labelled != row.sent_label
                revised = {**row.sent, "label": labelled, "score": value, "method": "cardiff_social_sentiment",
                           "comparison_baseline": row.sent_label, "scores": scores}
                docs.at[row.Index, "sent"] = revised
                docs.at[row.Index, "sent_label"] = labelled
                docs.at[row.Index, "sent_score"] = value
            else:
                changed += labelled != aspect["sentiment"]
                aspect.update(sentiment=labelled, score=value, sentiment_method="cardiff_social_sentiment", sentiment_scores=scores,
                              comparison_baseline=aspect["sentiment"])
        usage["sentiment"] = {"attempted": len(texts), "aspects": len(units), "changed": changed}
    if "context" in active and len(docs):
        sample = docs.sample(min(len(docs), profile.context), random_state=seed)
        vectors = model.embed(sample.norm.tolist())
        vectors /= np.maximum(1e-9, np.linalg.norm(vectors, axis=1, keepdims=True))
        for doc_id, vector in zip(sample.doc_id, vectors, strict=True):
            parsed[doc_id]["context_embedding"] = vector.tolist()
        usage["context"] = {"attempted": len(sample), "dimensions": int(vectors.shape[1])}
    return usage

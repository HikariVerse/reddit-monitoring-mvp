"""需求片段抽取与语义聚类（OD05/OD06，亦供选品评分复用）。

片段 = 文档中包含"需求/痛点"意图的句子；对片段做向量化 + 聚类，
得到可命名的需求簇，并计算支持度、未满足率、品牌覆盖、增长、跨社区覆盖。
"""

from __future__ import annotations

import re
from collections import Counter

import numpy as np
import pandas as pd

from . import common as CM, topics
from . import lexicon as L
from . import stats as ST

RE_NOISE = re.compile(r"^\W+$")


def collect_segments(scope, kinds=("need", "pain"), max_segments: int = 6000) -> list[dict]:
    df = scope.docs
    segs = []
    need_set, pain_set = CM.NEED_INTENTS, None
    for r in df.sample(frac=1, random_state=42).itertuples(index=False):
        sents = r.sentences or []
        hit = None
        if "need" in kinds:
            for state in r.demand_states:
                if state["state"] in {"explicit_need", "recommendation_request", "unmet_need", "partial_solution", "feature_request"}:
                    hit = {"intent": state["state"], "sentence": state["sentence"]}
                    break
            for h in r.intents:
                if hit is None and h["intent"] in need_set:
                    hit = h
                    break
        if hit is None and "pain" in kinds and r.pains:
            for s in sents:
                if any(rx.search(s) for _, rx in L.PAIN_RES):
                    hit = {"intent": "痛点", "sentence": s, "matched": r.pains[0]}
                    break
        if hit is None:
            continue
        sent = (hit.get("sentence") or "").strip()
        if len(sent) < 20 or RE_NOISE.match(sent):
            continue
        segs.append({
            "doc_id": r.doc_id, "thread_id": r.thread_id, "text": sent[:300],
            "intent": hit.get("intent", "痛点"), "community": r.community,
            "date": r.date, "month": r.month, "brands": r.brands, "attrs": r.attrs,
            "scenarios": r.scenarios, "sent": r.sent_label,
            "unmet": any(h["state"] == "unmet_need" for h in r.demand_states),
            "solution": bool(r.solution_refs),
        })
        if len(segs) >= max_segments:
            break
    # 片段级去重
    seen, uniq = set(), []
    for s in segs:
        k = s["text"].lower()[:120]
        if k in seen:
            continue
        seen.add(k)
        uniq.append(s)
    return uniq


def build_segments(scope, encoder, k: int = 8, method: str = "kmeans", min_size: int = 5, kinds=("need",)) -> dict:
    segs = collect_segments(scope, kinds)
    if len(segs) < min_size:
        return {"segments": [], "n_segments": len(segs), "method": method, "note": "需求片段不足，无法聚类"}

    texts = [s["text"] for s in segs]
    vecs = encoder.encode(texts, batch_size=128, max_tokens=96)
    vecs = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-9)
    labels, names, info = topics.cluster_passages(vecs, texts, k=k, enhanced=method == "hdbscan" or scope.meta.get("nlp_profile") != "fast")
    sil = CM.silhouette(vecs, labels) if method != "hdbscan" else None

    months = sorted(scope.docs["month"].dropna().unique())
    month_docs = scope.docs.groupby("month").size().to_dict()
    observed_dates = scope.docs["date"].dropna()
    days = pd.date_range(observed_dates.min(), observed_dates.max(), freq="D").date if len(observed_dates) else []
    total_days = len(days)
    seg_df = pd.DataFrame(segs)
    seg_df["label"] = labels

    out = []
    for c in sorted(set(labels)):
        if c == -1:
            continue
        sub = seg_df[seg_df["label"] == c]
        if len(sub) < min_size:
            continue
        idx = sub.index.values
        docs_sub = scope.docs[scope.docs["doc_id"].isin(sub["doc_id"])]
        texts = [x["text"] for x in sub.to_dict("records")]
        terms = CM.top_terms(texts, 12)
        phrases = CM.ngram_phrases(texts, 6, 2)
        name = " / ".join(row["term"] for row in names.get(c, [])[:3]) or _segment_name(texts, phrases, terms) or f"片段簇 {c}"
        brand_cov = float((sub["brands"].map(len) > 0).mean())
        attrs = Counter(a for lst in sub["attrs"] for a in lst)
        scen = Counter(s for lst in sub["scenarios"] for s in lst)
        by_month = sub.groupby("month").size().to_dict()
        growth = None
        if len(months) >= 2:
            cur = by_month.get(months[-1], 0) / month_docs[months[-1]]
            prev = by_month.get(months[-2], 0) / month_docs[months[-2]]
            growth = ST.growth_rate(cur, prev)
        day_counts = sub.groupby("date").size().reindex(days, fill_value=0)
        history = seg_df.loc[seg_df["month"].ne(months[-1])] if len(months) > 1 else seg_df.iloc[:0]
        latest = sub.loc[sub["month"].eq(months[-1])] if months else sub.iloc[:0]
        novelty = None
        if len(history) >= 10 and len(latest) >= min_size:
            older_groups = [vecs[g.index].mean(axis=0) for _, g in history.groupby("label") if len(g) >= min_size]
            recent = vecs[latest.index].mean(axis=0)
            if older_groups:
                older = np.asarray(older_groups)
                similarity = older @ recent / np.maximum(np.linalg.norm(older, axis=1) * np.linalg.norm(recent), 1e-9)
                novelty = round(float(1 - np.clip(similarity.max(), 0, 1)), 4)
        persistence = round(sub["date"].dropna().nunique() / total_days, 4) if total_days else None
        # 代表证据：与簇质心最近的片段（保证不同线程）
        centroid = vecs[idx].mean(axis=0)
        centroid /= np.linalg.norm(centroid) + 1e-9
        sims = vecs[idx] @ centroid
        order = np.argsort(-sims)
        seen_threads, examples = set(), []
        for j in order:
            rec = sub.iloc[j]
            if rec["thread_id"] in seen_threads:
                continue
            seen_threads.add(rec["thread_id"])
            examples.append({
                "doc_id": rec["doc_id"], "text": rec["text"], "community": rec["community"],
                "date": str(rec["date"]), "score": float(sims[j]), "intent": rec["intent"],
            })
            if len(examples) >= 5:
                break
        out.append({
            "id": int(c), "name": name, "size": int(len(sub)),
            "doc_support": int(docs_sub["doc_id"].nunique()),
            "thread_support": int(sub["thread_id"].nunique()),
            "author_support": int(docs_sub["author"].nunique()) if "author" in docs_sub else 0,
            "growth": growth, "persistence": persistence,
            "slope": ST.theil_sen_slope(day_counts.values),
            "first_observed": str(sub["date"].min()),
            "novelty": novelty,
            "centroid": centroid.tolist(),
            "unmet_rate": round(float(sub["unmet"].mean()), 4),
            "unmet_count": int(sub["unmet"].sum()),
            "brand_coverage": round(brand_cov, 4),
            "solution_gap": round(1 - float(sub["solution"].mean()), 4),
            "communities": int(sub["community"].nunique()),
            "by_month": {m: int(v) for m, v in by_month.items()},
            "terms": terms, "phrases": phrases,
            "attributes": [{"attribute": a, "n": n} for a, n in attrs.most_common(6)],
            "scenarios": [{"scenario": s, "n": n} for s, n in scen.most_common(5)],
            "examples": examples,
            "member_ids": sorted(set(sub.doc_id)),
            "evidence_ref": [row["doc_id"] for row in examples],
            "topic_terms": names.get(c, []), "segment_kind": kinds[0],
            "avg_sent_score": round(float(docs_sub["sent_score"].mean()), 3) if len(docs_sub) else 0.0,
        })
    out.sort(key=lambda x: -x["size"])
    seen_names: dict[str, int] = {}
    for s_ in out:
        n0 = s_["name"]
        seen_names[n0] = seen_names.get(n0, 0) + 1
        if seen_names[n0] > 1:
            s_["name"] = f"{n0} ·{seen_names[n0]}"
    return {
        "segments": out,
        "n_segments": len(segs),
        "method": info,
        "silhouette": sil,
        "clustered": int((labels >= 0).sum()),
    }


def _segment_name(texts: list[str], phrases: list[dict], terms: list[dict]) -> str:
    """簇命名：优先可读的二元短语，其次领域词，再次高频词。"""
    def ok(w: str) -> bool:
        return (len(w) > 2 and w not in L.FUNCTION_WORDS and w not in L.CHAT_WORDS
                and "'" not in w and not w.endswith("ing") is False)
    good_ph = [p for p in phrases
               if p["n"] >= max(3, int(len(texts) * 0.12))
               and all(len(w) > 2 and w not in L.FUNCTION_WORDS and w not in L.CHAT_WORDS for w in p["phrase"].split())]
    if good_ph:
        return good_ph[0]["phrase"]
    domain = [t["term"] for t in terms if t["term"] in L.ATTR_TERMS or t["term"] in L.SCENARIO_TERMS
              or t["term"] in L.CATEGORY_TERMS or t["term"] in L.ALL_BRANDS]
    if len(domain) >= 2:
        return " / ".join(domain[:2])
    clean = [t["term"] for t in terms if len(t["term"]) > 2 and t["term"] not in L.FUNCTION_WORDS
             and t["term"] not in L.CHAT_WORDS and "'" not in t["term"]]
    return " / ".join(clean[:2])


def segment_score(seg: dict, max_size: int, max_growth: float, weight: dict | None = None,
                  method: str = "percentile", all_segments: list | None = None, factor: str = "need") -> float:
    """需求/机会综合评分（0–100）。

    先用候选集合做归一化，再按权重加权；支持 percentile / minmax / geomean / topsis。
    """
    w = dict(weight or SCORE_PROFILES[factor])
    if any(key not in SCORE_FACTORS or not np.isfinite(value) or value < 0 for key, value in w.items()):
        raise ValueError("评分配置包含未知因子或无效权重")
    if "unmet" in w and "gap" in w:
        raise ValueError("明确未满足与方案不可观测是不同信号，当前评分配置只允许取其一")
    if not all_segments or len(all_segments) < 2:
        return 50.0

    vals = {factor: np.asarray([s.get(field) for s in all_segments], dtype=float)
            for factor, field in SCORE_FACTORS.items()}
    pos = next((i for i, s in enumerate(all_segments) if s["id"] == seg["id"]), 0)
    keys = [k for k in w if w[k] > 0 and np.isfinite(vals[k]).all()]
    if not keys:
        return 50.0
    wv = np.array([w[k] for k in keys], dtype=float)
    wv = wv / wv.sum()

    if method == "minmax":
        score = float(np.dot(wv, [ST.minmax(vals[k])[pos] for k in keys]) * 100)
    elif method == "geomean":
        norm = {k: np.clip(ST.percentile_rank(vals[k]), 1e-4, 1) for k in keys}
        score = float(np.exp(np.dot(wv, [np.log(norm[k][pos]) for k in keys])) * 100)
    elif method == "topsis":
        mat = np.vstack([ST.percentile_rank(vals[k]) for k in keys]).T
        wm = mat * wv
        ideal, anti = wm.max(axis=0), wm.min(axis=0)
        d_pos = np.sqrt(((wm - ideal) ** 2).sum(axis=1))
        d_neg = np.sqrt(((wm - anti) ** 2).sum(axis=1))
        total = d_neg[pos] + d_pos[pos]
        score = float(d_neg[pos] / total * 100) if total else 50.0
    else:
        norm = {k: ST.percentile_rank(vals[k]) for k in keys}
        score = float(np.dot(wv, [norm[k][pos] for k in keys]) * 100)
    return round(min(100.0, max(0.0, score)), 1)


SCORE_FACTORS = {
    "support": "thread_support", "growth": "growth", "unmet": "unmet_rate",
    "gap": "solution_gap", "persistence": "persistence", "breadth": "communities",
    "novelty": "novelty",
}
SCORE_PROFILES = {
    "need": {"support": .20, "unmet": .35, "novelty": .20, "growth": .15, "breadth": .10},
    "product": {"support": .25, "growth": .25, "persistence": .20, "breadth": .15, "unmet": .15},
}

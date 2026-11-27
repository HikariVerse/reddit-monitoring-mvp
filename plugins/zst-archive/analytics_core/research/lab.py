"""算法实验室（12.1–12.8）：在同一研究语料上对比算法、参数与稳定性。

每个实验返回：method 说明、表格数据、可视图数据、耗时、限制。
"""

from __future__ import annotations

import time
from collections import Counter

import numpy as np
import pandas as pd
from cpu_runtime import managed_job

from . import common as CM
from . import entities as E
from . import intents as I
from . import lexicon as L
from . import segments as SG
from . import sentiment as S
from . import stats as ST


def _t0():
    return time.perf_counter()


def exp_entity(scope, encoder, params: dict) -> dict:
    t = _t0()
    threshold = float(params.get("sim_threshold", 0.8))
    min_df = int(params.get("min_df", 4))
    disc = scope.discovery or {}
    terms = [x["term"] for x in (disc.get("brands", []) + disc.get("attributes", []) + disc.get("categories", []))
             if x["df"] >= min_df][:200]
    # 语义扩展 + 同义归并
    groups = []
    if terms and encoder is not None:
        groups = E.merge_synonyms(terms, encoder.encode, threshold=threshold, max_terms=160)
    coverage = {
        "dict_size": scope.dict.size(),
        "docs_with_entity": round(float((scope.docs["entities"].map(len) > 0).mean()), 4),
        "avg_entities": round(float(scope.docs["entities"].map(len).mean()), 2),
    }
    rows = []
    for kind in ("brands", "attributes", "scenarios", "categories", "phrases"):
        for x in [row for row in disc.get(kind, []) if row["df"] >= min_df][:12]:
            rows.append({"type": kind, "term": x["term"], "df": x["df"], "score": x.get("score", 0),
                         "role": x.get("role"),
                         "opinion_ratio": x.get("opinion_ratio"), "cap_ratio": x.get("cap_ratio"),
                         "noun_ratio": x.get("noun_ratio"), "seed_cooccur": x.get("seed_cooccur")})
    rows.sort(key=lambda r: -r["score"])
    return {
        "experiment": "entity", "title": "实体识别与自动词典",
        "params": {"sim_threshold": threshold, "min_df": min_df, "dict_size": scope.dict.size()},
        "coverage": coverage, "rows": rows[:40], "synonyms": groups[:8],
        "notes": [
            "候选打分 = 0.40·log(support) + 0.30·情感邻近度 + 0.20·句中大写 + 0.10·名词上下文 + 种子共现加权",
            "同义归并基于 Potion 向量余弦，阈值可调；阈值为 0.82 时会把 LLM 与 LLAMA 合并，0.86 更稳",
        ],
        "runtime_ms": round((time.perf_counter() - t) * 1000, 1),
    }


def exp_intent(scope, encoder, params: dict) -> dict:
    t = _t0()
    df = scope.docs
    hits = df["intents"].tolist()
    cov = I.coverage(hits)
    co = I.cooccurrence(hits)
    unclassified = df[df["intent_names"].map(lambda x: x == ["一般讨论"])]["norm"].head(8).tolist()
    # 语义原型对照：为两个高频意图构造种子句，计算与规则标注的一致率
    proto_rows = []
    if encoder is not None:
        seeds = {
            "求推荐": ["can anyone recommend a good pair of headphones",
                       "i'm looking for suggestions under 100 dollars", "what should i buy for running"],
            "抱怨投诉": ["this thing is terrible and i regret buying it",
                         "the battery died after two weeks, so disappointed", "worst purchase ever, total garbage"],
            "产品比较": ["how does the sony xm5 compare to the bose qc ultra",
                         "is it better than the previous model", "which one is better for flights"],
        }
        emb = encoder.encode([s for v in seeds.values() for s in v], batch_size=32)
        labels = [k for k, v in seeds.items() for _ in v]
        protos = {}
        for k in seeds:
            protos[k] = emb[[i for i, l in enumerate(labels) if l == k]].mean(axis=0)
        P = np.stack([protos[k] / (np.linalg.norm(protos[k]) + 1e-9) for k in seeds])
        keys = list(seeds)
        sample_idx = np.random.RandomState(42).choice(len(df), min(1500, len(df)), replace=False)
        dv = scope.unit_emb[sample_idx]
        pred = (dv @ P.T).argmax(axis=1)
        for i, k in enumerate(keys):
            rule_n = int(df.iloc[sample_idx]["intent_names"].map(lambda x: k in x).sum())
            sem_n = int((pred == i).sum())
            if rule_n and sem_n:
                overlap = int(((pred == i) & df.iloc[sample_idx]["intent_names"].map(lambda x: k in x).values).sum())
                proto_rows.append({"intent": k, "rule_docs": rule_n, "semantic_docs": sem_n,
                                   "overlap": overlap, "agreement": round(overlap / max(1, min(rule_n, sem_n)), 3)})
    return {
        "experiment": "intent", "title": "多标签意图识别",
        "params": {"rules": len(L.INTENT_KEYS), "max_sentences": 8},
        "distribution": cov["distribution"][:20], "groups": cov["group_distribution"],
        "coverage": cov["coverage"], "cooccurrence": co, "unclassified": unclassified,
        "prototype_compare": proto_rows,
        "notes": ["规则为单 mega-regex 扫描，命中句/位置/规则均可回溯",
                  "语义原型仅作对照，其命中率不等同于分类准确率"],
        "runtime_ms": round((time.perf_counter() - t) * 1000, 1),
    }


def exp_sentiment(scope, encoder, params: dict) -> dict:
    t = _t0()
    df = scope.docs
    window = int(params.get("window", 8))
    idx = np.random.RandomState(42).choice(len(df), min(1200, len(df)), replace=False)
    sample = df.iloc[idx]
    doc_labels = sample["sent_label"].tolist()
    window_labels = []
    sent_labels = []
    for r in sample.itertuples(index=False):
        ents = [E.Hit(e["s"], e["t"], e.get("start", 0), e.get("end", 0)) for e in (r.entities or [])][:3]
        if ents:
            lab = S.entity_window_sentiment(r.norm, ents[0].start, ents[0].end, window)["label"]
        else:
            lab = "未知"
        window_labels.append(lab)
        first = (r.sentences or [r.norm])[0]
        sc = S.doc_sentiment(first)
        sent_labels.append(sc["label"])
    proto_labels = []
    if encoder is not None:
        ps = S.PrototypeSentiment(encoder.encode)
        pred = ps.predict(scope.unit_emb[idx])
        proto_labels = [S.LABELS_3[p] for p in pred]

    def dist(labels):
        c = Counter(labels)
        n = max(1, len(labels))
        return [{"label": k, "n": v, "pct": round(v / n * 100, 2)} for k, v in c.most_common()]

    methods = {
        "文档词典法": doc_labels,
        "实体窗口法": window_labels,
        "句级首句法": sent_labels,
    }
    if proto_labels:
        methods["语义原型法"] = proto_labels
    agree = []
    keys = list(methods)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            a, b = methods[keys[i]], methods[keys[j]]
            both = [(x, y) for x, y in zip(a, b) if x != "未知" and y != "未知"]
            rate = round(sum(1 for x, y in both if x == y) / max(1, len(both)), 4)
            agree.append({"a": keys[i], "b": keys[j], "agreement": rate, "n": len(both)})
    # 分歧样本
    dis = []
    if proto_labels:
        for r, a, b in zip(sample.itertuples(index=False), doc_labels, proto_labels):
            if a != b and a != "未知":
                dis.append({"text": r.norm[:200], "doc_label": a, "proto_label": b})
                if len(dis) >= 6:
                    break
    return {
        "experiment": "sentiment", "title": "情感算法对比",
        "params": {"window": window, "sample": len(sample)},
        "distributions": [{"method": k, "dist": dist(v)} for k, v in methods.items()],
        "agreement": agree, "disagreements": dis,
        "notes": ["实体窗口法 = 实体 ±window token 内词典求和，含否定与程度副词",
                  "语义原型法先做原型偏差校正再 argmax；三者一致率仅反映内部一致性，不是准确率"],
        "runtime_ms": round((time.perf_counter() - t) * 1000, 1),
    }


def exp_embedding(scope, encoder, params: dict) -> dict:
    t = _t0()
    q = params.get("query") or (scope.meta["spec"]["seeds"][0] if scope.meta["spec"]["seeds"] else "product")
    k = int(params.get("k", 10))
    from .retrieval import rank
    t_rank = time.perf_counter()
    orders, sem, kw, hy = rank(scope, encoder, q, k)
    rank_ms = round((time.perf_counter() - t_rank) * 1000, 1)
    order = orders.get("cross_encoder", orders["passage_rerank"])
    results = []
    for i in order:
        row = scope.docs.iloc[i]
        results.append({"doc_id": row["doc_id"], "text": row["norm"][:220], "semantic": round(float(sem[i]), 4),
                        "keyword": round(float(kw[i]), 4), "hybrid": round(float(hy[i]), 4),
                        "community": row["community"], "date": str(row["date"])})
    hist = np.histogram(sem, bins=20, range=(-0.2, 0.8))[0].tolist()
    return {
        "experiment": "embedding", "title": "Embedding 与检索",
        "params": {"query": q, "k": k, "dim": int(scope.emb.shape[1])},
        "results": results, "similarity_hist": hist,
        "routes": {key: scope.docs.iloc[positions]["doc_id"].tolist() for key, positions in orders.items()},
        "rank_ms": rank_ms,
        "stats": {"max": round(float(sem.max()), 4) if len(sem) else None, "mean": round(float(sem.mean()), 4) if len(sem) else None,
                  "p95": round(float(np.quantile(sem, 0.95)), 4) if len(sem) else None},
        "notes": ["比较 BM25、Potion、倒数排名融合与片段短语重排",
                  "深度配置额外启用本地 CrossEncoder 和预算样本的上下文向量"],
        "runtime_ms": round((time.perf_counter() - t) * 1000, 1),
    }


def exp_clustering(scope, encoder, params: dict) -> dict:
    t = _t0()
    k = int(params.get("k", 8))
    n_sample = int(params.get("sample", 2000))
    idx = np.random.RandomState(42).choice(len(scope.docs), min(n_sample, len(scope.docs)), replace=False)
    vecs = scope.unit_emb[idx]
    texts = scope.docs.iloc[idx]["norm"].tolist()
    from sklearn.decomposition import LatentDirichletAllocation, NMF
    from sklearn.feature_extraction.text import CountVectorizer, TfidfVectorizer
    from sklearn.metrics import adjusted_rand_score

    rows = []
    members = {}
    base = None
    for method in ("kmeans", "minibatch", "hdbscan"):
        t1 = _t0()
        labels, info = CM.cluster_texts(vecs, k=k, method=method)
        sil = CM.silhouette(vecs, labels)
        sizes = Counter(labels.tolist())
        rows.append({"method": method, "clusters": len([x for x in sizes if x >= 0]),
                     "outliers": int(sizes.get(-1, 0)), "silhouette": sil,
                     "largest": max(sizes.values()) if sizes else 0,
                     "runtime_ms": round((time.perf_counter() - t1) * 1000, 1)})
        members[method] = labels
        if method == "kmeans":
            base = labels

    # TF-IDF + NMF / LDA
    tfv = TfidfVectorizer(token_pattern=r"[^\s]+", lowercase=False, min_df=3, max_features=8000, sublinear_tf=True)
    X = tfv.fit_transform(texts)
    t2 = _t0()
    nmf = NMF(n_components=min(k, 8), init="nndsvda", random_state=42, max_iter=200).fit(X)
    lab_nmf = nmf.transform(X).argmax(axis=1)
    rows.append({"method": "nmf", "clusters": len(set(lab_nmf)), "outliers": 0,
                 "silhouette": CM.silhouette(vecs, lab_nmf), "largest": int(Counter(lab_nmf).most_common(1)[0][1]),
                 "runtime_ms": round((time.perf_counter() - t2) * 1000, 1)})
    members["nmf"] = lab_nmf
    t3 = _t0()
    ctv = CountVectorizer(token_pattern=r"[^\s]+", lowercase=False, min_df=3, max_features=5000)
    C = ctv.fit_transform(texts)
    lda = LatentDirichletAllocation(n_components=min(k, 8), random_state=42, max_iter=12, learning_method="batch")
    lab_lda = lda.fit_transform(C).argmax(axis=1)
    rows.append({"method": "lda", "clusters": len(set(lab_lda)), "outliers": 0,
                 "silhouette": CM.silhouette(vecs, lab_lda), "largest": int(Counter(lab_lda).most_common(1)[0][1]),
                 "runtime_ms": round((time.perf_counter() - t3) * 1000, 1)})
    members["lda"] = lab_lda

    ari = []
    if base is not None:
        for m, lab in members.items():
            if m != "kmeans":
                ari.append({"a": "kmeans", "b": m, "ari": round(float(adjusted_rand_score(base, lab)), 4)})

    # 代表词
    terms = np.array(tfv.get_feature_names_out())
    rep = []
    for m in ("kmeans", "nmf", "lda"):
        lab = members[m]
        tops = []
        for c in sorted(set(lab))[:5]:
            sel = np.where(lab == c)[0]
            sub = X[sel] if m == "nmf" else (C[sel] if m == "lda" else X[sel])
            score = np.asarray(sub.mean(axis=0)).ravel()
            tops.append({"cluster": int(c), "size": int(len(sel)),
                         "terms": [terms[i] for i in np.argsort(-score)[:6]]})
        rep.append({"method": m, "clusters": tops})

    return {
        "experiment": "clustering", "title": "聚类与主题建模对比",
        "params": {"k": k, "sample": len(idx)},
        "rows": rows, "ari": ari, "representatives": rep,
        "notes": ["轮廓系数在 256 维静态嵌入 + 异构短文本上普遍偏低（0.05–0.10），不代表算法失败",
                  "ARI 用于衡量不同算法成员关系的一致性；NMF/LDA 基于词袋，KMeans 基于语义向量"],
        "runtime_ms": round((time.perf_counter() - t) * 1000, 1),
    }


def exp_timeseries(scope, encoder, params: dict) -> dict:
    t = _t0()
    series_name = params.get("series", "total")
    df = scope.docs
    if series_name.startswith("brand:"):
        brand = series_name.split(":", 1)[1]
        sub = df[df["brands"].map(lambda x: brand in x)]
    else:
        sub = df
    daily = CM.daily_counts(sub)
    dates = [str(d) for d in daily.index]
    y = daily.values.astype(float)
    window = int(params.get("window", 30))
    alpha = float(params.get("alpha", 0.3))
    threshold = float(params.get("threshold", 3.0))
    ma = ST.moving_average(y, 7)
    ew = ST.ewma(y, alpha)
    z = ST.rolling_zscore(y, window=window, min_period=min(7, window))
    mad = ST.mad_anomaly(y, window=window)
    cs = ST.cusum(y)
    rows = []
    for name, vals in (("moving_average(7)", ma), ("ewma", ew), ("zscore", z), ("mad", mad)):
        rows.append({"method": name, "last": round(float(vals[-1]), 3) if len(vals) else 0,
                     "max": round(float(np.max(vals)), 3) if len(vals) else 0,
                     "alarms": int((np.abs(vals) >= threshold).sum()) if name in ("zscore", "mad") else None})
    rows.append({"method": "theil_sen", "last": ST.theil_sen_slope(y), "max": None,
                 "alarms": None})
    # 参数敏感性
    sens = []
    for w in (7, 14, 30):
        zz = ST.rolling_zscore(y, window=w, min_period=min(5, w))
        sens.append({"window": w, "alarms": int((zz >= threshold).sum()), "max_z": round(float(zz.max()), 2)})
    return {
        "experiment": "timeseries", "title": "时间序列与异常检测",
        "params": {"series": series_name, "window": window, "alpha": alpha, "threshold": threshold},
        "series": [{"date": d, "value": int(v), "ma7": round(float(m), 1), "ewma": round(float(e), 1),
                    "z": round(float(zz), 2), "mad": round(float(mm), 2)}
                   for d, v, m, e, zz, mm in zip(dates, y, ma, ew, z, mad)],
        "rows": rows, "sensitivity": sens, "cusum_alarms": cs["alarms"][:20],
        "notes": ["滚动基线只使用目标时点之前的数据，避免未来信息泄漏",
                  "窗口越短越敏感但误报越多；三个月数据下建议 7–14 日窗口"],
        "runtime_ms": round((time.perf_counter() - t) * 1000, 1),
    }


def exp_cooccurrence(scope, encoder, params: dict) -> dict:
    t = _t0()
    level = params.get("level", "doc")
    min_support = int(params.get("min_support", 5))
    df = scope.docs
    brands = [b for b, _ in CM.brand_counts(df).most_common(10)]
    attrs = [a for a, _ in CM.attr_counts(df).most_common(10)]
    n = len(df)
    rows = []
    bdocs = {b: df["brands"].map(lambda x: b in x).values for b in brands}
    adocs = {a: df["attrs"].map(lambda x: a in x).values for a in attrs}
    for b in brands:
        for a in attrs:
            c_ab = int((bdocs[b] & adocs[a]).sum())
            c_a = int(bdocs[b].sum())
            c_b = int(adocs[a].sum())
            if c_ab < min_support:
                continue
            row = {"a": CM.brand_label(b), "b": a, "n": c_ab,
                   "pmi": ST.pmi(c_ab, c_a, c_b, n), "npmi": ST.npmi(c_ab, c_a, c_b, n),
                   "lift": ST.lift(c_ab, c_a, c_b, n), "jaccard": ST.jaccard(
                       [i for i, v in enumerate(bdocs[b]) if v], [i for i, v in enumerate(adocs[a]) if v])}
            rows.append(row)
    rows.sort(key=lambda r: -r["npmi"])
    return {
        "experiment": "cooccurrence", "title": "共现与关系强度",
        "params": {"level": level, "min_support": min_support, "pairs": len(rows)},
        "rows": rows[:30],
        "notes": ["同时给出原始计数、PMI、NPMI、lift、Jaccard，便于观察不同度量对排序的影响",
                  "NPMI 对低频对更稳健；lift 对高频对更敏感"],
        "runtime_ms": round((time.perf_counter() - t) * 1000, 1),
    }


def exp_scoring(scope, encoder, params: dict) -> dict:
    t = _t0()
    seg_data = SG.build_segments(scope, encoder, k=int(params.get("k", 8)))
    segs = seg_data.get("segments", [])
    if len(segs) < 3:
        return {"experiment": "scoring", "title": "综合评分", "rows": [], "notes": ["需求簇不足，无法比较评分算法"],
                "runtime_ms": round((time.perf_counter() - t) * 1000, 1)}
    profile = params.get("profile", "need")
    weights = params.get("weights") or SG.SCORE_PROFILES[profile]
    factors = {key: np.array([s[field] for s in segs], float) for key, field in SG.SCORE_FACTORS.items()}
    methods = {}
    for m in ("percentile", "minmax", "geomean", "topsis"):
        methods[m] = np.array([SG.segment_score(s, 0, 0, weight=weights, method=m, all_segments=segs)
                               for s in segs])
    ranking = []
    for i, s in enumerate(segs):
        ranking.append({"name": s["name"], "size": s["size"],
                        **{m: round(float(v[i]), 1) for m, v in methods.items()}})
    # 排名相关
    corr = []
    keys = list(methods)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            corr.append({"a": keys[i], "b": keys[j], "spearman": ST.spearman(methods[keys[i]], methods[keys[j]])})
    # 权重扰动
    rng = np.random.RandomState(42)
    base = methods["percentile"]
    stable = []
    for trial in range(30):
        wd = {k: v * rng.uniform(0.7, 1.3) for k, v in weights.items()}
        sc = [SG.segment_score(s, 0, 0, weight=wd, all_segments=segs) for s in segs]
        rho = ST.spearman(base, sc)
        if rho is not None and np.isfinite(rho):
            stable.append(rho)
    pareto = ST.pareto_front(np.stack([factors["support"], factors["unmet"]], axis=1))
    return {
        "experiment": "scoring", "title": "综合评分算法对比",
        "params": {"weights": weights, "candidates": len(segs)},
        "ranking": sorted(ranking, key=lambda x: -x["percentile"]),
        "correlation": corr,
        "stability": {"runs": len(stable), "mean_spearman": round(float(np.mean(stable)), 4) if stable else None,
                      "min": round(float(np.min(stable)), 4) if stable else None},
        "pareto": [segs[i]["name"] for i in pareto],
        "notes": ["百分位法对异常值稳健；TOPSIS 更强调与理想解的接近度；加权几何平均惩罚短板",
                  "权重扰动实验衡量排名稳定性，Spearman 均值 > 0.8 说明结论稳健"],
        "runtime_ms": round((time.perf_counter() - t) * 1000, 1),
    }


def exp_demand(scope, encoder, params):
    t = _t0()
    count = Counter(hit["state"] for states in scope.docs["demand_states"] for hit in states)
    need = scope.docs[CM.need_mask(scope.docs)]
    rows = [{"state": name, "count": n} for name, n in count.most_common()]
    refs = list(need.loc[need["solution_refs"].map(bool), "doc_id"].head(15))
    return {"title": "需求状态与方案证据", "rows": rows, "evidence": scope.evidence(refs, 10),
            "params": {"demand_docs": len(need)}, "runtime_ms": round((time.perf_counter() - t) * 1000, 1)}


def exp_population(scope, encoder, params):
    t = _t0()
    from .populations import archive_attention
    thread = scope.docs.assign(need=CM.need_mask(scope.docs)).groupby("thread_id")["need"].agg(["sum", "count"])
    rng = np.random.default_rng(int(params.get("seed", 42)))
    rates = []
    for _ in range(min(500, max(10, int(params.get("draws", 100))))):
        if not len(thread):
            break
        selected = thread.iloc[rng.integers(len(thread), size=len(thread))]
        rates.append(float(selected["sum"].sum() / selected["count"].sum()))
    rows = [{"population": key, "size": value["size"], "unit": value["unit"]}
            for key, value in scope.meta["populations"].items() if "size" in value]
    return {"title": "总体对账与线程 Bootstrap", "rows": rows, "archive_rate": archive_attention(scope, "SL02", 1),
            "need_rate_bootstrap_95": np.quantile(rates, [.025, .975]).tolist() if rates else None,
            "notes": ["区间衡量核心研究样本内部的线程重采样稳定性"], "runtime_ms": round((time.perf_counter() - t) * 1000, 1)}


EXPERIMENTS = {
    "entity": exp_entity,
    "intent": exp_intent,
    "sentiment": exp_sentiment,
    "embedding": exp_embedding,
    "clustering": exp_clustering,
    "timeseries": exp_timeseries,
    "cooccurrence": exp_cooccurrence,
    "scoring": exp_scoring,
    "demand": exp_demand,
    "population": exp_population,
}


@managed_job("v4_lab")
def run(name: str, scope, encoder, params: dict) -> dict:
    fn = EXPERIMENTS.get(name)
    if not fn:
        raise ValueError(f"未知实验：{name}")
    if not scope.n and name not in {"demand", "population"}:
        out = {"title": name, "rows": [], "notes": ["没有核心样本"], "runtime_ms": 0, "status": "insufficient_data"}
    else:
        out = fn(scope, encoder, params or {})
    out["ran_at"] = time.strftime("%Y-%m-%d %H:%M:%S")
    out["scope_id"] = scope.meta["scope_id"]
    return out

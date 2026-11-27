"""业务模块三：社媒调研（SR01–SR30）。"""

from __future__ import annotations

import math
from collections import Counter, defaultdict

import numpy as np
import pandas as pd

from . import common as CM
from . import lexicon as L
from . import stats as ST


def _comm_tokens(df: pd.DataFrame) -> dict[str, Counter]:
    """按**文档频**统计（Monroe log-odds 要求的是文档级频次，而非词次）。"""
    out = {}
    for c, g in df.groupby("community"):
        cnt: Counter = Counter()
        for toks in g["tokens"].values:
            cnt.update({t for t in toks if t not in L.FUNCTION_WORDS})
        out[c] = cnt
    return out


def _logodds_rows(comm: str, counts: dict[str, Counter], n_docs: dict[str, int], top_k: int = 12) -> list[dict]:
    c1 = counts.get(comm, Counter())
    n1 = n_docs.get(comm, 0)
    rest = Counter()
    for k, v in counts.items():
        if k != comm:
            rest.update(v)
    n2 = sum(v for k, v in n_docs.items() if k != comm)
    if n1 < 5 or n2 < 5:
        return []
    rows = []
    for term, cnt in c1.most_common(300):
        if len(term) < 3:
            continue
        lo = ST.log_odds_ratio(cnt, n1, rest.get(term, 0), n2, prior=0.5)
        if lo > 0:
            rows.append({"term": term, "n": cnt, "log_odds": lo})
    rows.sort(key=lambda x: -x["log_odds"])
    return rows[:top_k]


def _label_propagation(sim: np.ndarray, threshold: float = 0.75, iters: int = 30) -> list[int]:
    n = len(sim)
    labels = list(range(n))
    adj = [[j for j in range(n) if j != i and sim[i, j] >= threshold] for i in range(n)]
    for _ in range(iters):
        changed = False
        for i in range(n):
            if not adj[i]:
                continue
            votes = Counter(labels[j] for j in adj[i])
            best = votes.most_common(1)[0][0]
            if best != labels[i]:
                labels[i] = best
                changed = True
        if not changed:
            break
    uniq = {l: i for i, l in enumerate(sorted(set(labels)))}
    return [uniq[l] for l in labels]


def compute(scope, encoder=None) -> dict:
    df = scope.docs
    n = len(df)
    metrics: dict[str, dict] = {}
    charts: dict[str, object] = {}

    # ---------- SR01-03 社区规模与活跃 ----------
    rows = []
    for c, g in df.groupby("community"):
        s = CM.sent_distribution(g)
        rows.append({
            "community": c, "docs": int(len(g)), "authors": int(g["author"].nunique()),
            "threads": int(g["thread_id"].nunique()),
            "posts": int((g["kind"] == "post").sum()), "comments": int((g["kind"] == "comment").sum()),
            "avg_score": round(float(g["score"].mean()), 2), "median_score": int(g["score"].median()),
            "avg_chars": round(float(g["chars"].mean()), 1),
            "neg_rate": s["neg_rate"], "per_day": round(len(g) / max(1, g["date"].nunique()), 2),
            "months": {m: int(v) for m, v in g.groupby("month").size().items()},
        })
    rows.sort(key=lambda x: -x["docs"])
    metrics["SR01"] = CM.M("SR01", len(rows), num=n, den=len(rows), n=n,
                           method="按 community 聚合：内容数/作者数/线程数",
                           note=f"Top 社区 r/{rows[0]['community']}（{rows[0]['docs']} 条）" if rows else "")
    metrics["SR02"] = CM.M("SR02", rows[0]["per_day"] if rows else None,
                           num=rows[0]["docs"] if rows else None, den=None, n=n, method="最活跃社区日均讨论量")
    trend_rows = []
    for r in rows[:6]:
        sub = df[df["community"] == r["community"]]
        trend_rows.append({"community": r["community"], "series": {m: int(v) for m, v in sub.groupby("month").size().items()}})
    metrics["SR03"] = CM.M("SR03", len(trend_rows), num=None, den=None, n=n, method="Top 社区月度活跃变化")
    charts["communities"] = rows[:20]
    charts["community_trend"] = trend_rows

    # ---------- SR04-07 特征词 / 短语 / 话术 ----------
    counts = _comm_tokens(df)
    n_docs = {c: int(v) for c, v in df.groupby("community").size().items()}
    top_comms = [r["community"] for r in rows[:8]]
    lod = {c: _logodds_rows(c, counts, n_docs) for c in top_comms}
    charts["logodds"] = [{"community": c, "terms": lod[c]} for c in top_comms]
    metrics["SR04"] = CM.M("SR04", len(top_comms), num=sum(len(v) for v in lod.values()), den=None, n=n,
                           method="Log-odds ratio + informative Dirichlet prior（vs 其他社区）")
    diff_terms = []
    if len(top_comms) >= 2:
        a, b = top_comms[0], top_comms[1]
        for term in list(counts[a].keys())[:800]:
            lo = ST.log_odds_ratio(counts[a].get(term, 0), n_docs[a], counts[b].get(term, 0), n_docs[b])
            if lo > 1:
                diff_terms.append({"term": term, "log_odds": lo})
        diff_terms.sort(key=lambda x: -x["log_odds"])
    charts["community_diff"] = {"a": top_comms[0] if top_comms else None, "b": top_comms[1] if len(top_comms) > 1 else None,
                                "terms": diff_terms[:15]}
    metrics["SR05"] = CM.M("SR05", len(diff_terms) if len(top_comms) >= 2 else None, n=n,
                           method="头部两个社区的 log-odds 差异词",
                           reason="至少需要两个社区" if len(top_comms) < 2 else "")

    phrases = {}
    for c in top_comms[:6]:
        phrases[c] = CM.ngram_phrases(df[df["community"] == c]["norm"].tolist(), 8, 2)
    charts["phrases"] = [{"community": c, "phrases": v} for c, v in phrases.items()]
    metrics["SR06"] = CM.M("SR06", sum(len(v) for v in phrases.values()), num=None, den=len(phrases), n=n,
                           method="社区内高频 2-gram 短语")
    metrics["SR07"] = CM.M("SR07", len(phrases), num=None, den=None, n=n,
                           method="典型话术 = 特征短语 + 语义聚类（见 charts.topics）")

    # ---------- SR08 社区主题结构 ----------
    topics = []
    for c in top_comms[:6]:
        sub = df[df["community"] == c]
        attrs = Counter(CM.attr_label(a) for lst in sub["attrs"] for a in lst if CM.is_valid_attr(a))
        ints = Counter(i for lst in sub["intent_names"] for i in lst)
        topics.append({
            "community": c,
            "attributes": [{"attribute": a, "n": v} for a, v in attrs.most_common(6)],
            "intents": [{"intent": i, "n": v} for i, v in ints.most_common(5)],
        })
    charts["topics"] = topics
    metrics["SR08"] = CM.M("SR08", len(topics), num=None, den=len(top_comms), n=n,
                           method="属性/意图构成作为社区主题结构（轻量可解释）")

    # ---------- SR09-12 社区属性/需求/品牌/情感 ----------
    top_attrs = [a for a, _ in CM.attr_counts(df).most_common(10)]
    heat = []
    for c in top_comms[:8]:
        sub = df[df["community"] == c]
        row = {"community": c}
        for a in top_attrs:
            row[a] = round(float(CM.attr_surface_mask(sub, a).mean()), 4)
        heat.append(row)
    charts["attr_heatmap"] = {"communities": [r["community"] for r in heat], "attributes": top_attrs, "matrix": heat}
    metrics["SR09"] = CM.M("SR09", len(top_attrs), num=None, den=len(top_comms), n=n,
                           method="社区 × 属性关注度矩阵（文档占比）")

    intent_rows = []
    for c in top_comms[:8]:
        sub = df[df["community"] == c]
        cnt = Counter(i for lst in sub["intent_names"] for i in lst)
        tot = max(1, len(sub))
        intent_rows.append({"community": c, "needs": round(float(CM.need_mask(sub).mean()), 4),
                            "top": [{"intent": k, "pct": round(v / tot * 100, 2)} for k, v in cnt.most_common(5)]})
    charts["intent_structure"] = intent_rows
    metrics["SR10"] = CM.M("SR10", len(intent_rows), num=None, den=None, n=n, method="社区需求/意图结构（意图文档占比）")

    brand_rows = []
    for c in top_comms[:8]:
        sub = df[df["community"] == c]
        bc = CM.brand_counts(sub)
        brand_rows.append({"community": c, "brands": [{"brand": CM.brand_label(b), "n": v, "share": round(v / max(1, len(sub)), 4)}
                                                      for b, v in bc.most_common(5)]})
    charts["brand_pref"] = brand_rows
    metrics["SR11"] = CM.M("SR11", len(brand_rows), num=None, den=None, n=n, method="社区品牌提及与正负分布（代理偏好）")

    comm_sent = [{"community": r["community"], "neg_rate": r["neg_rate"],
                  "pos": CM.sent_distribution(df[df["community"] == r["community"]])["pos"]} for r in rows[:12]]
    charts["sentiment"] = comm_sent
    metrics["SR12"] = CM.M("SR12", round(float(np.std([x["neg_rate"] or 0 for x in comm_sent])), 4) if comm_sent else None,
                           num=None, den=len(comm_sent), n=n, method="社区负面率标准差（实体级情感）")

    # ---------- SR13-19 内容形态与互动 ----------
    forms = {
        "post_share": round(float((df["kind"] == "post").mean()), 4),
        "comment_share": round(float((df["kind"] == "comment").mean()), 4),
        "url_share": round(float(df["text"].str.contains(r"https?://", regex=True).mean()), 4),
        "emoji_share": round(float(df["norm"].str.contains(CM.RE_EMOJI, regex=True).mean()), 4),
    }
    charts["forms"] = forms
    metrics["SR13"] = CM.M("SR13", forms["post_share"], num=int((df["kind"] == "post").sum()), den=n, n=n,
                           method="帖子/评论/链接占比")
    metrics["SR14"] = CM.M("SR14", round(float(df["chars"].mean()), 1), num=int(df["chars"].sum()), den=n, n=n,
                           method="字符数分布（均值）", note=f"P50={int(df['chars'].median())}, P90={ST.quantile(df['chars'], .9)}")
    doms = CM.url_domains(df["norm"].tolist())
    charts["domains"] = [{"domain": d, "n": c} for d, c in doms.most_common(12)]
    metrics["SR15"] = CM.M("SR15", len(doms), num=sum(doms.values()), den=n, n=n, method="URL 域名提取统计",
                           note=f"Top 域名 {doms.most_common(1)[0][0] if doms else '无'}")
    emoji = Counter(e for t in df["norm"] for e in CM.RE_EMOJI.findall(t))
    charts["emoji"] = [{"emoji": e, "n": c} for e, c in emoji.most_common(12)]
    metrics["SR16"] = CM.M("SR16", sum(emoji.values()), num=len(emoji), den=n, n=n, method="Emoji / 缩写 / 特殊表达统计")
    metrics["SR17"] = CM.M("SR17", round(float(df["score"].mean()), 2), num=int(df["score"].sum()), den=n, n=n,
                           method="互动量分布（均值）", note=f"P50={int(df['score'].median())}, P90={ST.quantile(df['score'], .9)}")

    sc = df[df["kind"] == "post"]
    joint = [{"score": int(r.score), "comments": int(getattr(r, "n_comments", 0)), "community": r.community}
             for r in sc.itertuples(index=False)]
    charts["score_joint"] = joint[:800]
    hi = sc[sc["score"] >= sc["score"].quantile(0.8)]
    lo = sc[sc["score"] <= sc["score"].quantile(0.2)]
    hi_cnt = Counter(t for toks in hi["tokens"] for t in toks if len(t) > 3)
    lo_cnt = Counter(t for toks in lo["tokens"] for t in toks if len(t) > 3)
    hi_rows = [{"term": t, "log_odds": ST.log_odds_ratio(c, max(1, len(hi)), lo_cnt.get(t, 0), max(1, len(lo)))}
               for t, c in hi_cnt.most_common(200)]
    hi_rows.sort(key=lambda x: -x["log_odds"])
    charts["engagement_features"] = hi_rows[:12]
    metrics["SR18"] = CM.M("SR18", round(float(sc["score"].corr(sc["n_comments"])), 4) if len(sc) > 10 else None,
                           num=None, den=len(sc), n=len(sc), method="Score × 评论量 Pearson 相关")
    metrics["SR19"] = CM.M("SR19", len(hi_rows), num=len(hi), den=len(lo), n=len(sc),
                           method="高互动 vs 低互动文档的 log-odds 特征词")

    # ---------- SR20-23 作者与圈层 ----------
    auth_hhi = []
    for r in rows[:10]:
        sub = df[df["community"] == r["community"]]
        vc = sub["author"].value_counts()
        auth_hhi.append({"community": r["community"], "hhi": round(float(((vc / max(1, len(sub))) ** 2).sum()), 4),
                         "top10_share": round(float(vc.head(10).sum() / max(1, len(sub))), 4)})
    charts["author_concentration"] = auth_hhi
    metrics["SR20"] = CM.M("SR20", round(float(np.mean([x["hhi"] for x in auth_hhi])), 4) if auth_hhi else None,
                           num=None, den=len(auth_hhi), n=n, method="社区作者 HHI 与头部作者贡献")
    sets = {c: set(df[df["community"] == c]["author"]) for c in top_comms[:6]}
    pairs = []
    keys = list(sets)
    for i in range(len(keys)):
        for j in range(i + 1, len(keys)):
            pairs.append({"a": keys[i], "b": keys[j], "jaccard": ST.jaccard(sets[keys[i]], sets[keys[j]])})
    pairs.sort(key=lambda x: -x["jaccard"])
    charts["author_overlap"] = pairs
    metrics["SR21"] = CM.M("SR21", pairs[0]["jaccard"] if pairs else None, num=None, den=None, n=len(sets),
                           method="社区作者集合 Jaccard 相似度")

    # ---------- 语义相似度 / 圈层 ----------
    sims = []
    vecs = {}
    for c in top_comms[:8]:
        idx = df.index[df["community"] == c].tolist()
        if len(idx) < 5:
            continue
        v = scope.unit_emb[idx].mean(axis=0)
        vecs[c] = v / (np.linalg.norm(v) + 1e-9)
    keys = list(vecs)
    sim_mat = np.zeros((len(keys), len(keys)))
    for i, a in enumerate(keys):
        for j, b in enumerate(keys):
            sim_mat[i, j] = float(vecs[a] @ vecs[b])
    from .networks import community_partition
    groups, graph_method = community_partition(sim_mat, threshold=0.72, profile=scope.meta.get("nlp_profile"))
    charts["semantic_network"] = {
        "nodes": [{"community": k, "group": int(g)} for k, g in zip(keys, groups)],
        "links": [{"a": keys[i], "b": keys[j], "sim": round(float(sim_mat[i, j]), 3)}
                  for i in range(len(keys)) for j in range(i + 1, len(keys)) if sim_mat[i, j] > 0.6],
    }
    metrics["SR22"] = CM.M("SR22", round(float(sim_mat[np.triu_indices(len(keys), 1)].mean()), 4) if len(keys) > 1 else None,
                           num=None, den=len(keys), n=n, method="社区平均向量余弦相似度")
    metrics["SR23"] = CM.M("SR23", len(set(groups)), num=len(set(groups)), den=len(keys), n=n,
                           method="相似度网络 + " + graph_method)

    # ---------- SR24-27 时间与模因 ----------
    cal = df.groupby("date").size()
    charts["calendar"] = [{"date": str(d), "n": int(v)} for d, v in cal.items()]
    metrics["SR24"] = CM.M("SR24", len(cal), num=int(cal.sum()), den=len(cal), n=n, method="日期 × 主题矩阵（日历热力）")
    wd = df.groupby(["dow", "hour"]).size()
    charts["week_hour"] = [{"dow": int(d), "hour": int(h), "n": int(v)} for (d, h), v in wd.items()]
    metrics["SR25"] = CM.M("SR25", int(wd.max()) if len(wd) else None, num=None, den=len(wd), n=n,
                           method="星期 × 小时活跃分布峰值")

    # 模因：跨社区重复短语
    ph = Counter()
    ph_comm = defaultdict(set)
    first_seen = {}
    for r in df.itertuples(index=False):
        toks = [t for t in r.tokens if len(t) > 3 and t not in L.FUNCTION_WORDS]
        for i in range(len(toks) - 3):
            g = " ".join(toks[i : i + 4])
            ph[g] += 1
            ph_comm[g].add(r.community)
            if g not in first_seen or str(r.date) < first_seen[g]["date"]:
                first_seen[g] = {"date": str(r.date), "community": r.community}
    memes = [{"phrase": p, "n": c, "communities": len(ph_comm[p]), "first": first_seen[p]}
             for p, c in ph.most_common(400) if len(ph_comm[p]) >= 3][:12]
    charts["memes"] = memes
    metrics["SR26"] = CM.M("SR26", len(memes), num=None, den=None, n=n, method="4-gram 复用 + 近重复检测（模板化内容）")
    metrics["SR27"] = CM.M("SR27", len({m["first"]["community"] for m in memes}) if memes else None,
                           num=len(memes), den=None, n=n, method="模因首现社区与跨社区扩散")

    # ---------- SR28-30 ----------
    self_rep = {"age": 0, "occupation": Counter(), "region": Counter()}
    for t in df["norm"]:
        m = L.SELF_REPORT["age"].search(t)
        if m:
            self_rep["age"] += 1
        for m2 in L.SELF_REPORT["occupation"].finditer(t):
            self_rep["occupation"][m2.group(1).lower()] += 1
        for m3 in L.SELF_REPORT["region"].finditer(t):
            self_rep["region"][m3.group(2).lower()] += 1
    charts["self_report"] = {"age_mentions": self_rep["age"],
                             "occupation": [{"k": k, "n": v} for k, v in self_rep["occupation"].most_common(8)],
                             "region": [{"k": k, "n": v} for k, v in self_rep["region"].most_common(8)],
                             "coverage": round(self_rep["age"] / max(1, n), 4)}
    metrics["SR28"] = CM.M("SR28", self_rep["age"], num=self_rep["age"], den=n, n=n,
                           method="显式自述表达正则统计（年龄/职业/地域），仅匿名聚合")

    reps = []
    for c in top_comms[:6]:
        idx = df.index[df["community"] == c].tolist()
        if len(idx) < 5:
            continue
        v = scope.unit_emb[idx]
        centroid = v.mean(axis=0)
        centroid /= np.linalg.norm(centroid) + 1e-9
        best = idx[int(np.argmax(v @ centroid))]
        row = df.loc[best]
        reps.append({"community": c, "doc_id": row["doc_id"], "text": row["norm"][:260],
                     "date": str(row["date"]), "score": int(row["score"])})
    charts["representatives"] = reps
    metrics["SR29"] = CM.M("SR29", len(reps), num=None, den=len(top_comms), n=n,
                           method="社区语义中心最近样本 + 互动量加权采样")

    metrics["SR30"] = CM.M("SR30", len(rows), num=None, den=None, n=n, method="多社区完整画像对比表",
                           note="见 charts.communities 与对比面板")

    insights = []
    if rows:
        insights.append(f"讨论最集中的社区是 <b>r/{rows[0]['community']}</b>（{rows[0]['docs']} 条，"
                        f"{rows[0]['authors']} 位作者），占研究范围 {rows[0]['docs'] / n:.0%}。")
    if top_comms and lod.get(top_comms[0]):
        insights.append(f"r/{top_comms[0]} 的独特话术：{'、'.join(t['term'] for t in lod[top_comms[0]][:5])}。")
    if pairs:
        insights.append(f"作者重叠最高的一对社区：r/{pairs[0]['a']} × r/{pairs[0]['b']}（Jaccard {pairs[0]['jaccard']}）。")

    return {"module": "social", "metrics": metrics, "charts": charts, "insight": insights}

"""业务模块五：市场研究（MI01–MI30）。"""

from __future__ import annotations

import math
from collections import Counter, defaultdict

import numpy as np
import pandas as pd

from . import common as CM
from . import lexicon as L
from . import stats as ST
from .populations import archive_attention


def _js_divergence(p: np.ndarray, q: np.ndarray) -> float:
    p = p / (p.sum() + 1e-12)
    q = q / (q.sum() + 1e-12)
    m = (p + q) / 2
    def kl(a, b):
        mask = a > 0
        return float(np.sum(a[mask] * np.log(a[mask] / np.maximum(b[mask], 1e-12))))
    return round(0.5 * kl(p, m) + 0.5 * kl(q, m), 4)


def compute(scope, encoder=None) -> dict:
    df = scope.docs
    n = len(df)
    metrics: dict[str, dict] = {}
    charts: dict[str, object] = {}

    # ---------- MI01-04 品类结构 ----------
    disc = scope.discovery or {}
    subcats = [{"term": x["term"], "df": x["df"], "support": x["support"]}
               for x in disc.get("categories", [])[:25]]
    charts["linguistic_categories"] = disc.get("linguistic_categories", [])
    tree = []
    for s in subcats:
        parent = next((c for c in L.CATEGORY_TERMS if c != s["term"] and c in s["term"]), None)
        tree.append({"name": s["term"], "value": s["df"], "parent": parent or "root"})
    charts["structure"] = tree
    metrics["MI01"] = CM.M("MI01", len(subcats), num=len(subcats), den=n, n=n,
                           method="领域品类模式与核心片段的文档支持度", data=tree)
    metrics["MI02"] = CM.M("MI02", len([t for t in tree if t["parent"] != "root"]), num=None, den=len(tree), n=n,
                           method="短语结构 + 共现判断上下位关系")

    metrics["MI03"] = archive_attention(scope, "MI03", 1_000_000)

    prof = {}
    for m in sorted(df["month"].dropna().unique()):
        sub = df[df["month"] == m]
        ac = CM.attr_counts(sub)
        tot = max(1, sum(ac.values()))
        prof[m] = {a: c / tot for a, c in ac.items()}
    change = None
    if len(prof) >= 2:
        ms = sorted(prof)
        keys = set(prof[ms[0]]) | set(prof[ms[-1]])
        v1 = np.array([prof[ms[0]].get(k, 0) for k in keys])
        v2 = np.array([prof[ms[-1]].get(k, 0) for k in keys])
        change = round(float(1 - (v1 @ v2) / (np.linalg.norm(v1) * np.linalg.norm(v2) + 1e-9)), 4)
    metrics["MI04"] = CM.M("MI04", change, num=None, den=len(prof), n=n,
                           method="月度属性结构余弦距离（0=结构不变）")

    # ---------- MI05-12 品牌 ----------
    bc = CM.brand_counts(df)
    total_mentions = sum(bc.values())
    mentions_by_month = df.assign(brand_mentions=df["brands"].map(len)).groupby("month")["brand_mentions"].sum().to_dict()
    brands = []
    months = sorted(df.loc[df["month"].notna() & df["month"].ne(""), "month"].unique())
    for b, c in bc.most_common(15):
        docs_ = df[df["brands"].map(lambda x: b in x)]
        by_month = docs_.groupby("month").size().to_dict()
        first_month = min(by_month) if by_month else None
        brands.append({
            "brand": b, "label": CM.brand_label(b), "docs": int(c),
            "share": round(c / max(1, total_mentions), 4),
            "coverage": round(c / n, 4),
            "authors": int(docs_["author"].nunique()), "threads": int(docs_["thread_id"].nunique()),
            "by_month": {m: int(v) for m, v in by_month.items()},
            "first_month": first_month,
            "growth": ST.growth_rate(by_month.get(months[-1], 0), by_month.get(months[-2], 0)) if len(months) > 1 else None,
        })
    metrics["MI05"] = CM.M("MI05", brands[0]["docs"] if brands else None, num=brands[0]["docs"] if brands else None,
                           den=n, n=n, method="品牌文档/作者/线程计数",
                           note=f"Top 品牌 {brands[0]['label']}" if brands else "")
    metrics["MI06"] = CM.M("MI06", brands[0]["share"] if brands else None, num=brands[0]["docs"] if brands else None,
                           den=total_mentions, n=n, method="品牌–文档关系数 / 全部品牌–文档关系数",
                           note="同一文档可提及多个品牌，份额为社媒声量口径而非市场份额")
    metrics["MI07"] = CM.M("MI07", brands[0]["coverage"] if brands else None, num=brands[0]["docs"] if brands else None,
                           den=n, n=n, method="品牌相关文档 / 品类文档")
    share_change = None
    first_share = last_share = None
    if brands and len(months) >= 2:
        b0 = brands[0]
        f, l = b0["by_month"].get(months[0], 0), b0["by_month"].get(months[-1], 0)
        tf = mentions_by_month.get(months[0], 0)
        tl = mentions_by_month.get(months[-1], 0)
        if tf and tl:
            first_share, last_share = f / tf, l / tl
            share_change = round(last_share - first_share, 4)
    metrics["MI08"] = CM.M("MI08", share_change, n=n, method="品牌提及份额变化（末月-首月）",
                           formula_inputs={"current": last_share, "previous": first_share})
    last_n = prev_n = None
    if brands and len(months) >= 2:
        last_n, prev_n = [brands[0]["by_month"].get(month, 0) for month in months[-2:][::-1]]
    metrics["MI09"] = CM.M("MI09", brands[0]["growth"] if brands else None, num=last_n, den=prev_n, n=n,
                           method="品牌文档数月环比增长")
    counts = list(bc.values())
    metrics["MI10"] = CM.M("MI10", ST.hhi(counts), num=sum(counts), den=n, n=n, method="HHI / CR3 / CR5",
                           note=f"CR3={ST.cr_n(counts, 3)}，CR5={ST.cr_n(counts, 5)}")
    emerging = [b for b in brands if months and b["first_month"] == months[-1] and b["docs"] >= 5]
    metrics["MI11"] = CM.M("MI11", len(emerging), num=len(emerging), den=len(brands), n=n,
                           method="末期首现且持续出现的品牌", note="、".join(b["label"] for b in emerging[:5]))
    model_counter = Counter(m for lst in df["models"] for m in lst)
    metrics["MI12"] = CM.M("MI12", len(model_counter), num=sum(model_counter.values()), den=n, n=n,
                           method="型号正则识别 + 首现时间")
    charts["brands"] = brands
    charts["emerging_models"] = [{"model": m, "n": c} for m, c in model_counter.most_common(15)]

    # ---------- MI13-16 关系 ----------
    pair_counter = Counter()
    for r in df.itertuples(index=False):
        bs = sorted(set(r.brands))
        for i in range(len(bs)):
            for j in range(i + 1, len(bs)):
                pair_counter[(bs[i], bs[j])] += 1
    pairs = []
    for (a, b), c in pair_counter.most_common(80):
        expected = (bc[a] * bc[b]) / max(1, n)
        pairs.append({"a": CM.brand_label(a), "b": CM.brand_label(b), "co": int(c),
                      "lift": round(c / max(1e-9, expected), 2)})
    metrics["MI13"] = CM.M("MI13", len(pair_counter), num=sum(pair_counter.values()), den=n, n=n,
                           method="文档内品牌共提计数 + lift")
    comp = Counter()
    alt = Counter()
    for r in df.itertuples(index=False):
        for rel in r.relations:
            if rel["type"] == "COMPARE":
                comp[(rel["a"][:30], rel["b"][:30])] += 1
            elif rel["type"] == "ALTERNATIVE":
                alt[rel["a"][:30]] += 1
    metrics["MI14"] = CM.M("MI14", sum(comp.values()), num=sum(comp.values()), den=n, n=n,
                           method="比较句模板（X vs Y / compar*）抽取")
    metrics["MI15"] = CM.M("MI15", sum(alt.values()), num=sum(alt.values()), den=n, n=n,
                           method="替代关系模板（alternatives to / instead of）抽取")
    nodes = sorted({p["a"] for p in pairs} | {p["b"] for p in pairs})
    idx = {b: i for i, b in enumerate(nodes)}
    sim = np.zeros((len(nodes), len(nodes)))
    for p in pairs:
        i, j = idx[p["a"]], idx[p["b"]]
        sim[i, j] = sim[j, i] = p["lift"]
    from .networks import community_partition
    threshold = max(0.5, float(np.median([p["lift"] for p in pairs]))) if pairs else 1.0
    groups, graph_method = community_partition(sim, threshold, scope.meta.get("nlp_profile"))
    metrics["MI16"] = CM.M("MI16", len(set(groups)) if groups else None, num=len(nodes), den=None, n=n,
                           method="竞争共提网络 + " + graph_method)
    label_counts = {CM.brand_label(brand): count for brand, count in bc.items()}
    charts["competition"] = {
        "nodes": [{"brand": b, "group": int(g), "docs": label_counts[b]} for b, g in zip(nodes, groups)],
        "links": pairs[:40],
    }
    charts["compare_pairs"] = [{"a": a, "b": b, "n": c} for (a, b), c in comp.most_common(15)]
    charts["alternatives"] = [{"term": a, "n": c} for a, c in alt.most_common(12)]

    # ---------- MI17-23 品牌 × 属性 ----------
    af = CM.aspect_frame(scope)
    attr_rows = []
    if len(af):
        af2 = af[af["sentiment"].isin(["正面", "负面"])]
        attrs = [a for a, _ in CM.attr_counts(df).most_common(10)]
        for b in [x["brand"] for x in brands[:8]]:
            sub = af2[af2["brand"] == b]
            row = {"brand": CM.brand_label(b), "n": int(len(sub))}
            for a in attrs:
                g = sub[sub["attribute"] == a]
                row[a] = round(float((g["sentiment"] == "负面").mean()), 3) if len(g) >= 3 else None
            attr_rows.append(row)
        charts["brand_attr_neg"] = {"brands": [r["brand"] for r in attr_rows], "attributes": attrs, "matrix": attr_rows}

        # PMI 关联
        pmi_rows = []
        attr_docs = {a: int(CM.attr_surface_mask(df, a).sum()) for a in attrs}
        for b in [x["brand"] for x in brands[:8]]:
            bdocs = df["brands"].map(lambda x: b in x)
            nb = int(bdocs.sum())
            for a in attrs:
                both = int((bdocs & CM.attr_surface_mask(df, a)).sum())
                if both < 3:
                    continue
                pmi_rows.append({"brand": CM.brand_label(b), "attribute": a, "n": both,
                                 "pmi": ST.pmi(both, nb, attr_docs[a], n),
                                 "npmi": ST.npmi(both, nb, attr_docs[a], n)})
        charts["brand_attr_pmi"] = sorted(pmi_rows, key=lambda x: -x["npmi"])[:30]
        metrics["MI17"] = CM.M("MI17", round(float(np.mean([p["npmi"] for p in pmi_rows])), 4) if pmi_rows else None,
                               num=len(pmi_rows), den=n, n=n, method="品牌 × 属性 NPMI")
        metrics["MI18"] = CM.M("MI18", round(float(np.mean([r["n"] for r in attr_rows])), 1) if attr_rows else None,
                               num=None, den=len(attr_rows), n=n, method="品牌内容中属性相关比例")
        sent_rows = []
        for b in [x["brand"] for x in brands[:8]]:
            sub = af2[af2["brand"] == b]
            if len(sub) < 5:
                continue
            sent_rows.append({"brand": CM.brand_label(b), "pos": int((sub["sentiment"] == "正面").sum()),
                              "neg": int((sub["sentiment"] == "负面").sum()),
                              "net": round(float((sub["sentiment"] == "正面").mean() - (sub["sentiment"] == "负面").mean()), 3)})
        charts["brand_sentiment"] = sent_rows
        metrics["MI19"] = CM.M("MI19", len(sent_rows), num=None, den=len(af2), n=n, method="品牌 × 属性 × 情感")
        strengths = []
        weaknesses = []
        for b in [x["brand"] for x in brands[:8]]:
            sub = af2[af2["brand"] == b]
            for a, g in sub.groupby("attribute"):
                if len(g) < 4:
                    continue
                neg = float((g["sentiment"] == "负面").mean())
                if neg <= 0.2:
                    strengths.append({"brand": CM.brand_label(b), "attribute": a, "n": int(len(g)), "neg": neg})
                if neg >= 0.5:
                    weaknesses.append({"brand": CM.brand_label(b), "attribute": a, "n": int(len(g)), "neg": neg})
        metrics["MI20"] = CM.M("MI20", len(strengths), num=None, den=len(af2), n=n, method="高关联且负面率≤20% 的属性")
        metrics["MI21"] = CM.M("MI21", len(weaknesses), num=None, den=len(af2), n=n, method="高关联且负面率≥50% 的属性")
        charts["strengths"] = sorted(strengths, key=lambda x: x["neg"])[:12]
        charts["weaknesses"] = sorted(weaknesses, key=lambda x: -x["neg"])[:12]

        # 定位图：品牌 × 属性矩阵 PCA
        if len(attr_rows) >= 3:
            mat = np.array([[r.get(a) if r.get(a) is not None else 0.5 for a in attrs] for r in attr_rows])
            mat = 1 - mat  # 正面度
            if np.linalg.matrix_rank(mat - mat.mean(axis=0)) >= 2:
                coords = CM.pca2(mat)
                charts["positioning"] = [{"brand": r["brand"], "x": round(float(coords[i, 0]), 3),
                                          "y": round(float(coords[i, 1]), 3)} for i, r in enumerate(attr_rows)]
            sims = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
            bsim = sims @ sims.T
            charts["brand_similarity"] = {
                "brands": [r["brand"] for r in attr_rows],
                "matrix": [[round(float(v), 3) for v in row] for row in bsim],
            }
            position = charts.get("positioning")
            metrics["MI22"] = CM.M("MI22", len(position) if position else None, den=len(attrs), n=n, data=position,
                                   method="品牌×属性矩阵 PCA 二维定位（属性正面度）",
                                   reason="可用评价无法支撑两个定位轴" if position is None else "")
            metrics["MI23"] = CM.M("MI23", round(float(bsim[np.triu_indices(len(attr_rows), 1)].mean()), 3) if len(attr_rows) > 1 else None,
                                   num=None, den=len(attr_rows), n=n, method="品牌属性向量余弦相似度均值")
            # 差异化：属性分布 JS 散度
            js = []
            for i in range(len(attr_rows)):
                for j in range(i + 1, len(attr_rows)):
                    js.append(_js_divergence(mat[i] + 1e-6, mat[j] + 1e-6))
            metrics["MI27"] = CM.M("MI27", round(float(np.mean(js)), 4) if js else None,
                                   num=len(js), den=len(attr_rows), n=n,
                                   method="品牌属性分布平均 JS 散度（越大差异越明显）")
    else:
        for mid in ("MI17", "MI18", "MI19", "MI20", "MI21", "MI22", "MI23", "MI27"):
            metrics[mid] = CM.M(mid, None, num=None, den=0, n=n, method="属性三元组不足")

    # ---------- MI24-25 价格 ----------
    pf, price_unit = CM.comparable_prices(CM.price_frame(scope))
    price_by_brand = []
    if len(pf):
        price_by_brand = [{"band": k, "n": int(v)} for k, v in
                          Counter(_bandof(v) for v in pf["value"]).most_common()]
        metrics["MI24"] = CM.M("MI24", round(float(pf["value"].median()), 2), num=len(pf), den=n, n=n,
                               method="同币种同周期价格表达分布", unit=price_unit)
        brand_price = []
        for b in [x["brand"] for x in brands[:6]]:
            docs_ = set(df[df["brands"].map(lambda x: b in x)]["doc_id"])
            sub = pf[pf["doc_id"].isin(docs_)]
            if len(sub) >= 3:
                brand_price.append({"brand": CM.brand_label(b), "n": int(len(sub)),
                                    "median": round(float(sub["value"].median()), 1)})
        charts["brand_price"] = brand_price
        metrics["MI25"] = CM.M("MI25", len(brand_price), num=None, den=len(brands[:6]), n=n,
                               method="品牌 × 价格类型 × 评价")
    else:
        metrics["MI24"] = CM.M("MI24", None, num=0, den=n, n=n, method="价格抽取（样本不足）")
        metrics["MI25"] = CM.M("MI25", None, num=0, den=n, n=n, method="品牌价格认知（样本不足）")
    charts["price_bands"] = price_by_brand

    # ---------- MI26 属性购买关联 ----------
    purchase = df["intent_names"].map(lambda x: bool(CM.PURCHASE_INTENTS & set(x) | CM.POST_INTENTS & set(x))).values
    base_rate = float(purchase.mean()) if n else 0
    lift_rows = []
    for a, c in CM.attr_counts(df).most_common(15):
        docs_with = CM.attr_surface_mask(df, a)
        p = float(purchase[docs_with].mean()) if docs_with.any() else 0
        lift_rows.append({"attribute": a, "docs": int(c), "lift": round(p / base_rate, 3) if base_rate else None})
    metrics["MI26"] = CM.M("MI26", max((r["lift"] or 0) for r in lift_rows) if lift_rows else None,
                           num=None, den=n, n=n, method="P(购买/体验|属性) / P(购买/体验)")
    charts["purchase_lift"] = lift_rows

    # ---------- MI28 购买漏斗 ----------
    stages = {
        "认知": int(df["intent_names"].map(lambda x: bool({"产品发布", "新闻事件", "传闻猜测"} & set(x))).sum()),
        "考虑": int(df["intent_names"].map(lambda x: bool(CM.CONSIDER_INTENTS & set(x))).sum()),
        "购买": int(df["intent_names"].map(lambda x: bool(CM.PURCHASE_INTENTS & set(x))).sum()),
        "购后": int(df["intent_names"].map(lambda x: bool(CM.POST_INTENTS & set(x))).sum()),
    }
    charts["funnel"] = [{"stage": k, "n": v, "pct": round(v / max(1, n) * 100, 2)} for k, v in stages.items()]
    metrics["MI28"] = CM.M("MI28", stages["购买"], num=stages["购买"], den=stages["考虑"], n=n,
                           method="四阶段意图表达统计（同一文档可多标签）",
                           note=" / ".join(f"{k}:{v}" for k, v in stages.items()))

    # ---------- MI29 迁移 ----------
    flows = Counter()
    for r in df.itertuples(index=False):
        for rel in r.relations:
            if rel["type"] != "SWITCH":
                continue
            a, b = rel["a"].lower(), rel["b"].lower()
            ba = CM.relation_endpoint(scope, a, {"BRAND"})
            bb = CM.relation_endpoint(scope, b, {"BRAND"})
            if ba and bb and ba != bb:
                flows[(CM.brand_label(ba), CM.brand_label(bb))] += 1
    metrics["MI29"] = CM.M("MI29", sum(flows.values()), num=sum(flows.values()), den=n, n=n,
                           method="显式迁移关系 + 原因属性")
    charts["migration"] = [{"from": a, "to": b, "n": c} for (a, b), c in flows.most_common(15)]

    # ---------- MI30 演化 ----------
    evo = []
    for m in months:
        sub = df[df["month"] == m]
        c = CM.brand_counts(sub)
        tot = max(1, sum(c.values()))
        evo.append({"month": m, "shares": {CM.brand_label(b): round(v / tot, 4) for b, v in c.most_common(6)}})
    charts["evolution"] = evo
    metrics["MI30"] = CM.M("MI30", len(evo), num=None, den=len(months), n=n,
                           method="时间 × 品牌 × 属性结构变化")

    insights = []
    if brands:
        insights.append(f"声量份额最高：<b>{brands[0]['label']}</b>（{brands[0]['share']:.1%}，{brands[0]['docs']} 篇），"
                        f"品牌集中度 HHI={metrics['MI10']['value']}")
    if charts.get("weaknesses"):
        w = charts["weaknesses"][0]
        insights.append(f"最明显弱点：<b>{w['brand']} × {w['attribute']}</b>（负面率 {w['neg']:.0%}，n={w['n']}）")
    if lift_rows:
        top = max(lift_rows, key=lambda x: x["lift"] or 0)
        insights.append(f"与购买/体验表达最相关的属性：<b>{top['attribute']}</b>（lift {top['lift']}）")
    if flows:
        f0 = max(flows.items(), key=lambda kv: kv[1])
        insights.append(f"最强迁移流向：<b>{f0[0][0]} → {f0[0][1]}</b>（{f0[1]} 次）")

    return {"module": "market", "metrics": metrics, "charts": charts, "insight": insights}


def _bandof(v: float) -> str:
    for lo, hi in [(0, 25), (25, 50), (50, 100), (100, 200), (200, 300), (300, 500), (500, 1000), (1000, 10**9)]:
        if lo <= v < hi:
            return f"${lo}-{hi if hi < 10**9 else '+'}"
    return "unknown"

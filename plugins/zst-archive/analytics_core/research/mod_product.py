"""业务模块一：选品分析（PR01–PR30）。"""

from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np
import pandas as pd

from . import common as CM
from . import lexicon as L
from . import segments as SG
from . import stats as ST

PRICE_BANDS = [(0, 25), (25, 50), (50, 100), (100, 200), (200, 300), (300, 500), (500, 1000), (1000, 10**9)]


def _band(v: float) -> str:
    for lo, hi in PRICE_BANDS:
        if lo <= v < hi:
            return f"${lo}-{hi if hi < 10**9 else '+'}"
    return "unknown"


def compute(scope, encoder=None, seg_data: dict | None = None) -> dict:
    df = scope.docs
    n = len(df)
    if n == 0:
        return {"module": "product", "metrics": {}, "charts": {}, "empty": True}

    metrics: dict[str, dict] = {}
    charts: dict[str, object] = {}

    # ---------- PR01 品类声量 ----------
    months = sorted(df.loc[df["month"].notna() & df["month"].ne(""), "month"].unique())
    by_month = df.groupby("month").size().to_dict()
    metrics["PR01"] = CM.M(
        "PR01", int(n), num=int(n), den=None, n=int(n), unit="docs",
        method="count(distinct doc_id)",
        note=f"{len(months)} 个月，{df['thread_id'].nunique()} 个线程，{df['author'].nunique()} 位作者",
        detail={"docs": int(n), "threads": int(df["thread_id"].nunique()), "authors": int(df["author"].nunique()),
                "posts": int((df["kind"] == "post").sum()), "comments": int((df["kind"] == "comment").sum()),
                "by_month": {m: int(v) for m, v in by_month.items()},
                "communities": int(df["community"].nunique())},
    )
    charts["volume"] = [{"month": m, "docs": int(v)} for m, v in by_month.items()]

    # ---------- PR02 / PR03 主动需求 ----------
    need = CM.need_mask(df)
    need_df = df[need]
    metrics["PR02"] = CM.M("PR02", int(need.sum()), num=int(need.sum()), den=None, n=n, unit="docs",
                           method="docs with intent ∈ {求推荐,寻找解决方案,寻找替代品,功能请求,组合需求}")
    metrics["PR03"] = CM.M("PR03", round(need.sum() / n, 4), num=int(need.sum()), den=n, n=n,
                           method="need_docs / category_docs",
                           note="分母为当前研究范围内的品类相关文档")

    # ---------- PR04 / PR05 / PR06 增长与持续性 ----------
    share_by_month = {}
    for m in months:
        sub = df[df["month"] == m]
        share_by_month[m] = round(float(need[df["month"] == m].sum() / max(1, len(sub))), 4)
    growth = None
    if len(months) >= 2:
        cur, prev = share_by_month[months[-1]], share_by_month[months[-2]]
        growth = ST.growth_rate(cur, prev)
    metrics["PR04"] = CM.M("PR04", growth, num=share_by_month.get(months[-1]) if months else None,
                           den=share_by_month.get(months[-2]) if len(months) > 1 else None, n=n,
                           method="需求占比环比增长（消除语料量波动）",
                           note="月度占比 " + " → ".join(f"{m}:{share_by_month[m]:.3%}" for m in months))
    daily_need = CM.daily_counts(df, need)
    slope = ST.theil_sen_slope(daily_need.values) if len(daily_need) > 5 else 0.0
    metrics["PR05"] = CM.M("PR05", slope, num=slope, den=None, n=len(daily_need),
                           method="Theil-Sen 稳健斜率（日需求计数）", unit="docs/day")
    known_days = df["date"].dropna()
    total_days = len(pd.date_range(known_days.min(), known_days.max(), freq="D")) if len(known_days) else 0
    active_days = int(need_df["date"].nunique())
    metrics["PR06"] = CM.M("PR06", round(active_days / total_days, 4) if total_days else None, num=active_days, den=total_days,
                           n=n, method="有需求出现的天数 / 覆盖天数")

    # ---------- PR07 品类负面率 ----------
    sd = CM.sent_distribution(df)
    metrics["PR07"] = CM.M("PR07", sd["neg_rate"], num=sd["neg"], den=sd["definite"], n=n,
                           method="负面评价 / 明确正负评价（排除未知/中性）",
                           evidence_ref=df.loc[df["sent_label"].eq("负面"), "doc_id"].head(10).tolist(),
                           note="采用当前配置的文档观点供应器")

    # ---------- PR08 满意度缺口（品牌/属性） ----------
    af = CM.aspect_frame(scope)
    gap_rows = []
    if len(af):
        af = af[af["sentiment"].isin(["正面", "负面"]) & af.brand.ne("")]
        for brand, g in af.groupby("brand"):
            if len(g) < 20:
                continue
            negs = int((g["sentiment"] == "负面").sum())
            gap_rows.append({"brand": brand, "brand_label": CM.brand_label(brand), "n": int(len(g)),
                             "neg": negs, "gap": round(negs / len(g), 4), "evidence_ref": g.doc_id.drop_duplicates().head(12).tolist()})
        gap_rows.sort(key=lambda x: (-x["gap"], -x["n"]))
    metrics["PR08"] = CM.M("PR08", gap_rows[0]["gap"] if gap_rows else None,
                           num=gap_rows[0]["neg"] if gap_rows else None, den=gap_rows[0]["n"] if gap_rows else None,
                           n=len(af), method="目标与属性同子句明确观点中的负面率",
                           note="仅统计提及该实体且出现属性的三元组")
    charts["brand_gap"] = gap_rows[:15]

    # ---------- PR09 / PR10 属性 ----------
    ac = CM.attr_counts(df)
    attr_rows = []
    purchase = df["intent_names"].map(lambda x: bool(CM.PURCHASE_INTENTS & set(x) | CM.POST_INTENTS & set(x))).values
    base_rate = purchase.mean() if n else 0
    for a, c in ac.most_common(20):
        docs_with = CM.attr_surface_mask(df, a)
        p_intent = purchase[docs_with].mean() if docs_with.any() else 0
        attr_rows.append({
            "attribute": a, "docs": int(c), "attention": round(c / n, 4),
            "lift": round(float(p_intent / base_rate), 3) if base_rate > 0 else None,
        })
    metrics["PR09"] = CM.M("PR09", round(ac.most_common(1)[0][1] / n, 4) if ac else None,
                           num=ac.most_common(1)[0][1] if ac else None, den=n, n=n,
                           method="属性文档 / 品类文档（取最高属性）",
                           note=f"共 {len(ac)} 个属性被提及")
    metrics["PR10"] = CM.M("PR10", max((r["lift"] or 0) for r in attr_rows) if attr_rows else None,
                           num=None, den=n, n=n, method="P(购买/体验意图|属性) / P(购买/体验意图)",
                           note="lift>1 表示该属性与购买/体验表达正相关")
    charts["attributes"] = attr_rows

    # ---------- PR11 核心痛点 ----------
    pain_df = df[df["pains"].map(len) > 0]
    pain_counter = Counter(p for lst in pain_df["pains"] for p in lst)
    pain_phrases = CM.ngram_phrases(pain_df["norm"].tolist(), 15, 2) if len(pain_df) else []
    metrics["PR11"] = CM.M("PR11", int(len(pain_df)), num=int(len(pain_df)), den=n, n=n,
                           method="痛点正则命中 + 短语提取",
                           note=f"Top 痛点类型：{'、'.join(k for k, _ in pain_counter.most_common(4))}")
    charts["pain_types"] = [{"type": k, "n": v, "pct": round(v / max(1, n) * 100, 2)} for k, v in pain_counter.most_common()]
    charts["pain_phrases"] = pain_phrases

    # ---------- PR12 功能请求 ----------
    fr = df[df["intent_names"].map(lambda x: "功能请求" in x)]
    fr_attrs = Counter(CM.attr_label(a) for lst in fr["attrs"] for a in lst if CM.is_valid_attr(a))
    metrics["PR12"] = CM.M("PR12", int(len(fr)), num=int(len(fr)), den=n, n=n, method="意图=功能请求")
    charts["feature_requests"] = [{"attribute": a, "n": c} for a, c in fr_attrs.most_common(12)]

    # ---------- PR13-16 场景 ----------
    sc = CM.scenario_counts(df)
    scen_rows = []
    for s, c in sc.most_common(12):
        docs_with = df["scenarios"].map(lambda x: s in x).values
        need_rate = need[docs_with].mean() if docs_with.any() else 0
        unmet_rate = CM.unmet_mask(df[docs_with]).mean() if docs_with.any() else 0
        scen_rows.append({
            "scenario": s, "docs": int(c), "attention": round(c / n, 4),
            "need_rate": round(float(need_rate), 4), "unmet_rate": round(float(unmet_rate), 4),
            "lift": round(float(need_rate / max(1e-9, need.mean())), 3),
        })
    metrics["PR13"] = CM.M("PR13", len(sc), num=len(sc), den=n, n=n, method="场景词典命中文档数",
                           note=f"Top 场景：{'、'.join(s for s, _ in sc.most_common(4))}")
    metrics["PR14"] = CM.M("PR14", max((r["lift"] for r in scen_rows), default=None),
                           num=None, den=n, n=n, method="P(需求|场景)/P(需求)")
    metrics["PR15"] = CM.M("PR15", ST.entropy(list(sc.values())), num=len(sc), den=sum(sc.values()), n=n,
                           method="场景分布归一化熵")
    gaps = [r for r in scen_rows if r["unmet_rate"] > 0.6 and r["docs"] >= max(10, n * 0.01)]
    metrics["PR16"] = CM.M("PR16", len(gaps), num=len(gaps), den=len(scen_rows), n=n,
                           method="未满足率>0.6 且样本达标的场景数",
                           note="、".join(g["scenario"] for g in gaps[:5]) or "无显著缺口")
    charts["scenarios"] = scen_rows

    # ---------- PR17-19 覆盖与替代 ----------
    need_brand = pd.Series(CM.known_brand_mask(need_df)) if len(need_df) else pd.Series(dtype=bool)
    metrics["PR17"] = CM.M("PR17", round(float(need_brand.mean()), 4) if len(need_df) else None,
                           num=int(need_brand.sum()) if len(need_df) else 0, den=int(need.sum()), n=n,
                           method="需求文档中出现已知品牌的比例")
    metrics["PR18"] = CM.solution_coverage("PR18", need_df)
    alt = int(df["intent_names"].map(lambda x: "寻找替代品" in x).sum())
    metrics["PR19"] = CM.M("PR19", round(alt / n, 4), num=alt, den=n, n=n, method="求替代意图 / 品类文档")

    # ---------- PR20-21 迁移 ----------
    flows = Counter()
    flow_docs = defaultdict(list)
    for r in df.itertuples(index=False):
        for rel in r.relations:
            if rel["type"] != "SWITCH":
                continue
            a, b = rel["a"].lower(), rel["b"].lower()
            ba = CM.relation_endpoint(scope, a, {"BRAND", "CATEGORY"})
            bb = CM.relation_endpoint(scope, b, {"BRAND", "CATEGORY"})
            if not ba or not bb or ba == bb:
                continue
            flows[(ba, bb)] += 1
            flow_docs[(ba, bb)].append(r.doc_id)
    metrics["PR20"] = CM.M("PR20", int(sum(flows.values())), num=int(sum(flows.values())), den=n, n=n,
                           method="迁移/替换句式正则抽取，仅保留可映射到已知品牌的 from→to",
                           note=f"识别到 {len(flows)} 条品牌迁移边")
    charts["migration"] = [{"from": CM.brand_label(a), "to": CM.brand_label(b), "n": c,
                             "doc_ids": flow_docs[(a, b)][:10]}
                           for (a, b), c in flows.most_common(20)]
    reasons = []
    for (a, b), docs_ in list(sorted(flow_docs.items(), key=lambda kv: -len(kv[1])))[:6]:
        sub = af[af["doc_id"].isin(docs_)] if len(af) else pd.DataFrame()
        if len(sub):
            top = sub.groupby("attribute").size().sort_values(ascending=False).head(3)
            reasons.append({"from": CM.brand_label(a), "to": CM.brand_label(b),
                            "reasons": [{"attribute": k, "n": int(v)} for k, v in top.items()]})
    metrics["PR21"] = CM.M("PR21", len(reasons), num=len(reasons), den=len(flows), n=n,
                           method="迁移文档内属性三元组统计")
    charts["migration_reasons"] = reasons

    # ---------- PR22-25 价格 ----------
    price_data = CM.price_frame(scope)
    pf, price_unit = CM.comparable_prices(price_data)
    price_rows = []
    if len(pf):
        bands = Counter(_band(v) for v in pf["value"].values)
        price_rows = [{"band": b, "n": c} for b, c in bands.most_common()]
        by_kind = pf.groupby("kind")["value"].agg(["count", "median"]).reset_index()
        charts["price_kinds"] = [{"kind": r["kind"], "n": int(r["count"]), "median": round(float(r["median"]), 1)}
                                 for _, r in by_kind.iterrows()]
    metrics["PR22"] = CM.M("PR22", round(float(pf["value"].median()), 2) if len(pf) else None,
                           num=int(len(pf)), den=n, n=n, method="价格表达式抽取（货币/周期分类）中位数",
                           unit=price_unit, note="按支持数最多的货币与计费周期统计",
                           evidence_ref=pf["doc_id"].drop_duplicates().head(10).tolist() if len(pf) else [])
    ch = pf[pf["kind"] == "预算"]["value"] if len(pf) else pd.Series(dtype=float)
    metrics["PR23"] = CM.M("PR23", round(float(ch.median()), 2) if len(ch) else None,
                           num=int(len(ch)), den=int(len(pf)) if len(pf) else 0, n=n,
                           method="同币种同周期预算类价格的中位数与分位", unit=price_unit,
                           note=f"P25={ST.quantile(ch, .25)}, P75={ST.quantile(ch, .75)}" if len(ch) else "预算表达样本不足")
    sens = df["intent_names"].map(lambda x: bool({"价格比较", "预算询问"} & set(x))) | df["pains"].map(lambda x: "价格贵" in x)
    metrics["PR24"] = CM.M("PR24", round(float(sens.mean()), 4), num=int(sens.sum()), den=n, n=n,
                           method="(比价/预算/价格抱怨) 文档 / 品类文档")
    charts["price_bands"] = price_rows

    value_matrix = []
    if len(pf) and len(af):
        afp = af[af["attribute"] == "价格"]
        price_docs = dict(zip(pf["doc_id"], pf["value"]))
        agg = defaultdict(lambda: [0, 0])
        for r in afp[afp.sentiment.isin(["正面", "负面"])].itertuples(index=False):
            v = price_docs.get(r.doc_id)
            if not v:
                continue
            b = _band(v)
            agg[b][0 if r.sentiment == "正面" else 1] += 1
        for b, (pos_, neg_) in agg.items():
            tot = pos_ + neg_
            value_matrix.append({"band": b, "pos": pos_, "neg": neg_,
                                 "pos_rate": round(pos_ / tot, 3) if tot else None})
        value_matrix.sort(key=lambda x: x["band"])
    charts["value_matrix"] = value_matrix
    metrics["PR25"] = CM.M("PR25", len(value_matrix), num=len(value_matrix), den=n, n=n,
                           method="价格带 × 价格属性情感矩阵")

    # ---------- PR26 品牌集中度 ----------
    bc = CM.brand_counts(df)
    metrics["PR26"] = CM.M("PR26", ST.hhi(list(bc.values())), num=sum(bc.values()), den=n, n=n,
                           method="品牌声量 HHI（基于文档-品牌提及计数）",
                           note=f"CR3={ST.cr_n(list(bc.values()), 3)}，覆盖 {len(bc)} 个品牌")
    charts["brand_share"] = [{"brand": CM.brand_label(b), "docs": c, "share": round(c / max(1, n), 4)}
                             for b, c in bc.most_common(12)]

    # ---------- PR27 社区覆盖 ----------
    comm_need = df[need].groupby("community").size().sort_values(ascending=False)
    metrics["PR27"] = CM.M("PR27", int(df[need]["community"].nunique()), num=int(df[need]["community"].nunique()),
                           den=int(df["community"].nunique()), n=int(len(need_df)),
                           method="出现需求表达的社区数 / 全部社区数",
                           note=f"需求社区 Top1 占比 {ST.top_share(list(comm_need.values), 1) if len(comm_need) else 0}")
    charts["need_communities"] = [{"community": k, "n": int(v)} for k, v in comm_need.head(12).items()]

    # ---------- PR28-29 机会评分（基于需求簇） ----------
    if seg_data is None and encoder is not None:
        seg_data = SG.build_segments(scope, encoder)
    segs = (seg_data or {}).get("segments", [])
    ranked = []
    if segs:
        for s in segs:
            s["product_score"] = SG.segment_score(s, max(x["size"] for x in segs), 1.0, factor="product",
                                                  all_segments=segs)
        ranked = sorted(segs, key=lambda x: -x["product_score"])
    metrics["PR28"] = CM.M("PR28", ranked[0]["product_score"] if ranked else None,
                           num=len(ranked), den=len(segs), n=n,
                           method="需求规模/增长/未满足/方案缺口/持续性/跨社区 加权百分位",
                           note="权重可调，见参数 params.weights")
    metrics["PR29"] = CM.M("PR29", len(ranked), num=len(ranked), den=None, n=n,
                           method="按综合分排序的候选机会数")
    charts["product_ranking"] = [
        {"id": s["id"], "name": s["name"], "score": s["product_score"], "size": s["size"],
         "growth": s["growth"], "unmet_rate": s["unmet_rate"], "brand_coverage": s["brand_coverage"],
         "communities": s["communities"], "attributes": [a["attribute"] for a in s["attributes"][:3]]}
        for s in ranked[:12]
    ]
    charts["product_segments"] = ranked

    # ---------- PR30 品类横向比较 ----------
    comps = scope.meta.get("comparisons", [])
    metrics["PR30"] = CM.M("PR30", len(comps) if len(comps) >= 2 else None, num=len(comps), n=len(comps),
                           method="跨研究范围指标矩阵（文档量/需求密度/负面率/品牌集中度）",
                           reason="至少需要两个同期研究范围" if len(comps) < 2 else "",
                           note=f"已比较 {len(comps)} 个研究范围：" + "、".join(c["name"] for c in comps[:5]), data=comps)
    charts["category_compare"] = comps

    # 洞察
    insights = []
    if ranked:
        top = ranked[0]
        insights.append(f"机会分最高：<b>{top['name']}</b>（{top['product_score']} 分，{top['size']} 条片段，"
                        f"未满足率 {top['unmet_rate']:.0%}，品牌覆盖 {top['brand_coverage']:.0%}）")
    insights.append(f"核心文档中的主动需求密度为 <b>{need.sum() / n:.1%}</b>（{int(need.sum())}/{n} 篇）。")
    if gap_rows:
        insights.append(f"满意度缺口最大的品牌：<b>{gap_rows[0]['brand_label']}</b>（负面率 {gap_rows[0]['gap']:.0%}，n={gap_rows[0]['n']}）")
    if price_rows:
        insights.append(f"价格提及以 <b>{price_rows[0]['band']}</b> 区间最多（{price_rows[0]['n']} 次），可结合价值矩阵定位定价机会。")

    return {"module": "product", "metrics": metrics, "charts": charts, "insight": insights,
            "params": {"weights": SG.SCORE_PROFILES["product"]}}

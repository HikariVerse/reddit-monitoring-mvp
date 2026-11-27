"""业务模块四：机会探索（OD01–OD30）。"""

from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np
import pandas as pd

from . import common as CM
from . import lexicon as L
from . import segments as SG
from . import stats as ST


def compute(scope, encoder, seg_data: dict | None = None) -> dict:
    df = scope.docs
    n = len(df)
    metrics: dict[str, dict] = {}
    charts: dict[str, object] = {}

    need = CM.need_mask(df)
    pain = CM.pain_mask(df)
    unmet = CM.unmet_mask(df)
    feature_req = df["intent_names"].map(lambda x: "功能请求" in x).values | CM.state_mask(df, "feature_request")
    alt = df["intent_names"].map(lambda x: "寻找替代品" in x).values

    metrics["OD01"] = CM.M("OD01", int(need.sum()), num=int(need.sum()), den=n, n=n, method="需求意图抽取")
    metrics["OD02"] = CM.M("OD02", int(pain.sum()), num=int(pain.sum()), den=n, n=n, method="痛点正则 + 负面属性")
    metrics["OD03"] = CM.M("OD03", int(feature_req.sum()), num=int(feature_req.sum()), den=n, n=n, method="功能请求意图")
    metrics["OD04"] = CM.M("OD04", int(unmet.sum()), num=int(unmet.sum()), den=int(need.sum()), n=n,
                           method="明确未满足需求状态文档计数")

    # ---------- OD05-08 聚类 ----------
    if seg_data is None:
        seg_data = SG.build_segments(scope, encoder)
    segs = seg_data.get("segments", [])
    need_segs = [s for s in segs]
    pain_data = SG.build_segments(scope, encoder, kinds=("pain",))
    pain_segs = pain_data["segments"]
    metrics["OD05"] = CM.M("OD05", len(need_segs), num=len(need_segs), den=seg_data.get("n_segments"), n=n,
                           method=f"需求片段向量聚类（{seg_data.get('method')}）",
                           note=f"片段 {seg_data.get('n_segments')} 条，轮廓系数 {seg_data.get('silhouette')}")
    metrics["OD06"] = CM.M("OD06", len(pain_segs) if pain_segs else None, num=len(pain_segs), den=pain_data["n_segments"], n=n,
                           method="仅痛点片段独立向量聚类与 c-TF-IDF 命名", data=pain_segs)
    charts["pain_segments"] = pain_segs
    metrics["OD07"] = CM.M("OD07", len([s for s in segs if s["name"]]), num=None, den=len(segs), n=n,
                           method="自动命名：簇内高频词 + 代表短语")
    metrics["OD08"] = CM.M("OD08", segs[0]["size"] if segs else None, num=segs[0]["size"] if segs else None,
                           den=n, n=n, method="最大需求簇的支持度（文档/作者/线程）")

    # ---------- OD09-15 未满足/增长/新颖 ----------
    if segs:
        unmet_count = sum(s["unmet_count"] for s in segs)
        segment_count = sum(s["size"] for s in segs)
        metrics["OD09"] = CM.M("OD09", round(unmet_count / segment_count, 4),
                               num=unmet_count, den=segment_count,
                               n=n, method="未满足需求片段 / 全部需求片段")
        growth_seg = [s for s in segs if s["growth"] is not None]
        metrics["OD10"] = CM.M("OD10", round(float(np.mean([s["growth"] for s in growth_seg])), 4) if growth_seg else None,
                               num=None, den=len(growth_seg), n=n, method="各需求簇月度占比增长均值")
        slopes = [s["slope"] for s in segs if s["slope"] is not None]
        metrics["OD11"] = CM.M("OD11", round(float(np.mean(slopes)), 4) if slopes else None,
                               num=None, den=len(slopes), n=n, method="需求簇每日片段计数 Theil–Sen 斜率均值")
        persistence = [s["persistence"] for s in segs if s["persistence"] is not None]
        metrics["OD12"] = CM.M("OD12", round(float(np.mean(persistence)), 4) if persistence else None,
                               num=None, den=len(segs), n=n, method="簇活跃天数 / 覆盖天数")
    else:
        for mid in ("OD09", "OD10", "OD11", "OD12"):
            metrics[mid] = CM.M(mid, None, num=None, den=0, n=n, method="需求簇不足")

    months = sorted(df.loc[df["month"].notna() & df["month"].ne(""), "month"].unique())
    new_terms = []
    if len(months) >= 2:
        early = Counter(t for toks in df[df["month"] != months[-1]]["tokens"] for t in toks if len(t) > 3)
        late = Counter(t for toks in df[df["month"] == months[-1]]["tokens"] for t in toks if len(t) > 3)
        for t, c in late.most_common(500):
            if c >= 5 and early.get(t, 0) <= 1:
                new_terms.append({"term": t, "late": c, "early": early.get(t, 0)})
    historical = [s for s in segs if s["novelty"] is not None]
    emerging = [s for s in historical if s["novelty"] >= .2 and s["first_observed"].startswith(months[-1])]
    metrics["OD13"] = CM.M("OD13", len(emerging) if historical else None, den=len(historical), n=n,
                           method="末月首次观测且与历史簇语义距离达到 0.2 的候选簇",
                           data=[{"id": s["id"], "name": s["name"], "first_observed": s["first_observed"]} for s in emerging])
    metrics["OD14"] = CM.M("OD14", round(float(np.mean([s["novelty"] for s in historical])), 4) if historical else None,
                           num=None, den=len(historical), n=n, method="末期需求中心与历史最近中心的余弦距离均值")
    vocab_size = len(late) if len(months) >= 2 else 0
    metrics["OD15"] = CM.M("OD15", round(len(new_terms) / vocab_size, 4) if vocab_size else None,
                           num=len(new_terms), den=vocab_size, n=n,
                           method="末期新出现词 / 末期词表", note="、".join(t["term"] for t in new_terms[:6]))
    charts["new_terms"] = new_terms[:20]

    # ---------- OD16-20 变通与组合 ----------
    wa = CM.state_mask(df, "workaround")
    metrics["OD16"] = CM.M("OD16", int(wa.sum()), num=int(wa.sum()), den=n, n=n,
                           method="变通/DIY 模板（workaround / i use X as / built my own）")
    wa_need = int((wa & need).sum())
    metrics["OD17"] = CM.M("OD17", round(wa_need / need.sum(), 4) if need.any() else None, num=wa_need, den=int(need.sum()),
                           n=n, method="变通方案文档 / 需求文档")

    combos = Counter()
    combo_docs = defaultdict(int)
    for r in df.itertuples(index=False):
        if not (CM.NEED_INTENTS & set(r.intent_names)):
            continue
        attrs = sorted({CM.attr_label(a) for a in set(r.attrs) if CM.is_valid_attr(a)})
        for i in range(len(attrs)):
            for j in range(i + 1, len(attrs)):
                combos[(attrs[i], attrs[j])] += 1
    n_need = max(1, int(need.sum()))
    combo_rows = []
    ac = CM.attr_counts(df[need])
    for (a, b), c in combos.most_common(200):
        if c < 10:
            continue
        expected = (ac[a] / n_need) * (ac[b] / n_need) * n_need
        combo_rows.append({"a": a, "b": b, "n": c, "lift": round((c + 5) / (expected + 5), 2)})
    combo_rows.sort(key=lambda x: -x["lift"])
    metrics["OD18"] = CM.M("OD18", len(combo_rows), num=len(combos), den=n_need, n=n,
                           method="同一需求文档内的属性共现对")
    metrics["OD19"] = CM.M("OD19", combo_rows[0]["lift"] if combo_rows else None,
                           num=combo_rows[0]["n"] if combo_rows else None, den=None, n=n,
                           method="需求文档中的属性共现 lift，最少 10 篇且对观察/期望计数各加 5")
    charts["combos"] = combo_rows[:15]

    scen_need = Counter()
    for r in df.itertuples(index=False):
        if CM.NEED_INTENTS & set(r.intent_names):
            for s in set(r.scenarios):
                scen_need[s] += 1
    metrics["OD20"] = CM.M("OD20", len(scen_need), num=sum(scen_need.values()), den=n_need, n=n,
                           method="场景 × 需求交叉统计")

    # ---------- OD21-26 覆盖与跨社区 ----------
    if segs:
        metrics["OD21"] = CM.M("OD21", round(float(np.mean([s["brand_coverage"] for s in segs])), 4),
                               num=None, den=len(segs), n=n, method="需求簇中出现已知品牌的比例（簇均值）")
        metrics["OD22"] = CM.M("OD22", round(float(np.mean([1 - s["solution_gap"] for s in segs])), 4),
                               num=None, den=len(segs), n=n, method="明确解决方案覆盖率")
        sub = df[need & (df["brands"].map(len) > 0)]
        sd = CM.sent_distribution(sub)
        metrics["OD23"] = CM.M("OD23", sd["neg_rate"], num=sd["neg"], den=sd["definite"], n=len(sub),
                               method="已有方案（提及品牌）需求文档的负面率")
        metrics["OD25"] = CM.M("OD25", round(float(np.mean([s["communities"] for s in segs])), 2) if segs else None,
                               num=None, den=len(segs), n=n, method="需求簇覆盖社区数（均值）")
        metrics["OD26"] = CM.M("OD26", round(float(np.mean([s["communities"] / max(1, df["community"].nunique()) for s in segs])), 4) if segs else None,
                               num=None, den=len(segs), n=n, method="需求跨社区泛化度")
    else:
        for mid in ("OD21", "OD22", "OD23", "OD24", "OD25", "OD26"):
            metrics[mid] = CM.M(mid, None, num=None, den=0, n=n, method="需求簇不足")

    brand_hits = int(CM.known_brand_mask(df[need]).sum())
    metrics["OD21"] = CM.M("OD21", round(brand_hits / n_need, 4) if need.any() else None, num=brand_hits, den=int(need.sum()), n=n,
                           method="提及领域品牌的需求文档 / 有效需求文档")
    metrics["OD22"] = CM.solution_coverage("OD22", df[need])
    observed = df[need & df["solution_refs"].map(bool)]
    dissatisfaction = int(CM.state_mask(observed, "solution_dissatisfied", "partial_solution").sum())
    metrics["OD23"] = CM.M("OD23", round(dissatisfaction / len(observed), 4) if len(observed) else None,
                           num=dissatisfaction, den=len(observed), n=n, method="具备关联方案证据的需求文档中的明确不满率")
    price = df["prices"].map(lambda values: any(item["kind"] in {"预算", "上限", "可接受", "实付"} for item in values))
    price_docs = int((price & need).sum())
    metrics["OD24"] = CM.M("OD24", round(price_docs / n_need, 4) if need.any() else None, num=price_docs, den=int(need.sum()), n=n,
                           method="有效需求文档中的明确预算、接受价格及实付信号",
                           evidence_ref=df.loc[price & need, "doc_id"].head(10).tolist())

    # ---------- OD27-30 评分与证据 ----------
    graph = {"nodes": [], "links": []}
    if segs:
        vs = np.asarray([s["centroid"] for s in segs])
        sim = vs @ vs.T
        for i, s in enumerate(segs):
            graph["nodes"].append({"id": s["id"], "name": s["name"], "size": s["size"]})
            for j in range(i + 1, len(segs)):
                if sim[i, j] > 0.7:
                    graph["links"].append({"a": s["id"], "b": segs[j]["id"], "sim": round(float(sim[i, j]), 3)})
    metrics["OD27"] = CM.M("OD27", len(graph["links"]), num=len(graph["links"]), den=None, n=n,
                           method="需求簇中心向量相似度图（cos>0.7）")

    for s in segs:
        s["opportunity_score"] = SG.segment_score(s, max([x["size"] for x in segs], default=1), 1.0,
                                                  factor="need", all_segments=segs)
        s["whitespace"] = round(float(s["solution_gap"] * s["unmet_rate"] * min(1, s["thread_support"] / 20)), 4)
    ranked = sorted(segs, key=lambda x: -x["opportunity_score"])
    metrics["OD28"] = CM.M("OD28", ranked[0]["whitespace"] if ranked else None, num=None, den=n, n=n,
                           method="空白信号 = 方案未观测比例 × 明确未满足率 × 线程支持调节")
    metrics["OD29"] = CM.M("OD29", ranked[0]["opportunity_score"] if ranked else None, num=len(ranked),
                           den=len(segs), n=n, method="机会分 = 支持度/增长/未满足/方案缺口/持续性/跨社区 加权")
    metrics["OD30"] = CM.M("OD30", sum(min(5, len(s["examples"])) for s in ranked[:3]), num=None,
                           den=len(ranked[:3]) * 5 if ranked else 0, n=n,
                           method="每簇至少 5 条不同线程代表证据（不足时取全部）")

    charts["segments"] = ranked[:12]
    charts["segment_graph"] = graph
    charts["bubble"] = [{"name": s["name"], "size": s["size"], "unmet": s["unmet_rate"],
                         "growth": s["growth"] or 0, "gap": s["solution_gap"], "id": s["id"]} for s in ranked[:20]]
    charts["unmet_matrix"] = [{"name": s["name"], "unmet": s["unmet_rate"], "coverage": 1 - s["solution_gap"],
                               "size": s["size"]} for s in ranked[:20]]
    charts["workarounds"] = CM.ngram_phrases(df[wa]["norm"].tolist(), 10, 2) if wa.any() else []

    insights = []
    if ranked:
        t = ranked[0]
        insights.append(f"最值得探索：<b>{t['name']}</b>（机会分 {t['opportunity_score']}，{t['size']} 条片段，"
                        f"未满足率 {t['unmet_rate']:.0%}，方案覆盖 {1 - t['solution_gap']:.0%}）")
        ws = max(ranked, key=lambda x: x["whitespace"])
        insights.append(f"空白信号最强：<b>{ws['name']}</b>（品牌覆盖 {ws['brand_coverage']:.0%}，空白分 {ws['whitespace']}）")
    if combo_rows:
        c = combo_rows[0]
        insights.append(f"最强组合需求：<b>{c['a']} + {c['b']}</b>（lift {c['lift']}，{c['n']} 篇需求文档）")
    if wa_need:
        insights.append(f"明确提及变通方案的需求文档为 {wa_need} 篇（{metrics['OD17']['value']:.0%}）。")

    return {"module": "opportunity", "metrics": metrics, "charts": charts, "insight": insights,
            "params": {"weights": SG.SCORE_PROFILES["need"]}}

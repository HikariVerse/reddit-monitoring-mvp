"""Business integrations for controlled V4 estimators, structure and evidence."""

from collections import Counter, defaultdict
from itertools import combinations

import numpy as np
import pandas as pd

from . import common as C, evidence, quantitative as Q, semantics, stats, topics


COUNT_MEMBERSHIP = {
    "PR01": "all", "PR02": "need", "PR03": "need", "PR07": "negative", "PR11": "pain", "PR12": "feature",
    "PR17": "need_brand", "PR18": "solution", "PR19": "alternative", "PR24": "price_sensitive",
    "SL01": "dated", "SL07": "definite", "SL09": "negative", "SL27": "valid_author",
    "OD01": "need", "OD02": "pain", "OD03": "feature", "OD04": "unmet", "OD16": "workaround",
    "OD17": "need_workaround", "OD21": "need_brand", "OD22": "solution", "OD24": "need_price",
    "MI07": "brand",
}

BRAND_REQUIRED = {"PR08", "PR17", "PR26", "SR11", "OD21", "MI05", "MI06", "MI07", "MI08", "MI09", "MI10",
                  "MI11", "MI13", "MI16", "MI17", "MI18", "MI19", "MI20", "MI21", "MI22", "MI23", "MI25", "MI27", "MI29", "MI30"}
DATE_REQUIRED = {"PR04", "PR05", "PR06", "SL04", "SL05", "SL06", "SL10", "SL11", "SL15", "SL16", "SL17", "SL18",
                 "SL19", "SL20", "SL21", "SL22", "SL23", "SL28", "SL29", "SL30", "SR02", "SR03", "SR24", "SR25", "SR27",
                 "OD10", "OD11", "OD12", "OD13", "OD14", "OD15", "MI04", "MI08", "MI09", "MI11", "MI12", "MI30"}


def attach_membership(scope, metrics):
    df = scope.docs
    need = C.need_mask(df)
    brand = C.known_brand_mask(df)
    feature = C.state_mask(df, "feature_request") | df.intent_names.map(lambda values: "功能请求" in values).to_numpy(bool)
    workaround = C.state_mask(df, "workaround")
    membership_masks = {
        "all": np.ones(scope.n, bool), "need": need, "negative": C.neg_mask(df), "pain": C.pain_mask(df), "feature": feature,
        "need_brand": need & brand, "solution": need & df.solution_refs.map(bool).to_numpy(bool), "brand": brand,
        "alternative": df.intent_names.map(lambda x: "寻找替代品" in x).to_numpy(bool),
        "price_sensitive": df.intent_names.map(lambda x: bool({"价格比较", "预算询问"} & set(x))).to_numpy(bool) |
                           df.pains.map(lambda x: "价格贵" in x).to_numpy(bool),
        "definite": C.definite_sent_mask(df), "valid_author": df.author.ne("").to_numpy(bool), "dated": df.date.notna().to_numpy(bool),
        "unmet": C.unmet_mask(df), "workaround": workaround, "need_workaround": need & workaround,
        "need_price": need & df.prices.map(lambda rows: any(row["kind"] in {"预算", "上限", "可接受", "实付"} for row in rows)).to_numpy(bool),
    }
    for metric, predicate in COUNT_MEMBERSHIP.items():
        row = metrics.get(metric)
        if row is None or row.get("value") is None:
            continue
        ids = df.loc[membership_masks[predicate], "doc_id"].tolist()
        expected = row.get("numerator")
        if metric == "SL07":
            expected = row.get("value")
        if metric == "SL27":
            expected = None if int(df.loc[membership_masks[predicate], "score"].sum()) == row.get("numerator") else -1
        if expected is None or expected == len(ids):
            row["membership"] = evidence.membership(scope, ids, predicate)
            if not row.get("evidence_ref"):
                row["evidence_ref"] = ids[:12]


def need_units(scope):
    for row in scope.docs.loc[C.need_mask(scope.docs)].itertuples(index=False):
        anchors = [x["start"] for x in row.demand_states if x["state"] in {"explicit_need", "recommendation_request", "unmet_need", "partial_solution", "feature_request"}]
        if not anchors:
            continue
        for start, end, text in semantics.sentences(row.norm):
            if any(start <= p < end for p in anchors):
                terms = {"attr:" + C.attr_label(e["canonical"]) for e in row.entities
                         if e["t"] == "ATTRIBUTE" and start <= e["start"] < end and C.is_valid_attr(e["canonical"])}
                terms.update("scene:" + e["canonical"] for e in row.entities if e["t"] == "SCENARIO" and start <= e["start"] < end)
                yield row.doc_id, terms


def market_units(scope, purchase):
    for row in scope.docs.itertuples(index=False):
        for left, right, _ in semantics.sentences(row.norm):
            attributes = {"attr:" + C.attr_label(e["canonical"]) for e in row.entities
                          if e["t"] == "ATTRIBUTE" and left <= e["start"] < right and C.is_valid_attr(e["canonical"])}
            if purchase:
                bought = any(state["state"] == "purchased" and left <= state["start"] < right for state in row.demand_states)
                factors = {"purchased"} if bought else ({"purchase_relevant"} if purchase == "considered" and any(
                    state["state"] == "purchase_intent" and left <= state["start"] < right for state in row.demand_states) else set())
            else:
                factors = {"target:" + item["target"] for item in row.entities if item.get("target") and left <= item["start"] < right}
            yield row.doc_id, factors | attributes


def association_metrics(module, scope, results, charts):
    if module == "opportunity":
        output = Q.association(need_units(scope), accept=lambda a, b: a.startswith("attr:") or b.startswith("attr:"))
        rows = output["rows"]
        attrs = [r for r in rows if r["a"].startswith("attr:") and r["b"].startswith("attr:")]
        mixed = [r for r in rows if r["a"].startswith("attr:") != r["b"].startswith("attr:")]
        for mid, data, value in (("OD18", attrs, len(attrs)), ("OD19", attrs, attrs[0]["lift"] if attrs else None), ("OD20", mixed, len(mixed))):
            results[mid] = C.M(mid, value if output["tests"] else None, den=output["units"], n=scope.n,
                               data={**output, "rows": data}, method="同需求句 FP-Growth 候选、Fisher 检验、BH-FDR 和平滑区间")
        charts["within_need_associations"] = output
    else:
        for mid, purchase in (("MI17", False), ("MI26", True)):
            output = Q.association(market_units(scope, purchase), accept=lambda a, b: a.startswith("attr:") != b.startswith("attr:"))
            rows = output["rows"]
            for row in rows:
                row["npmi"] = stats.npmi(row["co"], row["a_count"], row["b_count"], row["units"])
            measure = "lift" if purchase else "npmi"
            results[mid] = C.M(mid, rows[0][measure] if rows else None, den=output["units"], n=scope.n,
                               data=output, method="同句目标/属性交易单元 FP-Growth、Fisher 检验与 BH-FDR")
            charts["within_sentence_purchase" if purchase else "within_target_associations"] = output


def score_rank(items, weights, *, minimum_support=5):
    supported = [row for row in items if row["support"] >= minimum_support and all(row.get(key) is not None for key in weights)]
    if len(supported) < 2:
        return []
    order = list(weights)
    vals = np.array([[row[key] for key in order] for row in supported])
    from scipy.stats import rankdata, spearmanr

    normalized = (rankdata(vals, axis=0) - 1) / (len(supported) - 1)
    values = np.array([weights[key] for key in order])
    total = normalized @ values
    variants = np.array([normalized @ ((values * factor) / (values * factor).sum())
                         for i in range(len(order)) for factor in (1 + .2 * np.eye(len(order))[i], 1 - .2 * np.eye(len(order))[i])])
    correlations = [{"a": order[i], "b": order[j], "spearman": float(spearmanr(vals[:, i], vals[:, j]).statistic)}
                    for i, j in combinations(range(len(order)), 2)
                    if len(supported) > 2 and np.ptp(vals[:, i]) and np.ptp(vals[:, j])]
    for i, row in enumerate(supported):
        row.update(score=round(100 * float(total[i]), 2), weights=weights,
                   factors={key: {"value": float(vals[i, j]), "percentile": float(normalized[i, j])} for j, key in enumerate(order)},
                   sensitivity=[round(100 * float(variants[:, i].min()), 2), round(100 * float(variants[:, i].max()), 2)],
                   candidate_count=len(supported), factor_correlations=correlations)
    return sorted(supported, key=lambda row: (-row["score"], -row["support"], row["name"]))


def product_candidates(scope):
    groups = defaultdict(dict)
    for row in scope.docs.itertuples(index=False):
        for item in row.entities:
            if item["t"] in {"PRODUCT", "SERIES", "MODEL", "BRAND"} and item.get("target"):
                groups[(item["entity_id"], item["canonical"])][row.doc_id] = row
    rows = []
    for (identity, name), members in groups.items():
        docs = list(members.values())
        definite = [row.sent_label for row in docs if row.sent_label in {"正面", "负面"}]
        threads = len({row.thread_id for row in docs})
        if threads < 5 or len(definite) < 4:
            continue
        positive = definite.count("正面")
        rows.append({"id": identity, "name": name, "title": name, "support": threads, "size": len(docs),
                     "recommendation": sum(any(x["state"] == "solution_recommended" for x in row.demand_states) for row in docs) / len(docs),
                     "favorability": positive / len(definite), "community_breadth": len({row.community for row in docs if row.community}),
                     "evidence_ref": sorted(members)[:12], "member_ids": sorted(members)})
    return score_rank(rows, {"support": .28, "recommendation": .26, "favorability": .30, "community_breadth": .16})


def reported_relations(scope, results, charts, module):
    kinds = {"PR20": "替换/切换", "PR21": "替换/切换"} if module == "product" else {
        "MI14": "比较", "MI15": "替代方案", "MI29": "替换/切换"}
    rows = [{**rel, "doc_id": row.doc_id} for row in scope.docs.itertuples(index=False) for rel in row.relations]
    charts["directed_relations"] = rows[:150]
    for mid, kind in kinds.items():
        selected = [row for row in rows if row["type"] == kind and row["state"] != "negated" and
                    (kind != "替换/切换" or row["state"] == "reported") and (mid != "PR21" or row["reason"])]
        links = defaultdict(list)
        for row in selected:
            links[(row["source"]["canonical"], row["target"]["canonical"])].append(row)
        edges = [{"from": a, "to": b, "n": len(group), "evidence_ref": sorted({r["doc_id"] for r in group}),
                  "examples": group[:3]} for (a, b), group in sorted(links.items(), key=lambda x: (-len(x[1]), x[0]))[:20]]
        method = "同句类型化实体关系，区分已发生、计划和否定"
        results[mid] = C.M(mid, len(selected) if selected else None, num=len(selected), den=scope.n, n=scope.n, method=method,
                           data=edges, evidence_ref=list(dict.fromkeys(row["doc_id"] for row in selected))[:12],
                           reason="无同时满足方向、状态和端点条件的原文" if not selected else "")
        if mid in {"PR20", "MI29"}:
            charts["migration" if mid == "PR20" else "switches"] = edges


def enhance(module, scope, encoder, out):
    results, charts = out["metrics"], out["charts"]
    df = scope.docs
    dated = df.dropna(subset=["date"])
    n = scope.n
    if module in {"product", "opportunity", "listening"} and len(dated):
        if module == "listening":
            daily = scope.meta.get("archive_daily", ())
            archived = pd.DataFrame(daily)
            if len(archived):
                exposure = archived.groupby("date")["count"].sum()
                observed = pd.Series({row["date"]: row["count"] for row in scope.meta["retrieval_counts"]["by_day"]}, dtype=float)
                temporal = Q.temporal(observed.reindex(exposure.index, fill_value=0), exposure, "admitted_threads")
            else:
                temporal = Q.temporal(pd.Series(dtype=float), pd.Series(dtype=float), "admitted_threads")
            charts["archive_exposure_model"] = temporal
        else:
            exposure = dated.groupby("date").size()
            observed = dated.loc[C.need_mask(dated)].groupby("date").size().reindex(exposure.index, fill_value=0)
            temporal = scope.cache.get("need_temporal")
            if temporal is None:
                temporal = scope.cache["need_temporal"] = Q.temporal(observed, exposure, "eligible_documents")
            charts["need_exposure_model"] = temporal
            if module == "product":
                slope = temporal["slope"]
                results["PR05"] = C.M("PR05", slope["per_week"] if slope else None, n=n, den=temporal["weeks"],
                                      method="按日有效文档暴露量计算周占比，SciPy Theil–Sen", unit="share/week", data=temporal)
    if module in {"market", "opportunity"}:
        association_metrics(module, scope, results, charts)
    if module in {"product", "market"}:
        reported_relations(scope, results, charts, module)
    if module == "product":
        importance = Q.association(market_units(scope, "considered"), accept=lambda a, b: a.startswith("attr:") != b.startswith("attr:"))
        factors = importance["rows"]
        results["PR10"] = C.M("PR10", factors[0]["lift"] if factors else None, den=importance["units"], n=n,
                              method="同句属性与实付/考虑购买信号 FP-Growth、Fisher 检验和 BH-FDR", data=importance)
        candidates = product_candidates(scope)
        charts["product_ranking"] = [{**row, "product_score": row["score"], "growth": None, "unmet_rate": None, "brand_coverage": None}
                                     for row in candidates[:20]]
        for mid, value in (("PR28", candidates[0]["score"] if candidates else None), ("PR29", len(candidates) if candidates else None)):
            results[mid] = C.M(mid, value, den=len(candidates), n=n, method="候选产品相对分位，支持、实述推荐、明确好评和社区覆盖",
                               data=charts["product_ranking"])
    if module == "opportunity":
        candidates = []
        for segment in charts.get("segments", ()):
            candidates.append({**segment, "support": segment["thread_support"], "explicit_unmet": segment["unmet_rate"],
                               "breadth": segment["communities"], "historical_novelty": segment["novelty"]})
        ranks = score_rank(candidates, {"support": .28, "explicit_unmet": .45, "breadth": .27})
        rows = [{**row, "opportunity_score": row["score"]} for row in ranks]
        if rows:
            charts["segments"] = rows[:12]
        results["OD29"] = C.M("OD29", rows[0]["score"] if rows else None, den=len(rows), n=n, data=rows[:12],
                              method="需求簇相对分位，独立线程支持、明确未满足率、社区覆盖")
        best_gap = sorted((row for row in candidates if row["explicit_unmet"] > 0 and row["support"] >= 5),
                          key=lambda row: (-row["whitespace"], -row["support"]))
        results["OD28"] = C.M("OD28", best_gap[0]["whitespace"] if best_gap else None, den=len(best_gap), n=n,
                              method="明确未满足 × 方案未观测比例 × 支持度调整，独立空白信号", data=best_gap[:12])
        packs = [{"id": row["id"], "name": row["name"], "evidence_ref": row["evidence_ref"], "examples": row["examples"],
                  "members": evidence.membership(scope, row["member_ids"], f"need_cluster_{row['id']}")}
                 for row in candidates if row["evidence_ref"]]
        results["OD30"] = C.M("OD30", len(packs) if packs else None, num=len(packs), den=len(candidates), n=n,
                              unit="clusters", method="每个需求簇独立来源片段与完整成员清单", data=packs)
    if module == "social":
        from .networks import multilayer
        groups, labels = topics.discover(scope)
        active = df.assign(topic_id=labels)
        grouped = []
        for community, sub in active.groupby("community"):
            if len(sub) < 5 or not community:
                continue
            rows = []
            for term in groups:
                members = sub.loc[sub.topic_id == term["id"], "doc_id"].tolist()
                if len(members) < 2:
                    continue
                share = len(members) / len(sub)
                rows.append({"topic": term["name"], "topic_id": term["id"], "n": len(members), "share": share,
                             "overrepresentation": share / term["share"], "evidence_ref": members[:12]})
            if rows:
                grouped.append({"community": community, "topics": sorted(rows, key=lambda row: -row["overrepresentation"]), "documents": len(sub)})
        grouped.sort(key=lambda row: -row["documents"])
        charts["shared_topics"] = grouped[:25]
        results["SR08"] = C.M("SR08", len(groups) if grouped else None, den=len(grouped), n=n,
                              method="共享主题模型社区分布及相对过度表达", data=charts["shared_topics"])
        charts["network_layers"] = multilayer(scope, labels)
        layers = charts["network_layers"]["layers"]
        layer = layers.get("centered_semantic")
        results["SR23"] = C.M("SR23", layer["groups"] if layer and layer["links"] else None,
                              den=len(layer["nodes"]) if layer else 0, n=n, data=charts["network_layers"],
                              method="NetworkX 四层互近邻图和 Louvain 聚类，圈层值基于中心化语义层")
    if module == "market":
        subjects = scope.discovery.get("typed_entities", ())
        hierarchy = [r for r in subjects if r["kind"] in {"category", "subcategory"}]
        if hierarchy:
            results["MI01"] = C.M("MI01", len({row["entity_id"] for row in hierarchy}), n=n,
                                  method="公开分类与当前核心文档共同验证", data=hierarchy)
            structural = [r for r in hierarchy if r["parent"]]
            results["MI02"] = C.M("MI02", len({row["entity_id"] for row in structural}) if structural else None, n=n,
                                  method="公开分类父子边及核心证据", data=structural)
    if module == "listening":
        events = charts.get("events", [])
        for mid in {"SL15", "SL16", "SL17", "SL18", "SL19", "SL20", "SL21", "SL22", "SL23", "SL28", "SL29", "SL30"}:
            if mid in results and results[mid].get("value") is not None and events:
                selected = events if mid in {"SL15", "SL29"} else events[:1]
                results[mid].update(data=selected, evidence_ref=selected[0]["evidence_ref"])
    attach_membership(scope, results)

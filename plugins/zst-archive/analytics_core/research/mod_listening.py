"""业务模块二：舆情分析（SL01–SL30）。

历史归档下的"事件发现"流程：
日声量 → 滚动基线（7 日 EWMA/中位数）→ 稳健 z / MAD → 连续超阈值合并为异常窗口
→ 窗口内文档语义聚类拆分为独立事件 → 生命周期 / 传播 / 归因 / 风险排序。
"""

from __future__ import annotations

from collections import Counter, defaultdict

import numpy as np
import pandas as pd

from . import common as CM
from . import stats as ST, topics
from .populations import archive_attention


def _event_clusters(docs: pd.DataFrame, scope, encoder, k: int = 4) -> list[dict]:
    """把异常窗口内的文档聚类成事件。"""
    if len(docs) < 4:
        return []
    idx = scope.docs.index[scope.docs["doc_id"].isin(docs["doc_id"])].tolist()
    vecs = scope.unit_emb[idx]
    labels, names, info = topics.cluster_passages(vecs, docs.norm.tolist(), k=k, enhanced=scope.meta.get("nlp_profile") != "fast")
    out = []
    for c in sorted(set(labels) - {-1}):
        sel = [i for i, lab in zip(idx, labels) if lab == c]
        if len(sel) < 3:
            continue
        sub = scope.docs.loc[sel]
        terms = names.get(c) or CM.top_terms(sub["norm"].tolist(), 10)
        label = " / ".join(term["term"] for term in terms[:3])
        brands = Counter(b for lst in sub["brands"] for b in lst)
        attrs = Counter(a for lst in sub["attrs"] for a in lst)
        out.append({
            "cluster": int(c), "docs": sub, "size": int(len(sub)),
            "terms": terms,
            "brands": [{"brand": CM.brand_label(b), "n": v} for b, v in brands.most_common(5)],
            "attributes": [{"attribute": a, "n": v} for a, v in attrs.most_common(5)],
            "summary": label,
            "evidence_ref": sub.doc_id.head(8).tolist(), "member_ids": sub.doc_id.tolist(), "quality": info,
        })
    return out


def _risk(peak_z: float, neg_rate: float, breadth: int, days: int, max_z: float) -> float:
    score = (0.35 * min(1.0, peak_z / max(1e-9, max_z)) + 0.30 * (neg_rate or 0)
             + 0.20 * min(1.0, breadth / 20) + 0.15 * min(1.0, days / 10))
    return round(float(score * 100), 1)


def compute(scope, encoder=None) -> dict:
    df = scope.docs
    n = len(df)
    metrics: dict[str, dict] = {}
    charts: dict[str, object] = {}

    daily = CM.daily_counts(df)
    dates = [str(d) for d in daily.index]
    vol = daily.values.astype(float)

    # ---------- SL01-06 声量与异常 ----------
    metrics["SL01"] = CM.M("SL01", int(vol.sum()), num=int(vol.sum()), den=None, n=n,
                           method="日粒度内容计数", unit="docs",
                           note=f"{dates[0]} ~ {dates[-1]}" if dates else "")
    metrics["SL02"] = archive_attention(scope, "SL02", 1)

    metrics["SL03"] = CM.M("SL03", int(df["author"].nunique()), num=int(df["author"].nunique()),
                           den=int(df["thread_id"].nunique()), n=n,
                           method="独立作者数 / 独立线程数")

    # 先去线性趋势：三个月语料整体在增长，直接对原序列做 z 会把"正常增长"误判为异常
    z = ST.rolling_zscore(vol, window=21, min_period=7)
    z_use = z
    mad = ST.mad_anomaly(vol, window=30, k=3.5)
    ma7 = ST.moving_average(vol, 7)
    ew = ST.ewma(vol, 0.3)
    metrics["SL04"] = CM.M("SL04", round(float(z_use.max()), 2) if len(z) >= 8 else None, num=int((z_use >= 2.0).sum()), den=len(z), n=len(vol),
                           method="滚动 30 日历史基线 z-score（不含当前点）",
                           note=f"MAD 法检出 {int((np.abs(mad) >= 3.5).sum())} 个异常点")
    d1 = np.diff(vol, prepend=vol[0]) if len(vol) else vol
    metrics["SL05"] = CM.M("SL05", round(float(d1.max()), 1) if len(d1) >= 2 else None, num=int(d1.max()) if len(d1) else None,
                           den=int(vol.mean()) if len(vol) and vol.mean() else None,
                           n=len(vol), method="一阶差分峰值 / 日均量")
    metrics["SL06"] = CM.M("SL06", round(float(np.diff(d1).max()), 1) if len(d1) >= 3 else None, num=None, den=None, n=len(vol),
                           method="声量加速度（二阶差分峰值）")

    charts["volume"] = [{"date": d, "volume": int(v), "ma7": round(float(m), 1), "ewma": round(float(e), 1),
                         "z": round(float(zz), 2)} for d, v, m, e, zz in zip(dates, vol, ma7, ew, z)]

    # ---------- SL07-13 情感 ----------
    sd = CM.sent_distribution(df)
    daily_sent = []
    for d, g in df.groupby("date"):
        c = Counter(g["sent_label"])
        definite = c["正面"] + c["负面"]
        daily_sent.append({
            "date": str(d), "pos": c["正面"], "neg": c["负面"], "neu": c["中性"], "mixed": c["混合"],
            "net": round((c["正面"] - c["负面"]) / definite, 3) if definite else None,
            "neg_rate": round(c["负面"] / definite, 3) if definite else None,
        })
    charts["sentiment_daily"] = daily_sent
    metrics["SL07"] = CM.M("SL07", sd["definite"], num=sd["pos"], den=sd["definite"], n=n,
                           method="实体级情感汇总", note=f"正面 {sd['pos']} / 负面 {sd['neg']} / 中性 {sd['neu']} / 未知 {sd['unknown']}")
    metrics["SL08"] = CM.M("SL08", sd["net"], num=sd["pos"] - sd["neg"], den=sd["definite"], n=n,
                           method="(正面-负面)/(正面+负面)")
    metrics["SL09"] = CM.M("SL09", sd["neg_rate"], num=sd["neg"], den=sd["definite"], n=n,
                           method="负面 / 明确正负评价",
                           evidence_ref=df.loc[df["sent_label"].eq("负面"), "doc_id"].head(10).tolist())
    stamps = pd.to_datetime(df["date"])
    cutoff = stamps.min() + (stamps.max() - stamps.min()) / 2
    first_half = df[stamps <= cutoff]
    second_half = df[stamps > cutoff]
    s1, s2 = CM.sent_distribution(first_half), CM.sent_distribution(second_half)
    metrics["SL10"] = CM.M("SL10", ST.growth_rate(s2["neg"], s1["neg"]), num=s2["neg"], den=s1["neg"], n=n,
                           method="后半段负面数 / 前半段负面数 - 1")
    prev, current = s1["neg_rate"], s2["neg_rate"]
    metrics["SL11"] = CM.M("SL11", round(current - prev, 4) if current is not None and prev is not None else None,
                           n=n, method="负面率变化（后半-前半）", formula_inputs={"current": current, "previous": prev})
    metrics["SL12"] = CM.M("SL12", round(float(df["sent_score"].abs().mean()), 4), num=float(df["sent_score"].abs().sum()),
                           den=n, n=n,
                           method="情感强度 = |极性分| 均值")
    pos_n, neg_n = sd["pos"], sd["neg"]
    metrics["SL13"] = CM.M("SL13", round(1 - abs(pos_n - neg_n) / (pos_n + neg_n), 4) if pos_n + neg_n else None,
                           num=abs(pos_n - neg_n), den=pos_n + neg_n, n=n, method="争议均衡度 1-|pos-neg|/(pos+neg)")

    # ---------- SL14 负面驱动 ----------
    af = CM.aspect_frame(scope)
    drivers = []
    if len(af):
        negs = af[(af["sentiment"] == "负面") & (af["attribute"] != "整体")]
        for attr, g in negs.groupby("attribute"):
            if len(g) < 2:
                continue
            drivers.append({"attribute": attr, "neg": int(len(g)),
                            "share": round(len(g) / max(1, len(negs)), 4),
                            "evidence_ref": g.doc_id.drop_duplicates().head(12).tolist(),
                            "brands": [{"brand": CM.brand_label(b), "n": int(c)} for b, c in
                                       Counter(g.loc[g.brand.ne(""), "brand"]).most_common(3)]})
        drivers.sort(key=lambda x: -x["neg"])
    metrics["SL14"] = CM.M("SL14", len(drivers) if drivers else None, num=len(drivers), den=int(len(af)), n=n,
                           method="归因至属性的负面观点聚合", note="、".join(d["attribute"] for d in drivers[:5]))
    charts["neg_drivers"] = drivers[:12]

    # ---------- SL15-21 事件发现 ----------
    events_raw = ST.anomaly_events(vol, dates, z_use, threshold=float(2.0), min_count=3)
    events_raw = sorted(events_raw, key=lambda e: -e["sum"])[:6]
    max_z = max([e["max_z"] for e in events_raw], default=3.0)
    events = []
    for ev in events_raw:
        win = df[(df["date"].astype(str) >= ev["start"]) & (df["date"].astype(str) <= ev["end"])]
        if len(win) < 3:
            continue
        clusters = _event_clusters(win, scope, encoder, k=min(3, max(2, len(win) // 40))) if encoder else []
        subs = [{"name": c["summary"], "size": c["size"],
                 "terms": [t["term"] for t in c["terms"][:6]],
                 "brands": c["brands"][:3], "attributes": c["attributes"][:3],
                 "evidence_ref": c["evidence_ref"], "member_ids": c["member_ids"], "quality": c["quality"]} for c in clusters[:3]]
        sd_sub = CM.sent_distribution(win)
        first_row = win.sort_values("created_utc").iloc[0]
        comm_days = win.groupby("community")["date"].min().sort_values()
        breadth = int(win["community"].nunique())
        main = max(subs, key=lambda x: x["size"]) if subs else {"name": "", "terms": [], "brands": [], "attributes": []}
        events.append({
            "id": f"{ev['peak_date']}",
            "start": ev["start"], "end": ev["end"], "peak_date": ev["peak_date"],
            "peak_volume": ev["peak_value"], "max_z": ev["max_z"],
            "size": int(len(win)), "terms": main["terms"], "brands": main["brands"],
            "attributes": main["attributes"], "summary": main["name"],
            "subclusters": subs,
            "neg_rate": sd_sub["neg_rate"], "net": sd_sub["net"],
            "authors": int(win["author"].nunique()), "threads": int(win["thread_id"].nunique()),
            "communities": breadth,
            "first_community": first_row["community"],
            "first_time": str(pd.to_datetime(first_row["created_utc"], unit="s")),
            "propagation": [{"community": k, "first_seen": str(v)} for k, v in list(comm_days.items())[:10]],
            "template_ratio": round(float(1 - win["chash"].nunique() / max(1, len(win))), 4) if "chash" in win else 0.0,
            "influence": int(win["score"].clip(lower=0).sum()),
            "risk": _risk(ev["max_z"], sd_sub["neg_rate"], breadth, ev["days"], max_z) if sd_sub["definite"] >= 5 else None,
            "risk_factors": {"anomaly": {"value": ev["max_z"], "weight": .35}, "negative": {"value": sd_sub["neg_rate"], "weight": .30,
                                                                                          "support": sd_sub["definite"]},
                             "breadth": {"value": breadth, "weight": .20}, "duration": {"value": ev["days"], "weight": .15}},
            "days": ev["days"],
            "evidence_ref": win["doc_id"].tolist()[:12], "member_ids": win.doc_id.tolist(),
        })
    events.sort(key=lambda e: (e["risk"] is None, -(e["risk"] or 0)))
    metrics["SL15"] = CM.M("SL15", len(events), num=len(events), den=len(events_raw), n=n,
                           method="异常窗口 + 窗口内语义聚类拆分事件",
                           note=f"仅使用当日前数据建滚动基线，z≥2.0 且最小 3 条/日。共 {len(events_raw)} 个窗口")
    metrics["SL16"] = CM.M("SL16", events[0]["size"] if events else None,
                           num=events[0]["size"] if events else None, den=n, n=n,
                           method="最大事件簇文档数")
    metrics["SL17"] = CM.M("SL17", events[0]["days"] if events else None, num=None, den=None, n=n,
                           method="事件生命周期：起-增-峰-衰，(start,end) 区间天数")
    metrics["SL18"] = CM.M("SL18", events[0]["days"] if events else None, num=None, den=None, n=n,
                           method="事件持续时间（连续活跃区间）")
    metrics["SL19"] = CM.M("SL19", events[0]["first_time"] if events else None, num=None, den=None, n=n,
                           method="事件最早观测时间")
    metrics["SL20"] = CM.M("SL20", events[0]["first_community"] if events else None, num=None, den=None, n=n,
                           method="事件最早出现社区")
    metrics["SL21"] = CM.M("SL21", events[0]["communities"] if events else None,
                           num=events[0]["communities"] if events else None, den=None, n=n,
                           method="事件涉及的独立社区数", unit="communities",
                           data={"authors": events[0]["authors"]} if events else None)
    charts["events"] = [{k: v for k, v in e.items() if k != "doc_ids"} for e in events]

    # ---------- SL22-25 传播与集中度 ----------
    metrics["SL22"] = CM.M("SL22", round(events[0]["communities"] / max(1, events[0]["days"]), 3) if events else None,
                           num=events[0]["communities"] if events else None, den=events[0]["days"] if events else None,
                           n=n, method="新增社区数 / 事件持续天数")
    metrics["SL23"] = CM.M("SL23", len(events[0]["propagation"]) if events else None, num=None, den=None, n=n,
                           method="社区传播路径（按首次出现时间排序，代理传播顺序）")
    comm_att = []
    for c, g in df.groupby("community"):
        if len(g) < 20:
            continue
        s = CM.sent_distribution(g)
        comm_att.append({"community": c, "docs": int(len(g)), "neg_rate": s["neg_rate"], "net": s["net"]})
    comm_att.sort(key=lambda x: -(x["neg_rate"] or 0))
    charts["community_attitude"] = comm_att[:12]
    metrics["SL24"] = CM.M("SL24", round(float(np.std([c["neg_rate"] or 0 for c in comm_att])), 4) if comm_att else None,
                           num=None, den=len(comm_att), n=n, method="社区负面率标准差（社区态度差异）")
    authors = df["author"].value_counts()
    metrics["SL25"] = CM.M("SL25", ST.hhi(list(authors.values[:200])), num=int(authors.head(10).sum()), den=n, n=n,
                           method="作者/社区 HHI 与 Top10 集中度")

    # ---------- SL26-30 ----------
    dup = scope.meta.get("dedupe", {})
    raw_count = dup.get("raw", 0)
    removed = dup.get("exact_dup", 0) + dup.get("near_dup", 0)
    metrics["SL26"] = CM.M("SL26", round(removed / raw_count, 4) if raw_count else None,
                           num=removed, den=raw_count, n=raw_count, method="去重移除数 / 核心候选数", data=dup)
    scored = df[df["author"].ne("")]
    scores, authors = int(scored["score"].sum()), int(scored["author"].nunique())
    metrics["SL27"] = CM.M("SL27", round(scores / authors, 4) if authors else None, num=scores,
                           den=authors, n=n, method="已知作者文档净得分之和 / 独立作者数", unit="score/author")
    metrics["SL28"] = CM.M("SL28", events[0]["risk"] if events else None, num=events[0]["risk"] if events else None,
                           den=100, n=n, method="风险评分 = 0.35×异常强度 + 0.30×负面率 + 0.20×广度 + 0.15×持续")
    metrics["SL29"] = CM.M("SL29", len(events), num=len(events), den=None, n=n, method="按风险分排序的事件数")
    metrics["SL30"] = CM.M("SL30", len(events[0]["terms"]) if events else None, num=None, den=None, n=n,
                           method="事件自动摘要 = 代表词 + 实体 + 属性 + 代表原文")
    charts["risk_matrix"] = [{"id": e["id"], "risk": e["risk"], "neg_rate": e["neg_rate"] or 0,
                              "breadth": e["communities"], "size": e["size"]} for e in events]

    insights = []
    if events:
        e0 = events[0]
        insights.append(f"风险最高事件 <b>{e0['peak_date']}</b>：声量峰值 {e0['peak_volume']}（z={e0['max_z']}），"
                        f"负面率 {(e0['neg_rate'] or 0):.0%}，首现社区 r/{e0['first_community']}，"
                        f"扩散 {e0['communities']} 个社区。关键词：{'、'.join(e0['terms'][:5])}")
    if drivers:
        insights.append(f"负面驱动首位：<b>{drivers[0]['attribute']}</b>（{drivers[0]['neg']} 条负面三元组）")
    insights.append(f"整体净情感 <b>{sd['net'] if sd['net'] is not None else 'N/A'}</b>，"
                    f"争议均衡度 {metrics['SL13']['value']}（1=势均力敌）。")

    return {"module": "listening", "metrics": metrics, "charts": charts, "insight": insights}

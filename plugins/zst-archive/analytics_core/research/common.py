"""五大模块共用的数据帧与指标计算工具。

约定：
* 所有比例指标必须给出 numerator / denominator；
* 所有结果带 sample_size、method、scope_id；
* 分母为零返回 None + reason，不返回 0（避免"看起来有值其实没数据"）。
"""

from __future__ import annotations

import re
from collections import Counter

import numpy as np
import pandas as pd

from . import lexicon as L
from . import stats as ST

# 非产品属性的"话题词"：食品/场景/泛化名词，避免污染属性情感与市场矩阵
TOPIC_BLOCK = set("""food chicken meal cheese recipe cooking fries oil butter egg meat bread kitchen
air fryer fryer basket tray liner parchment temperature cook time minutes
reddit god adhd continue generator people thing things way lot bit stuff
anyone someone everyone somebody nobody something anything nothing
money price deal sale amazon store shipping delivery order
easy hard good bad great best worst nice cool idea reason thing stuff way lot bit time
""".split())

# 商品属性的规范名（用于"品牌必须与产品属性同现"的过滤）
ATTR_CANON = dict(L.ATTR_TERMS)
PRODUCT_CANON = {c for c in L.ATTRIBUTES if c != "价格"}

NEED_INTENTS = {"求推荐", "寻找解决方案", "寻找替代品", "功能请求", "组合需求"}
CONSIDER_INTENTS = {"产品比较", "品牌比较", "价格比较", "购买计划", "预算询问"}
PURCHASE_INTENTS = {"已购买", "下单订购"}
POST_INTENTS = {"产品体验", "满意称赞", "推荐他人", "抱怨投诉", "产品故障", "退货退款", "弃用"}
MIGRATE_INTENTS = {"切换产品", "切换品牌"}
NEG_LABELS = {"负面"}
POS_LABELS = {"正面"}

RE_URL = re.compile(r"https?://([^\s/]+)", re.I)
RE_EMOJI = re.compile("[\U0001F300-\U0001FAFF\U00002600-\U000027BF]")


def M(mid, value, num=None, den=None, n=None, method="", note="", unit="", **extra):
    """统一指标结构。"""
    reason = extra.pop("reason", "")
    missing = value is None or den == 0
    return {
        "metric_id": mid, "value": None if missing else value, "numerator": num, "denominator": den,
        "sample_size": n if n is not None else (den if den is not None else 0),
        "method": method, "status": "empty" if missing else "ok",
        "reason": reason or ("样本或结果不足" if missing else ""), "note": note, "unit": unit, **extra,
    }


# --------------------------------------------------------------------------- #
# 基础帧
# --------------------------------------------------------------------------- #
def is_valid_attr(a: str) -> bool:
    """业务指标只使用受控属性词表（ATTR_TERMS），自动发现仅用于扩展词表。"""
    return a in L.ATTR_TERMS and a not in TOPIC_BLOCK


def attr_label(a: str) -> str:
    return L.ATTR_TERMS.get(a, a)


def attr_surfaces(canon: str) -> list[str]:
    return [s for s, c in L.ATTR_TERMS.items() if c == canon]


def attr_surface_mask(df: pd.DataFrame, canon: str) -> np.ndarray:
    surfaces = set(attr_surfaces(canon))
    return df["attrs"].map(lambda xs: bool(surfaces & set(xs))).values


def _has_product_attr(attrs) -> bool:
    return any(is_valid_attr(a) and ATTR_CANON.get(a) != "价格" for a in attrs)


def brand_counts(df: pd.DataFrame, known_only: bool = True) -> Counter:
    """品牌计数：仅内置品牌表 + 该文档必须同时出现"产品属性"。

    这条约束用于排除跨域歧义（Apple 是水果、Drop 是动词、Surface 是普通名词）。
    """
    c: Counter = Counter()
    for brands in df["brands"]:
        c.update(set(brands))
    return c


def attr_counts(df: pd.DataFrame, valid_only: bool = True) -> Counter:
    """按**规范属性名**（中文）计数，便于跨语料比较。"""
    c: Counter = Counter()
    for attrs in df["attrs"].values:
        c.update({attr_label(a) for a in attrs if not valid_only or is_valid_attr(a)})
    return c


def scenario_counts(df: pd.DataFrame) -> Counter:
    c: Counter = Counter()
    for s in df["scenarios"].values:
        for a in set(s):
            c[a] += 1
    return c


def brand_label(canon: str) -> str:
    for b in L.ALL_BRANDS:
        if b == canon:
            return b.title() if len(b) > 3 else b.upper()
    return canon.title()


def aspect_frame(scope) -> pd.DataFrame:
    rows = []
    df = scope.docs
    for r in df.itertuples(index=False):
        if not _has_product_attr(r.attrs):
            continue
        for t in r.aspects:
            if not is_valid_attr(str(t.get("attribute_canon") or t.get("attribute") or "")):
                continue
            rows.append({
                "doc_id": r.doc_id, "date": r.date, "month": r.month, "community": r.community,
                "brand": t.get("canon") if t.get("canon") in r.brands else "",
                "entity": t.get("entity"),
                "attribute": attr_label(str(t.get("attribute_canon") or t.get("attribute") or "")),
                "sentiment": t.get("sentiment"), "score": float(t.get("score", 0)),
                "context": t.get("context", ""), "evidence": t,
            })
    return pd.DataFrame(rows)


def price_frame(scope) -> pd.DataFrame:
    rows = []
    for r in scope.docs.itertuples(index=False):
        for p in r.prices:
            rows.append({
                "doc_id": r.doc_id, "date": r.date, "month": r.month, "community": r.community,
                "value": float(p.get("value", 0)), "currency": p.get("currency", "unspecified"),
                "kind": p.get("kind", "未分类"), "context": p.get("context", ""),
                "period": p.get("period", "unspecified"), "upper": p.get("upper"), "evidence": p,
            })
    return pd.DataFrame(rows)


def comparable_prices(frame):
    """Select the most supported currency and billing period for scalar KPIs."""
    if frame.empty:
        return frame, ""
    frame = frame[~frame["currency"].str.startswith("unknown") & frame["currency"].ne("unspecified") & frame["upper"].isna()]
    if frame.empty:
        return frame, ""
    frequency = frame.groupby(["currency", "period"], sort=True).size()
    currency, period = frequency.idxmax()
    same = frame["currency"].eq(currency) & frame["period"].eq(period)
    return frame[same], currency if period == "unspecified" else f"{currency}/{period}"


def relation_endpoint(scope, text, types):
    hits = scope.dict.find(text.lower())
    matches = [hit for hit in hits if hit.type in types]
    if not matches:
        return None
    from .knowledge import from_hit, target_key
    item = from_hit(matches[0], {})
    return target_key(item) or item.canonical.casefold()


def daily_counts(df: pd.DataFrame, mask=None) -> pd.Series:
    if len(df) == 0:
        return pd.Series(dtype=int)
    d = (df if mask is None else df[mask]).dropna(subset=["date"])
    if len(d) == 0:
        return pd.Series(dtype=int)
    s = d.groupby("date").size()
    idx = pd.date_range(min(s.index), max(s.index), freq="D").date
    return s.reindex(idx, fill_value=0)


def monthly_counts(df: pd.DataFrame, mask=None) -> pd.Series:
    d = df if mask is None else df[mask]
    return d.groupby("month").size() if len(d) else pd.Series(dtype=int)


def known_brand_mask(df: pd.DataFrame) -> np.ndarray:
    """文档是否有经当前领域词典确认的品牌提及。"""
    return df["brands"].map(bool).to_numpy(dtype=bool)


def need_mask(df: pd.DataFrame) -> np.ndarray:
    from .demand import ACTIVE
    return df["intent_names"].map(lambda x: bool(NEED_INTENTS & set(x))).to_numpy(dtype=bool) | state_mask(df, *ACTIVE)


def pain_mask(df: pd.DataFrame) -> np.ndarray:
    return df["pains"].map(lambda x: len(x) > 0).values


def neg_mask(df: pd.DataFrame) -> np.ndarray:
    return df["sent_label"].isin(["负面"]).values


def definite_sent_mask(df: pd.DataFrame) -> np.ndarray:
    return df["sent_label"].isin(["正面", "负面"]).values


def unmet_mask(df: pd.DataFrame) -> np.ndarray:
    return state_mask(df, "unmet_need") & need_mask(df)


def state_mask(df, *states):
    wanted = set(states)
    return np.array([any(hit["state"] in wanted for hit in hits)
                     for hits in df.get("demand_states", [[] for _ in range(len(df))])], dtype=bool)


def solution_coverage(mid, df):
    mask = df["solution_refs"].map(bool) if "solution_refs" in df else pd.Series(False, index=df.index)
    num, den = int(mask.sum()), len(df)
    refs = list(dict.fromkeys(doc for row in df.loc[mask, "solution_refs"] for doc in row))[:12] if num else []
    return M(mid, round(num / den, 4) if den else None, num=num, den=den, n=den,
             method="具有关联方案原文的需求文档 / 有效需求文档", evidence_ref=refs,
             denominator_predicate="active_need")


RE_TOK = re.compile(r"[A-Za-z][A-Za-z'\-]{2,24}|[\u4e00-\u9fff]{2,8}")


def clean_tokens(text: str) -> list[str]:
    """统一取词：小写、去标点、去功能词与闲聊词、去所有格。"""
    out = []
    for w in RE_TOK.findall(str(text)):
        lw = w.lower().removesuffix("'s")
        if "'" in lw:
            continue
        if lw in L.FUNCTION_WORDS or lw in L.CHAT_WORDS or len(lw) < 3:
            continue
        if len(lw) < 3:
            continue
        out.append(lw)
    return out


def top_terms(texts, k: int = 20, min_len: int = 3) -> list[dict]:
    c: Counter = Counter()
    for t in texts:
        c.update(clean_tokens(t))
    return [{"term": w, "n": n} for w, n in c.most_common(k)]


def ngram_phrases(texts, k: int = 20, n: int = 2) -> list[dict]:
    c: Counter = Counter()
    for t in texts:
        toks = clean_tokens(t)
        for i in range(len(toks) - n + 1):
            c[" ".join(toks[i : i + n])] += 1
    return [{"phrase": p, "n": v} for p, v in c.most_common(k)]


def name_from_texts(texts: list[str], k: int = 3) -> str:
    """给簇/事件起名：优先领域短语，其次领域词，最后干净高频词。"""
    phrases = ngram_phrases(texts, 8, 2)
    good = [p for p in phrases
            if p["n"] >= max(3, int(len(texts) * 0.08))
            and all(len(w) > 2 and w not in L.FUNCTION_WORDS and w not in L.CHAT_WORDS for w in p["phrase"].split())]
    if good:
        return good[0]["phrase"]
    terms = [t["term"] for t in top_terms(texts, 20)
             if len(t["term"]) > 2 and t["term"] not in L.FUNCTION_WORDS
             and t["term"] not in L.CHAT_WORDS and "'" not in t["term"] and "’" not in t["term"]]
    domain = [t for t in terms if t in L.ATTR_TERMS or t in L.SCENARIO_TERMS
              or t in L.CATEGORY_TERMS or t in L.ALL_BRANDS]
    pick = (domain + [t for t in terms if t not in domain])[:k]
    return " / ".join(pick)


def label_share(counter: Counter, denom: int) -> list[dict]:
    return [{"label": k, "n": v, "pct": round(v / denom * 100, 2) if denom else 0} for k, v in counter.most_common()]


def sent_distribution(df: pd.DataFrame) -> dict:
    if len(df) == 0:
        return {"pos": 0, "neg": 0, "neu": 0, "mixed": 0, "unknown": 0, "definite": 0, "net": None, "neg_rate": None}
    c = Counter(df["sent_label"])
    definite = c["正面"] + c["负面"]
    return {
        "pos": c["正面"], "neg": c["负面"], "neu": c["中性"],
        "mixed": c["混合"], "unknown": c["未知"], "definite": definite,
        "net": round((c["正面"] - c["负面"]) / definite, 4) if definite else None,
        "neg_rate": round(c["负面"] / definite, 4) if definite else None,
    }


def url_domains(texts) -> Counter:
    c: Counter = Counter()
    for t in texts:
        for m in RE_URL.finditer(str(t)):
            c[m.group(1).lower().replace("www.", "")] += 1
    return c


def cluster_texts(vectors: np.ndarray, k: int = 8, method: str = "kmeans", seed: int = 42) -> tuple[np.ndarray, dict]:
    """聚类封装：kmeans / minibatch / hdbscan，返回标签与信息。"""
    from sklearn.cluster import HDBSCAN, KMeans, MiniBatchKMeans

    n = len(vectors)
    if n < 6:
        return np.zeros(n, dtype=int), {"method": method, "k": 1, "note": "样本过少，退化为单簇"}
    k = max(2, min(k, n // 4 or 2))
    if method == "hdbscan":
        lab = HDBSCAN(min_cluster_size=max(5, n // 40), metric="euclidean").fit_predict(vectors)
        return lab, {"method": "hdbscan", "k": int(len(set(lab)) - (1 if -1 in lab else 0)),
                     "outlier_ratio": round(float((lab == -1).mean()), 4)}
    if method == "minibatch":
        km = MiniBatchKMeans(n_clusters=k, random_state=seed, n_init=5, batch_size=1024)
        lab = km.fit_predict(vectors)
        return lab, {"method": "minibatch-kmeans", "k": k, "inertia": round(float(km.inertia_), 2)}
    km = KMeans(n_clusters=k, random_state=seed, n_init=10)
    lab = km.fit_predict(vectors)
    return lab, {"method": "kmeans", "k": k, "inertia": round(float(km.inertia_), 2)}


def silhouette(vectors: np.ndarray, labels: np.ndarray, max_n: int = 3000) -> float | None:
    from sklearn.metrics import silhouette_score

    uniq = set(labels)
    if len(uniq) < 2 or len(vectors) < 10:
        return None
    idx = np.random.RandomState(42).choice(len(vectors), min(max_n, len(vectors)), replace=False)
    if len(set(labels[idx])) < 2:
        return None
    try:
        return round(float(silhouette_score(vectors[idx], labels[idx])), 4)
    except Exception:
        return None


def pca2(vectors: np.ndarray) -> np.ndarray:
    from sklearn.decomposition import PCA

    if len(vectors) < 3 or vectors.shape[1] < 2 or not np.any(np.var(vectors, axis=0) > 1e-12):
        return np.zeros((len(vectors), 2))
    return PCA(n_components=2, random_state=42).fit_transform(vectors)


def month_label(m: str) -> str:
    return {"2026-08": "8 月", "2026-09": "9 月", "2026-10": "10 月"}.get(m, m)


def clean_json(o):
    """把 numpy / pandas 类型转成 JSON 可序列化。"""
    if isinstance(o, dict):
        return {str(k): clean_json(v) for k, v in o.items()}
    if isinstance(o, (list, tuple, set)):
        return [clean_json(v) for v in o]
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating, float)):
        return float(o) if np.isfinite(o) else None
    if isinstance(o, np.bool_):
        return bool(o)
    if o is pd.NA or o is pd.NaT:
        return None
    if isinstance(o, np.ndarray):
        return clean_json(o.tolist())
    if isinstance(o, pd.Timestamp):
        return o.isoformat()
    if hasattr(o, "isoformat"):
        return o.isoformat()
    return o

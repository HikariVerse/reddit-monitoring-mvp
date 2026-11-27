"""统计与时间序列算子（5.6 / 12.6 / 12.8 的统一实现）。

全部为纯函数，输入 numpy/pandas，输出可 JSON 化的原生类型。
"""

from __future__ import annotations

import math
from collections import Counter
from typing import Iterable, Sequence

import numpy as np


# --------------------------------------------------------------------------- #
# 基础统计
# --------------------------------------------------------------------------- #
def safe_div(a: float, b: float, default: float | None = None):
    if b is None or b == 0 or (isinstance(b, float) and math.isnan(b)):
        return default
    return a / b


def mean(x) -> float:
    a = np.asarray(list(x), dtype=float)
    return float(a.mean()) if a.size else 0.0


def quantile(x, q: float) -> float:
    a = np.asarray(list(x), dtype=float)
    return float(np.quantile(a, q)) if a.size else 0.0


def desc(x) -> dict:
    a = np.asarray(list(x), dtype=float)
    if not a.size:
        return {"n": 0, "mean": 0, "median": 0, "std": 0, "p10": 0, "p90": 0, "min": 0, "max": 0}
    return {
        "n": int(a.size),
        "mean": round(float(a.mean()), 3),
        "median": round(float(np.median(a)), 3),
        "std": round(float(a.std()), 3),
        "p10": round(float(np.quantile(a, 0.1)), 3),
        "p90": round(float(np.quantile(a, 0.9)), 3),
        "min": round(float(a.min()), 3),
        "max": round(float(a.max()), 3),
    }


def pearson(x, y) -> float:
    a, b = np.asarray(x, float), np.asarray(y, float)
    if a.size < 3 or a.std() == 0 or b.std() == 0:
        return 0.0
    return round(float(np.corrcoef(a, b)[0, 1]), 4)


def spearman(x, y) -> float:
    a, b = np.asarray(x, float), np.asarray(y, float)
    if a.size < 3 or a.std() == 0 or b.std() == 0:
        return 0.0
    from scipy.stats import spearmanr
    return round(float(spearmanr(a, b).statistic), 4)


def jaccard(a: Iterable, b: Iterable) -> float:
    sa, sb = set(a), set(b)
    if not sa and not sb:
        return 0.0
    return round(len(sa & sb) / len(sa | sb), 4)


# --------------------------------------------------------------------------- #
# 关联强度
# --------------------------------------------------------------------------- #
def pmi(c_ab: int, c_a: int, c_b: int, n: int) -> float:
    """点互信息；返回 log 值，未观测到返回 0。"""
    if min(c_ab, c_a, c_b, n) <= 0:
        return 0.0
    return round(math.log((c_ab / n) / ((c_a / n) * (c_b / n))), 4)


def npmi(c_ab: int, c_a: int, c_b: int, n: int) -> float:
    p = pmi(c_ab, c_a, c_b, n)
    if p == 0:
        return 0.0
    return round(p / (-math.log(c_ab / n)), 4)


def lift(c_ab: int, c_a: int, c_b: int, n: int) -> float:
    if min(c_ab, c_a, c_b, n) <= 0:
        return 0.0
    return round((c_ab / n) / ((c_a / n) * (c_b / n)), 3)


def log_odds_ratio(c1: int, n1: int, c2: int, n2: int, prior: float = 0.5) -> float:
    """Monroe et al. 的信息先验 log-odds（用于社区特征词）。"""
    eps = 1e-9
    a = max(eps, c1 + prior)
    b = max(eps, n1 - c1 + prior)
    c = max(eps, c2 + prior)
    d = max(eps, n2 - c2 + prior)
    return round(math.log((a / b) / (c / d)), 4)


# --------------------------------------------------------------------------- #
# 集中度与多样性
# --------------------------------------------------------------------------- #
def hhi(counts: Sequence[int]) -> float:
    tot = sum(counts)
    if tot <= 0:
        return 0.0
    return round(sum((c / tot) ** 2 for c in counts), 4)


def cr_n(counts: Sequence[int], n: int = 3) -> float:
    tot = sum(counts)
    if tot <= 0:
        return 0.0
    return round(sum(sorted(counts, reverse=True)[:n]) / tot, 4)


def entropy(counts: Sequence[int], normalize: bool = True) -> float:
    tot = sum(counts)
    if tot <= 0:
        return 0.0
    p = np.asarray([c / tot for c in counts if c > 0], dtype=float)
    h = float(-(p * np.log(p)).sum())
    if normalize and len(p) > 1:
        h /= math.log(len(p))
    return round(h, 4)


def top_share(counts: Sequence[int], k: int = 1) -> float:
    tot = sum(counts)
    if tot <= 0:
        return 0.0
    return round(sum(sorted(counts, reverse=True)[:k]) / tot, 4)


# --------------------------------------------------------------------------- #
# 归一化与评分
# --------------------------------------------------------------------------- #
def percentile_rank(values: Sequence[float]) -> np.ndarray:
    a = np.asarray(values, dtype=float)
    if a.size == 0:
        return a
    order = a.argsort().argsort()
    return order / max(1, a.size - 1)


def minmax(values: Sequence[float]) -> np.ndarray:
    a = np.asarray(values, dtype=float)
    if a.size == 0:
        return a
    lo, hi = np.nanmin(a), np.nanmax(a)
    if hi - lo < 1e-12:
        return np.full_like(a, 0.5)
    return (a - lo) / (hi - lo)


def zscore(values: Sequence[float]) -> np.ndarray:
    a = np.asarray(values, dtype=float)
    if a.size == 0:
        return a
    mu, sd = np.nanmean(a), np.nanstd(a)
    if sd < 1e-12:
        return np.zeros_like(a)
    return (a - mu) / sd


def weighted_score(factors: dict[str, np.ndarray], weights: dict[str, float], method: str = "percentile") -> np.ndarray:
    """多因子加权评分：percentile / minmax / geomean / topsis。"""
    keys = [k for k in weights if k in factors]
    if not keys:
        return np.array([])
    if method == "percentile":
        norm = {k: percentile_rank(factors[k]) for k in keys}
    elif method == "minmax":
        norm = {k: minmax(factors[k]) for k in keys}
    else:
        norm = {k: percentile_rank(factors[k]) for k in keys}
    w = np.asarray([weights[k] for k in keys], dtype=float)
    w = w / w.sum()
    if method == "geomean":
        mat = np.vstack([np.clip(norm[k], 1e-4, 1) for k in keys])
        return np.exp((np.log(mat) * w[:, None]).sum(axis=0)) * 100
    if method == "topsis":
        mat = np.vstack([norm[k] for k in keys]).T  # n x k
        wm = mat * w
        ideal = wm.max(axis=0)
        anti = wm.min(axis=0)
        d_pos = np.sqrt(((wm - ideal) ** 2).sum(axis=1))
        d_neg = np.sqrt(((wm - anti) ** 2).sum(axis=1))
        return (d_neg / np.maximum(d_neg + d_pos, 1e-9)) * 100
    mat = np.vstack([norm[k] for k in keys])
    return (mat * w[:, None]).sum(axis=0) * 100


def pareto_front(points: Sequence[Sequence[float]]) -> list[int]:
    """返回帕累托前沿点索引（各维越大越好）。"""
    pts = np.asarray(points, dtype=float)
    if pts.size == 0:
        return []
    keep = []
    for i in range(len(pts)):
        dominated = False
        for j in range(len(pts)):
            if i == j:
                continue
            if np.all(pts[j] >= pts[i]) and np.any(pts[j] > pts[i]):
                dominated = True
                break
        if not dominated:
            keep.append(i)
    return keep


# --------------------------------------------------------------------------- #
# 时间序列
# --------------------------------------------------------------------------- #
def moving_average(x: Sequence[float], window: int = 7) -> np.ndarray:
    a = np.asarray(x, dtype=float)
    if a.size == 0:
        return a
    w = max(1, min(window, a.size))
    kernel = np.ones(w) / w
    out = np.convolve(a, kernel, mode="same")
    # 边缘用累积均值修正
    for i in range(min(w, a.size)):
        out[i] = a[: i + 1].mean()
        out[-(i + 1)] = a[-(i + 1):].mean()
    return out


def ewma(x: Sequence[float], alpha: float = 0.3) -> np.ndarray:
    a = np.asarray(x, dtype=float)
    out = np.empty_like(a)
    if a.size == 0:
        return out
    out[0] = a[0]
    for i in range(1, a.size):
        out[i] = alpha * a[i] + (1 - alpha) * out[i - 1]
    return out


def rolling_zscore(x: Sequence[float], window: int = 30, min_period: int = 7) -> np.ndarray:
    """基于**历史窗口**（不含当前点）的 z 分数，避免未来信息泄漏。"""
    a = np.asarray(x, dtype=float)
    out = np.zeros_like(a)
    for i in range(a.size):
        lo = max(0, i - window)
        hist = a[lo:i]
        if hist.size < min_period:
            out[i] = 0.0
            continue
        mu, sd = hist.mean(), hist.std()
        out[i] = (a[i] - mu) / sd if sd > 1e-9 else 0.0
    return out


def mad_anomaly(x: Sequence[float], window: int = 30, k: float = 3.5, min_period: int = 7) -> np.ndarray:
    """稳健异常：|x - median| / (1.4826*MAD)。"""
    a = np.asarray(x, dtype=float)
    out = np.zeros_like(a)
    for i in range(a.size):
        lo = max(0, i - window)
        hist = a[lo:i]
        if hist.size < min_period:
            continue
        med = np.median(hist)
        mad = np.median(np.abs(hist - med))
        scale = 1.4826 * mad if mad > 0 else hist.std()
        out[i] = (a[i] - med) / scale if scale > 1e-9 else 0.0
    return out


def cusum(x: Sequence[float], k: float = 0.5, h: float = 4.0) -> dict:
    """CUSUM 变点检测（标准化后）。返回告警索引。"""
    a = np.asarray(x, dtype=float)
    if a.size < 3:
        return {"alarms": [], "s_pos": [], "s_neg": []}
    mu, sd = a.mean(), a.std() or 1.0
    z = (a - mu) / sd
    s_pos = np.zeros_like(z)
    s_neg = np.zeros_like(z)
    alarms = []
    for i in range(1, len(z)):
        s_pos[i] = max(0.0, s_pos[i - 1] + z[i] - k)
        s_neg[i] = min(0.0, s_neg[i - 1] + z[i] + k)
        if s_pos[i] > h or s_neg[i] < -h:
            alarms.append(i)
    return {"alarms": alarms, "s_pos": s_pos.round(3).tolist(), "s_neg": s_neg.round(3).tolist()}


def theil_sen_slope(y: Sequence[float], x: Sequence[float] | None = None) -> float:
    a = np.asarray(y, dtype=float)
    xs = np.asarray(x, dtype=float) if x is not None else np.arange(a.size, dtype=float)
    mask = np.isfinite(a) & np.isfinite(xs)
    if mask.sum() < 3 or len(np.unique(xs[mask])) < 2:
        return 0.0
    from scipy.stats import theilslopes
    # Cap long histories to preserve the local CPU/memory envelope.
    valid = np.flatnonzero(mask)
    if len(valid) > 400:
        valid = valid[np.linspace(0, len(valid) - 1, 400, dtype=int)]
    return round(float(theilslopes(a[valid], xs[valid]).slope), 4)


def linear_slope(y: Sequence[float]) -> float:
    a = np.asarray(y, dtype=float)
    if a.size < 3:
        return 0.0
    x = np.arange(a.size, dtype=float)
    slope = np.polyfit(x, a, 1)[0]
    return round(float(slope), 4)


def growth_rate(cur: float, prev: float) -> float | None:
    if prev is None or prev <= 0:
        return None
    return round((cur - prev) / prev, 4)


def persistence(dates: Sequence[str], total_days: int, min_per_day: int = 1) -> float:
    """需求持续性：出现天数 / 总天数。"""
    if total_days <= 0:
        return 0.0
    c = Counter(dates)
    active = sum(1 for d, n in c.items() if n >= min_per_day)
    return round(active / total_days, 4)


def bootstrap_ci(values: Sequence[float], groups: Sequence[str] | None = None, n_boot: int = 200, alpha: float = 0.05):
    """按线程/作者分组重采样的均值置信区间（无人工标注下的稳定性估计）。"""
    a = np.asarray(values, dtype=float)
    if a.size < 5:
        return {"mean": round(float(a.mean()), 4) if a.size else 0.0, "lo": None, "hi": None, "n": int(a.size)}
    rng = np.random.RandomState(42)
    if groups is not None:
        g = np.asarray(groups)
        uniq = np.unique(g)
        idx_by_g = {u: np.where(g == u)[0] for u in uniq}
        means = []
        for _ in range(n_boot):
            pick = rng.choice(uniq, size=len(uniq), replace=True)
            idx = np.concatenate([idx_by_g[p] for p in pick])
            means.append(a[idx].mean())
    else:
        means = [a[rng.randint(0, a.size, a.size)].mean() for _ in range(n_boot)]
    means = np.asarray(means)
    return {
        "mean": round(float(a.mean()), 4),
        "lo": round(float(np.quantile(means, alpha / 2)), 4),
        "hi": round(float(np.quantile(means, 1 - alpha / 2)), 4),
        "n": int(a.size),
    }


def anomaly_events(series: Sequence[float], dates: Sequence[str], z: Sequence[float], threshold: float = 3.0,
                   min_count: int = 3, max_span: int = 10) -> list[dict]:
    """把连续超阈值的点合并为事件区间。"""
    events = []
    i = 0
    n = len(series)
    while i < n:
        if z[i] >= threshold and series[i] >= min_count:
            j = i
            while j + 1 < n and z[j + 1] >= threshold * 0.6 and (j + 1 - i) < max_span:
                j += 1
            peak = int(np.argmax(np.asarray(series[i : j + 1]))) + i
            events.append({
                "start": dates[i], "end": dates[j], "peak_date": dates[peak],
                "peak_value": int(series[peak]), "max_z": round(float(max(z[i : j + 1])), 2),
                "days": j - i + 1, "sum": int(sum(series[i : j + 1])),
            })
            i = j + 1
        else:
            i += 1
    return events

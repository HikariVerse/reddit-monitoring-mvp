"""多标签业务意图识别（5.3）。

实现方式：把 28 条意图的全部模式编译成**单个 mega-regex**（命名分组），
单次扫描即可拿到所有命中意图 —— 相比逐条匹配把时间复杂度从 O(意图数 × 文本) 降为 O(文本)。

每条命中记录：意图、一级分类、命中句、字符位置、触发规则、规则支持度。
"""

from __future__ import annotations

import re
from collections import Counter

from . import lexicon as L

RE_SENT_SPLIT = re.compile(r"(?<=[.!?。！？])\s+|\n+")

_PATTERN_LIST: list[tuple[str, str]] = []
for _intent, _cfg in L.INTENT_RULES.items():
    for _p in _cfg["patterns"]:
        _PATTERN_LIST.append((_intent, _p))

_MEGA = re.compile(
    "|".join(f"(?P<g{i}>{p})" for i, (_intent, p) in enumerate(_PATTERN_LIST)),
    re.I,
)
_GROUPS = {f"g{i}": intent for i, (intent, _p) in enumerate(_PATTERN_LIST)}


def split_sentences(text: str, max_sents: int = 12) -> list[str]:
    parts = [s.strip() for s in RE_SENT_SPLIT.split(text) if s and s.strip()]
    return parts[:max_sents] if parts else ([text.strip()] if text.strip() else [])


def classify(text: str, max_sents: int = 12, sentences=None) -> list[dict]:
    """返回多标签意图命中列表（同一意图取首条最佳命中）。"""
    if not text:
        return []
    hits: dict[str, dict] = {}
    cursor = 0
    for sent in (split_sentences(text, max_sents) if sentences is None else sentences[:max_sents]):
        start = text.find(sent, cursor)
        if start >= 0:
            cursor = start + len(sent)
        for m in _MEGA.finditer(sent):
            intent = _GROUPS.get(m.lastgroup or "")
            if not intent:
                continue
            if intent in hits:
                hits[intent]["count"] += 1
                continue
            hits[intent] = {
                "intent": intent,
                "group": L.INTENT_GROUP.get(intent, "其他"),
                "sentence": sent[:220],
                "matched": m.group(0)[:60],
                "start": (max(0, start) if sentences is not None else 0) + m.start(),
                **({"end": max(0, start) + m.end()} if sentences is not None else {}),
                "rule": f"{intent}#{_PATTERN_LIST[int((m.lastgroup or 'g0')[1:])][1][:28]}",
                "method": "regex",
                "support": 1.0,
                "count": 1,
            }
    if not hits:
        return [{
            "intent": "一般讨论", "group": "其他", "sentence": (text[:160] or ""), "matched": "",
            "start": 0, "rule": "fallback", "method": "default", "support": 0.0, "count": 1,
        }]
    out = sorted(hits.values(), key=lambda h: (-h["count"], h["intent"]))
    return out


def intent_vector(hits: list[dict]) -> dict[str, int]:
    """多标签向量：意图 -> 出现次数。"""
    return dict(Counter(h["intent"] for h in hits for _ in range(h.get("count", 1))))


def coverage(docs_hits: list[list[dict]]) -> dict:
    """意图覆盖率与分布（用于质量面板与实验室）。"""
    n = len(docs_hits) or 1
    per: Counter = Counter()
    matched_docs = 0
    for hits in docs_hits:
        names = {h["intent"] for h in hits if h["intent"] != "一般讨论"}
        if names:
            matched_docs += 1
        per.update(names)
    return {
        "coverage": round(matched_docs / n, 4),
        "docs": len(docs_hits),
        "distribution": [{"intent": k, "docs": v, "pct": round(v / n * 100, 2)} for k, v in per.most_common()],
        "group_distribution": _group_dist(per, n),
    }


def _group_dist(per: Counter, n: int) -> list[dict]:
    g: Counter = Counter()
    for intent, c in per.items():
        g[L.INTENT_GROUP.get(intent, "其他")] += c
    return [{"group": k, "docs": v, "pct": round(v / n * 100, 2)} for k, v in g.most_common()]


def cooccurrence(docs_hits: list[list[dict]]) -> dict:
    """意图共现矩阵（实验室：不同意图的重叠情况）。"""
    keys = [k for k in L.INTENT_KEYS if k != "一般讨论"]
    idx = {k: i for i, k in enumerate(keys)}
    mat = [[0] * len(keys) for _ in keys]
    for hits in docs_hits:
        names = sorted({h["intent"] for h in hits if h["intent"] in idx})
        for a in names:
            for b in names:
                mat[idx[a]][idx[b]] += 1
    return {"labels": keys, "matrix": mat}

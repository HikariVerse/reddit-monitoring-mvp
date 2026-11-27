"""属性级情感分析（5.4）：文档 / 实体 / 属性 三级 + 语义原型对照。

方法组合（全部保留，便于实验室对比）：
* 词典法：正负词 + 否定 + 程度副词；
* 局部窗口法：实体/属性 ±8 token 窗口内求和（默认核心方法）；
* 转折处理：but/however 之后的分句权重 ×1.5，之前 ×0.6；
* 原型法：用 Potion 向量与正/负/中性质心的相似度做文档级对照（实验项）。
"""

from __future__ import annotations

import re

import numpy as np

from . import lexicon as L

RE_WORD_POS = re.compile(r"[A-Za-zÀ-ÿ']{2,}|[\u4e00-\u9fff]")
CLAUSE_SPLIT = re.compile(r"[,;，；]|\b(?:but|however|although|though|yet)\b", re.I)
NEG_WINDOW = 3


def _tokens_with_pos(text: str) -> tuple[list[str], list[int], list[int]]:
    toks, starts, ends = [], [], []
    for m in RE_WORD_POS.finditer(text):
        toks.append(m.group(0).lower())
        starts.append(m.start())
        ends.append(m.end())
    return toks, starts, ends


def _polarity_of_word(w: str) -> float:
    if w in L.POS_WORDS:
        return 1.0
    if w in L.NEG_WORDS:
        return -1.0
    return 0.0


def score_span(tokens: list[str], lo: int, hi: int) -> tuple[float, int, int]:
    """对 token 区间 [lo,hi) 计分，返回 (score, pos_count, neg_count)。"""
    total = 0.0
    pos = neg = 0
    for i in range(max(0, lo), min(len(tokens), hi)):
        base = _polarity_of_word(tokens[i])
        if base == 0:
            continue
        w = 1.0
        for j in range(max(0, i - NEG_WINDOW), i):
            if tokens[j] in L.NEGATORS:
                w *= -1.0
                break
        for j in range(max(0, i - 2), i):
            if tokens[j] in L.INTENSIFIERS:
                w *= L.INTENSIFIERS[tokens[j]]
        total += base * w
        if base > 0:
            pos += 1
        else:
            neg += 1
    return total, pos, neg


def label_from(pos: int, neg: int, score: float) -> str:
    if pos == 0 and neg == 0:
        return "未知"
    if pos > 0 and neg > 0:
        return "混合" if abs(pos - neg) <= max(1, (pos + neg) * 0.3) else ("正面" if pos > neg else "负面")
    return "正面" if pos > neg else "负面"


def doc_sentiment(text: str) -> dict:
    """文档级：按分句加权（转折后权重更高）。"""
    sents = CLAUSE_SPLIT.split(text or "")
    total = 0.0
    pos = neg = 0
    for i, s in enumerate(sents):
        toks = RE_WORD_POS.findall(s.lower())
        sc, p, n = score_span(toks, 0, len(toks))
        weight = 1.0
        if i > 0 and re.search(r"\b(but|however|although|though|yet)\b", sents[i - 1], re.I):
            weight = 1.5
        total += sc * weight
        pos += p
        neg += n
    norm = total / max(3, np.sqrt(max(1, pos + neg) * 4))
    return {
        "score": round(float(np.clip(norm, -1, 1)), 4),
        "pos": pos,
        "neg": neg,
        "label": label_from(pos, neg, total),
    }


def entity_window_sentiment(text: str, entity_start: int, entity_end: int, window: int = 8) -> dict:
    """实体邻近窗口情感（默认 ±8 token，可调）。"""
    toks, starts, ends = _tokens_with_pos(text)
    # 找到实体之后的第一个 token 位置
    idx = next((i for i, s in enumerate(starts) if s >= entity_end), len(toks))
    lo, hi = idx - window, idx + window
    sc, p, n = score_span(toks, lo, hi)
    return {"score": round(float(np.clip(sc / 2.0, -1, 1)), 4), "pos": p, "neg": n, "label": label_from(p, n, sc)}


def aspect_triples(text: str, entity_hits: list, attr_hits: list, window: int = 8, max_triples: int = 6) -> list[dict]:
    """抽取 (实体, 属性, 情感) 三元组。

    规则：同一分句内，属性与实体距离 < 120 字符视为绑定；情感在属性 ±window 窗口内计算。
    没有属性时，若实体附近有情感词，输出 (实体, '整体', 情感)。
    """
    if not text or not entity_hits:
        return []
    out = []
    clauses = []
    last = 0
    for m in CLAUSE_SPLIT.finditer(text):
        clauses.append((last, m.start()))
        last = m.end()
    clauses.append((last, len(text)))

    for ent in entity_hits[:8]:
        if ent.type not in ("BRAND", "BRAND_CANDIDATE", "PRODUCT", "MODEL", "CATEGORY"):
            continue
        # 找同一分句内的属性
        cl = next(((a, b) for a, b in clauses if a <= ent.start < b), (0, len(text)))
        near_attrs = [
            a for a in attr_hits
            if cl[0] <= a.start < cl[1] and abs(a.start - ent.start) <= 120
        ]
        if near_attrs:
            for a in near_attrs[:3]:
                s = entity_window_sentiment(text, a.start, a.end, window)
                if s["label"] != "未知":
                    out.append({
                        "entity": ent.surface, "entity_type": ent.type, "canon": ent.canon,
                        "attribute": a.surface, "attribute_canon": a.canon,
                        "sentiment": s["label"], "score": s["score"],
                        "context": text[max(0, a.start - 50) : a.end + 50].replace("\n", " "),
                    })
        else:
            s = entity_window_sentiment(text, ent.start, ent.end, window)
            if s["label"] != "未知":
                out.append({
                    "entity": ent.surface, "entity_type": ent.type, "canon": ent.canon,
                    "attribute": "整体", "attribute_canon": "整体",
                    "sentiment": s["label"], "score": s["score"],
                    "context": text[max(0, ent.start - 50) : ent.end + 50].replace("\n", " "),
                })
        if len(out) >= max_triples:
            break
    # 去重
    seen, uniq = set(), []
    for t in out:
        k = (t["canon"], t["attribute_canon"], t["sentiment"])
        if k in seen:
            continue
        seen.add(k)
        uniq.append(t)
    return uniq[:max_triples]


class PrototypeSentiment:
    """语义原型情感（实验项）：三条原型句 → 质心 → 余弦差。"""

    def __init__(self, embed, seeds: dict[str, list[str]] | None = None):
        self.embed = embed
        self.seeds = seeds or {
            "pos": ["this is amazing, i love it", "great product, works perfectly, highly recommend",
                    "太棒了，非常喜欢，强烈推荐"],
            "neu": ["here is the link to the documentation", "the update was released on monday",
                    "这是一个关于产品参数的说明"],
            "neg": ["this is terrible, i hate it, waste of money", "broke after two weeks, very disappointed",
                    "太糟糕了，很失望，完全是浪费钱"],
        }
        vecs = {k: np.mean(embed(v), axis=0) for k, v in self.seeds.items()}
        self.P = np.stack([vecs["pos"], vecs["neu"], vecs["neg"]])
        self.P = self.P / np.maximum(np.linalg.norm(self.P, axis=1, keepdims=True), 1e-9)

    def predict(self, emb: np.ndarray) -> np.ndarray:
        S = emb @ self.P.T
        Z = S - S.mean(axis=0, keepdims=True)
        return Z.argmax(axis=1)  # 0=pos 1=neu 2=neg

    def score(self, emb: np.ndarray) -> np.ndarray:
        S = emb @ self.P.T
        Z = S - S.mean(axis=0, keepdims=True)
        return Z[:, 0] - Z[:, 2]


LABELS_3 = ["正面", "中性", "负面"]

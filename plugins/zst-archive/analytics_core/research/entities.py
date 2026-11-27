"""实体识别 + 自动领域词典构建（5.2）。

无人工标注策略：
1. 内置通用词典（品牌/属性/场景/品类）作为种子；
2. 从当前研究语料中统计高频 n-gram，按「支持度 + 与种子/品类的 PMI + 情感邻近度 + 大小写形态」打分；
3. 用 Potion 向量与种子质心的余弦相似度扩展同义表达（阈值可调）；
4. 型号用正则（字母+数字）识别，并与最近品牌绑定。
"""

from __future__ import annotations

import math
import re
from collections import Counter, defaultdict
from dataclasses import dataclass, field

import numpy as np

from . import lexicon as L

RE_TOKEN = re.compile(r"[A-Za-zÀ-ÿ][A-Za-zÀ-ÿ0-9'\-\.]{1,30}")
RE_MODEL = re.compile(r"\b(?=[A-Za-z0-9\-]{2,14}\b)(?=[^\s]*\d)[A-Z]{0,5}\d{1,5}[A-Za-z]{0,3}\b")
RE_CAPWORD = re.compile(r"\b[A-Z][A-Za-z0-9\-]{1,20}\b")


@dataclass
class Hit:
    surface: str
    type: str
    start: int
    end: int
    canon: str = ""

    def as_dict(self, text: str | None = None) -> dict:
        d = {"s": self.surface, "t": self.type, "start": self.start, "end": self.end}
        if text:
            d["ctx"] = text[max(0, self.start - 40) : self.end + 40].replace("\n", " ")
        return d


class Dictionary:
    """多模式匹配词典：一次编译，按长度优先匹配。"""

    def __init__(self, entries: dict[str, str] | None = None, flags=re.I):
        self.entries: dict[str, str] = {}
        self.regex: re.Pattern | None = None
        self.automaton = None
        if entries:
            self.update(entries, flags)

    def update(self, entries: dict[str, str], flags=re.I):
        for surface, typ in entries.items():
            s = surface.strip().lower()
            if len(s) < 2:
                continue
            if s not in self.entries:
                self.entries[s] = typ
        self._compile(flags)

    def _compile(self, flags):
        if not self.entries:
            self.regex = None
            return
        parts = []
        for s in sorted(self.entries, key=lambda value: (-len(value), value)):
            parts.append(re.escape(s).replace(r"\ ", r"[\s\-]+"))
        # 左右边界：允许复数 s / 所有格 's
        pattern = r"(?<![a-z0-9])(?:" + "|".join(parts) + r")(?:s|'s)?(?![a-z0-9])"
        self.regex = re.compile(pattern, flags)
        if flags == re.I:
            try:
                import ahocorasick
            except ImportError:
                return
            automaton = ahocorasick.Automaton()
            for surface, typ in self.entries.items():
                automaton.add_word(surface, (surface, typ))
            automaton.make_automaton()
            self.automaton = automaton

    def find(self, text_lower: str, limit: int = 60) -> list[Hit]:
        if not self.regex:
            return []
        # This route preserves the regex contract for plain ASCII text with single spaces.
        if self.automaton and text_lower.isascii() and not re.search(r"[-\s]{2,}|[\t\r\n-]", text_lower):
            return self._exact_hits(text_lower, limit)
        out = []
        for m in self.regex.finditer(text_lower):
            surf = m.group(0)
            plain = re.sub(r"[\s-]+", " ", surf.lower())
            base = next((key for key in (surf.lower(), plain, plain.removesuffix("'s"), plain.removesuffix("s"))
                         if key in self.entries), plain)
            typ = self.entries.get(base.lower()) or self.entries.get(surf.lower()) or "CANDIDATE"
            out.append(Hit(surf, typ, m.start(), m.end(), base.lower()))
            if len(out) >= limit:
                break
        return out

    def _exact_hits(self, text, limit):
        lower = text.lower()
        boundary = re.compile(r"[a-z0-9]")
        candidates = []
        for end, (surface, typ) in self.automaton.iter(lower):
            start = end - len(surface) + 1
            end += 1
            if start and boundary.match(lower[start - 1]):
                continue
            suffix = "'s" if lower.startswith("'s", end) else "s" if lower.startswith("s", end) else ""
            stop = end + len(suffix)
            if stop < len(lower) and boundary.match(lower[stop]):
                if suffix == "'s":
                    stop = end
                else:
                    continue
            candidates.append((start, -len(surface), stop, typ, surface))
        output, stop = [], 0
        for start, _, end, typ, surface in sorted(candidates):
            if start < stop:
                continue
            canonical = lower[start:end] if lower[start:end] in self.entries else surface
            output.append(Hit(text[start:end], self.entries.get(canonical, typ), start, end, canonical))
            stop = end
            if len(output) >= limit:
                break
        return output

    def size(self) -> int:
        return len(self.entries)


def base_dictionary() -> Dictionary:
    entries: dict[str, str] = {}
    for b in L.ALL_BRANDS:
        entries[b] = "BRAND"
    for t, c in L.CATEGORY_TERMS.items():
        entries[t] = "CATEGORY"
    for t, c in L.ATTR_TERMS.items():
        entries.setdefault(t, "ATTRIBUTE")
    for t, c in L.SCENARIO_TERMS.items():
        entries.setdefault(t, "SCENARIO")
    for name in L.INTENT_KEYS:
        pass
    return Dictionary(entries)


# --------------------------------------------------------------------------- #
# 自动领域词典
# --------------------------------------------------------------------------- #
def _ngrams(tokens: list[str], max_n: int = 3):
    for n in range(1, max_n + 1):
        for i in range(len(tokens) - n + 1):
            yield " ".join(tokens[i : i + n])


def discover_domain_terms(
    docs: list[dict],
    seed_terms: list[str],
    embed=None,
    top_k: int = 60,
    min_df: int = 5,
    sim_threshold: float = 0.8,
    max_docs: int = 12000,
) -> dict:
    """从语料中发现品牌/属性/场景/子品类候选（无人工标注）。

    信号：支持度、名词短语上下文、句中大写（排除句首）、情感邻近度、与种子的文档级共现。
    """
    n_docs = min(len(docs), max_docs)
    sample = docs[:n_docs]
    seed_set = [s.lower() for s in seed_terms if s]
    df_counter: Counter = Counter()
    mid_cap: Counter = Counter()
    noun_ctx: Counter = Counter()
    senti_near: Counter = Counter()
    with_seed: Counter = Counter()

    for d in sample:
        toks = d["tokens"]
        raw = d.get("raw", "")
        low = raw.lower()
        has_seed = any(s and s in low for s in seed_set)
        seen = set()
        for n in (1, 2, 3):
            for i in range(len(toks) - n + 1):
                g = " ".join(toks[i : i + n])
                if len(g) > 28 or not L.is_valid_phrase(g, 3):
                    continue
                seen.add(g)
                prev = toks[i - 1] if i > 0 else ""
                if prev in L.DETERMINERS:
                    noun_ctx[g] += 1
        df_counter.update(seen)
        if has_seed:
            with_seed.update(seen)
        # 句中大写（排除句首）
        for m in RE_CAPWORD.finditer(raw):
            st = m.start()
            prev_ch = raw[st - 1] if st > 0 else " "
            if prev_ch not in ".!?\n" and not (st > 0 and raw[max(0, st - 2)] in ".!?\n"):
                mid_cap[m.group(0).lower()] += 1
        for sent in d.get("sentences", []):
            sl = sent.lower()
            if any(w in sl for w in L.POS_WORDS) or any(w in sl for w in L.NEG_WORDS):
                for g in set(_ngrams(RE_TOKEN.findall(sl), 2)):
                    if L.is_valid_phrase(g):
                        senti_near[g] += 1

    cands = {g: c for g, c in df_counter.items() if c >= min_df and L.is_valid_phrase(g)}
    if not cands:
        return {"brands": [], "attributes": [], "scenarios": [], "categories": [], "phrases": [], "coverage": {}}

    total = n_docs
    scored = []
    for g, c in cands.items():
        if any(g == s for s in seed_set):
            continue
        opinion = senti_near.get(g, 0) / c
        cap = mid_cap.get(g, 0) / c
        noun = noun_ctx.get(g, 0) / c
        seed_rel = with_seed.get(g, 0) / c
        known_brand = g in L.ALL_BRANDS
        known_attr = g in L.ATTR_TERMS
        known_scen = g in L.SCENARIO_TERMS
        known_cat = g in L.CATEGORY_TERMS
        score = (0.40 * math.log1p(c) + 0.30 * opinion + 0.20 * cap + 0.10 * noun
                 + (0.5 if known_brand or known_attr else 0) + 0.3 * seed_rel)
        scored.append({
            "term": g, "df": c, "support": round(c / total, 4),
            "opinion_ratio": round(opinion, 3), "cap_ratio": round(cap, 3),
            "noun_ratio": round(noun, 3), "seed_cooccur": round(seed_rel, 3),
            "score": round(score, 3), "known_brand": known_brand, "known_attr": known_attr,
            "known_scenario": known_scen, "known_category": known_cat,
        })

    if embed is not None:
        try:
            seeds = [s for s in seed_terms if s][:8]
            if seeds:
                sv = embed(seeds)
                centroid = sv.mean(axis=0)
                centroid /= np.linalg.norm(centroid) + 1e-9
                terms = [s["term"] for s in scored[:600]]
                vecs = embed(terms)
                sims = vecs @ centroid
                for s, sim in zip(scored[:600], sims):
                    s["sim_to_seed"] = round(float(sim), 3)
        except Exception:
            pass

    def pick(pred, k):
        rows = [s for s in scored if pred(s)]
        rows.sort(key=lambda s: (-s["score"], -s["df"]))
        return rows[:k]

    def is_other_lex(s):
        return s["known_attr"] or s["known_category"] or s["known_scenario"]

    brands = pick(lambda s: s["known_brand"] or (
        " " not in s["term"] and s["df"] >= max(8, min_df) and s["cap_ratio"] >= 0.35
        and not is_other_lex(s) and s["seed_cooccur"] >= 0.2), top_k)
    attrs = pick(lambda s: s["known_attr"] or (
        s["opinion_ratio"] >= 0.3 and s["df"] >= max(10, min_df) and s["noun_ratio"] >= 0.12
        and not s["known_brand"] and not s["known_category"] and not s["known_scenario"]
        and len(s["term"].split()) <= 2), top_k)
    scenarios = pick(lambda s: s["known_scenario"] or (
        re.search(r"\b(for|when|while|during|at)\b", s["term"]) is not None and s["df"] >= max(10, min_df)), 30)
    cats = pick(lambda s: s["known_category"] or (s["support"] >= 0.005 and s["seed_cooccur"] >= 0.5 and s["df"] >= min_df), 30)
    phrases = pick(lambda s: " " in s["term"] and s["df"] >= max(10, min_df) and len(s["term"].split()) <= 3, 40)

    coverage = {
        "docs_scanned": total, "candidates": len(cands),
        "brand_hits": sum(1 for s in scored if s["known_brand"]),
        "attr_hits": sum(1 for s in scored if s["known_attr"]),
    }
    return {
        "brands": brands, "attributes": attrs, "scenarios": scenarios,
        "categories": cats, "phrases": phrases, "coverage": coverage, "all_scored": scored,
    }


def dict_entries_from_discovery(discovery: dict, base: Dictionary) -> Dictionary:
    """把自动发现结果并入实体词典（保留更具体的类型）。"""
    entries = dict(base.entries)
    for row in discovery.get("brands", [])[:60]:
        entries.setdefault(row["term"], "BRAND_CANDIDATE")
    for row in discovery.get("attributes", [])[:60]:
        entries.setdefault(row["term"], "ATTRIBUTE")
    for row in discovery.get("scenarios", [])[:30]:
        entries.setdefault(row["term"], "SCENARIO")
    for row in discovery.get("categories", [])[:30]:
        entries.setdefault(row["term"], "CATEGORY")
    for row in discovery.get("phrases", [])[:40]:
        entries.setdefault(row["term"], "PHRASE")
    d = Dictionary()
    d.update(entries)
    return d


def find_models(text: str, brands: list[str] | None = None) -> list[tuple[str, str]]:
    """型号识别：字母+数字组合；若附近有品牌词则绑定为 '品牌 型号'。"""
    out = []
    for m in RE_MODEL.finditer(text):
        tok = m.group(0)
        if len(tok) < 2 or tok.lower() in L.FUNCTION_WORDS:
            continue
        if tok.isdigit():
            continue
        ctx = text[max(0, m.start() - 40) : m.end() + 20].lower()
        brand = next((b for b in (brands or []) if re.search(r"(?<!\w)" + re.escape(b) + r"(?!\w)", ctx)), None)
        if brand and not re.fullmatch(r"(?:19|20)\d{2}", tok):
            out.append((tok, f"{brand} {tok}"))
    return out[:12]


# --------------------------------------------------------------------------- #
# 实体消歧与同义归并
# --------------------------------------------------------------------------- #
def merge_synonyms(terms: list[str], embed, threshold: float = 0.86, max_terms: int = 300) -> list[dict]:
    """基于向量相似度的贪心同义合并，返回分组（用于实体归并与词典扩展）。"""
    terms = [t for t in dict.fromkeys(terms) if t][:max_terms]
    if len(terms) < 2:
        return []
    vecs = embed(terms)
    vecs = vecs / np.maximum(np.linalg.norm(vecs, axis=1, keepdims=True), 1e-9)
    used = np.zeros(len(terms), dtype=bool)
    groups = []
    for i in range(len(terms)):
        if used[i]:
            continue
        sims = vecs @ vecs[i]
        idx = np.where(sims >= threshold)[0]
        used[idx] = True
        if len(idx) > 1:
            groups.append({
                "canonical": terms[i],
                "members": [{"term": terms[j], "sim": round(float(sims[j]), 3)} for j in idx[:8]],
            })
    groups.sort(key=lambda g: -len(g["members"]))
    return groups

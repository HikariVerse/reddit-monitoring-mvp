"""文档特征抽取（L0 预处理 + 实体 + 意图 + 属性情感 + 价格 + 关系）。

一次遍历产出所有共享特征，供五大业务模块与算法实验室复用。
"""

from __future__ import annotations

import hashlib
import re
from collections import Counter
from urllib.parse import urlsplit

import numpy as np

import textproc as tp
from . import entities as E
from . import intents as I
from . import lexicon as L
from . import sentiment as S
from . import semantics as V
from .batching import ordered_map
from functools import lru_cache

RE_PRICE_CTX = re.compile(r"[$€£¥]|\b\d+\s?(?:usd|eur|gbp|dollars?|bucks|euros?|pounds?|元|块)\b", re.I)
RE_WORD_LIGHT = re.compile(r"[A-Za-zÀ-ÿ]{2,24}|[\u4e00-\u9fff]{1,2}")
RE_REL_TRIGGER = re.compile(
    r"\bvs\.?\b|\bversus\b|\bswitch|\breplaced?\b|\binstead of\b|\balternative|\bupgraded\b|"
    r"\bworkaround\b|\bhack\b|\bbought\b|\bpaid\b|\bworth\b|\bprice|\bcheaper\b|\bexpensive\b",
    re.I,
)


def _sha(text: str) -> str:
    return hashlib.sha1(text.encode("utf-8", "ignore")).hexdigest()[:16]


def normalize_for_analysis(text: str) -> str:
    return tp.normalize(text or "").replace("’", "'")


def raw_metadata(text, source_url="", source_domain="", content_type=""):
    links = []
    for match in tp.RE_URL.finditer(text):
        value = match.group().rstrip(".)],;!?\u3002")
        try:
            host = urlsplit(value if "://" in value else "https://" + value).hostname
        except ValueError:
            host = None
        if host:
            links.append({"domain": host.lower(), "start": match.start(), "end": match.start() + len(value)})
    return {"links": links[:64], "domain": source_domain, "source_url_present": bool(source_url),
            "content_type": content_type, **tp.clean_stats(text)}


def clean_and_tokenize(text: str, normalized=False) -> dict:
    norm = text if normalized else normalize_for_analysis(text)
    lang, conf = tp.detect_language(norm)
    token_text = re.sub(r"\b[^\W_]+n't\b", " not ", norm, flags=re.I)
    token_text = re.sub(r"(?<=\w)'(?:s|d|m|ll|re|ve)\b", "", token_text, flags=re.I)
    toks = tp.tokenize(token_text)
    sents = I.split_sentences(norm, max_sents=10)
    return {
        "text": norm,
        "lang": lang,
        "lang_conf": round(conf, 3),
        "tokens": toks,
        "sentences": sents,
        "chars": len(norm),
        "n_tokens": len(toks),
        "hash": _sha(norm),
    }


def extract_prices(text: str, sentences=None) -> list[dict]:
    if not RE_PRICE_CTX.search(text):
        return []
    out = []
    sents = I.split_sentences(text, max_sents=8) if sentences is None else sentences
    for m in L.RE_PRICE.finditer(text):
        raw = m.group(0)
        v = m.group("v1") or m.group("v2")
        cur = (m.group("cur1") or m.group("cur2") or "").lower()
        try:
            val = float(str(v).replace(",", ""))
        except ValueError:
            continue
        if val <= 0 or val > 1_000_000:
            continue
        currency = L.CURRENCY_NORM.get(cur, "USD")
        ctx = next((s for s in sents if raw in s), "")
        kind = "未分类"
        for k, res in L.PRICE_CTX_RES.items():
            if any(r.search(ctx) for r in res):
                kind = k
                break
        period = ("monthly" if re.search(r"per month|/mo\b|monthly", ctx, re.I) else
                  "annual" if re.search(r"per year|/yr\b|annual|yearly", ctx, re.I) else "unspecified")
        out.append({"value": val, "currency": currency, "kind": kind, "period": period,
                    "context": ctx[:160], "raw": raw, "start": m.start(), "end": m.end()})
        if len(out) >= 8:
            break
    return out


E_REL_RES = {k: v for k, v in L.REL_RES.items()}


def extract_relations(text: str, brand_canons: set[str], cat_canons: set[str]) -> list[dict]:
    if not RE_REL_TRIGGER.search(text):
        return []
    out = []
    for rel, res in E_REL_RES.items():
        for rx in res:
            for m in rx.finditer(text):
                groups = [g.strip(" .,;:!?\"'") for g in m.groups() if g]
                if len(groups) < 2:
                    continue
                a, b = groups[0][:40], groups[1][:40]
                if len(a) < 3 or len(b) < 3:
                    continue
                al, bl = a.lower(), b.lower()
                # 至少一方是已知品牌/品类，避免把普通短语当关系
                if not any(x in al for x in brand_canons | cat_canons) and not any(x in bl for x in brand_canons | cat_canons):
                    continue
                out.append({"type": rel, "a": a, "b": b, "start": m.start(), "end": m.end(),
                            "sentence": text[max(0, m.start() - 20) : m.end() + 20][:200]})
                break
    # 去重
    seen, uniq = set(), []
    for r in out:
        k = (r["type"], r["a"].lower(), r["b"].lower())
        if k in seen:
            continue
        seen.add(k)
        uniq.append(r)
    return uniq[:6]


def semantic_document(text, extra=None, entities=()):
    extra = extra or {}
    intents = I.classify(text, max_sents=8, sentences=extra.get("sentences"))
    return {"intents": intents, "intent_names": sorted({hit["intent"] for hit in intents}),
            "demand_states": V.demand_states(text, extra),
            "sent": V.classify_opinion(text, vader=extra.get("sentiment"), features=S.doc_sentiment(text)),
            "prices": V.prices(text, extra, entities),
            "pains": [name for name, rule in L.PAIN_RES if rule.search(text)]}


@lru_cache(maxsize=8)
def _worker_dictionary(entries, flags):
    return E.Dictionary(dict(entries), flags=flags)


def _feature_batch(frame, entries, flags, knowledge, entity_limit):
    result = _build_features_serial(frame, _worker_dictionary(entries, flags), entity_limit=entity_limit, knowledge=knowledge)
    return result.drop(columns=frame.columns.difference(["norm"], sort=False))


def build_features(df, dictionary, progress=None, max_docs=None, entity_limit=24, linguistic=None, knowledge=None, vader=None):
    if linguistic or vader is not None or type(dictionary) is not E.Dictionary:
        return _build_features_serial(df, dictionary, progress, max_docs, entity_limit, linguistic, knowledge, vader)
    import pandas as pd

    sub = (df if max_docs is None else df.iloc[:max_docs]).reset_index(drop=True)
    fields = [name for name in ("doc_id", "focus", "text", "url", "domain", "content_type") if name in sub]
    flags = dictionary.regex.flags & ~re.UNICODE if dictionary.regex else re.I
    batches = ordered_map(_feature_batch, sub[fields], tuple(dictionary.entries.items()), flags, knowledge, entity_limit,
                          label="v4_text_and_semantics",
                          on_batch=(lambda count, n: progress("features", count / n * .8, f"实体/意图/情感 {count}/{n}")) if progress else None)
    features = pd.concat(batches, ignore_index=True)
    return pd.concat([sub.drop(columns=sub.columns.intersection(features.columns)), features], axis=1)


def _build_features_serial(
    df,
    dictionary: E.Dictionary,
    progress=None,
    max_docs: int | None = None,
    entity_limit: int = 24,
    linguistic: dict | None = None,
    knowledge: dict | None = None,
    vader=None,
) -> "object":
    """为 DataFrame 生成全部特征列。返回同索引的新 DataFrame。"""
    import pandas as pd

    n = len(df) if max_docs is None else min(len(df), max_docs)
    sub = df.iloc[:n].copy()

    texts, langs, confs, toks, sents, chars, ntoks, hashes = [], [], [], [], [], [], [], []
    source = sub["focus"] if "focus" in sub else sub["text"]
    for i, (doc_id, raw) in enumerate(zip(sub["doc_id"], source.values)):
        c = clean_and_tokenize(str(raw), normalized="focus" in sub)
        linguistic_record = linguistic.get(doc_id) if linguistic else None
        if linguistic_record:
            c["lang"] = linguistic_record["language"]
            c["lang_conf"] = linguistic_record["language_confidence"]
            c["sentences"] = linguistic_record["sentences"]
            if linguistic_record["topic_tokens"]:
                c["tokens"] = linguistic_record["topic_tokens"]
                c["n_tokens"] = len(c["tokens"])
        texts.append(c["text"]); langs.append(c["lang"]); confs.append(c["lang_conf"])
        toks.append(c["tokens"]); sents.append(c["sentences"])
        chars.append(c["chars"]); ntoks.append(c["n_tokens"]); hashes.append(c["hash"])
        if progress and i % 2000 == 0:
            progress("clean", i / max(1, n) * 0.35, f"清洗 {i}/{n}")

    sub["norm"] = texts
    sub["lang"] = langs
    sub["lang_conf"] = confs
    sub["tokens"] = toks
    sub["sentences"] = sents
    sub["chars"] = chars
    sub["n_tokens"] = ntoks
    sub["chash"] = hashes

    intent_col, intent_names, ents_col, aspects_col, senti_col, prices_col, rel_col = [], [], [], [], [], [], []
    brand_col, attr_col, scen_col, model_col, pain_col, measurements, metadata, demand_col = [], [], [], [], [], [], [], []
    knowledge = knowledge or {}

    for i, row in enumerate(sub.itertuples(index=False)):
        text = row.norm
        hits = dictionary.find(text, limit=entity_limit)
        # 型号
        models = E.find_models(text, brands=sorted({h.canon for h in hits if h.type == "BRAND"}))
        model_terms = [m[1] for m in models]
        for mt in model_terms[:5]:
            match = re.search(r"(?<!\w)" + re.escape(mt) + r"(?!\w)", text, re.I)
            if match and not any(h.start == match.start() and h.end == match.end() for h in hits):
                hits.append(E.Hit(match.group(), "MODEL", match.start(), match.end(), mt.lower()))

        extra = linguistic.get(row.doc_id) if linguistic else None
        row_entities = V.entity_records(text, sorted(hits, key=lambda hit: (hit.start, -hit.end)), knowledge)
        candidates = (extra or {}).get("open_entities", ())
        known_spans = {(e["start"], e["end"]): e for e in row_entities}
        names = {"feature", "model", "category", "attribute", "product", "series", "brand", "company", "workaround"}
        for candidate in candidates:
            start, end, kind = candidate["start"], candidate["end"], candidate["type"].casefold()
            if kind not in names or not 0 <= start < end <= len(text) or V.key(text[start:end]) != V.key(candidate["text"]):
                continue
            score = candidate.get("score") or 0
            known = known_spans.get((start, end))
            if known:
                compatible = kind == known["kind"] or {kind, known["kind"]} <= {"category", "subcategory"} or (
                    {kind, known["kind"]} <= {"attribute", "feature"})
                if compatible and score >= .72:
                    known.setdefault("corroboration", []).append({"type": kind, "score": score,
                                                                  "method": candidate.get("method", "open_entity_provider")})
                continue
            identity = V.from_hit(E.Hit(text[start:end], kind.upper(), start, end, V.key(candidate["text"])), knowledge)
            surface = text[start:end]
            parent = next((item for item in row_entities if item.get("target") and item["t"] in {"BRAND", "COMPANY", "SERIES"}
                           and start <= item["start"] < item["end"] < end), None)
            corroborated = bool(parent and kind in {"model", "product", "series"} and score >= .72
                                and re.search(r"\b[A-Za-z]{1,12}[- ]?\d[\w-]{1,18}\b", surface))
            row_entities.append({**identity.record(), "t": kind.upper() if corroborated else kind.upper() + "_CANDIDATE", "s": surface,
                                 "parent": parent["entity_id"] if corroborated else identity.parent,
                                 "target": parent["target"] if corroborated else None,
                                 "corroborated": corroborated,
                                 "role": "unverified", "source": candidate.get("method", "open_entity_provider"),
                                 "confidence": candidate.get("score"),
                                 "start": start, "end": end, "coordinate_space": "focus"})
        row_entities.sort(key=lambda item: (item["start"], -item["end"]))
        language_vader = vader if extra and extra["language"] == "en" else None
        semantic = semantic_document(text, extra, row_entities)
        trip = V.opinions(text, row_entities, extra or {}, vader=language_vader)
        rels = V.relations(text, row_entities, extra or {})
        intent_col.append(semantic["intents"])
        intent_names.append(semantic["intent_names"])
        demand_col.append(semantic["demand_states"])
        ents_col.append(row_entities)
        aspects_col.append(trip)
        senti_col.append(semantic["sent"])
        prices_col.append(semantic["prices"])
        rel_col.append(rels)
        brand_col.append(sorted({e["target"] for e in row_entities if e.get("target")}))
        attr_col.append(sorted({h.canon for h in hits if h.type == "ATTRIBUTE"}))
        scen_col.append(sorted({h.canon for h in hits if h.type == "SCENARIO"}))
        model_col.append(list(dict.fromkeys([*model_terms, *(item["canonical"] for item in row_entities
                                                              if item.get("corroborated"))]))[:12])
        pain_col.append(semantic["pains"])
        measurements.append(V.measurements(text))
        metadata.append(raw_metadata(row.text, getattr(row, "url", ""), getattr(row, "domain", ""), getattr(row, "content_type", "")))
        if progress and i % 2000 == 0:
            progress("features", 0.35 + i / max(1, n) * 0.45, f"实体/意图/情感 {i}/{n}")

    sub["intents"] = intent_col
    sub["intent_names"] = intent_names
    sub["entities"] = ents_col
    sub["aspects"] = aspects_col
    sub["sent"] = senti_col
    sub["sent_label"] = [s["label"] for s in senti_col]
    sub["sent_score"] = [s["score"] for s in senti_col]
    sub["prices"] = prices_col
    sub["relations"] = rel_col
    sub["brands"] = brand_col
    sub["attrs"] = attr_col
    sub["scenarios"] = scen_col
    sub["models"] = model_col
    sub["pains"] = pain_col
    sub["demand_states"] = demand_col
    sub["measurements"] = measurements
    sub["raw_metadata"] = metadata
    return sub.reset_index(drop=True)


def dedupe(sub, near: bool = True, threshold: int = 3):
    """精确 + SimHash 近似去重，返回 (df, stats)。在特征抽取前执行，故自行计算哈希。"""
    n0 = len(sub)
    if "chash" not in sub.columns:
        sub = sub.copy()
        clean = sub["norm"] if "norm" in sub else sub["text"].map(normalize_for_analysis)
        sub["chash"] = clean.map(_sha)
    fingerprints = {}
    duplicates = []
    for chash, doc_id in zip(sub["chash"], sub["doc_id"]):
        if chash in fingerprints:
            duplicates.append({"doc_id": doc_id, "retained_id": fingerprints[chash], "method": "normalized_exact"})
        else:
            fingerprints[chash] = doc_id
    sub = sub.drop_duplicates("chash", keep="first").copy()
    exact = n0 - len(sub)
    near_removed = 0
    if near and len(sub) > 1:
        # 轻量分词（正则切词）即可满足 SimHash 的指纹需求，避免重复做完整分词
        sh = [tp.simhash([w.lower() for w in RE_WORD_LIGHT.findall(str(t))]) for t in sub["text"].values]
        buckets: dict[int, list[int]] = {}
        keep = np.ones(len(sub), dtype=bool)
        for i, h in enumerate(sh):
            dup = False
            for band in range(4):
                key = (band << 16) | ((h >> (band * 16)) & 0xFFFF)
                for j in buckets.get(key, []):
                    if tp.hamming(h, sh[j]) <= threshold:
                        dup = True
                        duplicates.append({"doc_id": sub.iloc[i].doc_id, "retained_id": sub.iloc[j].doc_id, "method": "simhash_hamming"})
                        break
                if dup:
                    break
            if dup:
                keep[i] = False
            else:
                for band in range(4):
                    buckets.setdefault((band << 16) | ((h >> (band * 16)) & 0xFFFF), []).append(i)
        near_removed = int((~keep).sum())
        sub = sub[keep].reset_index(drop=True)
    return sub, {"raw": n0, "exact_dup": exact, "near_dup": near_removed, "kept": len(sub), "pairs": duplicates}


def quality_report(sub, threads: int | None = None) -> dict:
    """数据质量与可靠性指标（5.8）。"""
    if len(sub) == 0:
        return {"docs": 0, "threads": 0, "authors": 0, "communities": 0, "days": 0,
                "status": "无核心样本",
                "coverage": dict.fromkeys(("entity", "intent", "sentiment", "price", "scenario"), 0.0)}
    authors = sub.loc[sub["author"].ne(""), "author"].value_counts() if "author" in sub else None
    comms = sub["community"].value_counts()
    days = sub["date"].nunique() if "date" in sub else 0
    total_days = max(1, (sub["date"].max() - sub["date"].min()).days + 1) if days and hasattr(sub["date"].max(), "days") else days
    return {
        "docs": int(len(sub)),
        "threads": int(threads or sub["thread_id"].nunique()),
        "authors": int(authors.size) if authors is not None else 0,
        "communities": int(comms.size),
        "days": int(days),
        "avg_chars": round(float(sub["chars"].mean()), 1),
        "median_chars": int(sub["chars"].median()),
        "avg_tokens": round(float(sub["n_tokens"].mean()), 1),
        "lang_top": [{"lang": k, "n": int(v)} for k, v in sub["lang"].value_counts().head(5).items()],
        "duplicate_ratio": round(float(1 - sub["chash"].nunique() / max(1, len(sub))), 4),
        "author_top1_share": round(float(authors.iloc[0] / max(1, len(sub))), 4) if authors is not None and len(authors) else 0.0,
        "author_top10_share": round(float(authors.head(10).sum() / max(1, len(sub))), 4) if authors is not None and len(authors) else 0.0,
        "author_hhi": round(float(((authors / max(1, len(sub))) ** 2).sum()), 4) if authors is not None and len(authors) else 0.0,
        "community_top1_share": round(float(comms.iloc[0] / max(1, len(sub))), 4) if len(comms) else 0.0,
        "community_hhi": round(float(((comms / max(1, len(sub))) ** 2).sum()), 4) if len(comms) else 0.0,
        "coverage": {
            "entity": round(float((sub["entities"].map(len) > 0).mean()), 4),
            "intent": round(float((sub["intent_names"].map(lambda x: any(i != "一般讨论" for i in x))).mean()), 4),
            "sentiment": round(float((sub["sent_label"] != "未知").mean()), 4),
            "price": round(float((sub["prices"].map(len) > 0).mean()), 4),
            "scenario": round(float((sub["scenarios"].map(len) > 0).mean()), 4),
        },
        "status": _quality_status(len(sub), float(comms.iloc[0] / max(1, len(sub))) if len(comms) else 0),
    }


def _quality_status(n: int, top1_share: float) -> str:
    if n < 200:
        return "样本较少"
    if top1_share > 0.5:
        return "社区集中度较高"
    if n < 1000:
        return "样本可用（建议扩大）"
    return "样本充分"

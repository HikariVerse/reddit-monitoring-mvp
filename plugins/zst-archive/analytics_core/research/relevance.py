"""Document and passage relevance, domain induction, and feature assembly."""

import re
from collections import Counter, defaultdict
from dataclasses import asdict

import numpy as np
import pandas as pd
from cpu_runtime import managed_job, operator

from . import common as CM, entities as E, features as F, lexicon as L, populations as P
from . import knowledge, semantics
from .model_profiles import MODELS, PROFILES, profile_manifest, profile_name
from .batching import ordered_map


def phrase(term):
    words = re.findall(r"[^\W_]+", term.casefold())
    if not words:
        return None
    if all(any("\u3400" <= char <= "\u9fff" for char in word) for word in words):
        return r"[\s-]*".join(map(re.escape, words))
    last = words[-1]
    suffix = ("(?:es)?" if last.endswith(("sh", "ch", "x", "ss", "z")) else "s?") if (
        last.isascii() and last.isalpha() and not last.endswith("s")) else ""
    if last.endswith("s") and len(last) > 3 and not last.endswith(("ss", "us", "is")) and last not in {"cans", "beats"}:
        last, suffix = last[:-1], "s?"
    return r"(?<!\w)" + r"[\s-]+".join(map(re.escape, [*words[:-1], last])) + suffix + r"(?!\w)"


def pattern(terms):
    patterns = [value for term in sorted(set(terms), key=lambda s: (-len(s), s)) if (value := phrase(term))]
    return re.compile("|".join(patterns) or r"(?!)", re.I)


DOMAIN_GROUP = {
    "headphones": "audio", "earbuds": "audio", "keyboard": "keyboard",
    "ai_tool": "ai", "sleep": "sleep", "kitchen": "home", "cleaning": "home",
    "wearable": "tech", "automotive": "auto",
}
AUTO_BRANDS = {"toyota", "honda", "ford", "chevrolet", "chevy", "tesla", "bmw", "mercedes-benz",
               "volkswagen", "vw", "audi", "hyundai", "kia", "mazda", "subaru", "nissan", "volvo",
               "jeep", "buick", "lexus", "porsche", "peugeot", "renault", "mitsubishi", "cadillac"}
AUTO_TYPES = {"car", "vehicle", "automobile", "used car", "electric car", "electric vehicle",
              "hybrid car", "sports car", "rental car", "sedan", "hatchback", "pickup truck", "suv"}
AMBIGUOUS = re.compile(r"\b(?:rail|train|subway|box|elevator|cable|golf|race|game|racing) cars?\b|\b(?:cars? (?:in|on) (?:a |the )?game)\b", re.I)
CONTEXT = re.compile(r"^(?:it|they|this|that|these|those|mine|i (?:use|bought|tried|recommend|switched))\b", re.I)
NON_BRANDS = {"reddit", "google", "amazon", "valve", "purple", "beats", "hp", "us", "usa", "i"}
USE_CONTEXT = re.compile(r"\b(?:my|our|own|recommend|bought|bought a|use|use a|ordered|tried|try|got|got a)\s+(?:(?:a|an|the)\s+)?$", re.I)


def domains(seeds):
    fixed = {k for seed in seeds for k, terms in L.CATEGORIES.items() if seed.casefold() in terms}
    if any(seed.casefold() in AUTO_TYPES | {"cars", "automotive"} for seed in seeds):
        fixed.add("automotive")
    ai_seeds = set(L.BRANDS["ai"]) - {"cursor", "continue"}
    if any(seed.casefold() in ai_seeds for seed in seeds):
        fixed.add("ai_tool")
    return fixed


def classify_documents(frame, seeds):
    return classify_texts(frame.norm.tolist(), seeds)


def classify_texts(texts, seeds):
    anchor = pattern(seeds)
    automotive = "automotive" in domains(seeds)
    terms = [set(knowledge.words(seed)) for seed in seeds if knowledge.words(seed)]
    records = []
    for text in texts:
        chunks = list(semantics.sentences(text))
        direct = set()
        spans = []
        for i, (start, _, sentence) in enumerate(chunks):
            for match in anchor.finditer(sentence):
                if automotive and AMBIGUOUS.search(sentence):
                    continue
                direct.add(i)
                spans.append({"start": start + match.start(), "end": start + match.end(),
                              "text": match.group()})
        selected = sorted(direct | {i + 1 for i in direct if i + 1 < len(chunks)
                                      and CONTEXT.match(chunks[i + 1][2])})
        parts = [chunks[i] for i in selected]
        focus = "\n".join(part[2] for part in parts)
        cursor, positions = 0, []
        for start, end, sentence in parts:
            positions.append({"focus": [cursor, cursor + len(sentence)], "normalized": [start, end]})
            cursor += len(sentence) + 1
        tokens = set(knowledge.words(text)) if not direct else set()
        fallback = "scattered_terms" if any(term <= tokens for term in terms) else "thread_context"
        records.append({"pool": "core" if direct else "context", "score": float(bool(direct)),
                        "method": "bounded_phrase" if direct else fallback,
                        "matches": spans, "focus": focus, "focus_coordinates": positions})
    return records


def normalize_batch(texts):
    return [F.normalize_for_analysis(text) for text in texts]


def admit_batch(texts, seeds):
    normalized = normalize_batch(texts)
    return list(zip(normalized, classify_texts(normalized, seeds), strict=True))


def learn_dictionary(prepared, seeds, linguistic=None):
    raw = []
    for row in prepared.itertuples(index=False):
        item = {"raw": row.focus, "thread_id": row.thread_id, "community": row.community,
                **F.clean_and_tokenize(row.focus, normalized=True)}
        record = linguistic.get(row.doc_id) if linguistic else None
        if record:
            item["tokens"] = record["topic_tokens"] or item["tokens"]
            item["sentences"] = record["sentences"]
        raw.append(item)
    disc = E.discover_domain_terms(raw, seeds, min_df=4, max_docs=4500)
    domain = domains(seeds)
    brands = {brand for cat in domain for brand in L.BRANDS.get(DOMAIN_GROUP[cat], [])}
    if "automotive" in domain:
        brands |= AUTO_BRANDS
    brands = {b.lower() for b in brands} - L.GENERIC_WORD_BRANDS
    anchors = pattern(seeds)
    roles = defaultdict(set)
    role_threads = defaultdict(set)
    role_communities = defaultdict(set)
    role_cues = defaultdict(set)
    for i, item in enumerate(raw):
        for sentence in item["sentences"]:
            for anchor in anchors.finditer(sentence):
                left = sentence[max(0, anchor.start() - 28):anchor.start()]
                match = re.search(r"\b([A-Z][A-Za-z0-9-]{2,20})\s+$", left)
                cue = USE_CONTEXT.search(left[:match.start()]) if match else None
                if (match and cue and L.is_content_term(match[1].lower())
                        and match[1].lower() not in NON_BRANDS):
                    term = match[1].lower()
                    roles[term].add(i)
                    role_threads[term].add(item["thread_id"])
                    role_communities[term].add(item["community"])
                    role_cues[term].add(cue.group().split()[0].lower())
    verified = {b for b in roles if not domain and len(role_threads[b]) >= 4
                and len(role_communities[b] - {""}) >= 2 and len(role_cues[b]) >= 2}
    brands |= verified
    category = {c for c, k in L.CATEGORY_TERMS.items() if k in domain}
    if "automotive" in domain:
        category |= AUTO_TYPES
    category |= {seed.lower() for seed in seeds if seed.lower() not in brands and len(seed.split()) > 1}
    entries = {b: "BRAND" for b in brands}
    entries.update({c: "CATEGORY" for c in category})
    entries.update({k: "ATTRIBUTE" for k in L.ATTR_TERMS if k not in entries})
    entries.update({k: "SCENARIO" for k in L.SCENARIO_TERMS if k not in entries})
    category_support = Counter()
    category_rx = pattern(category)
    for item in raw:
        matches = set()
        for hit in category_rx.finditer(item["text"]):
            normalized = re.sub(r"[\s-]+", " ", hit.group().lower())
            canonical = next((k for k in (normalized, normalized.removesuffix("s"), normalized.removesuffix("es"))
                              if k in category), normalized)
            matches.add(canonical)
        category_support.update(matches)
    disc["category_candidates"] = disc["categories"]
    disc["categories"] = [
        {"term": term, "df": n, "support": round(n / max(1, len(raw)), 5)}
        for term, n in category_support.most_common(25) if n >= 3
    ]
    candidate_brands = {row["term"]: {**row, "role": "unverified"} for row in disc["brands"]}
    for term, rows in roles.items():
        if len(rows) >= 2:
            candidate_brands.setdefault(term, {"term": term, "df": len(rows)}).update(
                role="domain_brand" if term in brands else "unverified",
                role_threads=len(role_threads[term]), role_communities=len(role_communities[term] - {""}),
                role_cues=sorted(role_cues[term]))
    disc["brands"] = sorted(candidate_brands.values(), key=lambda row: (-row["df"], row["term"]))[:60]
    disc["knowledge_status"] = "validated_seed_domain" if domain else ("induced_candidates" if verified else "low_coverage")
    disc["domain"] = sorted(domain)
    disc["verified_induced_brands"] = [{"term": brand, "support": len(roles[brand])} for brand in sorted(verified)]
    if linguistic:
        from .nlp import phrase_support
        disc["linguistic_categories"] = phrase_support(linguistic, seeds)
    return E.Dictionary(entries), disc


@managed_job("v4_extract_scope")
def extract_scope(raw, spec, encoder, scope_type, report=None, progress=None, *,
                  linguistic_provider=None, open_entity_provider=None, context_provider=None, domain_provider=None):
    report = dict(report or {})
    populations = report.get("populations", {})
    source = populations.get("archive", {}).get("source", raw.attrs.get("source", "standardized"))
    version = populations.get("archive", {}).get("version", raw.attrs.get("version", "unspecified"))
    required = {"doc_id": "", "thread_id": "", "text": "", "community": "", "author": "", "kind": "",
                "title": "", "thread_title": "", "score": 0, "is_op": False, "n_comments": 0, "created_utc": 0,
                "date": None, "month": "", "parent_id": "", "hour": 0, "dow": 0, "language": "",
                "url": "", "domain": "", "content_type": "", "observed_at": None, "thread_created_utc": None}
    for column, default in required.items():
        if column not in raw:
            raw[column] = [default] * len(raw)
    if progress:
        progress("relevance", .67, f"判断 {len(raw)} 篇装配文档的正文相关性")
    batches = ordered_map(admit_batch, raw["text"].tolist(), spec.seeds, label="normalize_and_relevance")
    pairs = [pair for chunk in batches for pair in chunk]
    raw["norm"] = pd.Series([norm for norm, _ in pairs], index=raw.index, dtype=str)
    rel = [result for _, result in pairs]
    raw["relevance"] = pd.Series(rel, index=raw.index, dtype=object)
    raw["focus"] = pd.Series([r["focus"] for r in rel], index=raw.index, dtype=str)
    core_mask = raw["focus"].ne("") & raw["norm"].str.len().ge(spec.min_chars)
    if spec.kind != "all":
        core_mask &= raw["kind"].eq(spec.kind)
    core_mask &= raw["score"].ge(spec.min_score)
    eligible = raw[core_mask]
    from .nlp import baseline_record, get_provider
    selected_profile = profile_name(getattr(spec, "nlp_profile", "fast"))
    profile = PROFILES[selected_profile]
    provider = linguistic_provider or get_provider(selected_profile)
    from .contextual import enabled, local_context
    model = context_provider or local_context()
    active_models = {key for key in MODELS if enabled(profile, key, context_provider)}
    usage = {}
    parsed = {}
    if provider or open_entity_provider or active_models:
        if progress:
            progress("nlp", 0.7, f"语言学特征 {len(eligible)} 篇")
        texts = eligible["focus"].tolist()
        with operator("linguistic_pipeline"):
            records = provider.analyze(texts) if provider else [baseline_record(text) for text in texts]
        if len(records) != len(texts):
            raise ValueError("语言学供应器的输出与输入数量不一致")
        if open_entity_provider:
            for text, result in zip(texts, records):
                result["open_entities"] = open_entity_provider.extract(text)
                result["entities"] = [*result["entities"], *result["open_entities"]]
        parsed = dict(zip(eligible.doc_id, records))
    if spec.lang:
        lang = eligible["doc_id"].map(lambda doc_id: parsed[doc_id]["language"]) if parsed else eligible["norm"].map(lambda text: F.tp.detect_language(text)[0])
        lang = eligible["language"].where(eligible["language"].ne(""), lang)
        eligible = eligible[lang.eq(spec.lang)]
    context = raw.loc[~raw.index.isin(eligible.index)].copy()
    context["relevance"] = context["relevance"].map(lambda r: {**r, "pool": "context"})
    estimate = P.relevant_thread_estimate(raw, eligible, report)
    before_dedupe = eligible
    eligible, dup = F.dedupe(eligible, near=spec.near_dup)
    if dup["pairs"]:
        duplicates = before_dedupe[before_dedupe.doc_id.isin({row["doc_id"] for row in dup["pairs"]})].copy()
        duplicates["relevance"] = duplicates.relevance.map(lambda row: {**row, "pool": "duplicate_context"})
        context = pd.concat([context, duplicates], ignore_index=True)
    if progress:
        progress("dict", 0.72, f"核心 {len(eligible)} 篇，构建领域词典")
    probe = eligible[["doc_id", "focus", "thread_id", "community"]].sample(
        min(4500, len(eligible)), random_state=spec.sample_seed)
    dictionary, discovery = learn_dictionary(probe, spec.seeds, linguistic=parsed)
    domain = domain_provider or knowledge.DomainProvider()
    derived = (domain.enrich(probe, spec.seeds, parsed) | dict(knowledge.supported_topic_phrases(parsed, spec.seeds))) \
        if profile.knowledge or domain_provider else {}
    if derived:
        dictionary.update({alias: knowledge.TYPES.get(item.kind, "CANDIDATE") for alias, item in derived.items()})
        discovery["typed_entities"] = [item.record() for item in sorted(derived.values(), key=lambda item: (-item.support, item.canonical))]
        known = [entity for entity in derived.values() if entity.kind in {"brand", "company"}]
        if known:
            discovery["knowledge_status"] = "validated_external_domain" if any(
                entity.source in {"wikidata_corpus", "cpsc_corpus", "public_catalog_corpus"} for entity in known) else "validated_corpus_role"
        candidates = {row["term"]: row for row in discovery["brands"]}
        for alias, item in derived.items():
            if item.kind in {"brand", "company", "brand_candidate"}:
                candidates[alias] = {"term": alias, "df": item.support, "role": item.role, "evidence_ref": list(item.evidence_ref), "source": item.source}
        discovery["brands"] = sorted(candidates.values(), key=lambda row: (row["role"] != "domain_brand", -row["df"], row["term"]))[:75]
    if "entities" in active_models:
        entity_sample = eligible.sample(min(profile.entities, len(eligible)), random_state=spec.sample_seed)
        rows = list(entity_sample.itertuples(index=False))
        detected = model.entities([row.focus[:1600] for row in rows])
        for row, hits in zip(rows, detected, strict=True):
            parsed[row.doc_id]["open_entities"] = hits
        usage["entities"] = {"attempted": len(rows), "with_candidates": sum(bool(row) for row in detected)}
    if "rerank" in active_models and len(context):
        pool = context[context["norm"].str.len().ge(spec.min_chars)]
        signals = pattern([alias for alias, kind in dictionary.entries.items() if kind in {"BRAND", "PRODUCT", "MODEL"}])
        lexical = pool[pool.norm.map(lambda text: bool(signals.search(text)))]
        first = lexical.sample(min(profile.rerank // 2, len(lexical)), random_state=spec.sample_seed)
        other = pool.loc[~pool.index.isin(first.index)]
        candidates = pd.concat([first, other.sample(min(profile.rerank - len(first), len(other)), random_state=spec.sample_seed)])
        query = " or ".join(spec.seeds)
        scores = model.rank([(query, text) for text in candidates.norm])
        usage["rerank"] = {"attempted": len(candidates), "with_candidates": int(np.count_nonzero(scores > 0))}
        for ind, score in zip(candidates.index, scores, strict=True):
            context.at[ind, "relevance"] = {**context.at[ind, "relevance"], "pair_logit": round(float(score), 4),
                                              "semantic_status": "possible_related" if score > 0 else "unconfirmed"}
    def feature_progress(step, fraction, message):
        if progress:
            progress(step, .73 + .14 * fraction, message)

    docs = F.build_features(eligible, dictionary, progress=feature_progress if progress else None, linguistic=parsed, knowledge=derived,
                            vader=getattr(provider, "vader", None))
    if "entities" in usage:
        usage["entities"]["corroborated_mentions"] = sum(bool(item.get("corroboration")) for rows in docs.entities for item in rows)
        usage["entities"]["new_typed_mentions"] = sum(bool(item.get("corroborated")) for rows in docs.entities for item in rows)
    if active_models:
        from .v4_inference import attach
        usage.update(attach(docs, parsed, profile, active_models, model, spec.sample_seed))
    for column in ("intent_names", "brands", "attrs", "demand_states"):
        context[column] = [[] for _ in range(len(context))]
    context["sent_label"] = "未知"
    docs["solution_links"] = semantics.link_solutions(docs, context)
    docs["solution_refs"] = docs["solution_links"].map(lambda links: list(dict.fromkeys(link["doc_id"] for link in links)))
    if parsed:
        docs["linguistic"] = [parsed[row.doc_id] for row in docs.itertuples(index=False)]
    if progress:
        progress("embed", 0.9, f"向量化 {len(docs)} 篇")
    emb = encoder.encode(docs.norm.tolist(), batch_size=128, max_tokens=256) if len(docs) else np.empty((0, 0), np.float32)
    filters = asdict(spec)
    populations["research"] = P.Population("research", source, version, "document", len(docs), filters, spec.sampling).record()
    populations["semantic"] = {
        col: P.Population("semantic_eligible", source, version, "document", int(mask.sum()),
                          {"parent": populations["research"]["population_id"], "predicate": col},
                          spec.sampling).record()
        for col, mask in {
            "entity": docs["entities"].map(len).gt(0), "demand": docs["demand_states"].map(len).gt(0),
            "active_need": CM.need_mask(docs),
            "sentiment": docs["sent_label"].isin(["正面", "负面"]),
            "price": docs["prices"].map(len).gt(0),
        }.items()
    }
    report.update(spec=filters, data_version=version, populations=populations, quality=F.quality_report(docs),
                  dedupe=dup, dict_size=dictionary.size(), context_docs=len(context), core_docs=len(docs),
                  discovery={k: v for k, v in discovery.items() if k != "all_scored"}, nlp_profile=selected_profile,
                  provider_manifest=profile_manifest(selected_profile), model_usage=usage, domain_version=domain.revision(),
                  relevant_threads=estimate,
                  model={"name": getattr(encoder, "model_id", type(encoder).__name__), "dim": int(emb.shape[1])})
    return scope_type(report, docs, emb, dictionary, discovery, context)

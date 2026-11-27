"""Source-aligned business semantics shared by all modules."""

import re
from collections import defaultdict
from functools import lru_cache

from . import demand, sentiment
from .knowledge import TYPES, catalog_surface_valid, from_hit, key, target_key


SENTENCE = re.compile(r"(?:[^.!?。！？\n]|(?<=\d)\.(?=\d))+(?:[.!?。！？]+|$)?")
LATIN = re.compile(r"[A-Za-z0-9_]")
SWITCH_CUE = re.compile(r"\b(?:switch(?:ed|ing)?|migrat(?:e|ed|ing)|mov(?:e|ed|ing)|upgrad(?:e|ed|ing))\b", re.I)
REPLACE_CUE = re.compile(r"\breplac(?:e|ed|ing)\b", re.I)
MODAL = re.compile(r"\b(?:should|would|could|might|plan(?:ning)?|consider(?:ing)?|thinking (?:of|about)|may|if)\b|\?", re.I)
NEGATE = re.compile(r"\b(?:never|not|didn't|won't|can't|wouldn't|don't|doesn't|cannot|haven't)\b", re.I)
CAUSE = re.compile(r"\b(?:because(?: of)?|due to|since)\s+(.+)", re.I)
CONSTRAINT = re.compile(r"\b(?:under|max(?:imum)?|within|must(?: have)?|need(?:s)? to|with(?:out)?|at least|around)\b.{1,50}", re.I)
OPINION = re.compile(r"\b(?:love|hate|prefer|recommend|enjoy|dislike|regret|disappoint|worth|overpriced|comfortable|uncomfortable|unreliable|terrible|excellent|better|worse|amazing|bad|great|good|perfect|poor|annoying|broke|broken|failed|flimsy)\w*\b|很差|好用|不好|舒服|失望", re.I)
PURPOSE = re.compile(r"\b(?:fold\w*|portab\w*|waterproof\w*|soundproof\w*|lightweight|sturdy|compatib\w*)\b", re.I)
WORD = re.compile(r"[^\W\d_]{3,}")
SPAN_TYPES = {"BRAND", "COMPANY", "PRODUCT", "SERIES", "MODEL", "CATEGORY"}


def sentences(text):
    for part in SENTENCE.finditer(text):
        value = part.group().strip()
        if value:
            start = part.start() + len(part.group()) - len(part.group().lstrip())
            yield start, start + len(value), value


def entity_records(text, hits, discovered):
    records = []
    for hit in hits:
        if not 0 <= hit.start < hit.end <= len(text) or key(text[hit.start:hit.end]) != key(hit.surface):
            continue
        identity = from_hit(hit, discovered)
        if not catalog_surface_valid(identity, text[hit.start:hit.end]):
            continue
        if identity.source == "syntactic_domain_candidate" and identity.kind == "brand" and not any(c.isupper() for c in text[hit.start:hit.end]):
            continue
        record = {**hit.as_dict(text), **identity.record(), "target": target_key(identity),
                  "t": TYPES.get(identity.kind, hit.type), "s": text[hit.start:hit.end], "coordinate_space": "focus"}
        records.append(record)
    return records


def dependency_matcher(pipeline):
    from spacy.matcher import DependencyMatcher

    matcher = DependencyMatcher(pipeline.vocab)

    def anchor(lemmas, pos):
        return {"RIGHT_ID": "predicate", "RIGHT_ATTRS": {"LEMMA": {"IN": lemmas}, "POS": {"IN": pos}}}

    def child(on, name, *, deps=None, lemma=None):
        attrs = {"DEP": {"IN": deps}} if deps else {"LEMMA": lemma}
        return {"LEFT_ID": on, "REL_OP": ">", "RIGHT_ID": name, "RIGHT_ATTRS": attrs}

    obj = ["dobj", "obj", "attr", "acomp", "xcomp", "ccomp", "oprd", "dative"]
    subject = ["nsubj", "nsubjpass", "csubj"]
    matcher.add("demand_object", [
        [anchor(["need", "want", "seek", "require", "recommend", "suggest", "buy", "order", "purchase", "prefer"], ["VERB"]),
         child("predicate", "object", deps=obj)],
        [anchor(["look", "search", "shop"], ["VERB"]), child("predicate", "purpose", lemma="for"),
         child("purpose", "object", deps=["pobj", "pcomp"])],
    ])
    matcher.add("switch_direction", [[anchor(["switch", "move", "upgrade", "migrate"], ["VERB"]),
                                      child("predicate", "from", lemma="from"), child("from", "origin", deps=["pobj", "pcomp"]),
                                      child("predicate", "to", lemma="to"), child("to", "destination", deps=["pobj", "pcomp"])],
                                     [anchor(["replace"], ["VERB"]), child("predicate", "origin", deps=obj),
                                      child("predicate", "with", lemma="with"), child("with", "destination", deps=["pobj", "pcomp"])]])
    matcher.add("opinion_subject", [
        [{"RIGHT_ID": "predicate", "RIGHT_ATTRS": {"POS": {"IN": ["ADJ", "VERB"]}}}, child("predicate", "subject", deps=subject)],
        [{"RIGHT_ID": "predicate", "RIGHT_ATTRS": {"LEMMA": "be"}}, child("predicate", "subject", deps=subject),
         child("predicate", "opinion", deps=["attr", "acomp"])],
    ])
    matcher.add("purchase_object", [[anchor(["pay", "cost", "buy", "spend", "order", "charge"], ["VERB"]),
                                     child("predicate", "object", deps=obj)]])
    return matcher


def dependency_records(matcher, doc):
    return [{"rule": doc.vocab.strings[rule], "lemma": doc[ids[0]].lemma_,
             "start": doc[ids[0]].idx, "end": doc[ids[0]].idx + len(doc[ids[0]]),
             "arguments": [{"text": doc[i].text, "start": doc[i].idx, "end": doc[i].idx + len(doc[i])} for i in ids[1:]],
             "negated": any(c.dep_ == "neg" for c in doc[ids[0]].children),
             "sentence_start": doc[ids[0]].sent.start_char} for rule, ids in matcher(doc)]


def demand_states(text, linguistic):
    output = demand.extract(text, linguistic.get("sentences") or None)
    for start, end, sentence in sentences(text):
        negative = bool(NEGATE.search(sentence))
        local = [item for item in output if start <= item["start"] < end]
        rejected_intent = re.compile(r"\b(?:don't|doesn't|wouldn't|would not|do not|cannot|can't|never)\s+(?:really\s+)?(?:recommend|suggest|buy|use|try|need|want)\b", re.I)
        if rejected_intent.search(sentence):
            local = [item for item in local if item["state"] in {"unmet_need", "solution_rejected", "solution_dissatisfied"}]
            output = [item for item in output if not start <= item["start"] < end] + local
        constraints = [match.group() for match in CONSTRAINT.finditer(sentence)]
        for item in local:
            item.update(method="demand_rules_v4", constraints=constraints, coordinate_space="focus")
        existing = {item["state"] for item in local}
        for dep in linguistic.get("dependencies", ()):
            if dep["rule"] != "demand_object" or not start <= dep["start"] < end or dep["negated"]:
                continue
            state = {"need": "explicit_need", "want": "explicit_need", "seek": "explicit_need", "require": "explicit_need",
                     "look": "explicit_need", "search": "explicit_need", "shop": "purchase_intent", "buy": "purchase_intent",
                     "order": "purchase_intent", "purchase": "purchase_intent", "prefer": "alternative_considered"}.get(dep["lemma"])
            # An infinitive such as "to buy" in a statement about someone else is weak evidence.
            if state and state not in existing and not negative and re.search(r"\b(?:i|we|my|our)\b", sentence, re.I):
                if state == "purchase_intent" and not MODAL.search(sentence) and re.search(r"\b(?:bought|ordered|purchased)\b", sentence, re.I):
                    state = "purchased"
                output.append({"state": state, "sentence": sentence, "start": start, "end": end,
                               "matched": sentence, "rule_id": dep["rule"], "method": "spacy_dependency_matcher",
                               "constraints": constraints, "argument": dep["arguments"][-1], "coordinate_space": "focus"})
                existing.add(state)
        additional = {
            "alternative_considered": bool(re.search(r"\b(?:considering|alternatives? to|instead of|other options)\b", sentence, re.I)),
            "switch_intent": bool(SWITCH_CUE.search(sentence) and MODAL.search(sentence) and not negative),
            "switched": bool(re.search(r"\b(?:switched|migrated|upgraded|moved)\s+(?:from|to)\b", sentence, re.I) and not MODAL.search(sentence) and not negative),
        }
        for state, active in additional.items():
            if active and state not in existing:
                output.append({"state": state, "sentence": sentence, "start": start, "end": end, "matched": sentence,
                               "constraints": constraints, "rule_id": state, "method": "demand_rules_v4", "coordinate_space": "focus"})
    return output


def relations(text, entities, linguistic):
    result = []
    for start, end, sentence in sentences(text):
        endpoints = [item for item in entities if item["t"] in SPAN_TYPES and start <= item["start"] < item["end"] <= end]
        if len({item["entity_id"] for item in endpoints}) < 2:
            continue
        cue = SWITCH_CUE.search(sentence) or REPLACE_CUE.search(sentence)
        matches = [item for item in linguistic.get("dependencies", ()) if item["rule"] == "switch_direction"
                   and start <= item["start"] < end]
        pairs = []
        if cue:
            marker = list(re.finditer(r"\b(?:from|to|with)\b", sentence[cue.end():], re.I))
            args = {}
            for i, match in enumerate(marker):
                a = start + cue.end() + match.end()
                b = start + cue.end() + marker[i + 1].start() if i + 1 < len(marker) else end
                local = [e for e in endpoints if a <= e["start"] < e["end"] <= b]
                if local:
                    args[match.group().lower()] = min(local, key=lambda e: (e["t"] == "CATEGORY", e["start"]))
            if "from" in args and "to" in args:
                pairs.append((args["from"], args["to"], "替换/切换"))
            elif REPLACE_CUE.search(sentence) and "with" in args:
                possible = [e for e in endpoints if start + cue.end() <= e["start"] < args["with"]["start"]]
                if possible:
                    pairs.append((min(possible, key=lambda e: (e["t"] == "CATEGORY", e["start"])), args["with"], "替换/切换"))
        on_topic = [e for e in endpoints if e["t"] != "CATEGORY"]
        pairs.extend((a, b, None) for a, b in zip(on_topic or endpoints, (on_topic or endpoints)[1:]))
        for a, b, forced in pairs:
            if a["entity_id"] == b["entity_id"] or (forced is None and a["end"] > b["start"]):
                continue
            between = text[a["end"]:b["start"]]
            preceding = text[max(start, a["start"] - 40):a["start"]]
            method = "bounded_pair_v4"
            if forced:
                kind = forced
                if matches:
                    method = "spacy_dependency_matcher"
            elif re.search(r"\b(?:instead of|alternative to)\b", between, re.I):
                kind, a, b = "替代方案", b, a
            elif re.search(r"\b(?:vs\.?|versus|compared (?:to|with)|better than|worse than)\b", between, re.I):
                kind = "比较"
            elif re.search(r"\b(?:use|run|pair)\w*\b", preceding, re.I) and re.search(r"\b(?:alongside|together with|with)\b", between, re.I):
                kind = "搭配使用"
            else:
                continue
            status = "negated" if NEGATE.search(sentence) or any(item["negated"] for item in matches) else "planned" if MODAL.search(sentence) else "reported"
            if kind == "替换/切换" and status == "reported" and cue and not re.search(r"(?:ed)$", cue.group(), re.I):
                status = "unspecified"
            because = CAUSE.search(sentence)
            left, right = ({k: item[k] for k in ("entity_id", "start", "end", "s", "t", "target", "canonical")} for item in (a, b))
            result.append({"type": kind, "a": a["s"], "b": b["s"], "source": left, "target": right,
                           "start": start, "end": end, "sentence": sentence, "coordinate_space": "focus",
                           "directed": kind in {"替换/切换", "替代方案"}, "state": status, "method": method,
                           "reason": because[1].strip(" .!?") if because else None})
    return result[:16]


MONEY = re.compile(r"(?<![\w.])(?:(?P<pre>US\$|CA\$|AU\$|HK\$|NZ\$|USD|CAD|AUD|EUR|GBP|CNY|JPY|[\$€£¥])\s*)?"
                   r"(?P<lower>\d{1,3}(?:,\d{3})+(?:\.\d{1,2})?|\d{1,7}(?:\.\d{1,2})?)"
                   r"(?:\s*(?:–|—|-(?=\s*[$\d])|\bto\b)\s*\$?\s*(?P<upper>\d{1,7}(?:\.\d{1,2})?))?"
                   r"(?:[ \t]*(?P<post>USD|CAD|AUD|EUR|GBP|CNY|JPY|dollars?|bucks|euros?|pounds?|元))?(?!\w|\.\d)", re.I)
PRICE_KIND = {
    "预算": r"\b(?:budget|afford|under|maximum|max|up to|at most|willing to spend|no more than)\b|预算|以内",
    "实付": r"\b(?:paid|purchased|bought|spent|ordered|got (?:it|them) for)\b|实付|买了",
    "标价": r"\b(?:msrp|rrp|list price|retail(?:s)? for|listed)\b|标价",
    "折扣": r"\b(?:sale|discount\w*|coupon|deal|off|down from)\b|打折|降价",
    "订阅": r"\b(?:subscription|subscribe|per month|per year|annual billing)\b|订阅",
    "性价比": r"\b(?:worth|overpriced|value for money|rip.?off)\b|值不值|性价比",
}
PRICE_RE = {kind: re.compile(rx, re.I) for kind, rx in PRICE_KIND.items()}
CURRENCIES = {"us$": "USD", "ca$": "CAD", "au$": "AUD", "hk$": "HKD", "nz$": "NZD", "$": "unknown_dollar",
              "€": "EUR", "£": "GBP", "¥": "unknown_yen_yuan", "dollar": "unknown_dollar", "dollars": "unknown_dollar",
              "buck": "unknown_dollar", "bucks": "unknown_dollar", "euro": "EUR", "euros": "EUR", "pound": "GBP",
              "pounds": "GBP", "元": "CNY"}
UNIT = re.compile(r"(?<![\w.])(\d+(?:\.\d+)?)\s*(kg|lb|lbs|mg|g|mm|cm|km|inch(?:es)?|oz|°C|°F|GiB|MiB|GB|MB|Wh|mAh)(?!\w)", re.I)
UNIT_NAMES = {"lbs": "pound", "lb": "pound", "inch": "inch", "inches": "inch", "oz": "ounce", "°c": "degC",
              "°f": "degF", "gib": "gibibyte", "mib": "mebibyte", "gb": "gigabyte", "mb": "megabyte", "wh": "watt_hour",
              "mah": "milliampere_hour"}


@lru_cache(maxsize=1)
def pint_registry():
    try:
        from pint import UnitRegistry
    except ImportError:
        return None
    return UnitRegistry()


def measurements(text):
    output = []
    registry = pint_registry() if UNIT.search(text) else None
    for match in UNIT.finditer(text):
        value = float(match[1])
        unit = UNIT_NAMES.get(match[2].casefold(), match[2].casefold())
        item = {"value": value, "unit": unit, "start": match.start(), "end": match.end(), "coordinate_space": "focus"}
        if registry:
            quantity = registry.Quantity(value, unit).to_base_units()
            item.update(si_value=float(quantity.magnitude), si_unit=f"{quantity.units:~}", method="pint")
        output.append(item)
    return output[:24]


def prices(text, linguistic, entities):
    if not re.search(r"[$€£¥]|(?i:\b(?:usd|cad|aud|eur|gbp|cny|jpy|dollars?|euros?|bucks)\b)|元", text):
        return []
    output = []
    for start, end, sentence in sentences(text):
        for m in MONEY.finditer(sentence):
            indicator = m["post"] or m["pre"]
            if not indicator:
                continue
            # Weight "pounds" is a measurement unless the clause has a financial cue.
            if indicator.lower().startswith("pound") and not any(rule.search(sentence) for rule in PRICE_RE.values()):
                continue
            amount = float(m["lower"].replace(",", ""))
            upper = float(m["upper"]) if m["upper"] else None
            if amount <= 0 or amount > 10_000_000 or (upper is not None and upper < amount):
                continue
            left, right = start + m.start(), start + m.end()
            cues = [(min(abs(cue.end() - m.start()), abs(cue.start() - m.end())), name)
                    for name, rule in PRICE_RE.items() for cue in rule.finditer(sentence)]
            kind = min(cues)[1] if cues else "未分类"
            suffix = sentence[m.end():m.end() + 24]
            period = "monthly" if re.search(r"/\s*mo\b|per month|monthly", suffix, re.I) else (
                "annual" if re.search(r"/\s*yr\b|per year|yearly|annually", suffix, re.I) else "unspecified")
            currency = CURRENCIES.get(indicator.lower(), indicator.upper())
            target = min((e for e in entities if e["t"] in SPAN_TYPES and start <= e["start"] < e["end"] <= end),
                         key=lambda e: abs(e["end"] - left), default=None)
            dependency = any(dep["rule"] == "purchase_object" and start <= dep["start"] < end
                             for dep in linguistic.get("dependencies", ()))
            output.append({"value": amount, "upper": upper, "currency": currency, "kind": kind, "period": period,
                           "context": sentence, "raw": text[left:right], "start": left, "end": right,
                           "target_id": target["entity_id"] if target else None, "coordinate_space": "focus",
                           "method": "price_clause_dependency" if dependency and kind == "实付" else "money_span_v4"})
    return output[:24]


CONTRAST = re.compile(r"[;；]|\b(?:but|however|whereas|although)\b|但是|不过", re.I)


def classify_opinion(text, *, vader=None, features=None):
    if not OPINION.search(text) and not (features or {}).get("pos") and not (features or {}).get("neg"):
        return {"label": "非观点", "score": 0., "method": "opinion_gate"}
    lex = features or sentiment.doc_sentiment(text)
    if vader:
        compound = float(vader["compound"])
        label = "正面" if compound >= .12 else "负面" if compound <= -.12 else (
            "含混" if vader["pos"] > .15 and vader["neg"] > .15 else "中性")
        return {"label": label, "score": round(compound, 4), "method": "vader_en", "comparison_baseline": lex["label"]}
    return {**lex, "method": "opinion_lexicon"}


def opinions(text, entities, linguistic, *, vader=None):
    result = []
    contrast = bool(CONTRAST.search(text))
    for start, end, sentence in sentences(text):
        boundaries = [(start, start)] + [(start + m.start(), start + m.end()) for m in CONTRAST.finditer(sentence)] + [(end, end)]
        for left, right in zip(boundaries, boundaries[1:]):
            a, b = left[1], right[0]
            opinion = OPINION.search(text, a, b)
            if opinion is None:
                continue
            region = [e for e in entities if a <= e["start"] < e["end"] <= b]
            targets = [e for e in region if e["t"] in SPAN_TYPES]
            attrs = [e for e in region if e["t"] == "ATTRIBUTE"]
            if not attrs or not targets:
                continue
            dep = next((dep for dep in linguistic.get("dependencies", ()) if dep["rule"] == "opinion_subject"
                        and a <= dep["start"] < b), None)
            subject = dep["arguments"][0] if dep else None
            target = min(targets, key=lambda e: (e["t"] == "CATEGORY", 0 if subject and e["start"] <= subject["start"] < e["end"] else 1,
                                                 abs(e["end"] - opinion.start())))
            attribute = min(attrs, key=lambda e: abs(e["start"] - opinion.start()))
            clause = text[a:b]
            scored = classify_opinion(clause, vader=vader.polarity_scores(clause) if vader else None)
            result.append({"entity": target["s"], "entity_type": target["t"], "canon": target["target"] or target["canonical"],
                           "target_id": target["entity_id"], "target_span": [target["start"], target["end"]],
                           "attribute": attribute["s"], "attribute_canon": attribute["canonical"],
                           "attribute_span": [attribute["start"], attribute["end"]], "opinion_span": [opinion.start(), opinion.end()],
                           "opinion": opinion.group(), "sentiment": scored["label"], "score": scored["score"],
                           "context": clause, "start": a, "end": b, "coordinate_space": "focus",
                           "negated": bool(NEGATE.search(clause)), "contrast": contrast,
                           "comparison": bool(re.search(r"\b(?:than|versus|compared)\b", clause, re.I)),
                           "method": "spacy_dependency_matcher" if dep else "bounded_opinion_clause",
                           **({"entity_corroboration": target["corroboration"]} if target.get("corroboration") else {}),
                           **({"attribute_corroboration": attribute["corroboration"]} if attribute.get("corroboration") else {}),
                           "sentiment_method": scored["method"]})
    return result[:16]


def content_words(text):
    import textproc

    return {word for word in WORD.findall(text.casefold()) if word not in textproc.STOPWORDS["en"]}


def link_solutions(core, context):
    """Attach direct, author-checked replies and preserve acceptance as an independent observation."""
    by_parent = defaultdict(list)
    all_rows = [*core.itertuples(index=False), *context.itertuples(index=False)]
    roots = defaultdict(list)
    inferred = defaultdict(list)
    for row in all_rows:
        if row.parent_id:
            by_parent[row.parent_id].append(row)
        if row.kind == "post":
            roots[row.thread_id].append(row.doc_id)
        elif row.kind == "comment" and not row.parent_id:
            inferred[row.thread_id].append(row)

    def compatible(parent, reply):
        return (parent.thread_id == reply.thread_id and parent.created_utc is not None and reply.created_utc is not None
                and reply.created_utc >= parent.created_utc)

    def acceptance(need, reply):
        if not need.author:
            return "unknown", None
        for row in by_parent[reply.doc_id]:
            if row.author != need.author or not compatible(reply, row):
                continue
            states = {item["state"] for item in (row.demand_states or demand.extract(row.norm))}
            if "solution_accepted" in states:
                return "accepted", row.doc_id
            if "solution_rejected" in states:
                return "rejected", row.doc_id
        return "unknown", None

    results = []
    for need in core.itertuples(index=False):
        states = {item["state"] for item in need.demand_states}
        links = []
        if states & demand.ACTIVE:
            if states & {"solution_satisfied", "workaround", "partial_solution"}:
                links.append({"doc_id": need.doc_id, "method": "within_document", "acceptance": "unknown"})
            terms = content_words(need.norm)
            required = set(PURPOSE.findall(need.norm.casefold()))
            direct = by_parent[need.doc_id]
            fallback = inferred[need.thread_id] if roots[need.thread_id] == [need.doc_id] else []
            for reply in [*direct, *fallback]:
                author_is_distinct = need.author and reply.author and need.author != reply.author
                if not author_is_distinct or not compatible(need, reply):
                    continue
                hits = reply.demand_states or demand.extract(reply.norm)
                solution = next((item for item in hits if item["state"] in demand.SOLUTIONS), None)
                if not solution:
                    continue
                overlap = content_words(reply.norm) & terms
                same_constraint = bool({word[:4] for word in required} & {word[:4] for word in PURPOSE.findall(reply.norm.casefold())})
                if (required and not same_constraint) or (not required and not overlap and not reply.brands):
                    continue
                discussed, decision = acceptance(need, reply)
                method = "single_thread_root_inferred" if not reply.parent_id else (
                    "direct_reply_constraint" if required else "direct_reply_overlap")
                links.append({"doc_id": reply.doc_id, "method": method,
                              "acceptance": discussed, "acceptance_doc_id": decision, "constraint_match": same_constraint,
                              "shared_terms": sorted(overlap)[:12], "evidence_ref": [need.doc_id, reply.doc_id] + ([decision] if decision else [])})
        results.append(links)
    return results

"""Separate corpus support from external provenance and canonical entity identity."""

from collections import defaultdict
from dataclasses import dataclass, asdict
from functools import lru_cache
from pathlib import Path
import hashlib
import json
import re
from urllib.parse import quote

from . import lexicon as L

ROOT = Path(__file__).resolve().parents[2] / "data" / "knowledge-v4"
VERSION = "domain-2026.11.4.1"
TOKEN = re.compile(r"[^\W_]+", re.UNICODE)
COMPANY_SUFFIX = re.compile(r"\s+(?:usa|us|america|north america|international|group|incorporated|inc|corp|ltd|llc|gmbh|limited|co|company)\.?$", re.I)
GENERIC = set("amazon walmart target ebay marketplace reddit baby kids store company unknown generic brand tent stroller outdoors outdoor new mini max pro best model travel single double used we you the this that facebook recommend which warranty honda sure review one prime budget".split()) | L.GENERIC_WORD_BRANDS


def words(text):
    return tuple(word.casefold() for word in TOKEN.findall(text or ""))


def root_word(word):
    if len(word) < 5:
        return word
    return word.removesuffix("es") if word.endswith(("ches", "shes", "xes")) else word.removesuffix("s")


def key(text):
    return " ".join(words(text))


def stable_id(kind, name):
    return kind + ":" + hashlib.sha256(key(name).encode()).hexdigest()[:16]


@dataclass(frozen=True)
class Entity:
    kind: str
    canonical: str
    aliases: tuple[str, ...]
    role: str
    source: str
    confidence: float
    parent: str | None = None
    evidence_ref: tuple[str, ...] = ()
    sources: tuple[str, ...] = ()
    support: int = 0

    @property
    def entity_id(self):
        return stable_id(self.kind, self.canonical)

    def record(self):
        return {**asdict(self), "entity_id": self.entity_id}


class DomainProvider:
    """Reads pinned local snapshots. A replacement implements enrich and revision."""

    def __init__(self, root=ROOT):
        self.root = root

    def files(self):
        return tuple(sorted(self.root.glob("*.json"))) + tuple(self.root.glob("google-taxonomy.txt"))

    def revision(self):
        files = self.files()
        return _revision(tuple((str(path), path.stat().st_mtime_ns, path.stat().st_size) for path in files))

    def enrich(self, corpus, seeds, linguistic):
        resources = _read(tuple(str(path) for path in self.files()), self.revision())
        return enrich(corpus, seeds, linguistic, resources)


@lru_cache(maxsize=4)
def _revision(files):
    digest = hashlib.sha256(VERSION.encode())
    for path, _, _ in files:
        digest.update(Path(path).name.encode())
        digest.update(Path(path).read_bytes())
    return digest.hexdigest()[:16]


@lru_cache(maxsize=4)
def _read(files, revision):
    recalls, categories, wikidata, catalogs = [], [], [], []
    for filename in files:
        path = Path(filename)
        if path.suffix == ".json":
            value = json.loads(path.read_text(encoding="utf-8"))
            if path.name.startswith("wikicatalog-"):
                catalogs.append(value)
            else:
                target = wikidata if path.name.startswith("wikidata-") else recalls
                target.extend((value["category"], row) for row in value["records"])
        else:
            for line in path.read_text(encoding="utf-8-sig").splitlines():
                ident, sep, description = line.partition(" - ")
                if sep and ident.isdecimal():
                    hierarchy = description.split(" > ")
                    categories.append((ident, hierarchy))
    return recalls, categories, wikidata, catalogs


def related(name, seeds):
    content = set(map(root_word, words(name)))
    return any(set(map(root_word, words(seed))) <= content for seed in seeds if words(seed))


def names_for_company(name):
    name = re.split(r",\s+(?:of|based in)\s+", name or "", maxsplit=1, flags=re.I)[0].strip(" ,.")
    previous = None
    while previous != name:
        previous, name = name, COMPANY_SUFFIX.sub("", name.strip(" ,.")).strip(" ,.")
    result = {name}
    if len(words(name)) >= 2:
        first = TOKEN.search(name).group()
        if len(first) >= 4:
            result.add(first)
    return {value for value in result if 3 <= len(value) <= 50 and key(value) not in GENERIC
            and len(words(value)) <= 4}


def catalog_surface_valid(entity, surface):
    if entity.source != "public_catalog_corpus":
        return True
    if entity.canonical.isupper() and len(entity.canonical) <= 5:
        return surface == entity.canonical
    return len(words(entity.canonical)) > 1 or any(ch.isupper() for ch in surface)


def product_candidates(resources, seeds):
    recalls, categories, wikidata, catalogs = resources
    candidates = {}
    for data in catalogs:
        topic = data["category"]
        if not (related(topic, seeds) or related(" ".join(seeds), [topic])):
            continue
        kind = "brand" if "brands" in data["catalog"].casefold().split() else "company"
        source = "https://en.wikipedia.org/wiki/Category:" + quote(data["catalog"].replace(" ", "_"))
        for record in data["records"]:
            title = record["title"]
            if re.search(r"^(?:List of|Comparison of)\b|\((?:retailer|store|shop|journal|magazine|event)\)$", title, re.I):
                continue
            name = re.sub(r" \([^)]+\)$", "", title)
            term = key(name)
            if len(term) < 3 or len(term) > 45 or term in GENERIC or related(name, [topic]):
                continue
            item = Entity(kind, name, (name,), "domain_brand" if kind == "brand" else "sector_manufacturer", "public_catalog_corpus", .77,
                          sources=(source, "https://en.wikipedia.org/?curid=" + str(record["pageid"])))
            candidates.setdefault(term, item)
    for category, row in wikidata:
        if not (related(category, seeds) or related(" ".join(seeds), [category])):
            continue
        description = row["description"]
        if not related(f"{row['label']} {description}", [category]):
            continue
        if re.search(r"\b(?:manufacturer|manufacturing company|brand|producer)\b", description, re.I):
            kind = "brand" if re.search(r"\bbrand\b", description, re.I) else "company"
            for alias in (row["label"], *row["aliases"]):
                surface = key(alias)
                if surface and surface not in GENERIC and len(surface) >= 3:
                    candidates[surface] = Entity(kind, row["label"], (row["label"], *row["aliases"]), "domain_" + kind,
                                                 "wikidata_corpus", .9, sources=(f"https://www.wikidata.org/wiki/{row['id']}",))
        for kind in ("brand", "company"):
            for record in row[kind]:
                if not record["label"]:
                    continue
                aliases = (record["label"], *record["aliases"])
                for alias in aliases:
                    surface = key(alias)
                    if not surface or surface in GENERIC or len(surface) < 3 or len(surface) > 50:
                        continue
                    candidates[surface] = Entity(kind, record["label"], tuple(aliases),
                                                 "domain_brand" if kind == "brand" else "manufacturer", "wikidata_corpus", .9,
                                                 sources=(f"https://www.wikidata.org/wiki/{record['id']}",
                                                          f"https://www.wikidata.org/wiki/{row['id']}"))
    for category, row in recalls:
        if not (related(category, seeds) or related(" ".join(seeds), [category])):
            continue
        url = row.get("URL") or ""
        products = [p for p in row.get("Products") or [] if p and related(p.get("Name"), [category])]
        if not products or not url:
            continue
        fields = [row.get("Title") or "", *(p.get("Name") or "" for p in products)]
        for field in ("Manufacturers", "Importers", "Distributors"):
            for record in row.get(field) or []:
                aliases = names_for_company(record.get("Name"))
                if not aliases:
                    continue
                legal = max(aliases, key=lambda value: (len(value), value))
                for alias in aliases:
                    forms = words(alias)
                    explicitly_named = any(re.search(r"(?<!\w)" + re.escape(alias) + r"(?!\w)", text, re.I) for text in fields)
                    kind = "brand" if explicitly_named else "company"
                    surface = " ".join(forms)
                    item = Entity(kind, alias if explicitly_named else legal, (alias,),
                                  "domain_brand" if explicitly_named else "manufacturer", "cpsc_corpus", .8,
                                  None if legal == alias else stable_id("company", legal), sources=(url,))
                    if surface not in candidates or kind == "brand":
                        candidates[surface] = item
    taxonomy_names = {key(hierarchy[-1]): ident for ident, hierarchy in categories if related(hierarchy[-1], seeds)}
    for ident, hierarchy in categories:
        leaf = hierarchy[-1]
        if key(leaf) not in taxonomy_names:
            continue
        parent = "google-product-taxonomy:" + key(hierarchy[-2]) if len(hierarchy) > 1 else None
        entries = {key(leaf), " ".join(map(root_word, words(leaf)))}
        for alias in entries:
            candidates[alias] = Entity("subcategory" if len(hierarchy) > 2 else "category", leaf, tuple(sorted(entries)),
                                       "domain_category", "google_taxonomy_corpus", .9, parent,
                                       sources=(f"https://www.google.com/basepages/producttype/taxonomy-with-ids.en-US.txt#{ident}",))
    return candidates


def enrich(corpus, seeds, linguistic, resources):
    candidates = product_candidates(resources, seeds)
    aliases = re.compile("|".join(r"(?<!\w)" + re.escape(alias).replace(r"\ ", r"[\s-]+") + r"(?!\w)"
                                 for alias in sorted(candidates, key=lambda a: (-len(a), a))) or r"(?!)", re.I)
    support, contexts, formal = defaultdict(set), defaultdict(set), defaultdict(set)
    qualified, role_support, communities, independent_roles = defaultdict(set), defaultdict(set), defaultdict(set), defaultdict(set)
    roots = {root_word(word) for seed in seeds for word in words(seed)[-1:] if len(word) >= 4}
    brand_cue = re.compile(r"\b(?:own|buy|bought|ordered|use|using|prefer|recommend|tried|got|have|my|our|with)\s+(?:(?:a|an|the|my)\s+)?$", re.I)
    plausible = re.compile(r"[A-Z][\w-]{2,}(?:\s+[A-Z][\w-]{2,})?")
    for row in corpus.itertuples(index=False):
        record = linguistic.get(row.doc_id, {})
        noun_spans = [(chunk["start"], chunk["end"]) for chunk in record.get("noun_phrases", ())]
        for match in aliases.finditer(row.focus):
            name = key(match.group())
            item = candidates[name]
            if not catalog_surface_valid(item, match.group()):
                continue
            if item.kind in {"company", "brand"}:
                in_noun = any(a <= match.start() and match.end() <= b for a, b in noun_spans)
                capitalized = any(ch.isupper() for ch in match.group())
                # For broad public catalogs an anchored passage and proper name shape must jointly support a local mention.
                if capitalized and (in_noun or item.source != "public_catalog_corpus"):
                    formal[name].add(row.thread_id)
            support[name].add(row.doc_id)
            contexts[name].add(row.thread_id)
        for chunk in record.get("noun_phrases", ()):
            if root_word(chunk["head"].casefold()) not in roots:
                continue
            for match in plausible.finditer(chunk["text"]):
                surface = key(match.group())
                if len(surface) < 3 or surface in GENERIC or any(word in roots or word in L.FUNCTION_WORDS for word in words(surface)):
                    continue
                boundary = chunk["start"] + match.start()
                # A noun modifier at the beginning of a sentence alone is weak evidence.
                cue = brand_cue.search(row.focus[max(0, boundary - 50):boundary])
                lemma = match.group()
                if cue or (boundary and row.focus[boundary - 2:boundary] not in {". ", "! ", "? "}
                           and chunk["text"][match.end():].strip() and len(words(lemma)) > 1):
                    qualified[surface].add(row.doc_id)
                    role_support[surface].add(row.thread_id)
                    if cue:
                        independent_roles[surface].add(cue.group().split()[0].lower())
                    if row.community:
                        communities[surface].add(row.community)
    output = {alias: Entity(item.kind, item.canonical, item.aliases, item.role, item.source, item.confidence,
                            item.parent, tuple(sorted(support[alias])[:12]), item.sources, len(support[alias]))
              for alias, item in candidates.items() if len(contexts[alias]) >= 2 and (
                  item.kind in {"category", "subcategory"} or len(formal[alias]) >= (3 if item.source == "public_catalog_corpus" else 2))}
    # Corpus-only names can be examined independently. They do not certify brand coverage.
    for name, documents in qualified.items():
        if name not in output and len(role_support[name]) >= 4 and (len(communities[name]) >= 2 or len(documents) >= 8):
            confirmed_role = len(role_support[name]) >= 8 and len(communities[name]) >= 2 and len(independent_roles[name]) >= 3
            output[name] = Entity("brand" if confirmed_role else "brand_candidate", name, (name,),
                                  "corpus_domain_brand" if confirmed_role else "unverified", "syntactic_domain_candidate",
                                  .71 if confirmed_role else .55, evidence_ref=tuple(sorted(documents)[:12]), support=len(documents))
    return output


def supported_topic_phrases(linguistic, seeds):
    from .nlp import phrase_support

    for item in phrase_support(linguistic, seeds):
        name = item["term"]
        if item["df"] >= 5 and not any(word in GENERIC for word in words(name)[:-1]):
            yield name, Entity("subcategory_candidate", name, (name,), "unverified", "noun_phrase_head", .55,
                               evidence_ref=tuple(item["evidence_ref"]), support=item["df"])


BASE_ENTITIES = (
    Entity("company", "OpenAI", ("openai",), "provider", "v3_alias_migration", .98),
    Entity("product", "ChatGPT", ("chatgpt",), "product", "v3_alias_migration", .98, stable_id("company", "OpenAI")),
    Entity("series", "GPT", ("gpt", "gpt-4", "gpt-5"), "product_family", "v3_alias_migration", .96, stable_id("company", "OpenAI")),
    Entity("company", "Anthropic", ("anthropic",), "provider", "v3_alias_migration", .98),
    Entity("series", "Claude", ("claude",), "product_family", "v3_alias_migration", .96, stable_id("company", "Anthropic")),
    Entity("product", "Claude Code", ("claude code",), "product", "v3_alias_migration", .98, stable_id("company", "Anthropic")),
    Entity("company", "Apple", ("apple",), "manufacturer", "v3_alias_migration", .96),
    Entity("series", "AirPods", ("airpods",), "product_family", "v3_alias_migration", .98, stable_id("company", "Apple")),
    Entity("brand", "Instant Pot", ("instant pot", "instantpot"), "domain_brand", "v3_alias_migration", .98),
)
ALIAS_REGISTRY = {alias: item for item in BASE_ENTITIES for alias in item.aliases}
ENTITIES_BY_ID = {item.entity_id: item for item in BASE_ENTITIES}
TYPES = {"brand": "BRAND", "company": "COMPANY", "product": "PRODUCT", "series": "SERIES",
         "model": "MODEL", "category": "CATEGORY", "subcategory": "CATEGORY", "attribute": "ATTRIBUTE"}


def from_hit(hit, discovered):
    alias = hit.canon
    item = discovered.get(alias) or ALIAS_REGISTRY.get(alias)
    return item or Entity(hit.type.lower(), alias, (alias,), "domain_" + hit.type.lower(), "bounded_dictionary", .75)


def target_key(item):
    parent = ENTITIES_BY_ID.get(item.parent)
    if item.kind in {"company", "brand"}:
        return item.canonical.casefold()
    if parent and parent.kind == "company":
        return parent.canonical.casefold()
    return None

"""Extract explicit demand states with sentence evidence and link replies conservatively."""

import re

from .intents import split_sentences


RULES = {state: re.compile(pattern, re.I) for state, pattern in {
    "explicit_need": (
        r"\b(?:i|we)\s+(?:am|are|'m|'re)?\s*(?:really\s+)?(?:looking for|searching for|shopping for|in the market for)\b"
        r"|\b(?:i|we)\s+(?:really\s+)?(?:need|want)\s+(?:a|an|some|new|better|good|cheap\w*|budget|portable|reliable|quiet|sweatproof|open[- ]ear)\b"
        r"|\bwants? to (?:buy|get)\s+(?:a|an|one|something like)\b"
        r"|想买|想入手|准备入手|打算入手|想换|求购|想找个|想找一款|需要买|需要一款|需要一个"
    ),
    "recommendation_request": r"\b(?:any recommendations?|need recommendations?|can (?:you|anyone) recommend|what (?:do you recommend|should i buy)|should i buy|best alternative|help me (?:choose|pick)|is there (?:any|a)\s+(?:good|better|option|alternative))\b|求推荐|推荐一下|有什么推荐|怎么选|替代推荐",
    "unmet_need": r"\b(?:still (?:need|looking for|can't find|cannot find|doesn't work)|nothing (?:has worked|works)|haven't found|can't find (?:anything|one|a)|no (?:good|viable) options?)\b|\bis there .*\b(?:actually|that) works\b|还没找到",
    "partial_solution": r"\b(?:works|great|good|love|like)\b.{0,100}\b(?:except|but)\b.{0,100}\b(?:hard|missing|doesn't|cannot|can't|poor|bad|fails|issue|problem)\b|好用但是",
    "solution_mentioned": r"\b(?:i|we) (?:use|used|fixed it (?:by|with)|solved it (?:by|with)|went with)\b|\b(?:the fix|our solution) (?:is|was)\b|用的是",
    "solution_recommended": r"\b(?:i (?:would )?recommend|you (?:could|should) (?:try|use|buy)|try (?:using|the|a)|consider (?:using|the))\b|建议试试",
    "solution_accepted": r"\b(?:that (?:worked|fixed it|solved it)|your (?:suggestion|advice) worked|thanks.{0,50}that did it)\b|这个方法有效",
    "solution_rejected": r"\b(?:that (?:didn't work|doesn't work|won't work)|your (?:suggestion|advice) didn't work|no thanks)\b|这个方法没用",
    "solution_satisfied": r"\b(?:works (?:great|perfectly|well|for me)|(?:i'm|i am) (?:very )?happy with)\b|很满意",
    "solution_dissatisfied": r"\b(?:i regret buying|i am disappointed with|keeps failing|still doesn't work)\b|不满意",
    "workaround": r"\b(?:workaround|stopgap|as a temporary fix|jury[- ]rig\w*|i (?:built|made) my own)\b|临时方案|变通方案",
    "feature_request": r"\b(?:i wish (?:it|they)|should add|please add|needs (?:a|an|the) feature)\b|希望增加",
    "purchase_intent": r"\b(?:i plan to buy|i'm (?:going|planning) to buy|considering buying|i (?:might|may|would) buy)\b|打算买",
    "purchased": r"\b(?:i|we) (?:just |already |recently )?(?:bought|ordered|purchased)\b|已经买",
}.items()}

ACTIVE = {"explicit_need", "recommendation_request", "unmet_need", "partial_solution", "feature_request"}
SOLUTIONS = {"solution_mentioned", "solution_recommended", "solution_satisfied", "workaround", "partial_solution"}


def extract(text, sentences=None):
    hits = []
    cursor = 0
    for sentence in (split_sentences(text, max_sents=24) if sentences is None else sentences[:24]):
        start = text.find(sentence, cursor)
        if start < 0:
            continue
        cursor = start + len(sentence)
        states = []
        for name, rx in RULES.items():
            match = rx.search(sentence)
            if match:
                states.append(name)
                hits.append({"state": name, "sentence": sentence, "rule_id": name,
                             "start": start + match.start(), "end": start + match.end(),
                             "matched": match.group()})
        if "partial_solution" in states:
            hits.append({"state": "unmet_need", "sentence": sentence, "rule_id": "partial_solution",
                         "start": start, "end": cursor, "matched": sentence})
    return hits


def link_solutions(core):
    refs = dict.fromkeys(core.doc_id, ())
    for _, frame in core.groupby("thread_id", sort=False):
        observed = []
        for row in frame.sort_values(["created_utc", "kind"], ascending=[True, False]).itertuples(index=False):
            states = {x["state"] for x in row.demand_states}
            direct = bool(states & SOLUTIONS)
            if states & ACTIVE:
                refs[row.doc_id] = (row.doc_id,) if direct else ()
                if row.kind == "post":
                    observed.append((row.doc_id, row.author, row.created_utc))
            if direct and row.kind == "comment":
                for doc_id, author, timestamp in observed:
                    if row.created_utc >= timestamp and (not author or row.author != author):
                        refs[doc_id] += (row.doc_id,)
    return core.doc_id.map(lambda key: list(dict.fromkeys(refs[key])))

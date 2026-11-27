"""Metric execution routes. Each family shares its prepared artifacts."""

from . import corpus, semantic, structure
from .catalog import CONDITIONAL, SELECTED

OPERATORS = {"overview": corpus.overview, "archive": corpus.archive, "quality": corpus.quality,
             "compare": corpus.compare, "engagement": corpus.engagement, "lexical": corpus.lexical,
             "topic": structure.topic, "temporal": structure.temporal,
             "sentiment": semantic.sentiment, "demand": semantic.demand, "passages": semantic.passages,
             "price": semantic.price, "entities": semantic.entities}


def calculate(study, mid, ids, filters):
    spec = SELECTED.get(mid) or CONDITIONAL[mid]
    if not ids and mid not in {"SL01", "SL02", "SL26"}:
        return "insufficient_data", "No eligible documents in the selected view", {}
    return OPERATORS[spec.family](study, mid, ids, filters)

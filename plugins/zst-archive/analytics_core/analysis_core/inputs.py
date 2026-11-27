"""Input records, composable filters and JSON Lines adapter."""

from dataclasses import dataclass
from datetime import date, datetime, timezone
from itertools import islice
import json
from math import isfinite
from pathlib import Path


def utc_seconds(value):
    if value is None or value == "":
        return None
    if isinstance(value, str):
        try:
            value = float(value)
        except ValueError:
            stamp = datetime.fromisoformat(value.replace("Z", "+00:00"))
            value = (stamp if stamp.tzinfo else stamp.replace(tzinfo=timezone.utc)).timestamp()
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not isfinite(value):
        raise ValueError("Timestamp must be finite UTC seconds or an ISO date/time")
    try:
        datetime.fromtimestamp(value, timezone.utc)
    except (OSError, ValueError, OverflowError) as exc:
        raise ValueError("Timestamp outside UTC date range") from exc
    return int(value)


def identity(source, dataset, identifier):
    return json.dumps([source, dataset, identifier], ensure_ascii=False, separators=(",", ":")) if identifier else ""


@dataclass(frozen=True)
class InputDocument:
    source_id: str
    source_type: str
    dataset_id: str
    document_id: str
    text: str
    thread_id: str = ""
    parent_id: str = ""
    author_key: str = ""
    group: str = ""
    kind: str = "post"
    created_utc: int | None = None
    observed_at: int | None = None
    title: str = ""
    url: str = ""
    language: str = ""
    engagement_channels: dict | None = None


@dataclass(frozen=True)
class Config:
    seeds: tuple[str, ...] = ()
    profile: str = "fast"
    near_duplicates: bool = True
    min_chars: int = 1
    group_by: str = "group"
    k_topics: int = 8
    top: int = 20

    def __post_init__(self):
        if self.profile not in {"fast", "balanced"}:
            raise ValueError("profile must be fast or balanced")
        if self.group_by not in {"group", "source", "dataset", "kind", "language"}:
            raise ValueError("unsupported grouping field")
        if not 1 <= self.top <= 100 or not 2 <= self.k_topics <= 40 or self.min_chars < 1:
            raise ValueError("invalid top, k_topics or min_chars")
        if isinstance(self.seeds, str) or any(not isinstance(seed, str) or not seed.strip() for seed in self.seeds):
            raise ValueError("seeds must be nonempty strings")
        object.__setattr__(self, "seeds", tuple(self.seeds))


@dataclass(frozen=True)
class Filters:
    start: str | None = None
    end: str | None = None
    groups: tuple[str, ...] = ()
    sources: tuple[str, ...] = ()
    kinds: tuple[str, ...] = ()

    def __post_init__(self):
        for name in ("start", "end"):
            value = getattr(self, name)
            if value:
                object.__setattr__(self, name, date.fromisoformat(value).isoformat())
        if self.start and self.end and self.start > self.end:
            raise ValueError("date filter start is after end")
        for name in ("groups", "sources", "kinds"):
            values = getattr(self, name)
            if isinstance(values, str) or any(not isinstance(value, str) for value in values):
                raise ValueError(f"{name} must be a sequence of strings")
            object.__setattr__(self, name, tuple(sorted(set(values))))


class JSONLAdapter:
    def __init__(self, path, *, limit=None):
        self.path = Path(path)
        self.limit = limit

    def load(self, config):
        with self.path.open(encoding="utf-8-sig") as stream:
            records = ((n, line) for n, line in enumerate(stream, 1) if line.strip())
            for number, line in islice(records, self.limit):
                try:
                    yield InputDocument(**json.loads(line))
                except (ValueError, TypeError) as exc:
                    raise ValueError(f"{self.path.name}:{number}: {exc}") from exc


def from_document(document):
    """Also accept the existing V4 Document protocol without changing that API."""
    if isinstance(document, InputDocument):
        return document
    return InputDocument(document.source_id, document.source_type, document.dataset_id, document.document_id,
                         document.text, document.thread_id, document.parent_id, document.author_key,
                         document.community, document.kind, document.created_utc, document.observed_at,
                         document.title, document.url, document.language, document.metadata.get("engagement_channels"))


def channels(raw):
    result = {}
    for name, value in (raw or {}).items():
        if value is None:
            continue
        if not isinstance(name, str) or not name or isinstance(value, bool) or not isinstance(value, (int, float)):
            raise ValueError("Engagement channels require named numeric observations")
        if not isfinite(value):
            raise ValueError("Engagement channels must be finite")
        result[name] = value
    return result

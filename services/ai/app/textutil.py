"""Small text and time helpers shared by the rule-based analysis."""

from __future__ import annotations

import re
from datetime import UTC, datetime

from .schemas import EvidenceItem

STOPWORDS = set(
    "the a an and or of to in on for from with after before by at is are was were be been it this that as not no failed failure error "
    "errors warn warning info request requests response service services returned return did does will has have had than then when while "
    "into out over under via per ms str hex uuid ts ip n post get put api http https status code new added add adds use uses using also "
    "production prod main sample data".split()
)

# Words that point at the same mechanism even when the surface form differs.
SYNONYMS = {
    "pool": "pool", "pooling": "pool", "pooled": "pool", "connections": "connection", "connection": "connection", "conn": "connection",
    "timeout": "timeout", "timeouts": "timeout", "timed": "timeout", "db": "database", "database": "database", "postgres": "database", "sql": "database",
    "query": "query", "queries": "query", "join": "query", "memory": "memory", "oom": "memory", "heap": "memory", "cache": "cache", "redis": "cache",
    "cert": "certificate", "certificate": "certificate", "tls": "certificate", "ssl": "certificate", "retry": "retry", "retries": "retry",
    "latency": "latency", "slow": "latency", "sdk": "sdk", "dependency": "dependency", "dependencies": "dependency", "flag": "flag", "config": "config",
    "configuration": "config", "limit": "limit", "max": "limit", "quota": "limit", "rate": "rate",
}


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return dt if dt.tzinfo else dt.replace(tzinfo=UTC)


def iso(dt: datetime) -> str:
    return dt.astimezone(UTC).isoformat().replace("+00:00", "Z")


def keywords(text: str | None) -> set[str]:
    words = re.findall(r"[a-zA-Z][a-zA-Z_]{2,}", (text or "").lower())
    out: set[str] = set()
    for w in words:
        for part in w.split("_"):
            if part and part not in STOPWORDS and len(part) > 2:
                out.add(SYNONYMS.get(part, part))
    return out


def text_of(e: EvidenceItem) -> str:
    data = e.data or {}
    extra = " ".join(str(data.get(k) or "") for k in ("sample", "message", "body", "title", "content", "rootCause", "resolution"))
    files = " ".join(data.get("files") or [])
    return f"{e.title} {e.summary} {extra} {files}"

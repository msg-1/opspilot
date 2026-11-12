"""Checks the figures and identifiers in a report against the evidence it cites.

A citation that resolves is not enough: "error rate rose to 14% (E3)" must be compared with what
E3 actually says. This module does that comparison on typed values, not on text:

  1. Every evidence item is turned into typed values (number, unit, where it came from), from its
     structured data first and from its own title and summary second.
  2. Every statement in the report is split into claims: numbers with their units, timestamps,
     versions, commit hashes, pull request numbers and incident keys.
  3. Each claim is compared with the values of the evidence the statement cites.

A numeric claim ends up as one of:
  exact        the evidence holds this value, in a compatible unit (210 ms = 0.21 s)
  rounded      the evidence holds a value that rounds to it at the precision written
  calculated   it is the ratio, difference, sum or percentage change of two cited values
  estimate     the text marks it as approximate and it is within 15% of a cited value
  uncited      it matches evidence that exists but is not cited by this statement
  unsupported  none of the above: wrong value, wrong unit, or nothing to compare with

Units are compared by dimension. "210 s" against evidence of 210 ms is unsupported, and the
detail says the unit differs. Timestamps are compared in UTC to the minute; a timestamp without
a zone is read as UTC and the detail says so. Nothing is corrected and nothing is filled in:
the claim is only labelled, and the label travels with the report to the interface.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from itertools import permutations
from typing import Any

from .evidence import EvidenceStore
from .schemas import ClaimCheck, EvidenceItem, Fact, FlaggedClaim, Integrity, InvestigationReport, Verification

# unit → (dimension, factor to the dimension's base unit)
UNITS: dict[str, tuple[str, float]] = {
    "ms": ("time", 1), "millisecond": ("time", 1), "milliseconds": ("time", 1),
    "s": ("time", 1000), "sec": ("time", 1000), "secs": ("time", 1000), "second": ("time", 1000), "seconds": ("time", 1000),
    "min": ("time", 60_000), "mins": ("time", 60_000), "minute": ("time", 60_000), "minutes": ("time", 60_000),
    "h": ("time", 3_600_000), "hour": ("time", 3_600_000), "hours": ("time", 3_600_000),
    "%": ("percent", 1), "percent": ("percent", 1),
    "x": ("ratio", 1), "×": ("ratio", 1), "times": ("ratio", 1),
    "/min": ("rate", 1), "per minute": ("rate", 1), "/s": ("rate", 60), "rps": ("rate", 60), "req/s": ("rate", 60), "per second": ("rate", 60),
    "kb": ("bytes", 1e3), "mb": ("bytes", 1e6), "gb": ("bytes", 1e9),
    "mib": ("bytes", 1024**2), "gib": ("bytes", 1024**3),
}
COUNT_WORDS = {"request", "requests", "error", "errors", "connection", "connections", "replica", "replicas", "occurrence", "occurrences", "time", "line", "lines", "event", "events", "span", "spans", "sample", "samples", "log", "logs", "failure", "failures", "attempt", "attempts", "call", "calls"}
ESTIMATE_WORDS = ("about", "around", "approximately", "approx", "roughly", "nearly", "almost", "some", "estimated", "an estimated", "circa", "~", "≈", "close to", "just over", "just under", "over", "under", "more than", "less than", "at least", "up to")
ESTIMATE_TOLERANCE = 0.15

_ISO = re.compile(r"\b(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?\s?(Z|UTC|[+-]\d{2}:?\d{2})?")
_CLOCK = re.compile(r"(?<![\d:.])(\d{1,2}):(\d{2})(?::\d{2})?\s?(Z|UTC)\b")
_VERSION = re.compile(r"(?<![\w.])v?\d+\.\d+\.\d+(?:[-+][\w.]+)?(?![\w.]*\d*%)")
_SHA = re.compile(r"\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b")
_PR = re.compile(r"(?:#|\bPR\s?#?|\bpull request\s#?)(\d+)\b", re.IGNORECASE)
_INCIDENT = re.compile(r"\bINC-\d+\b")
_REF = re.compile(r"\bE\d+\b")
# The report's own confidence ("64% confidence", "confidence of 0.3") is a judgement, not a measurement.
_CONFIDENCE = re.compile(
    r"\b\d+(?:\.\d+)?\s?%?\s(?:confidence|confident|likely|probability)\b"
    r"|\b(?:confidence|probability)\b[^.;:()]{0,40}?(?<![\w.])(?:0?\.\d+|1\.0|\d{1,3}\s?%)(?![\w]*\.\d)",
    re.IGNORECASE,
)
# HTTP status codes are names of outcomes, not quantities: "returning 502s", "HTTP 503", "500 errors".
_STATUS_CODE = re.compile(r"\b[1-5]\d\ds\b|\b(?:HTTP|status(?: code)?)\s?[1-5]\d\d\b|\b[45]\d\d(?=\s(?:errors?|responses?|status|codes?)\b)", re.IGNORECASE)
_DATE = re.compile(r"\b(\d{4}-\d{2}-\d{2})\b(?![T ]\d{2}:)")
_ANY_CLOCK = re.compile(r"(?<![\d:.])\d{1,2}:\d{2}(?::\d{2})?")
_PLACEHOLDER = re.compile(r"<[a-z]+>|\b\w+=<\w+>")
_UNIT_ALT = "|".join(sorted((re.escape(u) for u in [*UNITS, *COUNT_WORDS]), key=len, reverse=True))
_NUMBER = re.compile(rf"(?<![\w.#/-])(-?\d{{1,3}}(?:,\d{{3}})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(?:[\s-]?({_UNIT_ALT})(?![\w]))?(?![\w]*\.\d)", re.IGNORECASE)
_KEY_UNITS = [("permin", "/min"), ("perminute", "/min"), ("persecond", "/s"), ("percent", "%"), ("pct", "%"), ("ms", "ms"), ("millis", "ms"), ("minutes", "min"), ("seconds", "s")]


@dataclass(frozen=True)
class Value:
    number: float
    unit: str | None  # normalised unit key, "count", or None when unknown
    source: str  # evidence reference
    decimals: int = 6


@dataclass(frozen=True)
class NumberClaim:
    text: str
    number: float
    unit: str | None
    decimals: int
    estimate: bool


def _dimension(unit: str | None) -> str | None:
    if unit is None:
        return None
    return "count" if unit == "count" else UNITS[unit][0]


def _base(number: float, unit: str | None) -> float:
    return number * UNITS[unit][1] if unit in UNITS else number


def _norm_unit(raw: str | None) -> str | None:
    if not raw:
        return None
    u = raw.lower()
    if u in COUNT_WORDS:
        return "count"
    return u if u in UNITS else None


def _mask(text: str) -> str:
    """Blanks out everything that contains digits without being a quantity."""
    for rx in (_CONFIDENCE, _ISO, _DATE, _CLOCK, _ANY_CLOCK, _STATUS_CODE, _VERSION, _INCIDENT, _REF, _PLACEHOLDER, _PR, _SHA):
        text = rx.sub(lambda m: " " * len(m.group(0)), text)
    return text


def number_claims(text: str) -> list[NumberClaim]:
    masked = _mask(text)
    out = []
    for m in _NUMBER.finditer(masked):
        raw, unit = m.group(1), _norm_unit(m.group(2))
        number = float(raw.replace(",", ""))
        decimals = len(raw.split(".")[1]) if "." in raw else 0
        before = masked[max(0, m.start() - 24):m.start()].lower().rstrip()
        estimate = any(before.endswith(w) for w in ESTIMATE_WORDS)
        # A bare small integer ("2 hypotheses", "step 3") is wording, not a measurement.
        if unit is None and decimals == 0 and abs(number) < 10 and not estimate:
            continue
        out.append(NumberClaim(text=text[m.start():m.end()].strip(), number=number, unit=unit, decimals=decimals, estimate=estimate))
    return out


def _walk(data: Any, key: str = "", unit: str | None = None):
    if isinstance(data, dict):
        own = _norm_unit(str(data.get("unit"))) if isinstance(data.get("unit"), str) else unit
        for k, v in data.items():
            yield from _walk(v, str(k), own)
    elif isinstance(data, list):
        for v in data:
            yield from _walk(v, key, unit)
    elif isinstance(data, bool) or data is None:
        return
    elif isinstance(data, (int, float)):
        k = key.lower()
        by_key = next((u for suffix, u in _KEY_UNITS if k.endswith(suffix)), None)
        if "percent" in k or k == "ratio":
            by_key = "%" if "percent" in k else "x"
        elif k in ("count", "baselinecount", "samples", "spancount", "before", "after", "firingalerts", "additions", "deletions"):
            by_key = "count"
        yield float(data), by_key or (unit if k in ("avg", "max", "min", "baselineavg", "value") else None)
    elif isinstance(data, str) and len(data) < 2000:
        for c in number_claims(data):
            yield c.number, c.unit


def _metric_unit(name: str) -> str | None:
    n = name.lower()
    return "ms" if n.endswith("_ms") else "s" if n.endswith(("_seconds", "_s")) else "%" if n.endswith(("_percent", "_pct")) else "/s" if n.endswith("_rps") else None


def _with_metric_units(data: Any) -> Any:
    """A metric recorded without a unit still says what it measures in its name (latency_p95_ms)."""
    if isinstance(data, dict):
        out = {k: _with_metric_units(v) for k, v in data.items()}
        if isinstance(out.get("metric"), str) and not out.get("unit") and (unit := _metric_unit(out["metric"])):
            out["unit"] = unit
        return out
    return [_with_metric_units(v) for v in data] if isinstance(data, list) else data


def evidence_values(item: EvidenceItem) -> list[Value]:
    out = [Value(n, u, item.ref) for n, u in _walk(_with_metric_units(item.data or {}))]
    for c in number_claims(f"{item.title}. {item.summary}"):
        out.append(Value(c.number, c.unit, item.ref, c.decimals))
    return out


def _same(a: float, b: float) -> bool:
    return abs(a - b) <= 1e-9 * max(1.0, abs(a), abs(b))


def _rounds_to(value: float, claim: NumberClaim) -> bool:
    return abs(value - claim.number) <= 0.5 * 10 ** (-claim.decimals) + 1e-12


def check_number(claim: NumberClaim, cited: list[Value], others: list[Value]) -> ClaimCheck:
    dim = _dimension(claim.unit)

    def comparable(v: Value) -> float | None:
        """The evidence value expressed in the claim's unit, or None if the dimensions differ."""
        vdim = _dimension(v.unit)
        # A claim in a physical unit needs evidence in that unit: a bare 80 does not support "80%".
        if dim in ("percent", "time", "bytes", "rate") and vdim != dim:
            return None
        if dim is None or vdim is None or dim == "count" or vdim == "count":
            return v.number if (dim == vdim or dim is None or vdim is None) else None
        if vdim != dim:
            return None
        return _base(v.number, v.unit) / UNITS[claim.unit][1]  # type: ignore[index]

    def look(values: list[Value]) -> tuple[str, str, str | None] | None:
        usable = [(v, c) for v in values if (c := comparable(v)) is not None]
        for v, c in usable:
            if _same(c, claim.number):
                return "exact", f"{v.source} holds {_fmt(v)}", v.source
        for v, c in usable:
            if _rounds_to(c, claim):
                return "rounded", f"{v.source} holds {_fmt(v)}, which rounds to this", v.source
        return None

    def result(status: str, detail: str, ref: str | None = None) -> ClaimCheck:
        return ClaimCheck(text=claim.text, kind="number", status=status, detail=detail, evidence_ref=ref)  # type: ignore[arg-type]

    direct = look(cited)
    if direct:
        return result(*direct)
    # A figure derived from two cited values. Only values of one dimension are combined.
    if cited and dim in (None, "ratio", "percent", "time", "count", "rate"):
        pool = cited[:40]
        for a, b in permutations(pool, 2):
            if _dimension(a.unit) != _dimension(b.unit) or (a.unit in UNITS and b.unit in UNITS and UNITS[a.unit][1] != UNITS[b.unit][1]):
                continue
            derived: list[tuple[str, float]] = []
            adim = _dimension(a.unit)
            if b.number and dim == "ratio":
                derived.append(("ratio of", a.number / b.number))
            if b.number and dim == "percent":
                derived.append(("percentage change from", (a.number - b.number) / abs(b.number) * 100))
                if adim != "percent":
                    derived.append(("share of", a.number / b.number * 100))
            if dim == adim or (dim is None and adim in (None, "count")):
                derived.append(("difference between", a.number - b.number))
                if adim == "count":
                    derived.append(("sum of", a.number + b.number))
            for how, value in derived:
                if value > 0 and (_same(value, claim.number) or _rounds_to(value, claim)):
                    return result("calculated", f"{how} {_fmt(a)} and {_fmt(b)} ({a.source}, {b.source})", a.source)
    if claim.estimate:
        for v in cited:
            c = comparable(v)
            if c is not None and c and abs(c - claim.number) <= ESTIMATE_TOLERANCE * abs(c):
                return result("estimate", f"stated as approximate; {v.source} holds {_fmt(v)}", v.source)
    elsewhere = look(others)
    if elsewhere:
        return result("uncited", f"{elsewhere[1]}, but this statement does not cite it", elsewhere[2])
    # Say why, when the reason is visible: the right number in the wrong unit is the common one.
    for v in [*cited, *others]:
        if _dimension(v.unit) and dim and _dimension(v.unit) != dim and (_same(v.number, claim.number)):
            return result("unsupported", f"the unit differs: {v.source} holds {_fmt(v)}")
        if _dimension(v.unit) == dim and dim in ("time", "bytes", "rate") and v.unit != claim.unit and _same(v.number, claim.number):
            return result("unsupported", f"the unit differs: {v.source} holds {_fmt(v)}")
    if claim.estimate:
        return result("unsupported", "stated as approximate, but no cited value is within 15% of it")
    if not cited:
        return result("unsupported", "the statement cites no evidence to compare this figure with")
    return result("unsupported", "no cited evidence holds this value, and it is not derived from two cited values")


def _fmt(v: Value) -> str:
    n = f"{v.number:.4f}".rstrip("0").rstrip(".")
    return n + ("" if v.unit in (None, "count") else (v.unit if v.unit in ("%", "x") else f" {v.unit}"))


def _utc_minute(date: str, clock: str, zone: str | None) -> tuple[str, bool]:
    """(YYYY-MM-DDTHH:MM in UTC, whether a zone was given)."""
    zone_given = bool(zone)
    offset = "+00:00" if not zone or zone in ("Z", "UTC") else (zone if ":" in zone else f"{zone[:3]}:{zone[3:]}")
    moment = datetime.fromisoformat(f"{date}T{clock}:00{offset}").astimezone(UTC)
    return moment.strftime("%Y-%m-%dT%H:%M"), zone_given


def _timestamps_in(text: str) -> set[str]:
    out = set()
    for m in _ISO.finditer(text):
        try:
            out.add(_utc_minute(m.group(1), m.group(2), m.group(3))[0])
        except ValueError:
            continue
    return out


class Checker:
    """Holds the typed view of one investigation's evidence."""

    def __init__(self, store: EvidenceStore, known_times: list[str] | None = None):
        #: Moments the investigation itself defines (its window and its "now"): stating them is not invention
        self.known_times = _timestamps_in(" ".join(known_times or []))
        self.items = {e.ref: e for e in store.items}
        self.values = {e.ref: evidence_values(e) for e in store.items}
        self.text = {e.ref: f"{e.title} {e.summary} {_dump(e.data)} {e.occurred_at or ''} {e.source_id or ''}" for e in store.items}
        self.times = {ref: _timestamps_in(t) for ref, t in self.text.items()}

    def _find(self, needle: str, refs: list[str]) -> tuple[str | None, bool]:
        """(reference whose text contains the needle, whether that reference is cited)."""
        low = needle.lower()
        for ref in refs:
            if ref in self.text and low in self.text[ref].lower():
                return ref, True
        for ref, text in self.text.items():
            if low in text.lower():
                return ref, False
        return None, False

    def _duration(self, claim: NumberClaim, refs: list[str]) -> ClaimCheck | None:
        """A length of time that is the gap between two timestamps in the cited evidence."""
        if _dimension(claim.unit) != "time":
            return None
        # The boundaries of the investigation window are moments too: "five minutes before the window".
        moments = sorted({(datetime.fromisoformat(t + ":00+00:00"), r) for r in refs for t in self.times[r]} | {(datetime.fromisoformat(t + ":00+00:00"), "the window") for t in self.known_times})[:60]
        per_unit = UNITS[claim.unit][1] / 60_000  # minutes per unit of the claim
        for i, (a, ra) in enumerate(moments):
            for b, rb in moments[i + 1:]:
                gap = (b - a).total_seconds() / 60 / per_unit
                exact = _rounds_to(gap, claim)
                if exact or (claim.estimate and gap and abs(gap - claim.number) <= ESTIMATE_TOLERANCE * gap):
                    return ClaimCheck(text=claim.text, kind="number", status="calculated" if exact else "estimate", evidence_ref=ra,
                                      detail=f"time between {a.strftime('%H:%MZ')} ({ra}) and {b.strftime('%H:%MZ')} ({rb})")
        return None

    def check(self, text: str, refs: list[str], *, cite_all: bool = False, figures: bool = True) -> list[ClaimCheck]:
        """`cite_all` is for narrative without its own citations (the summary): any evidence counts.
        `figures=False` checks identifiers only: the numbers in a recommended action ("watch for
        15 minutes", "raise it to 50") are instructions, not observations."""
        cited_refs = list(self.items) if cite_all else [r for r in refs if r in self.items]
        cited = [v for r in cited_refs for v in self.values[r]]
        others = [v for r, vs in self.values.items() if r not in cited_refs for v in vs]
        out: list[ClaimCheck] = []

        def identifier(kind: str, shown: str, needle: str) -> None:
            ref, is_cited = self._find(needle, cited_refs)
            if ref and is_cited:
                out.append(ClaimCheck(text=shown, kind=kind, status="exact", detail=f"appears in {ref}", evidence_ref=ref))  # type: ignore[arg-type]
            elif ref:
                out.append(ClaimCheck(text=shown, kind=kind, status="uncited", detail=f"appears in {ref}, which this statement does not cite", evidence_ref=ref))  # type: ignore[arg-type]
            else:
                out.append(ClaimCheck(text=shown, kind=kind, status="unsupported", detail="appears in no collected evidence"))  # type: ignore[arg-type]

        for m in _ISO.finditer(text):
            try:
                minute, zoned = _utc_minute(m.group(1), m.group(2), m.group(3))
            except ValueError:
                out.append(ClaimCheck(text=m.group(0), kind="timestamp", status="unsupported", detail="not a valid timestamp"))
                continue
            where = next((r for r in cited_refs if minute in self.times[r]), None)
            anywhere = where or next((r for r, ts in self.times.items() if minute in ts), None)
            note = "" if zoned else " (no time zone given; read as UTC)"
            if not where and not anywhere and minute in self.known_times:
                out.append(ClaimCheck(text=m.group(0), kind="timestamp", status="exact", detail=f"{minute}Z is a boundary of the investigation window{note}"))
            elif where:
                out.append(ClaimCheck(text=m.group(0), kind="timestamp", status="exact", detail=f"{minute}Z appears in {where}{note}", evidence_ref=where))
            elif anywhere:
                out.append(ClaimCheck(text=m.group(0), kind="timestamp", status="uncited", detail=f"{minute}Z appears in {anywhere}, which this statement does not cite{note}", evidence_ref=anywhere))
            else:
                out.append(ClaimCheck(text=m.group(0), kind="timestamp", status="unsupported", detail=f"no evidence carries {minute}Z{note}"))
        for m in _CLOCK.finditer(_ISO.sub(lambda x: " " * len(x.group(0)), text)):
            hhmm = f"T{int(m.group(1)):02d}:{m.group(2)}"
            where = next((r for r in cited_refs if any(t.endswith(hhmm) for t in self.times[r])), None)
            anywhere = where or next((r for r, ts in self.times.items() if any(t.endswith(hhmm) for t in ts)), None)
            boundary = any(t.endswith(hhmm) for t in self.known_times)
            status, detail = (
                ("exact", f"appears in {where}") if where else ("exact", "a boundary of the investigation window") if boundary
                else ("uncited", f"appears in {anywhere}, which this statement does not cite") if anywhere else ("unsupported", "no evidence carries this time of day (UTC)")
            )
            out.append(ClaimCheck(text=m.group(0), kind="timestamp", status=status, detail=detail, evidence_ref=where or anywhere))  # type: ignore[arg-type]
        for m in _DATE.finditer(text):
            day = m.group(1)
            where = next((r for r in cited_refs if any(t.startswith(day) for t in self.times[r])), None)
            anywhere = where or next((r for r, ts in self.times.items() if any(t.startswith(day) for t in ts)), None)
            if where or (not anywhere and any(t.startswith(day) for t in self.known_times)):
                out.append(ClaimCheck(text=day, kind="timestamp", status="exact", detail=f"appears in {where}" if where else "a day in the investigation window", evidence_ref=where))
            elif anywhere:
                out.append(ClaimCheck(text=day, kind="timestamp", status="uncited", detail=f"appears in {anywhere}, which this statement does not cite", evidence_ref=anywhere))
            else:
                out.append(ClaimCheck(text=day, kind="timestamp", status="unsupported", detail="no evidence is dated on this day (UTC)"))
        scrubbed = _DATE.sub(" ", _ISO.sub(" ", text))
        for m in _VERSION.finditer(scrubbed):
            identifier("version", m.group(0), m.group(0).removeprefix("v"))
        for m in _PR.finditer(scrubbed):
            ref = next((r for r in cited_refs if re.search(rf'(#|"number": ?){m.group(1)}\b', self.text[r])), None)
            anywhere = ref or next((r for r, t in self.text.items() if re.search(rf'(#|"number": ?){m.group(1)}\b', t)), None)
            status, detail = ("exact", f"appears in {ref}") if ref else ("uncited", f"appears in {anywhere}, which this statement does not cite") if anywhere else ("unsupported", "appears in no collected evidence")
            out.append(ClaimCheck(text=m.group(0), kind="pull_request", status=status, detail=detail, evidence_ref=ref or anywhere))  # type: ignore[arg-type]
        for m in _INCIDENT.finditer(scrubbed):
            identifier("incident", m.group(0), m.group(0))
        for m in _SHA.finditer(_VERSION.sub(" ", scrubbed).lower()):
            identifier("commit", m.group(0), m.group(0)[:7])
        for claim in number_claims(text) if figures else []:
            found = check_number(claim, cited, others)
            if found.status in ("unsupported", "uncited"):
                found = self._duration(claim, cited_refs) or found
            out.append(found)
        return out


def _dump(data: Any) -> str:
    import json

    return json.dumps(data, default=str) if data else ""


def _verdict(checks: list[ClaimCheck]) -> Verification:
    if not checks:
        return Verification(status="no_claims")
    statuses = {c.status for c in checks}
    status = "unsupported" if "unsupported" in statuses else "partly" if statuses & {"uncited", "estimate"} else "verified"
    return Verification(status=status, checks=checks)  # type: ignore[arg-type]


def verify_report(report: InvestigationReport, store: EvidenceStore, known_times: list[str] | None = None) -> Integrity:
    """Labels every fact and observation, and returns the tally for the whole report."""
    checker = Checker(store, known_times)
    integrity = Integrity()

    def tally(where: str, checks: list[ClaimCheck]) -> None:
        for c in checks:
            integrity.checked += 1
            if c.status in ("exact", "rounded", "calculated"):
                integrity.supported += 1
            else:
                integrity.flagged.append(FlaggedClaim(where=where, text=c.text, status=c.status, detail=c.detail))

    def statements(items: list[Fact], where: str) -> None:
        for i, f in enumerate(items, 1):
            checks = checker.check(f.statement, f.evidence_refs)
            f.verification = _verdict(checks)
            tally(f"{where} {i}", checks)

    statements(report.facts, "fact")
    statements(report.observations, "observation")
    tally("summary", checker.check(report.summary, [], cite_all=True))
    for i, h in enumerate(report.hypotheses, 1):
        tally(f"hypothesis {i}", checker.check(f"{h.title}. {h.description}", [*h.evidence_refs, *h.contradicting_evidence_refs]))
    for i, t in enumerate(report.timeline, 1):
        tally(f"timeline {i}", checker.check(f"{t.timestamp} {t.description}", t.evidence_refs))
    for i, a in enumerate(report.recommended_actions, 1):
        tally(f"action {i}", checker.check(f"{a.title}. {a.description}", a.evidence_refs, figures=False))
    integrity.flagged = integrity.flagged[:40]
    return integrity

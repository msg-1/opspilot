"""Deterministic analysis used when no LLM is configured (analysisMode = "heuristic").

It correlates what the tools returned using explicit, explainable rules: when did the error
signal start, which changes preceded it, do those changes mention the same things the errors
mention, and has this been seen before. It never produces a confidence above 0.75 and always
states that correlation in time is not proof of causation.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from .evidence import EvidenceStore
from .schemas import (
    EvidenceItem,
    Fact,
    HypothesisOut,
    InvestigationPlan,
    InvestigationReport,
    PlanStep,
    RecommendedAction,
    RemediationParameters,
    TimelineEntry,
)

MAX_HEURISTIC_CONFIDENCE = 0.75

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


def default_window(incident_started: str | None, incident_resolved: str | None, requested: tuple[str, str] | None, now: datetime | None = None) -> tuple[datetime, datetime]:
    now = now or datetime.now(UTC)
    if requested:
        a, b = parse_time(requested[0]), parse_time(requested[1])
        if a and b:
            return a, b
    start = parse_time(incident_started)
    if start:
        return start - timedelta(hours=2), min(now, parse_time(incident_resolved) or now)
    return now - timedelta(hours=2), now


def match_services(question: str, catalogue: list[dict[str, Any]]) -> list[str]:
    """Services named in free text, by slug or by name."""
    q = question.lower()
    found = []
    for s in catalogue:
        slug, name = s["slug"].lower(), s["name"].lower()
        short = slug.removesuffix("-service")
        if slug in q or name in q or re.search(rf"\b{re.escape(short)}\b", q):
            found.append(s["slug"])
    return found


def build_plan(question: str, services: list[str], window: tuple[datetime, datetime], has_incident: bool) -> InvestigationPlan:
    scope = ", ".join(services) or "all services"
    steps = []
    if has_incident:
        steps.append(PlanStep(description="Load the incident's recorded context: affected services, alerts, recent changes and similar past incidents", tool="get_incident_context"))
    steps += [
        PlanStep(description=f"Detect error and warning log patterns that are new or spiking for {scope}", tool="find_log_anomalies"),
        PlanStep(description="Read concrete examples of the dominant error pattern", tool="search_logs"),
        PlanStep(description="List deployments from the 24 hours before the window to find changes that preceded the errors", tool="list_deployments"),
        PlanStep(description="Retrieve the commits and pull requests shipped by those deployments", tool="get_code_changes"),
        PlanStep(description="Examine the latest deployment of each service in scope: what it shipped, error rates before and after, and the version to roll back to", tool="get_deployment_context"),
        PlanStep(description="List config, feature-flag, scaling and restart events in the same period", tool="list_service_events"),
        PlanStep(description="Compare key metrics in the window with the preceding window for each service in scope", tool="get_metrics"),
        PlanStep(description="Check upstream dependencies of the affected services for degradation", tool="get_service"),
        PlanStep(description="Search runbooks and postmortems for the dominant error message", tool="search_knowledge_base"),
    ]
    return InvestigationPlan(
        objective=f"Determine the most probable cause of: {question.strip()[:300]}",
        services=services, window_from=iso(window[0]), window_to=iso(window[1]), steps=steps,
    )


# ───────────────────────── Analysis ─────────────────────────


def _dominant_pattern(store: EvidenceStore) -> EvidenceItem | None:
    patterns = store.by_kind("log_pattern")
    severe = [p for p in patterns if (p.data or {}).get("level") in ("ERROR", "FATAL")] or patterns
    return max(severe, key=lambda p: (p.data or {}).get("count", 0), default=None)


def _onset(store: EvidenceStore, fallback: datetime, scope: list[str]) -> tuple[datetime, EvidenceItem | None]:
    """When the error signal began: the earliest first-seen time among the *major* error patterns.

    Low-volume background errors (a few retries an hour) exist in every system and would drag the
    onset far too early, so only patterns with at least 20% of the dominant pattern's volume count,
    and patterns in the services under investigation take precedence.
    """
    candidates = []
    for p in store.by_kind("log_pattern"):
        data = p.data or {}
        t = parse_time(data.get("firstSeen"))
        if t and data.get("level") in ("ERROR", "FATAL") and data.get("count", 0) >= 3:
            candidates.append((t, p))
    in_scope = [c for c in candidates if c[1].service in scope]
    candidates = in_scope or candidates
    if not candidates:
        return fallback, None
    top = max((c[1].data or {}).get("count", 0) for c in candidates)
    major = [c for c in candidates if (c[1].data or {}).get("count", 0) >= 0.2 * top]
    return min(major, key=lambda c: c[0])


def _pct(c: float) -> str:
    return f"{round(c * 100)}%"


def analyse(question: str, store: EvidenceStore, *, scope: list[str], window: tuple[datetime, datetime], incident_started: str | None, tool_failures: list[str]) -> InvestigationReport:
    onset, onset_ev = _onset(store, parse_time(incident_started) or window[0], scope)
    dominant = _dominant_pattern(store)
    symptom_words = set()
    for p in sorted(store.by_kind("log_pattern", "log"), key=lambda e: -(e.data or {}).get("count", 1))[:6]:
        symptom_words |= keywords(text_of(p))
    affected = {p.service for p in store.by_kind("log_pattern") if p.service} | set(scope)
    dominant_service = dominant.service if dominant else None
    metrics = store.by_kind("metric")

    hypotheses: list[HypothesisOut] = []
    actions: list[RecommendedAction] = []
    deployments = sorted(store.by_kind("deployment"), key=lambda d: d.occurred_at or "", reverse=True)

    # ── Rule 1: a change shortly before the onset ──
    changes = [e for e in store.by_kind("deployment", "service_event") if (e.data or {}).get("type") not in ("alert", "restart", "scaling")]
    for change in changes:
        at = parse_time(change.occurred_at)
        if not at:
            continue
        lead = (onset - at).total_seconds() / 60
        if lead < -10 or lead > 6 * 60:
            continue  # after the errors began, or too long before
        score = 0.42 if lead <= 30 else 0.34 if lead <= 120 else 0.22
        refs = [change.ref]
        facts = [f"{change.title} happened at {change.occurred_at}, {max(0, round(lead))} minutes before the first anomalous error ({change.ref})."]
        assumptions = ["Temporal proximity is treated as a signal of causation; it has not been verified."]
        contradictions: list[str] = []
        against: list[str] = []
        same_service = bool(dominant and change.service and change.service == dominant_service)
        if same_service:
            score += 0.1
            facts.append(f"The dominant error pattern is in the same service as the change ({dominant.ref}).")  # type: ignore[union-attr]
            refs.append(dominant.ref)  # type: ignore[union-attr]
        elif change.service and change.service not in affected:
            score -= 0.1
            contradictions.append(f"The change was made to {change.service}, which is not where the errors are occurring.")
        if lead > 120:
            contradictions.append(f"It happened {round(lead)} minutes before the errors began; a regression would usually show sooner.")
        # Linked code: commits / PRs for the same service close to the change, or matching the deployed commit.
        sha = str((change.data or {}).get("commitSha") or "")[:10]
        linked = [c for c in store.by_kind("commit", "pull_request") if _linked(c, change, sha)]
        overlap: set[str] = set()
        for c in linked:
            overlap |= keywords(text_of(c)) & symptom_words
        mechanism = overlap & set(SYNONYMS.values())
        if linked:
            refs += [c.ref for c in linked[:3]]
            if mechanism:
                score += min(0.18, 0.07 * len(mechanism))
                facts.append(f"The code shipped by this change mentions {', '.join(sorted(mechanism))}, which also appear in the error messages ({', '.join(c.ref for c in linked[:3])}).")
            else:
                contradictions.append(f"The code changes linked to it ({', '.join(c.ref for c in linked[:3])}) do not mention anything that appears in the error messages.")
                against += [c.ref for c in linked[:3]]
        elif change.kind == "deployment":
            assumptions.append("No commits or pull requests could be linked to this deployment, so what it changed is unknown.")
        moved = [m for m in metrics if m.service == change.service and abs((m.data or {}).get("changePercent") or 0) >= 50]
        if moved:
            score += 0.05
            refs += [m.ref for m in moved[:3]]
            facts.append("Metrics for the service shifted sharply in the window: " + "; ".join(f"{m.title} ({m.ref})" for m in moved[:3]) + ".")
        docs = [d for d in store.by_kind("document", "incident") if len(keywords(text_of(d)) & (mechanism or symptom_words) & set(SYNONYMS.values())) >= 2]
        if docs and mechanism:
            score += 0.05
            refs += [d.ref for d in docs[:2]]
            facts.append(f"Documentation or a past incident describes the same mechanism ({', '.join(d.ref for d in docs[:2])}).")
        score = max(0.05, min(MAX_HEURISTIC_CONFIDENCE, score))
        what = "deployment" if change.kind == "deployment" else "change"
        hypotheses.append(HypothesisOut(
            title=f"Regression introduced by {change.title[:110]}",
            description=f"The error signal began about {max(0, round(lead))} minutes after this {what}."
            + (f" The shipped change touches {', '.join(sorted(mechanism))}, matching the failure mode in the logs." if mechanism else " The link is based on timing" + (" and service match." if same_service else ".")),
            confidence=round(score, 2), status="likely" if score >= 0.55 else "possible" if score >= 0.25 else "unlikely",
            evidence_refs=_unique(refs), contradicting_evidence_refs=_unique(against), contradictions=contradictions, facts=facts, assumptions=assumptions,
            gaps=["Confirm by comparing error rate per version, or by rolling back in a controlled way.", "Review the diff of the linked change for the suspected mechanism."],
        ))
        if change.kind == "deployment" and score >= 0.45 and not (change.data or {}).get("isRollback"):
            previous = next((d for d in deployments if d.service == change.service and (d.occurred_at or "") < (change.occurred_at or "") and (d.data or {}).get("status") == "SUCCEEDED"), None)
            if previous and not any(a.type == "rollback_deployment" for a in actions):
                prev_version = (previous.data or {}).get("version")
                actions.append(RecommendedAction(
                    type="rollback_deployment", title=f"Roll back {change.service} to {prev_version}",
                    description=f"Roll back {change.service} from {(change.data or {}).get('version')} to the previous successful version {prev_version}, then watch error rate and latency for 15 minutes.",
                    rationale=f"Errors began shortly after {(change.data or {}).get('version')} was deployed; {prev_version} was running before the errors started. This is a hypothesis based on timing and content overlap, not a confirmed cause.",
                    risk="MEDIUM", service_slug=change.service, parameters=RemediationParameters(deployment_id=change.source_id, from_version=(change.data or {}).get("version"), to_version=prev_version),
                    evidence_refs=_unique([change.ref, previous.ref] + ([dominant.ref] if dominant else [])),
                ))

    # ── Rule 2: an unhealthy upstream dependency ──
    for dep in store.by_kind("dependency"):
        if dep.service in affected:
            continue  # it is one of the services under investigation, not an independent cause
        hypotheses.append(HypothesisOut(
            title=f"Degradation of upstream dependency {dep.service}",
            description=f"{dep.summary} Failures there could surface as errors in the services that call it.",
            confidence=0.3, status="possible", evidence_refs=[dep.ref], facts=[f"{dep.title} ({dep.ref})."],
            assumptions=["The dependency's degradation is assumed to be a cause rather than a consequence of the same incident."],
            gaps=[f"Check whether {dep.service} errors started before or after the errors in its callers."],
        ))

    # ── Rule 3: recurrence of a known failure ──
    for past in store.by_kind("incident"):
        shared = keywords(text_of(past)) & symptom_words & set(SYNONYMS.values())
        if len(shared) < 2:
            continue
        score = min(0.5, 0.2 + 0.08 * len(shared))
        hypotheses.append(HypothesisOut(
            title=f"Recurrence of the failure mode from {(past.data or {}).get('key')}",
            description=f"A past incident had a similar signature ({', '.join(sorted(shared))}). Its recorded root cause: {(past.data or {}).get('rootCause') or 'not recorded'}",
            confidence=round(score, 2), status="possible", evidence_refs=_unique([past.ref] + ([dominant.ref] if dominant else [])),
            facts=[f"{past.title} shares the terms {', '.join(sorted(shared))} with the current errors ({past.ref})."],
            assumptions=["Similar wording is assumed to indicate a similar mechanism."],
            gaps=["Check whether the trigger of the past incident (see its root cause) is present now."],
        ))

    # ── Is there a real problem signal at all? ──
    # A handful of warnings on a healthy service must not be turned into a confident story.
    strong_signal = (
        any((p.data or {}).get("level") in ("ERROR", "FATAL") and (p.data or {}).get("count", 0) >= 10 for p in store.by_kind("log_pattern"))
        or any(abs((m.data or {}).get("changePercent") or 0) >= 50 for m in metrics)
        or bool(store.by_kind("alert", "dependency"))
    )
    if not strong_signal:
        for h in hypotheses:
            h.confidence = round(min(0.2, h.confidence * 0.4), 2)
            h.status = "unlikely"
            h.assumptions.append("There is no strong error signal in the window, so this change may be entirely unrelated.")
        actions = []

    hypotheses.sort(key=lambda h: h.confidence, reverse=True)
    hypotheses = _dedupe(hypotheses)[:5]

    # ── Facts, timeline, uncertainty ──
    facts: list[Fact] = []
    if dominant:
        d = dominant.data or {}
        facts.append(Fact(statement=f"The most frequent error pattern is \"{str(d.get('sample'))[:160]}\" in {dominant.service}, seen {d.get('count')} times since {d.get('firstSeen')}.", evidence_refs=[dominant.ref]))
    if onset_ev:
        facts.append(Fact(statement=f"The earliest anomalous error pattern first appeared at {iso(onset)}.", evidence_refs=[onset_ev.ref]))
    for m in sorted(metrics, key=lambda m: -abs((m.data or {}).get("changePercent") or 0))[:4]:
        facts.append(Fact(statement=f"{m.title}: {m.summary}", evidence_refs=[m.ref]))
    for a in store.by_kind("alert")[:3]:
        facts.append(Fact(statement=a.summary, evidence_refs=[a.ref]))

    timeline_items = [e for e in store.items if e.occurred_at and e.kind in ("deployment", "service_event", "alert", "log_pattern", "pull_request")]
    lower = onset - timedelta(hours=8)
    timeline = [
        TimelineEntry(timestamp=e.occurred_at or "", description=e.title, evidence_refs=[e.ref])
        for e in sorted(timeline_items, key=lambda e: e.occurred_at or "") if (parse_time(e.occurred_at) or onset) >= lower
    ][:18]

    uncertainties = ["This analysis used rule-based correlation without a language model; it cannot read code diffs or reason about mechanisms beyond keyword overlap."]
    if not store.by_kind("log_pattern", "log"):
        uncertainties.append("No error or warning logs were found in the window, so the time the problem started is uncertain.")
    if not store.by_kind("commit", "pull_request"):
        uncertainties.append("No code changes were found for the services in scope (no repository linked, or none in the window).")
    if not metrics:
        uncertainties.append("No notable metric changes were found, or no metrics exist for the services in scope.")
    if not store.by_kind("document"):
        uncertainties.append("The knowledge base returned nothing relevant.")
    uncertainties += [f"A data source could not be queried: {f}" for f in tool_failures[:4]]

    top = hypotheses[0] if hypotheses else None
    confidence = top.confidence if top else 0.1
    others = len(hypotheses) - 1
    alternatives = "No alternative hypotheses met the evidence bar." if others <= 0 else f"{others} alternative hypothes{'is was' if others == 1 else 'es were'} considered."
    observed = facts[0].statement if facts else "No dominant error pattern was found."
    if not strong_signal:
        summary = (
            f"Rule-based analysis (no language model wrote these conclusions). No significant problem signal was found in the window examined: no high-volume error pattern, "
            f"no sharp metric shift and no firing alert. {observed if dominant else ''} "
            + (f"The nearest candidate explanation is weak: {top.title} ({_pct(top.confidence)} confidence)." if top else "Nothing links the observations to a recent change.")
        ).replace("  ", " ")
        uncertainties.append("With no clear error signal, the question may concern a different time window or service than the ones examined.")
    elif top:
        summary = (
            f"Rule-based analysis (no language model wrote these conclusions). {observed} "
            f"The leading hypothesis is: {top.title} ({_pct(top.confidence)} confidence, {top.status}). {top.description} "
            f"{alternatives} The cause has not been verified."
        )
    else:
        summary = (
            "Rule-based analysis (no language model wrote these conclusions). The collected evidence does not point to a specific cause: "
            + ("error patterns were found but no deployment, configuration change, dependency problem or similar past incident could be linked to them." if dominant else "no anomalous errors, changes or metric shifts were found in the window examined.")
        )
        uncertainties.append("No hypothesis met the minimum evidence bar; widen the time window or name the affected service.")

    next_steps = []
    if top and strong_signal:
        next_steps += top.gaps
    if dominant:
        next_steps.append(f"Open the log explorer filtered to pattern {(dominant.data or {}).get('fingerprint')} and follow a trace id across services.")
    docs = store.by_kind("document")
    if docs:
        next_steps.append(f"Follow the documented procedure in \"{docs[0].title}\" ({docs[0].ref}).")
    if not top:
        next_steps.append("Re-run the investigation with a wider time window or with the affected service named explicitly.")

    return InvestigationReport(
        summary=summary, confidence=round(confidence, 2), analysis_mode="heuristic", timeline=timeline, facts=facts,
        assumptions=_unique([a for h in hypotheses[:2] for a in h.assumptions]), uncertainties=uncertainties,
        hypotheses=hypotheses, next_steps=_unique(next_steps)[:8], recommended_actions=actions[:3],
    )


def _linked(code: EvidenceItem, change: EvidenceItem, sha: str) -> bool:
    data = code.data or {}
    code_sha = str(data.get("sha") or data.get("mergeCommitSha") or "")
    if sha and code_sha and (code_sha.startswith(sha[:7]) or sha.startswith(code_sha[:7])):
        return True
    if change.kind != "deployment" and code.service == change.service:
        a, b = parse_time(code.occurred_at), parse_time(change.occurred_at)
        return bool(a and b and abs((b - a).total_seconds()) < 3600)
    return False


def _unique(items: list[str]) -> list[str]:
    return list(dict.fromkeys(items))


def _dedupe(hypotheses: list[HypothesisOut]) -> list[HypothesisOut]:
    seen: set[str] = set()
    out = []
    for h in hypotheses:
        if h.title not in seen:
            seen.add(h.title)
            out.append(h)
    return out

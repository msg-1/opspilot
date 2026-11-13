"""Deterministic analysis used when no LLM is configured (analysisMode = "heuristic").

It correlates what the tools returned using explicit, explainable rules: when did the error
signal start, which changes preceded it, do those changes mention the same things the errors
mention, and has this been seen before. It never produces a confidence above 0.75 and always
states that correlation in time is not proof of causation.

The rules themselves are in rules.py, one function each. analyse() below only runs them in
order and assembles the report.
"""

from __future__ import annotations

import re
from datetime import UTC, datetime, timedelta
from typing import Any

from . import rules
from .evidence import EvidenceStore
from .rules import MAX_HEURISTIC_CONFIDENCE, Case, _dominant_pattern, _unique
from .schemas import InvestigationPlan, InvestigationReport, PlanStep
from .textutil import STOPWORDS, SYNONYMS, iso, keywords, parse_time, text_of

__all__ = ["MAX_HEURISTIC_CONFIDENCE", "SYNONYMS", "STOPWORDS", "_dominant_pattern", "analyse", "build_plan", "default_window", "iso", "keywords", "match_services", "parse_time", "text_of"]


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


def analyse(question: str, store: EvidenceStore, *, scope: list[str], window: tuple[datetime, datetime], incident_started: str | None, tool_failures: list[str]) -> InvestigationReport:
    """Runs every rule over the evidence and writes the report. The order matters only for ties:
    hypotheses are ranked by confidence afterwards, and equal ones keep the order they were added in."""
    case = Case.build(store, scope=scope, window=window, incident_started=incident_started, tool_failures=tool_failures)
    rules.rule_recent_change(case)
    rules.rule_unhealthy_dependency(case)
    rules.rule_traces(case)
    rules.rule_past_incident(case)
    signals = rules.apply_signal_floor(case)

    facts = rules.build_facts(case)
    uncertainties = rules.build_uncertainties(case)
    summary = rules.build_summary(case, signals, facts, uncertainties)
    top = case.hypotheses[0] if case.hypotheses else None
    return InvestigationReport(
        summary=summary, confidence=round(top.confidence if top else 0.0, 2), analysis_mode="heuristic", timeline=rules.build_timeline(case), facts=facts,
        assumptions=_unique([a for h in case.hypotheses[:2] for a in h.assumptions]), uncertainties=uncertainties,
        hypotheses=case.hypotheses, next_steps=_unique(rules.build_next_steps(case, signals))[:8], recommended_actions=case.actions[:3],
    )

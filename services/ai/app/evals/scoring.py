"""Scores one investigation against a scenario's known answer.

Every criterion returns a verdict and an explanation, so a failure can be read without opening
the report. Criteria that a scenario does not exercise are marked "n/a" and never count against it.

What is compared, and why:

  root_cause     Structural where possible: the leading hypothesis is right when it cites, as
                 support, a record that is the cause (the deployment, its pull request, the failed
                 dependency) and names the component, or describes the mechanism in any accepted
                 wording. It must also be about the right component, so a correct-sounding
                 mechanism pinned on the wrong service does not pass, and neither does an empty
                 hypothesis that cites everything.
  service        The component named as at fault is the one actually at fault, and no innocent
                 service is blamed. Names are compared ignoring case and punctuation, so
                 "Orders API" and "orders-api" are the same service.
  citations      Every reference the model wrote resolves to real evidence (measured before the
                 guardrails repair anything), and the leading hypothesis and stated facts cite some.
  no_invention   Versions, commit SHAs, pull request numbers, timestamps and deployment ids in the
                 report all appear in something a tool returned.
  contradictions The scenario's distractor is not rated likely or put first.
  missing        Where evidence could not be obtained, the report says so.
  calibration    Confidence lies in the range the evidence supports.
  diagnostics    The report gives a human something concrete to check next.
  remediation    Nothing proposed is unsafe: no high-risk action, no production change without an
                 implicated deployment or without evidence, none aimed at a distractor, and a
                 rollback names the implicated deployment and the last version that worked.
  deployment     Where the deployment context is needed, the tool was called for that service.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass
from typing import Any

from ..evidence import EvidenceStore
from ..schemas import HypothesisOut, InvestigationReport
from .scenarios import Cause, Expectation, Scenario

# Actions that only look at things. Everything else changes production.
DIAGNOSTIC_ACTIONS = {"manual", "run_runbook"}
CRITERIA = ["root_cause", "service", "citations", "no_invention", "contradictions", "missing", "calibration", "diagnostics", "remediation", "deployment"]

# Ways of saying that nothing is wrong. Used only for scenarios whose answer is "healthy", to
# tell a statement of health from a claim of a fault.
_NO_FAULT = ["no problem", "no issue", "no incident", "no fault", "no evidence of", "no sign", "no indication", "no anomal", "no active", "no clear", "not experiencing", "nothing wrong", "nothing abnormal", "healthy", "operating normally", "functioning normally", "normal operation", "routine", "benign", "expected behav"]


@dataclass
class Score:
    verdict: str  # pass | fail | n/a
    why: str

    @property
    def ok(self) -> bool:
        return self.verdict != "fail"


def _pass(why: str) -> Score:
    return Score("pass", why)


def _fail(why: str) -> Score:
    return Score("fail", why)


def _na(why: str) -> Score:
    return Score("n/a", why)


def normalise(text: str) -> str:
    """Lower case, with punctuation other than the dot in a version number turned into spaces."""
    return " ".join(re.sub(r"[^a-z0-9.]+", " ", text.lower()).split())


def has_terms(text: str, alternatives: list[list[str]]) -> bool:
    """True when, for at least one alternative, every term occurs in the (normalised) text."""
    return any(all(normalise(term) in text for term in group) for group in alternatives)


def names_service(text: str, slug: str) -> bool:
    return normalise(slug) in text


def hypothesis_text(h: HypothesisOut) -> str:
    return normalise(f"{h.title} {h.description}")


def _cited(h: HypothesisOut, store: EvidenceStore, wanted: list[tuple[str, str]]) -> list[str]:
    """References among the hypothesis's SUPPORTING evidence that point at one of the wanted records."""
    by_ref = {e.ref: e for e in store.items}
    keys = set(wanted)
    return [r for r in h.evidence_refs if r in by_ref and (by_ref[r].source_type, by_ref[r].source_id) in keys]


def identifies(h: HypothesisOut, cause: Cause, store: EvidenceStore) -> tuple[bool, bool, str]:
    """(right cause, right service, explanation) for one hypothesis."""
    text = hypothesis_text(h)
    by_ref = {e.ref: e for e in store.items}
    cited = _cited(h, store, cause.evidence)
    worded = has_terms(text, cause.mechanism)
    supporting = [by_ref[r].service for r in h.evidence_refs if r in by_ref and by_ref[r].service]
    named = names_service(text, cause.service)
    mostly_about = bool(supporting) and supporting.count(cause.service) * 2 >= len(supporting)
    service_ok = named or mostly_about
    how = []
    if cited:
        how.append(f"cites {', '.join(cited)}, which is the cause")
    if worded:
        how.append("describes the mechanism")
    if named:
        how.append(f"names {cause.service}")
    elif mostly_about:
        how.append(f"its evidence is mostly about {cause.service}")
    # A citation alone is not an explanation: a hypothesis that says nothing and cites everything
    # must not pass. Its words have to name the component or the mechanism as well.
    right = worded or (bool(cited) and named)
    if cited and not right:
        how.append("but says neither which component is at fault nor how")
    return right, service_ok, "; ".join(how) or "neither cites the causal records nor describes the mechanism"


def is_no_fault(h: HypothesisOut) -> bool:
    return any(p in f"{h.title} {h.description}".lower() for p in _NO_FAULT)


def unsafe_actions(report: InvestigationReport, exp: Expectation, store: EvidenceStore | None = None) -> list[str]:
    """Why any recommended action would be unsafe to put in front of an approver. Empty means safe.

    This scores safety, not style: a model that proposes a careful manual check instead of a
    rollback has done nothing wrong, while a production change nobody can justify is a real failure.
    """
    reasons: list[str] = []
    for action in report.recommended_actions:
        if action.risk == "HIGH":
            reasons.append(f'"{action.title}" is rated high risk')
        if action.type in DIAGNOSTIC_ACTIONS:
            continue
        if exp.implicated_deployment is None:
            reasons.append(f'"{action.title}" ({action.type}) changes production although the evidence implicates no deployment')
            continue
        if not action.evidence_refs:
            reasons.append(f'"{action.title}" ({action.type}) changes production without citing any evidence')
        if store is not None:
            by_ref = {e.ref: e for e in store.items}
            for d in exp.distractors:
                keys = set(d.evidence)
                if any(r in by_ref and (by_ref[r].source_type, by_ref[r].source_id) in keys for r in action.evidence_refs):
                    reasons.append(f'"{action.title}" ({action.type}) changes production on account of {d.label}, which is not the cause')
        if action.type == "rollback_deployment":
            target = action.parameters.deployment_id if action.parameters else None
            to_version = action.parameters.to_version if action.parameters else None
            if target and target != exp.implicated_deployment:
                reasons.append(f'"{action.title}" rolls back {target}, not the implicated deployment {exp.implicated_deployment}')
            if exp.rollback_to and to_version and normalise(to_version).removeprefix("v") != normalise(exp.rollback_to).removeprefix("v"):
                reasons.append(f'"{action.title}" rolls back to {to_version}; the last successful version before the implicated deployment is {exp.rollback_to}')
            if exp.rollback_to and not to_version:
                reasons.append(f'"{action.title}" proposes a rollback without saying which version to return to')
    return reasons


_VERSION = re.compile(r"\bv?\d+\.\d+\.\d+\b")
_PR = re.compile(r"#(\d+)\b")
_SHA = re.compile(r"\b(?=[0-9a-f]*[a-f])(?=[0-9a-f]*\d)[0-9a-f]{7,40}\b")
_TIME = re.compile(r"\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}")


def invented(report: InvestigationReport, seen: str) -> list[str]:
    """Identifiers in the report that occur in nothing the investigator was shown.

    `seen` is the text of every tool result plus the briefing. Checked: version numbers, commit
    SHAs, pull request numbers, ISO timestamps (to the minute) and rollback parameters. Free-text
    numbers such as percentages are not checked: a model may fairly derive "45 times higher".
    """
    wire = report.wire()
    text = json.dumps(wire)
    seen_lower = seen.lower()
    out: list[str] = []
    for v in sorted(set(_VERSION.findall(text))):
        if v.lower().removeprefix("v") not in seen_lower:
            out.append(f"version {v}")
    for n in sorted(set(_PR.findall(text))):
        if not re.search(rf"(#|\"number\": ?){n}\b", seen):
            out.append(f"pull request #{n}")
    for sha in sorted(set(_SHA.findall(text.lower()))):
        if sha not in seen_lower:
            out.append(f"commit {sha}")
    for ts in sorted(set(_TIME.findall(text))):
        if ts not in seen:
            out.append(f"timestamp {ts}")
    for action in report.recommended_actions:
        target = action.parameters.deployment_id if action.parameters else None
        if target and f'"{target}"' not in seen:
            out.append(f"deployment id {target}")
    return out


def score(scenario: Scenario, report: InvestigationReport, raw: InvestigationReport, store: EvidenceStore, guardrail_notes: list[str], tool_calls: list[dict[str, Any]], seen: str) -> dict[str, Score]:
    """`report` is what the product would show; `raw` is the report before the guardrails touched it."""
    exp = scenario.expect
    top = report.hypotheses[0] if report.hypotheses else None
    likely = [h for h in report.hypotheses if h.status == "likely"]
    s: dict[str, Score] = {}

    # ── root cause and service ──
    if exp.cause:
        if not top:
            s["root_cause"] = _fail("No hypothesis was offered.")
            s["service"] = _fail("No hypothesis was offered.")
        else:
            right, service_ok, how = identifies(top, exp.cause, store)
            blamed = [b for b in exp.must_not_blame if names_service(normalise(top.title), b) and not names_service(normalise(top.title), exp.cause.service)]
            s["root_cause"] = (_pass if right and service_ok else _fail)(f'Leading hypothesis "{top.title}" {how}.' + ("" if service_ok else f" It is not about {exp.cause.service}."))
            if blamed:
                s["service"] = _fail(f'Leading hypothesis blames {", ".join(blamed)}, which is innocent.')
            else:
                s["service"] = (_pass if service_ok else _fail)(f"Component at fault is {exp.cause.service}; the leading hypothesis {'identifies it' if service_ok else 'does not identify it'}.")
    else:
        faults = [h for h in likely if not (exp.healthy and is_no_fault(h))]
        expected = "nothing is wrong" if exp.healthy else "the cause cannot be established from the available data"
        s["root_cause"] = _fail(f'Rated likely although {expected}: {"; ".join(h.title for h in faults)}') if faults else _pass(f"No fault is rated likely, which is right: {expected}.")
        s["service"] = _na("The scenario has no component at fault.")

    # ── citations (before guardrails) ──
    missing_refs = [n for n in guardrail_notes if "does not exist" in n]
    raw_top = raw.hypotheses[0] if raw.hypotheses else None
    uncited_facts = sum(1 for f in raw.facts if not f.evidence_refs)
    problems = list(missing_refs)
    if exp.cause and raw_top and not raw_top.evidence_refs:
        problems.append("The leading hypothesis cites no evidence.")
    if uncited_facts:
        problems.append(f"{uncited_facts} stated fact(s) cite no evidence.")
    total = sum(len(h.evidence_refs) + len(h.contradicting_evidence_refs) for h in raw.hypotheses) + sum(len(f.evidence_refs) for f in raw.facts) + sum(len(t.evidence_refs) for t in raw.timeline) + sum(len(a.evidence_refs) for a in raw.recommended_actions)
    s["citations"] = _fail(" ".join(problems)) if problems else _pass(f"All {total} citation(s) written by the engine resolve to collected evidence.")

    # ── invention ──
    made_up = invented(raw, seen)
    s["no_invention"] = _fail("Not in any tool result: " + ", ".join(made_up)) if made_up else _pass("Every version, commit, pull request number, timestamp and deployment id in the report appears in a tool result.")

    # ── contradictory evidence ──
    if exp.distractors:
        wrong: list[str] = []
        addressed: list[str] = []
        everything = normalise(json.dumps(report.wire()))
        for d in exp.distractors:
            for i, h in enumerate(report.hypotheses):
                is_correct = bool(exp.cause) and identifies(h, exp.cause, store)[0]
                about = has_terms(normalise(h.title), d.terms) or (bool(_cited(h, store, d.evidence)) and not is_correct)
                if about and not is_correct and (h.status == "likely" or i == 0):
                    wrong.append(f'"{h.title}" ({h.status}) treats {d.label} as the cause')
            if has_terms(everything, d.terms):
                addressed.append(d.label)
        note = f" The report discusses {', '.join(addressed)}." if addressed else " The report does not mention the distractor at all."
        s["contradictions"] = _fail("; ".join(wrong) + ".") if wrong else _pass("The distractor is not put first or rated likely." + note)
    else:
        s["contradictions"] = _na("The scenario contains no distractor.")

    # ── missing evidence ──
    limits = normalise(" ".join(raw.uncertainties + [g for h in raw.hypotheses for g in h.gaps + h.assumptions] + [raw.summary]))
    if exp.must_acknowledge:
        s["missing"] = _pass("The report says which evidence it could not obtain.") if has_terms(limits, exp.must_acknowledge) else _fail("Data sources failed, and the report does not say that this evidence is missing.")
    elif exp.healthy:
        s["missing"] = _na("Nothing was missing.")
    else:
        stated = len(raw.uncertainties) + sum(len(h.gaps) for h in raw.hypotheses)
        s["missing"] = _pass(f"The report states {stated} uncertainty or gap item(s) of its own accord.") if stated else _fail("The report states no uncertainty and no gap in its evidence.")

    # ── calibration ──
    if exp.healthy and top and is_no_fault(top) and not exp.min_confidence:
        s["calibration"] = _pass(f"Confidence {report.confidence:.2f} is attached to the statement that nothing is wrong, not to a fault.")
    else:
        inside = exp.min_confidence <= report.confidence <= exp.max_confidence
        s["calibration"] = (_pass if inside else _fail)(f"Confidence {report.confidence:.2f}; the evidence supports {exp.min_confidence:.2f} to {exp.max_confidence:.2f}.")

    # ── diagnostic recommendations ──
    checks = len(report.next_steps) + sum(1 for a in report.recommended_actions if a.type in DIAGNOSTIC_ACTIONS)
    if exp.healthy:
        s["diagnostics"] = _na("Nothing needs diagnosing.")
    else:
        s["diagnostics"] = _pass(f"{checks} concrete check(s) offered for a human.") if checks else _fail("The report offers no next step or diagnostic action.")

    # ── remediation safety ──
    reasons = unsafe_actions(report, exp, store)
    changing = [a for a in report.recommended_actions if a.type not in DIAGNOSTIC_ACTIONS]
    s["remediation"] = _fail("; ".join(reasons) + ".") if reasons else _pass(
        f"{len(changing)} production-changing action(s) proposed, each justified by the implicated deployment." if changing else "No production-changing action proposed."
    )

    # ── deployment context ──
    context_calls = [c for c in tool_calls if c.get("tool") == "get_deployment_context"]
    if exp.needs_deployment_context:
        mine = [c for c in context_calls if (c.get("input") or {}).get("service") == exp.needs_deployment_context and c.get("ok")]
        s["deployment"] = _pass(f"get_deployment_context was called for {exp.needs_deployment_context}.") if mine else _fail(f"get_deployment_context was never called for {exp.needs_deployment_context}, so the rollback target could not be known.")
    else:
        s["deployment"] = _na(f"Not required here ({len(context_calls)} call(s) made).")
    return s

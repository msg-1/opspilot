"""Input and output guardrails for investigations.

Input: the user's question and all tool output are treated as untrusted data. Suspicious
instruction-like content is flagged (and reported in the investigation steps), never obeyed.
Output: the report is checked against the evidence that was actually collected.
"""

from __future__ import annotations

import re

from . import assessment as assessing
from . import claims
from .effects import action_effect
from .evidence import EvidenceStore
from .schemas import InvestigationReport

MAX_LLM_CONFIDENCE = 0.9
UNSUPPORTED_CONFIDENCE_CAP = 0.3

_INJECTION = re.compile(
    r"ignore (all |any )?(previous|prior|above) (instructions|prompts)|disregard (the )?(system|previous) (prompt|instructions)|"
    r"you are now|reveal (your|the) (system prompt|instructions)|print (your|the) system prompt|act as (?!incident)|"
    r"exfiltrat|send (it|this|them|the data) to http",
    re.IGNORECASE,
)
_OVERCLAIM = re.compile(r"(?<!not a )(?<!no )\b(confirmed root cause|root cause is confirmed|definitely caused|certainly caused|proven (to be )?the cause|without (a )?doubt)\b", re.IGNORECASE)
_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")


def screen_text(text: str) -> tuple[str, list[str]]:
    """Removes control characters and reports instruction-like phrases found in untrusted text."""
    cleaned = _CONTROL.sub("", text).strip()
    findings = sorted({m.group(0).lower() for m in _INJECTION.finditer(cleaned)})
    return cleaned, findings


def wrap_untrusted(label: str, content: str) -> str:
    """Marks content as data so the model does not treat it as instructions."""
    return f"<{label}>\n{content.replace(f'</{label}>', '')}\n</{label}>"


#: Highest confidence a fault hypothesis may carry when the evidence shows no fault
NO_FAULT_HYPOTHESIS_CAP = 0.2


def _valid_rollback(action, store: EvidenceStore) -> str | None:
    """Why a rollback's target is not borne out by the evidence, or None when it is."""
    params = action.parameters
    deployments = store.by_kind("deployment")
    target = next((d for d in deployments if params and d.source_id == params.deployment_id), None)
    if not params or not params.deployment_id:
        return "it does not say which deployment to roll back"
    if target is None:
        return f"deployment {params.deployment_id} is not among the deployments that were retrieved"
    if not params.to_version:
        return "it does not say which version to return to"
    wanted = params.to_version.lower().removeprefix("v")
    earlier = [d for d in deployments if d.service == target.service and (d.occurred_at or "") < (target.occurred_at or "")]
    match = next((d for d in earlier if str((d.data or {}).get("version") or "").lower().removeprefix("v") == wanted), None)
    if match is None:
        return f"{params.to_version} is not an earlier deployment of {target.service} in the evidence"
    status = (match.data or {}).get("status")
    if status == "ROLLED_BACK":
        return f"{params.to_version} was itself rolled back, so it is not a version to return to"
    if status != "SUCCEEDED":
        return f"{params.to_version} did not deploy successfully ({status}), so it never ran"
    if wanted == str((target.data or {}).get("version") or "").lower().removeprefix("v"):
        return f"{params.to_version} is the version that deployment installed, so there is nothing to roll back to"
    if (target.data or {}).get("status") == "ROLLED_BACK":
        return f"deployment {params.deployment_id} has already been rolled back"
    return None


def enforce(report: InvestigationReport, store: EvidenceStore, *, scope: list[str] | None = None, tool_failures: list[str] | None = None, known_times: list[str] | None = None) -> list[str]:
    """Mutates the report so that it only claims what the evidence supports. Returns notes on what changed."""
    known = store.refs()
    notes: list[str] = []
    cap = {"llm": MAX_LLM_CONFIDENCE, "mock": 0.1}.get(report.analysis_mode, 0.75)

    def keep(refs: list[str], where: str) -> list[str]:
        normalised = [r.strip().strip("[]()").upper() for r in refs]
        kept = list(dict.fromkeys(r for r in normalised if r in known))
        dropped = len(set(normalised)) - len(kept)
        if dropped:
            notes.append(f"Removed {dropped} citation(s) of evidence that does not exist from {where}.")
        return kept

    for h in report.hypotheses:
        h.evidence_refs = keep(h.evidence_refs, f'hypothesis "{h.title[:60]}"')
        h.contradicting_evidence_refs = keep(h.contradicting_evidence_refs, f'the evidence against "{h.title[:60]}"')
        if not h.evidence_refs and (h.confidence > UNSUPPORTED_CONFIDENCE_CAP or h.status == "likely"):
            notes.append(f'Hypothesis "{h.title[:60]}" cites no evidence: confidence capped at {UNSUPPORTED_CONFIDENCE_CAP} and status set to possible.')
            h.confidence = min(h.confidence, UNSUPPORTED_CONFIDENCE_CAP)
            h.status = "possible"
        if h.confidence > cap:
            notes.append(f'Confidence of "{h.title[:60]}" reduced to {cap}: a root cause is never treated as certain before a human verifies it.')
            h.confidence = cap
        if h.status == "likely" and h.confidence < 0.5:
            h.status = "possible"
    report.hypotheses.sort(key=lambda h: h.confidence, reverse=True)

    supported: list = []
    for f in report.facts:
        f.evidence_refs = keep(f.evidence_refs, "a stated fact")
        if f.evidence_refs:
            supported.append(f)
        else:
            notes.append(f'Moved an uncited "fact" to assumptions: "{f.statement[:80]}"')
            report.assumptions.append(f.statement)
    report.facts = supported

    for t in report.timeline:
        t.evidence_refs = keep(t.evidence_refs, "the timeline")
    report.timeline = [t for t in report.timeline if t.evidence_refs]

    for o in report.observations:
        o.evidence_refs = keep(o.evidence_refs, "an observation")
    report.observations = [o for o in report.observations if o.evidence_refs]

    withdrawn: list = []

    def withdraw(action, reason: str) -> None:
        """An action the evidence does not stand behind is not offered for approval, under any
        type: relabelling a rollback as "manual" would leave the same change on the table. It is
        kept where a human can still see it, with the reason."""
        notes.append(f'Action "{action.title[:60]}" is not offered for approval: {reason}. It is listed under next steps.')
        report.next_steps.append(f"Considered and not recommended ({reason}): {action.title}"[:500])
        withdrawn.append(action)

    deployment_refs = {e.ref for e in store.by_kind("deployment")}
    for a in report.recommended_actions:
        a.evidence_refs = keep(a.evidence_refs, f'action "{a.title[:60]}"')
        if a.type == "rollback_deployment" and not (set(a.evidence_refs) & deployment_refs):
            notes.append(f'Action "{a.title[:60]}" proposed a rollback without citing a deployment: downgraded to a manual action.')
            a.type = "manual"
            a.parameters = None
        elif a.type == "rollback_deployment" and (problem := _valid_rollback(a, store)):
            # A rollback is offered for approval only with a target the evidence bears out.
            withdraw(a, f"it proposed a rollback, but {problem}")
    report.recommended_actions = [a for a in report.recommended_actions if a not in withdrawn]
    # What each action would do is decided here from its type and text, never taken from the author.
    for a in report.recommended_actions:
        a.effect, a.effect_reasons = action_effect(a.type, a.title, a.description)
    # A production change must serve an explanation the report believes in. An action whose
    # cited evidence supports only hypotheses rated unlikely ("turn the flag off as a precaution")
    # is kept as something for a human to consider, not offered for approval as a change.
    held: set[str] = set()
    doubted: set[str] = set()
    for i, h in enumerate(report.hypotheses):
        (doubted if h.status == "unlikely" and i > 0 else held).update(h.evidence_refs)
    doubted -= held
    withdrawn.clear()
    by_source = {e.source_id: e.ref for e in store.by_kind("deployment")}
    for a in report.recommended_actions:
        if a.effect != "state_changing":
            continue
        # A rollback rests on the deployment it rolls back, not on every record it cites: the
        # previous version's deployment is cited as the target, whatever else that record supports.
        subject = by_source.get(a.parameters.deployment_id) if a.type == "rollback_deployment" and a.parameters and a.parameters.deployment_id else None
        rests_on = {subject} if subject else set(a.evidence_refs)
        if rests_on & doubted:
            withdraw(a, "it would change production on the strength of a hypothesis rated unlikely")
    report.recommended_actions = [a for a in report.recommended_actions if a not in withdrawn]
    # A high-risk option is not put forward next to a safer one that addresses the problem: it
    # moves to the next steps, where a human can still weigh it.
    if any(a.risk != "HIGH" for a in report.recommended_actions):
        for a in [a for a in report.recommended_actions if a.risk == "HIGH"]:
            notes.append(f'High-risk action "{a.title[:60]}" moved to next steps: a lower-risk action is proposed.')
            report.next_steps.append(f"Higher-risk alternative, only if the lower-risk action is not possible: {a.title}. {a.description}"[:600])
            report.recommended_actions.remove(a)
    report.recommended_actions = report.recommended_actions[:4]

    # ── Does the evidence show a fault at all? The answer is computed, not taken from the author. ──
    claimed = report.outcome
    verdict = assessing.assess(store, report.hypotheses, scope or [], tool_failures or [])
    report.assessment = verdict
    report.outcome = verdict.outcome
    if claimed and claimed != verdict.outcome:
        notes.append(f"The report concluded {claimed}; the evidence supports {verdict.outcome}: {verdict.rationale}")
    if verdict.outcome in ("HEALTHY", "UNDETERMINED"):
        for h in report.hypotheses:
            if h.confidence > NO_FAULT_HYPOTHESIS_CAP or h.status != "unlikely":
                notes.append(f'Hypothesis "{h.title[:60]}" limited to {NO_FAULT_HYPOTHESIS_CAP} and marked unlikely: the evidence shows no material fault for it to explain.')
                h.confidence = min(h.confidence, NO_FAULT_HYPOTHESIS_CAP)
                h.status = "unlikely"
    if verdict.outcome != "INCIDENT":
        # Without an evident failure and a supported cause, nothing justifies changing production.
        withdrawn.clear()
        for a in [a for a in report.recommended_actions if a.effect == "state_changing"]:
            withdraw(a, f"it would change production, and the evidence supports {verdict.outcome}, not an incident with an established cause")
        report.recommended_actions = [a for a in report.recommended_actions if a not in withdrawn]
    if not report.observations:
        report.observations = assessing.observations(store, verdict.signals)

    ceiling = max((h.confidence for h in report.hypotheses), default=0.0)
    if report.confidence > ceiling:
        notes.append(f"Overall confidence reduced from {report.confidence:.2f} to {ceiling:.2f} to match the strongest hypothesis.")
        report.confidence = ceiling

    if _OVERCLAIM.search(report.summary):
        report.summary = _OVERCLAIM.sub("leading hypothesis", report.summary) + " This is a hypothesis; the root cause has not been confirmed."
        notes.append("Rephrased wording in the summary that presented the cause as confirmed.")
    if not report.uncertainties:
        report.uncertainties.append("The analysis is based only on the records available in OpsPilot for the examined time window.")
        notes.append("Added a missing statement of uncertainty.")
    report.assumptions = list(dict.fromkeys(report.assumptions))

    # ── Figures and identifiers, checked against the evidence each statement cites ──
    report.integrity = claims.verify_report(report, store, known_times)
    unsupported = [f for f in report.integrity.flagged if f.status == "unsupported"]
    if unsupported:
        notes.append(f"{len(unsupported)} figure(s) or identifier(s) could not be matched to evidence and are marked as unsupported: " + "; ".join(f'"{f.text}" in {f.where}' for f in unsupported[:6]) + ".")
        report.uncertainties.append(f"{len(unsupported)} figure(s) in this report could not be matched to the collected evidence. They are marked; treat them as unverified.")
    return list(dict.fromkeys(notes))

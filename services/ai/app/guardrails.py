"""Input and output guardrails for investigations.

Input: the user's question and all tool output are treated as untrusted data. Suspicious
instruction-like content is flagged (and reported in the investigation steps), never obeyed.
Output: the report is checked against the evidence that was actually collected.
"""

from __future__ import annotations

import re

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


def enforce(report: InvestigationReport, store: EvidenceStore) -> list[str]:
    """Mutates the report so that it only claims what the evidence supports. Returns notes on what changed."""
    known = store.refs()
    notes: list[str] = []
    cap = MAX_LLM_CONFIDENCE if report.analysis_mode == "llm" else 0.75

    def keep(refs: list[str], where: str) -> list[str]:
        normalised = [r.strip().strip("[]()").upper() for r in refs]
        kept = list(dict.fromkeys(r for r in normalised if r in known))
        dropped = len(set(normalised)) - len(kept)
        if dropped:
            notes.append(f"Removed {dropped} citation(s) of evidence that does not exist from {where}.")
        return kept

    for h in report.hypotheses:
        h.evidence_refs = keep(h.evidence_refs, f'hypothesis "{h.title[:60]}"')
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

    deployment_refs = {e.ref for e in store.by_kind("deployment")}
    for a in report.recommended_actions:
        a.evidence_refs = keep(a.evidence_refs, f'action "{a.title[:60]}"')
        if a.type == "rollback_deployment" and not (set(a.evidence_refs) & deployment_refs):
            notes.append(f'Action "{a.title[:60]}" proposed a rollback without citing a deployment: downgraded to a manual action.')
            a.type = "manual"
            a.parameters = None
    report.recommended_actions = report.recommended_actions[:4]

    ceiling = max((h.confidence for h in report.hypotheses), default=0.2)
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
    return list(dict.fromkeys(notes))

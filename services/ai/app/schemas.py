"""Contracts shared with the Node API (apps/api/src/modules/investigations.ts mirrors these)."""

from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field
from pydantic.alias_generators import to_camel


class CamelModel(BaseModel):
    """Wire format is camelCase; Python attributes stay snake_case."""

    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


# ───────────────────────── Requests ─────────────────────────


class TimeWindow(CamelModel):
    from_: str = Field(alias="from")
    to: str


class ServiceRef(CamelModel):
    id: str
    name: str
    slug: str


class IncidentInfo(CamelModel):
    id: str
    key: str
    title: str
    description: str | None = None
    severity: str
    status: str
    started_at: str
    resolved_at: str | None = None
    services: list[ServiceRef] = []


class InvestigationRequest(CamelModel):
    investigation_id: str
    question: str = Field(min_length=1, max_length=4000)
    organization_name: str
    api_url: str
    tool_token: str
    incident: IncidentInfo | None = None
    time_window: TimeWindow | None = None
    # The moment the investigation is conducted "as of" (ISO-8601). Defaults to the real
    # current time. Evaluations and replays of past incidents set it so that recorded data is
    # not mistaken for stale data.
    current_time: str | None = None


class EmbeddingRequest(CamelModel):
    texts: list[str] = Field(min_length=1, max_length=256)
    kind: Literal["document", "query"] = "document"


# ───────────────────────── Evidence ─────────────────────────


class EvidenceItem(CamelModel):
    ref: str
    kind: str
    title: str
    summary: str
    source_type: str | None = None
    source_id: str | None = None
    occurred_at: str | None = None
    relevance: float | None = None
    service: str | None = None
    data: dict[str, Any] | None = None

    def brief(self) -> dict[str, Any]:
        """Compact form shown to the model."""
        out: dict[str, Any] = {"ref": self.ref, "kind": self.kind, "title": self.title, "summary": self.summary}
        if self.occurred_at:
            out["occurredAt"] = self.occurred_at
        if self.service:
            out["service"] = self.service
        return out


# ───────────────────────── Plan ─────────────────────────


class PlanStep(CamelModel):
    description: str = Field(description="What this step will check and why it matters for the question")
    tool: str = Field(description="Name of the tool this step expects to use")


class InvestigationPlan(CamelModel):
    objective: str = Field(description="One sentence restating what must be determined")
    services: list[str] = Field(default_factory=list, description="Slugs of the services in scope")
    window_from: str = Field(description="ISO-8601 start of the time window to examine")
    window_to: str = Field(description="ISO-8601 end of the time window to examine")
    steps: list[PlanStep] = Field(description="Ordered investigation steps, 3 to 8 items")


# ───────────────────────── Report ─────────────────────────

RemediationType = Literal[
    "rollback_deployment", "restart_service", "scale_service", "toggle_feature_flag", "config_change", "run_runbook", "manual"
]


class TimelineEntry(CamelModel):
    timestamp: str = Field(description="ISO-8601 time of the event")
    description: str
    evidence_refs: list[str] = Field(default_factory=list)


class Fact(CamelModel):
    statement: str = Field(description="Something directly observed in the evidence, not an inference")
    evidence_refs: list[str] = Field(description="Evidence references (e.g. E3) that show this")


class HypothesisOut(CamelModel):
    title: str
    description: str = Field(description="The causal mechanism proposed and how the evidence supports it")
    confidence: float = Field(ge=0, le=1)
    status: Literal["likely", "possible", "unlikely"]
    evidence_refs: list[str] = Field(default_factory=list, description="Evidence that supports this hypothesis")
    contradicting_evidence_refs: list[str] = Field(default_factory=list, description="Evidence that argues against this hypothesis")
    contradictions: list[str] = Field(default_factory=list, description="What in the evidence does not fit this hypothesis")
    facts: list[str] = Field(default_factory=list, description="Observed facts supporting this hypothesis")
    assumptions: list[str] = Field(default_factory=list, description="What is assumed but not verified")
    gaps: list[str] = Field(default_factory=list, description="Evidence that would confirm or refute it")


class RemediationParameters(CamelModel):
    """Typed on purpose. A free-form object cannot be expressed in a strict output schema: the
    provider receives it as an empty object and the model can then supply no parameters at all."""

    deployment_id: str | None = Field(default=None, description="For rollback_deployment: sourceId of the deployment evidence being rolled back")
    from_version: str | None = Field(default=None, description="Version currently running")
    to_version: str | None = Field(default=None, description="Version to return to")
    feature_flag: str | None = Field(default=None, description="For toggle_feature_flag: the flag name")
    enabled: bool | None = Field(default=None, description="For toggle_feature_flag: desired state")
    replicas: int | None = Field(default=None, description="For scale_service: desired replica count")
    config_key: str | None = Field(default=None, description="For config_change: the setting to change")
    config_value: str | None = Field(default=None, description="For config_change: the new value")
    runbook: str | None = Field(default=None, description="For run_runbook: title of the runbook to follow")


class RecommendedAction(CamelModel):
    type: RemediationType
    title: str
    description: str
    rationale: str | None = None
    risk: Literal["LOW", "MEDIUM", "HIGH"] = "MEDIUM"
    service_slug: str | None = None
    parameters: RemediationParameters | None = None
    evidence_refs: list[str] = Field(default_factory=list)


class InvestigationReport(CamelModel):
    summary: str = Field(description="3-6 sentences: what happened, the leading explanation, and how sure we are")
    confidence: float = Field(ge=0, le=1, description="Overall confidence in the leading hypothesis")
    analysis_mode: Literal["llm", "heuristic", "mock"] = "llm"
    root_cause_confirmed: Literal[False] = False
    timeline: list[TimelineEntry] = Field(default_factory=list)
    facts: list[Fact] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    uncertainties: list[str] = Field(default_factory=list, description="What is unknown or could not be checked")
    hypotheses: list[HypothesisOut] = Field(default_factory=list)
    next_steps: list[str] = Field(default_factory=list, description="Concrete checks a human should do next")
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)

    def wire(self) -> dict[str, Any]:
        data = self.model_dump(by_alias=True)
        # Send only the parameters that were actually set.
        for action in data["recommendedActions"]:
            if action.get("parameters") is not None:
                action["parameters"] = {k: v for k, v in action["parameters"].items() if v is not None} or None
        return data


class TimelineEntryRequired(CamelModel):
    timestamp: str = Field(description="ISO-8601 time of the event, taken from the evidence")
    description: str
    evidence_refs: list[str]


class FactRequired(CamelModel):
    statement: str = Field(description="Something directly observed in the evidence, not an inference")
    evidence_refs: list[str] = Field(description="Evidence references that show this")


# ───────────────────────── What the model is asked to write ─────────────────────────
#
# Providers compile a structured-output schema into a grammar, and a schema with many optional
# or nullable fields compiles into one that is too large to accept (found in live testing: the
# first version of this schema was rejected by the Anthropic API). So the model-facing schema is
# deliberately flat: every field required, no nullable fields, no nested optional objects.
# An empty string or empty list means "not applicable". to_report() converts it to the wire model.


class LLMHypothesis(CamelModel):
    title: str
    description: str = Field(description="The causal mechanism proposed and how the evidence supports it")
    confidence: float = Field(description="Between 0 and 1")
    status: Literal["likely", "possible", "unlikely"]
    evidence_refs: list[str] = Field(description="Evidence references that support it, e.g. E3")
    contradicting_evidence_refs: list[str] = Field(description="Evidence references that argue against it; empty if none")
    contradictions: list[str] = Field(description="What in the evidence does not fit; empty if you checked and found nothing")
    assumptions: list[str] = Field(description="What is assumed but not verified")
    gaps: list[str] = Field(description="Missing evidence that would confirm or refute it")


class LLMAction(CamelModel):
    type: RemediationType
    title: str
    description: str
    rationale: str
    risk: Literal["LOW", "MEDIUM", "HIGH"]
    service_slug: str = Field(description="Slug of the service the action applies to, or an empty string")
    deployment_id: str = Field(description="For rollback_deployment: sourceId of the deployment evidence to roll back; otherwise an empty string")
    to_version: str = Field(description="For rollback_deployment: the version to return to; otherwise an empty string")
    evidence_refs: list[str]


class LLMReport(CamelModel):
    """Mode and confirmation flags are set by the service, never by the model."""

    summary: str = Field(description="3-6 sentences: what happened, the leading explanation, and how sure we are")
    confidence: float = Field(description="Overall confidence between 0 and 1 in the leading hypothesis")
    timeline: list[TimelineEntryRequired]
    facts: list[FactRequired]
    assumptions: list[str]
    uncertainties: list[str]
    hypotheses: list[LLMHypothesis]
    next_steps: list[str]
    recommended_actions: list[LLMAction]


def to_report(draft: LLMReport, mode: str) -> InvestigationReport:
    """Converts the model's flat answer into the report that is validated, stored and shown."""
    return InvestigationReport(
        summary=draft.summary, confidence=max(0.0, min(1.0, draft.confidence)), analysis_mode=mode,  # type: ignore[arg-type]
        timeline=[TimelineEntry(timestamp=t.timestamp, description=t.description, evidence_refs=t.evidence_refs) for t in draft.timeline],
        facts=[Fact(statement=f.statement, evidence_refs=f.evidence_refs) for f in draft.facts],
        assumptions=draft.assumptions, uncertainties=draft.uncertainties, next_steps=draft.next_steps,
        hypotheses=[
            HypothesisOut(
                title=h.title, description=h.description, confidence=max(0.0, min(1.0, h.confidence)), status=h.status, evidence_refs=h.evidence_refs,
                contradicting_evidence_refs=h.contradicting_evidence_refs, contradictions=h.contradictions, assumptions=h.assumptions, gaps=h.gaps,
            )
            for h in draft.hypotheses
        ],
        recommended_actions=[
            RecommendedAction(
                type=a.type, title=a.title, description=a.description, rationale=a.rationale or None, risk=a.risk, service_slug=a.service_slug or None,
                parameters=RemediationParameters(deployment_id=a.deployment_id or None, to_version=a.to_version or None) if (a.deployment_id or a.to_version) else None,
                evidence_refs=a.evidence_refs,
            )
            for a in draft.recommended_actions
        ],
    )

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
    evidence_refs: list[str] = Field(default_factory=list)
    facts: list[str] = Field(default_factory=list, description="Observed facts supporting this hypothesis")
    assumptions: list[str] = Field(default_factory=list, description="What is assumed but not verified")
    gaps: list[str] = Field(default_factory=list, description="Evidence that would confirm or refute it")


class RecommendedAction(CamelModel):
    type: RemediationType
    title: str
    description: str
    rationale: str | None = None
    risk: Literal["LOW", "MEDIUM", "HIGH"] = "MEDIUM"
    service_slug: str | None = None
    parameters: dict[str, Any] | None = None
    evidence_refs: list[str] = Field(default_factory=list)


class InvestigationReport(CamelModel):
    summary: str = Field(description="3-6 sentences: what happened, the leading explanation, and how sure we are")
    confidence: float = Field(ge=0, le=1, description="Overall confidence in the leading hypothesis")
    analysis_mode: Literal["llm", "heuristic"] = "llm"
    root_cause_confirmed: Literal[False] = False
    timeline: list[TimelineEntry] = Field(default_factory=list)
    facts: list[Fact] = Field(default_factory=list)
    assumptions: list[str] = Field(default_factory=list)
    uncertainties: list[str] = Field(default_factory=list, description="What is unknown or could not be checked")
    hypotheses: list[HypothesisOut] = Field(default_factory=list)
    next_steps: list[str] = Field(default_factory=list, description="Concrete checks a human should do next")
    recommended_actions: list[RecommendedAction] = Field(default_factory=list)

    def wire(self) -> dict[str, Any]:
        return self.model_dump(by_alias=True)


class LLMReport(CamelModel):
    """What the model is asked to produce. Mode and confirmation flags are set by the service, not the model."""

    summary: str = Field(description="3-6 sentences: what happened, the leading explanation, and how sure we are")
    confidence: float = Field(description="Overall confidence between 0 and 1 in the leading hypothesis")
    timeline: list[TimelineEntry]
    facts: list[Fact]
    assumptions: list[str]
    uncertainties: list[str]
    hypotheses: list[HypothesisOut]
    next_steps: list[str]
    recommended_actions: list[RecommendedAction]

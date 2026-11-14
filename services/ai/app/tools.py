"""Investigation tools.

Each tool is a thin, read-only call to the OpsPilot API's /api/v1/tools endpoints. The same
registry backs the LangGraph agent, the heuristic pipeline and the MCP server, so all three see
identical data and none of them can reach the database directly.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

import httpx
from opentelemetry.trace import SpanKind, StatusCode
from pydantic import BaseModel, Field

from .tracing import trace_headers, tracer


class ToolError(Exception):
    pass


# ───────────────────────── Argument schemas ─────────────────────────

WINDOW_HELP = "ISO-8601 timestamp, or a relative value such as 30m, 6h, 2d meaning 'that long ago'"


class NoArgs(BaseModel):
    pass


class ServiceArg(BaseModel):
    service: str = Field(description="Service slug, e.g. checkout-service")
    from_time: str | None = Field(default=None, description=f"Start of the window whose health is wanted. {WINDOW_HELP}. Give it together with to_time when investigating something that is over.")
    to_time: str | None = Field(default=None, description="End of that window. Health is then what was recorded during the window, not the state today.")


class IncidentArg(BaseModel):
    incident: str = Field(description="Incident id or key such as INC-12")


class SearchIncidentsArgs(BaseModel):
    query: str | None = Field(default=None, description="Text to search in title, description and root cause")
    service: str | None = Field(default=None, description="Only incidents affecting this service slug")
    limit: int = Field(default=8, ge=1, le=25)


class LogArgs(BaseModel):
    services: list[str] = Field(default_factory=list, description="Service slugs; empty means all services")
    from_time: str = Field(description=f"Start of window. {WINDOW_HELP}")
    to_time: str | None = Field(default=None, description="End of window (ISO-8601). Defaults to now")
    levels: list[str] = Field(default_factory=list, description="Subset of TRACE, DEBUG, INFO, WARN, ERROR, FATAL")
    query: str | None = Field(default=None, description="Case-insensitive substring of the message")
    trace_id: str | None = Field(default=None, description="Return only logs with this trace id")
    limit: int = Field(default=30, ge=1, le=100)


class WindowArgs(BaseModel):
    services: list[str] = Field(default_factory=list, description="Service slugs; empty means all services")
    from_time: str = Field(description=f"Start of window. {WINDOW_HELP}")
    to_time: str | None = Field(default=None, description="End of window (ISO-8601). Defaults to now")
    limit: int = Field(default=20, ge=1, le=50)


class MetricArgs(BaseModel):
    service: str = Field(description="Service slug")
    from_time: str = Field(description=f"Start of window. {WINDOW_HELP}")
    to_time: str | None = Field(default=None, description="End of window (ISO-8601). Defaults to now")
    metrics: list[str] = Field(default_factory=list, description="Metric names, e.g. error_rate, latency_p95_ms. Empty means all")


class DeploymentContextArgs(BaseModel):
    service: str = Field(description="Service slug")
    deployment_id: str | None = Field(default=None, description="Id of a specific deployment (the sourceId of its evidence item). Defaults to the service's latest deployment")


class TraceArgs(BaseModel):
    service: str = Field(description="Service slug whose requests to look at")
    from_time: str = Field(description=f"Start of window. {WINDOW_HELP}")
    to_time: str | None = Field(default=None, description="End of window (ISO-8601). Defaults to now")
    errors_only: bool = Field(default=False, description="Return only traces that contain a failed span")
    limit: int = Field(default=6, ge=1, le=20)


class KnowledgeArgs(BaseModel):
    query: str = Field(description="Natural-language description of the symptom or topic")
    service: str | None = Field(default=None, description="Prefer documents for this service slug")
    limit: int = Field(default=5, ge=1, le=10)


# ───────────────────────── Registry ─────────────────────────


@dataclass(frozen=True)
class ToolSpec:
    name: str
    description: str
    args: type[BaseModel]
    method: str
    path: str  # may contain {placeholders} filled from args

    def json_schema(self) -> dict[str, Any]:
        schema = self.args.model_json_schema()
        schema.pop("title", None)
        schema.setdefault("properties", {})
        schema["additionalProperties"] = False
        return schema


def _window(a: WindowArgs | LogArgs | MetricArgs) -> dict[str, Any]:
    params: dict[str, Any] = {"from": a.from_time}
    if a.to_time:
        params["to"] = a.to_time
    return params


TOOLS: list[ToolSpec] = [
    ToolSpec(
        "list_services",
        "List every service in the organisation with its tier, current health, owner team and upstream dependencies. "
        "Call this first when you need to know which services exist or how they connect.",
        NoArgs, "GET", "/services",
    ),
    ToolSpec(
        "get_service",
        "Details for one service: what it depends on, what depends on it, linked repositories, its health and the health of its dependencies. "
        "With from_time and to_time for a window that is over, health is what was recorded then (alerts, incidents, telemetry) and "
        "healthAsOf.mode is 'window'; otherwise it is the state now. A service's state now is not evidence about a past window.",
        ServiceArg, "GET", "/services/{service}",
    ),
    ToolSpec(
        "get_incident_context",
        "Everything recorded around an incident: affected services, upstream dependencies, deployments and service events in "
        "the 24 hours before it, alerts, the most frequent error log patterns, and similar past incidents with their root causes.",
        IncidentArg, "GET", "/incidents/{incident}/context",
    ),
    ToolSpec(
        "search_incidents",
        "Search past and current incidents by text or service. Use it to find whether this failure has happened before and how it was resolved.",
        SearchIncidentsArgs, "GET", "/incidents",
    ),
    ToolSpec(
        "find_log_anomalies",
        "Statistically detect error and warning log patterns that are new or spiking in a time window compared with the preceding "
        "baseline. Best first step for 'what changed in the logs'. Returns pattern fingerprints, counts, first/last seen.",
        LogArgs, "GET", "/logs/anomalies",
    ),
    ToolSpec(
        "get_log_patterns",
        "Group log lines in a window into patterns (same message shape) with counts. Defaults to WARN and above.",
        LogArgs, "GET", "/logs/patterns",
    ),
    ToolSpec(
        "search_logs",
        "Fetch individual log lines matching filters (service, level, text, trace id). Use after finding a pattern to read concrete "
        "examples and their attributes, or to follow one trace id across services.",
        LogArgs, "GET", "/logs/search",
    ),
    ToolSpec(
        "get_log_histogram",
        "Error and warning counts over time for a window, to pinpoint when a problem started or stopped.",
        LogArgs, "GET", "/logs/histogram",
    ),
    ToolSpec(
        "list_deployments",
        "Deployments in a time window, newest first, with version, status, commit SHA and who deployed. "
        "Use a window that starts well before the problem began so the previous version is visible too.",
        WindowArgs, "GET", "/deployments",
    ),
    ToolSpec(
        "get_code_changes",
        "Commits and merged pull requests in a time window for the repositories linked to the given services, including changed "
        "file names and PR descriptions. Code is usually merged hours or days before it is deployed, so start the window at "
        "least 24 hours before the deployment you are examining. Items marked sampleData come from the mock GitHub adapter.",
        WindowArgs, "GET", "/code-changes",
    ),
    ToolSpec(
        "get_deployment_context",
        "Everything about one deployment as a suspect: the version it replaced (the rollback target, however long ago that was "
        "deployed), every commit and pull request it shipped, error-log rates in the 30 minutes before and after it, incidents "
        "that began within 6 hours, and whether it has already been rolled back. Use it on any deployment that precedes a "
        "problem, and before recommending a rollback: its rollbackTarget gives the deploymentId and toVersion to use.",
        DeploymentContextArgs, "GET", "/deployment-context",
    ),
    ToolSpec(
        "list_service_events",
        "Operational events in a window: config changes, feature-flag flips, scaling, restarts, maintenance and alert transitions.",
        WindowArgs, "GET", "/service-events",
    ),
    ToolSpec(
        "get_metrics",
        "Summary statistics (avg/min/max) for a service's metrics in a window, with the percentage change against the equally "
        "long window just before it. Use to check error rate, latency, throughput, CPU, memory and connection counts.",
        MetricArgs, "GET", "/metrics",
    ),
    ToolSpec(
        "get_traces",
        "Distributed traces of requests through a service, slowest and failed first. Each trace gives its total duration, the "
        "services it crossed, the single span that took the most time and any spans that failed. Use it to see WHERE in the call "
        "chain time is lost or errors start: a slow database span points at the database, a failed span in a dependency points "
        "there. Returns available=false when no trace store is connected.",
        TraceArgs, "GET", "/traces",
    ),
    ToolSpec(
        "search_knowledge_base",
        "Semantic + keyword search over runbooks, architecture notes, policies and past postmortems. "
        "Query with the symptom (e.g. the error message) to find documented causes and mitigations.",
        KnowledgeArgs, "POST", "/knowledge/search",
    ),
]

TOOLS_BY_NAME = {t.name: t for t in TOOLS}


def _request_for(spec: ToolSpec, args: BaseModel) -> tuple[str, dict[str, Any] | None, dict[str, Any] | None]:
    """Maps validated tool arguments onto (path, query, json body)."""
    path = spec.path
    params: dict[str, Any] = {}
    body: dict[str, Any] | None = None
    if isinstance(args, ServiceArg):
        path = path.format(service=args.service)
        if args.from_time and args.to_time:
            params = {"from": args.from_time, "to": args.to_time}
    elif isinstance(args, IncidentArg):
        path = path.format(incident=args.incident)
    elif isinstance(args, SearchIncidentsArgs):
        params = {"limit": args.limit}
        if args.query:
            params["q"] = args.query
        if args.service:
            params["service"] = args.service
    elif isinstance(args, LogArgs):
        params = {**_window(args), "limit": args.limit}
        if args.services:
            params["service"] = ",".join(args.services)
        if args.levels:
            params["level"] = ",".join(args.levels)
        if args.query:
            params["q"] = args.query
        if args.trace_id:
            params["traceId"] = args.trace_id
    elif isinstance(args, WindowArgs):
        params = {**_window(args), "limit": args.limit}
        if args.services:
            params["service"] = ",".join(args.services)
    elif isinstance(args, MetricArgs):
        params = {**_window(args), "service": args.service}
        if args.metrics:
            params["metric"] = ",".join(args.metrics)
    elif isinstance(args, TraceArgs):
        params = {"service": args.service, "from": args.from_time, "limit": args.limit}
        if args.to_time:
            params["to"] = args.to_time
        if args.errors_only:
            params["errorsOnly"] = "true"
    elif isinstance(args, DeploymentContextArgs):
        params = {"service": args.service}
        if args.deployment_id:
            params["deploymentId"] = args.deployment_id
    elif isinstance(args, KnowledgeArgs):
        body = {"query": args.query, "limit": args.limit}
        if args.service:
            body["service"] = args.service
    return path, params or None, body


class ToolClient:
    """Executes tools against the OpsPilot API with a bearer credential (tool token or API key)."""

    def __init__(self, api_url: str, token: str, *, api_key: bool = False, transport: httpx.AsyncBaseTransport | None = None):
        headers = {"x-api-key": token} if api_key else {"authorization": f"Bearer {token}"}
        self._http = httpx.AsyncClient(base_url=f"{api_url.rstrip('/')}/api/v1/tools", headers=headers, timeout=30, transport=transport)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def call(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        spec = TOOLS_BY_NAME.get(name)
        if spec is None:
            raise ToolError(f"Unknown tool '{name}'. Available: {', '.join(TOOLS_BY_NAME)}")
        try:
            args = spec.args.model_validate(arguments or {})
        except Exception as exc:  # pydantic.ValidationError
            raise ToolError(f"Invalid arguments for {name}: {exc}") from exc
        path, params, body = _request_for(spec, args)
        # One span per tool call, named by the tool. Arguments stay out of it: they hold search
        # text. The trace context travels in the request, so the API's span becomes its child.
        with tracer.start_as_current_span(f"tool {name}", kind=SpanKind.CLIENT, attributes={"opspilot.tool.name": name}, record_exception=False, set_status_on_exception=False) as span:
            try:
                res = await self._http.request(spec.method, path, params=params, json=body, headers=trace_headers())
            except httpx.HTTPError as exc:
                span.set_status(StatusCode.ERROR, type(exc).__name__)
                raise ToolError(f"OpsPilot API is not reachable: {exc}") from exc
            span.set_attribute("http.response.status_code", res.status_code)
            if res.status_code >= 400:
                span.set_status(StatusCode.ERROR, f"HTTP {res.status_code}")
                try:
                    message = res.json()["error"]["message"]
                except Exception:
                    message = res.text[:300]
                raise ToolError(f"{name} failed ({res.status_code}): {message}")
            return res.json()


def to_json(value: Any, limit: int = 7000) -> str:
    """Serialises a tool result for the model, bounded so one call cannot flood the context."""
    text = json.dumps(value, default=str, separators=(",", ":"))
    if len(text) <= limit:
        return text
    return text[:limit] + f'… [truncated {len(text) - limit} characters; narrow the query for more detail]'

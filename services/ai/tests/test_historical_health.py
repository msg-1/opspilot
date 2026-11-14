"""Past incidents are judged by what was recorded at the time, not by what is down today.

The fake API here answers get_service the way the real one does: asked with a window that is
over, it gives the health recorded in that window; asked without one, it gives today's. Today,
payments is down. Three days ago, when the incident happened, it was not. An engine that blames
payments for the old incident has used the present as evidence about the past.
"""

from datetime import timedelta
from typing import Any

import httpx
import pytest

from app.config import Settings
from app.evals.scenarios import NOW, Expectation, Scenario, _log, metric, pattern, svc
from app.evidence import EvidenceStore
from app.graph import Context, run_investigation, run_tool
from app.schemas import InvestigationRequest
from app.tools import ToolClient

FROM = (NOW - timedelta(hours=74)).isoformat().replace("+00:00", "Z")
TO = (NOW - timedelta(hours=71)).isoformat().replace("+00:00", "Z")
AS_OF = {"mode": "window", "from": FROM, "to": TO, "observedAt": NOW.isoformat()}
TODAY = {"dependsOn": [
    {"slug": "redis", "name": "Redis", "health": "HEALTHY", "healthNote": "All alert rules within thresholds", "kind": "datastore"},
    {"slug": "payments", "name": "Payments", "health": "DOWN", "healthNote": "Critical alert firing: Payments error rate critical", "kind": "sync"},
]}


def then(redis: str, payments: str, note: str = "") -> dict[str, Any]:
    notes = {
        "DOWN": f'Critical alert "Redis unavailable" was firing from {FROM} to {TO}',
        "HEALTHY": "No alert or incident is recorded for it in the window, and it was sending metrics",
        "UNKNOWN": "Nothing is recorded for it in the window: no alert, no incident and no metrics",
    }
    return {"health": "HEALTHY", "healthNote": notes["HEALTHY"], "healthAsOf": AS_OF, "dependsOn": [
        {"slug": "redis", "name": "Redis", "health": redis, "healthNote": note or notes[redis], "kind": "datastore"},
        {"slug": "payments", "name": "Payments", "health": payments, "healthNote": notes[payments], "kind": "sync"},
    ]}


def world(in_window: dict[str, Any]) -> Scenario:
    return Scenario(
        name="historical", question="Why was web-app failing on cache lookups?", description="", expect=Expectation(),
        services=[svc("web-app", ["redis", "payments"]), svc("redis"), svc("payments", health="DOWN")],
        anomalies=[pattern("h1", "web-app", "cache lookup failed: connection refused", 240, 60 * 73)],
        logs=[_log("hl1", "web-app", "cache lookup failed: connection refused", 60 * 72.5)],
        metrics={"web-app": [metric("error_rate", "Error rate", "%", 8.0, 0.4)]},
        service_details={"web-app": in_window},
    )


async def investigate(scenario: Scenario):
    """Runs the rule-based engine on the scenario and records how get_service was asked."""
    asked: list[dict[str, str]] = []
    inner = scenario.handler()

    def handle(request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/api/v1/tools")
        if path.startswith("/services/"):
            params = dict(request.url.params)
            asked.append({"service": path.rsplit("/", 1)[-1], **params})
            if not (params.get("from") and params.get("to")) and path.endswith("/web-app"):
                # Asked without a window, the API can only say what is true today.
                base = next(s for s in scenario.services if s["slug"] == "web-app")
                return httpx.Response(200, json={"id": base["id"], "slug": "web-app", "name": base["name"], "health": "DEGRADED", "dependedOnBy": [], "repositories": [], "firingAlerts": [], "healthAsOf": {"mode": "current"}, **TODAY})
        return inner(request)

    events: list[dict[str, Any]] = []

    async def emit(e):
        events.append(e)

    tools = ToolClient("http://opspilot.test", "tok", transport=httpx.MockTransport(handle))
    request = InvestigationRequest(investigation_id="inv-h", question=scenario.question, organization_name="Org", api_url="http://opspilot.test", tool_token="tok", time_window={"from": FROM, "to": TO}, current_time=NOW.isoformat())
    ctx = Context(request=request, settings=Settings(_env_file=None), tools=tools, provider=None, emit=emit)
    report = await run_investigation(ctx)
    await tools.aclose()
    return report, ctx, asked


def everything(report) -> str:
    return report.model_dump_json()


@pytest.mark.asyncio
async def test_a_dependency_that_was_down_at_the_time_is_named_from_the_record_of_that_time():
    report, ctx, asked = await investigate(world(then("DOWN", "HEALTHY")))
    # Health was asked for the window under investigation, every time.
    assert asked and all(a.get("from") == FROM and a.get("to") == TO for a in asked)
    dependency = [e for e in ctx.store.by_kind("dependency")]
    assert [e.service for e in dependency] == ["redis"]
    assert dependency[0].title == "Upstream dependency redis was DOWN during the window"
    assert dependency[0].data == {"health": "DOWN", "asOf": "window", "from": FROM, "to": TO}
    # The evidence says what it is: a record from then, with the alert it rests on, not the state now.
    assert "Redis unavailable" in dependency[0].summary and "not from its state now" in dependency[0].summary
    top = report.hypotheses[0]
    assert top.title == "Failure of upstream dependency redis" and dependency[0].ref in top.evidence_refs
    assert "was recorded as unhealthy in the window" in top.description
    assert report.assessment.outcome == "INCIDENT"
    # Every citation still resolves to an evidence item.
    refs = ctx.store.refs()
    assert all(r in refs for h in report.hypotheses for r in h.evidence_refs)
    # What is down today is not in the report about three days ago.
    assert "payments" not in everything(report).lower()


@pytest.mark.asyncio
async def test_a_dependency_that_is_down_today_and_was_fine_then_is_not_blamed():
    report, ctx, asked = await investigate(world(then("HEALTHY", "HEALTHY")))
    assert asked and all(a.get("from") and a.get("to") for a in asked)
    assert ctx.store.by_kind("dependency") == []
    assert not any("dependency" in h.title.lower() for h in report.hypotheses)
    assert "payments" not in everything(report).lower()
    # The failure in the logs is still a failure: evident, and without an established cause.
    assert report.assessment.outcome == "DEGRADED"
    assert "does not establish what caused it" in report.assessment.rationale
    # The service's own health is reported as a record of the window, in words that say so.
    health = ctx.store.by_kind("service_health")
    assert [e.title for e in health] == ["web-app was HEALTHY during the window"]
    assert health[0].data["asOf"] == "window" and "not its state now" in health[0].summary


@pytest.mark.asyncio
async def test_missing_history_is_stated_and_lowers_confidence_without_changing_the_outcome():
    known, _, _ = await investigate(world(then("HEALTHY", "HEALTHY")))
    unknown, ctx, _ = await investigate(world(then("UNKNOWN", "UNKNOWN")))
    # Nothing on record is not turned into evidence, either way.
    assert ctx.store.by_kind("dependency") == [] and ctx.store.health_gaps == ["redis", "payments"]
    assert not any("dependency" in h.title.lower() for h in unknown.hypotheses)
    gap = [m for m in unknown.assessment.missing_telemetry if "is not on record" in m]
    assert gap == ["The state of redis, payments during the window is not on record (no alert, incident or metrics from that time), so a problem in them at the time can be neither shown nor ruled out."]
    assert not [m for m in known.assessment.missing_telemetry if "is not on record" in m]
    # Same outcome, by the same rules; less confidence, because a cause could be hiding there.
    assert unknown.assessment.outcome == known.assessment.outcome == "DEGRADED"
    assert unknown.assessment.confidence == pytest.approx(known.assessment.confidence - 0.10)


@pytest.mark.asyncio
async def test_a_healthy_past_window_is_healthy_whatever_is_down_today():
    scenario = world(then("HEALTHY", "HEALTHY"))
    scenario.anomalies, scenario.logs = [], [_log("hl2", "web-app", "request served", 60 * 72.5, level="INFO")]
    scenario.metrics = {"web-app": [metric("error_rate", "Error rate", "%", 0.4, 0.4)]}
    report, ctx, _ = await investigate(scenario)
    assert report.assessment.outcome == "HEALTHY" and report.hypotheses == []
    assert "no alert or incident was recorded for it in the window while it was sending metrics" in report.assessment.rationale
    assert "payments" not in everything(report).lower()


@pytest.mark.asyncio
async def test_health_is_asked_for_the_window_even_when_the_caller_does_not_say_so():
    """A model may call get_service with nothing but a name. The window is added for it."""
    seen: list[dict[str, str]] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(dict(request.url.params))
        return httpx.Response(200, json={"id": "s1", "slug": "web-app", "name": "Web App", "health": "HEALTHY", "healthAsOf": AS_OF, "dependsOn": [], "firingAlerts": []})

    async def emit(_):
        return None

    tools = ToolClient("http://opspilot.test", "tok", transport=httpx.MockTransport(handle))
    request = InvestigationRequest(investigation_id="inv-w", question="q", organization_name="Org", api_url="http://opspilot.test", tool_token="tok")
    ctx = Context(request=request, settings=Settings(_env_file=None), tools=tools, provider=None, emit=emit)
    ctx.window = (FROM, TO)
    await run_tool(ctx, "get_service", {"service": "web-app"})
    await run_tool(ctx, "get_service", {"service": "web-app", "from_time": "2h", "to_time": "1h"})  # an explicit window is respected
    await tools.aclose()
    assert seen == [{"from": FROM, "to": TO}, {"from": "2h", "to": "1h"}]


def test_evidence_says_whether_health_is_from_then_or_from_now():
    dep = {"id": "d1", "slug": "redis", "name": "Redis", "health": "DOWN", "healthNote": "Critical alert firing: Redis unavailable", "kind": "datastore"}
    now = EvidenceStore()
    now.ingest("get_service", {"id": "s1", "slug": "web-app", "name": "Web App", "health": "DEGRADED", "dependsOn": [dep], "firingAlerts": []})
    assert [e.title for e in now.items] == ["web-app is recorded as DEGRADED", "Upstream dependency redis is DOWN"]
    assert all(e.data["asOf"] == "current" for e in now.items) and now.health_gaps == []

    past = EvidenceStore()
    past.ingest("get_incident_context", {"healthAsOf": AS_OF, "upstreamDependencies": [{**dep, "healthNote": f'Critical alert "Redis unavailable" was firing from {FROM} to {TO}'}, {"id": "d2", "slug": "ledger", "name": "Ledger", "health": "UNKNOWN", "kind": "sync"}]})
    assert [e.title for e in past.items] == ["Upstream dependency redis was DOWN during the window"]
    assert past.items[0].data["asOf"] == "window" and past.health_gaps == ["ledger"]
    # An answer that does not say which it is (an older API, a hand-written fixture) is read as before.
    legacy = EvidenceStore()
    legacy.ingest("get_incident_context", {"upstreamDependencies": [dep]})
    assert legacy.items[0].title == "Upstream dependency redis is DOWN" and "is currently DOWN" in legacy.items[0].summary

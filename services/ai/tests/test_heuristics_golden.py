"""Golden snapshot of the rule-based engine's output.

The snapshot was written from the code as it stood BEFORE analyse() was broken into separate
rule functions (Milestone 5). The complete report of every evaluation scenario, and of the
trace, dependency-chain and rollback cases found on real telemetry, must stay byte-for-byte
the same. Regenerate only for an intended change in behaviour:

    OPSPILOT_WRITE_GOLDEN=1 uv run pytest tests/test_heuristics_golden.py
"""

import json
import os
from pathlib import Path
from typing import Any

import httpx
import pytest

from app.config import Settings
from app.evals.scenarios import SCENARIOS, Scenario, metric, pattern, svc, t
from app.graph import Context, run_investigation
from app.schemas import InvestigationRequest
from app.tools import ToolClient

GOLDEN = Path(__file__).parent / "fixtures" / "heuristics.golden.json"


def _dep(slug: str, health: str) -> dict[str, Any]:
    return {"slug": slug, "name": slug, "health": health, "healthNote": f"alert firing on {slug}" if health != "HEALTHY" else None, "kind": "sync"}


def _trace(id_: str, root: str, duration: float, slowest: dict[str, Any] | None = None, errors: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"traceId": id_, "startedAt": t(5), "durationMs": duration, "rootService": root, "rootOperation": "POST /checkout", "spanCount": 6, "services": ["shop-gateway", "shop-orders", "shop-payments"], "slowestSpan": slowest, "errorSpans": errors or []}


def extra_scenarios() -> list[Scenario]:
    """Cases that exercise the rules the evaluation scenarios do not: dependency chains, traces,
    rollbacks and repeated deployments."""
    expect = SCENARIOS[1].expect
    slow = {"service": "shop-orders", "operation": "pg.query:SELECT", "durationMs": 405, "selfMs": 403, "system": "postgresql", "peer": "demo-postgres"}
    failing = [
        {"service": "shop-gateway", "operation": "POST /checkout", "message": "HTTP 502", "system": None, "peer": None},
        {"service": "shop-payments", "operation": "request handler - /pay", "message": "idempotency store unavailable, refusing to charge", "system": None, "peer": None},
    ]
    deploy = {"service": "shop-orders", "environment": "production", "status": "SUCCEEDED", "branch": "main", "deployedBy": "ci", "isRollback": False}
    chain_services = [svc("shop-gateway", ["shop-orders"], "DEGRADED"), svc("shop-orders", ["shop-payments", "shop-postgres"], "DEGRADED"), svc("shop-payments", ["shop-redis"], "DEGRADED"), svc("shop-redis", health="DOWN"), svc("shop-postgres")]
    chain_details = {
        "shop-gateway": {"health": "DEGRADED", "dependsOn": [_dep("shop-orders", "DEGRADED")]},
        "shop-orders": {"health": "DEGRADED", "dependsOn": [_dep("shop-payments", "DEGRADED"), _dep("shop-postgres", "HEALTHY")]},
        "shop-payments": {"health": "DEGRADED", "dependsOn": [_dep("shop-redis", "DOWN")]},
        "shop-redis": {"health": "DOWN", "dependsOn": []},
    }
    return [
        Scenario(
            name="x_dependency_chain_with_traces", question="Why are checkouts failing on shop-gateway?", description="", expect=expect, services=chain_services,
            anomalies=[pattern("g1", "shop-gateway", "upstream shop-orders returned 502", 240, 6)],
            logs=[{"id": "lg", "timestamp": t(3), "level": "ERROR", "service": "shop-gateway", "message": "upstream shop-orders returned 502", "traceId": "t1", "fingerprint": "g1", "attributes": None}],
            metrics={"shop-gateway": [metric("error_rate", "Error rate", "%", 28.0, 0.0)]}, service_details=chain_details,
            traces=[_trace(f"c{i}", "shop-gateway", 20, None, failing) for i in range(4)],
        ),
        Scenario(
            name="x_slow_database_after_rollback", question="Why is shop-orders slow?", description="", expect=expect,
            services=[svc("shop-orders", ["shop-postgres"]), svc("shop-postgres")],
            deployments=[
                {**deploy, "id": "d-undo", "version": "v1.4.0", "commitSha": "abababab1400", "startedAt": t(126), "finishedAt": t(126), "isRollback": True, "description": "Roll back to v1.4.0"},
                {**deploy, "id": "d-bad", "version": "v1.5.0", "status": "ROLLED_BACK", "commitSha": "abababab1500", "startedAt": t(129), "finishedAt": t(129), "description": "Simplify discount lookup"},
                {**deploy, "id": "d-good", "version": "v1.4.0", "commitSha": "abababab1400", "startedAt": t(4000), "finishedAt": t(4000), "description": "Order history pagination"},
            ],
            metrics={"shop-orders": [metric("latency_p95_ms", "p95 latency", "ms", 780, 30), metric("error_rate", "Error rate", "%", 0.0, 0.0)]},
            traces=[_trace(f"s{i}", "shop-orders", 850 - i, slow) for i in range(5)],
            service_details={"shop-orders": {"health": "DEGRADED", "dependsOn": [_dep("shop-postgres", "HEALTHY")]}}, deployment_errors={"d-undo": (180, 0)},
        ),
        Scenario(
            name="x_two_deployments_before_errors", question="Why is shop-orders returning errors?", description="", expect=expect, services=[svc("shop-orders")],
            anomalies=[pattern("o1", "shop-orders", "failed to compute order total: Cannot read properties of null", 300, 2)],
            logs=[{"id": "lo", "timestamp": t(1), "level": "ERROR", "service": "shop-orders", "message": "failed to compute order total: Cannot read properties of null", "traceId": "x", "fingerprint": "o1", "attributes": None}],
            deployments=[
                {**deploy, "id": "new", "version": "v1.5.0", "commitSha": "abababab1500", "startedAt": t(3), "finishedAt": t(3), "description": "Simplify discount lookup"},
                {**deploy, "id": "old", "version": "v1.4.0", "commitSha": "abababab1400", "startedAt": t(27), "finishedAt": t(27), "description": "Order history pagination"},
                {**deploy, "id": "older", "version": "v1.3.9", "commitSha": "abababab1309", "startedAt": t(9000), "finishedAt": t(9000), "description": "Routine update"},
            ],
            metrics={"shop-orders": [metric("error_rate", "Error rate", "%", 55.0, 0.0)]},
        ),
        Scenario(
            name="x_recurrence_of_past_incident", question="Why is orders-api failing?", description="", expect=expect, services=[svc("orders-api", [], "DEGRADED")],
            anomalies=[pattern("f1", "orders-api", "timeout acquiring connection from database pool", 420, 30)],
            logs=[{"id": "l1", "timestamp": t(20), "level": "ERROR", "service": "orders-api", "message": "timeout acquiring connection from database pool", "traceId": "x", "fingerprint": "f1", "attributes": None}],
            metrics={"orders-api": [metric("error_rate", "Error rate", "%", 12.0, 0.4)]},
            incidents=[{"id": "i1", "key": "INC-7", "title": "Orders API connection pool exhausted", "rootCause": "Database pool size lowered; connections timed out", "resolution": "Raised pool size", "severity": "SEV2", "startedAt": t(90000)}],
        ),
        Scenario(name="x_no_telemetry", question="Is ledger-api healthy?", description="", expect=expect, services=[svc("ledger-api")], log_lines=0),
    ]


async def rule_based_report(scenario: Scenario) -> dict[str, Any]:
    async def emit(_event: dict[str, Any]) -> None:
        return None

    tools = ToolClient("http://opspilot.test", "tok", transport=httpx.MockTransport(scenario.handler()))
    request = InvestigationRequest(investigation_id="inv", question=scenario.question, organization_name="Org", api_url="http://opspilot.test", tool_token="tok", time_window={"from": t(120), "to": t(0)}, current_time=t(0))
    report = await run_investigation(Context(request=request, settings=Settings(_env_file=None), tools=tools, provider=None, emit=emit))
    await tools.aclose()
    return report.wire()


ALL = [*SCENARIOS, *extra_scenarios()]


async def test_golden_file_is_complete():
    reports = {s.name: await rule_based_report(s) for s in ALL}
    if os.environ.get("OPSPILOT_WRITE_GOLDEN"):
        GOLDEN.write_text(json.dumps(reports, indent=1, sort_keys=True) + "\n")
    assert set(json.loads(GOLDEN.read_text())) == set(reports)


@pytest.mark.parametrize("scenario", ALL, ids=lambda s: s.name)
async def test_rule_based_report_is_unchanged(scenario):
    expected = json.loads(GOLDEN.read_text())[scenario.name]
    actual = json.loads(json.dumps(await rule_based_report(scenario), sort_keys=True))
    assert actual == expected, f"the rule-based report for {scenario.name} changed"

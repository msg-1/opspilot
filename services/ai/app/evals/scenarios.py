"""Synthetic incident scenarios with known answers, used to evaluate the investigation agent.

Each scenario is a small fake of the OpsPilot tool API (served through httpx.MockTransport), so
the full agent runs unchanged: same tools, same evidence extraction, same guardrails. Only the
data source is replaced. Ground truth is known because we wrote the scenario.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime, timedelta
from typing import Any

import httpx

NOW = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)


def t(minutes_ago: float) -> str:
    return (NOW - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


def svc(slug: str, depends: list[str] | None = None, health: str = "HEALTHY") -> dict[str, Any]:
    return {"id": f"svc_{slug}", "slug": slug, "name": slug.replace("-", " ").title(), "description": None, "tier": "TIER1", "health": health, "healthNote": None, "ownerTeam": "Core", "dependsOn": [{"slug": d, "kind": "sync"} for d in depends or []]}


def pattern(fp: str, service: str, sample: str, count: int, first: float, level: str = "ERROR", kind: str = "new", baseline: int = 0) -> dict[str, Any]:
    return {"fingerprint": fp, "sample": sample, "level": level, "serviceId": f"svc_{service}", "serviceName": service.replace("-", " ").title(), "serviceSlug": service, "count": count, "firstSeen": t(first), "lastSeen": t(1), "baselineCount": baseline, "kind": kind, "ratio": None if kind == "new" else 9.0}


def deployment(id_: str, service: str, version: str, minutes_ago: float, sha: str, description: str = "", status: str = "SUCCEEDED") -> dict[str, Any]:
    return {"id": id_, "service": service, "version": version, "environment": "production", "status": status, "commitSha": sha, "branch": "main", "deployedBy": "deploy-bot", "startedAt": t(minutes_ago), "finishedAt": t(minutes_ago - 3), "isRollback": False, "description": description}


def pull(id_: str, service: str, number: int, title: str, body: str, minutes_ago: float, sha: str) -> dict[str, Any]:
    return {"id": id_, "number": number, "repository": f"acme/{service}", "service": service, "sampleData": False, "title": title, "body": body, "author": "dev", "state": "merged", "mergedAt": t(minutes_ago), "mergeCommitSha": sha[:12], "labels": []}


def commit(id_: str, service: str, sha: str, message: str, minutes_ago: float, files: list[str]) -> dict[str, Any]:
    return {"id": id_, "sha": sha[:12], "repository": f"acme/{service}", "service": service, "sampleData": False, "message": message, "author": "dev", "committedAt": t(minutes_ago), "additions": 10, "deletions": 2, "files": files}


def metric(name: str, label: str, unit: str, avg: float, base: float) -> dict[str, Any]:
    change = round((avg - base) / base * 100, 1) if base else None
    return {"metric": name, "label": label, "unit": unit, "window": {"from": t(120), "to": t(0), "avg": avg, "max": avg * 1.3, "min": avg * 0.6, "samples": 120}, "baseline": {"from": t(240), "to": t(120), "avg": base, "max": base * 1.2, "min": base * 0.8, "samples": 120}, "changePercent": change}


@dataclass
class Cause:
    """The true cause of a scenario, stated structurally rather than as a phrase to find.

    A hypothesis identifies this cause when it is about the right component and either cites, as
    support, a record that IS the cause (the deployment, its pull request, the failed dependency)
    or describes the mechanism in any of the listed wordings.
    """

    #: Slug of the service or component actually at fault
    service: str
    #: Alternative descriptions of the mechanism. Each is a list of terms that must all appear.
    mechanism: list[list[str]]
    #: (source type, source id) of the records that constitute the cause
    evidence: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class Distractor:
    """Something in the data that looks relevant and is not the cause."""

    label: str
    terms: list[list[str]]
    evidence: list[tuple[str, str]] = field(default_factory=list)


@dataclass
class Expectation:
    #: None when no cause can be established from the data (healthy service, or the sources
    #: that would show it are unavailable). Then no fault may be rated likely.
    cause: Cause | None = None
    #: True when the correct answer is that nothing is wrong
    healthy: bool = False
    min_confidence: float = 0.0
    max_confidence: float = 1.0
    # Id of the deployment the evidence implicates, if any. A rollback is acceptable only for
    # this deployment; when it is None, proposing any rollback is unsafe.
    implicated_deployment: str | None = None
    #: The version a rollback of the implicated deployment must return to (its last successful predecessor)
    rollback_to: str | None = None
    #: Slugs of services that are innocent and must not be named as the cause
    must_not_blame: list[str] = field(default_factory=list)
    distractors: list[Distractor] = field(default_factory=list)
    #: Evidence the investigation could not obtain; the report must say so. Alternative term lists.
    must_acknowledge: list[list[str]] = field(default_factory=list)
    #: Slug of the service whose deployment context the investigator needs to consult, if any
    needs_deployment_context: str | None = None


@dataclass
class Scenario:
    name: str
    question: str
    description: str
    expect: Expectation
    services: list[dict[str, Any]]
    anomalies: list[dict[str, Any]] = field(default_factory=list)
    logs: list[dict[str, Any]] = field(default_factory=list)
    deployments: list[dict[str, Any]] = field(default_factory=list)
    pulls: list[dict[str, Any]] = field(default_factory=list)
    commits: list[dict[str, Any]] = field(default_factory=list)
    events: list[dict[str, Any]] = field(default_factory=list)
    metrics: dict[str, list[dict[str, Any]]] = field(default_factory=dict)
    knowledge: list[dict[str, Any]] = field(default_factory=list)
    incidents: list[dict[str, Any]] = field(default_factory=list)
    service_details: dict[str, dict[str, Any]] = field(default_factory=dict)
    fail_paths: list[str] = field(default_factory=list)
    #: ERROR/FATAL log counts (30 minutes before, up to 30 minutes after) per deployment id, for
    #: the deployment-context tool. Derived from the anomalies when a deployment is not listed.
    deployment_errors: dict[str, tuple[int, int]] = field(default_factory=dict)

    def handler(self) -> Callable[[httpx.Request], httpx.Response]:
        def handle(request: httpx.Request) -> httpx.Response:
            path = request.url.path.removeprefix("/api/v1/tools")
            window = {"from": t(120), "to": t(0)}
            if any(path.startswith(p) for p in self.fail_paths):
                return httpx.Response(503, json={"error": {"code": "service_unavailable", "message": "backend unavailable"}})
            wanted = set(filter(None, (request.url.params.get("service") or "").split(",")))
            pick = lambda rows, key="service": [r for r in rows if not wanted or r.get(key) in wanted]  # noqa: E731
            if path == "/services":
                return httpx.Response(200, json={"services": self.services})
            if path.startswith("/services/"):
                slug = path.rsplit("/", 1)[-1]
                base = next((s for s in self.services if s["slug"] == slug), None)
                if not base:
                    return httpx.Response(404, json={"error": {"code": "not_found", "message": "Service not found"}})
                detail = {"id": base["id"], "slug": slug, "name": base["name"], "health": base["health"], "dependsOn": [], "dependedOnBy": [], "repositories": [], "firingAlerts": []}
                return httpx.Response(200, json={**detail, **self.service_details.get(slug, {})})
            if path == "/logs/anomalies":
                return httpx.Response(200, json={"window": window, "anomalies": pick(self.anomalies, "serviceSlug")})
            if path == "/logs/patterns":
                return httpx.Response(200, json={"window": window, "patterns": pick(self.anomalies, "serviceSlug")})
            if path == "/logs/search":
                return httpx.Response(200, json={"window": window, "totalMatching": len(self.logs), "returned": len(self.logs), "logs": pick(self.logs)})
            if path == "/logs/histogram":
                return httpx.Response(200, json={"window": window, "bucketSeconds": 300, "buckets": []})
            if path == "/deployment-context":
                # Mirrors deploymentContext() in apps/api/src/modules/tools.ts.
                slug = request.url.params.get("service", "")
                if not any(sv["slug"] == slug for sv in self.services):
                    return httpx.Response(404, json={"error": {"code": "not_found", "message": "Service not found"}})
                mine = sorted((d for d in self.deployments if d["service"] == slug), key=lambda d: d["startedAt"], reverse=True)
                wanted_id = request.url.params.get("deploymentId")
                target = next((d for d in mine if d["id"] == wanted_id), None) if wanted_id else next((d for d in mine if not d["isRollback"]), None)
                if not target:
                    return httpx.Response(200, json={"service": slug, "environment": "production", "deployment": None, "note": "No deployment is recorded for this service in this environment."})
                started = datetime.fromisoformat(target["startedAt"].replace("Z", "+00:00"))
                since = round((NOW - started).total_seconds() / 60)
                window_minutes = min(30, max(since, 0))
                # The rollback target is the last deployment that SUCCEEDED before this one.
                previous = next((d for d in mine if d["startedAt"] < target["startedAt"] and d["status"] == "SUCCEEDED" and not d["isRollback"]), None)
                sha = (target.get("commitSha") or "")[:12]
                between = [c for c in self.commits if c["service"] == slug and c["sha"] != sha and previous and previous["startedAt"] < c["committedAt"] <= target["startedAt"]]
                before, after = self.deployment_errors.get(target["id"], (None, None))
                if after is None:
                    cutoff = (started + timedelta(minutes=30)).isoformat().replace("+00:00", "Z")
                    after = min(sum(p["count"] for p in self.anomalies if p["serviceSlug"] == slug and p["level"] in ("ERROR", "FATAL") and target["startedAt"] <= p["firstSeen"] <= cutoff), 400)
                    before = 2 if after else 0
                return httpx.Response(200, json={
                    "service": slug, "environment": "production", "deployment": target, "minutesSinceDeployment": since, "isLatest": mine[0]["id"] == target["id"],
                    "previousSuccessful": previous,
                    "rollbackTarget": {"deploymentId": target["id"], "fromVersion": target["version"], "toVersion": previous["version"], "previousDeployedAt": previous["startedAt"]} if previous else None,
                    "alreadyRolledBack": target["status"] == "ROLLED_BACK" or any(d["isRollback"] and d["startedAt"] > target["startedAt"] for d in mine),
                    "changes": {"commits": [c for c in self.commits if c["sha"] == sha] + between, "pullRequests": [p for p in self.pulls if p["mergeCommitSha"] == sha], "note": None},
                    "errorLogs": {"windowMinutes": window_minutes, "before": before, "after": after, "beforePerMinute": round(before / 30, 2), "afterPerMinute": round(after / window_minutes, 2) if window_minutes else None},
                    "incidentsAfter": [], "recentDeployments": mine[:6],
                })
            if path == "/deployments":
                return httpx.Response(200, json={"window": window, "deployments": pick(self.deployments)})
            if path == "/code-changes":
                return httpx.Response(200, json={"window": window, "commits": pick(self.commits), "pullRequests": pick(self.pulls)})
            if path == "/service-events":
                return httpx.Response(200, json={"window": window, "events": pick(self.events)})
            if path == "/metrics":
                slug = request.url.params.get("service", "")
                return httpx.Response(200, json={"service": slug, "window": window, "metrics": self.metrics.get(slug, [])})
            if path == "/incidents":
                return httpx.Response(200, json={"incidents": self.incidents})
            if path == "/knowledge/search":
                json.loads(request.content)  # must be valid JSON
                return httpx.Response(200, json={"mode": "hybrid", "results": self.knowledge})
            return httpx.Response(404, json={"error": {"code": "not_found", "message": f"no route {path}"}})

        return handle


def _log(id_: str, service: str, message: str, minutes_ago: float, level: str = "ERROR") -> dict[str, Any]:
    return {"id": id_, "timestamp": t(minutes_ago), "level": level, "service": service, "message": message, "traceId": "abc123", "fingerprint": "fp", "attributes": None}


SCENARIOS: list[Scenario] = [
    Scenario(
        name="bad_deploy_matching_change",
        question="Orders API is returning 500s. What happened to orders-api?",
        description="A deployment 8 minutes before the errors shipped a PR that changed the cache TTL config; errors are cache deserialisation failures. An unrelated deployment happened on another service.",
        expect=Expectation(
            cause=Cause("orders-api", mechanism=[["cache", "schema"], ["cache", "deseriali"], ["v4.2.0"]], evidence=[("deployment", "d1"), ("deployment_impact", "d1"), ("pull_request", "p1"), ("commit", "c1")]),
            min_confidence=0.55, implicated_deployment="d1", rollback_to="v4.1.9", must_not_blame=["search-api"],
            distractors=[Distractor("the search-api deployment shortly before", terms=[["search api"]], evidence=[("deployment", "d2"), ("pull_request", "p2")])],
        ),
        services=[svc("orders-api", ["orders-cache"], "DEGRADED"), svc("orders-cache"), svc("search-api")],
        anomalies=[pattern("f1", "orders-api", "failed to deserialize cache entry for key order:<n>: unexpected schema version", 420, 30)],
        logs=[_log("l1", "orders-api", "failed to deserialize cache entry for key order:8812: unexpected schema version 3", 20)],
        deployments=[
            deployment("d1", "orders-api", "v4.2.0", 38, "aaaaaaaaaaaa1111", "Cache schema v3"),
            deployment("d0", "orders-api", "v4.1.9", 60 * 30, "bbbbbbbbbbbb2222"),
            deployment("d2", "search-api", "v9.0.1", 55, "cccccccccccc3333", "Ranking tweak"),
        ],
        pulls=[
            pull("p1", "orders-api", 77, "Bump cache schema version and config", "Changes cache entry schema to v3 and updates cache TTL config. Old entries should expire naturally.", 60, "aaaaaaaaaaaa1111"),
            pull("p2", "search-api", 12, "Tweak ranking weights", "Adjusts boost for in-stock items.", 70, "cccccccccccc3333"),
        ],
        commits=[commit("c1", "orders-api", "aaaaaaaaaaaa1111", "Bump cache schema version and config (#77)", 60, ["src/cache/schema.ts", "config/cache.yaml"])],
        metrics={"orders-api": [metric("error_rate", "Error rate", "%", 12.0, 0.4), metric("latency_p95_ms", "p95 latency", "ms", 210, 190)]},
        knowledge=[{"chunkId": "k1", "documentId": "doc1", "title": "Runbook: Cache schema migrations", "type": "runbook", "section": "Symptoms", "content": "If a deployment changes the cache entry schema without flushing, readers fail to deserialize cache entries. Flush the cache or roll back.", "similarity": 0.61, "matchedBy": ["vector", "keyword"]}],
    ),
    Scenario(
        name="upstream_dependency_down",
        question="Why is web-app slow and erroring?",
        description="No changes to web-app. Its upstream dependency auth-service is DOWN.",
        # A dependency that is recorded as DOWN, with connection-refused errors naming it, is well
        # supported; why auth-service itself is down is not in the data, so certainty is not justified.
        expect=Expectation(
            cause=Cause("auth-service", mechanism=[["down"], ["outage"], ["unavailab"], ["unreachable"], ["connection refused"], ["fail"]], evidence=[("service", "svc_auth-service"), ("service", "dep:auth-service")]),
            min_confidence=0.25, max_confidence=0.85,
        ),
        services=[svc("web-app", ["auth-service"], "DEGRADED"), svc("auth-service", health="DOWN")],
        anomalies=[pattern("f2", "web-app", "upstream auth-service request failed: connection refused", 300, 25)],
        logs=[_log("l2", "web-app", "upstream auth-service request failed: connection refused", 10)],
        metrics={"web-app": [metric("error_rate", "Error rate", "%", 9.0, 0.5)]},
        service_details={"web-app": {"dependsOn": [{"slug": "auth-service", "name": "Auth Service", "health": "DOWN", "healthNote": "Critical alert firing: Auth error rate", "kind": "sync"}]}},
    ),
    Scenario(
        name="healthy_no_signal",
        question="Is anything wrong with billing-service?",
        description="A healthy service with a few routine warnings and a week-old deployment. The right answer is 'no clear problem'.",
        expect=Expectation(healthy=True, max_confidence=0.25),
        services=[svc("billing-service")],
        anomalies=[pattern("f3", "billing-service", "invoice email retry scheduled attempt=<n>", 6, 90, level="WARN")],
        # A healthy service still has logs behind its patterns and metrics that show it is healthy.
        logs=[_log("l3", "billing-service", "invoice email retry scheduled attempt=2", 40, level="WARN")],
        metrics={"billing-service": [metric("error_rate", "Error rate", "%", 0.2, 0.2), metric("latency_p95_ms", "p95 latency", "ms", 180, 176)]},
        deployments=[deployment("d5", "billing-service", "v2.0.0", 60 * 24 * 7, "dddddddddddd4444", "Routine release")],
    ),
    Scenario(
        name="red_herring_closer_in_time",
        question="Why is api-gateway returning 502s for payments-api?",
        description="Two changes precede the errors. The closest in time (a feature flag on payments-api) is unrelated; the slightly earlier deployment shipped a TLS certificate change and the errors are certificate failures.",
        expect=Expectation(
            cause=Cause("payments-api", mechanism=[["certificate"], ["tls"], ["v3.1.0"]], evidence=[("deployment", "d7"), ("deployment_impact", "d7"), ("pull_request", "p7"), ("commit", "c7")]),
            min_confidence=0.5, implicated_deployment="d7", rollback_to="v3.0.4",
            distractors=[Distractor("the feature flag enabled closer to the errors", terms=[["flag"], ["new receipt email"]], evidence=[("service_event", "e1")])],
        ),
        services=[svc("api-gateway", ["payments-api"], "DEGRADED"), svc("payments-api", health="DEGRADED")],
        anomalies=[
            pattern("f4", "payments-api", "tls handshake failed: certificate signed by unknown authority", 510, 40),
            pattern("f5", "api-gateway", "upstream payments-api returned 502", 380, 39),
        ],
        logs=[_log("l4", "payments-api", "tls handshake failed: certificate signed by unknown authority", 12), _log("l5", "api-gateway", "upstream payments-api returned 502", 11)],
        deployments=[deployment("d7", "payments-api", "v3.1.0", 52, "eeeeeeeeeeee5555", "Rotate mTLS certificate bundle"), deployment("d6", "payments-api", "v3.0.4", 60 * 50, "ffffffffffff6666")],
        events=[{"id": "e1", "service": "payments-api", "type": "feature_flag", "title": "Flag new_receipt_email enabled", "details": "Enabled for 5% of users", "actor": "pm", "source": "api", "occurredAt": t(44)}],
        pulls=[pull("p7", "payments-api", 301, "Rotate mTLS certificate bundle", "Replaces the CA certificate bundle used for TLS between services.", 70, "eeeeeeeeeeee5555")],
        commits=[commit("c7", "payments-api", "eeeeeeeeeeee5555", "Rotate mTLS certificate bundle (#301)", 70, ["deploy/certs/ca-bundle.pem", "config/tls.yaml"])],
        metrics={"payments-api": [metric("error_rate", "Error rate", "%", 22.0, 0.3)], "api-gateway": [metric("error_rate", "Error rate", "%", 6.0, 0.4)]},
    ),
    Scenario(
        name="tool_failures_degrade_gracefully",
        question="Why is orders-api failing?",
        description="Same as the first scenario but the deployments and code-changes endpoints are down. The agent must say what it could not check and must not claim high confidence.",
        expect=Expectation(max_confidence=0.5, must_acknowledge=[["deployment"], ["code change"], ["commit"], ["pull request"]]),
        services=[svc("orders-api", [], "DEGRADED")],
        anomalies=[pattern("f1", "orders-api", "failed to deserialize cache entry for key order:<n>: unexpected schema version", 420, 30)],
        logs=[_log("l1", "orders-api", "failed to deserialize cache entry for key order:8812: unexpected schema version 3", 20)],
        metrics={"orders-api": [metric("error_rate", "Error rate", "%", 12.0, 0.4)]},
        fail_paths=["/deployments", "/code-changes"],
    ),
    Scenario(
        name="deployment_rollback_target",
        question="Checkout is failing for customers since a few minutes ago. What changed on checkout-api, and what should we do?",
        description="checkout-api v2.8.0 lowered the database pool size; pool-exhaustion errors began minutes later. The release before it (v2.7.5, two days ago) FAILED, "
        "so the version actually running before, and the only valid rollback target, is v2.7.4 from nine days ago. Neither older deployment is inside the default "
        "window: the target is knowable only from the deployment context. A replica scale-up shortly before the errors is unrelated.",
        expect=Expectation(
            cause=Cause("checkout-api", mechanism=[["pool"], ["v2.8.0"]], evidence=[("deployment", "d11"), ("deployment_impact", "d11"), ("pull_request", "p11"), ("commit", "c11")]),
            min_confidence=0.55, implicated_deployment="d11", rollback_to="v2.7.4", needs_deployment_context="checkout-api",
            distractors=[Distractor("the replica scale-up shortly before the errors", terms=[["scal"], ["replica"]], evidence=[("service_event", "e11")])],
        ),
        services=[svc("checkout-api", ["checkout-db"], "DEGRADED"), svc("checkout-db")],
        anomalies=[pattern("f11", "checkout-api", "timeout acquiring connection from pool after <n>ms (pool size 10, <n> waiting)", 640, 19)],
        logs=[_log("l11", "checkout-api", "timeout acquiring connection from pool after 5000ms (pool size 10, 37 waiting)", 9)],
        deployments=[
            deployment("d11", "checkout-api", "v2.8.0", 24, "1a2b3c4d5e6f7788", "Tune database settings"),
            deployment("d10", "checkout-api", "v2.7.5", 60 * 48, "9f8e7d6c5b4a3322", "Checkout copy changes", status="FAILED"),
            deployment("d9", "checkout-api", "v2.7.4", 60 * 24 * 9, "0a1b2c3d4e5f6677", "Routine release"),
        ],
        pulls=[pull("p11", "checkout-api", 412, "Reduce DB pool size to cut idle connections", "Lowers DB_POOL_MAX from 50 to 10 to reduce idle connections on the database.", 180, "1a2b3c4d5e6f7788")],
        commits=[commit("c11", "checkout-api", "1a2b3c4d5e6f7788", "Reduce DB pool size to cut idle connections (#412)", 180, ["config/database.yaml"])],
        events=[{"id": "e11", "service": "checkout-api", "type": "scaling", "title": "Scaled checkout-api from 6 to 8 replicas", "details": "Autoscaler: CPU above target", "actor": "autoscaler", "source": "api", "occurredAt": t(21)}],
        metrics={"checkout-api": [metric("error_rate", "Error rate", "%", 18.0, 0.3), metric("latency_p95_ms", "p95 latency", "ms", 4800, 220)], "checkout-db": [metric("connections", "Open connections", "", 80, 140)]},
        deployment_errors={"d11": (3, 590)},
    ),
]

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


def deployment(id_: str, service: str, version: str, minutes_ago: float, sha: str, description: str = "") -> dict[str, Any]:
    return {"id": id_, "service": service, "version": version, "environment": "production", "status": "SUCCEEDED", "commitSha": sha, "branch": "main", "deployedBy": "deploy-bot", "startedAt": t(minutes_ago), "finishedAt": t(minutes_ago - 3), "isRollback": False, "description": description}


def pull(id_: str, service: str, number: int, title: str, body: str, minutes_ago: float, sha: str) -> dict[str, Any]:
    return {"id": id_, "number": number, "repository": f"acme/{service}", "service": service, "sampleData": False, "title": title, "body": body, "author": "dev", "state": "merged", "mergedAt": t(minutes_ago), "mergeCommitSha": sha[:12], "labels": []}


def commit(id_: str, service: str, sha: str, message: str, minutes_ago: float, files: list[str]) -> dict[str, Any]:
    return {"id": id_, "sha": sha[:12], "repository": f"acme/{service}", "service": service, "sampleData": False, "message": message, "author": "dev", "committedAt": t(minutes_ago), "additions": 10, "deletions": 2, "files": files}


def metric(name: str, label: str, unit: str, avg: float, base: float) -> dict[str, Any]:
    change = round((avg - base) / base * 100, 1) if base else None
    return {"metric": name, "label": label, "unit": unit, "window": {"from": t(120), "to": t(0), "avg": avg, "max": avg * 1.3, "min": avg * 0.6, "samples": 120}, "baseline": {"from": t(240), "to": t(120), "avg": base, "max": base * 1.2, "min": base * 0.8, "samples": 120}, "changePercent": change}


@dataclass
class Expectation:
    # Lower-case substrings; the top hypothesis title+description must contain at least one of them.
    top_mentions: list[str]
    min_confidence: float = 0.0
    max_confidence: float = 1.0
    # Id of the deployment the evidence implicates, if any. A rollback is acceptable only for
    # this deployment; when it is None, proposing any rollback is unsafe.
    implicated_deployment: str | None = None
    must_not_blame: list[str] = field(default_factory=list)


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


def _log(id_: str, service: str, message: str, minutes_ago: float) -> dict[str, Any]:
    return {"id": id_, "timestamp": t(minutes_ago), "level": "ERROR", "service": service, "message": message, "traceId": "abc123", "fingerprint": "fp", "attributes": None}


SCENARIOS: list[Scenario] = [
    Scenario(
        name="bad_deploy_matching_change",
        question="Orders API is returning 500s. What happened to orders-api?",
        description="A deployment 8 minutes before the errors shipped a PR that changed the cache TTL config; errors are cache deserialisation failures. An unrelated deployment happened on another service.",
        expect=Expectation(top_mentions=["orders-api v4.2.0", "v4.2.0 cache"], min_confidence=0.55, implicated_deployment="d1", must_not_blame=["search-api"]),
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
        expect=Expectation(top_mentions=["auth-service"], max_confidence=0.6),
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
        expect=Expectation(top_mentions=[], max_confidence=0.25),
        services=[svc("billing-service")],
        anomalies=[pattern("f3", "billing-service", "invoice email retry scheduled attempt=<n>", 6, 90, level="WARN")],
        deployments=[deployment("d5", "billing-service", "v2.0.0", 100, "dddddddddddd4444", "Routine release")],
    ),
    Scenario(
        name="red_herring_closer_in_time",
        question="Why is api-gateway returning 502s for payments-api?",
        description="Two changes precede the errors. The closest in time (a feature flag on payments-api) is unrelated; the slightly earlier deployment shipped a TLS certificate change and the errors are certificate failures.",
        expect=Expectation(top_mentions=["payments-api v3.1.0", "v3.1.0 certificate", "v3.1.0 tls"], min_confidence=0.5, implicated_deployment="d7"),
        services=[svc("api-gateway", ["payments-api"], "DEGRADED"), svc("payments-api", health="DEGRADED")],
        anomalies=[
            pattern("f4", "payments-api", "tls handshake failed: certificate signed by unknown authority", 510, 40),
            pattern("f5", "api-gateway", "upstream payments-api returned 502", 380, 39),
        ],
        logs=[_log("l4", "payments-api", "tls handshake failed: certificate signed by unknown authority", 12)],
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
        expect=Expectation(top_mentions=[], max_confidence=0.5),
        services=[svc("orders-api", [], "DEGRADED")],
        anomalies=[pattern("f1", "orders-api", "failed to deserialize cache entry for key order:<n>: unexpected schema version", 420, 30)],
        metrics={"orders-api": [metric("error_rate", "Error rate", "%", 12.0, 0.4)]},
        fail_paths=["/deployments", "/code-changes"],
    ),
]

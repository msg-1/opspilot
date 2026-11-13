"""Healthy-state conclusions, action effects, rollback targets and claim validation.

All deterministic: evidence is built by hand or gathered from the scenario fakes, and reports
are written by hand so that both correct and incorrect ones are put in front of each check.
"""

import json
from pathlib import Path
from typing import Any

import httpx
import pytest

from app import guardrails
from app.assessment import assess, find_signals
from app.claims import Checker, number_claims, verify_report
from app.config import Settings
from app.effects import action_effect, classify_text
from app.evals.run import evaluate
from app.evals.scenarios import SCENARIOS, Scenario, metric, pattern, svc, t
from app.evidence import EvidenceStore
from app.graph import Context, run_investigation
from app.schemas import (
    Fact,
    HypothesisOut,
    InvestigationReport,
    InvestigationRequest,
    RecommendedAction,
    RemediationParameters,
)
from app.tools import ToolClient

BY_NAME = {s.name: s for s in SCENARIOS}
FIXTURES = Path(__file__).resolve().parents[3] / "contracts" / "fixtures"


async def investigate(scenario: Scenario) -> tuple[InvestigationReport, EvidenceStore, list[str]]:
    events: list[dict[str, Any]] = []

    async def emit(e):
        events.append(e)

    tools = ToolClient("http://opspilot.test", "tok", transport=httpx.MockTransport(scenario.handler()))
    request = InvestigationRequest(investigation_id="inv", question=scenario.question, organization_name="Org", api_url="http://opspilot.test", tool_token="tok", time_window={"from": t(120), "to": t(0)}, current_time=t(0))
    ctx = Context(request=request, settings=Settings(_env_file=None), tools=tools, provider=None, emit=emit)
    report = await run_investigation(ctx)
    await tools.aclose()
    return report, ctx.store, ctx.tool_failures


# ───────────────────────── Outcome: is there a fault at all? ─────────────────────────


@pytest.mark.parametrize("scenario", SCENARIOS, ids=lambda s: s.name)
async def test_every_scenario_reaches_the_outcome_its_evidence_supports(scenario):
    result = await evaluate(scenario, None)
    assert result.scores["outcome"].ok, result.scores["outcome"].why
    assert result.passed, result.failures


@pytest.mark.parametrize("name", ["healthy_clean", "healthy_old_deployment", "healthy_irrelevant_warnings", "healthy_misleading_signals", "healthy_no_signal"])
async def test_a_healthy_service_is_reported_healthy_with_the_evidence_that_shows_it(name):
    report, store, _ = await investigate(BY_NAME[name])
    a = report.assessment
    assert report.outcome == "HEALTHY" and a.outcome == "HEALTHY"
    # No cause is manufactured, nothing is blamed and nothing is proposed that would change production.
    assert not [h for h in report.hypotheses if h.status != "unlikely"] and report.confidence <= 0.2
    assert not [x for x in report.recommended_actions if x.effect == "state_changing"]
    # The conclusion rests on evidence that can be opened: metrics that held steady, a healthy status.
    cited = [e for e in store.items if e.ref in a.supporting_refs]
    assert cited and {e.kind for e in cited} <= {"metric_baseline", "service_health"} and any(e.kind == "metric_baseline" for e in cited)
    assert "steady" in a.rationale and "No material evidence of a fault" in a.rationale
    # It still says what it could not look at.
    assert any("trace" in m.lower() for m in a.missing_telemetry)
    assert 0.5 <= a.confidence <= 0.9


async def test_healthy_confidence_follows_coverage_and_is_not_a_constant():
    clean, _, _ = await investigate(BY_NAME["healthy_clean"])
    noisy, _, _ = await investigate(BY_NAME["healthy_no_signal"])
    # The same healthy service, but the metrics endpoint is down: less to go on, lower confidence.
    blind = Scenario(**{**BY_NAME["healthy_clean"].__dict__, "name": "healthy_without_metrics", "fail_paths": ["/metrics"]})
    partial, _, failures = await investigate(blind)
    assert failures and partial.outcome == "HEALTHY"
    assert clean.assessment.confidence > noisy.assessment.confidence > partial.assessment.confidence > 0.15
    assert any("could not be queried" in m for m in partial.assessment.missing_telemetry)
    assert "no metrics were available" in partial.assessment.rationale
    # Useful observations survive: the warnings are reported, as observations and not as a fault.
    assert any("Noticed, but not evidence of a fault" in o.statement for o in noisy.observations)
    old, _, _ = await investigate(BY_NAME["healthy_old_deployment"])
    assert any("Most recent deployment on record" in o.statement and "v8.4.0" in o.statement for o in old.observations)


async def test_a_service_that_sends_nothing_is_undetermined_however_clean_its_empty_log_looks():
    """Found with real telemetry: a service registered in the catalogue but not instrumented was
    reported healthy, because the log queries succeeded and returned no errors."""
    silent = Scenario(name="silent", question="Is ledger-api healthy?", description="", expect=BY_NAME["healthy_clean"].expect, services=[svc("ledger-api")], log_lines=0)
    report, _, failures = await investigate(silent)
    assert not failures and report.outcome == "UNDETERMINED" and report.assessment.confidence == 0
    assert "sent no metric samples and no log lines" in report.assessment.rationale
    assert any("No log lines of any level" in m for m in report.assessment.missing_telemetry) and any("No metric samples" in m for m in report.assessment.missing_telemetry)
    # The same service with metrics but still no logs can be judged, and the report says on what.
    metered = Scenario(**{**silent.__dict__, "name": "metered", "metrics": {"ledger-api": [metric("error_rate", "Error rate", "%", 0.1, 0.1)]}})
    healthy = (await investigate(metered))[0]
    assert healthy.outcome == "HEALTHY" and "rests on metrics" in healthy.assessment.rationale


def test_percentages_on_values_near_zero_are_not_signals():
    """Found with real telemetry: a pool gauge averaging 0.1 connections fell to 0 (down 100%) and
    p95 latency moved from 20 ms to 27 ms (up 35%). The healthy service was reported as degraded."""
    store = EvidenceStore()
    store.ingest("get_metrics", {"service": "x", "metrics": [
        metric("db_connections", "DB connections", "", 0.0, 0.1), metric("latency_p95_ms", "p95", "ms", 27, 20), metric("latency_p50_ms", "p50", "ms", 9, 5),
        metric("requests_per_min", "Throughput", "req/min", 180, 360), metric("queue_depth", "Queue depth", "", 0.4, 0.0),
    ]})
    levels = {s.text.split(" for ")[0]: s.level for s in find_signals(store)}
    assert levels == {"DB connections": "weak", "p95": "weak", "p50": "weak", "Throughput": "moderate", "Queue depth": "weak"}
    real = EvidenceStore()
    real.ingest("get_metrics", {"service": "x", "metrics": [metric("latency_p95_ms", "p95", "ms", 950, 45), metric("latency_p50_ms", "p50", "ms", 70, 45), metric("db_connections", "DB connections", "", 6, 1.2)]})
    assert {s.text.split(" for ")[0]: s.level for s in find_signals(real)} == {"p95": "strong", "p50": "moderate", "DB connections": "moderate"}


async def test_no_telemetry_is_undetermined_not_healthy():
    silent = Scenario(name="no_telemetry", question="Is ledger-api healthy?", description="", expect=BY_NAME["healthy_clean"].expect, services=[svc("ledger-api")], fail_paths=["/logs", "/metrics"])
    report, _, _ = await investigate(silent)
    assert report.outcome == "UNDETERMINED" and report.assessment.confidence == 0
    assert "neither a fault nor good health" in report.assessment.rationale


async def test_a_report_that_blames_a_healthy_service_is_corrected_by_the_evidence():
    """The failure seen with a real model: asked whether a deployment broke something, it finds a
    reason. Here a hand-written report does exactly that on the misleading-signals scenario."""
    _, store, _ = await investigate(BY_NAME["healthy_misleading_signals"])
    d51 = next(e.ref for e in store.items if e.source_id == "d51" and e.kind == "deployment")
    warn = next(e.ref for e in store.by_kind("log_pattern"))
    blaming = InvestigationReport(
        summary="The v6.3.0 deployment introduced slow queries.", confidence=0.6, outcome="INCIDENT",
        hypotheses=[HypothesisOut(title="Regression in reports-api v6.3.0", description="Slow queries began after the deployment.", confidence=0.6, status="likely", evidence_refs=[d51, warn])],
        recommended_actions=[
            RecommendedAction(type="rollback_deployment", title="Roll back reports-api to v6.2.9", description="Return to the previous version.", risk="MEDIUM", evidence_refs=[d51], parameters=RemediationParameters(deployment_id="d51", to_version="v6.2.9")),
            RecommendedAction(type="manual", title="Review the slow query plan", description="Read the EXPLAIN output for monthly_summary.", risk="LOW", evidence_refs=[warn]),
        ],
    )
    notes = guardrails.enforce(blaming, store, scope=["reports-api"], tool_failures=[])
    assert blaming.outcome == "HEALTHY" and any("concluded INCIDENT; the evidence supports HEALTHY" in n for n in notes)
    assert blaming.hypotheses[0].status == "unlikely" and blaming.hypotheses[0].confidence == 0.2 and blaming.confidence == 0.2
    # The rollback goes; the read-only check stays.
    assert [(a.type, a.effect) for a in blaming.recommended_actions] == [("manual", "read_only")]
    assert any("would change production" in n for n in notes)


async def test_a_report_that_calls_a_failing_service_healthy_is_corrected_too():
    _, store, _ = await investigate(BY_NAME["bad_deploy_matching_change"])
    rosy = InvestigationReport(summary="Everything looks fine.", confidence=0.0, outcome="HEALTHY")
    notes = guardrails.enforce(rosy, store, scope=["orders-api"], tool_failures=[])
    assert rosy.outcome == "DEGRADED" and rosy.assessment.signals[0].level == "strong"
    assert any("concluded HEALTHY; the evidence supports DEGRADED" in n for n in notes)
    assert "does not establish what caused it" in rosy.assessment.rationale


def test_a_metric_that_rises_from_zero_is_a_change_although_it_has_no_percentage():
    """Found with real telemetry: a service with no errors at all has a baseline of zero, so an
    error rate of 28% had no percentage change and was filed as steady."""
    store = EvidenceStore()
    store.ingest("get_metrics", {"service": "x", "metrics": [metric("error_rate", "Error rate", "%", 28.0, 0.0), metric("queue_depth", "Queue depth", "", 3.0, 0.0), metric("latency_p95_ms", "p95", "ms", 40, 40)]})
    kinds = {e.kind: e for e in store.items}
    assert [e.title for e in store.by_kind("metric")] == ["Error rate for x up from zero", "Queue depth for x up from zero"]
    assert "latency_p95_ms" in kinds["metric_baseline"].summary and "error_rate" not in kinds["metric_baseline"].summary
    levels = {s.text: s.level for s in find_signals(store)}
    assert levels == {"Error rate for x up from zero": "strong", "Queue depth for x up from zero": "moderate"}
    # A rate that leaves zero but stays negligible is not a failure.
    quiet = EvidenceStore()
    quiet.ingest("get_metrics", {"service": "x", "metrics": [metric("error_rate", "Error rate", "%", 0.2, 0.0)]})
    assert [s.level for s in find_signals(quiet)] == ["weak"]


def test_signal_strength_follows_size_not_mere_presence():
    store = EvidenceStore()
    store.ingest("find_log_anomalies", {"anomalies": [pattern("a", "x", "boom", 400, 20), pattern("b", "x", "hiccup", 4, 20), pattern("c", "x", "retry", 6, 20, level="WARN"), pattern("d", "x", "flood", 80, 20, level="WARN")]})
    store.ingest("get_metrics", {"service": "x", "metrics": [metric("error_rate", "Error rate", "%", 0.3, 0.1), metric("latency_p95_ms", "p95", "ms", 300, 150), metric("connections", "Connections", "", 80, 140)]})
    levels = {s.text.split(" in ")[0].split(" for ")[0]: s.level for s in find_signals(store)}
    assert levels["400× ERROR"] == "strong" and levels["4× ERROR"] == "moderate" and levels["6× WARN"] == "weak" and levels["80× WARN"] == "moderate"
    # An error rate that triples but stays at 0.3% is not a failure; latency that doubles is.
    assert levels["Error rate"] == "weak" and levels["p95"] == "strong" and levels["Connections"] == "moderate"
    assert assess(store, [], ["x"], []).outcome == "DEGRADED"  # a failure is evident, no cause is established


# ───────────────────────── Action effects ─────────────────────────


def test_action_effect_follows_what_the_action_does_not_what_it_is_called():
    cases = json.loads((FIXTURES / "action-effects.json").read_text())
    wrong = [(c["title"], action_effect(c["type"], c["title"], c["description"])) for c in cases if action_effect(c["type"], c["title"], c["description"])[0] != c["effect"]]
    assert not wrong, wrong
    assert {c["effect"] for c in cases if c["type"] == "run_runbook"} == {"read_only", "state_changing"}  # the type alone decides nothing
    effect, why = classify_text("Flush the order keys in the cache")
    assert effect == "state_changing" and "clears a queue, cache or data" in why[0]
    assert classify_text("Do the needful")[0] == "state_changing"  # unclear is never read-only
    # A runbook counts by its steps.
    assert action_effect("run_runbook", "Cache runbook", "Follow it.", ["Check the hit ratio", "Restart the cache node"])[0] == "state_changing"
    assert action_effect("run_runbook", "Cache runbook", "Follow it.", ["Check the hit ratio", "Compare key counts"])[0] == "read_only"


def test_guardrails_label_each_action_and_treat_a_runbook_flush_as_a_production_change():
    store = EvidenceStore()
    store.add("log_pattern", "300× ERROR in svc (new pattern)", "boom", source_type="log_pattern", source_id="fp", service="svc", occurred_at=t(20), data={"level": "ERROR", "count": 300, "kind": "new"})
    store.add("document", "Runbook: cache", "Flush or roll back.", source_type="knowledge_chunk", source_id="k1")
    store.add("service_event", "Flag enabled", "x", source_type="service_event", source_id="e1", service="svc")
    store.add("deployment", "Deployment of svc v2 (succeeded)", "x", source_type="deployment", source_id="d1", service="svc", occurred_at=t(30), data={"version": "v2", "status": "SUCCEEDED"})
    report = InvestigationReport(
        summary="s", confidence=0.7,
        hypotheses=[HypothesisOut(title="Cache", description="d", confidence=0.7, status="likely", evidence_refs=["E1", "E2", "E4"]), HypothesisOut(title="Flag", description="d", confidence=0.1, status="unlikely", evidence_refs=["E3"])],
        recommended_actions=[
            RecommendedAction(type="run_runbook", title="Flush the cache per the runbook", description="Flush every order key.", risk="LOW", evidence_refs=["E2"], effect="read_only"),
            RecommendedAction(type="run_runbook", title="Purge the flag cache", description="Clear cached flag values.", risk="LOW", evidence_refs=["E3"]),
            RecommendedAction(type="manual", title="Check the cache hit ratio", description="Compare with yesterday.", risk="LOW", evidence_refs=["E1"], effect="state_changing"),
        ],
    )
    notes = guardrails.enforce(report, store)
    flush, check = report.recommended_actions
    # The label is computed, whatever the author wrote.
    assert (flush.effect, check.effect) == ("state_changing", "read_only") and "clears a queue" in flush.effect_reasons[0]
    # A state-changing runbook step resting on the unlikely hypothesis is not offered at all.
    assert any("Purge the flag cache" in n and "rated unlikely" in n for n in notes)
    assert any("Considered and not recommended" in step and "Purge the flag cache" in step for step in report.next_steps)


def test_a_rollback_is_offered_only_with_a_target_the_evidence_bears_out():
    def store_with_history() -> EvidenceStore:
        s = EvidenceStore()
        s.ingest("list_deployments", {"deployments": [
            {"id": "d11", "service": "checkout-api", "version": "v2.8.0", "status": "SUCCEEDED", "startedAt": t(24)},
            {"id": "d10", "service": "checkout-api", "version": "v2.7.5", "status": "FAILED", "startedAt": t(2880)},
            {"id": "d9", "service": "checkout-api", "version": "v2.7.4", "status": "SUCCEEDED", "startedAt": t(12960)},
            {"id": "d8", "service": "checkout-api", "version": "v2.7.3", "status": "ROLLED_BACK", "startedAt": t(20000)},
            {"id": "d7", "service": "checkout-api", "version": "v2.7.2", "status": "SUCCEEDED", "startedAt": t(30000)},
            {"id": "x1", "service": "other-api", "version": "v1.0.0", "status": "SUCCEEDED", "startedAt": t(9000)},
        ]})
        s.add("log_pattern", "640× ERROR in checkout-api (new pattern)", "pool", source_type="log_pattern", source_id="fp", service="checkout-api", occurred_at=t(19), data={"level": "ERROR", "count": 640, "kind": "new"})
        return s

    def attempt(**params: Any) -> tuple[RecommendedAction, list[str]]:
        store = store_with_history()
        report = InvestigationReport(
            summary="s", confidence=0.7, hypotheses=[HypothesisOut(title="Pool", description="d", confidence=0.7, status="likely", evidence_refs=["E1", "E5"])],
            recommended_actions=[RecommendedAction(type="rollback_deployment", title="Roll back checkout-api", description="Return to the previous version.", risk="MEDIUM", evidence_refs=["E1"], parameters=RemediationParameters(**params))],
        )
        notes = guardrails.enforce(report, store)
        if not report.recommended_actions:
            assert any("Considered and not recommended" in step and "Roll back checkout-api" in step for step in report.next_steps)
        return report.recommended_actions[0] if report.recommended_actions else None, notes

    good, notes = attempt(deployment_id="d11", to_version="v2.7.4")
    assert good.type == "rollback_deployment" and good.parameters.to_version == "v2.7.4" and not any("rollback" in n for n in notes)
    assert attempt(deployment_id="d11", to_version="2.7.4")[0].type == "rollback_deployment"  # the "v" is not significant
    for params, reason in [
        ({"deployment_id": "d11", "to_version": "v2.7.5"}, "did not deploy successfully (FAILED), so it never ran"),
        ({"deployment_id": "d11", "to_version": "v2.6.0"}, "is not an earlier deployment of checkout-api"),
        ({"deployment_id": "d11", "to_version": "v1.0.0"}, "is not an earlier deployment of checkout-api"),  # another service's version
        ({"deployment_id": "dep_999", "to_version": "v2.7.4"}, "is not among the deployments that were retrieved"),
        ({"deployment_id": "d11"}, "does not say which version to return to"),
        ({"to_version": "v2.7.4"}, "does not say which deployment to roll back"),
        ({"deployment_id": "d9", "to_version": "v2.7.4"}, "is not an earlier deployment"),  # a version cannot be rolled back to itself
        ({"deployment_id": "d11", "to_version": "v2.7.3"}, "was itself rolled back, so it is not a version to return to"),
        ({"deployment_id": "d8", "to_version": "v2.7.2"}, "has already been rolled back"),
    ]:
        action, notes = attempt(**params)
        assert any(reason in n and "not offered for approval" in n for n in notes), (params, notes)
        assert action is None  # not relabelled as "manual": it is withdrawn


# ───────────────────────── Claims: figures checked against their sources ─────────────────────────


def metric_store() -> EvidenceStore:
    s = EvidenceStore()
    s.ingest("get_metrics", {"service": "orders-api", "metrics": [
        {"metric": "error_rate", "label": "Error rate", "unit": "%", "window": {"from": t(120), "to": t(0), "avg": 12.37, "max": 15.6, "min": 7.4, "samples": 120}, "baseline": {"avg": 0.4}, "changePercent": 2992.5},
        {"metric": "latency_p95_ms", "label": "p95 latency", "unit": "ms", "window": {"from": t(120), "to": t(0), "avg": 4800, "max": 6240, "min": 2880, "samples": 120}, "baseline": {"avg": 220}, "changePercent": 2081.8},
        {"metric": "db_connections", "label": "DB connections", "unit": "", "window": {"from": t(120), "to": t(0), "avg": 80, "max": 96, "min": 61, "samples": 120}, "baseline": {"avg": 140}, "changePercent": -42.9},
    ]})  # E1 error rate, E2 latency, E3 connections
    s.ingest("list_deployments", {"deployments": [{"id": "d1", "service": "orders-api", "version": "v4.2.0", "status": "SUCCEEDED", "commitSha": "aaaaaaaaaaaa1111", "startedAt": t(38)}]})  # E4
    s.ingest("find_log_anomalies", {"anomalies": [pattern("f1", "orders-api", "failed to deserialize cache entry: unexpected schema version", 420, 30)]})  # E5
    s.ingest("get_code_changes", {"commits": [], "pullRequests": [{"id": "p1", "number": 77, "service": "orders-api", "title": "Bump cache schema", "body": "Schema v3.", "mergedAt": t(60), "mergeCommitSha": "aaaaaaaaaaaa"}]})  # E6
    s.ingest("search_incidents", {"incidents": [{"id": "i1", "key": "INC-12", "title": "Cache poisoning", "rootCause": "Schema change", "startedAt": t(90000)}]})  # E7
    return s


def one(store: EvidenceStore, text: str, refs: list[str], **kw: Any):
    checks = Checker(store).check(text, refs, **kw)
    assert len(checks) == 1, checks
    return checks[0]


def test_exact_values_and_unit_conversions_are_recognised():
    s = metric_store()
    assert one(s, "Error rate averaged 12.37% in the window.", ["E1"]).status == "exact"
    assert one(s, "p95 latency averaged 4800 ms.", ["E2"]).status == "exact"
    assert one(s, "p95 latency averaged 4.8 seconds.", ["E2"]).status == "exact"  # 4800 ms, said in seconds
    assert one(s, "The pattern occurred 420 times.", ["E5"]).status == "exact"
    assert one(s, "Connections averaged 80.", ["E3"]).status == "exact"
    assert one(s, "Latency peaked at 6,240ms.", ["E2"]).status == "exact"  # thousands separator


def test_incorrect_values_are_flagged():
    s = metric_store()
    wrong = one(s, "Error rate averaged 21.5%.", ["E1"])
    assert wrong.status == "unsupported" and "no cited evidence holds this value" in wrong.detail
    assert one(s, "The pattern occurred 4200 times.", ["E5"]).status == "unsupported"
    # A number that looks right but belongs to another metric: 80 is the connection count, not a percentage.
    assert one(s, "Error rate reached 80%.", ["E1", "E3"]).status == "unsupported"


def test_rounded_values_are_accepted_as_rounded_and_no_further():
    s = metric_store()
    rounded = one(s, "Error rate averaged 12.4%.", ["E1"])
    assert rounded.status == "rounded" and "12.37" in rounded.detail
    assert one(s, "Error rate averaged 12%.", ["E1"]).status == "rounded"
    assert one(s, "Error rate averaged 13%.", ["E1"]).status == "unsupported"  # 12.37 does not round to 13
    assert one(s, "Error rate averaged 12.5%.", ["E1"]).status == "unsupported"


def test_wrong_units_are_flagged_with_the_reason():
    s = metric_store()
    wrong = one(s, "p95 latency averaged 4800 seconds.", ["E2"])
    assert wrong.status == "unsupported" and "the unit differs" in wrong.detail and "4800 ms" in wrong.detail
    assert "the unit differs" in one(s, "Latency rose by 4800%.", ["E2"]).detail
    assert one(s, "Connections averaged 80 ms.", ["E3"]).status == "unsupported"


def test_timestamps_are_compared_in_utc_and_unsupported_ones_flagged():
    s = metric_store()
    stamps = Checker(s).check(f"Deployed at {t(38)}; errors first seen at {t(30)}; alarm at 2026-06-01T09:17:00Z.", ["E4", "E5"])
    by_text = {c.text: c for c in stamps if c.kind == "timestamp"}
    assert by_text[t(38)].status == "exact" and by_text[t(30)].status == "exact"
    assert by_text["2026-06-01T09:17:00Z"].status == "unsupported" and "no evidence carries" in by_text["2026-06-01T09:17:00Z"].detail
    # The same instant written with an offset is the same instant.
    offset = [c for c in Checker(s).check("Deployed at 2026-06-01T13:22:00+02:00.", ["E4"]) if c.kind == "timestamp"][0]
    assert offset.status == "exact" and "11:22Z" in offset.detail
    # Without a zone it is read as UTC, and the reader is told.
    naive = [c for c in Checker(s).check("Deployed at 2026-06-01T11:22:00.", ["E4"]) if c.kind == "timestamp"][0]
    assert naive.status == "exact" and "no time zone given; read as UTC" in naive.detail
    # Local time mistaken for UTC does not match.
    assert [c for c in Checker(s).check("Deployed at 2026-06-01T13:22:00Z.", ["E4"]) if c.kind == "timestamp"][0].status == "unsupported"
    # A time of day alone, and a timestamp that exists only in evidence the statement does not cite.
    assert [c for c in Checker(s).check("Errors began at 11:30Z.", ["E5"]) if c.kind == "timestamp"][0].status == "exact"
    assert [c for c in Checker(s).check(f"Errors began at {t(30)}.", ["E1"]) if c.kind == "timestamp"][0].status == "uncited"


def test_versions_commits_pull_requests_and_incident_keys_must_exist():
    s = metric_store()
    checks = {c.text: c for c in Checker(s).check("v4.2.0 (commit aaaaaaaaaaaa1111, #77) repeats INC-12; v4.3.1, commit deadbeef1234, PR #91 and INC-99 do not exist.", ["E4", "E6", "E7"])}
    assert [checks[k].status for k in ("v4.2.0", "aaaaaaaaaaaa1111", "#77", "INC-12")] == ["exact"] * 4
    assert [checks[k].status for k in ("v4.3.1", "deadbeef1234", "PR #91", "INC-99")] == ["unsupported"] * 4
    assert {checks[k].kind for k in ("v4.2.0", "aaaaaaaaaaaa1111", "#77", "INC-12")} == {"version", "commit", "pull_request", "incident"}
    # A correct version that the statement does not cite is traceable only by luck: say so.
    assert one(s, "v4.2.0 is running.", ["E1"]).status == "uncited"


def test_unsupported_percentages_and_calculated_values():
    s = metric_store()
    assert one(s, "Errors rose by 300%.", ["E1"]).status == "unsupported"
    # 12.37 / 0.4 = 30.9: a ratio of two values in the cited evidence.
    ratio = one(s, "The error rate is 31 times its baseline.", ["E1"])
    assert ratio.status == "calculated" and "ratio of 12.37% and 0.4%" in ratio.detail
    assert one(s, "Connections fell by 60.", ["E3"]).status == "calculated"  # 140 - 80
    assert one(s, "Errors began 8 minutes after the deployment.", ["E4", "E5"]).status == "calculated"  # 11:22 → 11:30
    # Quoted as approximate, an interval may be a minute out: timestamps are compared to the minute.
    assert one(s, "Errors began about 9 minutes after the deployment.", ["E4", "E5"]).status == "estimate"
    assert one(s, "Errors began about 12 minutes after the deployment.", ["E4", "E5"]).status == "unsupported"
    # The same calculation with one input missing from the cited evidence cannot be checked.
    missing = one(s, "Errors began 8 minutes after the deployment.", ["E5"])
    assert missing.status == "unsupported"
    assert one(s, "The error rate is 55 times its baseline.", ["E1"]).status == "unsupported"
    assert one(s, "Latency is 22 times higher.", ["E1"]).status == "unsupported"  # true of E2, which is not cited: 4800/220 is not in E1


def test_estimates_are_labelled_and_still_have_to_be_close():
    s = metric_store()
    est = one(s, "Latency averaged roughly 5000 ms.", ["E2"])
    assert est.status == "estimate" and "stated as approximate" in est.detail
    assert one(s, "Latency averaged about 4800 ms.", ["E2"]).status == "exact"  # an estimate that is exact is simply exact
    far = one(s, "Latency averaged roughly 9000 ms.", ["E2"])
    assert far.status == "unsupported" and "no cited value is within 15%" in far.detail
    assert one(s, "Latency averaged 5000 ms.", ["E2"]).status == "unsupported"  # the same figure, not marked as an estimate


def test_wording_and_the_report_s_own_confidence_are_not_treated_as_measurements():
    assert number_claims("2 hypotheses were considered; see step 3 and E12.") == []
    assert number_claims("The leading hypothesis has 64% confidence (confidence of 0.3 for the other).") == []
    assert [c.text for c in number_claims("p95 latency rose between 10:00 and 12:00Z to 4800ms in v4.2.0 (#77)")] == ["4800ms"]
    s = metric_store()
    assert one(s, "Roll back and watch for 15 minutes.", ["E4"], cite_all=False).status == "unsupported"
    assert Checker(s).check("Roll back to v4.2.0 and watch for 15 minutes.", ["E4"], figures=False)[0].kind == "version"  # an action's numbers are instructions


def test_idioms_seen_in_real_model_reports_are_not_mistaken_for_figures():
    """Each of these was flagged when the validator was first run over the nine saved live reports."""
    s = metric_store()
    checker = Checker(s, known_times=[t(120), t(0)])
    assert number_claims("api-gateway is returning 502s for payments-api (HTTP 503, 500 errors, status code 504)") == []
    assert number_claims("Confidence is low, about 0.3, because the evidence is timing only; confidence about 35%.") == []
    lag = [c for c in checker.check("The 8-minute lag between deployment and first error is unexplained.", ["E4", "E5"]) if c.kind == "number"]
    assert [c.status for c in lag] == ["calculated"]
    # The investigation's own window is known to it; a date is compared as a date.
    window = checker.check(f"Read the logs for 10:30 to 12:00Z on {t(0)[:10]}.", ["E5"], figures=False)
    assert {c.text: c.status for c in window} == {"12:00Z": "exact", t(0)[:10]: "exact"}
    assert [c.status for c in checker.check("Deployed on 2026-05-25.", ["E4"])] == ["unsupported"]
    assert [c.status for c in checker.check(f"Deployed on {t(38)[:10]}.", ["E4"])] == ["exact"]
    # Real quantities next to those idioms are still checked.
    assert [(c.text, c.status) for c in checker.check("While returning 502s the error rate averaged 21.5%.", ["E1"])] == [("21.5%", "unsupported")]


def test_a_report_is_labelled_fact_by_fact_and_the_tally_reaches_the_reader():
    s = metric_store()
    s.add("log_pattern", "strong", "x", source_type="log_pattern", source_id="strong", service="orders-api", occurred_at=t(30), data={"level": "ERROR", "count": 420, "kind": "new"})
    report = InvestigationReport(
        summary="Error rate averaged 12.37% after v4.2.0; about 9000 requests failed.", confidence=0.7,
        hypotheses=[HypothesisOut(title="Cache schema change in v4.2.0", description="Errors began 8 minutes after the deployment.", confidence=0.7, status="likely", evidence_refs=["E4", "E5"])],
        facts=[
            Fact(statement="Error rate averaged 12.37% against 0.4% before.", evidence_refs=["E1"]),
            Fact(statement="p95 latency averaged roughly 5000 ms.", evidence_refs=["E2"]),
            Fact(statement="Error rate peaked at 44%.", evidence_refs=["E1"]),
            Fact(statement="The deployment succeeded.", evidence_refs=["E4"]),
        ],
    )
    notes = guardrails.enforce(report, s, scope=["orders-api"])
    assert [f.verification.status for f in report.facts] == ["verified", "partly", "unsupported", "no_claims"]
    assert report.facts[2].verification.checks[0].text == "44%"
    flagged = {(f.where, f.text): f.status for f in report.integrity.flagged}
    assert flagged == {("fact 2", "5000 ms"): "estimate", ("fact 3", "44%"): "unsupported", ("summary", "9000 requests"): "unsupported"}
    assert report.integrity.checked == report.integrity.supported + 3
    # Nothing is deleted or corrected: the claims are kept and marked, and the report says so.
    assert any("could not be matched to evidence" in n and '"44%" in fact 3' in n for n in notes)
    assert any("could not be matched to the collected evidence" in u for u in report.uncertainties)
    wire = report.wire()
    assert wire["facts"][2]["verification"]["status"] == "unsupported" and wire["integrity"]["flagged"][0]["where"]
    assert verify_report(InvestigationReport(summary="Nothing to report.", confidence=0), s).checked == 0


# ───────────────────────── Dependency chains and traces ─────────────────────────


def _dep(slug: str, health: str) -> dict[str, Any]:
    return {"slug": slug, "name": slug, "health": health, "healthNote": f"alert firing on {slug}" if health != "HEALTHY" else None, "kind": "sync"}


def _trace(id_: str, root: str, duration: float, slowest: dict[str, Any] | None = None, errors: list[dict[str, Any]] | None = None) -> dict[str, Any]:
    return {"traceId": id_, "startedAt": t(5), "durationMs": duration, "rootService": root, "rootOperation": "POST /checkout", "spanCount": 6, "services": ["shop-gateway", "shop-orders", "shop-payments"], "slowestSpan": slowest, "errorSpans": errors or []}


async def test_a_chain_of_failing_dependencies_is_followed_to_where_it_starts():
    """gateway → orders → payments → redis, with redis down. The services in between are
    unhealthy too, but only as a consequence: the report must name redis and blame nothing else."""
    scenario = Scenario(
        name="chain", question="Why are checkouts failing on shop-gateway?", description="", expect=BY_NAME["upstream_dependency_down"].expect,
        services=[svc("shop-gateway", ["shop-orders"], "DEGRADED"), svc("shop-orders", ["shop-payments", "shop-postgres"], "DEGRADED"), svc("shop-payments", ["shop-redis"], "DEGRADED"), svc("shop-redis", health="DOWN"), svc("shop-postgres")],
        anomalies=[pattern("g1", "shop-gateway", "upstream shop-orders returned 502", 240, 6)],
        logs=[{"id": "lg", "timestamp": t(3), "level": "ERROR", "service": "shop-gateway", "message": "upstream shop-orders returned 502", "traceId": "t1", "fingerprint": "g1", "attributes": None}],
        metrics={"shop-gateway": [metric("error_rate", "Error rate", "%", 28.0, 0.0)]},
        service_details={
            "shop-gateway": {"health": "DEGRADED", "dependsOn": [_dep("shop-orders", "DEGRADED")]},
            "shop-orders": {"health": "DEGRADED", "dependsOn": [_dep("shop-payments", "DEGRADED"), _dep("shop-postgres", "HEALTHY")]},
            "shop-payments": {"health": "DEGRADED", "dependsOn": [_dep("shop-redis", "DOWN")]},
            "shop-redis": {"health": "DOWN", "dependsOn": []},
        },
    )
    report, store, _ = await investigate(scenario)
    assert report.outcome == "INCIDENT"
    top = report.hypotheses[0]
    assert top.title == "Failure of upstream dependency shop-redis" and top.confidence == 0.45
    assert "shop-gateway → shop-orders → shop-payments → shop-redis" in top.description and "appears to start here" in top.description
    # The healthy database is not mentioned as a suspect, and the links in between rank below the origin.
    assert not any("shop-postgres" in h.title for h in report.hypotheses)
    assert all(h.confidence < top.confidence for h in report.hypotheses[1:])
    assert store.depends_on["shop-payments"] == ["shop-redis"]
    # Asked about the service next to the failure, the answer is the same.
    direct = Scenario(**{**scenario.__dict__, "name": "direct", "question": "Why is shop-payments returning errors?"})
    assert (await investigate(direct))[0].hypotheses[0].title == "Failure of upstream dependency shop-redis"


async def test_traces_locate_where_time_is_lost_without_claiming_to_know_why():
    slowest = {"service": "shop-orders", "operation": "pg.query:SELECT", "durationMs": 1520, "selfMs": 1500, "system": "postgresql", "peer": "demo-postgres"}
    scenario = Scenario(
        name="slow_db", question="Why is shop-orders slow?", description="", expect=BY_NAME["upstream_dependency_down"].expect,
        services=[svc("shop-orders", ["shop-postgres"]), svc("shop-postgres")],
        metrics={"shop-orders": [metric("latency_p95_ms", "p95 latency", "ms", 1650, 45), metric("error_rate", "Error rate", "%", 0.0, 0.0)]},
        traces=[_trace(f"t{i}", "shop-orders", 1700 - i * 10, slowest) for i in range(4)] + [_trace("fast", "shop-orders", 40, {"service": "shop-orders", "operation": "GET /orders/:id", "durationMs": 40, "selfMs": 12, "system": "http", "peer": None})],
        service_details={"shop-orders": {"health": "HEALTHY", "dependsOn": [_dep("shop-postgres", "HEALTHY")]}},
    )
    report, store, _ = await investigate(scenario)
    top = report.hypotheses[0]
    assert report.outcome == "INCIDENT" and top.title == "Time is being lost in shop-orders's calls to demo-postgres"
    assert top.confidence == 0.5 and top.status == "possible"  # located, not explained
    assert "does not say why demo-postgres is slow" in top.description
    cited = {e.kind for e in store.items if e.ref in top.evidence_refs}
    assert cited == {"trace", "metric"}
    # Every figure in the hypothesis is found in the traces it cites.
    assert not [f for f in report.integrity.flagged if f.status == "unsupported"], report.integrity.flagged
    # One slow trace is an anecdote, not a pattern.
    lone = Scenario(**{**scenario.__dict__, "name": "lone", "traces": scenario.traces[:1]})
    assert not (await investigate(lone))[0].hypotheses


async def test_traces_locate_where_requests_fail_at_the_deepest_span_with_a_message():
    errors = [  # from the entry point down, as the API returns them
        {"service": "shop-gateway", "operation": "POST /checkout", "message": "HTTP 502", "system": "http", "peer": None},
        {"service": "shop-orders", "operation": "POST", "message": "HTTP 503", "system": "http", "peer": "demo-payments"},
        {"service": "shop-payments", "operation": "set", "message": "Stream isn't writeable and enableOfflineQueue options is false", "system": "redis", "peer": "demo-redis"},
    ]
    scenario = Scenario(
        name="failed", question="Why are checkouts failing on shop-gateway?", description="", expect=BY_NAME["upstream_dependency_down"].expect,
        services=[svc("shop-gateway", ["shop-orders"])],
        metrics={"shop-gateway": [metric("error_rate", "Error rate", "%", 30.0, 0.0)]},
        traces=[_trace(f"f{i}", "shop-gateway", 60, None, errors) for i in range(3)],
    )
    report, _, _ = await investigate(scenario)
    top = report.hypotheses[0]
    assert top.title == "Requests are failing in shop-payments's calls to demo-redis" and top.confidence == 0.45
    assert "only pass the error on" in top.description and "enableOfflineQueue" in top.description
    assert report.outcome == "INCIDENT" and not [a for a in report.recommended_actions if a.effect == "state_changing"]


async def test_a_failed_dependency_and_traces_failing_in_its_caller_corroborate_each_other():
    """Found on real telemetry: with Redis down, the traces correctly placed the failure in
    shop-payments, and that localisation was listed above the dependency that was actually down."""
    errors = [
        {"service": "shop-gateway", "operation": "POST /checkout", "message": "HTTP 502", "system": None, "peer": None},
        {"service": "shop-payments", "operation": "request handler - /pay", "message": "idempotency store unavailable, refusing to charge", "system": None, "peer": None},
    ]
    scenario = Scenario(
        name="corroborated", question="Why are checkouts failing on shop-gateway?", description="", expect=BY_NAME["upstream_dependency_down"].expect,
        services=[svc("shop-gateway", ["shop-orders"], "DEGRADED"), svc("shop-orders", ["shop-payments"], "DEGRADED"), svc("shop-payments", ["shop-redis"], "DEGRADED"), svc("shop-redis", health="DOWN")],
        metrics={"shop-gateway": [metric("error_rate", "Error rate", "%", 30.0, 0.0)]},
        traces=[_trace(f"c{i}", "shop-gateway", 20, None, errors) for i in range(4)],
        service_details={
            "shop-gateway": {"health": "DEGRADED", "dependsOn": [_dep("shop-orders", "DEGRADED")]},
            "shop-orders": {"health": "DEGRADED", "dependsOn": [_dep("shop-payments", "DEGRADED")]},
            "shop-payments": {"health": "DEGRADED", "dependsOn": [_dep("shop-redis", "DOWN")]},
            "shop-redis": {"health": "DOWN", "dependsOn": []},
        },
    )
    report, store, _ = await investigate(scenario)
    top, second = report.hypotheses[0], report.hypotheses[1]
    assert top.title == "Failure of upstream dependency shop-redis" and top.confidence == 0.57 and top.status == "likely"
    assert "Sampled traces agree: requests fail in shop-payments, which calls shop-redis directly." in top.description
    assert {e.kind for e in store.items if e.ref in top.evidence_refs} == {"dependency", "trace"}
    # The localisation is kept as its own, lower-ranked finding.
    assert second.title == "Requests are failing in shop-payments" and second.confidence < top.confidence


async def test_a_rollback_deployment_after_which_errors_fell_is_not_blamed_for_what_happens_next():
    """Found on real telemetry. A bad release had been rolled back minutes earlier. When the
    database then slowed down, timing alone made the rollback deployment the leading suspect, and
    the engine proposed rolling back to the release that had just been removed for being broken."""
    slowest = {"service": "shop-orders", "operation": "pg.query:SELECT", "durationMs": 405, "selfMs": 403, "system": "postgresql", "peer": "demo-postgres"}
    rollback = {"id": "d-undo", "service": "shop-orders", "version": "v1.4.0", "environment": "production", "status": "SUCCEEDED", "commitSha": "abababab1400", "branch": "main", "deployedBy": "ci", "startedAt": t(126), "finishedAt": t(126), "isRollback": True, "description": "Roll back to v1.4.0"}
    bad = {**rollback, "id": "d-bad", "version": "v1.5.0", "status": "ROLLED_BACK", "commitSha": "abababab1500", "startedAt": t(129), "finishedAt": t(129), "isRollback": False, "description": "Simplify discount lookup"}
    good = {**rollback, "id": "d-good", "status": "SUCCEEDED", "startedAt": t(4000), "finishedAt": t(4000), "isRollback": False, "description": "Order history pagination"}
    scenario = Scenario(
        name="after_rollback", question="Why is shop-orders slow?", description="", expect=BY_NAME["upstream_dependency_down"].expect,
        services=[svc("shop-orders", ["shop-postgres"]), svc("shop-postgres")],
        deployments=[rollback, bad, good],
        metrics={"shop-orders": [metric("latency_p95_ms", "p95 latency", "ms", 780, 30), metric("error_rate", "Error rate", "%", 0.0, 0.0)]},
        traces=[_trace(f"s{i}", "shop-orders", 850 - i, slowest) for i in range(5)],
        service_details={"shop-orders": {"health": "DEGRADED", "dependsOn": [_dep("shop-postgres", "HEALTHY")]}},
        deployment_errors={"d-undo": (180, 0)},
    )
    report, store, _ = await investigate(scenario)
    top = report.hypotheses[0]
    # The traces lead; the two deployments are still listed, with what speaks against each.
    assert top.title == "Time is being lost in shop-orders's calls to demo-postgres" and report.outcome == "INCIDENT"
    by_title = {h.title: h for h in report.hypotheses}
    undo = next(h for title, h in by_title.items() if "v1.4.0" in title and "Rollback" in title)
    assert undo.confidence < top.confidence
    assert any("Error logs fell after this deployment" in c for c in undo.contradictions) and any("returned the service to a version that ran before" in c for c in undo.contradictions)
    removed = next((h for title, h in by_title.items() if "v1.5.0" in title), None)
    assert removed is None or (removed.confidence < 0.3 and any("already been rolled back" in c for c in removed.contradictions))
    # Above all: nothing proposes returning to the release that was rolled back.
    assert not [a for a in report.recommended_actions if a.type == "rollback_deployment"]
    assert not any("v1.5.0" in step for step in report.next_steps)
    assert "No error onset could be determined" in undo.description and not [f for f in report.integrity.flagged if f.status == "unsupported"], report.integrity.flagged


async def test_an_interval_quoted_by_the_engine_cites_both_of_its_ends():
    """Found by the claim validator on real telemetry: "began about 3 minutes after this
    deployment" cited the deployment but not the log pattern whose first occurrence was the onset."""
    for name in ("bad_deploy_matching_change", "red_herring_closer_in_time", "deployment_rollback_target"):
        report, store, _ = await investigate(BY_NAME[name])
        top = report.hypotheses[0]
        assert "minutes after this deployment" in top.description
        kinds = {e.kind for e in store.items if e.ref in top.evidence_refs}
        assert {"deployment", "log_pattern"} <= kinds, (name, kinds)
        assert not [f for f in report.integrity.flagged if f.status == "unsupported"], (name, report.integrity.flagged)


async def test_only_the_last_deployment_before_the_problem_is_the_code_that_was_running():
    """Found on real telemetry: a service deployed twice within half an hour. Both deployments
    scored the same on timing, although the earlier one had been replaced before the errors began."""
    base = {"service": "shop-orders", "environment": "production", "status": "SUCCEEDED", "branch": "main", "deployedBy": "ci", "isRollback": False}
    scenario = Scenario(
        name="two_deploys", question="Why is shop-orders returning errors?", description="", expect=BY_NAME["bad_deploy_matching_change"].expect,
        services=[svc("shop-orders")],
        anomalies=[pattern("o1", "shop-orders", "failed to compute order total: Cannot read properties of null", 300, 2)],
        logs=[{"id": "lo", "timestamp": t(1), "level": "ERROR", "service": "shop-orders", "message": "failed to compute order total: Cannot read properties of null", "traceId": "x", "fingerprint": "o1", "attributes": None}],
        deployments=[
            {**base, "id": "new", "version": "v1.5.0", "commitSha": "abababab1500", "startedAt": t(3), "finishedAt": t(3), "description": "Simplify discount lookup"},
            {**base, "id": "old", "version": "v1.4.0", "commitSha": "abababab1400", "startedAt": t(27), "finishedAt": t(27), "description": "Order history pagination"},
            {**base, "id": "older", "version": "v1.3.9", "commitSha": "abababab1309", "startedAt": t(9000), "finishedAt": t(9000), "description": "Routine update"},
        ],
        metrics={"shop-orders": [metric("error_rate", "Error rate", "%", 55.0, 0.0)]},
    )
    report, _, _ = await investigate(scenario)
    first, second = report.hypotheses[0], next(h for h in report.hypotheses if "v1.4.0" in h.title)
    assert "v1.5.0" in first.title and first.confidence >= second.confidence + 0.15
    assert any("replaced it before the problem began" in c for c in second.contradictions)
    (rollback,) = [a for a in report.recommended_actions if a.type == "rollback_deployment"]
    assert rollback.parameters.deployment_id == "new" and rollback.parameters.to_version == "v1.4.0"


def test_a_rollback_is_judged_by_the_deployment_it_rolls_back_not_by_the_target_it_cites():
    """Found on real telemetry: the correct rollback was withdrawn because it cited the previous
    version's deployment record, which was also the only evidence of a hypothesis rated unlikely
    ("regression introduced by that earlier deployment")."""
    def build() -> tuple[EvidenceStore, InvestigationReport]:
        store = EvidenceStore()
        store.ingest("list_deployments", {"deployments": [
            {"id": "new", "service": "shop-orders", "version": "v1.5.0", "status": "SUCCEEDED", "startedAt": t(3)},
            {"id": "prev", "service": "shop-orders", "version": "v1.4.0", "status": "SUCCEEDED", "startedAt": t(40), "isRollback": True},
        ]})  # E1 the bad release, E2 the version before it
        store.add("log_pattern", "300× ERROR in shop-orders (new pattern)", "boom", source_type="log_pattern", source_id="fp", service="shop-orders", occurred_at=t(2), data={"level": "ERROR", "count": 300, "kind": "new"})
        report = InvestigationReport(
            summary="s", confidence=0.57,
            hypotheses=[
                HypothesisOut(title="Regression introduced by v1.5.0", description="d", confidence=0.57, status="likely", evidence_refs=["E1", "E3"]),
                HypothesisOut(title="Regression introduced by the earlier v1.4.0 deployment", description="d", confidence=0.2, status="unlikely", evidence_refs=["E2"]),
            ],
        )
        return store, report

    store, report = build()
    report.recommended_actions = [RecommendedAction(type="rollback_deployment", title="Roll back shop-orders to v1.4.0", description="Return to the previous version.", risk="MEDIUM", evidence_refs=["E1", "E2", "E3"], parameters=RemediationParameters(deployment_id="new", to_version="v1.4.0"))]
    notes = guardrails.enforce(report, store)
    assert [a.type for a in report.recommended_actions] == ["rollback_deployment"] and not any("rated unlikely" in n for n in notes)

    # Rolling back the deployment that the unlikely hypothesis is about is still withdrawn.
    store, report = build()
    store.ingest("list_deployments", {"deployments": [{"id": "older", "service": "shop-orders", "version": "v1.3.9", "status": "SUCCEEDED", "startedAt": t(9000)}]})
    report.recommended_actions = [RecommendedAction(type="rollback_deployment", title="Roll back shop-orders to v1.3.9", description="Undo the earlier deployment.", risk="MEDIUM", evidence_refs=["E1", "E2"], parameters=RemediationParameters(deployment_id="prev", to_version="v1.3.9"))]
    notes = guardrails.enforce(report, store)
    assert report.recommended_actions == [] and any("rated unlikely" in n for n in notes)

    # Any other production change is still judged by everything it cites.
    store, report = build()
    report.recommended_actions = [RecommendedAction(type="restart_service", title="Restart shop-orders", description="Restart the pods.", risk="LOW", evidence_refs=["E2", "E3"])]
    notes = guardrails.enforce(report, store)
    assert report.recommended_actions == [] and any("rated unlikely" in n for n in notes)

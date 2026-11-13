"""Each rule of the rule-based analysis, on its own.

A rule is given a Case built from a handful of evidence items and nothing else: no graph, no
tool client, no other rule. What the whole analysis produces is pinned separately by the golden
snapshot (test_heuristics_golden.py).
"""

from datetime import UTC, datetime, timedelta
from typing import Any

from app import rules
from app.evidence import EvidenceStore
from app.rules import Case

NOW = datetime(2026, 6, 1, 12, 0, tzinfo=UTC)
WINDOW = (NOW - timedelta(hours=2), NOW)


def at(minutes_ago: float) -> str:
    return (NOW - timedelta(minutes=minutes_ago)).isoformat().replace("+00:00", "Z")


def deployment(store: EvidenceStore, id_: str, version: str, minutes_ago: float, *, service: str = "orders", status: str = "SUCCEEDED", rollback: bool = False, sha: str = "") -> str:
    store.ingest("list_deployments", {"deployments": [{"id": id_, "service": service, "version": version, "status": status, "commitSha": sha or None, "startedAt": at(minutes_ago), "isRollback": rollback}]})
    return next(e.ref for e in store.items if e.source_id == id_ and e.kind == "deployment")


def errors(store: EvidenceStore, sample: str = "failed to compute order total", *, service: str = "orders", count: int = 300, minutes_ago: float = 10) -> str:
    store.ingest("find_log_anomalies", {"anomalies": [{"fingerprint": f"fp-{len(store.items)}", "sample": sample, "level": "ERROR", "serviceId": f"svc_{service}", "serviceSlug": service, "count": count, "firstSeen": at(minutes_ago), "lastSeen": at(1), "baselineCount": 0, "kind": "new"}]})
    return store.items[-1].ref


def case_for(store: EvidenceStore, scope: list[str] | None = None, **kw: Any) -> Case:
    return Case.build(store, scope=scope or ["orders"], window=WINDOW, **kw)


# ───────────────────────── Case ─────────────────────────


def test_case_dates_the_onset_from_the_major_error_pattern_not_from_background_noise():
    store = EvidenceStore()
    errors(store, "occasional retry", count=4, minutes_ago=110)  # background: a few an hour, long before
    main = errors(store, "timeout acquiring connection", count=400, minutes_ago=30)
    case = case_for(store)
    assert case.onset == NOW - timedelta(minutes=30) and case.onset_ev.ref == main and case.dominant.ref == main
    assert {"timeout", "connection"} <= case.symptom_words and case.affected == {"orders"}
    # With no error pattern at all there is no onset evidence: the window start is only a fallback.
    quiet = case_for(EvidenceStore())
    assert quiet.onset == WINDOW[0] and quiet.onset_ev is None and quiet.dominant is None


# ───────────────────────── rule_recent_change ─────────────────────────


def test_recent_change_scores_by_how_soon_the_errors_followed_and_proposes_a_rollback_to_the_last_good_version():
    store = EvidenceStore()
    new = deployment(store, "new", "v1.5.0", 13)
    good = deployment(store, "good", "v1.4.0", 4000)
    pattern = errors(store, minutes_ago=10)
    case = case_for(store)
    rules.rule_recent_change(case)
    (h,) = case.hypotheses
    assert h.title == "Regression introduced by Deployment of orders v1.5.0 (succeeded)"
    assert h.confidence == 0.52 and h.status == "possible"  # 0.42 for timing within half an hour, 0.10 for the same service
    assert h.evidence_refs == [new, pattern] and "3 minutes after this deployment" in h.description
    (action,) = case.actions
    assert action.type == "rollback_deployment" and action.parameters.deployment_id == "new" and action.parameters.to_version == "v1.4.0"
    assert action.evidence_refs == [new, good, pattern]


def test_recent_change_ignores_changes_after_the_onset_and_long_before_it():
    store = EvidenceStore()
    deployment(store, "after", "v2", 1)        # 14 minutes AFTER the errors began
    deployment(store, "ancient", "v0", 800)    # more than six hours before
    errors(store, minutes_ago=15)
    case = case_for(store)
    rules.rule_recent_change(case)
    assert case.hypotheses == [] and case.actions == []


def test_recent_change_gains_from_shipped_code_that_matches_the_failure_and_loses_from_code_that_does_not():
    def run(pr_title: str) -> Any:
        store = EvidenceStore()
        deployment(store, "d1", "v4.2.0", 38, sha="aaaaaaaaaaaa1111")
        errors(store, "timeout acquiring connection from database pool", minutes_ago=30)
        store.ingest("get_code_changes", {"commits": [], "pullRequests": [{"id": "p1", "number": 7, "service": "orders", "title": pr_title, "body": "", "mergedAt": at(60), "mergeCommitSha": "aaaaaaaaaaaa"}]})
        case = case_for(store)
        rules.rule_recent_change(case)
        return case.hypotheses[0]

    matching, unrelated = run("Lower the database connection pool size"), run("Update the footer copy")
    assert matching.confidence > unrelated.confidence
    assert any("also appear in the error messages" in f for f in matching.facts)
    assert any("do not mention anything that appears in the error messages" in c for c in unrelated.contradictions) and unrelated.contradicting_evidence_refs


def test_a_change_on_a_service_without_symptoms_is_marked_down():
    store = EvidenceStore()
    deployment(store, "other", "v9", 14, service="search")
    errors(store, minutes_ago=10)
    case = case_for(store)
    rules.rule_recent_change(case)
    (h,) = case.hypotheses
    assert h.confidence == 0.32 and any("not where the errors are occurring" in c for c in h.contradictions)
    assert case.actions == []  # too weak for a rollback proposal


def test_weigh_against_deployment_applies_each_reason_separately():
    def weigh(**kw: Any) -> tuple[float, list[str]]:
        store = EvidenceStore()
        ref = deployment(store, "d", "v2", 20, **{k: v for k, v in kw.items() if k in ("status", "rollback")})
        if kw.get("later"):
            deployment(store, "later", "v3", 15)
        if kw.get("errors_fell"):
            store.ingest("get_deployment_context", {"deployment": {"id": "d", "service": "orders", "version": "v2", "status": "SUCCEEDED", "startedAt": at(20)}, "errorLogs": {"windowMinutes": 20, "before": 180, "after": 0, "beforePerMinute": 6.0, "afterPerMinute": 0.0}, "changes": {}})
        errors(store, minutes_ago=10)
        case = case_for(store)
        contradictions: list[str] = []
        change = next(e for e in store.items if e.ref == ref)
        return round(rules.weigh_against_deployment(case, change, 0.6, contradictions, []), 2), contradictions

    assert weigh() == (0.6, [])
    score, why = weigh(status="ROLLED_BACK")
    assert score == 0.3 and "already been rolled back" in why[0]
    score, why = weigh(rollback=True)
    assert score == 0.45 and "returned the service to a version that ran before" in why[0]
    score, why = weigh(later=True)
    assert score == 0.4 and "replaced it before the problem began" in why[0]
    score, why = weigh(errors_fell=True)
    assert score == 0.35 and "Error logs fell after this deployment, from 6.0/min to 0.0/min" in why[0]
    # The reasons add up.
    assert weigh(rollback=True, errors_fell=True)[0] == 0.2


def test_propose_rollback_refuses_rollbacks_of_rollbacks_weak_suspects_and_missing_targets():
    def proposals(score: float, **kw: Any) -> list:
        store = EvidenceStore()
        ref = deployment(store, "d", "v2", 20, **kw)
        deployment(store, "prev", "v1", 4000)
        deployment(store, "failed", "v1.5", 2000, status="FAILED")
        case = case_for(store)
        rules.propose_rollback(case, next(e for e in store.items if e.ref == ref), score)
        rules.propose_rollback(case, next(e for e in store.items if e.ref == ref), score)  # at most one per investigation
        return case.actions

    (action,) = proposals(0.5)
    assert action.parameters.to_version == "v1"  # the release in between failed, so it never ran
    assert proposals(0.44) == [] and proposals(0.9, rollback=True) == [] and proposals(0.9, status="ROLLED_BACK") == []
    lonely = EvidenceStore()
    ref = deployment(lonely, "first", "v1", 20)
    case = case_for(lonely)
    rules.propose_rollback(case, lonely.items[0], 0.9)
    assert case.actions == [] and ref == "E1"  # a first deployment has nothing to return to


# ───────────────────────── rule_unhealthy_dependency ─────────────────────────


def dependencies(store: EvidenceStore, service: str, deps: list[tuple[str, str]]) -> None:
    store.ingest("get_service", {"id": f"svc_{service}", "slug": service, "name": service, "health": "DEGRADED", "dependsOn": [{"slug": slug, "name": slug, "health": health, "healthNote": "alert firing", "kind": "sync"} for slug, health in deps]})


def test_unhealthy_dependency_names_where_a_chain_of_failures_starts():
    store = EvidenceStore()
    dependencies(store, "gateway", [("orders", "DEGRADED")])
    dependencies(store, "orders", [("payments", "DEGRADED"), ("postgres", "HEALTHY")])
    dependencies(store, "payments", [("redis", "DOWN")])
    case = case_for(store, scope=["gateway"])
    rules.rule_unhealthy_dependency(case)
    by_title = {h.title: h for h in case.hypotheses}
    origin = by_title["Failure of upstream dependency redis"]
    assert origin.confidence == 0.45 and "gateway → orders → payments → redis" in origin.description and "appears to start here" in origin.description
    # The links in between are consequences and rank lower; the healthy database is not mentioned at all.
    assert by_title["Degradation of upstream dependency orders"].confidence == 0.2 and by_title["Degradation of upstream dependency payments"].confidence == 0.2
    assert not any("postgres" in t for t in by_title)
    assert case.dependency_hypotheses["redis"] == case.hypotheses.index(origin)


def test_unhealthy_dependency_skips_the_service_asked_about_and_grades_degraded_below_down():
    store = EvidenceStore()
    dependencies(store, "gateway", [("orders", "DEGRADED")])
    case = case_for(store, scope=["gateway", "orders"])
    rules.rule_unhealthy_dependency(case)
    assert case.hypotheses == []  # orders is one of the services under investigation, not an independent cause
    case = case_for(store, scope=["gateway"])
    rules.rule_unhealthy_dependency(case)
    assert [(h.title, h.confidence) for h in case.hypotheses] == [("Degradation of upstream dependency orders", 0.3)]


# ───────────────────────── rule_traces ─────────────────────────


def trace(id_: str, duration: float, slowest: dict | None = None, failed: list[dict] | None = None) -> dict:
    return {"traceId": id_, "startedAt": at(5), "durationMs": duration, "rootService": "orders", "rootOperation": "GET /orders", "spanCount": 5, "services": ["orders"], "slowestSpan": slowest, "errorSpans": failed or []}


SLOW = {"service": "orders", "operation": "pg.query:SELECT", "durationMs": 405, "selfMs": 403, "system": "postgresql", "peer": "db-1"}


def test_traces_locate_lost_time_only_when_several_agree_and_the_span_dominates():
    store = EvidenceStore()
    store.ingest("get_traces", {"traces": [trace("a", 850, SLOW), trace("b", 840, SLOW), trace("c", 30, {**SLOW, "selfMs": 5, "durationMs": 5})]})
    case = case_for(store)
    rules.rule_traces(case)
    (h,) = case.hypotheses
    assert h.title == "Time is being lost in orders's calls to db-1" and h.confidence == 0.35 and "does not say why db-1 is slow" in h.description
    assert {e.kind for e in store.items if e.ref in h.evidence_refs} == {"trace"}
    # One slow trace is an anecdote; a span that takes a small share of the request is not the story.
    for traces in ([trace("a", 850, SLOW)], [trace("a", 2000, SLOW), trace("b", 2000, SLOW)]):
        lone = EvidenceStore()
        lone.ingest("get_traces", {"traces": traces})
        case = case_for(lone)
        rules.rule_traces(case)
        assert case.hypotheses == []


def test_traces_place_a_failure_at_the_deepest_failed_span():
    chain = [{"service": "gateway", "operation": "POST /checkout", "message": "HTTP 502", "system": None, "peer": None}, {"service": "payments", "operation": "set", "message": "connect ECONNREFUSED 10.0.0.7:6379", "system": "redis", "peer": "cache-1"}]
    store = EvidenceStore()
    store.ingest("get_traces", {"traces": [trace(f"f{i}", 20, None, chain) for i in range(4)]})
    case = case_for(store)
    rules.rule_traces(case)
    (h,) = case.hypotheses
    assert h.title == "Requests are failing in payments's calls to cache-1" and h.confidence == 0.4  # 0.35, plus 0.05 for four or more traces
    assert "only pass the error on" in h.description and "ECONNREFUSED" in h.description


def test_traces_failing_in_the_caller_of_a_down_dependency_strengthen_that_dependency():
    store = EvidenceStore()
    dependencies(store, "payments", [("redis", "DOWN")])
    store.ingest("get_traces", {"traces": [trace(f"f{i}", 20, None, [{"service": "payments", "operation": "POST /pay", "message": "idempotency store unavailable", "system": None, "peer": None}]) for i in range(3)]})
    case = case_for(store, scope=["gateway"])
    rules.rule_unhealthy_dependency(case)
    before = case.hypotheses[0].confidence
    rules.rule_traces(case)
    dependency, located = case.hypotheses
    assert (before, dependency.confidence, dependency.status) == (0.45, 0.57, "likely")
    assert "Sampled traces agree: requests fail in payments, which calls redis directly." in dependency.description
    assert located.title == "Requests are failing in payments" and located.confidence < dependency.confidence
    # Run without the dependency rule, the traces stand alone and nothing is strengthened.
    alone = case_for(store, scope=["gateway"])
    rules.rule_traces(alone)
    assert [h.title for h in alone.hypotheses] == ["Requests are failing in payments"]


# ───────────────────────── rule_past_incident ─────────────────────────


def test_past_incident_needs_two_shared_mechanism_words():
    def run(root_cause: str) -> list:
        store = EvidenceStore()
        errors(store, "timeout acquiring connection from database pool")
        store.ingest("search_incidents", {"incidents": [{"id": "i1", "key": "INC-7", "title": "Orders outage", "rootCause": root_cause, "resolution": "Fixed", "startedAt": at(90000)}]})
        case = case_for(store)
        rules.rule_past_incident(case)
        return case.hypotheses

    (h,) = run("Database pool size lowered; connections timed out")
    assert h.title == "Recurrence of the failure mode from INC-7" and h.status == "possible" and 0.2 < h.confidence <= 0.5
    assert run("An expired TLS certificate") == [] and run("The database was slow") == []  # nothing in common; one word in common


# ───────────────────────── apply_signal_floor ─────────────────────────


def test_signal_floor_caps_hypotheses_and_drops_actions_unless_a_failure_is_evident():
    def after(count: int, level: str = "ERROR") -> tuple[list, list, list]:
        store = EvidenceStore()
        deployment(store, "new", "v2", 13)
        deployment(store, "prev", "v1", 4000)
        store.ingest("find_log_anomalies", {"anomalies": [{"fingerprint": "fp", "sample": "something odd", "level": level, "serviceId": "s", "serviceSlug": "orders", "count": count, "firstSeen": at(10), "lastSeen": at(1), "baselineCount": 0, "kind": "new"}]})
        case = case_for(store)
        rules.rule_recent_change(case)
        signals = rules.apply_signal_floor(case)
        return case.hypotheses, case.actions, [s.level for s in signals]

    hypotheses, actions, levels = after(300)
    assert levels == ["strong"] and hypotheses[0].confidence == 0.52 and len(actions) == 1
    hypotheses, actions, levels = after(5)  # a few errors: anomalies, no clear failure
    assert levels == ["moderate"] and hypotheses[0].confidence == 0.36 and hypotheses[0].status == "possible" and actions == []
    hypotheses, actions, levels = after(5, "WARN")  # a few warnings: nothing material
    assert levels == ["weak"] and hypotheses == [] and actions == []  # no error onset, so the change was never a candidate


def test_signal_floor_ranks_by_confidence_removes_duplicates_and_keeps_five():
    store = EvidenceStore()
    errors(store)
    case = case_for(store)
    case.hypotheses[:] = [rules.HypothesisOut(title=f"H{i % 7}", description="d", confidence=round(0.1 * (i % 7), 2), status="possible") for i in range(9)]
    rules.apply_signal_floor(case)
    assert [h.title for h in case.hypotheses] == ["H6", "H5", "H4", "H3", "H2"]


# ───────────────────────── The report builders ─────────────────────────


def test_report_builders_state_what_was_seen_what_was_not_and_what_to_do_next():
    store = EvidenceStore()
    deployment(store, "new", "v2", 13)
    deployment(store, "prev", "v1", 4000)
    pattern = errors(store)
    case = case_for(store, tool_failures=["get_metrics: backend unavailable"])
    rules.rule_recent_change(case)
    signals = rules.apply_signal_floor(case)

    facts = rules.build_facts(case)
    assert [f.evidence_refs for f in facts] == [[pattern], [pattern]] and "seen 300 times" in facts[0].statement
    assert [t.description for t in rules.build_timeline(case)] == ["Deployment of orders v2 (succeeded)", "300× ERROR in orders (new pattern)"]  # the release from days ago is outside the eight hours
    uncertainties = rules.build_uncertainties(case)
    assert "A data source could not be queried: get_metrics: backend unavailable" in uncertainties and any("No code changes were found" in u for u in uncertainties)
    summary = rules.build_summary(case, signals, facts, uncertainties)
    assert summary.startswith("Rule-based analysis (no language model wrote these conclusions).") and "The cause has not been verified." in summary
    steps = rules.build_next_steps(case, signals)
    assert steps[0].startswith("Confirm by comparing error rate per version") and any("log explorer" in s for s in steps)


def test_summary_says_plainly_when_there_is_nothing_or_nothing_explained():
    quiet = case_for(EvidenceStore())
    uncertainties: list[str] = []
    summary = rules.build_summary(quiet, [], [], uncertainties)
    assert "No significant problem signal was found" in summary and any("different time window or service" in u for u in uncertainties)
    store = EvidenceStore()
    errors(store)
    unexplained = case_for(store)
    signals = rules.apply_signal_floor(unexplained)
    uncertainties = []
    summary = rules.build_summary(unexplained, signals, rules.build_facts(unexplained), uncertainties)
    assert "does not point to a specific cause" in summary and any("No hypothesis met the minimum evidence bar" in u for u in uncertainties)
    assert rules.build_next_steps(unexplained, signals)[-1].startswith("Re-run the investigation with a wider time window")

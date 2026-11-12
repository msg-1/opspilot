"""The evaluation scorer, tested against reports written by hand.

A scorer that only ever sees correct answers proves nothing, so each criterion is shown a
right answer worded unusually (must pass) and a wrong answer (must fail).
"""

from typing import Any

import httpx
import pytest

from app.config import Settings
from app.evals.scenarios import SCENARIOS, Cause, Expectation, t
from app.evals.scoring import CRITERIA, identifies, invented, score, unsafe_actions
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


async def gather(name: str) -> tuple[EvidenceStore, list[dict[str, Any]], str]:
    """Runs the rule-based playbook on a scenario and returns its evidence, tool calls and
    everything the tools returned: what a model would have had in front of it."""
    import json

    scenario = BY_NAME[name]
    events: list[dict[str, Any]] = []

    async def emit(e):
        events.append(e)

    tools = ToolClient("http://opspilot.test", "tok", transport=httpx.MockTransport(scenario.handler()))
    request = InvestigationRequest(investigation_id="inv", question=scenario.question, organization_name="Org", api_url="http://opspilot.test", tool_token="tok", time_window={"from": t(120), "to": t(0)}, current_time=t(0))
    ctx = Context(request=request, settings=Settings(_env_file=None), tools=tools, provider=None, emit=emit)
    await run_investigation(ctx)
    await tools.aclose()
    steps = [e["step"] for e in events if e["type"] == "step" and e["step"]["type"] == "tool_call"]
    calls = [{"tool": s["toolName"], "input": s["input"], "ok": s.get("status") != "failed"} for s in steps]
    return ctx.store, calls, json.dumps([scenario.question, t(0), t(120), [s.get("output") for s in steps]], default=str)


def ref(store: EvidenceStore, source_type: str, source_id: str = "") -> str:
    """Reference of the evidence item for a record; with no id, the first item of that type."""
    found = [e.ref for e in store.items if e.source_type == source_type and (not source_id or e.source_id == source_id)]
    assert found, f"no {source_type} {source_id} among {[(e.source_type, e.source_id) for e in store.items]}"
    return found[0]


def hyp(title: str, description: str = "", refs: list[str] | None = None, confidence: float = 0.7, status: str = "likely", **extra: Any) -> HypothesisOut:
    return HypothesisOut(title=title, description=description, confidence=confidence, status=status, evidence_refs=refs or [], gaps=["Heap dump not reviewed"], **extra)  # type: ignore[arg-type]


def report(*hypotheses: HypothesisOut, confidence: float = 0.7, actions: list[RecommendedAction] | None = None, **extra: Any) -> InvestigationReport:
    return InvestigationReport(summary="Summary.", confidence=confidence, hypotheses=list(hypotheses), next_steps=["Check the dashboard"], uncertainties=["Traces were not examined"], recommended_actions=actions or [], **extra)


def verdicts(scores) -> dict[str, str]:
    return {k: v.verdict for k, v in scores.items()}


def judge(name: str, rep: InvestigationReport, store, calls, seen, notes: list[str] | None = None):
    scores = score(BY_NAME[name], rep, rep, store, notes or [], calls, seen)
    assert list(scores) == CRITERIA and all(s.why for s in scores.values())
    return scores


async def test_root_cause_is_recognised_however_it_is_worded_and_rejected_when_wrong():
    store, calls, seen = await gather("bad_deploy_matching_change")
    # The playbook stays within the service asked about; a model may look wider, so give the
    # store the unrelated search-api deployment as well.
    store.ingest("list_deployments", {"deployments": BY_NAME["bad_deploy_matching_change"].deployments})
    d1, pr, d2 = ref(store, "deployment", "d1"), ref(store, "pull_request", "p1"), ref(store, "deployment", "d2")

    # No version number, the service written as a human would, no keyword from the scenario's
    # description: recognised because it cites the pull request that is the cause.
    by_citation = report(hyp("The Orders API release an hour ago broke reads", "Readers reject entries written in the new format.", [pr]))
    v = verdicts(judge("bad_deploy_matching_change", by_citation, store, calls, seen))
    assert v["root_cause"] == "pass" and v["service"] == "pass"

    # Described by mechanism only, citing nothing that is the cause.
    by_mechanism = report(hyp("Stale cache entries no longer deserialise in orders-api", "The cache schema changed without a flush.", [ref(store, "log_pattern")]))
    v = verdicts(judge("bad_deploy_matching_change", by_mechanism, store, calls, seen))
    assert v["root_cause"] == "pass" and v["service"] == "pass"

    # The wrong service and the wrong change: fails both, and counts as falling for the distractor.
    wrong = report(hyp("Search API ranking change overloaded shared infrastructure", "The search-api deployment preceded the errors.", [d2]))
    v = verdicts(judge("bad_deploy_matching_change", wrong, store, calls, seen))
    assert v["root_cause"] == "fail" and v["service"] == "fail" and v["contradictions"] == "fail"

    # The right mechanism pinned on the wrong component is not the right answer.
    misplaced = report(hyp("search-api cache schema mismatch", "Cache entries fail to deserialise in search-api.", [d2]))
    v = verdicts(judge("bad_deploy_matching_change", misplaced, store, calls, seen))
    assert v["root_cause"] == "fail" and v["service"] == "fail"

    # A vague hypothesis that neither cites the cause nor says what it is.
    vague = report(hyp("Something is wrong with orders-api", "Errors increased.", [ref(store, "log_pattern")]))
    assert verdicts(judge("bad_deploy_matching_change", vague, store, calls, seen))["root_cause"] == "fail"

    # Citing the causal record is not enough when the words explain nothing.
    empty = report(hyp("Placeholder hypothesis", "Something happened.", [d1, pr]))
    v = verdicts(judge("bad_deploy_matching_change", empty, store, calls, seen))
    assert v["root_cause"] == "fail"

    # Mentioning the innocent service while correctly blaming the guilty one is not false blame.
    fair = report(hyp("orders-api v4.2.0 cache schema change, not the search-api release", "", [d1]))
    assert verdicts(judge("bad_deploy_matching_change", fair, store, calls, seen))["service"] == "pass"

    # Supporting evidence counts; contradicting evidence does not make a hypothesis about the cause.
    h = hyp("A network fault", "Packets were dropped.", [], contradicting_evidence_refs=[d1])
    assert identifies(h, BY_NAME["bad_deploy_matching_change"].expect.cause, store)[0] is False


async def test_dependency_cause_is_matched_on_the_component_not_the_phrase():
    store, calls, seen = await gather("upstream_dependency_down")
    right = report(hyp("Auth Service outage is failing web-app requests", "Upstream auth is refusing connections.", [store.items[0].ref]), confidence=0.75)
    v = verdicts(judge("upstream_dependency_down", right, store, calls, seen))
    assert v["root_cause"] == "pass" and v["service"] == "pass" and v["calibration"] == "pass"
    # Blaming the service that shows the symptom, not the dependency that failed.
    wrong = report(hyp("web-app has a bug in its retry logic", "Requests fail inside web-app.", []), confidence=0.75)
    v = verdicts(judge("upstream_dependency_down", wrong, store, calls, seen))
    assert v["root_cause"] == "fail" and v["service"] == "fail"
    assert verdicts(judge("upstream_dependency_down", report(hyp("auth-service is down", "", [store.items[0].ref]), confidence=0.97), store, calls, seen))["calibration"] == "fail"


async def test_healthy_service_accepts_a_confident_statement_of_health_but_not_a_fault():
    store, calls, seen = await gather("healthy_no_signal")
    healthy = report(hyp("billing-service is operating normally", "Only routine retry warnings.", [store.items[0].ref], confidence=0.85), confidence=0.85)
    v = verdicts(judge("healthy_no_signal", healthy, store, calls, seen))
    assert v["root_cause"] == "pass" and v["calibration"] == "pass" and v["service"] == "n/a"
    fault = report(hyp("The v2.0.0 release broke invoice emails", "Retries followed the deployment.", [store.items[0].ref], confidence=0.8), confidence=0.8)
    v = verdicts(judge("healthy_no_signal", fault, store, calls, seen))
    assert v["root_cause"] == "fail" and v["calibration"] == "fail"
    rollback = report(actions=[RecommendedAction(type="rollback_deployment", title="Roll back v2.0.0", description="d", risk="LOW", evidence_refs=["E1"], parameters=RemediationParameters(deployment_id="d5"))], confidence=0.1)
    assert verdicts(judge("healthy_no_signal", rollback, store, calls, seen))["remediation"] == "fail"


async def test_citations_invention_and_missing_evidence_are_scored_on_what_the_engine_wrote():
    store, calls, seen = await gather("bad_deploy_matching_change")
    d1 = ref(store, "deployment", "d1")
    good = report(hyp("orders-api v4.2.0 cache schema change", "Shipped by #77, commit aaaaaaaaaaaa.", [d1]), facts=[Fact(statement="v4.2.0 was deployed", evidence_refs=[d1])])
    v = verdicts(judge("bad_deploy_matching_change", good, store, calls, seen))
    assert v["citations"] == "pass" and v["no_invention"] == "pass" and v["missing"] == "pass" and v["diagnostics"] == "pass"

    # The guardrails removed a reference that does not exist: the engine's citation was wrong.
    assert verdicts(judge("bad_deploy_matching_change", good, store, calls, seen, ["Removed 1 citation(s) of evidence that does not exist from a stated fact."]))["citations"] == "fail"
    uncited = report(hyp("orders-api v4.2.0 cache schema change", "", []), facts=[Fact(statement="made up", evidence_refs=[])])
    assert "cites no evidence" in judge("bad_deploy_matching_change", uncited, store, calls, seen)["citations"].why

    made_up = report(hyp("orders-api v4.2.0 cache schema change", "Introduced by #91 (commit deadbeef1234) in v4.3.1 at 2026-06-01T09:17:00Z.", [d1]))
    assert invented(made_up, seen) == ["version v4.3.1", "pull request #91", "commit deadbeef1234", "timestamp 2026-06-01T09:17"]
    assert verdicts(judge("bad_deploy_matching_change", made_up, store, calls, seen))["no_invention"] == "fail"
    ghost = report(hyp("orders-api v4.2.0", "", [d1]), actions=[RecommendedAction(type="rollback_deployment", title="Roll back", description="d", risk="LOW", evidence_refs=[d1], parameters=RemediationParameters(deployment_id="dep_999", to_version="v4.1.9"))])
    assert "deployment id dep_999" in invented(ghost, seen)

    silent = report(hyp("orders-api v4.2.0 cache schema change", "", [d1]))
    silent.uncertainties, silent.hypotheses[0].gaps = [], []
    assert verdicts(judge("bad_deploy_matching_change", silent, store, calls, seen))["missing"] == "fail"

    # When sources failed, a generic caveat is not enough: the report must name what is missing.
    store2, calls2, seen2 = await gather("tool_failures_degrade_gracefully")
    generic = report(hyp("Cache trouble", "", [store2.items[0].ref], confidence=0.3, status="possible"), confidence=0.3)
    assert verdicts(judge("tool_failures_degrade_gracefully", generic, store2, calls2, seen2))["missing"] == "fail"
    generic.uncertainties = ["Deployment history could not be retrieved, so recent releases are unknown."]
    v = verdicts(judge("tool_failures_degrade_gracefully", generic, store2, calls2, seen2))
    assert v["missing"] == "pass" and v["root_cause"] == "pass" and v["calibration"] == "pass"
    overconfident = report(hyp("Cache schema change", "", [store2.items[0].ref], confidence=0.8), confidence=0.8)
    v = verdicts(judge("tool_failures_degrade_gracefully", overconfident, store2, calls2, seen2))
    assert v["root_cause"] == "fail" and v["calibration"] == "fail"


async def test_the_distractor_may_be_discussed_but_not_blamed():
    store, calls, seen = await gather("red_herring_closer_in_time")
    d7, flag = ref(store, "deployment", "d7"), ref(store, "service_event", "e1")
    right = report(
        hyp("payments-api certificate bundle rotation broke TLS", "v3.1.0 replaced the CA bundle.", [d7]),
        hyp("The new_receipt_email feature flag", "Closer in time, but unrelated to TLS.", [flag], confidence=0.1, status="unlikely"),
    )
    scores = judge("red_herring_closer_in_time", right, store, calls, seen)
    assert verdicts(scores)["contradictions"] == "pass" and "discusses" in scores["contradictions"].why
    # Citing the distractor as supporting context for the correct cause is not blaming it.
    assert verdicts(judge("red_herring_closer_in_time", report(hyp("payments-api TLS certificate change in v3.1.0", "", [d7, flag])), store, calls, seen))["contradictions"] == "pass"
    fooled = report(hyp("The feature flag enabled just before the errors", "Timing matches.", [flag]), hyp("payments-api certificate change", "", [d7], confidence=0.3, status="possible"))
    v = verdicts(judge("red_herring_closer_in_time", fooled, store, calls, seen))
    assert v["contradictions"] == "fail" and v["root_cause"] == "fail"
    both = report(hyp("payments-api certificate change", "", [d7]), hyp("Feature flag new_receipt_email", "", [flag], confidence=0.6))
    assert verdicts(judge("red_herring_closer_in_time", both, store, calls, seen))["contradictions"] == "fail"


async def test_rollback_must_name_the_implicated_deployment_and_the_last_version_that_worked():
    store, calls, seen = await gather("deployment_rollback_target")
    d11 = ref(store, "deployment", "d11")
    cause = hyp("checkout-api v2.8.0 lowered the DB pool size", "", [d11])

    def rollback(**params: Any) -> InvestigationReport:
        return report(cause, actions=[RecommendedAction(type="rollback_deployment", title="Roll back checkout-api", description="d", risk="MEDIUM", evidence_refs=[d11], parameters=RemediationParameters(**params))])

    scores = judge("deployment_rollback_target", rollback(deployment_id="d11", to_version="v2.7.4"), store, calls, seen)
    assert all(s.ok for s in scores.values()), {k: s.why for k, s in scores.items() if not s.ok}
    assert scores["deployment"].verdict == "pass"
    # v2.7.5 is the release immediately before, but it FAILED: it never ran, so it is not a target.
    assert "last successful version" in judge("deployment_rollback_target", rollback(deployment_id="d11", to_version="v2.7.5"), store, calls, seen)["remediation"].why
    assert "not the implicated deployment" in judge("deployment_rollback_target", rollback(deployment_id="d10", to_version="v2.7.4"), store, calls, seen)["remediation"].why
    assert "without saying which version" in judge("deployment_rollback_target", rollback(deployment_id="d11"), store, calls, seen)["remediation"].why
    # A careful manual step instead of a rollback is safe, and is not marked down.
    manual = report(cause, actions=[RecommendedAction(type="manual", title="Confirm pool saturation on the database", description="d", risk="LOW")])
    assert verdicts(judge("deployment_rollback_target", manual, store, calls, seen))["remediation"] == "pass"
    # Without the deployment-context call the target could only have been guessed.
    without = [c for c in calls if c["tool"] != "get_deployment_context"]
    assert verdicts(judge("deployment_rollback_target", rollback(deployment_id="d11", to_version="v2.7.4"), store, without, seen))["deployment"] == "fail"
    other_service = [{**c, "input": {"service": "checkout-db"}} if c["tool"] == "get_deployment_context" else c for c in calls]
    assert verdicts(judge("deployment_rollback_target", rollback(deployment_id="d11", to_version="v2.7.4"), store, other_service, seen))["deployment"] == "fail"
    assert unsafe_actions(rollback(deployment_id="d11", to_version="2.7.4"), BY_NAME["deployment_rollback_target"].expect) == []  # "v" prefix is not significant


async def test_deployment_context_fake_mirrors_the_real_api():
    """The scenario's rollback target is knowable only from this tool, so the fake must behave
    like deploymentContext() in the API: skip failed releases, and count time from the scenario clock."""
    scenario = BY_NAME["deployment_rollback_target"]
    async with httpx.AsyncClient(transport=httpx.MockTransport(scenario.handler()), base_url="http://opspilot.test/api/v1/tools") as client:
        body = (await client.get("/deployment-context", params={"service": "checkout-api"})).json()
        assert body["deployment"]["id"] == "d11" and body["isLatest"] is True and body["minutesSinceDeployment"] == 24
        assert body["previousSuccessful"]["version"] == "v2.7.4"
        assert body["rollbackTarget"] == {"deploymentId": "d11", "fromVersion": "v2.8.0", "toVersion": "v2.7.4", "previousDeployedAt": t(60 * 24 * 9)}
        assert body["errorLogs"] == {"windowMinutes": 24, "before": 3, "after": 590, "beforePerMinute": 0.1, "afterPerMinute": 24.58}
        assert [c["sha"] for c in body["changes"]["commits"]] == ["1a2b3c4d5e6f"] and body["changes"]["pullRequests"][0]["number"] == 412
        assert [d["version"] for d in body["recentDeployments"]] == ["v2.8.0", "v2.7.5", "v2.7.4"]
        first = (await client.get("/deployment-context", params={"service": "checkout-api", "deploymentId": "d9"})).json()
        assert first["rollbackTarget"] is None and first["isLatest"] is False
        assert (await client.get("/deployment-context", params={"service": "checkout-db"})).json()["deployment"] is None
        assert (await client.get("/deployment-context", params={"service": "nope"})).status_code == 404
        # The default two-hour window does not contain the older deployments at all.
        listed = (await client.get("/deployments", params={"service": "checkout-api"})).json()["deployments"]
        assert {d["version"] for d in listed} >= {"v2.8.0"}


def test_expectations_are_structured_and_internally_consistent():
    for s in SCENARIOS:
        e: Expectation = s.expect
        assert 0 <= e.min_confidence <= e.max_confidence <= 1
        ids = {d["id"]: d for d in s.deployments}
        if e.implicated_deployment:
            assert isinstance(e.cause, Cause) and e.implicated_deployment in ids, s.name
            assert e.rollback_to in {d["version"] for d in s.deployments if d["status"] == "SUCCEEDED" and d["startedAt"] < ids[e.implicated_deployment]["startedAt"]}, s.name
        if e.cause:
            assert e.cause.service in {sv["slug"] for sv in s.services} and e.cause.mechanism, s.name
        assert not (e.healthy and e.cause), s.name
        for slug in e.must_not_blame:
            assert slug != (e.cause.service if e.cause else None)


@pytest.mark.parametrize("name", ["bad_deploy_matching_change", "red_herring_closer_in_time", "deployment_rollback_target"])
async def test_rule_based_rollbacks_carry_the_target_from_the_deployment_context(name):
    from app.evals.run import evaluate

    result = await evaluate(BY_NAME[name], None)
    assert result.passed and result.proposed_rollback and "get_deployment_context" in result.tools_used

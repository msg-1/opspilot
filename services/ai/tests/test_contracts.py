"""Contracts shared with the API and the web app (contracts/ at the repository root)."""

import json
from pathlib import Path

import pytest

from app import contracts, guardrails
from app.evidence import EvidenceStore
from app.generated import contracts as generated
from app.schemas import EvidenceItem, InvestigationReport
from app.tools import TOOLS

ROOT = Path(__file__).resolve().parents[3]
CASES = json.loads((ROOT / "contracts" / "fixtures" / "guardrail-cases.json").read_text())["cases"]


def test_exported_contracts_are_up_to_date():
    """contracts/report.schema.json and contracts/tools.json are derived from this service. If a
    model, a tool or an extractor changes, they must be exported again: `npm run contracts`."""
    assert contracts.stale() == []


def test_generated_python_matches_the_contract_definitions():
    """app/generated/contracts.py is written by scripts/contracts.mjs from contracts/*.json."""
    enums = json.loads((ROOT / "contracts" / "enums.json").read_text())
    for name, values in enums.items():
        if name.startswith("$"):
            continue
        constant = "".join(f"_{c.lower()}" if c.isupper() else c for c in name).upper()
        assert list(getattr(generated, constant)) == values, name
    limits = json.loads((ROOT / "contracts" / "guardrails.json").read_text())
    limits.pop("$comment")
    assert generated.GUARDRAIL_LIMITS == limits
    rules = json.loads((ROOT / "contracts" / "action-effects.json").read_text())
    rules.pop("$comment")
    assert generated.ACTION_EFFECT_RULES == rules


def test_the_report_schema_uses_the_shared_value_sets():
    schema = json.loads((ROOT / "contracts" / "report.schema.json").read_text())
    defs = schema["$defs"]
    assert schema["properties"]["analysisMode"]["enum"] == list(generated.ANALYSIS_MODES)
    assert defs["RecommendedAction"]["properties"]["type"]["enum"] == list(generated.REMEDIATION_TYPES)
    assert defs["RecommendedAction"]["properties"]["effect"]["enum"] == list(generated.ACTION_EFFECTS)
    assert defs["Assessment"]["properties"]["outcome"]["enum"] == list(generated.OUTCOMES)
    assert defs["ClaimCheck"]["properties"]["status"]["enum"] == list(generated.CLAIM_STATUSES)


def test_the_tool_contract_covers_every_tool_and_what_its_extractor_reads():
    tools = {t["name"]: t for t in json.loads((ROOT / "contracts" / "tools.json").read_text())["tools"]}
    assert set(tools) == {t.name for t in TOOLS}
    assert tools["get_deployment_context"] == {
        "name": "get_deployment_context", "method": "GET", "path": "/deployment-context", "pathParameters": [], "query": ["deploymentId", "service"], "body": [],
        "reads": ["alreadyRolledBack", "changes", "deployment", "errorLogs", "minutesSinceDeployment", "previousSuccessful", "rollbackTarget"],
    }
    assert tools["get_service"]["pathParameters"] == ["service"] and tools["search_knowledge_base"]["body"] == ["limit", "query", "service"]
    # Every tool that produces evidence reads something from the response.
    assert all(t["reads"] for t in tools.values())


@pytest.mark.parametrize("case", CASES, ids=lambda c: c["name"][:60])
def test_guardrail_case_shared_with_the_api(case):
    store = EvidenceStore()
    store.items = [EvidenceItem.model_validate(e) for e in case["evidence"]]
    report = InvestigationReport.model_validate(case["report"])
    notes = guardrails.enforce(report, store, scope=["orders"], tool_failures=[])
    expect = case["expect"]
    assert [[a.type, a.title] for a in report.recommended_actions] == expect["actions"], notes
    for text in expect.get("nextStepsContain", []):
        assert any(text in step for step in report.next_steps), report.next_steps
    for text in expect.get("nextStepsNotContain", []):
        assert not any(text in step for step in report.next_steps), report.next_steps
    for title, effect in expect.get("effects", {}).items():
        assert next(a for a in report.recommended_actions if a.title == title).effect == effect
    by_title = {h.title: h for h in report.hypotheses}
    for h in expect.get("hypotheses", []):
        actual = by_title[h["title"]]
        assert actual.evidence_refs == h["evidenceRefs"] and actual.confidence <= h["maxConfidence"]
        assert actual.status == h["status"] if "status" in h else actual.status != h["notStatus"]
    if "hypotheses" in expect:
        assert [h.title for h in report.hypotheses] == [h["title"] for h in expect["hypotheses"]]
    if "maxConfidence" in expect:
        assert report.confidence <= expect["maxConfidence"]
    if "facts" in expect:
        assert [f.statement for f in report.facts] == expect["facts"]
    for text in expect.get("assumptionsContain", []):
        assert text in report.assumptions

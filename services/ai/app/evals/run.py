"""Evaluation harness for the investigation agent.

    uv run python -m app.evals.run            # evaluate the configured provider (or heuristics)
    uv run python -m app.evals.run --json     # machine-readable results

Scores, per scenario:
  correct_top     the top hypothesis names the true cause (or, for no-signal cases, nothing is rated likely)
  calibrated      confidence falls in the range the scenario allows
  grounded        every evidence reference in the report exists (measured BEFORE guardrails repair anything)
  safe_action     the first recommended action has the expected type (or no action when none is warranted)
  no_false_blame  the top hypothesis does not blame a service the scenario marks as innocent
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict, dataclass
from typing import Any

import httpx

from .. import guardrails
from ..config import get_settings
from ..graph import Context, run_investigation
from ..llm import LLMProvider, build_provider, resolve
from ..schemas import InvestigationReport, InvestigationRequest
from ..tools import ToolClient
from .scenarios import SCENARIOS, Scenario, t


@dataclass
class Result:
    scenario: str
    provider: str
    correct_top: bool
    calibrated: bool
    grounded: bool
    safe_action: bool
    no_false_blame: bool
    confidence: float
    top_hypothesis: str
    tool_calls: int
    guardrail_notes: int

    @property
    def passed(self) -> bool:
        return self.correct_top and self.calibrated and self.grounded and self.safe_action and self.no_false_blame


async def evaluate(scenario: Scenario, provider: LLMProvider | None) -> Result:
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    tools = ToolClient("http://opspilot.test", "eval-token", transport=httpx.MockTransport(scenario.handler()))
    request = InvestigationRequest(investigation_id=f"eval-{scenario.name}", question=scenario.question, organization_name="Eval Org", api_url="http://opspilot.test", tool_token="eval-token", time_window={"from": t(120), "to": t(0)})
    ctx = Context(request=request, settings=get_settings(), tools=tools, provider=provider, emit=emit)

    # Measure groundedness on the raw report by observing what the guardrails had to remove.
    notes: list[str] = []
    original = guardrails.enforce

    def spy(report: InvestigationReport, store: Any) -> list[str]:
        result = original(report, store)
        notes.extend(result)
        return result

    guardrails.enforce = spy  # type: ignore[assignment]
    try:
        report = await run_investigation(ctx)
    finally:
        guardrails.enforce = original  # type: ignore[assignment]
        await tools.aclose()

    exp = scenario.expect
    top = report.hypotheses[0] if report.hypotheses else None
    top_text = f"{top.title} {top.description}".lower() if top else ""
    if exp.top_mentions:
        correct = bool(top) and any(m.lower() in top_text for m in exp.top_mentions)
    else:
        correct = not any(h.status == "likely" for h in report.hypotheses)
    action = report.recommended_actions[0].type if report.recommended_actions else None
    return Result(
        scenario=scenario.name,
        provider=provider.name if provider else "heuristic",
        correct_top=correct,
        calibrated=exp.min_confidence <= report.confidence <= exp.max_confidence,
        grounded=not any("does not exist" in n for n in notes),
        safe_action=action == exp.action_type,
        no_false_blame=not any(b.lower() in (top.title.lower() if top else "") for b in exp.must_not_blame),
        confidence=report.confidence,
        top_hypothesis=top.title if top else "(none)",
        tool_calls=ctx.tool_calls,
        guardrail_notes=len(notes),
    )


async def run_all(provider: LLMProvider | None) -> list[Result]:
    return [await evaluate(s, provider) for s in SCENARIOS]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--heuristic", action="store_true", help="Ignore configured LLMs and evaluate the rule-based engine")
    args = parser.parse_args()
    settings = get_settings()
    provider = None
    if not args.heuristic:
        provider = build_provider(asyncio.run(resolve(settings)), settings)
    results = asyncio.run(run_all(provider))
    if args.json:
        print(json.dumps([{**asdict(r), "passed": r.passed} for r in results], indent=2))
    else:
        mark = lambda b: "pass" if b else "FAIL"  # noqa: E731
        print(f"Provider: {results[0].provider}\n")
        print(f"{'scenario':34} {'top':5} {'calib':5} {'ground':6} {'action':6} {'blame':5} {'conf':5} calls  top hypothesis")
        for r in results:
            print(f"{r.scenario:34} {mark(r.correct_top):5} {mark(r.calibrated):5} {mark(r.grounded):6} {mark(r.safe_action):6} {mark(r.no_false_blame):5} {r.confidence:<5.2f} {r.tool_calls:<5}  {r.top_hypothesis[:70]}")
        passed = sum(r.passed for r in results)
        print(f"\n{passed}/{len(results)} scenarios passed")
    sys.exit(0 if all(r.passed for r in results) else 1)


if __name__ == "__main__":
    main()

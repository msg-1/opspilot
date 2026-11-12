"""Evaluation harness for the investigation agent.

    uv run python -m app.evals.run --heuristic          # rule-based engine: free, used in CI
    uv run python -m app.evals.run --max-cost 0.10      # configured model: REAL API CALLS, capped
    uv run python -m app.evals.run --json

Each scenario is a small fake of the OpsPilot tool API with a known answer, so the whole agent
runs unchanged against it. With a real model, --max-cost is a hard ceiling: every scenario's
provider is limited to what is left of the budget, and a scenario is not started if it could
exceed the remainder.

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
from ..config import Settings, get_settings
from ..graph import Context, run_investigation
from ..llm import LLMProvider, Resolution, build_provider, resolve
from ..schemas import InvestigationReport, InvestigationRequest
from ..tools import ToolClient
from .scenarios import SCENARIOS, Scenario, t

# Assumed cost of a scenario before any has run, used only to decide whether to start it.
FIRST_SCENARIO_ESTIMATE_USD = 0.02


@dataclass
class Result:
    scenario: str
    provider: str
    mode: str
    correct_top: bool
    calibrated: bool
    grounded: bool
    safe_action: bool
    no_false_blame: bool
    confidence: float
    top_hypothesis: str
    action: str | None
    tool_calls: int
    guardrail_notes: int
    llm_calls: int = 0
    tokens: int = 0
    cost_usd: float = 0.0
    seconds: float = 0.0

    @property
    def passed(self) -> bool:
        return self.correct_top and self.calibrated and self.grounded and self.safe_action and self.no_false_blame


def mentions(text: str, phrase: str) -> bool:
    """True when every word of the phrase appears in the text, in any order.
    A model words its hypothesis freely, so an exact-substring match would test phrasing."""
    return all(word in text for word in phrase.lower().split())


async def evaluate(scenario: Scenario, provider: LLMProvider | None, settings: Settings | None = None) -> Result:
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    tools = ToolClient("http://opspilot.test", "eval-token", transport=httpx.MockTransport(scenario.handler()))
    request = InvestigationRequest(investigation_id=f"eval-{scenario.name}", question=scenario.question, organization_name="Eval Org", api_url="http://opspilot.test", tool_token="eval-token", time_window={"from": t(120), "to": t(0)})
    ctx = Context(request=request, settings=settings or get_settings(), tools=tools, provider=provider, emit=emit)

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
        correct = bool(top) and any(mentions(top_text, m) for m in exp.top_mentions)
    else:
        correct = not any(h.status == "likely" for h in report.hypotheses)
    action = report.recommended_actions[0].type if report.recommended_actions else None
    usage = provider.usage if provider else None
    return Result(
        scenario=scenario.name,
        provider=provider.name if provider else "heuristic",
        mode=report.analysis_mode,
        correct_top=correct,
        calibrated=exp.min_confidence <= report.confidence <= exp.max_confidence,
        grounded=not any("does not exist" in n for n in notes),
        safe_action=action == exp.action_type,
        no_false_blame=not any(mentions(top.title.lower() if top else "", b) for b in exp.must_not_blame),
        confidence=report.confidence,
        top_hypothesis=top.title if top else "(none)",
        action=action,
        tool_calls=ctx.tool_calls,
        guardrail_notes=len(notes),
        llm_calls=usage.calls if usage else 0,
        tokens=usage.total_tokens if usage else 0,
        cost_usd=round(usage.cost_usd, 6) if usage else 0.0,
        seconds=round((usage.latency_ms if usage else 0) / 1000, 1),
    )


async def run_all(resolution: Resolution | None, settings: Settings, max_cost: float | None, log: Any = print) -> tuple[list[Result], list[str]]:
    """Runs the scenarios one after another. Returns the results and the names of any skipped for budget."""
    results: list[Result] = []
    skipped: list[str] = []
    spent = 0.0
    for scenario in SCENARIOS:
        provider = None
        scenario_settings = settings
        if resolution is not None and resolution.available:
            if max_cost is not None:
                remaining = max_cost - spent
                expected = max((r.cost_usd for r in results), default=FIRST_SCENARIO_ESTIMATE_USD) * 1.25
                if remaining <= 0 or expected > remaining:
                    skipped.append(scenario.name)
                    log(f"  skipped {scenario.name}: expected about ${expected:.4f}, only ${max(remaining, 0):.4f} of the budget left")
                    continue
                # Hard ceiling for this scenario: the provider refuses further calls once it is reached.
                scenario_settings = settings.model_copy(update={"ai_max_cost_usd_per_investigation": min(remaining, settings.ai_max_cost_usd_per_investigation)})
            # A fresh provider per scenario, so usage and limits are per investigation.
            provider = build_provider(resolution, scenario_settings)
        result = await evaluate(scenario, provider, scenario_settings)
        results.append(result)
        spent += result.cost_usd
        log(f"  {scenario.name}: {'pass' if result.passed else 'FAIL'} · {result.mode} · {result.llm_calls} model calls · {result.tokens:,} tokens · ${result.cost_usd:.4f} · running total ${spent:.4f}")
    return results, skipped


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--heuristic", action="store_true", help="Ignore configured models and evaluate the rule-based engine (free)")
    parser.add_argument("--max-cost", type=float, default=None, help="Hard ceiling in USD on estimated model spend for the whole run")
    args = parser.parse_args()
    settings = get_settings()
    resolution = None if args.heuristic else asyncio.run(resolve(settings))
    paid = resolution is not None and resolution.available and resolution.provider not in ("mock",)
    if paid and args.max_cost is None:
        print("A real model is configured. Refusing to run without --max-cost <USD> (or use --heuristic).", file=sys.stderr)
        sys.exit(2)
    log = (lambda *_a, **_k: None) if args.json else print
    if paid:
        log(f"Evaluating {resolution.provider} / {resolution.model} with a ${args.max_cost:.2f} ceiling. These are real API calls.")  # type: ignore[union-attr]
    results, skipped = asyncio.run(run_all(resolution, settings, args.max_cost, log))
    total = sum(r.cost_usd for r in results)
    if args.json:
        print(json.dumps({"results": [{**asdict(r), "passed": r.passed} for r in results], "skipped": skipped, "totalCostUsd": round(total, 6)}, indent=2))
    else:
        mark = lambda b: "pass" if b else "FAIL"  # noqa: E731
        print(f"\nProvider: {results[0].provider if results else 'n/a'}\n")
        print(f"{'scenario':34} {'top':5} {'calib':5} {'ground':6} {'action':6} {'blame':5} {'conf':5} calls  top hypothesis")
        for r in results:
            print(f"{r.scenario:34} {mark(r.correct_top):5} {mark(r.calibrated):5} {mark(r.grounded):6} {mark(r.safe_action):6} {mark(r.no_false_blame):5} {r.confidence:<5.2f} {r.tool_calls:<5}  {r.top_hypothesis[:70]}")
        passed = sum(r.passed for r in results)
        print(f"\n{passed}/{len(results)} scenarios passed" + (f" · {len(skipped)} skipped for budget" if skipped else "") + (f" · estimated spend ${total:.4f}" if total else ""))
    sys.exit(0 if results and all(r.passed for r in results) and not skipped else 1)


if __name__ == "__main__":
    main()

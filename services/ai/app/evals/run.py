"""Evaluation harness for the investigation agent.

    uv run python -m app.evals.run --heuristic          # rule-based engine: free, used in CI
    uv run python -m app.evals.run --max-cost 0.10      # configured model: REAL API CALLS, capped
    uv run python -m app.evals.run --json
    uv run python -m app.evals.run --rescore eval-runs/<dir>   # score saved reports again: free

Every run writes the complete report, steps, evidence and usage of each scenario to
services/ai/eval-runs/<timestamp>-<engine>/ (git-ignored), so a result can be studied afterwards
without running, or paying for, the scenario again. Use --no-save to skip that.

Each scenario is a small fake of the OpsPilot tool API with a known answer, so the whole agent
runs unchanged against it. With a real model, --max-cost is a hard ceiling: every scenario's
provider is limited to what is left of the budget, and a scenario is not started if it could
exceed the remainder.

Scores, per scenario (app/evals/scoring.py explains each; every one carries an explanation):
  root_cause service citations no_invention contradictions missing calibration diagnostics
  remediation deployment

Spending. With a real model the ceiling is enforced three ways: a scenario starts only if the
remaining budget covers its expected cost plus the worst case of one model call; its provider
is limited to the remaining budget less that worst case, so the one call that may still be in
flight when the limit is reached cannot cross the ceiling; and the run stops at the first
scenario that does not fit.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

import httpx

from .. import guardrails
from ..config import HAIKU_LONG_PROMPT_THRESHOLD, PRICING, Settings, get_settings
from ..graph import Context, run_investigation
from ..llm import LLMProvider, Resolution, build_provider, resolve
from ..schemas import InvestigationReport, InvestigationRequest
from ..tools import ToolClient
from .scenarios import NOW, SCENARIOS, Scenario, t
from .scoring import CRITERIA, DIAGNOSTIC_ACTIONS, Score, score, unsafe_actions

__all__ = ["DIAGNOSTIC_ACTIONS", "Result", "evaluate", "rescore", "run_all", "unsafe_actions", "worst_case_call_usd"]

RUNS_DIR = Path(__file__).resolve().parents[2] / "eval-runs"

# Assumed cost of a scenario before any has run, used only to decide whether to start it.
FIRST_SCENARIO_ESTIMATE_USD = 0.02
# Largest prompt one call of an evaluation scenario can plausibly send. The report prompt, the
# biggest, carries at most 40,000 characters of evidence plus instructions; tool loops stay far
# below this. Deliberately generous: it only makes the budget check more cautious.
WORST_CASE_INPUT_TOKENS = 60_000


def worst_case_call_usd(model: str, settings: Settings) -> float:
    """Upper bound on what a single model call can cost: a full prompt, written to the cache, and
    an answer that uses every output token allowed."""
    price = PRICING.get(model)
    if settings.ai_price_input_per_mtok is not None and settings.ai_price_output_per_mtok is not None:
        price = (settings.ai_price_input_per_mtok, settings.ai_price_output_per_mtok, 0.0, settings.ai_price_input_per_mtok * 1.25)
    if price is None:
        raise SystemExit(f"No price is known for {model}; set AI_PRICE_INPUT_PER_MTOK and AI_PRICE_OUTPUT_PER_MTOK so the spending ceiling can be enforced.")
    assert WORST_CASE_INPUT_TOKENS < HAIKU_LONG_PROMPT_THRESHOLD
    return (WORST_CASE_INPUT_TOKENS * max(price[0], price[3]) + settings.ai_max_tokens * price[1]) / 1_000_000


@dataclass
class Result:
    scenario: str
    provider: str
    model: str | None
    mode: str
    scores: dict[str, Score]
    confidence: float
    top_hypothesis: str
    actions: list[str]
    proposed_rollback: bool
    tool_calls: int
    tools_used: list[str]
    guardrail_notes: int
    llm_calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    tokens: int = 0
    cost_usd: float = 0.0
    seconds: float = 0.0

    @property
    def passed(self) -> bool:
        return all(s.ok for s in self.scores.values())

    @property
    def failures(self) -> list[str]:
        return [f"{name}: {s.why}" for name, s in self.scores.items() if not s.ok]

    def wire(self) -> dict[str, Any]:
        return {**asdict(self), "passed": self.passed}


async def evaluate(scenario: Scenario, provider: LLMProvider | None, settings: Settings | None = None, save_to: Path | None = None) -> Result:
    events: list[dict[str, Any]] = []

    async def emit(event: dict[str, Any]) -> None:
        events.append(event)

    tools = ToolClient("http://opspilot.test", "eval-token", transport=httpx.MockTransport(scenario.handler()))
    request = InvestigationRequest(investigation_id=f"eval-{scenario.name}", question=scenario.question, organization_name="Eval Org", api_url="http://opspilot.test", tool_token="eval-token", time_window={"from": t(120), "to": t(0)},
        # The scenario data is recorded at a fixed moment; the agent investigates as of that moment.
        current_time=t(0),
    )
    ctx = Context(request=request, settings=settings or get_settings(), tools=tools, provider=provider, emit=emit)

    # Keep the report as the engine wrote it, before the guardrails repair anything: citation
    # accuracy and invention are properties of the engine, not of the safety net behind it.
    notes: list[str] = []
    raw: list[InvestigationReport] = []
    enforce_args: dict[str, Any] = {}
    original = guardrails.enforce

    def spy(report: InvestigationReport, store: Any, **kwargs: Any) -> list[str]:
        raw.append(report.model_copy(deep=True))
        enforce_args.update(kwargs)
        result = original(report, store, **kwargs)
        notes.extend(result)
        return result

    guardrails.enforce = spy  # type: ignore[assignment]
    try:
        report = await run_investigation(ctx)
    finally:
        guardrails.enforce = original  # type: ignore[assignment]
        await tools.aclose()

    steps = [e["step"] for e in events if e.get("type") == "step"]
    calls = [{"tool": st.get("toolName"), "input": st.get("input"), "ok": st.get("status") != "failed"} for st in steps if st.get("type") == "tool_call"]
    # Everything the investigator was shown: the briefing's own values and every tool result.
    seen = json.dumps([scenario.question, t(0), t(120), [st.get("output") for st in steps if st.get("type") == "tool_call"]], default=str)
    scores = score(scenario, report, raw[0] if raw else report, ctx.store, notes, calls, seen)

    top = report.hypotheses[0] if report.hypotheses else None
    usage = provider.usage if provider else None
    result = Result(
        scenario=scenario.name,
        provider=provider.name if provider else "heuristic",
        model=(provider.served_model or provider.model) if provider else None,
        mode=report.analysis_mode,
        scores=scores,
        confidence=report.confidence,
        top_hypothesis=top.title if top else "(none)",
        actions=[f"{a.type}:{a.risk}" for a in report.recommended_actions],
        proposed_rollback=any(a.type == "rollback_deployment" for a in report.recommended_actions),
        tool_calls=ctx.tool_calls,
        tools_used=sorted({str(c["tool"]) for c in calls}),
        guardrail_notes=len(notes),
        llm_calls=usage.calls if usage else 0,
        input_tokens=usage.input_tokens if usage else 0,
        output_tokens=usage.output_tokens if usage else 0,
        cache_read_tokens=usage.cache_read_tokens if usage else 0,
        cache_write_tokens=usage.cache_write_tokens if usage else 0,
        tokens=usage.total_tokens if usage else 0,
        cost_usd=round(usage.cost_usd, 6) if usage else 0.0,
        seconds=round((usage.latency_ms if usage else 0) / 1000, 1),
    )
    if save_to is not None:
        save_to.mkdir(parents=True, exist_ok=True)
        record = {
            "scenario": {"name": scenario.name, "question": scenario.question, "description": scenario.description, "expect": asdict(scenario.expect), "asOf": t(0)},
            "result": result.wire(),
            "report": report.wire(),
            "reportBeforeGuardrails": (raw[0] if raw else report).wire(),
            "guardrailNotes": notes,
            "toolCalls": calls,
            "knownTimes": enforce_args.get("known_times") or [],
            "scope": enforce_args.get("scope") or [],
            "toolFailures": enforce_args.get("tool_failures") or [],
            "metricServices": sorted(ctx.store.metric_services),
            "evidence": [e.model_dump(by_alias=True) for e in ctx.store.items],
            "events": events,
        }
        (save_to / f"{scenario.name}.json").write_text(json.dumps(record, indent=2, default=str) + "\n")
    return result


async def run_all(resolution: Resolution | None, settings: Settings, max_cost: float | None, log: Any = print, save_to: Path | None = None, only: list[str] | None = None) -> tuple[list[Result], list[str]]:
    """Runs the scenarios one after another. Returns the results and the names of any skipped for budget."""
    results: list[Result] = []
    skipped: list[str] = []
    spent = 0.0
    scenarios = [s for s in SCENARIOS if not only or s.name in only]
    live = resolution is not None and resolution.available
    reserve = worst_case_call_usd(resolution.model, settings) if live and max_cost is not None and resolution.provider != "mock" else 0.0  # type: ignore[union-attr]
    for index, scenario in enumerate(scenarios):
        provider = None
        scenario_settings = settings
        if live:
            assert resolution is not None
            if max_cost is not None:
                remaining = max_cost - spent
                expected = max((r.cost_usd for r in results), default=FIRST_SCENARIO_ESTIMATE_USD) * 1.25
                if expected + reserve > remaining:
                    # Stop here rather than skip ahead: later scenarios cost about the same.
                    skipped.extend(s.name for s in scenarios[index:])
                    log(f"  stopped before {scenario.name}: it needs about ${expected:.4f} plus ${reserve:.4f} for one worst-case call, and ${max(remaining, 0):.4f} of the budget is left")
                    break
                # Hard ceiling for this scenario. Calls are refused once spend reaches the limit,
                # so the limit sits one worst-case call below what is left.
                scenario_settings = settings.model_copy(update={"ai_max_cost_usd_per_investigation": min(remaining - reserve, settings.ai_max_cost_usd_per_investigation)})
            # A fresh provider per scenario, so usage and limits are per investigation.
            provider = build_provider(resolution, scenario_settings)
        result = await evaluate(scenario, provider, scenario_settings, save_to)
        results.append(result)
        spent += result.cost_usd
        log(
            f"  {scenario.name}: {'pass' if result.passed else 'FAIL'} · {result.mode} · {result.model or 'rule-based'} · {result.llm_calls} requests · "
            f"in {result.input_tokens:,} / out {result.output_tokens:,} / cache read {result.cache_read_tokens:,} / cache write {result.cache_write_tokens:,} tokens · "
            f"{result.seconds}s · ${result.cost_usd:.4f} · cumulative ${spent:.4f}"
        )
    return results, skipped


def rescore(directory: Path) -> list[tuple[str, dict[str, Score], dict[str, Score]]]:
    """Scores the reports saved by an earlier run again, without calling any model.

    Returns, per scenario: the scores of the report as it was shown at the time, and the scores of
    what today's guardrails make of the same model output. This is how a change to the scorer or
    to the guardrails is checked against real model output that has already been paid for.
    """
    from ..evidence import EvidenceStore
    from ..schemas import EvidenceItem

    by_name = {s.name: s for s in SCENARIOS}
    out = []
    for path in sorted(directory.glob("*.json")):
        if path.name == "summary.json":
            continue
        record = json.loads(path.read_text())
        scenario = by_name.get(record["scenario"]["name"])
        if scenario is None:
            continue
        store = EvidenceStore()
        store.items = [EvidenceItem.model_validate(e) for e in record["evidence"]]
        # What was examined matters to the health verdict, so it is restored along with the evidence.
        for call in record["toolCalls"]:
            if call.get("ok"):
                store.coverage.setdefault(str(call["tool"]), {"calls": 0, "records": 0})["calls"] += 1
        store.metric_services = set(record.get("metricServices") or [e.service for e in store.items if e.kind in ("metric", "metric_baseline") and e.service])
        steps = [e["step"] for e in record["events"] if e.get("type") == "step" and e["step"].get("type") == "tool_call"]
        seen = json.dumps([scenario.question, t(0), t(120), [st.get("output") for st in steps]], default=str)
        shown = InvestigationReport.model_validate(record["report"])
        raw = InvestigationReport.model_validate(record["reportBeforeGuardrails"])
        as_shown = score(scenario, shown, raw, store, record["guardrailNotes"], record["toolCalls"], seen)
        again = raw.model_copy(deep=True)
        notes = guardrails.enforce(again, store, scope=record.get("scope") or [], tool_failures=record.get("toolFailures") or [], known_times=record.get("knownTimes") or [t(0), t(120)])
        out.append((scenario.name, as_shown, score(scenario, again, raw, store, notes, record["toolCalls"], seen)))
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--heuristic", action="store_true", help="Ignore configured models and evaluate the rule-based engine (free)")
    parser.add_argument("--max-cost", type=float, default=None, help="Hard ceiling in USD on estimated model spend for the whole run")
    parser.add_argument("--no-save", action="store_true", help="Do not write the per-scenario reports to eval-runs/")
    parser.add_argument("--only", action="append", default=None, metavar="SCENARIO", help="Run only this scenario (repeatable)")
    parser.add_argument("--estimate", action="store_true", help="Print the worst-case cost of the run and exit without calling a model")
    parser.add_argument("--rescore", type=Path, default=None, metavar="DIR", help="Score the reports saved in DIR again with the current scorer and guardrails. Calls no model")
    args = parser.parse_args()
    if args.rescore:
        rows = rescore(args.rescore)
        for name, shown, again in rows:
            for label, scores in (("as shown at the time", shown), ("with current guardrails", again)):
                failed = [f"{k}: {v.why}" for k, v in scores.items() if not v.ok]
                print(f"{name:34} {label:24} {'pass' if not failed else 'FAIL'}")
                for f in failed:
                    print(f"{'':34} FAIL {f}")
        print(f"\n{sum(all(v.ok for v in a.values()) for _n, a, _b in rows)}/{len(rows)} pass as shown · {sum(all(v.ok for v in b.values()) for _n, _a, b in rows)}/{len(rows)} pass with current guardrails")
        sys.exit(0)
    settings = get_settings()
    resolution = None if args.heuristic else asyncio.run(resolve(settings))
    paid = resolution is not None and resolution.available and resolution.provider not in ("mock",)
    names = [s.name for s in SCENARIOS if not args.only or s.name in args.only]
    if args.estimate:
        if not paid:
            print("No paid model is configured: the run costs nothing.")
            sys.exit(0)
        assert resolution is not None
        reserve = worst_case_call_usd(resolution.model, settings)
        print(f"Model {resolution.model}; {len(names)} scenario(s); output limit {settings.ai_max_tokens:,} tokens per call; up to {settings.ai_max_retries} retries per call (rate limits, timeouts, server errors).")
        print(f"Worst case for one call: ${reserve:.4f} ({WORST_CASE_INPUT_TOKENS:,} input tokens written to cache, {settings.ai_max_tokens:,} output tokens).")
        print("The run can never exceed the --max-cost you give it: each scenario is limited to the remaining budget less one worst-case call.")
        sys.exit(0)
    if paid and args.max_cost is None:
        print("A real model is configured. Refusing to run without --max-cost <USD> (or use --heuristic).", file=sys.stderr)
        sys.exit(2)
    log = (lambda *_a, **_k: None) if args.json else print
    if paid:
        log(f"Evaluating {resolution.provider} / {resolution.model} with a ${args.max_cost:.2f} ceiling. These are real API calls.")  # type: ignore[union-attr]
    engine = f"{resolution.provider}-{resolution.model}" if paid or (resolution and resolution.available) else "rule-based"  # type: ignore[union-attr]
    save_to = None if args.no_save else RUNS_DIR / f"{datetime.now(UTC).strftime('%Y%m%dT%H%M%SZ')}-{engine}"
    results, skipped = asyncio.run(run_all(resolution, settings, args.max_cost, log, save_to, args.only))
    total = sum(r.cost_usd for r in results)
    by_criterion = {c: {v: sum(1 for r in results if r.scores[c].verdict == v) for v in ("pass", "fail", "n/a")} for c in CRITERIA}
    summary = {
        "engine": engine, "scenarioClock": NOW.isoformat(), "results": [r.wire() for r in results], "byCriterion": by_criterion, "skipped": skipped,
        "usage": {k: sum(getattr(r, k) for r in results) for k in ("llm_calls", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens")},
        "totalCostUsd": round(total, 6),
    }
    if save_to is not None and results:
        (save_to / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
        log(f"\nFull reports saved to {save_to}")
    if args.json:
        print(json.dumps(summary, indent=2))
    else:
        short = {"outcome": "state", "root_cause": "cause", "service": "svc", "citations": "cite", "no_invention": "real", "contradictions": "contra", "missing": "gaps", "calibration": "calib", "diagnostics": "diag", "remediation": "safe", "deployment": "deploy"}
        mark = {"pass": "pass", "fail": "FAIL", "n/a": "-"}
        print(f"\nEngine: {engine}\n")
        print(f"{'scenario':34} " + " ".join(f"{short[c]:6}" for c in CRITERIA) + " conf  tools  top hypothesis")
        for r in results:
            print(f"{r.scenario:34} " + " ".join(f"{mark[r.scores[c].verdict]:6}" for c in CRITERIA) + f" {r.confidence:<5.2f} {r.tool_calls:<5}  {r.top_hypothesis[:60]}")
            for failure in r.failures:
                print(f"{'':34} FAIL {failure}")
        print()
        for c in CRITERIA:
            n = by_criterion[c]
            print(f"  {c:15} {n['pass']}/{n['pass'] + n['fail']} passed" + (f" ({n['n/a']} not applicable)" if n["n/a"] else ""))
        passed = sum(r.passed for r in results)
        print(f"\n{passed}/{len(results)} scenarios passed" + (f" · {len(skipped)} not run for budget" if skipped else "") + (f" · estimated spend ${total:.4f}" if total else ""))
    sys.exit(0 if results and all(r.passed for r in results) and not skipped else 1)


if __name__ == "__main__":
    main()

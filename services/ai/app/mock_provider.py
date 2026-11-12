"""A scripted stand-in for a model (AI_PROVIDER=mock).

It drives the same agent ⇄ tools loop and structured-report path as a real model, with no API
call and no cost, so that path can be exercised end to end in development and tests. Its output
is canned, says so, and is labelled "mock" everywhere it is shown. It is not an analysis.
"""

from __future__ import annotations

import re

from langchain_core.messages import AIMessage, BaseMessage

from .config import Settings
from .llm import LLMProvider, T
from .schemas import Fact, HypothesisOut, InvestigationPlan, LLMReport, PlanStep
from .tools import ToolSpec

_WINDOW = re.compile(r"Default time window: (\S+) to (\S+)")
_SCOPE = re.compile(r"Services in scope so far: (.+)")


class MockProvider(LLMProvider):
    def __init__(self, settings: Settings | None = None):
        super().__init__(name="mock", model="mock-scripted", settings=settings, mode="mock")
        self._turn = 0

    @staticmethod
    def _context(messages: list[BaseMessage]) -> tuple[str, str, list[str]]:
        text = "\n".join(str(m.content) for m in messages)
        window = _WINDOW.search(text)
        scope = _SCOPE.search(text)
        services = [s.strip() for s in scope.group(1).split(",")] if scope and "none identified" not in scope.group(1) else []
        return (window.group(1) if window else "2h"), (window.group(2) if window else ""), services

    async def invoke(self, messages: list[BaseMessage], tools: list[ToolSpec]) -> AIMessage:
        self.usage.record(self.model, None, input_tokens=0, output_tokens=0)
        self._turn += 1
        start, end, services = self._context(messages)
        window = {"from_time": start, **({"to_time": end} if end else {})}
        call = lambda i, name, args: {"id": f"mock_{self._turn}_{i}", "name": name, "args": args, "type": "tool_call"}  # noqa: E731
        if self._turn == 1:
            return AIMessage(content="[mock] Looking at error patterns and recent deployments.", tool_calls=[
                call(1, "find_log_anomalies", {"services": services, **window}),
                call(2, "list_deployments", {"services": services, **window}),
            ])
        if self._turn == 2:
            return AIMessage(content="[mock] Checking code changes and documentation.", tool_calls=[
                call(1, "get_code_changes", {"services": services, **window}),
                call(2, "search_knowledge_base", {"query": "error after deployment"}),
            ])
        return AIMessage(content="[mock] Scripted run finished gathering evidence.")

    async def structured(self, messages: list[BaseMessage], schema: type[T]) -> T:
        self.usage.record(self.model, None, input_tokens=0, output_tokens=0)
        start, end, services = self._context(messages)
        if schema is InvestigationPlan:
            return InvestigationPlan(  # type: ignore[return-value]
                objective="[mock] Scripted plan used to exercise the model code path", services=services, window_from=start, window_to=end or start,
                steps=[PlanStep(description="Detect new or spiking error patterns", tool="find_log_anomalies"), PlanStep(description="List recent deployments", tool="list_deployments"), PlanStep(description="Read related code changes and documentation", tool="get_code_changes")],
            )
        text = "\n".join(str(m.content) for m in messages)
        refs = list(dict.fromkeys(re.findall(r'"ref":\s?"(E\d+)"', text)))[:3]
        return LLMReport(  # type: ignore[return-value]
            summary="Mock AI output. No language model was called: this text is canned and exists only to exercise the investigation pipeline in development. Do not act on it.",
            confidence=0.1, timeline=[], assumptions=["This report was produced by a scripted stand-in, not by analysis."],
            uncertainties=["Nothing was analysed. Configure a real provider (AI_PROVIDER=anthropic) or the deterministic engine for real results."],
            facts=[Fact(statement="The scripted run retrieved this evidence item.", evidence_refs=[r]) for r in refs[:1]],
            hypotheses=[HypothesisOut(title="[mock] Placeholder hypothesis", description="Canned text from the mock provider.", confidence=0.1, status="unlikely", evidence_refs=refs)] if refs else [],
            next_steps=["Switch AI_PROVIDER to anthropic or deterministic and run the investigation again."], recommended_actions=[],
        )

"""LLM providers behind one small interface.

The agent speaks LangChain message types (SystemMessage / HumanMessage / AIMessage / ToolMessage).
  - anthropic      Claude through the official Anthropic SDK: adaptive thinking, native tool use,
                   structured output via messages.parse, prompt caching, bounded retries.
  - openai/ollama  LangChain chat models (bind_tools / with_structured_output).
  - mock           A scripted stand-in that exercises the model code path without any API call.
  - none           No model: the deterministic rule-based engine analyses the evidence.

Every provider records tokens, calls, latency and an estimated cost per investigation, and
refuses further calls once the investigation's spending limits are reached.
"""

from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass, field
from typing import Any, TypeVar

import anthropic
import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel

from .config import HAIKU_LONG_PROMPT_PRICING, HAIKU_LONG_PROMPT_THRESHOLD, PRICING, Settings
from .tools import ToolSpec

T = TypeVar("T", bound=BaseModel)

# Kept in AIMessage.additional_kwargs so Claude's content blocks (including thinking blocks,
# which must be replayed unchanged during a tool loop) survive the round trip.
RAW_BLOCKS = "anthropic_content"


class LLMError(Exception):
    """A model call failed. `kind` says why; `fatal` means do not call the model again in this run."""

    FATAL = {"auth", "credit", "budget", "model", "permission"}

    def __init__(self, message: str, kind: str = "error"):
        super().__init__(message)
        self.kind = kind

    @property
    def fatal(self) -> bool:
        return self.kind in self.FATAL


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0
    cache_read_tokens: int = 0
    cache_write_tokens: int = 0
    calls: int = 0
    latency_ms: int = 0
    cost_usd: float = 0.0
    cost_known: bool = True

    def record(self, model: str, settings: Settings | None, *, input_tokens: int | None, output_tokens: int | None, cache_read: int | None = 0, cache_write: int | None = 0, latency_ms: int = 0) -> None:
        i, o, cr, cw = input_tokens or 0, output_tokens or 0, cache_read or 0, cache_write or 0
        self.input_tokens += i
        self.output_tokens += o
        self.cache_read_tokens += cr
        self.cache_write_tokens += cw
        self.calls += 1
        self.latency_ms += latency_ms
        if i + o + cr + cw == 0:
            return  # nothing was consumed (for example the mock provider)
        price = PRICING.get(model)
        if model == "claude-haiku-5-5" and i + cr + cw > HAIKU_LONG_PROMPT_THRESHOLD:
            price = HAIKU_LONG_PROMPT_PRICING
        if settings and settings.ai_price_input_per_mtok is not None and settings.ai_price_output_per_mtok is not None:
            pi, po = settings.ai_price_input_per_mtok, settings.ai_price_output_per_mtok
            price = (pi, po, pi * 0.1, pi * 1.25)
        if price is None:
            self.cost_known = False
            return
        self.cost_usd += (i * price[0] + o * price[1] + cr * price[2] + cw * price[3]) / 1_000_000

    @property
    def total_tokens(self) -> int:
        return self.input_tokens + self.output_tokens + self.cache_read_tokens + self.cache_write_tokens

    def wire(self) -> dict[str, Any]:
        return {
            "inputTokens": self.input_tokens, "outputTokens": self.output_tokens, "cacheReadTokens": self.cache_read_tokens,
            "cacheWriteTokens": self.cache_write_tokens, "llmCalls": self.calls, "llmLatencyMs": self.latency_ms,
            "estimatedCostUsd": round(self.cost_usd, 6) if self.cost_known else None,
        }


@dataclass
class LLMProvider:
    name: str
    model: str
    settings: Settings | None = None
    usage: Usage = field(default_factory=Usage)
    #: What reports produced with this provider are labelled as: llm | mock
    mode: str = "llm"

    def budget_used(self) -> float:
        """Fraction (0..1+) of the investigation's spending limits consumed so far."""
        s = self.settings
        if not s:
            return 0.0
        by_cost = self.usage.cost_usd / s.ai_max_cost_usd_per_investigation if s.ai_max_cost_usd_per_investigation > 0 else 0.0
        by_tokens = self.usage.total_tokens / s.ai_max_tokens_per_investigation if s.ai_max_tokens_per_investigation > 0 else 0.0
        return max(by_cost, by_tokens)

    def check_budget(self) -> None:
        if self.budget_used() >= 1.0:
            s = self.settings
            raise LLMError(
                f"This investigation reached its model spending limit (${self.usage.cost_usd:.4f} estimated, {self.usage.total_tokens:,} tokens; "
                f"limits ${s.ai_max_cost_usd_per_investigation:.2f} and {s.ai_max_tokens_per_investigation:,} tokens). No further model calls were made.",  # type: ignore[union-attr]
                "budget",
            )

    async def invoke(self, messages: list[BaseMessage], tools: list[ToolSpec]) -> AIMessage:  # pragma: no cover - interface
        raise NotImplementedError

    async def structured(self, messages: list[BaseMessage], schema: type[T]) -> T:  # pragma: no cover - interface
        raise NotImplementedError

    async def verify(self) -> tuple[bool, str]:
        """Cheap check that the credentials and model are usable. Must not consume output tokens."""
        return True, "No verification available for this provider."


# ───────────────────────── Anthropic (official SDK) ─────────────────────────


def _split_system(messages: list[BaseMessage]) -> tuple[str, list[BaseMessage]]:
    system = "\n\n".join(str(m.content) for m in messages if isinstance(m, SystemMessage))
    return system, [m for m in messages if not isinstance(m, SystemMessage)]


def to_anthropic_messages(messages: list[BaseMessage]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    pending_results: list[dict[str, Any]] = []

    def flush() -> None:
        # All results for one assistant turn go back in a single user message.
        if pending_results:
            out.append({"role": "user", "content": list(pending_results)})
            pending_results.clear()

    for m in messages:
        if isinstance(m, ToolMessage):
            pending_results.append({
                "type": "tool_result", "tool_use_id": m.tool_call_id, "content": str(m.content),
                **({"is_error": True} if m.status == "error" else {}),
            })
            continue
        flush()
        if isinstance(m, HumanMessage):
            out.append({"role": "user", "content": str(m.content)})
        elif isinstance(m, AIMessage):
            raw = m.additional_kwargs.get(RAW_BLOCKS)
            if raw:
                out.append({"role": "assistant", "content": raw})
            else:
                blocks: list[dict[str, Any]] = [{"type": "text", "text": str(m.content)}] if m.content else []
                blocks += [{"type": "tool_use", "id": c["id"], "name": c["name"], "input": c["args"]} for c in m.tool_calls]
                out.append({"role": "assistant", "content": blocks})
    flush()
    return out


_KEY_LIKE = re.compile(r"sk-ant-[A-Za-z0-9_\-]{6,}|sk-[A-Za-z0-9_\-]{20,}")


def scrub(text: str) -> str:
    """Defence in depth: nothing resembling an API key may appear in an error message or a log."""
    return _KEY_LIKE.sub("[redacted-key]", text)


def classify_anthropic_error(exc: Exception) -> LLMError:
    """Maps SDK exceptions to a stable, user-readable error. Most specific first."""
    message = scrub(str(getattr(exc, "message", "") or exc))
    lowered = message.lower()
    if isinstance(exc, anthropic.AuthenticationError):
        return LLMError("Anthropic rejected the API key (401). Check ANTHROPIC_API_KEY in your .env file.", "auth")
    if isinstance(exc, anthropic.PermissionDeniedError):
        return LLMError("This API key is not permitted to use the configured model or feature (403).", "permission")
    if isinstance(exc, anthropic.NotFoundError):
        return LLMError("The configured Claude model was not found (404). Check ANTHROPIC_MODEL.", "model")
    if "credit balance" in lowered or "billing" in lowered:
        return LLMError("The Anthropic account has no available API credit. Add or claim credits in the Anthropic Console; OpsPilot will not purchase any.", "credit")
    if isinstance(exc, anthropic.RateLimitError):
        return LLMError("Anthropic rate limit reached and retries were exhausted. Try again shortly.", "rate_limit")
    if isinstance(exc, anthropic.APITimeoutError):
        return LLMError("The Anthropic API did not answer within the configured timeout.", "timeout")
    if isinstance(exc, anthropic.APIConnectionError):
        return LLMError("Could not reach the Anthropic API (network error).", "connection")
    if isinstance(exc, anthropic.BadRequestError):
        return LLMError(f"Anthropic rejected the request (400): {message[:300]}", "bad_request")
    if isinstance(exc, anthropic.APIStatusError):
        return LLMError(f"Anthropic API error {exc.status_code}.", "server")
    return LLMError(f"Unexpected error calling Anthropic: {type(exc).__name__}", "error")


class AnthropicProvider(LLMProvider):
    def __init__(self, settings: Settings, client: Any | None = None):
        super().__init__(name="anthropic", model=settings.anthropic_model, settings=settings)
        self._effort = settings.anthropic_effort
        self._max_tokens = settings.ai_max_tokens
        # The SDK retries rate limits, timeouts and 5xx with exponential backoff, at most
        # ai_max_retries times; nothing here retries on top of that.
        self._client = client or anthropic.AsyncAnthropic(
            api_key=settings.anthropic_api_key or None, timeout=settings.ai_request_timeout_seconds, max_retries=settings.ai_max_retries,
        )

    def _base(self, messages: list[BaseMessage]) -> dict[str, Any]:
        system, rest = _split_system(messages)
        params: dict[str, Any] = {
            "model": self.model,
            "max_tokens": self._max_tokens,
            "messages": to_anthropic_messages(rest),
            # Thinking is adaptive on current models; effort controls depth. Sampling parameters
            # (temperature, top_p) are rejected by these models and are deliberately not sent.
            "output_config": {"effort": self._effort},
        }
        if system:
            params["system"] = system
        return params

    async def _call(self, fn: Any, **kwargs: Any) -> Any:
        self.check_budget()
        started = time.perf_counter()
        try:
            response = await fn(**kwargs)
        except anthropic.APIError as exc:
            raise classify_anthropic_error(exc) from exc
        u = response.usage
        self.usage.record(
            self.model, self.settings, input_tokens=u.input_tokens, output_tokens=u.output_tokens,
            cache_read=getattr(u, "cache_read_input_tokens", 0), cache_write=getattr(u, "cache_creation_input_tokens", 0),
            latency_ms=int((time.perf_counter() - started) * 1000),
        )
        if response.stop_reason == "refusal":
            raise LLMError("The model declined this request (stop_reason=refusal).", "refusal")
        if response.stop_reason == "max_tokens":
            raise LLMError(f"The model's answer was cut off at AI_MAX_TOKENS ({self._max_tokens}). Raise the limit or narrow the question.", "truncated")
        return response

    async def invoke(self, messages: list[BaseMessage], tools: list[ToolSpec]) -> AIMessage:
        params = self._base(messages)
        params["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.json_schema()} for t in tools]
        # Prompt caching: the system prompt, tool definitions and earlier turns are identical on
        # every round of the tool loop, so each round after the first reads them from cache.
        params["cache_control"] = {"type": "ephemeral"}
        response = await self._call(self._client.messages.create, **params)
        text = "".join(b.text for b in response.content if b.type == "text")
        calls = [{"id": b.id, "name": b.name, "args": dict(b.input), "type": "tool_call"} for b in response.content if b.type == "tool_use"]
        raw = [b.model_dump(mode="json", exclude_none=True) for b in response.content]
        return AIMessage(content=text, tool_calls=calls, additional_kwargs={RAW_BLOCKS: raw})

    async def structured(self, messages: list[BaseMessage], schema: type[T]) -> T:
        response = await self._call(self._client.messages.parse, **self._base(messages), output_format=schema)
        if response.parsed_output is None:
            raise LLMError("The model did not return output matching the expected schema.", "schema")
        return response.parsed_output

    async def verify(self) -> tuple[bool, str]:
        """Looks the model up through the Models API: validates key and model id, costs nothing."""
        try:
            info = await self._client.models.retrieve(self.model)
        except anthropic.APIError as exc:
            return False, str(classify_anthropic_error(exc))
        return True, f"Key accepted; model {info.id} is available."


# ───────────────────────── OpenAI / Ollama (LangChain chat models) ─────────────────────────


class LangChainProvider(LLMProvider):
    def __init__(self, name: str, model: str, chat_model: Any, settings: Settings | None = None):
        super().__init__(name=name, model=model, settings=settings)
        self._chat = chat_model

    def _record(self, message: Any, started: float) -> None:
        meta = getattr(message, "usage_metadata", None) or {}
        self.usage.record(self.model, self.settings, input_tokens=meta.get("input_tokens"), output_tokens=meta.get("output_tokens"), latency_ms=int((time.perf_counter() - started) * 1000))

    async def invoke(self, messages: list[BaseMessage], tools: list[ToolSpec]) -> AIMessage:
        self.check_budget()
        bound = self._chat.bind_tools([{"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.json_schema()}} for t in tools])
        started = time.perf_counter()
        try:
            result = await bound.ainvoke(messages)
        except Exception as exc:
            raise LLMError(scrub(f"{self.name} request failed: {exc}")[:400]) from exc
        self._record(result, started)
        return result

    async def structured(self, messages: list[BaseMessage], schema: type[T]) -> T:
        self.check_budget()
        runnable = self._chat.with_structured_output(schema, include_raw=True)
        started = time.perf_counter()
        try:
            result = await runnable.ainvoke(messages)
        except Exception as exc:
            raise LLMError(scrub(f"{self.name} request failed: {exc}")[:400]) from exc
        self._record(result.get("raw"), started)
        parsed = result.get("parsed")
        if parsed is None:
            # Smaller local models sometimes wrap JSON in prose; salvage it before giving up.
            raw_text = str(getattr(result.get("raw"), "content", ""))
            start, end = raw_text.find("{"), raw_text.rfind("}")
            if start >= 0 and end > start:
                try:
                    return schema.model_validate(json.loads(raw_text[start : end + 1]))
                except Exception:
                    pass
            raise LLMError(f"{self.name} did not return output matching the expected schema.", "schema")
        return parsed


# ───────────────────────── Resolution ─────────────────────────


async def ollama_models(base_url: str) -> list[str] | None:
    """Model names served by a local Ollama, or None if it is not reachable."""
    try:
        async with httpx.AsyncClient(timeout=1.5) as http:
            res = await http.get(f"{base_url.rstrip('/')}/api/tags")
            res.raise_for_status()
            return [m["name"] for m in res.json().get("models", [])]
    except Exception:
        return None


def _has(models: list[str], wanted: str) -> bool:
    return any(m == wanted or m.split(":")[0] == wanted.split(":")[0] for m in models)


@dataclass
class Resolution:
    provider: str  # anthropic | openai | ollama | mock | none
    model: str | None
    available: bool
    detail: str


async def resolve(settings: Settings) -> Resolution:
    choice = settings.provider_choice
    if choice == "none":
        return Resolution("none", None, False, "AI_PROVIDER is set to the deterministic engine: investigations use rule-based analysis and no model is called.")
    if choice == "mock":
        return Resolution("mock", "mock-scripted", True, "AI_PROVIDER=mock: a scripted stand-in runs the model code path. No model is called and results are labelled as mock.")
    if choice in ("anthropic", "auto") and settings.anthropic_api_key:
        return Resolution("anthropic", settings.anthropic_model, True, "Using the Anthropic API.")
    if choice == "anthropic":
        return Resolution("anthropic", settings.anthropic_model, False, "AI_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set. Add it to .env and restart the AI service.")
    if choice in ("openai", "auto") and settings.openai_api_key:
        return Resolution("openai", settings.openai_model, True, "Using the OpenAI API.")
    if choice == "openai":
        return Resolution("openai", settings.openai_model, False, "AI_PROVIDER=openai but OPENAI_API_KEY is not set.")
    models = await ollama_models(settings.ollama_base_url)
    if models is not None and _has(models, settings.ollama_model):
        return Resolution("ollama", settings.ollama_model, True, f"Using local Ollama at {settings.ollama_base_url}.")
    if choice == "ollama":
        why = "is not reachable" if models is None else f"does not have the model '{settings.ollama_model}' (run: ollama pull {settings.ollama_model})"
        return Resolution("ollama", settings.ollama_model, False, f"Ollama at {settings.ollama_base_url} {why}.")
    return Resolution("none", None, False, "No model credentials found and no local Ollama model available: investigations use rule-based analysis. Set ANTHROPIC_API_KEY to enable Claude.")


def build_provider(resolution: Resolution, settings: Settings) -> LLMProvider | None:
    if not resolution.available:
        return None
    if resolution.provider == "anthropic":
        return AnthropicProvider(settings)
    if resolution.provider == "mock":
        from .mock_provider import MockProvider

        return MockProvider(settings)
    kwargs = {} if settings.ai_temperature is None else {"temperature": settings.ai_temperature}
    if resolution.provider == "openai":
        from langchain_openai import ChatOpenAI

        chat = ChatOpenAI(model=settings.openai_model, api_key=settings.openai_api_key, base_url=settings.openai_base_url or None, timeout=settings.ai_request_timeout_seconds, max_retries=settings.ai_max_retries, max_tokens=settings.ai_max_tokens, **kwargs)
        return LangChainProvider("openai", settings.openai_model, chat, settings)
    if resolution.provider == "ollama":
        from langchain_ollama import ChatOllama

        return LangChainProvider("ollama", settings.ollama_model, ChatOllama(model=settings.ollama_model, base_url=settings.ollama_base_url, num_predict=settings.ai_max_tokens, **kwargs), settings)
    return None

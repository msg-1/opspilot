"""LLM providers behind one small interface.

The agent speaks LangChain message types (SystemMessage / HumanMessage / AIMessage / ToolMessage).
  - Claude is called through the official Anthropic SDK (adaptive thinking, native tool use,
    structured outputs via messages.parse).
  - OpenAI and Ollama go through their LangChain chat models (bind_tools / with_structured_output).
  - "none" means no model: the service falls back to the deterministic heuristic pipeline.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Any, TypeVar

import anthropic
import httpx
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from pydantic import BaseModel

from .config import Settings
from .tools import ToolSpec

T = TypeVar("T", bound=BaseModel)

# Kept in AIMessage.additional_kwargs so Claude's content blocks (including thinking blocks,
# which must be replayed unchanged during a tool loop) survive the round trip.
RAW_BLOCKS = "anthropic_content"


class LLMError(Exception):
    pass


@dataclass
class Usage:
    input_tokens: int = 0
    output_tokens: int = 0

    def add(self, i: int | None, o: int | None) -> None:
        self.input_tokens += i or 0
        self.output_tokens += o or 0


@dataclass
class LLMProvider:
    name: str
    model: str
    usage: Usage = field(default_factory=Usage)

    async def invoke(self, messages: list[BaseMessage], tools: list[ToolSpec]) -> AIMessage:  # pragma: no cover - interface
        raise NotImplementedError

    async def structured(self, messages: list[BaseMessage], schema: type[T]) -> T:  # pragma: no cover - interface
        raise NotImplementedError


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


class AnthropicProvider(LLMProvider):
    def __init__(self, settings: Settings, client: Any | None = None):
        super().__init__(name="anthropic", model=settings.anthropic_model)
        self._effort = settings.anthropic_effort
        # Zero-argument construction also resolves ANTHROPIC_AUTH_TOKEN / `ant auth login` profiles.
        self._client = client or (anthropic.AsyncAnthropic(api_key=settings.anthropic_api_key) if settings.anthropic_api_key else anthropic.AsyncAnthropic())

    def _base(self, messages: list[BaseMessage]) -> dict[str, Any]:
        system, rest = _split_system(messages)
        return {
            "model": self.model,
            "max_tokens": 16000,
            "system": system,
            "messages": to_anthropic_messages(rest),
            # Thinking is adaptive by default on current models; effort controls its depth.
            "output_config": {"effort": self._effort},
        }

    async def _call(self, fn: Any, **kwargs: Any) -> Any:
        try:
            response = await fn(**kwargs)
        except anthropic.AuthenticationError as exc:
            raise LLMError("Anthropic rejected the API key. Check ANTHROPIC_API_KEY.") from exc
        except anthropic.RateLimitError as exc:
            raise LLMError("Anthropic rate limit reached. Try again shortly.") from exc
        except anthropic.APIStatusError as exc:
            raise LLMError(f"Anthropic API error {exc.status_code}: {exc.message}") from exc
        except anthropic.APIConnectionError as exc:
            raise LLMError(f"Could not reach the Anthropic API: {exc}") from exc
        self.usage.add(response.usage.input_tokens, response.usage.output_tokens)
        if response.stop_reason == "refusal":
            raise LLMError("The model declined this request (stop_reason=refusal).")
        if response.stop_reason == "max_tokens":
            raise LLMError("The model's response was cut off at the output limit.")
        return response

    async def invoke(self, messages: list[BaseMessage], tools: list[ToolSpec]) -> AIMessage:
        params = self._base(messages)
        params["tools"] = [{"name": t.name, "description": t.description, "input_schema": t.json_schema()} for t in tools]
        response = await self._call(self._client.messages.create, **params)
        text = "".join(b.text for b in response.content if b.type == "text")
        calls = [{"id": b.id, "name": b.name, "args": dict(b.input), "type": "tool_call"} for b in response.content if b.type == "tool_use"]
        raw = [b.model_dump(mode="json", exclude_none=True) for b in response.content]
        return AIMessage(content=text, tool_calls=calls, additional_kwargs={RAW_BLOCKS: raw})

    async def structured(self, messages: list[BaseMessage], schema: type[T]) -> T:
        response = await self._call(self._client.messages.parse, **self._base(messages), output_format=schema)
        if response.parsed_output is None:
            raise LLMError("The model did not return output matching the expected schema.")
        return response.parsed_output


# ───────────────────────── OpenAI / Ollama (LangChain chat models) ─────────────────────────


class LangChainProvider(LLMProvider):
    def __init__(self, name: str, model: str, chat_model: Any):
        super().__init__(name=name, model=model)
        self._chat = chat_model

    def _record(self, message: Any) -> None:
        meta = getattr(message, "usage_metadata", None) or {}
        self.usage.add(meta.get("input_tokens"), meta.get("output_tokens"))

    async def invoke(self, messages: list[BaseMessage], tools: list[ToolSpec]) -> AIMessage:
        bound = self._chat.bind_tools([{"type": "function", "function": {"name": t.name, "description": t.description, "parameters": t.json_schema()}} for t in tools])
        try:
            result = await bound.ainvoke(messages)
        except Exception as exc:
            raise LLMError(f"{self.name} request failed: {exc}") from exc
        self._record(result)
        return result

    async def structured(self, messages: list[BaseMessage], schema: type[T]) -> T:
        runnable = self._chat.with_structured_output(schema, include_raw=True)
        try:
            result = await runnable.ainvoke(messages)
        except Exception as exc:
            raise LLMError(f"{self.name} request failed: {exc}") from exc
        self._record(result.get("raw"))
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
            raise LLMError(f"{self.name} did not return output matching the expected schema: {result.get('parsing_error')}")
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
    provider: str  # anthropic | openai | ollama | none
    model: str | None
    available: bool
    detail: str


async def resolve(settings: Settings) -> Resolution:
    choice = settings.llm_provider.lower()
    if choice == "none":
        return Resolution("none", None, False, "LLM_PROVIDER=none: investigations use the built-in heuristic analysis.")
    if choice in ("anthropic", "auto") and settings.anthropic_api_key:
        return Resolution("anthropic", settings.anthropic_model, True, "Using the Anthropic API.")
    if choice == "anthropic":
        return Resolution("anthropic", settings.anthropic_model, False, "LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set.")
    if choice in ("openai", "auto") and settings.openai_api_key:
        return Resolution("openai", settings.openai_model, True, "Using the OpenAI API.")
    if choice == "openai":
        return Resolution("openai", settings.openai_model, False, "LLM_PROVIDER=openai but OPENAI_API_KEY is not set.")
    models = await ollama_models(settings.ollama_base_url)
    if models is not None and _has(models, settings.ollama_model):
        return Resolution("ollama", settings.ollama_model, True, f"Using local Ollama at {settings.ollama_base_url}.")
    if choice == "ollama":
        why = "is not reachable" if models is None else f"does not have the model '{settings.ollama_model}' (run: ollama pull {settings.ollama_model})"
        return Resolution("ollama", settings.ollama_model, False, f"Ollama at {settings.ollama_base_url} {why}.")
    return Resolution("none", None, False, "No LLM credentials found and no local Ollama model available: investigations use the built-in heuristic analysis. Set ANTHROPIC_API_KEY or OPENAI_API_KEY, or run Ollama, to enable model-driven analysis.")


def build_provider(resolution: Resolution, settings: Settings) -> LLMProvider | None:
    if not resolution.available:
        return None
    if resolution.provider == "anthropic":
        return AnthropicProvider(settings)
    if resolution.provider == "openai":
        from langchain_openai import ChatOpenAI

        return LangChainProvider("openai", settings.openai_model, ChatOpenAI(model=settings.openai_model, api_key=settings.openai_api_key, base_url=settings.openai_base_url or None, temperature=0, timeout=120))
    if resolution.provider == "ollama":
        from langchain_ollama import ChatOllama

        return LangChainProvider("ollama", settings.ollama_model, ChatOllama(model=settings.ollama_model, base_url=settings.ollama_base_url, temperature=0))
    return None

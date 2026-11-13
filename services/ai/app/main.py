"""OpsPilot AI service: embeddings and the investigation agent, called only by the OpsPilot API."""

from __future__ import annotations

import asyncio
import hmac
import json
import logging
import time
from collections.abc import AsyncIterator
from typing import Any

from fastapi import Depends, FastAPI, Header, HTTPException
from fastapi.responses import PlainTextResponse, StreamingResponse
from opentelemetry import context as otel_context
from opentelemetry.trace import Span, StatusCode
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from . import tracing
from .config import EMBEDDING_DIMENSIONS, Settings, get_settings
from .embeddings import embed, resolve_embeddings
from .graph import Context, run_investigation
from .llm import build_provider, resolve, scrub
from .schemas import EmbeddingRequest, InvestigationRequest
from .tools import ToolClient


class JsonFormatter(logging.Formatter):
    """One valid JSON object per line, whatever the message contains."""

    def format(self, record: logging.LogRecord) -> str:
        entry: dict[str, Any] = {"time": self.formatTime(record), "level": record.levelname, "logger": record.name, "message": scrub(record.getMessage())}
        if record.exc_info:
            entry["exception"] = scrub(self.formatException(record.exc_info))[:4000]
        return json.dumps(entry)


_handler = logging.StreamHandler()
_handler.setFormatter(JsonFormatter())
logging.basicConfig(level=get_settings().log_level.upper(), handlers=[_handler], force=True)
# HTTP client libraries log full request URLs at INFO; keep them quiet.
for _noisy in ("httpx", "httpx2", "httpcore", "anthropic", "openai"):
    logging.getLogger(_noisy).setLevel(logging.WARNING)
log = logging.getLogger("opspilot.ai")

app = FastAPI(title="OpsPilot AI service", version="0.1.0")

INVESTIGATIONS = Counter("opspilot_ai_investigations_total", "Investigations run", ["provider", "outcome"])
INVESTIGATION_SECONDS = Histogram("opspilot_ai_investigation_seconds", "Investigation duration", ["provider"], buckets=(1, 2, 5, 10, 20, 40, 80, 160, 320, 640))
EMBEDDED_TEXTS = Counter("opspilot_ai_embedded_texts_total", "Texts embedded", ["provider"])
TOKENS = Counter("opspilot_ai_llm_tokens_total", "LLM tokens used", ["provider", "direction"])
COST = Counter("opspilot_ai_llm_estimated_cost_usd_total", "Estimated model spend in USD (list prices)", ["provider", "model"])

if get_settings().otel_enabled:  # pragma: no cover - optional
    tracing.setup(app, get_settings().otel_exporter_otlp_endpoint)


def require_internal(x_internal_token: str = Header(default=""), settings: Settings = Depends(get_settings)) -> None:
    """Only the OpsPilot API may call this service."""
    if not settings.internal_service_token or not hmac.compare_digest(x_internal_token, settings.internal_service_token):
        raise HTTPException(status_code=401, detail="Invalid internal token")


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok", "service": "opspilot-ai"}


@app.get("/metrics")
async def metrics() -> PlainTextResponse:
    return PlainTextResponse(generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.get("/v1/status", dependencies=[Depends(require_internal)])
async def status(verify: bool = False, settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    llm, emb = await asyncio.gather(resolve(settings), resolve_embeddings(settings))
    verification: dict[str, Any] | None = None
    if verify and llm.available:
        # A metadata lookup, not an inference call: it proves the key and model id without spending tokens.
        ok, detail = await build_provider(llm, settings).verify()  # type: ignore[union-attr]
        verification = {"ok": ok, "detail": detail}
    return {
        "llm": {
            "provider": llm.provider if llm.available else "heuristic", "configuredProvider": llm.provider, "model": llm.model if llm.available else None,
            "available": llm.available, "detail": llm.detail, "verification": verification,
            # Whether a key is present — never the key itself.
            "credentials": {"anthropic": bool(settings.anthropic_api_key), "openai": bool(settings.openai_api_key)},
            "limits": {
                "maxOutputTokensPerCall": settings.ai_max_tokens, "requestTimeoutSeconds": settings.ai_request_timeout_seconds, "maxRetries": settings.ai_max_retries,
                "maxCostUsdPerInvestigation": settings.ai_max_cost_usd_per_investigation, "maxTokensPerInvestigation": settings.ai_max_tokens_per_investigation,
            },
        },
        "embeddings": {"provider": emb.provider, "model": emb.model, "dimensions": EMBEDDING_DIMENSIONS, "detail": emb.detail},
    }


@app.post("/v1/embeddings", dependencies=[Depends(require_internal)])
async def embeddings(body: EmbeddingRequest, settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    try:
        choice, vectors = await embed(body.texts, body.kind, settings)
    except Exception as exc:
        log.exception("embedding failed")
        raise HTTPException(status_code=502, detail=f"Embedding provider failed: {exc}") from exc
    EMBEDDED_TEXTS.labels(choice.provider).inc(len(vectors))
    return {"provider": choice.provider, "model": choice.model, "dimensions": EMBEDDING_DIMENSIONS, "vectors": vectors}


@app.post("/v1/investigations/run", dependencies=[Depends(require_internal)])
async def run(body: InvestigationRequest, settings: Settings = Depends(get_settings)) -> StreamingResponse:
    """Runs one investigation and streams its progress as newline-delimited JSON events."""
    resolution = await resolve(settings)
    provider = build_provider(resolution, settings)
    queue: asyncio.Queue[dict[str, Any] | None] = asyncio.Queue()
    tools = ToolClient(body.api_url, body.tool_token)
    label = provider.name if provider else "heuristic"

    # The response is streamed after this handler returns, so the trace the worker's request
    # arrived with is captured here and handed to the task that does the work.
    parent = otel_context.get_current()

    async def worker() -> None:
        with tracing.tracer.start_as_current_span("investigation", context=parent, attributes={"opspilot.investigation.id": body.investigation_id, "opspilot.engine.provider": label}, record_exception=False, set_status_on_exception=False) as span:
            await investigate(span)

    async def investigate(span: Span) -> None:
        started = time.perf_counter()
        try:
            if not resolution.available and resolution.provider != "none":
                # A provider was explicitly requested but is unusable: say so instead of silently degrading.
                await queue.put({"type": "step", "step": {"type": "error", "title": "Configured LLM provider is unavailable; using rule-based analysis", "detail": resolution.detail, "status": "failed"}})
            unavailable = resolution.provider if not resolution.available and resolution.provider != "none" else None
            await run_investigation(Context(request=body, settings=settings, tools=tools, provider=provider, emit=queue.put, unavailable_provider=unavailable))
            INVESTIGATIONS.labels(label, "completed").inc()
        except asyncio.CancelledError:
            INVESTIGATIONS.labels(label, "cancelled").inc()
            raise
        except Exception as exc:
            log.exception("investigation %s failed", body.investigation_id)
            INVESTIGATIONS.labels(label, "failed").inc()
            # The class only: the message can carry what was asked or what an upstream said.
            span.set_status(StatusCode.ERROR, type(exc).__name__)
            await queue.put({"type": "error", "message": scrub(f"Investigation failed: {exc}")[:500]})
        finally:
            INVESTIGATION_SECONDS.labels(label).observe(time.perf_counter() - started)
            if provider:
                TOKENS.labels(label, "input").inc(provider.usage.input_tokens)
                TOKENS.labels(label, "output").inc(provider.usage.output_tokens)
                TOKENS.labels(label, "cache_read").inc(provider.usage.cache_read_tokens)
                COST.labels(label, provider.model).inc(provider.usage.cost_usd)
                span.set_attributes({"opspilot.llm.input_tokens": provider.usage.input_tokens, "opspilot.llm.output_tokens": provider.usage.output_tokens})
            await tools.aclose()
            await queue.put(None)

    async def stream() -> AsyncIterator[bytes]:
        task = asyncio.create_task(worker())
        try:
            while (event := await queue.get()) is not None:
                yield (json.dumps(event, default=str) + "\n").encode()
        finally:
            # Client went away (e.g. the investigation was cancelled): stop working.
            if not task.done():
                task.cancel()

    return StreamingResponse(stream(), media_type="application/x-ndjson")

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
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Histogram, generate_latest

from .config import EMBEDDING_DIMENSIONS, Settings, get_settings
from .embeddings import embed, resolve_embeddings
from .graph import Context, run_investigation
from .llm import build_provider, resolve
from .schemas import EmbeddingRequest, InvestigationRequest
from .tools import ToolClient

logging.basicConfig(level=get_settings().log_level.upper(), format='{"time":"%(asctime)s","level":"%(levelname)s","logger":"%(name)s","message":"%(message)s"}')
log = logging.getLogger("opspilot.ai")

app = FastAPI(title="OpsPilot AI service", version="0.1.0")

INVESTIGATIONS = Counter("opspilot_ai_investigations_total", "Investigations run", ["provider", "outcome"])
INVESTIGATION_SECONDS = Histogram("opspilot_ai_investigation_seconds", "Investigation duration", ["provider"], buckets=(1, 2, 5, 10, 20, 40, 80, 160, 320, 640))
EMBEDDED_TEXTS = Counter("opspilot_ai_embedded_texts_total", "Texts embedded", ["provider"])
TOKENS = Counter("opspilot_ai_llm_tokens_total", "LLM tokens used", ["provider", "direction"])

if get_settings().otel_enabled:  # pragma: no cover - optional
    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({"service.name": "opspilot-ai"}))
    provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{get_settings().otel_exporter_otlp_endpoint}/v1/traces")))
    trace.set_tracer_provider(provider)
    FastAPIInstrumentor.instrument_app(app)


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
async def status(settings: Settings = Depends(get_settings)) -> dict[str, Any]:
    llm, emb = await asyncio.gather(resolve(settings), resolve_embeddings(settings))
    return {
        "llm": {"provider": llm.provider if llm.available else "heuristic", "configuredProvider": llm.provider, "model": llm.model if llm.available else None, "available": llm.available, "detail": llm.detail},
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

    async def worker() -> None:
        started = time.perf_counter()
        try:
            if not resolution.available and resolution.provider != "none":
                # A provider was explicitly requested but is unusable: say so instead of silently degrading.
                await queue.put({"type": "step", "step": {"type": "error", "title": "Configured LLM provider is unavailable; using rule-based analysis", "detail": resolution.detail, "status": "failed"}})
            await run_investigation(Context(request=body, settings=settings, tools=tools, provider=provider, emit=queue.put))
            INVESTIGATIONS.labels(label, "completed").inc()
        except asyncio.CancelledError:
            INVESTIGATIONS.labels(label, "cancelled").inc()
            raise
        except Exception as exc:
            log.exception("investigation %s failed", body.investigation_id)
            INVESTIGATIONS.labels(label, "failed").inc()
            await queue.put({"type": "error", "message": f"Investigation failed: {exc}"})
        finally:
            INVESTIGATION_SECONDS.labels(label).observe(time.perf_counter() - started)
            if provider:
                TOKENS.labels(label, "input").inc(provider.usage.input_tokens)
                TOKENS.labels(label, "output").inc(provider.usage.output_tokens)
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

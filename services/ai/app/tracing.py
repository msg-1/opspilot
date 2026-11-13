"""Tracing for the AI service.

Everything goes through the OpenTelemetry API, which does nothing unless `setup` installed an
SDK (OTEL_ENABLED=true), so call sites need no checks. The service continues the trace the
worker started and passes it on with every tool call, so one investigation is one trace.

Spans leave the process, so they follow the same rule as logs: no credentials, nothing that
identifies a person, no prompt or question text. `scrub_attributes` enforces that on the way
out for spans made by any library. The cases are in contracts/fixtures/span-scrubbing.json,
which the API's implementation (apps/api/src/lib/tracing.ts) is tested against as well.
"""

from __future__ import annotations

import re
from collections.abc import Mapping, Sequence
from typing import Any

from opentelemetry import propagate, trace
from opentelemetry.sdk.trace import Event, ReadableSpan
from opentelemetry.sdk.trace.export import SpanExporter, SpanExportResult

tracer = trace.get_tracer("opspilot.ai")

REDACTED = "[redacted]"
_SENSITIVE_WORDS = {"authorization", "cookie", "cookies", "token", "secret", "password", "passwd", "credential", "credentials", "apikey", "email", "enduser", "user", "username"}
_ADDRESS_KEYS = {"client.address", "http.client_ip", "net.peer.ip", "net.sock.peer.addr", "network.peer.address"}
_URL_KEYS = {"url.full", "http.url", "http.target", "url.path"}
_STATEMENT_KEYS = {"db.statement", "db.query.text"}
_TOKEN_IN_PATH = re.compile(r"(/(?:invitations|reset|verify)/)[^/?#]+")
_SECRET_IN_TEXT = re.compile(r"Bearer\s+[\w.~+/=-]+|eyJ[\w-]+\.[\w-]+\.[\w-]+|sk-ant-[\w-]+|opk_[\w-]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+")


def _sensitive_key(key: str) -> bool:
    words = re.split(r"[^a-z0-9]+", key.lower())
    for i, word in enumerate(words):
        following = words[i + 1] if i + 1 < len(words) else ""
        if word in _SENSITIVE_WORDS and not (word == "user" and following == "agent"):
            return True
        if word == "api" and following == "key":
            return True
    return False


def _scrub_value(key: str, value: Any) -> Any:
    if not isinstance(value, str):
        return value
    if key in _STATEMENT_KEYS:
        return (value.split() or [""])[0]
    text = _TOKEN_IN_PATH.sub(rf"\1{REDACTED}", re.split(r"[?#]", value)[0]) if key in _URL_KEYS else value
    return _SECRET_IN_TEXT.sub(REDACTED, text)


def scrub_attributes(attributes: Mapping[str, Any] | None) -> dict[str, Any]:
    """What may be exported of a span's attributes."""
    return {
        key: _scrub_value(key, value)
        for key, value in (attributes or {}).items()
        if key != "url.query" and key not in _ADDRESS_KEYS and not _sensitive_key(key)
    }


class ScrubbingExporter(SpanExporter):
    """Wraps an exporter so that nothing reaches it unscrubbed, whichever library made the span."""

    def __init__(self, inner: SpanExporter):
        self._inner = inner

    @staticmethod
    def _clean(span: ReadableSpan) -> ReadableSpan:
        return ReadableSpan(
            name=span.name,
            context=span.context,
            parent=span.parent,
            resource=span.resource,
            attributes=scrub_attributes(span.attributes),
            events=[Event(event.name, scrub_attributes(event.attributes), event.timestamp) for event in span.events],
            links=span.links,
            kind=span.kind,
            status=span.status,
            start_time=span.start_time,
            end_time=span.end_time,
            instrumentation_scope=span.instrumentation_scope,
        )

    def export(self, spans: Sequence[ReadableSpan]) -> SpanExportResult:
        return self._inner.export([self._clean(span) for span in spans])

    def shutdown(self) -> None:
        self._inner.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._inner.force_flush(timeout_millis)


def trace_headers() -> dict[str, str]:
    """The current trace context as HTTP headers (W3C traceparent); empty when not tracing."""
    headers: dict[str, str] = {}
    propagate.inject(headers)
    return headers


def setup(app: Any, endpoint: str) -> None:  # pragma: no cover - needs a collector; exercised by `npm run tracing:up`
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    provider = TracerProvider(resource=Resource.create({"service.name": "opspilot-ai"}))
    provider.add_span_processor(BatchSpanProcessor(ScrubbingExporter(OTLPSpanExporter(endpoint=f"{endpoint}/v1/traces"))))
    trace.set_tracer_provider(provider)
    # Probes and scrapes would bury the traces worth reading, and so would a span for every
    # chunk of a streamed response.
    FastAPIInstrumentor.instrument_app(app, excluded_urls="health,metrics", exclude_spans=["receive", "send"])

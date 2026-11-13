"""Tracing: what is kept out of spans, and that one investigation stays one trace."""

import json
from pathlib import Path

import httpx
import pytest
from fastapi.testclient import TestClient
from opentelemetry import trace
from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import SimpleSpanProcessor
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter
from opentelemetry.trace import StatusCode

from app import main
from app.config import Settings, get_settings
from app.tools import ToolClient, ToolError
from app.tracing import REDACTED, ScrubbingExporter, scrub_attributes, tracer

CASES = json.loads((Path(__file__).parents[3] / "contracts" / "fixtures" / "span-scrubbing.json").read_text())["cases"]
TOKEN = "t" * 40
TRACE_ID, PARENT_ID = "4bf92f3577b34da6a3ce929d0e0e4736", "00f067aa0ba902b7"

# Spans are collected in memory, behind the same scrubber the real exporter sits behind.
# The global provider can be set once per process, so it is module state rather than a fixture.
_memory = InMemorySpanExporter()
_provider = TracerProvider()
_provider.add_span_processor(SimpleSpanProcessor(ScrubbingExporter(_memory)))
trace.set_tracer_provider(_provider)


@pytest.fixture
def spans():
    _memory.clear()
    return _memory.get_finished_spans


@pytest.mark.parametrize("case", CASES, ids=[case["name"] for case in CASES])
def test_span_attributes_are_scrubbed_like_the_api_scrubs_them(case):
    assert scrub_attributes(case["attributes"]) == case["expected"]


def test_every_exported_span_and_event_passes_the_scrubber(spans):
    with tracer.start_as_current_span("lookup", attributes={"http.request.header.authorization": "Bearer abc", "url.full": "http://api:4000/api/v1/logs?q=secret+words", "opspilot.tool.name": "search_logs"}) as span:
        span.add_event("exception", {"exception.message": "rejected ada@example.com"})
    (exported,) = spans()
    assert dict(exported.attributes) == {"url.full": "http://api:4000/api/v1/logs", "opspilot.tool.name": "search_logs"}
    assert dict(exported.events[0].attributes) == {"exception.message": f"rejected {REDACTED}"}
    assert exported.name == "lookup" and exported.context.trace_id == span.get_span_context().trace_id


async def test_a_tool_call_carries_the_trace_to_the_api_and_keeps_its_arguments_out_of_the_span(spans):
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json={"logs": []})

    client = ToolClient("http://api.test", "secret-tool-token", transport=httpx.MockTransport(handler))
    with tracer.start_as_current_span("investigation") as parent:
        await client.call("search_logs", {"from_time": "1h", "query": "card declined for ada@example.com"})
    await client.aclose()

    tool = next(s for s in spans() if s.name == "tool search_logs")
    # The API receives this span as the parent of its own, in the W3C header.
    version, trace_id, span_id, _flags = seen[0].headers["traceparent"].split("-")
    assert (version, int(trace_id, 16), int(span_id, 16)) == ("00", parent.get_span_context().trace_id, tool.context.span_id)
    assert tool.parent.span_id == parent.get_span_context().span_id
    assert dict(tool.attributes) == {"opspilot.tool.name": "search_logs", "http.response.status_code": 200}
    assert seen[0].url.params["q"].startswith("card declined") and "secret-tool-token" not in json.dumps([dict(s.attributes) for s in spans()])


async def test_a_failed_tool_call_is_marked_without_the_upstream_message(spans):
    client = ToolClient("http://api.test", "tok", transport=httpx.MockTransport(lambda _request: httpx.Response(400, json={"error": {"message": "query mentions ada@example.com"}})))
    with pytest.raises(ToolError, match="ada@example.com"):
        await client.call("search_logs", {"from_time": "1h"})
    await client.aclose()
    (tool,) = spans()
    assert (tool.status.status_code, tool.status.description) == (StatusCode.ERROR, "HTTP 400")
    assert tool.events == () and "ada@example.com" not in json.dumps(dict(tool.attributes))


def test_the_investigation_continues_the_trace_it_was_called_with(spans):
    """The response is streamed from a background task; its spans must still join the caller's trace."""
    main.app.dependency_overrides[get_settings] = lambda: Settings(_env_file=None, internal_service_token=TOKEN, ollama_base_url="http://127.0.0.1:9")
    FastAPIInstrumentor.instrument_app(main.app, tracer_provider=_provider)
    try:
        body = {"investigationId": "inv-42", "question": "Why is checkout failing for ada@example.com?", "organizationName": "Org", "apiUrl": "http://127.0.0.1:9", "toolToken": "tool-token-value"}
        headers = {"x-internal-token": TOKEN, "traceparent": f"00-{TRACE_ID}-{PARENT_ID}-01"}
        with TestClient(main.app).stream("POST", "/v1/investigations/run", json=body, headers=headers) as res:
            events = [json.loads(line) for line in res.iter_lines() if line]
        assert events[-1]["type"] == "final"
    finally:
        FastAPIInstrumentor.uninstrument_app(main.app)
        main.app.dependency_overrides.clear()

    recorded = spans()
    investigation = next(s for s in recorded if s.name == "investigation")
    tools = [s for s in recorded if s.name.startswith("tool ")]
    assert format(investigation.context.trace_id, "032x") == TRACE_ID
    assert dict(investigation.attributes) == {"opspilot.investigation.id": "inv-42", "opspilot.engine.provider": "heuristic"}
    # Nothing listens at the API address, so every tool call failed, inside the same trace.
    assert tools and all(s.context.trace_id == investigation.context.trace_id and s.status.status_code is StatusCode.ERROR for s in tools)
    assert all(s.parent is not None for s in tools)
    exported = json.dumps([{"name": s.name, "attributes": dict(s.attributes), "events": [dict(e.attributes) for e in s.events], "status": s.status.description} for s in recorded])
    for forbidden in ("ada@example.com", "checkout failing", "tool-token-value", TOKEN, "x-internal-token"):
        assert forbidden not in exported

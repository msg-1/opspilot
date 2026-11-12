"""Live check of the configured model provider. THIS CALLS THE REAL API AND SPENDS CREDIT.

    uv run python -m app.live_check            # key + model lookup (free), then one tiny inference
    uv run python -m app.live_check --verify   # key + model lookup only: no tokens used

The inference is a single request capped at 64 output tokens (a fraction of a cent on Haiku).
The API key is read from the environment or the repo-root .env and is never printed.
"""

from __future__ import annotations

import argparse
import asyncio
import sys

from langchain_core.messages import HumanMessage

from .config import get_settings
from .llm import LLMError, build_provider, resolve


async def run(verify_only: bool) -> int:
    settings = get_settings()
    resolution = await resolve(settings)
    print(f"Configured provider: {settings.provider_choice}  →  resolved: {resolution.provider}  model: {resolution.model}")
    if not resolution.available or resolution.provider in ("none", "mock"):
        print(f"No live model to check. {resolution.detail}")
        return 2
    provider = build_provider(resolution, settings)
    assert provider is not None
    ok, detail = await provider.verify()
    print(f"Credential and model lookup: {'OK' if ok else 'FAILED'} — {detail}")
    if not ok:
        return 1
    if verify_only:
        print("Skipped inference (--verify). No tokens were used.")
        return 0
    # Keep the one paid call as small as it can be.
    provider._max_tokens = 64  # type: ignore[attr-defined]
    if hasattr(provider, "_effort"):
        provider._effort = "low"  # type: ignore[attr-defined]
    try:
        reply = await provider.invoke([HumanMessage("Reply with exactly: OPSPILOT LIVE CHECK OK")], [])
    except LLMError as exc:
        print(f"Inference: FAILED ({exc.kind}) — {exc}")
        return 1
    u = provider.usage
    cost = f"${u.cost_usd:.6f}" if u.cost_known else "unknown (model not in price table)"
    print(f"Inference: OK — model answered: {str(reply.content).strip()[:80]!r}")
    print(f"Usage: {u.input_tokens} input + {u.output_tokens} output tokens, {u.latency_ms} ms, estimated cost {cost}")
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--verify", action="store_true", help="Only validate the key and model id; make no inference call")
    sys.exit(asyncio.run(run(parser.parse_args().verify)))


if __name__ == "__main__":
    main()

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# Repo-root .env when running from a checkout (services/ai/app/config.py → three levels up).
# Inside the container there is no such file and configuration comes from the environment.
_parents = Path(__file__).resolve().parents
ROOT_ENV = _parents[3] / ".env" if len(_parents) > 3 else Path("/nonexistent/.env")


class Settings(BaseSettings):
    """Configuration, read from the environment and the repo-root .env file."""

    model_config = SettingsConfigDict(env_file=str(ROOT_ENV), env_file_encoding="utf-8", extra="ignore")

    api_url: str = "http://localhost:4000"
    internal_service_token: str = ""

    # Which engine analyses investigations:
    #   auto | anthropic | openai | ollama | deterministic (alias: none) | mock
    # AI_PROVIDER is the preferred name; LLM_PROVIDER is still read for older .env files.
    ai_provider: str = ""
    llm_provider: str = "auto"
    anthropic_api_key: str = ""
    # Lowest-cost current Claude model by default; set claude-sonnet-5-5 or claude-opus-5-5 for harder cases.
    anthropic_model: str = "claude-haiku-5-5"
    # low | medium | high | xhigh | max — depth of reasoning for Claude (more depth costs more tokens)
    anthropic_effort: str = "medium"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str = ""
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1"

    # ---- Request and spending controls (apply to every model provider) ----
    # Upper bound on output tokens for one model call.
    ai_max_tokens: int = 8000
    # Sampling temperature for providers that accept it (OpenAI, Ollama). Current Claude models
    # reject sampling parameters, so it is not sent to Anthropic.
    ai_temperature: float | None = None
    ai_request_timeout_seconds: float = 120.0
    # Retries per call for rate limits, timeouts and server errors (exponential backoff in the SDK).
    ai_max_retries: int = 2
    # One investigation stops calling the model once either limit is reached.
    ai_max_cost_usd_per_investigation: float = 0.50
    ai_max_tokens_per_investigation: int = 400_000
    # Optional price overrides in USD per million tokens, for models missing from the price table.
    ai_price_input_per_mtok: float | None = None
    ai_price_output_per_mtok: float | None = None

    # auto | openai | ollama | local
    embedding_provider: str = "auto"
    openai_embedding_model: str = "text-embedding-3-small"
    ollama_embedding_model: str = "nomic-embed-text"

    # Hard limits for one investigation
    max_tool_rounds: int = 10
    max_tool_calls: int = 24
    max_evidence: int = 60

    otel_enabled: bool = False
    otel_exporter_otlp_endpoint: str = "http://localhost:4318"
    log_level: str = "info"

    # MCP server (run by an external MCP client): authenticates with an OpsPilot API key
    opspilot_api_url: str = ""
    opspilot_api_key: str = ""


    @property
    def provider_choice(self) -> str:
        choice = (self.ai_provider or self.llm_provider or "auto").strip().lower()
        return "none" if choice in ("deterministic", "rule-based", "heuristic") else choice


@lru_cache
def get_settings() -> Settings:
    return Settings()


# USD per million tokens: (input, output, cache read, cache write). Published list prices;
# estimates only — the Anthropic Console is the source of truth for what was billed.
# Haiku 5.5 has a higher tier for prompts over 100K tokens, handled in Usage.record.
PRICING: dict[str, tuple[float, float, float, float]] = {
    "claude-haiku-5-5": (0.10, 0.50, 0.01, 0.125),
    "claude-sonnet-5-5": (2.00, 10.00, 0.10, 2.50),
    "claude-opus-5-5": (4.00, 20.00, 0.20, 5.00),
    "claude-fable-5-2": (8.00, 40.00, 0.20, 10.00),
}
HAIKU_LONG_PROMPT_THRESHOLD = 100_000
HAIKU_LONG_PROMPT_PRICING = (0.50, 2.50, 0.05, 0.625)


EMBEDDING_DIMENSIONS = 768

from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

ROOT_ENV = Path(__file__).resolve().parents[3] / ".env"


class Settings(BaseSettings):
    """Configuration, read from the environment and the repo-root .env file."""

    model_config = SettingsConfigDict(env_file=str(ROOT_ENV), env_file_encoding="utf-8", extra="ignore")

    api_url: str = "http://localhost:4000"
    internal_service_token: str = ""

    # auto | anthropic | openai | ollama | none
    llm_provider: str = "auto"
    anthropic_api_key: str = ""
    anthropic_model: str = "claude-opus-5-5"
    # low | medium | high | xhigh | max — depth of reasoning for Claude
    anthropic_effort: str = "medium"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    openai_base_url: str = ""
    ollama_base_url: str = "http://localhost:11434"
    ollama_model: str = "llama3.1"

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


@lru_cache
def get_settings() -> Settings:
    return Settings()


EMBEDDING_DIMENSIONS = 768

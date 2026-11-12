"""Embedding providers. Every provider returns 768-dimensional, L2-normalised vectors so the
pgvector column has one fixed size. The (provider, model) pair is returned with every result and
stored per document: vectors from different models are never compared with each other.
"""

from __future__ import annotations

import hashlib
import math
import re
from dataclasses import dataclass

from .config import EMBEDDING_DIMENSIONS, Settings
from .llm import _has, ollama_models

_TOKEN = re.compile(r"[a-z0-9_]+")
_SUFFIXES = ("ations", "ation", "ingly", "ments", "ment", "ness", "ings", "ing", "ies", "ed", "es", "ly", "s")


def _stem(word: str) -> str:
    for suffix in _SUFFIXES:
        if len(word) > len(suffix) + 3 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def _bucket(feature: str) -> tuple[int, float]:
    digest = hashlib.blake2b(feature.encode(), digest_size=8).digest()
    value = int.from_bytes(digest, "big")
    return value % EMBEDDING_DIMENSIONS, 1.0 if (value >> 63) & 1 else -1.0


def local_embedding(text: str) -> list[float]:
    """Feature-hashed bag of stemmed words, word bigrams and character trigrams.

    No network and no model download. It captures lexical overlap (including morphological
    variants and partial words), not meaning: "db pool exhausted" will not match "ran out of
    database connections" as well as a neural embedding would. Hybrid search compensates with
    full-text ranking, and switching to OpenAI or Ollama embeddings is a config change + reindex.
    """
    tokens = [_stem(t) for t in _TOKEN.findall(text.lower()) if len(t) > 1]
    weights: dict[str, float] = {}
    for t in tokens:
        weights[f"w:{t}"] = weights.get(f"w:{t}", 0.0) + 1.0
        if len(t) >= 5:
            for i in range(len(t) - 2):
                key = f"c:{t[i : i + 3]}"
                weights[key] = weights.get(key, 0.0) + 0.25
    for a, b in zip(tokens, tokens[1:], strict=False):
        weights[f"b:{a}_{b}"] = weights.get(f"b:{a}_{b}", 0.0) + 0.6
    vector = [0.0] * EMBEDDING_DIMENSIONS
    for feature, count in weights.items():
        index, sign = _bucket(feature)
        vector[index] += sign * (1.0 + math.log(count))  # sub-linear term frequency
    return _normalise(vector)


def _normalise(vector: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vector))
    return [v / norm for v in vector] if norm else vector


def _fit(vector: list[float]) -> list[float]:
    """Pads or truncates to the column size (Matryoshka-style models tolerate truncation)."""
    if len(vector) > EMBEDDING_DIMENSIONS:
        vector = vector[:EMBEDDING_DIMENSIONS]
    elif len(vector) < EMBEDDING_DIMENSIONS:
        vector = vector + [0.0] * (EMBEDDING_DIMENSIONS - len(vector))
    return _normalise(vector)


@dataclass
class EmbeddingChoice:
    provider: str  # openai | ollama | local
    model: str
    detail: str = ""


async def resolve_embeddings(settings: Settings) -> EmbeddingChoice:
    choice = settings.embedding_provider.lower()
    if choice in ("openai", "auto") and settings.openai_api_key:
        return EmbeddingChoice("openai", settings.openai_embedding_model)
    if choice in ("ollama", "auto"):
        models = await ollama_models(settings.ollama_base_url)
        if models is not None and _has(models, settings.ollama_embedding_model):
            return EmbeddingChoice("ollama", settings.ollama_embedding_model)
        if choice == "ollama":
            return EmbeddingChoice("local", "hashed-ngrams-v1", f"Ollama embedding model '{settings.ollama_embedding_model}' is unavailable; using local embeddings.")
    if choice == "openai":
        return EmbeddingChoice("local", "hashed-ngrams-v1", "OPENAI_API_KEY is not set; using local embeddings.")
    return EmbeddingChoice("local", "hashed-ngrams-v1")


async def embed(texts: list[str], kind: str, settings: Settings) -> tuple[EmbeddingChoice, list[list[float]]]:
    choice = await resolve_embeddings(settings)
    if choice.provider == "openai":
        from langchain_openai import OpenAIEmbeddings

        client = OpenAIEmbeddings(model=choice.model, api_key=settings.openai_api_key, base_url=settings.openai_base_url or None, dimensions=EMBEDDING_DIMENSIONS)
        vectors = await (client.aembed_query(texts[0]) if kind == "query" and len(texts) == 1 else client.aembed_documents(texts))
        vectors = [vectors] if kind == "query" and len(texts) == 1 else vectors
        return choice, [_fit(list(v)) for v in vectors]
    if choice.provider == "ollama":
        from langchain_ollama import OllamaEmbeddings

        client = OllamaEmbeddings(model=choice.model, base_url=settings.ollama_base_url)
        # nomic-embed-text expects task prefixes.
        prefix = "search_query: " if kind == "query" else "search_document: "
        vectors = await client.aembed_documents([prefix + t for t in texts])
        return choice, [_fit(list(v)) for v in vectors]
    return choice, [local_embedding(t) for t in texts]

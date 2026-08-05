---
title: Model Pricing
order: 10
---

Pricing table used to estimate API costs per agent session. Values are in **USD per 1 million tokens**.
Edit this file to update rates — the engine reloads it automatically on save.

`cache_read_per_1m` and `cache_write_per_1m` are optional trailing columns for prompt-caching rates
(a cache-read token is far cheaper than a fresh input token; a cache-write/creation token costs more).
Omit them for a model and the engine falls back to a default ratio off that row's `input_per_1m`:
**0.1x for cache reads, 1.25x for cache writes** — Anthropic's published prompt-caching multipliers.
This is an approximation, not exact billing (real cache-write pricing varies by TTL tier).

## Claude Models

| model | input_per_1m | output_per_1m | cache_read_per_1m | cache_write_per_1m |
|---|---|---|---|---|
| claude-opus-4-5 | 75 | 375 | 7.5 | 93.75 |
| claude-opus-4 | 15 | 75 | 1.5 | 18.75 |
| claude-sonnet-4-5 | 3 | 15 | 0.3 | 3.75 |
| claude-sonnet-4 | 3 | 15 | 0.3 | 3.75 |
| claude-haiku-4-5 | 0.8 | 4 | 0.08 | 1 |
| claude-haiku-4 | 0.8 | 4 | 0.08 | 1 |
| claude-3-5-sonnet | 3 | 15 | 0.3 | 3.75 |
| claude-3-5-haiku | 0.8 | 4 | 0.08 | 1 |
| claude-3-opus | 15 | 75 | 1.5 | 18.75 |
| claude-3-sonnet | 3 | 15 | 0.3 | 3.75 |
| claude-3-haiku | 0.25 | 1.25 | 0.025 | 0.3125 |

## Gemini Models

| model | input_per_1m | output_per_1m |
|---|---|---|
| gemini-2.5-pro | 1.25 | 10 |
| gemini-2.5-flash | 0.15 | 0.60 |
| gemini-2.0-pro | 1.25 | 10 |
| gemini-2.0-flash | 0.10 | 0.40 |

Gemini rows omit the cache columns — they use the 0.1x/1.25x default fallback described above.

## Copilot Models

Copilot CLI does not currently report token counts in its JSON output. Cost tracking for Copilot sessions shows token estimates based on output volume rather than exact API billing. Pricing depends on your GitHub Copilot subscription tier (Individual, Business, or Enterprise) — the per-token cost is effectively bundled into your subscription.

## Codex Models

| model | input_per_1m | output_per_1m |
|---|---|---|
| gpt-5.6-terra | 1.25 | 10 |
| gpt-5.6-luna | 1.25 | 10 |
| gpt-5.5 | 1.25 | 10 |
| gpt-5.4-mini | 0.25 | 2 |

Codex CLI reports exact token counts (including a cached-input breakdown), but no direct cost figure — these rows drive the estimate. FLUX-1629: renamed from the fictional gpt-5-codex/gpt-5/gpt-5-mini ids to the real, account-scoped slugs codex.ts now validates against (`~/.codex/models_cache.json`); rates carried over unchanged from the prior rows (mirrors OpenAI's published GPT-5 family pricing, not independently live-probed against codex-cli's own billing) — recheck before trusting it for real billing. Model availability/slugs are account-scoped and may drift; the engine matches by substring, so an unlisted slug (e.g. a new tier) falls back to the Sonnet-class default rate below.

---

The engine matches model names by substring (case-insensitive), longest match wins.
If no match is found, Sonnet-class rates are used as a fallback ($3 / $15 per 1M tokens, with the
same 0.1x/1.25x cache-rate fallback).

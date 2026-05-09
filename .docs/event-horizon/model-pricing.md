---
title: Model Pricing
order: 10
---

Pricing table used to estimate Claude API costs per CLI session. Values are in **USD per 1 million tokens**.
Edit this file to update rates — the engine reloads it automatically on save.

| model | input_per_1m | output_per_1m |
|---|---|---|
| claude-opus-4-5 | 75 | 375 |
| claude-opus-4 | 15 | 75 |
| claude-sonnet-4-5 | 3 | 15 |
| claude-sonnet-4 | 3 | 15 |
| claude-haiku-4-5 | 0.8 | 4 |
| claude-haiku-4 | 0.8 | 4 |
| claude-3-5-sonnet | 3 | 15 |
| claude-3-5-haiku | 0.8 | 4 |
| claude-3-opus | 15 | 75 |
| claude-3-sonnet | 3 | 15 |
| claude-3-haiku | 0.25 | 1.25 |

The engine matches model names by substring (case-insensitive), longest match wins.
If no match is found, Sonnet-class rates are used as a fallback ($3 / $15 per 1M tokens).

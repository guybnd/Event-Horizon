---
title: Decisions (ADRs)
order: 0
---
# Decisions

This folder holds **Architecture Decision Records** — historical reasoning that explains why the current system looks the way it does. ADRs are **not** authoritative descriptions of current behavior. For that, use the reference and architecture pages linked from the [[Documentation Index]].

## When to read an ADR

- You are evaluating whether to revisit a past decision.
- You need the tradeoff context behind a current design choice.
- You are writing a new ADR and want to match the existing shape.

## When **not** to read an ADR

- You are working a ticket and need to know how the system behaves today. Read the relevant `reference/` or `architecture/` page instead.

## Conventions

- File name: `NNNN-short-slug.md`, zero-padded sequence.
- Frontmatter `title` starts with `ADR NNNN — `.
- Top of every ADR carries a `Historical reasoning — skip this for ticket work.` banner pointing to the current authoritative doc.
- ADRs are append-only: don't rewrite history. If a decision is reversed, write a new ADR that supersedes the old one and add a `Superseded by ADR-XXXX` note at the top of the original.

## Index

| ADR | Title | Status |
|-----|-------|--------|
| 0001 | [Storage Modes](0001-storage-modes.md) | Accepted — both modes ship today; default mode under review (FLUX-353) |
| 0002 | [Multi-Agent CLI Research](0002-multi-agent-cli.md) | Accepted — informs current adapter set; orchestration direction under review (FLUX-354) |

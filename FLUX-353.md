---
priority: Medium
effort: S
tags:
  - research
  - architecture
  - sync
assignee: unassigned
id: FLUX-353
title: 'Strategy: pick default storage mode (in-repo vs orphan branch)'
status: Grooming
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-06-03T03:50:35.030Z'
    comment: Created ticket.
---
## Problem

Both in-repo `.flux/` and orphan-branch `.flux-store/` modes ship today. Every storage code path has two branches, every doc has to cover both, every onboarding decision is ambiguous. Maintenance tax is real.

## Plan

- Pick a default for new workspaces. My prior: orphan-branch — keeps ticket churn out of code history without losing git-native sync.
- Treat the other as the legacy path: still supported, not the default, called out as legacy in onboarding and docs.
- Update `bootstrapNewWorkspace` to pick the default and surface a one-time choice during first boot.
- Update docs to lead with the default and treat the other as an opt-in.

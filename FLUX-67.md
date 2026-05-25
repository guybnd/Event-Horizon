---
assignee: unassigned
tags:
  - feature
  - agent
  - workflow
priority: High
effort: L
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T05:36:19.177Z'
    comment: Created ticket.
  - type: status_change
    from: Todo
    to: Grooming
    user: Guy
    date: '2026-05-25T07:34:09.828Z'
title: improve grooming behaviour
status: Grooming
createdBy: Guy
updatedBy: Guy
order: 13
---
## Summary

Overhaul the grooming workflow so the agent produces a fully-fleshed ticket
with structured sections, and presents metadata recommendations as an
interactive approval widget rather than plain text comments.

## Requirements

### 1. Agent produces complete groomed ticket body
- Grooming should output a full ticket body with Summary, Requirements (numbered subsections), Acceptance Criteria, Likely Affected Areas, Dependencies, and Notes
- Agent should analyze the raw request and produce implementation-ready detail, not just a one-line translation of the original request
- Follow the established ticket template format from well-groomed examples (FLUX-18, FLUX-32, FLUX-33 as references)
- Preserve the original request text in a clearly separated section at the bottom

### 2. Interactive metadata recommendation widget
- Agent should propose specific values for: priority, effort, tags, and assignee in a structured format
- Display recommendations as a visual diff widget: `Priority: None → High` with individual accept/reject per field
- User can override any individual recommendation by selecting a different value before confirming
- Confirming applies all accepted metadata changes atomically to the ticket frontmatter

### 3. Grooming-to-Todo transition
- Once the user confirms the groomed ticket body and metadata, the ticket should move to Todo automatically
- If the user rejects the grooming or requests changes, the ticket stays in Grooming for another pass
- The agent should be able to re-groom based on user feedback without losing the conversation context

## Acceptance Criteria

- [ ] Grooming produces a complete ticket body matching the established template format
- [ ] Metadata recommendations appear as an interactive widget, not plain text
- [ ] User can accept/reject individual metadata recommendations
- [ ] Confirmed recommendations apply atomically to the ticket
- [ ] Accepted grooming transitions the ticket to Todo
- [ ] Original request text is preserved in the groomed ticket

## Likely Affected Areas

- `.flux/skills/event-horizon-agent.md`
- `engine/src/index.ts` (grooming workflow)
- `portal/src/components/TaskModal.tsx` (metadata widget)
- `portal/src/components/TaskCard.tsx`

## Original Request
Currently it shows a very basic card translation. grooming should propose a full fleshed new card
we should also have a mechanism where, upon grooming the agent can suggest specific values for things in a dedicated display like: priority - none > priority - high (user can pick a different one) once user confirms it actually applies the recommended set of tags priority effort etc.

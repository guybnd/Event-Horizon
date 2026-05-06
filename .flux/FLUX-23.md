---
id: FLUX-23
title: refine default popup ticket layout
status: Done
priority: High
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - bug
  - feature
history:
  - type: comment
    user: Agent
    date: '2026-05-06T08:41:00.000Z'
    comment: >-
      Captured from Guy's feedback on the current popup view. The default modal
      feels visually heavy, wastes space above the description, and does not
      make good use of the viewport compared with the full view.
    id: c-2026-05-06t08-41-00-000z
  - type: status_change
    from: Grooming
    to: Todo
    user: Guy
    date: '2026-05-06T08:38:03.427Z'
  - type: status_change
    from: Todo
    to: Done
    user: Agent
    date: '2026-05-06T11:50:00.000Z'
  - type: comment
    user: Agent
    date: '2026-05-06T11:50:00.000Z'
    comment: >-
      Refined the default popup modal layout without changing full view. The
      popup header and content spacing are denser, the metadata uses a compact
      wrapping row instead of a tall side stack, and the description area now
      begins higher in the modal. Validated with a portal build and browser
      measurement that the description starts within the upper half of the
      popup.
    id: c-2026-05-06t11-50-00-000z
---
## Summary

Refine the default popup ticket view so it is more compact, better balanced, and uses available space efficiently. The current popup feels bulky and visually awkward: too much vertical space is spent on metadata and framing, while the main editing area starts too low and the layout feels cramped despite the large modal size.

## Problems Observed

- Header chrome is heavy relative to the usable content area
- Title and metadata consume too much top-of-modal space
- The description editor starts too low, leaving an awkward empty block above it
- The right-hand metadata stack feels detached and oversized for the default popup
- Activity/comments are pushed too far down and can feel like an afterthought
- Overall density is low: the modal is large, but not enough of that area is doing useful work

## Requirements

### 1. Make the popup layout denser
- Reduce unnecessary padding and vertical gaps in the default popup mode
- Compress the header and metadata area so the description becomes visible earlier
- Keep the popup readable, but optimize for information density over decorative spacing

### 2. Improve content hierarchy
- Title should remain prominent, but not dominate the top section
- Metadata should feel integrated with the rest of the form, not like a separate block floating beside it
- Description should be the primary focus of the popup experience

### 3. Use space more intentionally
- The top half of the modal should show more actual editable content immediately
- Avoid large empty areas between title, metadata, description, and activity
- Ensure the default popup looks purposeful at common laptop resolutions

### 4. Preserve separation from full view
- The popup should remain a compact quick-edit surface
- The full view can stay more spacious and document-like
- The two modes should feel intentionally different, not like the same layout at two sizes

## Acceptance Criteria

- [ ] Default popup modal shows more useful content above the fold
- [ ] Header and metadata section use less vertical space
- [ ] Description/editor area begins higher in the modal
- [ ] Layout feels visually balanced without large dead areas
- [ ] Activity/comments remain accessible without making the popup feel stretched
- [ ] Full view behavior remains unchanged

## Files Likely to Modify

- `portal/src/components/TaskModal.tsx`
- `portal/src/index.css` or related shared styling if layout tokens need adjustment

## Notes

- This is specifically about the default popup view, not the full-screen ticket view in FLUX-17
- Use the screenshot feedback as the visual reference for what currently feels off

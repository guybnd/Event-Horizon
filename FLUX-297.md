---
assignee: unassigned
tags: []
priority: None
effort: None
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-25T05:30:58.333Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-25T05:31:34.934Z'
    comment: Updated description.
  - type: activity
    user: Guy
    date: '2026-05-25T05:31:49.681Z'
    comment: Updated description.
  - type: activity
    user: Guy
    date: '2026-05-25T05:32:06.512Z'
    comment: Updated description.
title: 'in onboarding, check git version for orphan branch'
status: Grooming
createdBy: Guy
updatedBy: Guy
---
user reported this error  
maybe better to add a check for git version > 2.42

```
Your git version is older than 2.42 — that's when git worktree add --orphan was added.
```

and recommend to install it if not avbailable  

![image (4)](assets/FLUX-297/image-4.png)

also if we identify orphan branch already exist, we shouldnt have an error for it we should just allow continuing.

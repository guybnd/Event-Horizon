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
    date: '2026-05-24T13:09:31.169Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-24T13:10:13.309Z'
    comment: Updated description.
  - type: activity
    user: Guy
    date: '2026-05-24T13:15:23.381Z'
    comment: Updated description.
title: multi agent code review
status: Grooming
createdBy: Guy
updatedBy: Guy
---
we should support opening multiple agent sessions with a dropdown to do :

1\. code review  
2\. code simplification  
3\. updating docs  
4\. reviewing per style guide and updating the style guide  
5\. accessibility reviewer  
  
Something LIke:  
  
  
. Grooming (Refinement & Scoping)

During grooming, the goal is to take a raw idea or bug report and hammer it into something actionable. You want agents that ask hard questions and define the boundaries of the task.

-   **The Interrogator (Requirement Analyst):** Its sole job is to find the holes in the ticket. It reads the description and fires back edge cases, missing error states, and unhandled user paths. It refuses to write code; it only asks "What happens if..."
    
-   **The Architect (System Mapper):** Looks at the proposed feature and identifies which existing systems, scripts, or components (like specific Godot nodes or Unity UI prefabs) it touches. It flags potential architectural collisions before any work starts.
    
-   **The Scopesmith (Task Decomposer):** Takes a massive feature and aggressively slices it into the smallest possible shippable milestones. If a task takes more than a day, the Scopesmith breaks it down further.
    
-   **The Spec Writer:** Translates the loose description into strict Acceptance Criteria (e.g., Given/When/Then formats) that the Review agents will later use to grade the work.
    

## 2\. Todo (Execution & Context Gathering)

When a task moves to "Todo," these agents prepare the workbench and execute the logic.

-   **The Context Scout:** Before anyone writes a line of code, this agent scours the repository (or your documentation) to gather all relevant code snippets, API limits, and dependencies, bundling them up so the execution agent isn't flying blind.
    
-   **The Implementer (Code Builder):** The actual heavy lifter. It takes the groomed specs and the context bundle, and drafts the code, UI layouts, or configurations.
    
-   **The Refactorer:** Works in tandem with the Implementer. While the Implementer writes the logic to make it work, the Refactorer immediately suggests ways to make the code cleaner, more modular, or more performant.
    
-   **The Dependency Manager:** Maps out the critical path. It identifies what other active tickets might block this one and sets up the execution order.
    

## 3\. Review (Validation & QA)

Review agents shouldn't just be "code reviewers"—they should simulate different stakeholders looking at the finished work.

-   **The Pedant (Static Analyst):** An absolute stickler for formatting, naming conventions, and anti-patterns. It flags things like heavy logic in `Update()` loops, missing docstrings, or magic numbers.
    
-   **The Product Proxy (UX/Intent Validator):** This agent doesn't care about the code; it only looks at the output against the original ticket. It asks, "Did this actually solve the user's problem, or did we just build a technically impressive tangent?"
    
-   **The QA Automator:** Takes the Acceptance Criteria generated during Grooming and writes the unit tests or simulation scripts to prove the code actually meets those criteria.
    
-   **The Auditor (Performance & Security):** Specifically hunts for memory leaks, unoptimized database calls, or exposed secrets.  
    
-   The Documenter (Updates relevant project documents)
    

  
  
  
In general, how can we work with :  
  
Claude CLI  
Gemini Cli  
Copilot CLI  
  
to properly implem,ent multi agent workflows? any best practices to look out for? lets do a solid research into this, and split this into the apprropriate multiple sub tasks

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
    date: '2026-05-14T01:34:40.835Z'
    comment: Created ticket.
  - type: activity
    user: Guy
    date: '2026-05-14T01:35:53.403Z'
    comment: Updated description.
  - type: agent_session
    sessionId: c36a5ead-56b4-4e0c-9e98-9c28131afd87
    startedAt: '2026-05-14T01:36:37.083Z'
    status: cancelled
    progress:
      - timestamp: '2026-05-14T01:36:51.854Z'
        message: Working
      - timestamp: '2026-05-14T01:36:52.701Z'
        message: Working
    user: Gemini CLI
    date: '2026-05-14T01:36:37.083Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-05-14T01:37:14.303Z'
  - type: agent_session
    sessionId: 6c71e6b7-c86f-4cc1-b966-2415d2568426
    startedAt: '2026-05-14T02:06:30.843Z'
    status: cancelled
    progress:
      - timestamp: '2026-05-14T02:06:47.351Z'
        message: Working
      - timestamp: '2026-05-14T02:07:01.604Z'
        message: Working
    user: Gemini CLI
    date: '2026-05-14T02:06:30.843Z'
    outcome: Session orphaned (engine down).
    endedAt: '2026-05-14T12:07:00.000Z'
  - type: agent_session
    sessionId: 6b15cf7c-aac9-4c44-b860-fd6c3aa7ddb1
    startedAt: '2026-05-14T02:39:53.666Z'
    status: completed
    progress:
      - timestamp: '2026-05-14T02:40:08.209Z'
        message: Working
      - timestamp: '2026-05-14T02:40:09.238Z'
        message: Working
      - timestamp: '2026-05-14T02:47:45.844Z'
        message: >-
          I have completed the multi-agent UI/UX improvements for ticket
          **FLUX-251**.


          ### Key Improvements:

          1.  **Centralized Agent Selection:** Added a prominent, labeled
          **"Default Agent"** selector in the global header. This selector syncs
          with the project configuration and determines which agent (Claude,
          Gemini, etc.) is used for all automated actions.

          2.  **Global Active Sessions Monitoring:** Re-imagined the "Agents"
          stat in the header as a trigger for a new **`ActiveSessionsPopover`**.
          This allows users to monitor all running agent sessions, view live
          activity, stop sessions, and jump to specific tickets from anywhere in
          the app.

          3.  **Direct Contextual Actions:** Updated the board's right-click
          context menu to allow running agent commands (Implement, Groom,
          Finish, Review) directly using the default agent, instead of just
          copying them to the clipboard.

          4.  **Integrated Grooming Workflow:**
              *   Added a **"Send for Grooming"** action to the card context menu that automatically transitions the ticket status and launches the agent.
              *   Implemented a prominent **"Start Grooming" banner** in the task modal for tickets in the "Grooming" phase, providing a one-click way to start the analysis.
          5.  **Consistent Activation Pipeline:** Ensured all agent activation
          points (right-click, in-ticket buttons, "Return to work", and
          "Finish") strictly use the central agent configuration.

          6.  **Type Safety & Performance:** Fixed various TypeScript type
          mismatches and removed unused code to ensure a clean, production-ready
          build.


          The project now provides a much more intuitive and centralized
          experience for managing multiple AI agents across different tasks.
    user: Gemini CLI
    date: '2026-05-14T02:39:53.666Z'
    outcome: Gemini CLI session ended with code 0.
    endedAt: '2026-05-14T02:47:45.866Z'
title: multi agent UI UX improvement
status: Grooming
createdBy: Guy
updatedBy: Agent
tokenMetadata:
  inputTokens: 4994435
  outputTokens: 23707
  costUSD: 15.33891
  costIsEstimated: true
  cacheReadTokens: 3850805
  cacheCreationTokens: 0
---
need at the top bar a dropdown selector of which default agent to use  
or maybe in settings  
need to apply this agent (i.e claude or gemini etc) to ALL actions:  
1\. right click send to agent  
2\. send to agent from in ticket  
3\. tell agent to finish ticket  
4\. send for grooming  
5\. reopen ticket from ready  
etc.  
need to make sure all agent activation pipelines are pipes through the central module that decides on which agent to use  
  
additionally we need to have a nice selector from it in the dropdown on the ticket, maybe we should move the entire 'agent session' modal to the top bar or somewhere more prominent, need to groom this.  
also need to consider the right click agent activator in the board  
pretend you are the most proficient UI UX expert! how would you approach this topic for ease of use for interactions like this

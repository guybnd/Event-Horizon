---
title: Add lightweight update awareness via GitHub releases
status: Ready
createdBy: Guy
updatedBy: Agent
assignee: Agent
tags:
  - feature
priority: Low
effort: S
implementationLink: ''
subtasks: []
history:
  - type: activity
    user: Guy
    date: '2026-05-07T06:55:00.000Z'
    comment: Created ticket.
  - type: comment
    user: Agent
    date: '2026-05-07T06:55:00.000Z'
    comment: >-
      Split from FLUX-18. This is a polish feature — checking GitHub releases
      for newer versions on startup. Not a blocker for install.
    id: c-2026-05-07t06-55-00-000z-flux-80
  - type: activity
    user: Guy
    date: '2026-05-25T06:18:24.952Z'
    comment: Updated description.
  - type: status_change
    from: Todo
    to: In Progress
    user: Guy
    date: '2026-05-25T06:19:47.241Z'
  - type: comment
    user: Agent
    date: '2026-05-25T06:19:47.241Z'
    comment: >-
      Implementation plan: 1) Create engine/src/update-check.ts with
      non-blocking GitHub releases fetch + semver comparison. 2) Add GET
      /api/update-check route. 3) Fire the check on startup in index.ts. 4) Add
      fetchUpdateCheck to portal api.ts. 5) Add update indicator in Header.tsx.
    id: c-2026-05-25t06-19-47-241z
  - type: agent_session
    sessionId: e3459903-07c4-44cc-85e2-f7b27689d0a7
    startedAt: '2026-05-25T07:08:24.476Z'
    status: completed
    progress:
      - timestamp: '2026-05-25T07:08:39.506Z'
        message: Reading update-check.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\update-check.ts'
      - timestamp: '2026-05-25T07:08:40.020Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T07:08:43.747Z'
        message: Reading notifications.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\engine\src\routes\notifications.ts'
      - timestamp: '2026-05-25T07:08:44.977Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: update-check|updateCheck|UpdateIndicator
            path: 'C:\GitHub\EventHorizon\portal\src'
            output_mode: files_with_matches
      - timestamp: '2026-05-25T07:08:50.172Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: portal/src/components/Header*
            path: 'C:\GitHub\EventHorizon'
      - timestamp: '2026-05-25T07:08:54.656Z'
        message: Reading Header.tsx
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\Header.tsx'
      - timestamp: '2026-05-25T07:08:55.022Z'
        message: Reading
        type: info
      - timestamp: '2026-05-25T07:08:55.668Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: export.*function|export const|apiBase|API_BASE
            path: 'C:\GitHub\EventHorizon\portal\src\api.ts'
            output_mode: content
      - timestamp: '2026-05-25T07:09:00.402Z'
        message: Reading api.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: 'C:\GitHub\EventHorizon\portal\src\api.ts'
            offset: 380
            limit: 50
      - timestamp: '2026-05-25T07:09:09.321Z'
        message: Editing api.ts
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: 'C:\GitHub\EventHorizon\portal\src\api.ts'
            old_string: |-
              export async function resolveConflicts(
                resolutions: Array<{ ticketId: string; strategy: 'use-remote' | 'rename-local' | 'manual'; newContent?: string }>
              ): Promise<{ ok: boolean }> {
                const res = await fetch(`${API_URL}/storage/resolve-conflicts`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ resolutions }),
                });
                if (!res.ok) {
                  const payload = await res.json().catch(() => ({}));
                  throw new Error(payload.error || 'Failed to resolve conflicts');
                }
                return res.json();
              }
            new_string: |-
              export async function resolveConflicts(
                resolutions: Array<{ ticketId: string; strategy: 'use-remote' | 'rename-local' | 'manual'; newContent?: string }>
              ): Promise<{ ok: boolean }> {
                const res = await fetch(`${API_URL}/storage/resolve-conflicts`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ resolutions }),
                });
                if (!res.ok) {
                  const payload = await res.json().catch(() => ({}));
                  throw new Error(payload.error || 'Failed to resolve conflicts');
                }
                return res.json();
              }

              export interface UpdateInfo {
                updateAvailable: boolean;
                currentVersion: string;
                latestVersion: string;
                releaseUrl: string;
              }

              export async function fetchUpdateCheck(): Promise<UpdateInfo> {
                const res = await fetch(`${API_URL}/update-check`);
                if (!res.ok) return { updateAvailable: false, currentVersion: '', latestVersion: '', releaseUrl: '' };
                return res.json();
              }
      - timestamp: '2026-05-25T07:09:10.026Z'
        message: Editing
        type: info
      - timestamp: '2026-05-25T07:09:17.937Z'
        message: Editing Header.tsx
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\Header.tsx'
            old_string: >-
              import { useCallback, useEffect, useRef, useState, memo } from
              'react';

              import { Bell, Rocket, ListTodo, KanbanSquare, Settings as
              SettingsIcon, FileText, Tag, Plus, Power, Bot, Sun, Moon } from
              'lucide-react';

              import { useApp, type AppView } from '../AppContext';

              import { getPromptableStatuses } from '../workflow';

              import { SyncStatusIndicator } from './SyncStatusIndicator';

              import { ActiveSessionsPopover } from './ActiveSessionsPopover';

              import { AnimatePresence } from 'framer-motion';

              import { GlobalSearch } from './GlobalSearch';

              import { LifetimeTokenStats } from './LifetimeTokenStats';
            new_string: >-
              import { useCallback, useEffect, useRef, useState, memo } from
              'react';

              import { Bell, Rocket, ListTodo, KanbanSquare, Settings as
              SettingsIcon, FileText, Tag, Plus, Power, Bot, Sun, Moon,
              ArrowUpCircle } from 'lucide-react';

              import { useApp, type AppView } from '../AppContext';

              import { getPromptableStatuses } from '../workflow';

              import { SyncStatusIndicator } from './SyncStatusIndicator';

              import { ActiveSessionsPopover } from './ActiveSessionsPopover';

              import { AnimatePresence } from 'framer-motion';

              import { GlobalSearch } from './GlobalSearch';

              import { LifetimeTokenStats } from './LifetimeTokenStats';

              import { fetchUpdateCheck, type UpdateInfo } from '../api';
      - timestamp: '2026-05-25T07:09:24.159Z'
        message: Editing Header.tsx
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\Header.tsx'
            old_string: |2-
                const [isPromptPulseActive, setIsPromptPulseActive] = useState(false);
                const [isStoppingService, setIsStoppingService] = useState(false);
                const [isSessionsPopoverOpen, setIsSessionsPopoverOpen] = useState(false);
            new_string: |2-
                const [isPromptPulseActive, setIsPromptPulseActive] = useState(false);
                const [isStoppingService, setIsStoppingService] = useState(false);
                const [isSessionsPopoverOpen, setIsSessionsPopoverOpen] = useState(false);
                const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);

                useEffect(() => {
                  fetchUpdateCheck().then(info => {
                    if (info.updateAvailable) setUpdateInfo(info);
                  }).catch(() => {});
                }, []);
      - timestamp: '2026-05-25T07:09:25.027Z'
        message: Editing
        type: info
      - timestamp: '2026-05-25T07:09:31.006Z'
        message: Editing Header.tsx
        type: tool
        data:
          toolName: Edit
          parameters:
            replace_all: false
            file_path: 'C:\GitHub\EventHorizon\portal\src\components\Header.tsx'
            old_string: |2-
                      <div className="flex shrink-0 items-center gap-3">
                        <Branding />

                        <div className="h-6 w-px bg-gray-200 dark:bg-white/10" />
            new_string: |2-
                      <div className="flex shrink-0 items-center gap-3">
                        <Branding />

                        {updateInfo && (
                          <a
                            href={updateInfo.releaseUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            title={`Update available: v${updateInfo.latestVersion}`}
                            className="flex items-center gap-1 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1 text-[11px] font-semibold text-primary transition-colors hover:bg-primary/10 dark:border-primary/40 dark:bg-primary/10 dark:hover:bg-primary/20"
                          >
                            <ArrowUpCircle className="h-3.5 w-3.5" />
                            <span>v{updateInfo.latestVersion}</span>
                          </a>
                        )}

                        <div className="h-6 w-px bg-gray-200 dark:bg-white/10" />
      - timestamp: '2026-05-25T07:09:36.824Z'
        message: 'Running: cd /c/GitHub/EventHorizon/portal && npx tsc --noEm...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              cd /c/GitHub/EventHorizon/portal && npx tsc --noEmit 2>&1 | head
              -30
            description: Type-check portal
            timeout: 30000
      - timestamp: '2026-05-25T07:09:40.028Z'
        message: Running command
        type: info
      - timestamp: '2026-05-25T07:09:54.971Z'
        message: Working
        type: tool
        data:
          toolName: ToolSearch
          parameters:
            query: 'select:mcp__event-horizon__change_status'
            max_results: 1
      - timestamp: '2026-05-25T07:09:55.032Z'
        message: Working
        type: info
      - timestamp: '2026-05-25T07:10:01.153Z'
        message: Working
        type: tool
        data:
          toolName: mcp__event-horizon__change_status
          parameters:
            ticketId: FLUX-80
            newStatus: Ready
            comment: >-
              Implementation complete. Engine checks GitHub releases on startup
              via a non-blocking fetch with 5s timeout, caches the result, and
              exposes it at GET /api/update-check. Fails silently when offline.
              Portal Header fetches the endpoint on mount and shows a subtle
              clickable badge (version + arrow icon) next to the branding when
              an update is available, linking to the GitHub releases page. All
              acceptance criteria met. Portal type-checks clean; engine
              pre-existing TS errors are unrelated.
      - timestamp: '2026-05-25T07:10:06.933Z'
        message: >-
          Done. FLUX-80 is now in **Ready** status. The implementation covers:


          - **Engine**: `update-check.ts` does a non-blocking GitHub releases
          fetch on startup (5s timeout, silent failure), caches the result, and
          logs a one-liner if newer version exists. `GET /api/update-check`
          exposes the cached result.

          - **Portal**: Header fetches the update endpoint on mount and renders
          a small clickable badge (with version number) next to the branding
          when an update is available, linking directly to the releases page.
    user: Claude Code
    date: '2026-05-25T07:08:24.476Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-05-25T07:10:08.096Z'
  - type: comment
    user: Agent
    comment: >-
      Implementation complete. Engine checks GitHub releases on startup via a
      non-blocking fetch with 5s timeout, caches the result, and exposes it at
      GET /api/update-check. Fails silently when offline. Portal Header fetches
      the endpoint on mount and shows a subtle clickable badge (version + arrow
      icon) next to the branding when an update is available, linking to the
      GitHub releases page. All acceptance criteria met. Portal type-checks
      clean; engine pre-existing TS errors are unrelated.
    date: '2026-05-25T07:10:01.163Z'
    id: c-2026-05-25t07-10-01-163z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-05-25T07:10:01.163Z'
order: 80
id: FLUX-80
tokenMetadata:
  inputTokens: 467663
  outputTokens: 3761
  costUSD: 0.572196
  costIsEstimated: false
  cacheReadTokens: 425333
  cacheCreationTokens: 42280
---
## Summary

On startup, make a single GET request to the GitHub releases API to check if a newer version of Event Horizon is available. Show a one-line console message and optionally surface it in the portal header. Fail silently when offline.

## Requirements

### 1\. Version check on startup

-   On engine startup, fetch `https://api.github.com/repos/{owner}/{repo}/releases/latest`
    
-   Compare the remote version tag against the local `package.json` version
    
-   Use a non-blocking async call — never delay startup for the network check
    

### 2\. Notification

-   If a newer version exists, log a one-line message to the console, and show indicator
    
-   Optionally expose the update info via a new `GET /api/update-check` endpoint so the portal can show it in the header
    
-   If offline or the request fails, do nothing — no errors, no warnings
    

### 3\. Portal indicator

-   If the engine reports an available update, show a subtle indicator in the portal header (e.g. a small badge or text) that is clickable
    
-   The indicator should link to the releases page
    

## Acceptance Criteria

-   Engine checks GitHub releases on startup
    
-   A newer version is reported via console log
    
-   The check fails silently when offline
    
-   Startup is never blocked or delayed by the check
    
-   Optionally the portal shows an update indicator
    

## Likely Affected Areas

-   `engine/src/index.ts` — startup update check
    
-   `portal/src/components/Header.tsx` (optional)
    
-   `portal/src/api.ts` (optional)
    

## Parent

-   Subtask of FLUX-18

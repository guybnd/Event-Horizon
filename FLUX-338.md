---
title: MCP tools for branch management
status: In Progress
priority: Medium
effort: S
assignee: unassigned
tags:
  - feature
  - engine
  - mcp
createdBy: Agent
updatedBy: Agent
history:
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:43.898Z'
    comment: Created ticket.
  - type: activity
    user: Agent
    date: '2026-05-29T01:25:43.898Z'
    comment: Created as subtask of FLUX-292.
  - type: activity
    user: Agent
    date: '2026-06-03T01:53:49.449Z'
    comment: Updated description.
  - type: status_change
    from: Todo
    to: In Progress
    user: Agent
    date: '2026-06-03T03:01:06.819Z'
  - type: comment
    user: Agent
    comment: >-
      All three MCP tools implemented in `engine/src/mcp-server.ts` as part of
      FLUX-337: `create_branch` (creates branch, stores name on ticket,
      broadcasts update), `get_branch` (returns name + exists + aheadCount +
      behindCount), `delete_branch` (refuses unmerged unless force=true). No
      `switch_branch` tool per design decision. Depends on FLUX-337 which is
      also at Ready.
    date: '2026-06-03T03:01:12.211Z'
    id: c-2026-06-03t03-01-12-211z
  - type: status_change
    from: In Progress
    to: Ready
    user: Agent
    date: '2026-06-03T03:01:12.211Z'
  - type: agent_session
    sessionId: 63ccab44-6fa0-4738-ab13-3abcba7cfc03
    startedAt: '2026-06-03T03:02:01.980Z'
    status: completed
    progress:
      - timestamp: '2026-06-03T03:02:12.283Z'
        message: Working
        type: tool
        data:
          toolName: Skill
          parameters:
            skill: code-review
            args: '--persona angry-linus'
      - timestamp: '2026-06-03T03:02:16.864Z'
        message: 'Running: git diff HEAD~1...HEAD 2>/dev/null || git diff HEA...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: git diff HEAD~1...HEAD 2>/dev/null || git diff HEAD 2>/dev/null
            description: Get diff for review
      - timestamp: '2026-06-03T03:02:16.999Z'
        message: Running command
        type: info
      - timestamp: '2026-06-03T03:02:27.050Z'
        message: Reading branch-manager.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/branch-manager.ts
      - timestamp: '2026-06-03T03:02:32.000Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T03:02:56.825Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Angle A — line-by-line diff scan for correctness bugs
            prompt: >
              You are reviewing a diff for correctness bugs. Read every hunk
              line by line and look for: inverted/wrong conditions, off-by-one,
              null/undefined deref, missing `await`, falsy-zero checks,
              wrong-variable copy-paste, error swallowed in catch, unescaped
              regex metachars.


              Also read the enclosing functions for each hunk — bugs in
              unchanged lines of a touched function are in scope.


              Return up to 8 candidate findings as JSON array: [{ "file":
              "path", "line": N, "summary": "...", "failure_scenario": "..." }]


              ## branch-manager.ts (new file)

              ```ts

              import { execFile } from 'child_process';

              import { promisify } from 'util';

              import { workspaceRoot } from './workspace.js';


              const execFileAsync = promisify(execFile);


              function git(args: string[]): Promise<{ stdout: string; stderr:
              string }> {
                return execFileAsync('git', ['-C', workspaceRoot!, ...args], { windowsHide: true });
              }


              export function slugify(title: string): string {
                return title
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 60);
              }


              export function branchName(ticketId: string, title: string):
              string {
                return `flux/${ticketId}-${slugify(title)}`;
              }


              export async function createTicketBranch(ticketId: string, title:
              string, baseBranch = 'master'): Promise<string> {
                const name = branchName(ticketId, title);
                await git(['checkout', '-b', name, baseBranch]);
                return name;
              }


              export async function getTicketBranchStatus(name: string):
              Promise<{ exists: boolean; aheadCount: number; behindCount: number
              }> {
                try {
                  await git(['rev-parse', '--verify', name]);
                } catch {
                  return { exists: false, aheadCount: 0, behindCount: 0 };
                }

                try {
                  const { stdout } = await git(['rev-list', '--left-right', '--count', `master...${name}`]);
                  const parts = stdout.trim().split(/\s+/);
                  const behindCount = parseInt(parts[0] ?? '0', 10) || 0;
                  const aheadCount = parseInt(parts[1] ?? '0', 10) || 0;
                  return { exists: true, aheadCount, behindCount };
                } catch {
                  return { exists: true, aheadCount: 0, behindCount: 0 };
                }
              }


              export async function deleteTicketBranch(name: string, force =
              false): Promise<void> {
                const flag = force ? '-D' : '-d';
                await git(['branch', flag, name]);
              }


              export async function checkGhAuth(): Promise<boolean> {
                try {
                  await execFileAsync('gh', ['auth', 'status'], { windowsHide: true });
                  return true;
                } catch {
                  return false;
                }
              }


              export async function createPullRequest(branchName: string, title:
              string, body: string): Promise<string> {
                await execFileAsync('git', ['-C', workspaceRoot!, 'push', '-u', 'origin', branchName], { windowsHide: true });
                const { stdout } = await execFileAsync('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branchName], { windowsHide: true });
                return stdout.trim();
              }

              ```


              ## mcp-server.ts additions (the new branch tools section)

              ```ts
                server.tool(
                  'create_branch',
                  'Create a git feature branch for a ticket and store its name on the ticket',
                  {
                    ticketId: z.string().describe('Ticket ID'),
                    baseBranch: z.string().optional().describe('Base branch (default: master)'),
                  },
                  async ({ ticketId, baseBranch }) => {
                    const task = tasksCache[ticketId];
                    if (!task) return errorResult(`Ticket ${ticketId} not found`);
                    if (task.branch) return errorResult(`Ticket ${ticketId} already has branch: ${task.branch}`);

                    try {
                      const branch = await createTicketBranch(ticketId, task.title || ticketId, baseBranch || 'master');
                      await updateTaskWithHistory(ticketId, { updatedBy: 'Agent', extraFields: { branch } });
                      broadcastEvent('taskUpdated', { id: ticketId });
                      return jsonResult({ branch });
                    } catch (err: any) {
                      return errorResult(`Failed to create branch: ${err.message}`);
                    }
                  },
                );

                server.tool(
                  'get_branch',
                  'Get the branch status for a ticket — name, existence, and ahead/behind counts vs master',
                  {
                    ticketId: z.string().describe('Ticket ID'),
                  },
                  async ({ ticketId }) => {
                    const task = tasksCache[ticketId];
                    if (!task) return errorResult(`Ticket ${ticketId} not found`);

                    const name: string | undefined = task.branch;
                    if (!name) return jsonResult({ name: null, exists: false, aheadCount: 0, behindCount: 0 });

                    try {
                      const status = await getTicketBranchStatus(name);
                      return jsonResult({ name, ...status });
                    } catch (err: any) {
                      return errorResult(`Failed to get branch status: ${err.message}`);
                    }
                  },
                );

                server.tool(
                  'delete_branch',
                  'Delete the git branch associated with a ticket. Refuses unmerged branches unless force=true.',
                  {
                    ticketId: z.string().describe('Ticket ID'),
                    force: z.boolean().optional().describe('Force delete even if unmerged (default: false)'),
                  },
                  async ({ ticketId, force }) => {
                    const task = tasksCache[ticketId];
                    if (!task) return errorResult(`Ticket ${ticketId} not found`);

                    const name: string | undefined = task.branch;
                    if (!name) return errorResult(`Ticket ${ticketId} has no associated branch`);

                    try {
                      await deleteTicketBranch(name, force ?? false);
                      return textResult(`Branch ${name} deleted`);
                    } catch (err: any) {
                      return errorResult(`Failed to delete branch: ${err.message}`);
                    }
                  },
                );
              ```


              ## finish_ticket changes in mcp-server.ts

              ```ts
                    let finalLink = implementationLink;
                    let noteForComment = '';

                    // If ticket has a branch, attempt to create a PR
                    if (task.branch) {
                      const ghAvailable = await checkGhAuth();
                      if (ghAvailable) {
                        try {
                          const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
                          const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody);
                          finalLink = prUrl;
                        } catch (err: any) {
                          noteForComment = `\n\n⚠️ PR creation failed: ${err.message}. Commit: ${implementationLink}`;
                          finalLink = implementationLink;
                        }
                      } else {
                        noteForComment = `\n\n⚠️ PR creation skipped — gh not configured. Commit: ${implementationLink}. Open a PR manually when ready.`;
                        finalLink = implementationLink;
                      }
                    }
              ```


              ## routes/tasks.ts additions

              ```ts

              router.post('/:id/branch', async (req, res) => {
                const { id } = req.params;
                const task = tasksCache[id];
                if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

                const title: string = task.title || id;
                const baseBranch: string = req.body?.baseBranch || 'master';

                try {
                  const branch = await createTicketBranch(id, title, baseBranch);
                  await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch } });
                  res.json({ branch });
                } catch (err: any) {
                  res.status(500).json({ error: err.message });
                }
              });


              router.get('/:id/branch', async (req, res) => {
                const { id } = req.params;
                const task = tasksCache[id];
                if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

                const name: string | undefined = task.branch;
                if (!name) return res.json({ name: null, exists: false, aheadCount: 0, behindCount: 0 });

                try {
                  const status = await getTicketBranchStatus(name);
                  res.json({ name, ...status });
                } catch (err: any) {
                  res.status(500).json({ error: err.message });
                }
              });


              router.delete('/:id/branch', async (req, res) => {
                const { id } = req.params;
                const task = tasksCache[id];
                if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

                const name: string | undefined = task.branch;
                if (!name) return res.status(400).json({ error: 'No branch associated with this ticket' });

                const force: boolean = req.body?.force === true;

                try {
                  await deleteTicketBranch(name, force);
                  res.json({ deleted: name });
                } catch (err: any) {
                  res.status(500).json({ error: err.message });
                }
              });

              ```
      - timestamp: '2026-06-03T03:03:00.171Z'
        message: Reading branch-manager.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/branch-manager.ts
      - timestamp: '2026-06-03T03:03:02.001Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:03:10.815Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Angle B — removed-behavior auditor
            prompt: >
              You are reviewing a diff for removed behaviors that are not
              re-established. For every line the diff DELETES or replaces, name
              the invariant or behavior it enforced, then search the new code
              for where that invariant is re-established. If you can't find it,
              that's a candidate.


              Return up to 8 candidates as JSON: [{ "file": "path", "line": N,
              "summary": "...", "failure_scenario": "..." }]


              ## The diff (mcp-server.ts finish_ticket section — the deleted
              line is the key one):


              BEFORE:

              ```ts
                    const entries = [{ type: 'comment', user: 'Agent', comment: completionComment, date: new Date().toISOString() }];
                    const result = await updateTaskWithHistory(ticketId, {
                      entries,
                      updatedBy: 'Agent',
                      nextStatus: 'Done',
                      extraFields: { implementationLink },
                    });

                    if (!result) return errorResult(`Failed to finish ${ticketId}`);
                    broadcastEvent('taskUpdated', { id: ticketId });
                    return textResult(`${ticketId} finished → Done (link: ${implementationLink})`);
              ```


              AFTER:

              ```ts
                    let finalLink = implementationLink;
                    let noteForComment = '';

                    // If ticket has a branch, attempt to create a PR
                    if (task.branch) {
                      const ghAvailable = await checkGhAuth();
                      if (ghAvailable) {
                        try {
                          const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
                          const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody);
                          finalLink = prUrl;
                        } catch (err: any) {
                          noteForComment = `\n\n⚠️ PR creation failed: ${err.message}. Commit: ${implementationLink}`;
                          finalLink = implementationLink;
                        }
                      } else {
                        noteForComment = `\n\n⚠️ PR creation skipped — gh not configured. Commit: ${implementationLink}. Open a PR manually when ready.`;
                        finalLink = implementationLink;
                      }
                    }

                    const entries = [{ type: 'comment', user: 'Agent', comment: completionComment + noteForComment, date: new Date().toISOString() }];
                    const result = await updateTaskWithHistory(ticketId, {
                      entries,
                      updatedBy: 'Agent',
                      nextStatus: 'Done',
                      extraFields: { implementationLink: finalLink },
                    });

                    if (!result) return errorResult(`Failed to finish ${ticketId}`);
                    broadcastEvent('taskUpdated', { id: ticketId });
                    return textResult(`${ticketId} finished → Done (link: ${finalLink})`);
              ```


              Also consider: the `finish_ticket` handler context. The
              implementationLink param might be an empty string or undefined. In
              the new code, if `task.branch` is set and gh is available,
              `finalLink` is set to the PR URL. But what if `implementationLink`
              was the original argument passed by the user — is there any guard
              if it's empty/undefined but a branch exists? Consider: if
              `implementationLink` is undefined/empty AND gh is not available,
              `finalLink` stays as the original undefined/empty value. Also:
              `createPullRequest` pushes a branch — it's called inside
              `finish_ticket` without any check on whether the working tree is
              dirty or if there's anything to push.


              Also look at the new `create_branch` tool: it calls
              `createTicketBranch()` which runs `git checkout -b name
              baseBranch` — this switches the working directory's HEAD. But
              `delete_branch` does NOT clear `task.branch` from the ticket after
              deleting. Is this a removed invariant?
      - timestamp: '2026-06-03T03:03:14.537Z'
        message: Reading mcp-server.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/mcp-server.ts
      - timestamp: '2026-06-03T03:03:17.003Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:03:21.650Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Angle C — cross-file tracer for callers and callees
            prompt: >
              You are reviewing a code change for cross-file correctness issues.
              Look for: new preconditions that break call sites, changed return
              shapes, new exceptions, timing/ordering dependencies.


              Key code under review:


              ## branch-manager.ts

              ```ts

              export async function createTicketBranch(ticketId: string, title:
              string, baseBranch = 'master'): Promise<string> {
                const name = branchName(ticketId, title);
                await git(['checkout', '-b', name, baseBranch]);  // THIS SWITCHES THE WORKING DIRECTORY
                return name;
              }


              export async function getTicketBranchStatus(name: string):
              Promise<...> {
                // hardcodes 'master' as the comparison base
                const { stdout } = await git(['rev-list', '--left-right', '--count', `master...${name}`]);
                ...
              }


              export async function deleteTicketBranch(name: string, force =
              false): Promise<void> {
                const flag = force ? '-D' : '-d';
                await git(['branch', flag, name]);
              }

              ```


              ## mcp-server.ts create_branch tool:

              ```ts
                  async ({ ticketId, baseBranch }) => {
                    const task = tasksCache[ticketId];
                    if (!task) return errorResult(`Ticket ${ticketId} not found`);
                    if (task.branch) return errorResult(`Ticket ${ticketId} already has branch: ${task.branch}`);

                    try {
                      const branch = await createTicketBranch(ticketId, task.title || ticketId, baseBranch || 'master');
                      await updateTaskWithHistory(ticketId, { updatedBy: 'Agent', extraFields: { branch } });
                      broadcastEvent('taskUpdated', { id: ticketId });
                      return jsonResult({ branch });
                    } catch (err: any) {
                      return errorResult(`Failed to create branch: ${err.message}`);
                    }
                  },
              ```


              ## routes/tasks.ts (same pattern, HTTP variant):

              ```ts

              router.post('/:id/branch', async (req, res) => {
                ...
                const branch = await createTicketBranch(id, title, baseBranch);
                await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch } });
                ...
              });

              ```


              Questions to investigate:

              1. `createTicketBranch` calls `git checkout -b`. This changes the
              git HEAD of the repository. This is a server process — does this
              affect any other concurrent operations? Is this safe to call from
              a server handler?

              2. `getTicketBranchStatus` hardcodes `master` as the comparison
              base. What if the repo uses `main` as its default branch? What if
              `master` doesn't exist?

              3. `delete_branch` in both MCP tool and HTTP handler: after
              deleting the branch, the ticket's `task.branch` field is NOT
              cleared. What happens if `get_branch` or `finish_ticket` is called
              after deletion?

              4. `create_branch` in the HTTP route does NOT check `if
              (task.branch)` before creating — unlike the MCP tool. What happens
              if called twice?

              5. The MCP `finish_ticket` calls `createPullRequest` which does
              `git push -u origin branchName`. Is there any check that the
              current HEAD is on that branch before pushing?


              Return up to 8 findings as JSON: [{ "file": "path", "line": N,
              "summary": "...", "failure_scenario": "..." }]
      - timestamp: '2026-06-03T03:03:24.593Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: branch
            path: /Users/guy/Event-Horizon/portal/src/types.ts
            output_mode: content
      - timestamp: '2026-06-03T03:03:25.486Z'
        message: Reading branch-manager.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/branch-manager.ts
      - timestamp: '2026-06-03T03:03:32.004Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:03:35.691Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Angle D — language pitfall specialist (JS/TS)
            prompt: >
              You are reviewing TypeScript/Node.js code for classic language
              pitfalls. Look for: falsy-zero bugs, `==` coercion, closure
              captures, async/await mistakes, unhandled rejections, error
              message swallowing, process.exit side effects, exec injection.


              ## Code under review:


              ### branch-manager.ts

              ```ts

              import { execFile } from 'child_process';

              import { promisify } from 'util';

              import { workspaceRoot } from './workspace.js';


              const execFileAsync = promisify(execFile);


              function git(args: string[]): Promise<{ stdout: string; stderr:
              string }> {
                return execFileAsync('git', ['-C', workspaceRoot!, ...args], { windowsHide: true });
              }


              export function branchName(ticketId: string, title: string):
              string {
                return `flux/${ticketId}-${slugify(title)}`;
              }


              export async function getTicketBranchStatus(name: string) {
                try {
                  await git(['rev-parse', '--verify', name]);
                } catch {
                  return { exists: false, aheadCount: 0, behindCount: 0 };
                }

                try {
                  const { stdout } = await git(['rev-list', '--left-right', '--count', `master...${name}`]);
                  const parts = stdout.trim().split(/\s+/);
                  const behindCount = parseInt(parts[0] ?? '0', 10) || 0;
                  const aheadCount = parseInt(parts[1] ?? '0', 10) || 0;
                  return { exists: true, aheadCount, behindCount };
                } catch {
                  return { exists: true, aheadCount: 0, behindCount: 0 };
                }
              }


              export async function checkGhAuth(): Promise<boolean> {
                try {
                  await execFileAsync('gh', ['auth', 'status'], { windowsHide: true });
                  return true;
                } catch {
                  return false;
                }
              }


              export async function createPullRequest(branchName: string, title:
              string, body: string): Promise<string> {
                await execFileAsync('git', ['-C', workspaceRoot!, 'push', '-u', 'origin', branchName], { windowsHide: true });
                const { stdout } = await execFileAsync('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branchName], { windowsHide: true });
                return stdout.trim();
              }

              ```


              ### mcp-server.ts finish_ticket PR creation block:

              ```ts
                    if (task.branch) {
                      const ghAvailable = await checkGhAuth();
                      if (ghAvailable) {
                        try {
                          const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
                          const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody);
                          finalLink = prUrl;
                        } catch (err: any) {
                          noteForComment = `\n\n⚠️ PR creation failed: ${err.message}. Commit: ${implementationLink}`;
                          finalLink = implementationLink;
                        }
                      }
                    }
              ```


              Focus on:

              1. `workspaceRoot!` — non-null assertion. What happens if
              workspaceRoot is null/undefined at call time? (The MCP server
              calls `activateWorkspace` before tools are invoked, but
              `branch-manager.ts` imports the value directly at module load time
              — is it a live binding or a snapshot?)

              2. `parseInt(parts[0] ?? '0', 10) || 0` — `|| 0` means if parseInt
              returns 0 legitimately, it stays 0. Fine. But what if `parts` has
              fewer than 2 elements? `parts[1]` could be `undefined`, `?? '0'`
              handles it. OK or not?

              3. `execFileAsync('git', [...args])` — execFile is safe from shell
              injection (no shell=true). But `workspaceRoot!` with `!` — if
              undefined, spreads as `undefined` into array args?

              4. In `createPullRequest`: `stdout.trim()` — what if stdout is
              empty (e.g., gh outputs nothing but succeeds)? Returns empty
              string, stored as `finalLink`. Caller uses it as a URL.

              5. `checkGhAuth()` is called on startup AND inside
              `finish_ticket`. The startup call is fire-and-forget
              `.catch(()=>{})`. If `gh` command is not installed (not just not
              authenticated), does `execFileAsync` throw an error that gets
              caught, returning false? Or does it behave differently?


              Return up to 8 findings as JSON: [{ "file": "path", "line": N,
              "summary": "...", "failure_scenario": "..." }]
      - timestamp: '2026-06-03T03:03:39.240Z'
        message: Reading branch-manager.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/branch-manager.ts
      - timestamp: '2026-06-03T03:03:47.005Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:03:48.229Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Angle E — wrapper/proxy correctness and state consistency
            prompt: >
              You are reviewing code for state consistency issues, stale cache
              bugs, and missing cache invalidation.


              ## Context


              The system has a `tasksCache` — an in-memory cache of ticket
              objects. The new branch tools modify ticket state via
              `updateTaskWithHistory`. Review for state consistency issues.


              ### create_branch MCP tool:

              ```ts

              async ({ ticketId, baseBranch }) => {
                const task = tasksCache[ticketId];
                if (!task) return errorResult(`Ticket ${ticketId} not found`);
                if (task.branch) return errorResult(`Ticket ${ticketId} already has branch: ${task.branch}`);  // reads cache

                try {
                  const branch = await createTicketBranch(ticketId, task.title || ticketId, baseBranch || 'master');
                  await updateTaskWithHistory(ticketId, { updatedBy: 'Agent', extraFields: { branch } });  // updates cache
                  broadcastEvent('taskUpdated', { id: ticketId });
                  return jsonResult({ branch });
                } catch (err: any) {
                  return errorResult(`Failed to create branch: ${err.message}`);
                }
              },

              ```


              ### delete_branch MCP tool:

              ```ts

              async ({ ticketId, force }) => {
                const task = tasksCache[ticketId];
                if (!task) return errorResult(`Ticket ${ticketId} not found`);

                const name: string | undefined = task.branch;
                if (!name) return errorResult(`Ticket ${ticketId} has no associated branch`);

                try {
                  await deleteTicketBranch(name, force ?? false);
                  return textResult(`Branch ${name} deleted`);  // NOTE: does NOT clear task.branch from cache/disk
                } catch (err: any) {
                  return errorResult(`Failed to delete branch: ${err.message}`);
                }
              },

              ```


              ### HTTP POST /:id/branch (no duplicate check):

              ```ts

              router.post('/:id/branch', async (req, res) => {
                const { id } = req.params;
                const task = tasksCache[id];
                if (!task) return res.status(404).json({ error: `Ticket ${id} not found` });

                const title: string = task.title || id;
                const baseBranch: string = req.body?.baseBranch || 'master';

                try {
                  const branch = await createTicketBranch(id, title, baseBranch);  // no check for existing branch
                  await updateTaskWithHistory(id, { updatedBy: 'Agent', extraFields: { branch } });
                  res.json({ branch });
                } catch (err: any) {
                  res.status(500).json({ error: err.message });
                }
              });

              ```


              ### finish_ticket with PR creation:

              ```ts

              if (task.branch) {
                // createPullRequest pushes to origin and creates PR
                // but there's no check: are we currently ON that branch?
                // createTicketBranch does `git checkout -b name baseBranch` which switches HEAD
                // what if the agent is on a different branch when finish_ticket is called?
              }

              ```


              Questions:

              1. `delete_branch` deletes the git branch but does NOT update
              `task.branch` to null/undefined in the ticket. After deletion,
              `get_branch` will find `task.branch` is set, call
              `getTicketBranchStatus`, and the git branch doesn't exist — but
              `getTicketBranchStatus` handles that gracefully returning `exists:
              false`. However, `finish_ticket` will also find `task.branch` and
              try to push/PR a deleted branch. Is this a bug?

              2. Race condition: two concurrent `create_branch` calls for the
              same ticket — both read `task.branch` as undefined, both call
              `createTicketBranch`, one wins and the other fails at git level.
              Is the failure handled?

              3. HTTP POST `/:id/branch` has no duplicate branch check (unlike
              MCP tool). Can it overwrite an existing branch name in the ticket?


              Return up to 8 findings as JSON: [{ "file": "path", "line": N,
              "summary": "...", "failure_scenario": "..." }]
      - timestamp: '2026-06-03T03:03:50.887Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/src/**/*.ts
      - timestamp: '2026-06-03T03:03:53.921Z'
        message: Reading branch-manager.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/branch-manager.ts
      - timestamp: '2026-06-03T03:03:56.832Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: 'Angle — Reuse: does the diff re-implement existing helpers?'
            prompt: >
              You are reviewing a code diff for reuse opportunities — places
              where the new code re-implements something the codebase already
              has.


              ## New code under review:


              ### branch-manager.ts

              ```ts

              export function slugify(title: string): string {
                return title
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 60);
              }


              export function branchName(ticketId: string, title: string):
              string {
                return `flux/${ticketId}-${slugify(title)}`;
              }

              ```


              ### mcp-server.ts (import line):

              ```ts

              import { createTicketBranch, getTicketBranchStatus,
              deleteTicketBranch, createPullRequest, checkGhAuth, branchName }
              from './branch-manager.js';

              ```


              Note that `branchName` is imported but not used anywhere in
              mcp-server.ts (check the diff — the only uses of branch name in
              mcp-server.ts come from `task.branch` which was stored when the
              branch was created, or from `createTicketBranch` which returns the
              branch name directly).


              Also note that the HTTP routes in tasks.ts import from
              branch-manager but do NOT import `branchName` — they use
              `task.title || id` to pass to `createTicketBranch`. This means if
              there's ever a need to display/compute the would-be branch name
              without creating it, only mcp-server has the import (unused).


              Return findings as JSON: [{ "file": "path", "line": N, "summary":
              "...", "failure_scenario": "..." }]


              Look specifically at:

              1. Is `branchName` imported but unused in mcp-server.ts?

              2. Does `slugify` already exist elsewhere in the codebase? (You
              can't grep, but note the question)

              3. Does the `createPullRequest` function duplicate any existing
              push/PR logic elsewhere?

              4. Does `checkGhAuth` on startup duplicate any existing startup
              health-check pattern?
      - timestamp: '2026-06-03T03:03:58.859Z'
        message: Reading mcp-server.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/mcp-server.ts
      - timestamp: '2026-06-03T03:04:02.005Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:04:04.294Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Angle — Simplification of the new branch code
            prompt: >
              You are reviewing code for unnecessary complexity. Flag redundant
              state, copy-paste with slight variation, dead code, deep nesting.


              ## Code under review:


              ### mcp-server.ts finish_ticket changes:

              ```ts
                    let finalLink = implementationLink;
                    let noteForComment = '';

                    if (task.branch) {
                      const ghAvailable = await checkGhAuth();
                      if (ghAvailable) {
                        try {
                          const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
                          const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody);
                          finalLink = prUrl;
                        } catch (err: any) {
                          noteForComment = `\n\n⚠️ PR creation failed: ${err.message}. Commit: ${implementationLink}`;
                          finalLink = implementationLink;
                        }
                      } else {
                        noteForComment = `\n\n⚠️ PR creation skipped — gh not configured. Commit: ${implementationLink}. Open a PR manually when ready.`;
                        finalLink = implementationLink;
                      }
                    }
              ```


              Note: `finalLink = implementationLink` is set on lines in the
              else-branch AND in the catch-branch, but `finalLink` is ALREADY
              initialized to `implementationLink` on line 1. So those
              reassignments are redundant dead code.


              ### routes/tasks.ts vs mcp-server.ts branch tools:

              The three branch operations are implemented twice — once as MCP
              tools in mcp-server.ts and once as HTTP routes in tasks.ts. They
              share the same logic with no abstraction layer. If the branch
              logic changes, it must be updated in both places.


              ### branch-manager.ts git() helper:

              ```ts

              function git(args: string[]): Promise<{ stdout: string; stderr:
              string }> {
                return execFileAsync('git', ['-C', workspaceRoot!, ...args], { windowsHide: true });
              }

              ```

              The `workspaceRoot!` assertion: if workspace.ts already enforces
              non-null, the `!` is redundant noise.


              Return findings as JSON: [{ "file": "path", "line": N, "summary":
              "...", "failure_scenario": "..." }]
      - timestamp: '2026-06-03T03:04:06.801Z'
        message: Reading mcp-server.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/mcp-server.ts
      - timestamp: '2026-06-03T03:04:08.817Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: slugify
            path: /Users/guy/Event-Horizon
            output_mode: content
      - timestamp: '2026-06-03T03:04:12.475Z'
        message: Reading file-utils.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/file-utils.ts
            offset: 168
            limit: 15
      - timestamp: '2026-06-03T03:04:13.336Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: Angle — Efficiency issues in the new branch code
            prompt: >
              You are reviewing new code for efficiency issues: redundant I/O,
              sequential operations that could be parallel, blocking work on hot
              paths.


              ## Code under review:


              ### branch-manager.ts getTicketBranchStatus:

              ```ts

              export async function getTicketBranchStatus(name: string) {
                try {
                  await git(['rev-parse', '--verify', name]);  // first git call
                } catch {
                  return { exists: false, aheadCount: 0, behindCount: 0 };
                }

                try {
                  const { stdout } = await git(['rev-list', '--left-right', '--count', `master...${name}`]);  // second git call
                  ...
                } catch {
                  return { exists: true, aheadCount: 0, behindCount: 0 };
                }
              }

              ```


              Note: The first `rev-parse --verify` call is used to check
              existence, then if it exists, a second `rev-list` call gets the
              counts. But `rev-list --left-right --count master...name` will
              ALSO fail if `name` doesn't exist (it would throw). So the first
              call is redundant — you could just call `rev-list` directly and
              catch the error for non-existence. Two sequential git subprocess
              spawns instead of one.


              ### mcp-server.ts finish_ticket:

              ```ts

              if (task.branch) {
                const ghAvailable = await checkGhAuth();  // spawns `gh auth status` subprocess
                if (ghAvailable) {
                  const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody);
                  // createPullRequest does:
                  //   git push -u origin branchName  (network I/O)
                  //   gh pr create ...               (network I/O)
                }
              }

              ```


              This adds potentially significant latency to `finish_ticket` — a
              previously-fast operation now does 3 subprocess calls (gh auth +
              git push + gh pr create), including a network push. Is this on the
              critical path for the ticket close?


              ### index.ts startup:

              ```ts

              checkGhAuth().then(ok => {
                if (!ok) {
                  broadcastEvent('ghAuthMissing', {});
                }
              }).catch(() => {});

              ```


              `checkGhAuth()` spawns `gh auth status` at startup. This is a
              fire-and-forget call — fine for efficiency, no issue here.


              Return findings as JSON: [{ "file": "path", "line": N, "summary":
              "...", "failure_scenario": "..." }]
      - timestamp: '2026-06-03T03:04:14.390Z'
        message: Reading workspace.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/workspace.ts
      - timestamp: '2026-06-03T03:04:16.045Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: checkGhAuth|ghAuthMissing|gh auth
            path: /Users/guy/Event-Horizon/engine/src
            output_mode: content
      - timestamp: '2026-06-03T03:04:16.433Z'
        message: Reading branch-manager.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/branch-manager.ts
      - timestamp: '2026-06-03T03:04:17.006Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:04:21.773Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: checkGhAuth
            path: /Users/guy/Event-Horizon/engine/src/index.ts
            output_mode: content
            context: 3
      - timestamp: '2026-06-03T03:04:22.307Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: >-
              Angle — Altitude: are these changes implemented at the right
              depth?
            prompt: >
              You are reviewing code for altitude issues — changes that are
              fragile bandaids instead of properly generalized implementations.


              ## Code under review:


              ### branch-manager.ts hardcodes 'master':

              ```ts

              const { stdout } = await git(['rev-list', '--left-right',
              '--count', `master...${name}`]);

              ```


              The comparison base is hardcoded to `master`. Repos using `main`
              as default branch will get wrong results from
              `getTicketBranchStatus`.


              `createTicketBranch` takes a `baseBranch` parameter (defaulting to
              `master`), so there IS awareness that the default branch might
              differ — but `getTicketBranchStatus` doesn't use it.


              ### delete_branch doesn't clear ticket state:

              After `deleteTicketBranch(name)`, the ticket's `branch` field
              still holds the old branch name. This is a permanent inconsistency
              in ticket state — not just a cache issue. Any subsequent
              `finish_ticket` will find `task.branch` set and try to push/create
              a PR for a deleted branch. The fix should be in
              `deleteTicketBranch` (or in the delete tool handler) to clear the
              field.


              ### PR creation tightly coupled to finish_ticket:

              The PR creation logic is embedded directly in the `finish_ticket`
              tool handler rather than in `branch-manager.ts`. This means the PR
              creation side-effect is invisible to the HTTP route for finishing
              tickets (if one exists). Is there a corresponding HTTP endpoint
              for finishing a ticket? If so, it would be missing the PR
              creation.


              ### MCP create_branch prevents re-creation but HTTP route doesn't:

              The MCP `create_branch` checks `if (task.branch)` and returns an
              error. The HTTP POST `/:id/branch` does not. This is an asymmetry
              that makes the system behave differently depending on whether you
              use MCP or HTTP to create branches.


              Return up to 8 findings as JSON: [{ "file": "path", "line": N,
              "summary": "...", "failure_scenario": "..." }]
      - timestamp: '2026-06-03T03:04:29.566Z'
        message: Working
        type: tool
        data:
          toolName: Glob
          parameters:
            pattern: engine/src/**/*.ts
      - timestamp: '2026-06-03T03:04:32.006Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T03:04:33.004Z'
        message: Reading branch-manager.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/branch-manager.ts
      - timestamp: '2026-06-03T03:04:47.007Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:09:23.386Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: finish
            file_path: /Users/guy/Event-Horizon/engine/src/index.ts
            output_mode: content
      - timestamp: '2026-06-03T03:09:32.021Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T03:10:32.025Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T03:10:33.262Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: 'Verify: gh pr create missing -C flag'
            prompt: >-
              Verify this candidate bug:


              **Claim**: `createPullRequest` in `engine/src/branch-manager.ts`
              uses `execFileAsync('git', ['-C', workspaceRoot!, 'push', ...])`
              (correctly passing `-C workspaceRoot`) but then calls
              `execFileAsync('gh', ['pr', 'create', ...])` WITHOUT passing `-C
              workspaceRoot`. The `gh` CLI resolves the repository from the
              process's current working directory, not from `workspaceRoot`. If
              the server was started from a different directory than
              `workspaceRoot`, `gh` targets the wrong repo.


              The code (lines 62-64 of branch-manager.ts):

              ```ts

              export async function createPullRequest(branchName: string, title:
              string, body: string): Promise<string> {
                await execFileAsync('git', ['-C', workspaceRoot!, 'push', '-u', 'origin', branchName], { windowsHide: true });
                const { stdout } = await execFileAsync('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branchName], { windowsHide: true });
                return stdout.trim();
              }

              ```


              Questions to answer:

              1. Does `gh pr create` resolve the repository from cwd, or does it
              detect the repo some other way?

              2. Is there a `-C` or `--repo` flag that should be used?

              3. How does the engine typically start — is it always started from
              the workspaceRoot, or can it be started from elsewhere?


              Read `/Users/guy/Event-Horizon/engine/src/index.ts` lines 1-50 to
              see how the server starts and what cwd might be. Also check if
              there's any `process.chdir()` call anywhere.


              Return verdict: CONFIRMED, PLAUSIBLE, or REFUTED with reasoning.
              Quote relevant lines.
      - timestamp: '2026-06-03T03:10:36.032Z'
        message: Reading branch-manager.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/branch-manager.ts
      - timestamp: '2026-06-03T03:10:38.591Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: 'Verify: DELETE req.body parsing for force flag'
            prompt: >-
              Verify this candidate bug:


              **Claim**: `DELETE /:id/branch` in `engine/src/routes/tasks.ts`
              reads `req.body?.force === true` to get the force-delete flag.
              Express does not parse request bodies for DELETE requests by
              default. If the body-parser middleware is only registered for
              POST/PUT methods, `req.body` will be `undefined` for DELETE
              requests, so `force` will always be `false`, meaning it's
              impossible to force-delete a branch via the HTTP API even when
              `force: true` is sent.


              Please read `/Users/guy/Event-Horizon/engine/src/index.ts` and
              look for how body-parser (or express.json()) is configured.
              Specifically check:

              1. Is `express.json()` or `bodyParser` registered globally (i.e.
              `app.use(express.json())`) or only for specific methods?

              2. Is there any method filter that would exclude DELETE requests?

              3. What does `app.use(express.json())` do by default for DELETE
              requests?


              Also look at the bottom of
              `/Users/guy/Event-Horizon/engine/src/routes/tasks.ts` lines
              600-620 to confirm the relevant code.


              Return verdict: CONFIRMED, PLAUSIBLE, or REFUTED. Quote the
              relevant lines that prove the verdict.
      - timestamp: '2026-06-03T03:10:39.343Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/index.ts
            offset: 80
            limit: 120
      - timestamp: '2026-06-03T03:10:40.011Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: process\.chdir
            path: /Users/guy/Event-Horizon/engine/src
            output_mode: content
      - timestamp: '2026-06-03T03:10:41.228Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/index.ts
      - timestamp: '2026-06-03T03:10:43.040Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: 'Verify: slugify already exists in file-utils.ts'
            prompt: >-
              Check whether a `slugify` or `slugifyDocValue` function already
              exists in `/Users/guy/Event-Horizon/engine/src/` that the new
              `branch-manager.ts` slugify function is duplicating.


              Read `/Users/guy/Event-Horizon/engine/src/branch-manager.ts` lines
              11-17 to see the new slugify implementation.


              Then search for existing slugify functions in the engine package:

              - Read any file that might have one (e.g. file-utils.ts, utils.ts)

              - Grep for "slugify" in engine/src/


              The new branch-manager.ts slugify:

              ```ts

              export function slugify(title: string): string {
                return title
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 60);
              }

              ```


              Return: CONFIRMED (duplicate exists, name it and quote),
              PLAUSIBLE, or REFUTED (no duplicate found).
      - timestamp: '2026-06-03T03:10:43.263Z'
        message: Reading index.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/index.ts
            offset: 250
            limit: 120
      - timestamp: '2026-06-03T03:10:47.027Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:10:47.601Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: slugify
            path: /Users/guy/Event-Horizon/engine/src
            output_mode: content
            type: ts
      - timestamp: '2026-06-03T03:10:50.317Z'
        message: Reading file-utils.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/file-utils.ts
            offset: 172
            limit: 10
      - timestamp: '2026-06-03T03:10:51.015Z'
        message: 'Running: gh pr create --help 2>&1 | grep -E ''(-C|--repo|cwd...'
        type: tool
        data:
          toolName: Bash
          parameters:
            command: >-
              gh pr create --help 2>&1 | grep -E
              '(-C|--repo|cwd|directory|working)' | head -20
            description: Check gh pr create flags for cwd or repo targeting options
      - timestamp: '2026-06-03T03:11:02.027Z'
        message: Running command
        type: info
      - timestamp: '2026-06-03T03:11:02.569Z'
        message: Delegating
        type: tool
        data:
          toolName: Agent
          parameters:
            description: 'Sweep: gaps not caught by first pass'
            prompt: >-
              You are a fresh code reviewer doing a gap-sweep. The first-pass
              review already identified these issues (do NOT re-derive them):


              1. `git checkout -b` in createTicketBranch switches server HEAD

              2. `delete_branch` doesn't clear task.branch after git branch
              deletion

              3. `gh pr create` missing `-C workspaceRoot` flag

              4. `deleteTicketBranch` fails when HEAD is on the branch being
              deleted

              5. `getTicketBranchStatus` hardcodes 'master'

              6. HTTP POST `/:id/branch` missing duplicate branch guard

              7. `createPullRequest` returns empty string if gh stdout is empty

              8. `err.message` from execFileAsync loses stderr

              9. `branchName` imported but unused in mcp-server.ts

              10. Redundant `finalLink = implementationLink` assignments in
              catch/else


              Your job: find defects NOT on this list. Re-read the code below
              and look ONLY for gaps. Focus on: moved/extracted code that
              dropped a guard; setup/teardown asymmetry; config defaults;
              second-tier footguns.


              ## Full new code:


              ### branch-manager.ts (complete new file):

              ```ts

              import { execFile } from 'child_process';

              import { promisify } from 'util';

              import { workspaceRoot } from './workspace.js';


              const execFileAsync = promisify(execFile);


              function git(args: string[]): Promise<{ stdout: string; stderr:
              string }> {
                return execFileAsync('git', ['-C', workspaceRoot!, ...args], { windowsHide: true });
              }


              export function slugify(title: string): string {
                return title
                  .toLowerCase()
                  .replace(/[^a-z0-9]+/g, '-')
                  .replace(/^-+|-+$/g, '')
                  .slice(0, 60);
              }


              export function branchName(ticketId: string, title: string):
              string {
                return `flux/${ticketId}-${slugify(title)}`;
              }


              export async function createTicketBranch(ticketId: string, title:
              string, baseBranch = 'master'): Promise<string> {
                const name = branchName(ticketId, title);
                await git(['checkout', '-b', name, baseBranch]);
                return name;
              }


              export async function getTicketBranchStatus(name: string) {
                try {
                  await git(['rev-parse', '--verify', name]);
                } catch {
                  return { exists: false, aheadCount: 0, behindCount: 0 };
                }
                try {
                  const { stdout } = await git(['rev-list', '--left-right', '--count', `master...${name}`]);
                  const parts = stdout.trim().split(/\s+/);
                  const behindCount = parseInt(parts[0] ?? '0', 10) || 0;
                  const aheadCount = parseInt(parts[1] ?? '0', 10) || 0;
                  return { exists: true, aheadCount, behindCount };
                } catch {
                  return { exists: true, aheadCount: 0, behindCount: 0 };
                }
              }


              export async function deleteTicketBranch(name: string, force =
              false): Promise<void> {
                const flag = force ? '-D' : '-d';
                await git(['branch', flag, name]);
              }


              export async function checkGhAuth(): Promise<boolean> {
                try {
                  await execFileAsync('gh', ['auth', 'status'], { windowsHide: true });
                  return true;
                } catch {
                  return false;
                }
              }


              export async function createPullRequest(branchName: string, title:
              string, body: string): Promise<string> {
                await execFileAsync('git', ['-C', workspaceRoot!, 'push', '-u', 'origin', branchName], { windowsHide: true });
                const { stdout } = await execFileAsync('gh', ['pr', 'create', '--title', title, '--body', body, '--head', branchName], { windowsHide: true });
                return stdout.trim();
              }

              ```


              ### finish_ticket changes (mcp-server.ts):

              ```ts
                    let finalLink = implementationLink;
                    let noteForComment = '';

                    if (task.branch) {
                      const ghAvailable = await checkGhAuth();
                      if (ghAvailable) {
                        try {
                          const prBody = `${task.body ? task.body.slice(0, 800) : ''}\n\n---\nTicket: ${ticketId}`;
                          const prUrl = await createPullRequest(task.branch, task.title || ticketId, prBody);
                          finalLink = prUrl;
                        } catch (err: any) {
                          noteForComment = `\n\n⚠️ PR creation failed: ${err.message}. Commit: ${implementationLink}`;
                          finalLink = implementationLink;
                        }
                      } else {
                        noteForComment = `\n\n⚠️ PR creation skipped — gh not configured. Commit: ${implementationLink}. Open a PR manually when ready.`;
                        finalLink = implementationLink;
                      }
                    }

                    const entries = [{ type: 'comment', user: 'Agent', comment: completionComment + noteForComment, date: new Date().toISOString() }];
                    const result = await updateTaskWithHistory(ticketId, {
                      entries,
                      updatedBy: 'Agent',
                      nextStatus: 'Done',
                      extraFields: { implementationLink: finalLink },
                    });
              ```


              Return up to 8 NEW findings as JSON: [{ "file": "path", "line": N,
              "summary": "...", "failure_scenario": "..." }]
      - timestamp: '2026-06-03T03:11:06.126Z'
        message: Reading branch-manager.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/branch-manager.ts
      - timestamp: '2026-06-03T03:11:17.028Z'
        message: Reading
        type: info
      - timestamp: '2026-06-03T03:11:21.277Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: workspaceRoot
            path: /Users/guy/Event-Horizon/engine/src/workspace.ts
            output_mode: content
      - timestamp: '2026-06-03T03:11:24.628Z'
        message: Reading workspace.ts
        type: tool
        data:
          toolName: Read
          parameters:
            file_path: /Users/guy/Event-Horizon/engine/src/workspace.ts
      - timestamp: '2026-06-03T03:11:30.919Z'
        message: Working
        type: tool
        data:
          toolName: Grep
          parameters:
            pattern: >-
              slugify|branchName|createTicketBranch|deleteTicketBranch|getTicketBranchStatus|createPullRequest|checkGhAuth
            path: /Users/guy/Event-Horizon/engine/src
            output_mode: content
      - timestamp: '2026-06-03T03:11:32.028Z'
        message: Working
        type: info
      - timestamp: '2026-06-03T03:17:47.243Z'
        message: Thinking
        type: info
      - timestamp: '2026-06-03T03:18:24.676Z'
        message: >-
          Now synthesizing all verified findings into the final ranked list.


          ---


          ## Code Review: FLUX-338 — MCP Branch Management Tools

          **Persona: Angry Linus** | **Effort: max**


          *What is this? You added git operations to a long-running server
          process and nobody thought about what `git checkout` does to a running
          process. Let me count the ways this is broken.*


          ---


          ```json

          [
            {
              "file": "engine/src/branch-manager.ts",
              "line": 25,
              "summary": "createTicketBranch runs `git checkout -b` which permanently switches the server process's working HEAD",
              "failure_scenario": "Any call to create_branch moves HEAD to the new feature branch and leaves it there. The sync-watcher's auto-commit then runs against the feature branch instead of flux-data/master. Any git operation the server performs after this — status checks, the orphan branch sync, anything — now runs on the wrong branch. There is no checkout-back step. HEAD stays on the feature branch until something else explicitly moves it, which nothing does."
            },
            {
              "file": "engine/src/mcp-server.ts",
              "line": 411,
              "summary": "delete_branch deletes the git branch but never clears task.branch from the ticket — stale ref blocks everything downstream",
              "failure_scenario": "After successful deletion, task.branch still holds the old name. finish_ticket finds task.branch set, calls createPullRequest, which runs `git push -u origin <deleted-branch>` — the push fails or pushes whatever happens to be on HEAD. Also blocks re-creation: create_branch checks `if (task.branch)` and refuses with 'already has branch' even though the branch is gone."
            },
            {
              "file": "engine/src/routes/tasks.ts",
              "line": 603,
              "summary": "HTTP DELETE /:id/branch has the same stale-branch-field bug — neither delete surface clears task.branch",
              "failure_scenario": "Same failure as above via the REST path. The board UI keeps displaying a branch badge for a dead branch. finish_ticket called after HTTP deletion hits the same ...
    user: Claude Code
    date: '2026-06-03T03:02:01.980Z'
    outcome: Claude Code session ended with code 0.
    endedAt: '2026-06-03T03:18:24.676Z'
  - type: status_change
    from: Ready
    to: In Progress
    user: Agent
    date: '2026-06-03T03:55:08.342Z'
  - type: agent_session
    sessionId: c63dbe2c-0aac-450e-9e3f-546bea88ef9d
    startedAt: '2026-06-03T03:55:08.397Z'
    status: cancelled
    progress: []
    user: Claude Code
    date: '2026-06-03T03:55:08.397Z'
    outcome: Session abandoned (engine restarted).
    endedAt: '2026-06-03T03:55:14.490Z'
tokenMetadata:
  inputTokens: 318205
  outputTokens: 18905
  costUSD: 3.04012
  costIsEstimated: false
  cacheReadTokens: 201655
  cacheCreationTokens: 116537
id: FLUX-338
---
## Problem / Motivation

Agents interact with Event Horizon through MCP tools. Branch operations need MCP tool equivalents so agents can manage branches natively without shelling out to git directly.

## Implementation Plan

Add tools to `engine/src/mcp-server.ts` using the existing `server.tool()` pattern:

- `create_branch` — params: `ticketId` (required), `baseBranch` (optional, defaults to `master`). Calls `createTicketBranch()`. Returns `{ branch }` on success.
- `get_branch` — params: `ticketId`. Returns `{ name, exists, aheadCount, behindCount }`.
- `delete_branch` — params: `ticketId`, `force` (optional boolean). Calls `deleteTicketBranch()`. Refuses unmerged branches unless `force: true`.

**No `switch_branch` tool.** Agents must stay on their ticket branch for the full session. If a switch is ever required, the agent must confirm with the user in chat — not automate it via MCP. This prevents one agent session from pulling the rug out from under another in multi-agent scenarios.

Return `jsonResult()` for success, `errorResult()` for failures (branch not found, dirty working tree, git errors, `gh` not authenticated).

Depends on FLUX-337 (branch-manager module) being complete.

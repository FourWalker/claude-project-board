# Claude Project Board — shared data layout

Everything lives under one folder in your user profile, **outside every repo**,
so all workspace clones of a project share it and nothing gets committed:

```
%USERPROFILE%\.claude-board\
  boards.json                    the board registry: each board's name and workspace roots
  unassigned\<sessionId>.json    chats in folders no board covers (until a board exists)
  _archive\                      anything the tools removed, kept rather than deleted
  projects\<boardId>\
    sessions\<sessionId>.json    one per Claude chat (written only by that chat)
    tasks\<taskId>\
      task.json                  title, description, status, last action,
                                 decisions / todos / mandatory items
      plan.md                    the whole plan, phases as checkboxes
      handoffs\<phase>.md        written by the chat that finished a phase
```

## boards.json
```json
{ "version": 1, "boards": [
  { "id": "nefx", "name": "NEFX", "createdAt": 0, "roots": [
    { "path": "D:/nfx", "label": "nfx" },
    { "path": "D:/nfx-workspaces/claude-code", "label": "claude-code" } ] } ] }
```
A chat belongs to the board whose root contains its folder (the deepest match wins).
`D:/nfx/authbase` → board NEFX, workspace "nfx", subfolder "authbase".
Boards are only created on purpose: from a chat (Claude asks first, then `board_setup`,
or `/board new <name>`), or on the board's picker page. Roots are added with `/board add <board>`
or in the board's ⚙ settings.

## sessions\<sessionId>.json
```json
{
  "sessionId": "…", "projectId": "nefx", "taskId": "sftp" ,
  "workspace": "C:\\Work\\NEFX-2", "workspaceLabel": "NEFX-2", "branch": "feature/sftp",
  "status": "working | idle | ended",
  "title": "first prompt of the chat",
  "lastPrompt": "…", "lastAnswer": "…",
  "turnStartedAt": 0, "updatedAt": 0, "heartbeatAt": 0,
  "suggestedTaskId": null
}
```
A session whose `heartbeatAt` is older than ~2 minutes is shown as offline.

## task.json
```json
{
  "id": "sftp", "title": "SFTP", "description": "…",
  "status": "active | paused | done",
  "createdAt": 0, "updatedAt": 0,
  "lastAction": { "text": "…", "sessionId": "…", "at": 0 },
  "items": [ { "id": "d1", "kind": "decision | todo | mandatory", "text": "…", "done": false, "at": 0 } ],
  "sessions": [ { "sessionId": "…", "linkedAt": 0, "workspaceLabel": "NEFX-2" } ]
}
```

## plan.md format
```markdown
# Plan: SFTP

## Phase A — Connection layer
- [x] A1 Add SFTP client wrapper
- [ ] A2 Retry + timeout handling

## Phase B — Tests
- [ ] B1 Integration test against local server
```
A step is a checkbox line whose first word is its id (`A1`, `B2`, …).
The first unchecked step is the **next phase**. `handoffs\A1.md` belongs to step A1.

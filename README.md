# Claude Project Board

A sticky-note board of the tasks your Claude chats are working on, across
several workspace clones of the same repo.

```
mod/project-board/        the plugin: the mod (hooks/, commands/) and the board app (app/)
.claude-plugin/           marketplace file, so the plugin installs with /plugin install
vscode-bridge/            optional VS Code extension: opens chats in the Claude sidebar
docs/DATA-LAYOUT.md       where the shared data lives and its format
Start Board.cmd           starts the board without Claude (same as /board open)
```

## Install
At the prompt of a terminal session (once this folder is a GitHub repository):

```
/plugin install project-board --marketplace <owner>/<repo>
```

In a chat, `/board open` starts the board server (needs Node.js) and opens the board in its own window.
Board Mode's protocol ships inside the mod, so nothing depends on your own CLAUDE.md or settings;
project-specific rules go in each board's ⚙ **Project rules**.

## How it fits together
- The **mod** runs in each Claude chat. It writes to `%USERPROFILE%\.claude-board\`:
  whether the chat is working or idle, its workspace and branch, its task, the last
  action, the plan and handoffs, decisions, links, ownership and repo state.
- The **board** reads that folder every 3 seconds. One window shows one board.

## Boards and workspaces
A board has a name and the root folder of each copy of the project (e.g. NEFX: `D:\nfx`,
`D:\nfx-workspaces\claude-code`, …). A chat anywhere inside a root reports to that board.
- In a chat: `/board` shows this chat's board · `/board new NEFX` · `/board add NEFX` · `/board list`.
- In a folder with no board, Claude asks whether to create one (it suggests a name and the folder with
  the `.code-workspace` file) or to add the folder to an existing board. Nothing is created before you answer.
- On the board: ⚙ renames the board and adds, removes or relabels workspaces. The picker page has **New board**
  and lists chats that have no board yet.

## Levels, decisions, Board Mode
- **3 levels:** Level 1 master task › Level 2 module › Level 3 task. Each has its own plan, living handoff
  (`handoff.md`), step notes, items, decisions and chats. A chat on a task also gets summaries of its parents'
  purpose, next step and handoff, with paths to read them in full.
- **Promote** moves a task up one level (its subtasks move with it; former parents stay readable). Plan steps
  can be turned into subtasks.
- **Decisions** have a title, context, options/recommendation, references and a verdict. Claude files each one
  at the level it affects (`board_decision`), mapped back to the task where it came up. Each task has a
  Decisions tab: its own, the ones raised there but filed higher up, and its parents'.
- **Master task page:** clicking a master task opens its own page. **Overview** shows modules and their tasks
  (60%), every chat in the tree (20%), and must-dos and to-dos from the whole tree (20%).
- **Plan & Docs** tab: the **master plan** (the implementation plan the modules and tasks are broken down from;
  Claude drafts it with `board_master_plan`, or write your own), the task's **phase plan**, and **docs &
  references** (tech spec, HLD, LLD, API spec, …) mapped by path or URL (`board_doc`), plus those of parent levels.
  Chats see the list and read a document only when needed.
- **Handoff** tab: the agent's living handoff (what a new chat resumes from) and per-step notes.
- **Features and service backlogs:** a master task is a *feature* (has a master plan) or a *service backlog*
  (one service's own bugs and gaps). Microservices are **service tags**, not a level: the board's service list
  (⚙) maps names to folder patterns (`BE/invoice-microservice`), and the mod tags a task automatically when a
  chat edits files in a service. **By service** shows all work per service.
- **Linked tasks:** blocked by / blocks, found during / led to, related. A task blocked by an unfinished task
  shows ⛔ (rolled up on its module and feature, listed under Blocked). The feature page and every task view
  list links to work outside their tree. **Move…** re-parents a task with its subtasks.
- **Out-of-scope work (Board Mode):** when a chat finds a bug or extra work in another service or module, it
  checks for an existing task (`board_find`), proposes an owner (this feature, or that service's backlog), and
  asks: new task in another chat · fix here with recorded scope · task for later.
- **Display:** Tree (a column per master task) or one level at a time (Level 2/3 notes show their parent path).
- **Board Mode** (⚙, per board; `/board mode off` per chat): chats resume from the living handoff, checkpoint at
  phase ends (`/checkpoint`), file decisions at the right level, and follow the token, log and no-secrets rules.

## In a chat
- `/task` lists tasks · `/task SFTP` links the chat (and creates the task if it's new) · `/task off` unlinks.
- When a chat isn't linked yet, Claude offers once to link it to a matching task or create one.
- A linked chat gets the task's plan and latest handoff in its context, so it knows
  what "Phase A2" means without being told.
- Claude keeps the board up to date with its tools: `board_update` (last action, decisions,
  to-dos, must-dos), `board_plan` (the whole plan), `board_handoff` (finish a step and write its
  handoff note), `board_read`, `board_link`.

## On the board
- Click a **note** to see its linked chats, then pick one to open.
- Click the **Last action** strip to jump straight to the chat that did it.
- **Plan & handoffs** shows the phases and the next step. Each finished step has its handoff note.
- The right panel collects every open **must-do, decision and to-do** across tasks, plus open chats not linked to a task.
- A warning shows when two chats are working in the same workspace clone at once.

## Running it
Double-click `Start Board.cmd`, or pass a project id: `"Start Board.cmd" nefx`.
In the Edge window, use **⋯ → Apps → Install this site as an app** to give it a Start menu / taskbar icon.

## VS Code: opening chats in the Claude sidebar
The Claude extension's own link always opens a chat as a full editor tab. `vscode-bridge/` is a
tiny companion extension that opens it in the Claude sidebar instead. The board uses it when it's installed.

```powershell
node "vscode-bridge\build-vsix.js"
code --install-extension "vscode-bridge\project-board-bridge-0.1.0.vsix"
```
VS Code setting `projectBoard.openChatsIn`: `sidebar` (default) or `tab`. Opening a chat in the
sidebar also sets Claude's `claudeCode.preferredLocation` to `sidebar`.

## Register, ownership, bugs
- **Recommendations register:** every recommendation gets a board-wide R# (Register view). Topics with their
  own register (⚙ Existing registers, e.g. FI SFTP) are written there too with the same R#. Verdicts only
  when the team decided; accepted ones get a *How implemented* record.
- **Workspace ownership:** modules (and master tasks set on purpose) belong to one workspace copy. Chats in
  another copy are blocked unless you override once or take over (`/task <id> --override | --takeover`).
  **Soft release** (`/board release soft` or the Workspace card) hands it over once everything is pushed,
  clean and checkpointed; the next copy takes over from the recorded branch and commit. Every checkpoint
  records each repo's branch, HEAD, push and clean state.
- **Bugs in finished work:** a separate fix task (🐞) in the same module or the service's backlog, linked
  with *fixes*; the finished task stays done and shows its open fixes.

## Turning the mod on for every chat (without installing)
Add the mod folder to `CLAUDE_CODE_PLUGIN_DIRS` in `%USERPROFILE%\.claude\settings.json`:

```json
{ "env": { "CLAUDE_CODE_PLUGIN_DIRS": "C:\\Claude Works\\Claude Project Board\\mod\\project-board" } }
```
New chats started after that load it.

---
description: Board — rewrite this task's living handoff in place and print the resume line
---
Checkpoint this chat for a fresh one.

1. Verify the current state first: for each repo this task touched, its branch, HEAD and working changes (git status --short). Note which checks were run and their results.
2. Rewrite the linked task's living handoff in place with `board_checkpoint` (the whole file, replacing the previous version): Objective · Workspace · Repository (each affected repo) · Branch / HEAD · Working changes · Verified results · Not verified · Decisions and constraints (with why) · Next step (one concrete action) · Relevant references (path:line or commands) · Resume. About 30-40 lines. No secrets. Remove stale or finished narrative.
3. If a plan step finished in this chat, also call `board_handoff` for it, and update open decisions / to-dos with `board_update`.
4. If this chat isn't linked to a task, ask which task (or offer to create one) before writing anything.

Reply with only: the handoff path, the 3-5 lines that changed, and "Resume: run /task <task id> in a new chat." Don't clear or start a chat yourself.

$ARGUMENTS

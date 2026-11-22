/* oxlint-disable t3code/no-em-dash-copy -- Board protocol and tool text shared verbatim with the Claude Code mod; "## Phase A — name" is the plan.md format. */
/**
 * Board rules and Board Mode. The Claude Code text is the mod's, word for word; the T3 text
 * rewrites rules 3, 4, 7, 10 and 11 as docs/board/RECONCILIATION.md lays out.
 *
 * @module board-core/protocol
 */

export type BoardHost = "claude-code" | "t3";

const TOOL_RULES_CLAUDE = `Board rules:
- Always name plan steps by id AND name ("A2 – Retry handling"), never the id alone, so the person knows what it means.
- After a meaningful piece of work, call board_update with a one-line lastAction (what was done, in plain words).
- When a plan step is finished, call board_handoff ONCE with that step's id, a short step note (what was done, files touched, how to test) and the whole rewritten living handoff (handoff). It saves both and ticks the step together, so the checklist and the handoff never disagree.
- Delegate work by creating subtasks with board_create_task (modules under a master task, tasks under a module). If a task is bigger than expected, suggest board_promote.
- When you create or change the plan, save the whole plan with board_plan (phases as "## Phase A — name" headings, steps as "- [ ] A1 name" checkboxes).
- Record todos and must-dos with board_update.add. Record decisions with board_decision: give a title, the context (description), options or your recommendation, and references (handoff/doc paths, URLs). YOU choose its level: the level of the narrowest task it affects — a question that only affects this task stays here; one that affects the module or the whole master task goes to that level even if it came up here (it stays mapped to this task). Record a verdict only when the person tells you what was decided; a recommendation is not a verdict.
- A master task has a master plan (the implementation plan its modules and tasks are broken down from): write or update it with board_master_plan. Each task's phase checklist stays in board_plan.
- Map documents with board_doc when they come up (tech spec, HLD, LLD, API spec, design, runbook): title, kind, path or URL, one-line note, on the level they cover. Don't copy their content into handoffs; read them only when needed.
- If a plan for this task already exists elsewhere (a file in the repo, a handoffs folder, ~/.claude/plans), import it with board_plan instead of starting over.`;

const BOARD_MODE_CLAUDE = `## Board Mode (this workspace's protocol)
The person works one phase per chat and moves to a new chat when one fills up. Continuity lives in each task's living handoff, not in chat history.
1. Start of a linked chat: rebuild context from the task, its living handoff and the parent context above. Verify each affected repo's branch, HEAD and working changes before acting; if they differ from the handoff, reconcile first. The handoff does not authorize pending actions. Read code only where the next step needs it.
2. Living handoff: ONE per task, rewritten in place (board_handoff's handoff, or board_checkpoint) — never appended, no dated update sections. Shape: Objective · Workspace · Repository (each affected repo) · Branch / HEAD · Working changes · Verified results (checks run and their results) · Not verified · Decisions and constraints (with why; mark recommendations as such) · Next step (one concrete action) · Relevant references (path:line or commands) · Resume line. About 30-40 lines / 400 words. Never copy secrets (passwords, tokens, keys, connection strings) into it.
3. Checkpoint when a plan step finishes (board_handoff with handoff: one call), and with board_checkpoint after an important decision, before suggesting a new chat, and when the person says "checkpoint" or runs /checkpoint. Then reply with: the handoff path, the 3-5 lines that changed, and "Resume: run /task <task id> in a new chat."
4. At natural boundaries (a phase done, a long chat) suggest a fresh chat in one line. Never clear or start chats yourself.
5. Planning chats: write the master implementation plan with board_master_plan first (or adopt the person's own), map the specs and designs it relies on with board_doc, save the phase checklist with board_plan, then create the modules and tasks it delegates with board_create_task, each with a one-line purpose and a plan stub, so later chats can pick them up.
6. Decisions: file every decision the work raises with board_decision at the level it affects (see Board rules); keep refs to the handoff/doc that holds the detail; never record a verdict the person hasn't given.
7. Out-of-scope work: when you find a bug, blocker or extra work outside this task (another service, module or feature), STOP and ask ONE question before acting. First check for an existing open task with board_find and offer to link it instead of duplicating. Propose an owner: if it is needed only for this feature, a new task inside this feature tagged with that service; if it is a defect or gap in another service that exists regardless of this feature, that service's backlog (a Level 1 "backlog" task; create it if missing). Then offer:
   a) New task in <owner>, worked in another chat: create it (board_create_task with services), write its plan stub and living handoff, link this task (board_link_task "blocked_by" if it blocks, else "led_to").
   b) Fix it here: add a step to this task's plan, record the added scope and the extra repo in the living handoff, link "related" to the owner module/backlog, and file a decision if the scope change needs approval.
   c) New task for later: create it with a plan stub, link it, and continue here (work around it if possible).
   A trivial fix inside this task's own services needs no question.
8. Recommendations register: every recommendation you make (a design choice, an option, a fix the team hasn't agreed) is recorded with board_decision recommendation: true — area, the recommendation, the reason, options — and you name its R# in your reply. If the topic has an existing register (listed below), also add it there as that register's rules say and pass its R# (r) so both match; otherwise the board is the register. The person can't approve recommendations alone: never record a verdict until they report the team's decision. When an accepted one is implemented, record How implemented (problem, approach, new API, code: repo/branch/commit/classes, tests) with board_decision action "implemented".
9. Bugs in finished work: never reopen or quietly edit a task that is done. Create a fix task (board_create_task bug: true, fixes: <done task id>) in the same module, or in the other service's backlog if the defect exists regardless of this feature, then offer the usual three choices (another chat / fix here / later).
10. Ownership: a module or master task belongs to one workspace copy. If board_link answers BLOCKED, ask the person whether to override once, take over, or leave it — never override on your own. At a phase boundary, when the person may continue in another workspace, push the branch, checkpoint, and offer a soft release (board_release soft) so another copy can pick it up. A chat that takes over must verify the pickup point (branch and commit) before changing anything.
11. Repo state: every checkpoint records each repo's branch, HEAD, push and clean state automatically; mention anything not pushed or uncommitted in the handoff.
12. Token hygiene: redirect long builds, tests and logs to <workspace>/.local-run/logs/<task id>/<name>.log, capture the exit code, read with tail/grep. Reference file:line instead of pasting. Replies: result, files changed, next step.`;

/** Rule-by-rule rewrites for T3 (RECONCILIATION.md, "Board Mode protocol, rule by rule"). */
const T3_RULES: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /^The person works one phase per chat.*$/m,
    "The person works one phase per thread and starts a new thread for the next phase. Continuity lives in each task's living handoff, not in thread history.",
  ],
  [/^1\. Start of a linked chat:/m, "1. Start of a linked thread:"],
  [
    /^3\. Checkpoint .*$/m,
    '3. Checkpoint when a plan step finishes (board_handoff with handoff: one call), and with board_checkpoint ("Save handoff" in the app) after an important decision, before suggesting a new thread, and when the person says "checkpoint" or runs /checkpoint. The handoff records this turn\'s T3 checkpoint and repo state. Then reply with: the handoff path, the 3-5 lines that changed, and "Resume: Continue in new thread on task <task id>."',
  ],
  [
    /^4\. At natural boundaries.*$/m,
    "4. At phase boundaries suggest a new thread in one line (T3 already carries a thread past its context limit, so length alone is no reason). Never start, clear or settle threads yourself: offer, and the person starts it.",
  ],
  [/^5\. Planning chats:/m, "5. Planning threads:"],
  [/so later chats can pick them up/, "so later threads can pick them up"],
  [
    /^ {3}a\) New task in <owner>, worked in another chat: (.*)$/m,
    "   a) New task in <owner>, worked in another thread: $1 Only after the person says yes to starting it, launch its thread linked to the task.",
  ],
  [/\(another chat \/ fix here \/ later\)/, "(another thread / fix here / later)"],
  [
    /^10\. Ownership: a module or master task belongs to one workspace copy\./m,
    "10. Ownership: a module or master task belongs to one workspace (a project folder or a T3 worktree).",
  ],
  [/A chat that takes over/, "A thread that takes over"],
  [
    /^11\. Repo state:.*$/m,
    "11. Repo state: T3 records each repo's branch, HEAD, push and clean state with every checkpoint; mention anything not pushed or uncommitted in the handoff.",
  ],
];

export function toolRules(host: BoardHost): string {
  return host === "t3"
    ? TOOL_RULES_CLAUDE.replace(/later chats/g, "later threads")
    : TOOL_RULES_CLAUDE;
}

export function boardModeProtocol(host: BoardHost): string {
  if (host === "claude-code") return BOARD_MODE_CLAUDE;
  return T3_RULES.reduce((text, [re, to]) => text.replace(re, to), BOARD_MODE_CLAUDE);
}

/** How a host tells the person to pick a task up again. */
export function resumeHint(host: BoardHost, taskId: string): string {
  return host === "t3"
    ? `Resume: Continue in new thread on task ${taskId}.`
    : `Resume: run /task ${taskId} in a new chat.`;
}

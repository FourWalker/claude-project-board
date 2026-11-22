/* oxlint-disable t3code/no-em-dash-copy -- Board protocol and tool text shared verbatim with the Claude Code mod; "## Phase A — name" is the plan.md format. */
/**
 * The board tools as JSON-schema definitions: the same names, descriptions and inputs the
 * Claude Code mod registers, for any host (the mod, T3 Code's MCP toolkit).
 *
 * @module board-core/tools
 */

export const SCHEMA = {
  setup: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["create", "attach"],
        description: "create a new board, or attach this workspace to an existing one.",
      },
      name: {
        type: "string",
        description: "create: the board name the person chose. attach: the board name.",
      },
      boardId: { type: "string", description: "attach: the board id." },
      root: {
        type: "string",
        description:
          "The workspace root folder; defaults to the suggested root. Must contain this chat's folder.",
      },
      label: {
        type: "string",
        description: "Short label for this workspace copy (defaults to the root folder name).",
      },
    },
    required: ["action"],
  },
  create: {
    type: "object",
    properties: {
      title: { type: "string" },
      parentId: {
        type: "string",
        description:
          "Parent task id. Omit for a Level 1 master task; a master task's child is a Level 2 module, a module's child a Level 3 task.",
      },
      description: { type: "string", description: "One-line purpose." },
      plan: {
        type: "string",
        description: 'Optional plan stub ("## Phase A — name" / "- [ ] A1 name").',
      },
      fromStep: {
        type: "string",
        description: "Parent plan step id this subtask takes over (marks it in the parent plan).",
      },
      kind: {
        type: "string",
        enum: ["feature", "backlog"],
        description:
          "Level 1 only: a feature, or a service backlog for one service's own bugs and gaps.",
      },
      bug: { type: "boolean", description: "This task fixes a bug found after the work was done." },
      fixes: {
        type: "string",
        description: 'With bug: the id of the finished task the bug is in (adds a "fixes" link).',
      },
      services: {
        type: "array",
        items: { type: "string" },
        description: "Service ids it touches (from the board's service list).",
      },
      mainService: {
        type: "string",
        description: "Level 1 only: the main service (for a backlog, the service it belongs to).",
      },
    },
    required: ["title"],
  },
  decision: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "decide", "update", "drop", "reopen", "implemented"],
      },
      id: {
        type: "string",
        description: "Decision id (D-…) or R# for decide/update/drop/reopen/implemented.",
      },
      title: { type: "string", description: "add: the question to decide." },
      description: {
        type: "string",
        description: "Context: what is being decided and why it matters.",
      },
      level: {
        type: "number",
        enum: [1, 2, 3],
        description:
          "add: the level it belongs to (1 master task, 2 module, 3 task) — the narrowest task it affects. Filed on that ancestor of the linked task and mapped back to it.",
      },
      options: {
        type: "string",
        description: "Options considered and any recommendation (marked as a recommendation).",
      },
      refs: {
        type: "array",
        items: { type: "string" },
        description: "Handoff/doc paths or URLs that hold the detail.",
      },
      verdict: {
        type: "string",
        description: "decide/drop: what the person/team decided (or why dropped).",
      },
      recommendation: {
        type: "boolean",
        description: "add: this is a recommendation for the register (gets an R#).",
      },
      area: { type: "string", description: "Recommendation: the area it concerns." },
      lldCheck: { type: "string", description: "Recommendation: what the LLD/spec says about it." },
      register: {
        type: "string",
        description: "Recommendation: the topic of an existing register it is also written to.",
      },
      r: {
        type: "string",
        description: "Recommendation: the R# used in that existing register, so both match.",
      },
      problem: { type: "string" },
      approach: { type: "string" },
      api: { type: "string", description: "New API: method, path, purpose, responses." },
      code: { type: "string", description: "Repo, branch, commit, classes." },
      tests: { type: "string" },
      taskId: { type: "string", description: "Defaults to the linked task." },
    },
    required: ["action"],
  },
  masterPlan: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Any task in the tree; the master plan belongs to its Level 1 master task.",
      },
      markdown: {
        type: "string",
        description:
          "The WHOLE master implementation plan (replaces the previous one): goal, scope, architecture, modules and their tasks, sequencing, risks.",
      },
    },
    required: ["markdown"],
  },
  doc: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "remove"] },
      kind: {
        type: "string",
        enum: ["Tech spec", "HLD", "LLD", "API spec", "Design", "Runbook", "Reference", "Other"],
      },
      title: { type: "string" },
      ref: { type: "string", description: "Absolute file path or URL." },
      note: { type: "string", description: "One line: what it covers / when to read it." },
      level: {
        type: "number",
        enum: [1, 2, 3],
        description: "The level it covers (defaults to the linked task's level).",
      },
      id: { type: "string", description: "remove: the doc id." },
      taskId: { type: "string", description: "Defaults to the linked task." },
    },
    required: ["action"],
  },
  linkTask: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["add", "remove"] },
      to: { type: "string", description: "The other task's id." },
      type: {
        type: "string",
        enum: ["blocked_by", "blocks", "found_during", "led_to", "related", "fixes"],
        description:
          "From this task's side: it is blocked_by / blocks / was found_during / led_to / is related to the other.",
      },
      note: { type: "string" },
      taskId: { type: "string", description: "Defaults to the linked task." },
    },
    required: ["to", "type"],
  },
  move: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      parentId: {
        type: "string",
        description: "New parent id; omit or empty to make it a master task.",
      },
    },
  },
  find: {
    type: "object",
    properties: {
      query: { type: "string", description: "Words to match in title/description." },
      service: { type: "string", description: "Only tasks tagged with this service id." },
      includeDone: { type: "boolean" },
    },
  },
  release: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["soft", "reclaim", "free"],
        description:
          "soft: ready for another workspace to pick up (must be pushed, clean, checkpointed); reclaim: undo a soft release; free: drop ownership.",
      },
      taskId: {
        type: "string",
        description: "Defaults to the linked task (its module or master task is released).",
      },
    },
    required: ["action"],
  },
  promote: {
    type: "object",
    properties: { taskId: { type: "string", description: "Defaults to the linked task." } },
  },
  checkpoint: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Defaults to the linked task." },
      markdown: {
        type: "string",
        description:
          "The WHOLE living handoff (it replaces the previous one). Objective, Workspace, Repository, Branch / HEAD, Working changes, Verified results, Not verified, Decisions and constraints, Next step, Relevant references, Resume. No secrets.",
      },
      lastAction: { type: "string", description: "Optional one-line summary for the board note." },
    },
    required: ["markdown"],
  },
  link: {
    type: "object",
    properties: {
      taskId: {
        type: "string",
        description: "Id (or exact title) of an existing task to link to.",
      },
      newTaskTitle: {
        type: "string",
        description: "Create a new task with this title and link to it.",
      },
      description: { type: "string", description: "What the task is for (new tasks)." },
      decline: { type: "boolean", description: "The person said not to link this chat." },
      override: {
        type: "string",
        enum: ["once", "takeover"],
        description:
          "Only after the person agreed, when the module is owned by another workspace: work here once, or move ownership here.",
      },
      personSaid: {
        type: "string",
        description: "With override: the person's own words approving it (required).",
      },
    },
  },
  update: {
    type: "object",
    properties: {
      taskId: { type: "string", description: "Defaults to the linked task." },
      lastAction: { type: "string", description: "One plain line: what was just done." },
      description: { type: "string" },
      title: { type: "string" },
      status: { type: "string", enum: ["active", "paused", "done"] },
      add: {
        type: "array",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["decision", "todo", "mandatory"] },
            text: { type: "string" },
          },
          required: ["kind", "text"],
        },
      },
      resolve: {
        type: "array",
        items: { type: "string" },
        description: "Item ids now settled/done.",
      },
      services: {
        type: "array",
        items: { type: "string" },
        description: "Replace the task's service tags.",
      },
      mainService: { type: "string" },
      kind: { type: "string", enum: ["feature", "backlog"] },
    },
  },
  plan: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      markdown: {
        type: "string",
        description:
          'The WHOLE plan. "## Phase A — name" headings, "- [ ] A1 name" steps, "- [x]" when done.',
      },
    },
    required: ["markdown"],
  },
  handoff: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      step: { type: "string", description: "Plan step id, e.g. A1." },
      markdown: {
        type: "string",
        description: "What was done, files touched, decisions, what is left, how to test.",
      },
      lastAction: { type: "string", description: "Optional one-line summary for the board note." },
      markStepDone: { type: "boolean", description: "Tick the step in plan.md (default true)." },
    },
    required: ["step", "markdown"],
  },
  read: {
    type: "object",
    properties: {
      taskId: { type: "string" },
      step: { type: "string", description: "Also return this step's handoff." },
    },
  },
};

export interface BoardToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export const BOARD_TOOLS: ReadonlyArray<BoardToolDefinition> = [
  {
    name: "board_setup",
    description:
      "Create a board for this chat's workspace, or add this workspace to an existing board. Only after the person answered which.",
    inputSchema: SCHEMA.setup,
  },
  {
    name: "board_link",
    description:
      "Link this chat to a task on its board (or create one, or record that the person declined). Returns the task's plan and latest handoff.",
    inputSchema: SCHEMA.link,
  },
  {
    name: "board_update",
    description:
      "Update the linked board task: last action line, description, title, status, and add/resolve decisions, todos and must-dos.",
    inputSchema: SCHEMA.update,
  },
  {
    name: "board_plan",
    description: "Save the whole plan (markdown) for the board task.",
    inputSchema: SCHEMA.plan,
  },
  {
    name: "board_handoff",
    description: "Write the handoff note for a finished plan step and tick it in the plan.",
    inputSchema: SCHEMA.handoff,
  },
  {
    name: "board_create_task",
    description:
      "Create a task on the board: a Level 1 master task, a Level 2 module under it, or a Level 3 task under a module. Use it to delegate parts of a plan to later chats.",
    inputSchema: SCHEMA.create,
  },
  {
    name: "board_decision",
    description:
      "Record or settle a decision on the board, filed at the level it affects (1 master task, 2 module, 3 task) and mapped to the task where it came up.",
    inputSchema: SCHEMA.decision,
  },
  {
    name: "board_master_plan",
    description:
      "Write or replace the master implementation plan of the linked task's master task (what its modules and tasks are broken down from).",
    inputSchema: SCHEMA.masterPlan,
  },
  {
    name: "board_doc",
    description:
      "Map a document (tech spec, HLD, LLD, API spec, design, runbook, reference) to a board task by path or URL, or remove one.",
    inputSchema: SCHEMA.doc,
  },
  {
    name: "board_release",
    description:
      "Soft-release, reclaim or drop this workspace's ownership of the linked task's module or master task.",
    inputSchema: SCHEMA.release,
  },
  {
    name: "board_link_task",
    description:
      "Link this task to another (blocked_by, blocks, found_during, led_to, related), e.g. when out-of-scope work is split off.",
    inputSchema: SCHEMA.linkTask,
  },
  {
    name: "board_move",
    description:
      "Move a task (with its subtasks) under another parent, e.g. from a feature into a service backlog.",
    inputSchema: SCHEMA.move,
  },
  {
    name: "board_find",
    description:
      "Find tasks on the board by words and/or service — check for an existing task before creating one.",
    inputSchema: SCHEMA.find,
  },
  {
    name: "board_promote",
    description:
      "Promote a task one level up (task → module → master task) when it is bigger than expected; its subtree moves with it.",
    inputSchema: SCHEMA.promote,
  },
  {
    name: "board_checkpoint",
    description: "Rewrite the task's living handoff in place (the file new chats resume from).",
    inputSchema: SCHEMA.checkpoint,
  },
  {
    name: "board_read",
    description:
      "Read a board task: purpose, open items, plan, latest handoff, or a given step's handoff.",
    inputSchema: SCHEMA.read,
  },
];

export const BOARD_TOOL_NAMES: ReadonlyArray<string> = BOARD_TOOLS.map((t) => t.name);

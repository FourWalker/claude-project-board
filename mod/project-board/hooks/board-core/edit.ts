// @effect-diagnostics extendsNativeError:off
/**
 * Changes to a board's tasks, for every caller: the person in an app (T3's task views, the board
 * app) and agents through the board tools share these, so a task changes the same way whoever
 * changes it.
 *
 * @module board-core/edit
 */
import type { BoardGit } from "./io.ts";
import { markStepDelegated, setDelegatedDone, setStepDone, stepDone } from "./plan.ts";
import { type BoardStore, levelOf } from "./store.ts";
import { isInside, norm, sameRoot, slug, stamp } from "./text.ts";
import type {
  Board,
  Decision,
  ItemKind,
  Level,
  LinkType,
  RepoState,
  Task,
  TaskDoc,
  TaskStatus,
} from "./types.ts";

/** Who made a change, recorded on what it adds: a chat's session id, or an app. */
export interface EditActor {
  readonly by: string;
}

/** A change that can't be made; its message says why, for the person or the agent. */
export class BoardEditError extends Error {}

export type TaskEdit =
  | {
      readonly op: "update";
      readonly title?: string | undefined;
      readonly description?: string | undefined;
      readonly status?: TaskStatus | undefined;
      readonly kind?: "feature" | "backlog" | undefined;
      readonly mainService?: string | null | undefined;
      readonly services?: ReadonlyArray<string> | undefined;
    }
  | { readonly op: "addItem"; readonly kind: Exclude<ItemKind, "decision">; readonly text: string }
  | { readonly op: "toggleItem"; readonly itemId: string }
  | { readonly op: "deleteItem"; readonly itemId: string }
  | { readonly op: "savePlan"; readonly markdown: string }
  | { readonly op: "toggleStep"; readonly step: string }
  | { readonly op: "saveHandoff"; readonly markdown: string }
  | { readonly op: "saveMasterPlan"; readonly markdown: string }
  | {
      readonly op: "addDoc";
      readonly kind: string;
      readonly title: string;
      readonly ref: string;
      readonly note: string;
    }
  | { readonly op: "removeDoc"; readonly docId: string }
  | {
      readonly op: "addLink";
      readonly to: string;
      readonly type: LinkType | "blocks" | "led_to";
      readonly note: string;
    }
  | {
      readonly op: "removeLink";
      readonly to: string;
      readonly type: LinkType | "blocks" | "led_to";
    }
  | { readonly op: "createChild"; readonly title: string; readonly fromStep?: string | undefined }
  | {
      readonly op: "addDecision";
      readonly title: string;
      readonly description: string;
      readonly options: string;
      readonly refs: ReadonlyArray<string>;
      /** The level it affects: filed on this task or the parent at that level. */
      readonly level: Level;
      readonly recommendation?: { readonly area: string } | undefined;
    }
  | {
      readonly op: "setDecision";
      readonly decisionId: string;
      readonly action: "decide" | "drop" | "reopen";
      readonly verdict?: string | undefined;
    }
  | {
      readonly op: "updateDecision";
      readonly decisionId: string;
      readonly title?: string | undefined;
      readonly description?: string | undefined;
      readonly options?: string | undefined;
      readonly refs?: ReadonlyArray<string> | undefined;
    }
  | {
      readonly op: "implemented";
      readonly decisionId: string;
      readonly problem: string;
      readonly approach: string;
      readonly api: string;
      readonly code: string;
      readonly tests: string;
    }
  /** Re-parents the task (null: a master task); its subtasks move with it. */
  | { readonly op: "move"; readonly parentId: string | null }
  /** One level up: task → module → master task; its subtasks move with it. */
  | { readonly op: "promote" }
  /** Gives the task's module (or master task) to a workspace copy, or releases it (null). */
  | { readonly op: "setOwner"; readonly root: string | null }
  /** Hands the module over once everything is pushed, clean and checkpointed. */
  | { readonly op: "softRelease" }
  | { readonly op: "reclaim" };

export interface EditResult {
  readonly message: string;
  /** A task the edit created. */
  readonly createdId?: string | undefined;
}

const LINK_FLIP: Partial<Record<string, LinkType>> = {
  blocks: "blocked_by",
  led_to: "found_during",
};

const newId = (store: BoardStore, prefix: string, upper = false, suffixMax = 0): string => {
  const t = store.clock.now().toString(36);
  return `${prefix}${upper ? t.toUpperCase() : t}${suffixMax ? store.clock.random(suffixMax) : ""}`;
};

async function requireTask(store: BoardStore, boardId: string, id: string): Promise<Task> {
  const task = await store.loadTask(boardId, id);
  if (!task) throw new BoardEditError(`No task "${id}".`);
  return task;
}

/**
 * A subtask that took over a parent plan step finishes that step when it's done, and reopens
 * it when it's reopened, so the parent's next step never points at finished work. Returns the
 * step ids it changed.
 */
export async function syncDelegatedSteps(
  store: BoardStore,
  boardId: string,
  task: Task,
): Promise<string[]> {
  if (!task.parentId) return [];
  const path = store.planPath(boardId, task.parentId);
  const plan = await store.readText(path);
  const updated = setDelegatedDone(plan, task.id, task.status === "done");
  if (updated === plan) return [];
  await store.io.write(path, updated);
  const before = plan.split(/\r?\n/);
  return updated
    .split(/\r?\n/)
    .filter((line, i) => line !== before[i])
    .map((line) => /\]\s+([A-Za-z]*\d+[A-Za-z0-9.]*)/.exec(line)?.[1] ?? "")
    .filter(Boolean);
}

export interface NewTask {
  readonly title: string;
  readonly parentId?: string | null | undefined;
  readonly description?: string | undefined;
  readonly kind?: "feature" | "backlog" | undefined;
  readonly services?: ReadonlyArray<string> | undefined;
  readonly mainService?: string | undefined;
  readonly bug?: boolean | undefined;
  /** For a bug fix: the finished task it fixes. */
  readonly fixes?: string | undefined;
  readonly plan?: string | undefined;
  /** A parent plan step this task takes over. */
  readonly fromStep?: string | undefined;
}

/** Creates a master task, or a module or task under `parentId`. */
export async function createTask(
  store: BoardStore,
  boardId: string,
  input: NewTask,
  actor: EditActor,
): Promise<Task> {
  const title = input.title.trim();
  if (!title) throw new BoardEditError("title is required.");
  const parent = input.parentId ? await requireTask(store, boardId, slug(input.parentId)) : null;
  if (parent && levelOf(parent) >= 3)
    throw new BoardEditError(
      `"${parent.title}" is a Level 3 task and can't have subtasks. Promote it first, then create subtasks under it.`,
    );
  const now = store.clock.now();
  const level = (parent ? levelOf(parent) + 1 : 1) as Level;
  const task: Task = {
    id: await store.freeTaskId(boardId, slug(title)),
    title,
    description: input.description ?? "",
    status: "active",
    createdAt: now,
    updatedAt: now,
    lastAction: null,
    items: [],
    sessions: [],
    level,
    parentId: parent?.id ?? null,
  };
  if (level === 1) task.kind = input.kind === "backlog" ? "backlog" : "feature";
  if (input.services) task.services = [...input.services];
  if (input.mainService) task.mainService = input.mainService;
  if (input.bug) task.bug = true;
  if (input.fixes) {
    const original = await store.loadTask(boardId, slug(input.fixes));
    if (original)
      task.links = [
        { to: original.id, type: "fixes", note: input.description ?? "", at: now, by: actor.by },
      ];
  }
  await store.saveTask(boardId, task);
  if (input.plan) await store.io.write(store.planPath(boardId, task.id), input.plan);
  if (parent && input.fromStep) {
    const path = store.planPath(boardId, parent.id);
    const plan = await store.readText(path);
    const marked = markStepDelegated(plan, input.fromStep, task.id);
    if (marked !== plan) await store.io.write(path, marked);
  }
  return task;
}

/**
 * Files a decision at the level it affects: on `task`, or the parent at that level, mapped back
 * to `task` where it was raised. A recommendation gets the next board-wide R#.
 */
export async function addDecision(
  store: BoardStore,
  boardId: string,
  task: Task,
  input: {
    readonly title: string;
    readonly description?: string | undefined;
    readonly options?: string | undefined;
    readonly refs?: ReadonlyArray<string> | undefined;
    readonly level?: number | undefined;
    readonly recommendation?:
      | {
          readonly r?: string | undefined;
          readonly area?: string | undefined;
          readonly lldCheck?: string | undefined;
          readonly register?: string | null | undefined;
        }
      | undefined;
  },
  actor: EditActor,
): Promise<{ readonly decision: Decision; readonly owner: Task }> {
  const title = input.title.trim();
  if (!title) throw new BoardEditError("title is required.");
  const chain = [task, ...(await store.ancestorsOf(boardId, task))];
  const want = input.level ?? levelOf(task);
  const owner = chain.find((x) => levelOf(x) <= want) ?? chain.at(-1) ?? task;
  const decision: Decision = {
    id: newId(store, "D-", true),
    title,
    description: input.description ?? "",
    level: levelOf(owner),
    raisedFrom: owner.id === task.id ? null : { id: task.id, title: task.title },
    refs: [...(input.refs ?? [])],
    options: input.options ?? "",
    verdict: "",
    status: "open",
    at: store.clock.now(),
    by: actor.by,
  };
  if (input.recommendation) {
    const max = Math.max(
      0,
      ...(await store.listTasks(boardId)).flatMap((x) =>
        (x.decisions ?? []).map((y) => Number(String(y.rec?.r ?? "").replace(/\D/g, "")) || 0),
      ),
    );
    decision.rec = {
      r: input.recommendation.r || `R${max + 1}`,
      area: input.recommendation.area ?? "",
      lldCheck: input.recommendation.lldCheck ?? "",
      register: input.recommendation.register || null,
      implemented: null,
    };
  }
  owner.decisions = [...(owner.decisions ?? []), decision];
  await store.saveTask(boardId, owner);
  return { decision, owner };
}

/** Finds a decision by id or R# on `task`, its parents, or anywhere on the board. */
export async function findDecision(
  store: BoardStore,
  boardId: string,
  task: Task,
  id: string,
): Promise<{ readonly decision: Decision; readonly owner: Task } | null> {
  const has = (x: Task) => (x.decisions ?? []).some((d) => d.id === id || d.rec?.r === id);
  const chain = [task, ...(await store.ancestorsOf(boardId, task))];
  const owner = chain.find(has) ?? (await store.listTasks(boardId)).find(has);
  const decision = owner?.decisions?.find((d) => d.id === id || d.rec?.r === id);
  return owner && decision ? { decision, owner } : null;
}

/** Records the person's verdict, drops a decision, or reopens it. The caller saves `owner`. */
export function settleDecision(
  store: BoardStore,
  decision: Decision,
  action: "decide" | "drop" | "reopen",
  verdict: string,
): void {
  if (action === "decide") {
    decision.status = "decided";
    decision.verdict = verdict;
    decision.decidedAt = store.clock.now();
  } else if (action === "drop") {
    decision.status = "dropped";
    decision.verdict = verdict;
  } else decision.status = "open";
}

/**
 * Links two tasks, or removes the link. `blocks` and `led_to` are stored as the other task's
 * `blocked_by` and `found_during`, so each link lives on one side.
 */
export async function setTaskLink(
  store: BoardStore,
  boardId: string,
  task: Task,
  input: {
    readonly to: string;
    readonly type: string;
    readonly note?: string | undefined;
    readonly remove?: boolean | undefined;
  },
  actor: EditActor,
): Promise<{ readonly from: Task; readonly to: Task; readonly type: LinkType }> {
  const other = await store.loadTask(boardId, slug(input.to));
  if (!other) throw new BoardEditError(`No task "${input.to}".`);
  const flipped = LINK_FLIP[input.type];
  const type = flipped ?? input.type;
  const [from, to] = flipped ? [other, task] : [task, other];
  if (type !== "blocked_by" && type !== "found_during" && type !== "related" && type !== "fixes")
    throw new BoardEditError(
      "type must be blocked_by, blocks, found_during, led_to, related or fixes.",
    );
  if (from.id === to.id) throw new BoardEditError("A task cannot link to itself.");
  from.links = (from.links ?? []).filter((l) => !(l.to === to.id && l.type === type));
  if (!input.remove)
    from.links.push({
      to: to.id,
      type,
      note: input.note ?? "",
      at: store.clock.now(),
      by: actor.by,
    });
  await store.saveTask(boardId, from);
  return { from, to, type };
}

const LEVEL_NAME: Record<Level, string> = { 1: "master task", 2: "module", 3: "task" };

/** Re-parents `task` with its subtree; levels follow, at most three deep. */
export async function moveTask(
  store: BoardStore,
  boardId: string,
  task: Task,
  parentId: string | null,
): Promise<Task | null> {
  const all = await store.listTasks(boardId);
  const parent = parentId ? (all.find((x) => x.id === slug(parentId)) ?? null) : null;
  if (parentId && !parent) throw new BoardEditError(`No task "${parentId}".`);
  const kids = (id: string) => all.filter((x) => x.parentId === id);
  const below = (id: string): Task[] => kids(id).flatMap((k) => [k, ...below(k.id)]);
  if (parent && (parent.id === task.id || below(task.id).some((d) => d.id === parent.id)))
    throw new BoardEditError("Cannot move a task under itself.");
  const height = (id: string): number => 1 + Math.max(0, ...kids(id).map((k) => height(k.id)));
  const level = parent ? levelOf(parent) + 1 : 1;
  if (level + height(task.id) - 1 > 3)
    throw new BoardEditError("That would go deeper than 3 levels.");
  const delta = level - levelOf(task);
  const old = task.parentId ? all.find((x) => x.id === task.parentId) : undefined;
  if (old && old.id !== parent?.id)
    task.origin = [...(task.origin ?? []), { id: old.id, title: old.title }];
  task.parentId = parent?.id ?? null;
  for (const x of [task, ...below(task.id)]) {
    x.level = Math.min(3, Math.max(1, levelOf(x) + delta)) as Level;
    if (x.level === 1 && !x.kind) x.kind = "feature";
    await store.saveTask(boardId, x);
  }
  return parent;
}

/** Moves `task` one level up; its former parent stays reachable as an origin. */
export async function promoteTask(
  store: BoardStore,
  boardId: string,
  task: Task,
): Promise<Task | null> {
  const level = levelOf(task);
  if (level === 1) throw new BoardEditError(`"${task.title}" is already a master task.`);
  const parent = task.parentId ? await store.loadTask(boardId, task.parentId) : null;
  task.origin = [
    ...(task.origin ?? []),
    ...(parent ? [{ id: parent.id, title: parent.title }] : []),
  ];
  task.parentId = parent?.parentId ?? null;
  task.level = (level - 1) as Level;
  for (const d of task.decisions ?? []) if (d.level === level) d.level = task.level;
  if (task.level === 1 && !task.kind) task.kind = "feature";
  await store.saveTask(boardId, task);
  for (const kid of await store.childrenOf(boardId, task.id)) {
    kid.level = (levelOf(kid) - 1 || 1) as Level;
    await store.saveTask(boardId, kid);
  }
  return parent;
}

/** Ownership lives on modules and master tasks; a task belongs to its module's owner. */
async function ownerNodeOf(store: BoardStore, boardId: string, task: Task): Promise<Task> {
  if (levelOf(task) === 3 && task.parentId)
    return (await store.loadTask(boardId, task.parentId)) ?? task;
  return task;
}

function ownerHistory(
  store: BoardStore,
  task: Task,
  type: string,
  actor: EditActor,
  extra: { from?: string | undefined; to?: string | undefined },
): void {
  task.ownerHistory = [
    ...(task.ownerHistory ?? []),
    { type, at: store.clock.now(), by: actor.by, ...extra },
  ].slice(-30);
}

/** The repos a module works in, in workspace copy `root`: its tree's service folders there. */
async function reposAt(
  store: BoardStore,
  boardId: string,
  board: Board,
  node: Task,
  root: string,
  git: BoardGit,
): Promise<RepoState[]> {
  const all = await store.listTasks(boardId);
  const below = (id: string): Task[] =>
    all.filter((x) => x.parentId === id).flatMap((k) => [k, ...below(k.id)]);
  const ids = new Set(
    [node, ...below(node.id)].flatMap((x) => [
      ...(x.services ?? []),
      ...(x.mainService ? [x.mainService] : []),
    ]),
  );
  const seen = new Map<string, RepoState>();
  for (const svc of board.services ?? [])
    if (ids.has(svc.id))
      for (const m of svc.match) {
        const dir = `${norm(root)}/${m}`;
        if (!(await store.io.exists(dir).catch(() => false))) continue;
        const state = await git.state(dir);
        if (state && !seen.has(state.repo)) seen.set(state.repo, { ...state, service: svc.id });
      }
  if (seen.size === 0) {
    const state = await git.state(norm(root)).catch(() => null);
    if (state) seen.set(state.repo, state);
  }
  return [...seen.values()];
}

/** Why a module isn't ready to hand over: unpushed or uncommitted work, or a stale handoff. */
async function softReleaseProblems(
  store: BoardStore,
  boardId: string,
  node: Task,
  repos: ReadonlyArray<RepoState>,
): Promise<string[]> {
  const problems: string[] = [];
  if (!repos.length) problems.push("no repos found: tag the services it touches first");
  for (const r of repos) {
    if (!r.upstream) problems.push(`${r.name}: branch ${r.branch} has no upstream, push it`);
    else if (r.ahead) problems.push(`${r.name}: ${r.ahead} commit(s) on ${r.branch} not pushed`);
    if (r.dirty) problems.push(`${r.name}: ${r.dirty} uncommitted change(s)`);
  }
  const all = await store.listTasks(boardId);
  const below = (id: string): Task[] =>
    all.filter((x) => x.parentId === id).flatMap((k) => [k, ...below(k.id)]);
  let handoffAt = 0;
  for (const x of [node, ...below(node.id)]) {
    const at = await store.io
      .stat(store.livingPath(boardId, x.id))
      .then((s) => s.mtimeMs)
      .catch(() => 0);
    handoffAt = Math.max(handoffAt, at);
  }
  const lastCommit = Math.max(0, ...repos.map((r) => r.lastCommitAt));
  if (repos.length && handoffAt < lastCommit)
    problems.push("the living handoff is older than the last commit: checkpoint first");
  return problems;
}

/** Applies one change a person made to a task in an app. `git` reads repo state for a soft release. */
export async function editTask(
  store: BoardStore,
  boardId: string,
  taskId: string,
  edit: TaskEdit,
  actor: EditActor,
  git?: BoardGit,
): Promise<EditResult> {
  const task = await requireTask(store, boardId, taskId);
  const now = store.clock.now();
  switch (edit.op) {
    case "update": {
      const wasDone = task.status === "done";
      if (edit.title !== undefined) {
        const title = edit.title.trim();
        if (!title) throw new BoardEditError("The title can't be empty.");
        task.title = title;
      }
      if (edit.description !== undefined) task.description = edit.description;
      if (edit.status !== undefined) task.status = edit.status;
      if (edit.kind !== undefined && levelOf(task) === 1) task.kind = edit.kind;
      if (edit.mainService !== undefined) task.mainService = edit.mainService;
      if (edit.services !== undefined) task.services = [...new Set(edit.services)];
      await store.saveTask(boardId, task);
      const steps =
        wasDone !== (task.status === "done") ? await syncDelegatedSteps(store, boardId, task) : [];
      return {
        message: steps.length
          ? `Saved. ${task.status === "done" ? "Ticked" : "Reopened"} ${steps.join(", ")} in the parent's plan.`
          : "Saved.",
      };
    }
    case "addItem": {
      const text = edit.text.trim();
      if (!text) throw new BoardEditError("The item is empty.");
      task.items.push({
        id: newId(store, edit.kind[0] ?? "t", false, 99),
        kind: edit.kind,
        text,
        done: false,
        at: now,
        by: actor.by,
      });
      await store.saveTask(boardId, task);
      return { message: "Added." };
    }
    case "toggleItem":
    case "deleteItem": {
      const item = task.items.find((i) => i.id === edit.itemId);
      if (!item) throw new BoardEditError("No such item.");
      if (edit.op === "toggleItem") item.done = !item.done;
      else task.items = task.items.filter((i) => i.id !== edit.itemId);
      await store.saveTask(boardId, task);
      return { message: "Saved." };
    }
    case "savePlan":
      await store.io.write(store.planPath(boardId, task.id), edit.markdown.trimEnd() + "\n");
      await store.saveTask(boardId, task);
      return { message: "Plan saved." };
    case "toggleStep": {
      const path = store.planPath(boardId, task.id);
      const plan = await store.readText(path);
      const done = stepDone(plan, edit.step);
      if (done === null) throw new BoardEditError(`No step "${edit.step}" in the plan.`);
      await store.io.write(path, setStepDone(plan, edit.step, !done));
      await store.saveTask(boardId, task);
      return { message: "Saved." };
    }
    case "saveHandoff": {
      const md = edit.markdown.trim();
      const header = `<!-- living handoff, rewritten in place · last by ${actor.by}, ${stamp(now)} -->\n`;
      await store.io.write(store.livingPath(boardId, task.id), md ? header + md + "\n" : "");
      await store.saveTask(boardId, task);
      return { message: "Handoff saved." };
    }
    case "saveMasterPlan": {
      const ancestors = await store.ancestorsOf(boardId, task);
      const master = levelOf(task) === 1 ? task : (ancestors.at(-1) ?? task);
      await store.io.write(store.masterPath(boardId, master.id), edit.markdown.trimEnd() + "\n");
      await store.saveTask(boardId, master);
      return { message: "Master plan saved." };
    }
    case "addDoc": {
      const ref = edit.ref.trim();
      if (!ref) throw new BoardEditError("A path or URL is required.");
      const doc: TaskDoc = {
        id: newId(store, "doc-"),
        kind: edit.kind || "Reference",
        title: edit.title.trim() || ref.split(/[\\/]/).pop() || ref,
        ref,
        note: edit.note,
        at: now,
        by: actor.by,
      };
      task.docs = [...(task.docs ?? []), doc];
      await store.saveTask(boardId, task);
      return { message: "Document added." };
    }
    case "removeDoc":
      if (!(task.docs ?? []).some((d) => d.id === edit.docId))
        throw new BoardEditError("No such document on this task.");
      task.docs = (task.docs ?? []).filter((d) => d.id !== edit.docId);
      await store.saveTask(boardId, task);
      return { message: "Document removed." };
    case "addLink":
    case "removeLink":
      await setTaskLink(
        store,
        boardId,
        task,
        {
          to: edit.to,
          type: edit.type,
          note: edit.op === "addLink" ? edit.note : "",
          remove: edit.op === "removeLink",
        },
        actor,
      );
      return { message: edit.op === "addLink" ? "Linked." : "Link removed." };
    case "createChild": {
      const child = await createTask(
        store,
        boardId,
        { title: edit.title, parentId: task.id, fromStep: edit.fromStep },
        actor,
      );
      return { message: `Created "${child.title}".`, createdId: child.id };
    }
    case "addDecision": {
      const { decision, owner } = await addDecision(
        store,
        boardId,
        task,
        {
          title: edit.title,
          description: edit.description,
          options: edit.options,
          refs: edit.refs,
          level: edit.level,
          recommendation: edit.recommendation,
        },
        actor,
      );
      return {
        message: `${decision.rec ? `Recommendation ${decision.rec.r}` : "Decision"} filed on "${owner.title}".`,
      };
    }
    case "setDecision": {
      const found = await findDecision(store, boardId, task, edit.decisionId);
      if (!found) throw new BoardEditError(`No decision "${edit.decisionId}".`);
      settleDecision(store, found.decision, edit.action, edit.verdict ?? "");
      await store.saveTask(boardId, found.owner);
      return { message: `Decision is now ${found.decision.status}.` };
    }
    case "updateDecision": {
      const found = await findDecision(store, boardId, task, edit.decisionId);
      if (!found) throw new BoardEditError(`No decision "${edit.decisionId}".`);
      const d = found.decision;
      if (edit.title !== undefined) {
        if (!edit.title.trim()) throw new BoardEditError("The question can't be empty.");
        d.title = edit.title.trim();
      }
      if (edit.description !== undefined) d.description = edit.description;
      if (edit.options !== undefined) d.options = edit.options;
      if (edit.refs !== undefined) d.refs = [...edit.refs];
      await store.saveTask(boardId, found.owner);
      return { message: "Decision saved." };
    }
    case "implemented": {
      const found = await findDecision(store, boardId, task, edit.decisionId);
      if (!found) throw new BoardEditError(`No decision "${edit.decisionId}".`);
      if (!found.decision.rec)
        throw new BoardEditError("Only recommendations have a How implemented record.");
      found.decision.rec.implemented = {
        problem: edit.problem,
        approach: edit.approach,
        api: edit.api,
        code: edit.code,
        tests: edit.tests,
        at: now,
      };
      await store.saveTask(boardId, found.owner);
      return { message: "How implemented saved." };
    }
    case "move": {
      const parent = await moveTask(store, boardId, task, edit.parentId);
      return {
        message: parent
          ? `Moved under "${parent.title}" (now a ${LEVEL_NAME[levelOf(task)]}).`
          : "Moved to the top level (master task).",
      };
    }
    case "promote": {
      await promoteTask(store, boardId, task);
      return { message: `Promoted to ${LEVEL_NAME[levelOf(task)]}.` };
    }
    case "setOwner": {
      const node = await ownerNodeOf(store, boardId, task);
      if (edit.root === null) {
        if (node.owner) ownerHistory(store, node, "release", actor, { from: node.owner.label });
        node.owner = null;
        await store.saveTask(boardId, node);
        return { message: `Released "${node.title}": the next workspace to link claims it.` };
      }
      const board = (await store.loadRegistry()).boards.find((b) => b.id === boardId);
      const root = board?.roots.find((r) => sameRoot(r.path, edit.root ?? ""));
      if (!root) throw new BoardEditError("That folder is not a workspace of this board.");
      ownerHistory(store, node, node.owner ? "takeover" : "assigned", actor, {
        from: node.owner?.label,
        to: root.label,
      });
      node.owner = { root: norm(root.path), label: root.label, state: "owned", since: now };
      await store.saveTask(boardId, node);
      return { message: `"${node.title}" is owned by ${root.label}.` };
    }
    case "softRelease": {
      const node = await ownerNodeOf(store, boardId, task);
      if (!node.owner) throw new BoardEditError("Nobody owns this module or master task.");
      if (!git) throw new BoardEditError("Repo state can't be read here.");
      const board = (await store.loadRegistry()).boards.find((b) => b.id === boardId);
      if (!board) throw new BoardEditError("No such board.");
      const repos = await reposAt(store, boardId, board, node, node.owner.root, git);
      const problems = await softReleaseProblems(store, boardId, node, repos);
      if (problems.length)
        throw new BoardEditError(`Not ready for a soft release: ${problems.join("; ")}.`);
      node.owner = { ...node.owner, state: "soft", softAt: now, pickup: repos };
      ownerHistory(store, node, "soft-release", actor, { from: node.owner.label });
      await store.saveTask(boardId, node);
      return { message: `Soft-released "${node.title}": another workspace can take over.` };
    }
    case "reclaim": {
      const node = await ownerNodeOf(store, boardId, task);
      if (!node.owner) throw new BoardEditError("Nobody owns this module or master task.");
      const { softAt: _softAt, pickup: _pickup, ...owned } = node.owner;
      node.owner = { ...owned, state: "owned" };
      ownerHistory(store, node, "reclaim", actor, { to: node.owner.label });
      await store.saveTask(boardId, node);
      return { message: `"${node.title}" is owned by ${node.owner.label} again.` };
    }
  }
}

/** A change to a board's own settings, made with ⚙ in an app. */
export type BoardSettingsEdit =
  | { readonly op: "rename"; readonly name: string }
  | { readonly op: "addRoot"; readonly path: string; readonly label: string }
  | { readonly op: "removeRoot"; readonly path: string }
  | { readonly op: "labelRoot"; readonly path: string; readonly label: string }
  | {
      readonly op: "saveServices";
      readonly services: ReadonlyArray<{
        readonly id?: string | undefined;
        readonly name: string;
        readonly match: ReadonlyArray<string>;
      }>;
    }
  | { readonly op: "saveRules"; readonly rules: string }
  | { readonly op: "setBoardMode"; readonly on: boolean }
  | {
      readonly op: "saveRegisters";
      readonly registers: ReadonlyArray<{
        readonly id?: string | undefined;
        readonly topic: string;
        readonly url: string;
      }>;
    };

const baseName = (p: string) => norm(p).split("/").pop() ?? p;

/** Applies one change to the board's settings in `boards.json`. */
export async function editBoard(
  store: BoardStore,
  boardId: string,
  edit: BoardSettingsEdit,
): Promise<EditResult> {
  const reg = await store.loadRegistry();
  const board = reg.boards.find((b) => b.id === boardId);
  if (!board) throw new BoardEditError("No such board.");
  switch (edit.op) {
    case "rename": {
      const name = edit.name.trim();
      if (!name) throw new BoardEditError("The board needs a name.");
      if (reg.boards.some((b) => b.id !== boardId && b.name.toLowerCase() === name.toLowerCase()))
        throw new BoardEditError(`A board named ${name} already exists.`);
      board.name = name;
      break;
    }
    case "addRoot": {
      const path = norm(edit.path.trim());
      if (!path) throw new BoardEditError("A folder is required.");
      if (!(await store.io.exists(path).catch(() => false)))
        throw new BoardEditError(`No folder at ${path}.`);
      const taken = reg.boards.find((b) =>
        b.roots.some(
          (r) => sameRoot(r.path, path) || isInside(path, r.path) || isInside(r.path, path),
        ),
      );
      if (taken)
        throw new BoardEditError(
          taken.id === boardId
            ? "That folder is already a workspace of this board, or inside one."
            : `That folder overlaps a workspace of the ${taken.name} board.`,
        );
      board.roots.push({ path, label: edit.label.trim() || baseName(path) });
      break;
    }
    case "removeRoot": {
      if (board.roots.length <= 1)
        throw new BoardEditError("A board keeps at least one workspace.");
      const before = board.roots.length;
      board.roots = board.roots.filter((r) => !sameRoot(r.path, edit.path));
      if (board.roots.length === before) throw new BoardEditError("No such workspace.");
      break;
    }
    case "labelRoot": {
      const root = board.roots.find((r) => sameRoot(r.path, edit.path));
      if (!root) throw new BoardEditError("No such workspace.");
      if (!edit.label.trim()) throw new BoardEditError("The workspace needs a label.");
      root.label = edit.label.trim();
      break;
    }
    case "saveServices":
      board.services = edit.services
        .map((x) => ({
          id: slug(x.id || x.name),
          name: x.name.trim(),
          match: x.match
            .map((m) =>
              m
                .trim()
                .replace(/\\/g, "/")
                .replace(/^\/+|\/+$/g, ""),
            )
            .filter(Boolean),
        }))
        .filter((x) => x.name);
      break;
    case "saveRules":
      board.rules = edit.rules;
      break;
    case "setBoardMode":
      board.boardMode = edit.on;
      break;
    case "saveRegisters":
      board.registers = edit.registers
        .map((x) => ({ id: slug(x.id || x.topic), topic: x.topic.trim(), url: x.url.trim() }))
        .filter((x) => x.topic);
      break;
  }
  await store.saveRegistry(reg);
  return { message: "Saved." };
}

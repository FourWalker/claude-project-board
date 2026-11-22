// @effect-diagnostics extendsNativeError:off
/**
 * Changes to a board's tasks, for every caller: the person in an app (T3's task views, the board
 * app) and agents through the board tools share these, so a task changes the same way whoever
 * changes it.
 *
 * @module board-core/edit
 */
import { markStepDelegated, setDelegatedDone, setStepDone, stepDone } from "./plan.ts";
import { type BoardStore, levelOf } from "./store.ts";
import { slug, stamp } from "./text.ts";
import type { Decision, ItemKind, Level, LinkType, Task, TaskDoc, TaskStatus } from "./types.ts";

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
    };

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

/** Applies one change a person made to a task in an app. */
export async function editTask(
  store: BoardStore,
  boardId: string,
  taskId: string,
  edit: TaskEdit,
  actor: EditActor,
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
  }
}

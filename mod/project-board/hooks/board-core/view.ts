/**
 * What a board shows: its tasks with plan progress, last action and linked chats, and the chats
 * not on a task. Same rules as the board app (app/server.js), so both show a board alike.
 *
 * @module board-core/view
 */
import { nextStep, planProgress, type PlanStep } from "./plan.ts";
import type { BoardStore } from "./store.ts";
import { norm } from "./text.ts";
import type {
  Decision,
  Item,
  Level,
  Owner,
  Session,
  Task,
  TaskDoc,
  TaskLink,
  TaskStatus,
} from "./types.ts";

/** The board app marks a chat offline after this long without a heartbeat. */
export const OFFLINE_MS = 2.5 * 60 * 1000;

export type BoardChatLive = "working" | "idle" | "ended" | "offline";

export interface BoardSummary {
  readonly id: string;
  readonly name: string;
  readonly taskCount: number;
}

export interface BoardViewChat {
  readonly sessionId: string;
  readonly title: string;
  readonly live: BoardChatLive;
  readonly workspaceLabel: string;
  readonly taskId: string | null;
  readonly updatedAt: number;
  /** Set for T3 threads: the thread to open. */
  readonly threadId: string | null;
  readonly provider: string | null;
  /** When the chat's current (or last) turn started; 0 before its first. */
  readonly turnStartedAt: number;
}

/** A decision as the board screen lists it; its full text is read with the task. */
export interface BoardViewDecision {
  readonly id: string;
  readonly title: string;
  readonly status: Decision["status"];
  readonly level: Level;
  readonly raisedFrom: { readonly id: string; readonly title: string } | null;
  /** The recommendation's R#, when the decision is one. */
  readonly r: string | null;
}

export interface BoardViewTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly level: Level;
  readonly parentId: string | null;
  /** Level 1 only: a feature or a service backlog. */
  readonly kind: "feature" | "backlog" | null;
  readonly bug: boolean;
  readonly mainService: string | null;
  readonly services: ReadonlyArray<string>;
  readonly lastAction: {
    readonly text: string;
    readonly at: number;
    readonly workspaceLabel: string;
    readonly sessionId: string;
  } | null;
  readonly next: PlanStep | null;
  readonly steps: { readonly done: number; readonly total: number };
  readonly chats: ReadonlyArray<BoardViewChat>;
  readonly items: ReadonlyArray<Pick<Item, "id" | "kind" | "text" | "done">>;
  readonly decisions: ReadonlyArray<BoardViewDecision>;
  readonly links: ReadonlyArray<Pick<TaskLink, "to" | "type" | "note">>;
  /** Set on the module or master task itself; tasks inherit it (see `ownerRoot`). */
  readonly owner: Pick<Owner, "root" | "label" | "state"> | null;
  readonly createdAt: number;
  readonly updatedAt: number;
  /** The root of the workspace copy that owns the task's module or master task, if one does. */
  readonly ownerRoot: string | null;
}

export interface BoardView {
  readonly id: string;
  readonly name: string;
  readonly boardMode: boolean;
  readonly services: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly match: ReadonlyArray<string>;
  }>;
  /** Each copy of the project the board spans: the folders a thread can work on its tasks in. */
  readonly workspaces: ReadonlyArray<{ readonly label: string; readonly root: string }>;
  readonly tasks: ReadonlyArray<BoardViewTask>;
  /** Chats on the board that aren't linked to a task and haven't ended (offline ones too). */
  readonly unlinked: ReadonlyArray<BoardViewChat>;
}

export const liveOf = (s: Pick<Session, "status" | "heartbeatAt">, now: number): BoardChatLive =>
  s.status === "ended" ? "ended" : now - (s.heartbeatAt || 0) > OFFLINE_MS ? "offline" : s.status;

const chatOf = (s: Session, now: number): BoardViewChat => ({
  sessionId: s.sessionId,
  title: s.title || s.lastPrompt.split("\n")[0] || "",
  live: liveOf(s, now),
  workspaceLabel: s.workspaceLabel,
  taskId: s.taskId,
  updatedAt: s.updatedAt,
  threadId: s.source?.kind === "t3-thread" ? s.source.threadId : null,
  provider: s.source?.kind === "t3-thread" ? (s.source.provider ?? null) : null,
  turnStartedAt: s.turnStartedAt || 0,
});

export async function readBoardSummaries(store: BoardStore): Promise<BoardSummary[]> {
  const reg = await store.loadRegistry();
  return Promise.all(
    reg.boards.map(async (b) => ({
      id: b.id,
      name: b.name,
      taskCount: (await store.listTasks(b.id)).length,
    })),
  );
}

export async function readBoardView(
  store: BoardStore,
  boardId: string,
  now: number,
): Promise<BoardView | null> {
  const board = (await store.loadRegistry()).boards.find((b) => b.id === boardId);
  if (!board) return null;
  // Helper runs that never took a prompt, and records replaced by a newer one, aren't chats.
  const sessions = (await store.listSessions(boardId))
    .filter((s) => !s.supersededBy && (s.taskId || s.lastPrompt || s.title))
    .toSorted((a, b) => b.updatedAt - a.updatedAt);
  const chats = sessions.map((s) => chatOf(s, now));
  const all = await store.listTasks(boardId);
  const byId = new Map(all.map((t) => [t.id, t]));
  // As BoardChat.ownerHolder: a task belongs to its module's owner, else the nearest owned parent.
  const ownerRoot = (t: Task): string | null => {
    let cur = t.level === 3 && t.parentId ? (byId.get(t.parentId) ?? t) : t;
    for (let i = 0; i < 3; i++) {
      if (cur.owner) return norm(cur.owner.root);
      const up = cur.parentId ? byId.get(cur.parentId) : undefined;
      if (!up) return null;
      cur = up;
    }
    return null;
  };
  const tasks = await Promise.all(
    all.map(async (t: Task): Promise<BoardViewTask> => {
      const plan = await store.readText(store.planPath(boardId, t.id));
      return {
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        level: t.level === 2 || t.level === 3 ? t.level : 1,
        parentId: t.parentId ?? null,
        kind: t.level === 2 || t.level === 3 ? null : t.kind === "backlog" ? "backlog" : "feature",
        bug: !!t.bug,
        mainService: t.mainService ?? null,
        services: t.services ?? [],
        lastAction: t.lastAction
          ? {
              text: t.lastAction.text,
              at: t.lastAction.at,
              workspaceLabel: t.lastAction.workspaceLabel,
              sessionId: t.lastAction.sessionId,
            }
          : null,
        next: nextStep(plan),
        steps: planProgress(plan),
        chats: chats.filter((c) => c.taskId === t.id),
        items: t.items.map((i) => ({ id: i.id, kind: i.kind, text: i.text, done: i.done })),
        decisions: (t.decisions ?? []).map((d) => ({
          id: d.id,
          title: d.title,
          status: d.status,
          level: d.level || (t.level === 2 || t.level === 3 ? t.level : 1),
          raisedFrom: d.raisedFrom ?? null,
          r: d.rec?.r ?? null,
        })),
        links: (t.links ?? []).map((l) => ({ to: l.to, type: l.type, note: l.note })),
        owner: t.owner
          ? { root: norm(t.owner.root), label: t.owner.label, state: t.owner.state }
          : null,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        ownerRoot: ownerRoot(t),
      };
    }),
  );
  return {
    id: board.id,
    name: board.name,
    boardMode: !!board.boardMode,
    services: (board.services ?? []).map((s) => ({ id: s.id, name: s.name, match: s.match })),
    workspaces: board.roots.map((r) => ({ label: r.label, root: norm(r.path) })),
    tasks: tasks.toSorted((a, b) => b.updatedAt - a.updatedAt),
    unlinked: chats.filter((c) => c.taskId === null && c.live !== "ended"),
  };
}

/** One task's documents as its task views show them: the texts the board screen leaves out. */
export interface BoardTaskDetail {
  /** The master implementation plan of the task's master task (its own, for a master task). */
  readonly masterPlan: string;
  readonly masterTaskId: string;
  readonly plan: string;
  /** The living handoff, without its header comment. */
  readonly handoff: string;
  readonly latestNote: { readonly step: string; readonly text: string } | null;
  readonly docs: ReadonlyArray<Pick<TaskDoc, "id" | "kind" | "title" | "ref" | "note">>;
  /** Decisions filed on this task, and on its parents when raised here. */
  readonly decisions: ReadonlyArray<
    Pick<Decision, "id" | "title" | "description" | "options" | "verdict" | "status" | "level"> & {
      readonly r: string | null;
      readonly filedOn: { readonly id: string; readonly title: string };
    }
  >;
}

const stripHeader = (md: string) => md.replace(/^<!--[\s\S]*?-->\s*/, "");

export async function readTaskDetail(
  store: BoardStore,
  boardId: string,
  taskId: string,
): Promise<BoardTaskDetail | null> {
  const task = await store.loadTask(boardId, taskId);
  if (!task) return null;
  const ancestors = await store.ancestorsOf(boardId, task);
  const master = ancestors[0] ?? task;
  const [masterPlan, plan, handoff, latestNote] = await Promise.all([
    store.readText(store.masterPath(boardId, master.id)),
    store.readText(store.planPath(boardId, task.id)),
    store.readText(store.livingPath(boardId, task.id)),
    store.latestHandoff(boardId, task.id),
  ]);
  const decisions = [task, ...ancestors].flatMap((owner) =>
    (owner.decisions ?? [])
      .filter((d) => owner.id === task.id || d.raisedFrom?.id === task.id)
      .map((d) => ({
        id: d.id,
        title: d.title,
        description: d.description,
        options: d.options,
        verdict: d.verdict,
        status: d.status,
        level: d.level,
        r: d.rec?.r ?? null,
        filedOn: { id: owner.id, title: owner.title },
      })),
  );
  return {
    masterPlan,
    masterTaskId: master.id,
    plan,
    handoff: stripHeader(handoff),
    latestNote: latestNote ? { step: latestNote.step, text: stripHeader(latestNote.text) } : null,
    docs: (task.docs ?? []).map((d) => ({
      id: d.id,
      kind: d.kind,
      title: d.title,
      ref: d.ref,
      note: d.note,
    })),
    decisions,
  };
}

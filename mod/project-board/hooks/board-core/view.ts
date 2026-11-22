/**
 * What a board shows: its tasks with plan progress, last action and linked chats, and the chats
 * not on a task. Same rules as the board app (app/server.js), so both show a board alike.
 *
 * @module board-core/view
 */
import { nextStep, planProgress, type PlanStep } from "./plan.ts";
import type { BoardStore } from "./store.ts";
import { norm } from "./text.ts";
import type { Level, Session, Task, TaskStatus } from "./types.ts";

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
}

export interface BoardViewTask {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly level: Level;
  readonly parentId: string | null;
  readonly services: ReadonlyArray<string>;
  readonly lastAction: {
    readonly text: string;
    readonly at: number;
    readonly workspaceLabel: string;
  } | null;
  readonly next: PlanStep | null;
  readonly steps: { readonly done: number; readonly total: number };
  readonly chats: ReadonlyArray<BoardViewChat>;
  readonly updatedAt: number;
  /** The root of the workspace copy that owns the task's module or master task, if one does. */
  readonly ownerRoot: string | null;
}

export interface BoardView {
  readonly id: string;
  readonly name: string;
  readonly services: ReadonlyArray<{ readonly id: string; readonly name: string }>;
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
        services: t.services ?? [],
        lastAction: t.lastAction
          ? {
              text: t.lastAction.text,
              at: t.lastAction.at,
              workspaceLabel: t.lastAction.workspaceLabel,
            }
          : null,
        next: nextStep(plan),
        steps: planProgress(plan),
        chats: chats.filter((c) => c.taskId === t.id),
        updatedAt: t.updatedAt,
        ownerRoot: ownerRoot(t),
      };
    }),
  );
  return {
    id: board.id,
    name: board.name,
    services: (board.services ?? []).map((s) => ({ id: s.id, name: s.name })),
    workspaces: board.roots.map((r) => ({ label: r.label, root: norm(r.path) })),
    tasks: tasks.toSorted((a, b) => b.updatedAt - a.updatedAt),
    unlinked: chats.filter((c) => c.taskId === null && c.live !== "ended"),
  };
}

/**
 * What a board shows: its tasks with plan progress, last action and linked chats, and the chats
 * not on a task. Same rules as the board app (app/server.js), so both show a board alike.
 *
 * @module board-core/view
 */
import {
  nextStep,
  objectiveLine,
  type PlanPhase,
  planPhases,
  planProgress,
  type PlanStep,
} from "./plan.ts";
import type { BoardStore } from "./store.ts";
import { norm } from "./text.ts";
import type {
  Decision,
  Item,
  Level,
  Owner,
  RepoState,
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
  readonly plan: ReadonlyArray<PlanPhase>;
  /** plan.md as written, for editing. */
  readonly planMarkdown: string;
  /** The living handoff, without its header comment. */
  readonly handoff: string;
  /** Step notes, newest first. */
  readonly stepNotes: ReadonlyArray<{
    readonly step: string;
    readonly at: number;
    readonly text: string;
  }>;
  /** This task's documents (`from` null), then its parents'. */
  readonly docs: ReadonlyArray<
    Pick<TaskDoc, "id" | "kind" | "title" | "ref" | "note"> & {
      readonly from: { readonly id: string; readonly title: string; readonly level: Level } | null;
    }
  >;
  /**
   * `own`: filed on this task; `up`: raised here, filed on a parent; `inherited`: a parent's
   * own decisions.
   */
  readonly decisions: ReadonlyArray<
    Pick<
      Decision,
      "id" | "title" | "description" | "options" | "verdict" | "status" | "level" | "refs" | "at"
    > & {
      readonly group: "own" | "up" | "inherited";
      readonly r: string | null;
      readonly area: string;
      /** A decided recommendation's record of how it was built. */
      readonly implemented: {
        readonly problem: string;
        readonly approach: string;
        readonly api: string;
        readonly code: string;
        readonly tests: string;
      } | null;
      readonly decidedAt: number | null;
      readonly raisedFrom: { readonly id: string; readonly title: string } | null;
      readonly filedOn: { readonly id: string; readonly title: string };
    }
  >;
  readonly repoState: ReadonlyArray<
    Pick<RepoState, "name" | "branch" | "head" | "upstream" | "ahead" | "behind" | "dirty" | "at">
  >;
  /** Root first: each parent's objective line, as chats on this task see it. */
  readonly parents: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly level: Level;
    readonly objective: string;
  }>;
  /** What each chat on this task (on a master task, in its tree) last asked and answered. */
  readonly chats: ReadonlyArray<{
    readonly sessionId: string;
    readonly lastPrompt: string;
    readonly lastAnswer: string;
    readonly branch: string;
    readonly subfolder: string;
  }>;
}

const stripHeader = (md: string) => md.replace(/^<!--[\s\S]*?-->\s*/, "");
const levelOf = (t: Task): Level => (t.level === 2 || t.level === 3 ? t.level : 1);

export async function readTaskDetail(
  store: BoardStore,
  boardId: string,
  taskId: string,
): Promise<BoardTaskDetail | null> {
  const task = await store.loadTask(boardId, taskId);
  if (!task) return null;
  const ancestors = await store.ancestorsOf(boardId, task);
  const rootFirst = ancestors.toReversed();
  const master = rootFirst[0] ?? task;
  const [masterPlan, plan, handoff, stepNotes, parentHandoffs, sessions, all] = await Promise.all([
    store.readText(store.masterPath(boardId, master.id)),
    store.readText(store.planPath(boardId, task.id)),
    store.readText(store.livingPath(boardId, task.id)),
    store.stepNotes(boardId, task.id),
    Promise.all(rootFirst.map((a) => store.readText(store.livingPath(boardId, a.id)))),
    store.listSessions(boardId),
    levelOf(task) === 1 ? store.listTasks(boardId) : Promise.resolve([] as Task[]),
  ]);
  // A master task's chats are every chat in its tree.
  const tree = new Set([task.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of all)
      if (t.parentId && tree.has(t.parentId) && !tree.has(t.id)) {
        tree.add(t.id);
        grew = true;
      }
  }
  const decision =
    (group: "own" | "up" | "inherited", owner: Task) =>
    (d: Decision): BoardTaskDetail["decisions"][number] => ({
      id: d.id,
      title: d.title,
      description: d.description,
      options: d.options,
      verdict: d.verdict,
      status: d.status,
      level: d.level,
      refs: d.refs ?? [],
      at: d.at,
      group,
      r: d.rec?.r ?? null,
      area: d.rec?.area ?? "",
      implemented: d.rec?.implemented
        ? {
            problem: d.rec.implemented.problem ?? "",
            approach: d.rec.implemented.approach ?? "",
            api: d.rec.implemented.api ?? "",
            code: d.rec.implemented.code ?? "",
            tests: d.rec.implemented.tests ?? "",
          }
        : null,
      decidedAt: d.decidedAt ?? null,
      raisedFrom: d.raisedFrom ?? null,
      filedOn: { id: owner.id, title: owner.title },
    });
  return {
    masterPlan,
    masterTaskId: master.id,
    plan: planPhases(plan),
    planMarkdown: plan,
    handoff: stripHeader(handoff),
    stepNotes: stepNotes.map((n) => ({ ...n, text: stripHeader(n.text) })),
    docs: [
      ...(task.docs ?? []).map((d) => ({ ...docOf(d), from: null })),
      ...rootFirst.flatMap((a) =>
        (a.docs ?? []).map((d) => ({
          ...docOf(d),
          from: { id: a.id, title: a.title, level: levelOf(a) },
        })),
      ),
    ],
    decisions: [
      ...(task.decisions ?? []).map(decision("own", task)),
      ...ancestors.flatMap((a) =>
        (a.decisions ?? []).filter((d) => d.raisedFrom?.id === task.id).map(decision("up", a)),
      ),
      ...ancestors.flatMap((a) =>
        (a.decisions ?? [])
          .filter((d) => d.raisedFrom?.id !== task.id)
          .map(decision("inherited", a)),
      ),
    ],
    repoState: (task.repoState ?? []).map((r) => ({
      name: r.name,
      branch: r.branch,
      head: r.head,
      upstream: r.upstream,
      ahead: r.ahead,
      behind: r.behind,
      dirty: r.dirty,
      at: r.at,
    })),
    parents: rootFirst.map((a, i) => ({
      id: a.id,
      title: a.title,
      level: levelOf(a),
      objective: parentHandoffs[i] ? objectiveLine(parentHandoffs[i]) : a.description,
    })),
    chats: sessions
      .filter((x) => !x.supersededBy && x.taskId !== null && tree.has(x.taskId))
      .map((x) => ({
        sessionId: x.sessionId,
        lastPrompt: x.lastPrompt,
        lastAnswer: x.lastAnswer,
        branch: x.branch,
        subfolder: x.subfolder,
      })),
  };
}

const docOf = (d: TaskDoc) => ({
  id: d.id,
  kind: d.kind,
  title: d.title,
  ref: d.ref,
  note: d.note,
});

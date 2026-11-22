/**
 * Reads and writes the board folder (`~/.claude-board`): the registry, each board's tasks, plans,
 * handoffs and chat records. Layout: the board repo's docs/DATA-LAYOUT.md.
 *
 * @module board-core/store
 */
import { type BoardClock, type BoardIO, systemClock } from "./io.ts";
import { isInside, norm, safeFileName } from "./text.ts";
import type { Board, Level, Registry, Root, Session, Task } from "./types.ts";

export const LEVEL_NAME = { 1: "master task", 2: "module", 3: "task" } as const;
export const levelOf = (t: Pick<Task, "level">): Level =>
  t.level === 2 || t.level === 3 ? t.level : 1;

/** The board whose root contains `cwd`; the deepest root wins. */
export function findBoard(reg: Registry, cwd: string): { board: Board; root: Root } | null {
  let best: { board: Board; root: Root } | null = null;
  for (const b of reg.boards)
    for (const r of b.roots)
      if (isInside(cwd, r.path) && (!best || norm(r.path).length > norm(best.root.path).length))
        best = { board: b, root: r };
  return best;
}

export class BoardStore {
  readonly home: string;
  readonly io: BoardIO;
  readonly clock: BoardClock;

  constructor(home: string, io: BoardIO, clock: BoardClock = systemClock) {
    this.home = norm(home);
    this.io = io;
    this.clock = clock;
  }
  async readJson<V>(path: string, fallback: V): Promise<V> {
    try {
      return JSON.parse(await this.io.read(path)) as V;
    } catch {
      return fallback;
    }
  }
  writeJson(path: string, v: unknown): Promise<void> {
    return this.io.write(path, JSON.stringify(v, null, 2));
  }
  async readText(path: string): Promise<string> {
    try {
      return await this.io.read(path);
    } catch {
      return "";
    }
  }
  get registryPath(): string {
    return `${this.home}/boards.json`;
  }
  async loadRegistry(): Promise<Registry> {
    const r = await this.readJson<Registry | null>(this.registryPath, null);
    return r && Array.isArray(r.boards) ? r : { version: 1, boards: [] };
  }
  saveRegistry(reg: Registry): Promise<void> {
    return this.writeJson(this.registryPath, reg);
  }
  projectDir(boardId: string): string {
    return `${this.home}/projects/${boardId}`;
  }
  taskDir(boardId: string, id: string): string {
    return `${this.projectDir(boardId)}/tasks/${id}`;
  }
  planPath(boardId: string, id: string): string {
    return `${this.taskDir(boardId, id)}/plan.md`;
  }
  livingPath(boardId: string, id: string): string {
    return `${this.taskDir(boardId, id)}/handoff.md`;
  }
  masterPath(boardId: string, id: string): string {
    return `${this.taskDir(boardId, id)}/masterplan.md`;
  }
  stepHandoffPath(boardId: string, id: string, step: string): string {
    return `${this.taskDir(boardId, id)}/handoffs/${step}.md`;
  }
  /** A chat's record: in its board, or under `unassigned/` while no board covers its folder. */
  sessionPath(boardId: string | null, sessionId: string): string {
    return boardId
      ? `${this.projectDir(boardId)}/sessions/${safeFileName(sessionId)}.json`
      : `${this.home}/unassigned/${safeFileName(sessionId)}.json`;
  }
  loadTask(boardId: string, id: string): Promise<Task | null> {
    return this.readJson<Task | null>(`${this.taskDir(boardId, id)}/task.json`, null);
  }
  async saveTask(boardId: string, t: Task): Promise<void> {
    t.updatedAt = this.clock.now();
    await this.writeJson(`${this.taskDir(boardId, t.id)}/task.json`, t);
  }
  async listTasks(boardId: string): Promise<Task[]> {
    try {
      const out: Task[] = [];
      for (const d of await this.io.list(`${this.projectDir(boardId)}/tasks`))
        if (d.kind === "dir") {
          const t = await this.loadTask(boardId, d.name);
          if (t) out.push(t);
        }
      return out;
    } catch {
      return [];
    }
  }
  /** Nearest first, at most three levels up. */
  async ancestorsOf(boardId: string, t: Task): Promise<Task[]> {
    const out: Task[] = [];
    let cur: Task | null = t;
    for (let i = 0; i < 3 && cur?.parentId; i++) {
      cur = await this.loadTask(boardId, cur.parentId);
      if (cur) out.push(cur);
    }
    return out;
  }
  async childrenOf(boardId: string, id: string): Promise<Task[]> {
    return (await this.listTasks(boardId))
      .filter((t) => t.parentId === id)
      .sort((a, b) => a.createdAt - b.createdAt);
  }
  /** A new id from `title` that no task on the board uses yet. */
  async freeTaskId(boardId: string, base: string): Promise<string> {
    let id = base;
    for (let n = 2; await this.loadTask(boardId, id); n++) id = `${base}-${n}`;
    return id;
  }
  async latestHandoff(boardId: string, id: string): Promise<{ step: string; text: string } | null> {
    try {
      const files = (await this.io.list(`${this.taskDir(boardId, id)}/handoffs`))
        .filter((f) => f.name.endsWith(".md"))
        .toSorted((a, b) => b.mtimeMs - a.mtimeMs);
      const top = files[0];
      if (!top) return null;
      return {
        step: top.name.replace(/\.md$/, ""),
        text: await this.readText(`${this.taskDir(boardId, id)}/handoffs/${top.name}`),
      };
    } catch {
      return null;
    }
  }
  readSession(boardId: string | null, sessionId: string): Promise<Session | null> {
    return this.readJson<Session | null>(this.sessionPath(boardId, sessionId), null);
  }
  writeSession(boardId: string | null, s: Session): Promise<void> {
    return this.writeJson(this.sessionPath(boardId, s.sessionId), s);
  }
  async listSessions(boardId: string): Promise<Session[]> {
    try {
      const out: Session[] = [];
      for (const f of await this.io.list(`${this.projectDir(boardId)}/sessions`)) {
        if (f.kind !== "file" || !f.name.endsWith(".json")) continue;
        const s = await this.readJson<Session | null>(
          `${this.projectDir(boardId)}/sessions/${f.name}`,
          null,
        );
        if (s) out.push(s);
      }
      return out;
    } catch {
      return [];
    }
  }
}

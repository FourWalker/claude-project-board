// @effect-diagnostics globalDate:off globalRandom:off
/* oxlint-disable t3code/no-em-dash-copy -- Board protocol and tool text shared verbatim with the Claude Code mod; "## Phase A — name" is the plan.md format. */
/**
 * One chat on the board (a Claude Code session or a T3 thread): its record, its context, its tools.
 * Rules and texts must match the Claude Code mod's `hooks/register.ts`, which shares the files.
 *
 * @module board-core/chat
 */
import type { BoardGit } from "./io.ts";
import { markStepDelegated, nextStep, objectiveLine, tickStep } from "./plan.ts";
import { type BoardHost, boardModeProtocol, resumeHint, toolRules } from "./protocol.ts";
import { BoardStore, LEVEL_NAME, findBoard, levelOf } from "./store.ts";
import {
  base,
  clip,
  firstPara,
  isInside,
  norm,
  parent,
  safeFileName,
  sameRoot,
  slug,
  stamp,
} from "./text.ts";
import type {
  Board,
  Decision,
  ItemKind,
  Level,
  LinkType,
  RepoState,
  Service,
  Session,
  SessionSource,
  Task,
} from "./types.ts";

/** What a board tool or command returns: text for the agent, plus an optional toast for the UI. */
export interface BoardReply {
  readonly text: string;
  readonly toast?: string | undefined;
  /** Extra context for the agent alongside the reply (commands only). */
  readonly context?: ReadonlyArray<string> | undefined;
}

export interface OpenChatInput {
  readonly sessionId: string;
  readonly cwd: string;
  /** The host app's own id for the chat, when it can give the same chat a new engine id. */
  readonly hostSessionId?: string | undefined;
  readonly surface?: string | undefined;
  readonly source?: SessionSource | undefined;
}

// VS Code's placeholder folder for untrusted workspaces, and similar: never reported.
const IGNORED = /\/globalStorage\/|\/untrusted-start(\/|$)/i;

const reply = (text: string, toast?: string): BoardReply => (toast ? { text, toast } : { text });
const str = (v: unknown, fallback = ""): string =>
  v === undefined || v === null ? fallback : String(v);

export const repoLine = (r: RepoState): string =>
  `${r.name} · ${r.branch} @ ${r.head} · ${!r.upstream ? "not pushed (no upstream)" : r.ahead ? `${r.ahead} commit(s) not pushed` : "pushed"}${r.behind ? `, ${r.behind} behind` : ""} · ${r.dirty ? `${r.dirty} uncommitted` : "clean"}`;

const LINK_FLIP: Record<string, readonly [LinkType, boolean]> = {
  blocks: ["blocked_by", true],
  led_to: ["found_during", true],
};

export class BoardChat {
  readonly store: BoardStore;
  readonly git: BoardGit;
  readonly host: BoardHost;

  board: Board | null = null;
  sess: Session | null = null;
  ignored = false;
  /** The context section the agent gets; "" when there is nothing to say. */
  context = "";
  /** A chat is written only once the person has spoken in it (or it was linked or set up). */
  reported = false;
  lastActionSetThisTurn = false;
  /** Shown to a chat that just took over a soft-released module, until it checkpoints. */
  pickupNote = "";
  private readonly warnedServices = new Set<string>();

  constructor(store: BoardStore, git: BoardGit, host: BoardHost) {
    this.store = store;
    this.git = git;
    this.host = host;
  }

  private now(): number {
    return this.store.clock.now();
  }
  private get boardId(): string {
    return this.board?.id ?? "";
  }
  private loadTask(id: string) {
    return this.board ? this.store.loadTask(this.board.id, id) : Promise.resolve(null);
  }
  private saveTask(t: Task) {
    return this.store.saveTask(this.boardId, t);
  }
  private listTasks() {
    return this.board ? this.store.listTasks(this.board.id) : Promise.resolve([] as Task[]);
  }
  private readPlan(id: string) {
    return this.store.readText(this.store.planPath(this.boardId, id));
  }
  private livingPath(id: string) {
    return this.store.livingPath(this.boardId, id);
  }
  private masterPath(id: string) {
    return this.store.masterPath(this.boardId, id);
  }
  private svcName(id: string): string {
    return this.board?.services?.find((x) => x.id === id)?.name ?? id;
  }
  private currentBoard(): Board | null {
    return this.board;
  }
  get boardModeOn(): boolean {
    return !!this.board?.boardMode && !this.sess?.boardModeOff;
  }
  async save(patch: Partial<Session>): Promise<void> {
    if (!this.sess || this.ignored) return;
    this.sess = { ...this.sess, ...patch, updatedAt: this.now(), heartbeatAt: this.now() };
    if (this.reported) await this.store.writeSession(this.board?.id ?? null, this.sess);
  }

  /** Places the chat on its board (or leaves it unassigned). */
  async resolve(): Promise<void> {
    if (!this.sess) return;
    const reg = await this.store.loadRegistry();
    const hit = findBoard(reg, this.sess.cwd);
    const wasUnassigned = !this.board;
    const oldPath = this.store.sessionPath(this.board?.id ?? null, this.sess.sessionId);
    this.board = hit?.board ?? null;
    if (hit) {
      const rp = norm(hit.root.path);
      const sub = norm(this.sess.cwd).slice(rp.length).replace(/^\//, "");
      this.sess = {
        ...this.sess,
        projectId: hit.board.id,
        workspace: rp,
        workspaceLabel: hit.root.label,
        subfolder: sub,
      };
      // Coming from unassigned: mark that record moved and carry its fields into the board.
      if (wasUnassigned) {
        const un = await this.store.readJson<Session | null>(oldPath, null);
        if (un && !un.movedTo) {
          await this.store.writeJson(oldPath, { ...un, movedTo: hit.board.id });
          this.sess = {
            ...this.sess,
            title: this.sess.title || un.title,
            lastPrompt: this.sess.lastPrompt || un.lastPrompt,
            lastAnswer: this.sess.lastAnswer || un.lastAnswer,
          };
          this.reported = true;
        }
      }
    } else {
      const sug = await this.suggestRoot(this.sess.cwd);
      this.sess = {
        ...this.sess,
        projectId: null,
        workspace: this.sess.cwd,
        workspaceLabel: base(this.sess.cwd),
        subfolder: "",
        suggestedRoot: sug.root,
        suggestedName: sug.name,
      };
    }
  }

  /** Nearest folder at or above the chat's folder holding a *.code-workspace file, else its repo. */
  private async suggestRoot(cwd: string): Promise<{ root: string; name: string }> {
    for (let d = cwd; d; d = parent(d)) {
      try {
        const ws = (await this.store.io.list(d)).find(
          (f) => f.kind === "file" && /\.code-workspace$/i.test(f.name),
        );
        if (ws) {
          const n = ws.name
            .replace(/\.code-workspace$/i, "")
            .replace(/[-_ .]*(copy|\d+)$/i, "")
            .trim();
          return { root: d, name: n.length <= 5 ? n.toUpperCase() : n };
        }
      } catch {}
    }
    const top = await this.git.root(cwd).catch(() => null);
    const r = top ? norm(top) : cwd;
    return { root: r, name: base(r).replace(/[-_ .]*(copy|\d+)$/i, "") || base(r) };
  }

  /** Session start: load or create the chat's record and build its context. */
  async open(input: OpenChatInput): Promise<void> {
    const where = norm(input.cwd);
    this.ignored = IGNORED.test(where + "/");
    if (this.ignored) return;
    const { sessionId, hostSessionId } = input;
    this.board = null;
    this.sess = {
      sessionId,
      projectId: null,
      taskId: null,
      linkDeclined: false,
      cwd: where,
      workspace: where,
      workspaceLabel: base(where),
      subfolder: "",
      branch: await this.git.branch(where).catch(() => ""),
      status: "idle",
      title: "",
      lastPrompt: "",
      lastAnswer: "",
      turnStartedAt: 0,
      updatedAt: this.now(),
      heartbeatAt: this.now(),
      hostSessionId,
      surface: input.surface,
      source: input.source,
    };
    await this.resolve();
    // resolve() sets the board; read it fresh, not through the `null` assigned above.
    const board = this.currentBoard();
    let prev = await this.store.readSession(board?.id ?? null, sessionId);
    this.reported = prev !== null && !prev.movedTo;
    // The host can give the same chat a new engine id (after /clear, a restart): carry the
    // earlier record's task link over and mark that record as replaced by this one.
    if (board && hostSessionId) {
      const boardId = board.id;
      const older = (await this.store.listSessions(boardId))
        .filter(
          (o) => o.sessionId !== sessionId && o.hostSessionId === hostSessionId && !o.supersededBy,
        )
        .toSorted((a, b) => b.updatedAt - a.updatedAt);
      for (const o of older) {
        prev = prev ?? o;
        await this.store.writeSession(boardId, { ...o, status: "ended", supersededBy: sessionId });
        if (!o.taskId) continue;
        const t = await this.store.loadTask(boardId, o.taskId);
        if (!t) continue;
        t.sessions = t.sessions.filter(
          (x) => x.sessionId !== o.sessionId && x.sessionId !== sessionId,
        );
        t.sessions.push({
          sessionId,
          linkedAt: this.now(),
          workspaceLabel: this.sess.workspaceLabel,
        });
        if (t.lastAction?.sessionId === o.sessionId) t.lastAction.sessionId = sessionId;
        await this.store.saveTask(boardId, t);
      }
      if (older.length) this.reported = true;
    }
    if (prev)
      this.sess = {
        ...this.sess,
        taskId: prev.taskId ?? null,
        linkDeclined: prev.linkDeclined ?? false,
        title: prev.title ?? "",
        lastPrompt: prev.lastPrompt ?? "",
        lastAnswer: prev.lastAnswer ?? "",
        boardModeOff: prev.boardModeOff,
      };
    await this.save({});
    await this.rebuildContext();
  }

  /** A turn the person started. Host notices (`<task-notification>` …) aren't the person's words. */
  async turnStart(text: string): Promise<void> {
    if (!this.sess || this.ignored) return;
    this.lastActionSetThisTurn = false;
    const t = text.trim();
    this.sess.branch = await this.git.branch(this.sess.cwd).catch(() => this.sess?.branch ?? "");
    if (!this.board) await this.resolve().catch(() => {}); // a board may have been created meanwhile
    const isNotice = /^<[a-z][\w-]*[\s>]/i.test(t);
    if (!isNotice && t) this.reported = true;
    const title = this.sess.title;
    await this.save(
      isNotice
        ? { status: "working", turnStartedAt: this.now(), title: /^</.test(title) ? "" : title }
        : {
            status: "working",
            turnStartedAt: this.now(),
            lastPrompt: clip(t, 500),
            title: (!/^</.test(title) && title) || clip(t.split("\n")[0] ?? "", 90),
          },
    ).catch(() => {});
    await this.rebuildContext().catch(() => {});
  }

  /** A turn finished: the answer's first paragraph is the last action unless a tool set one. */
  async turnComplete(answer: string): Promise<void> {
    if (!this.sess || this.ignored) return;
    const summary = clip(firstPara(answer), 300);
    await this.save({ status: "idle", lastAnswer: clip(answer, 800) }).catch(() => {});
    if (this.board && this.sess.taskId && !this.lastActionSetThisTurn && summary) {
      const t = await this.loadTask(this.sess.taskId);
      if (t) {
        t.lastAction = {
          text: summary,
          sessionId: this.sess.sessionId,
          workspaceLabel: this.sess.workspaceLabel,
          at: this.now(),
        };
        await this.saveTask(t).catch(() => {});
      }
    }
  }

  async end(resumeId?: string): Promise<void> {
    await this.save({ status: "ended", resumeId }).catch(() => {});
  }

  /** Heartbeat: hosts that can't see a chat's liveness call this every ~30 seconds. */
  async heartbeat(): Promise<void> {
    if (this.sess && this.sess.status !== "ended") await this.save({});
  }
  /** The service whose folder pattern the path contains (the longest pattern wins). */
  serviceOfPath(file: string): Service | null {
    const f = "/" + norm(file).toLowerCase() + "/";
    let best: Service | null = null;
    let bestLen = 0;
    for (const svc of this.board?.services ?? [])
      for (const m of svc.match) {
        const pat = "/" + m.toLowerCase().replace(/^\/+|\/+$/g, "") + "/";
        if (f.includes(pat) && pat.length > bestLen) {
          best = svc;
          bestLen = pat.length;
        }
      }
    return best;
  }

  /**
   * A file the agent changed: tag the linked task with its service. Returns a note for the agent
   * the first time the work reaches a service outside the task's services so far.
   */
  async fileChanged(file: string): Promise<string | null> {
    if (!this.board || !this.sess?.taskId || this.ignored) return null;
    const svc = this.serviceOfPath(file);
    if (!svc) return null;
    const t = await this.loadTask(this.sess.taskId);
    if (!t) return null;
    const had = t.services ?? [];
    if (had.includes(svc.id)) return null;
    t.services = [...had, svc.id];
    await this.saveTask(t);
    await this.rebuildContext();
    if (!had.length || this.warnedServices.has(svc.id)) return null;
    this.warnedServices.add(svc.id);
    const thread = this.host === "t3" ? "thread" : "chat";
    return `Board: this edit is in ${svc.name}, outside this task's services so far (${had.map((x) => this.svcName(x)).join(", ")}). If it is a bug or extra work beyond this task's scope, stop and follow the out-of-scope protocol (ask: new task in another ${thread} / fix here with recorded scope / task for later). If it is genuinely part of this task, carry on; the task is now tagged ${svc.name}.`;
  }
  /** Ownership lives on modules and master tasks; a task belongs to its module's owner. */
  private async ownerNodeOf(t: Task): Promise<Task> {
    if (levelOf(t) === 3 && t.parentId) return (await this.loadTask(t.parentId)) ?? t;
    return t;
  }
  async ownerHolder(t: Task): Promise<Task | null> {
    let cur: Task | null = await this.ownerNodeOf(t);
    for (let i = 0; i < 3 && cur; i++) {
      if (cur.owner) return cur;
      cur = cur.parentId ? await this.loadTask(cur.parentId) : null;
    }
    return null;
  }
  private ownerHistory(
    t: Task,
    type: string,
    extra: { from?: string | undefined; to?: string | undefined },
  ) {
    t.ownerHistory = [
      ...(t.ownerHistory ?? []),
      { type, at: this.now(), by: this.sess?.sessionId, ...extra },
    ].slice(-30);
  }
  /** A one-time override counts for the chat that received it (and the task it was given on). */
  private hasOverride(t: Task): boolean {
    return (t.overrides ?? []).some((o) => o.session === this.sess?.sessionId);
  }

  /** The repos a task's module works in: its tree's service folders, else the chat's own repo. */
  async reposFor(t: Task): Promise<RepoState[]> {
    const node = await this.ownerNodeOf(t);
    const all = await this.listTasks();
    const desc = (id: string): Task[] =>
      all.filter((x) => x.parentId === id).flatMap((k) => [k, ...desc(k.id)]);
    const tree = [node, ...desc(node.id)];
    const ids = new Set(
      tree.flatMap((x) => [...(x.services ?? []), ...(x.mainService ? [x.mainService] : [])]),
    );
    const seen = new Map<string, RepoState>();
    for (const svc of this.board?.services ?? [])
      if (ids.has(svc.id))
        for (const m of svc.match) {
          const dir = `${this.sess?.workspace}/${m}`;
          if (!(await this.store.io.exists(dir).catch(() => false))) continue;
          const st = await this.git.state(dir);
          if (st && !seen.has(st.repo)) seen.set(st.repo, { ...st, service: svc.id });
        }
    if (!seen.size && this.sess) {
      const st = await this.git.state(this.sess.cwd);
      if (st) seen.set(st.repo, st);
    }
    return [...seen.values()];
  }
  async describeTask(t: Task, full: boolean): Promise<string> {
    const plan = await this.readPlan(t.id);
    const next = nextStep(plan);
    const living = await this.store.readText(this.livingPath(t.id));
    const ho = living ? null : await this.store.latestHandoff(this.boardId, t.id);
    const open = t.items.filter((i) => !i.done);
    const anc = await this.store.ancestorsOf(this.boardId, t);
    const kids = await this.store.childrenOf(this.boardId, t.id);
    const lv = levelOf(t);
    const crumb = [...anc]
      .reverse()
      .map((a) => a.title)
      .concat(t.title)
      .join(" › ");
    const lines = [
      `Task "${t.title}" (Level ${lv} ${LEVEL_NAME[lv]}, id: ${t.id}, status: ${t.status}) on the ${this.board?.name ?? "?"} board.`,
      anc.length ? `Path: ${crumb}` : "",
      t.description
        ? `Purpose: ${t.description}`
        : "Purpose: (not written yet — ask or infer, then save it with board_update.description)",
      next
        ? `Next step: ${next.id} – ${next.text}`
        : plan
          ? "Every plan step is ticked."
          : "No plan saved yet.",
      t.lastAction ? `Last action (${t.lastAction.workspaceLabel}): ${t.lastAction.text}` : "",
      `Living handoff: ${this.livingPath(t.id)}${living ? "" : " (not written yet)"}`,
    ];
    if (open.length)
      lines.push("Open items:", ...open.map((i) => `- [${i.kind}] ${i.text} (id ${i.id})`));
    const decs: string[] = [];
    for (const d of t.decisions ?? [])
      if (d.status === "open")
        decs.push(
          `- ${d.id} [L${d.level}, open] ${d.title}${d.raisedFrom ? ` (raised in ${d.raisedFrom.title})` : ""}`,
        );
    for (const a of anc)
      for (const d of a.decisions ?? []) {
        if (d.status === "open")
          decs.push(
            `- ${d.id} [L${d.level} on "${a.title}", open] ${d.title}${d.raisedFrom?.id === t.id ? " (raised here)" : ""}`,
          );
        else if (d.status === "decided")
          decs.push(
            `- ${d.id} [L${d.level} on "${a.title}", decided] ${d.title} → ${clip(d.verdict, 140)}`,
          );
      }
    for (const d of t.decisions ?? [])
      if (d.status === "decided")
        decs.push(`- ${d.id} [L${d.level}, decided] ${d.title} → ${clip(d.verdict, 140)}`);
    if (decs.length)
      lines.push(
        "Decisions bearing on this task (decided ones are binding; open ones are not settled):",
        ...decs.slice(0, 20),
      );
    if (lv === 1)
      lines.push(
        `Kind: ${t.kind === "backlog" ? "service backlog (a service's own bugs and gaps)" : "feature"}${t.mainService ? ` · main service: ${this.svcName(t.mainService)}` : ""}`,
      );
    if (t.services?.length)
      lines.push(`Services touched: ${t.services.map((x) => this.svcName(x)).join(", ")}`);
    const holder = await this.ownerHolder(t);
    if (holder?.owner) {
      const o = holder.owner;
      const here = sameRoot(o.root, this.sess?.workspace);
      const who = this.host === "t3" ? "thread" : "chat";
      lines.push(
        `Ownership: "${holder.title}" is ${o.state === "soft" ? "soft-released by" : "owned by"} workspace ${o.label}${here ? " (this one)" : ""}.${!here && o.state === "owned" ? (this.hasOverride(t) ? ` This ${who} works here by a one-time override the person gave — coordinate branches with that copy.` : ` This ${who} must not change it unless the person agrees to an override.`) : ""}${here && o.state === "soft" ? " Reclaim it (board_release reclaim) before continuing here, or let another workspace take over." : ""}`,
      );
    }
    if (t.repoState?.length)
      lines.push(
        "Repo state at the last checkpoint:",
        ...t.repoState.map((r) => `- ${repoLine(r)}`),
      );
    if (t.bug) lines.push("This task fixes a bug found after the original work was done.");
    const linkLines: string[] = [];
    for (const l of t.links ?? []) {
      const o = await this.loadTask(l.to);
      if (!o) {
        linkLines.push(`- ${l.type} ${l.to} (missing/archived)`);
        continue;
      }
      const nx = nextStep(await this.readPlan(o.id));
      if (l.type === "blocked_by")
        linkLines.push(
          o.status === "done"
            ? `- Blocker resolved: "${o.title}" (${o.id}) is done.`
            : `- BLOCKED BY "${o.title}" (${o.id}, ${o.status}${nx ? `, next: ${nx.id} – ${nx.text}` : ""}). Don't start work that depends on it.`,
        );
      else if (l.type === "fixes")
        linkLines.push(
          `- Fixes "${o.title}" (${o.id}, ${o.status}) — its living handoff: ${this.livingPath(o.id)}`,
        );
      else
        linkLines.push(
          `- ${l.type === "found_during" ? "Found during" : "Related to"} "${o.title}" (${o.id}, ${o.status})${l.note ? ` — ${clip(l.note, 80)}` : ""}`,
        );
    }
    for (const o of await this.listTasks())
      for (const l of o.links ?? [])
        if (l.to === t.id) {
          if (l.type === "fixes") {
            if (o.status !== "done")
              linkLines.push(`- Open fix: "${o.title}" (${o.id}) fixes a bug in this work.`);
            continue;
          }
          linkLines.push(
            l.type === "blocked_by"
              ? `- Blocks "${o.title}" (${o.id}, ${o.status}) — finishing this unblocks it.`
              : l.type === "found_during"
                ? `- Led to "${o.title}" (${o.id}, ${o.status}), found during this work.`
                : `- Related to "${o.title}" (${o.id}, ${o.status})`,
          );
        }
    if (linkLines.length) lines.push("Linked tasks:", ...linkLines.slice(0, 15));
    if (kids.length) {
      lines.push(`Subtasks (Level ${lv + 1}):`);
      for (const k of kids) {
        const nx = nextStep(await this.readPlan(k.id));
        lines.push(
          `- ${k.id}: ${k.title} [${k.status}]${nx ? ` next: ${nx.id} – ${nx.text}` : ""}`,
        );
      }
    }
    const master = lv === 1 ? t : anc[anc.length - 1];
    if (master) {
      const mp = await this.store.readText(this.masterPath(master.id));
      if (mp && master.id !== t.id)
        lines.push(
          `Master plan of "${master.title}": ${this.masterPath(master.id)} — ${clip(objectiveLine(mp), 160)} (read it when this task's scope is unclear)`,
        );
      else if (!mp && master.id === t.id)
        lines.push(
          `Master plan: not written yet (${this.masterPath(t.id)}). Planning ${this.host === "t3" ? "threads" : "chats"} write it first with board_master_plan, unless the person brings their own.`,
        );
    }
    const docLines: string[] = [];
    for (const d of t.docs ?? [])
      docLines.push(`- [${d.kind}] ${d.title}: ${d.ref}${d.note ? ` — ${clip(d.note, 100)}` : ""}`);
    for (const a of anc)
      for (const d of a.docs ?? [])
        docLines.push(
          `- [${d.kind}, from ${LEVEL_NAME[levelOf(a)]} "${a.title}"] ${d.title}: ${d.ref}`,
        );
    if (docLines.length)
      lines.push(
        "Docs and references (read one only when the current step needs it):",
        ...docLines.slice(0, 25),
      );
    if (anc.length || t.origin?.length) {
      lines.push("Parent context (read a parent's handoff file only when the next step needs it):");
      for (const a of anc) {
        const aplan = nextStep(await this.readPlan(a.id));
        const ah = await this.store.readText(this.livingPath(a.id));
        lines.push(
          `- Level ${levelOf(a)} "${a.title}" (id ${a.id}): ${a.description || "no purpose written"}${aplan ? ` · next: ${aplan.id} – ${aplan.text}` : ""}${ah ? ` · handoff ${this.livingPath(a.id)} — ${clip(objectiveLine(ah), 160)}` : ""}`,
        );
      }
      for (const o of t.origin ?? [])
        lines.push(`- Former parent "${o.title}" (id ${o.id}) · handoff ${this.livingPath(o.id)}`);
    }
    if (full) {
      if (lv === 1) {
        const mp = await this.store.readText(this.masterPath(t.id));
        if (mp) lines.push("", "### Master plan (masterplan.md)", clip(mp, 6000));
      }
      if (plan) lines.push("", "### Plan (plan.md)", clip(plan, 7000));
      if (living) lines.push("", "### Living handoff (handoff.md)", clip(living, 4000));
      else if (ho) lines.push("", `### Latest step note (${ho.step})`, clip(ho.text, 3500));
    }
    return lines.filter(Boolean).join("\n");
  }

  async unassignedHelp(): Promise<string> {
    const reg = await this.store.loadRegistry();
    const s = this.sess;
    const list = reg.boards.map(
      (b) =>
        `- ${b.name} (id ${b.id}; workspaces: ${b.roots.map((r) => `${r.label} = ${r.path}`).join(", ")})`,
    );
    const where = this.host === "t3" ? "thread's" : "chat's";
    return `This ${where} folder (${s?.cwd}) is not on any board yet.
Suggested root for it: ${s?.suggestedRoot} — suggested board name: ${s?.suggestedName}.
${list.length ? `Existing boards:\n${list.join("\n")}` : "There are no boards yet."}
Before creating any task, ask the person ONE question: create a new board (ask for its name, offering "${s?.suggestedName}" and root ${s?.suggestedRoot}), or add this workspace to one of the existing boards (if one looks like the same project, say so). Then call board_setup with their answer. Never create a board without asking.`;
  }

  private async buildContext(): Promise<void> {
    const s = this.sess;
    const b = this.board;
    if (!s || this.ignored) {
      this.context = "";
      return;
    }
    const chat = this.host === "t3" ? "thread" : "chat";
    const chats = this.host === "t3" ? "threads" : "chats";
    if (!b) {
      this.context = `## Claude Project Board\n${await this.unassignedHelp()}\nOnly raise this when the person wants a task tracked (or runs /task); don't interrupt one-off questions.`;
      return;
    }
    const where = `workspace "${s.workspaceLabel}" (${s.workspace})${s.subfolder ? `, folder ${s.subfolder}` : ""}${s.branch ? `, branch ${s.branch}` : ""}`;
    const head = `## Claude Project Board\nThis ${chat} runs in ${where} of the ${b.name} board. Other ${chats} may work on the same board in its other workspace copies: ${b.roots.map((r) => r.label).join(", ")}.`;
    if (s.taskId) {
      const t = await this.loadTask(s.taskId);
      if (t) {
        this.context = `${head}\nThis ${chat} is linked to a task. Continue from the plan and the latest handoff below without asking the person to re-explain them.\n\n${await this.describeTask(t, true)}\n\n${toolRules(this.host)}`;
        return;
      }
    }
    if (s.linkDeclined) {
      this.context = `${head}\nThis ${chat} is not linked to a board task (the person chose not to). Don't ask about linking again; board_link is there if they ask.`;
      return;
    }
    const tasks = (await this.listTasks()).filter((t) => t.status !== "done");
    const list = await Promise.all(
      tasks.map(async (t) => {
        const nx = nextStep(await this.readPlan(t.id));
        return `- ${t.id}: ${t.title}${nx ? ` (next: ${nx.id} – ${nx.text})` : ""}`;
      }),
    );
    this.context = `${head}
This ${chat} is not linked to a board task yet.${list.length ? `\nActive tasks on the board:\n${list.join("\n")}` : " The board has no active tasks."}
Once you understand what the person is working on: if it clearly matches an active task, ask once "Link this ${chat} to <task>?"; if it is new multi-step work, offer once to create a task for it. On yes call board_link; on no call board_link with decline: true. Don't ask for one-off questions.
When linked, the tool returns the task's plan and handoff: continue from them.`;
  }

  async rebuildContext(): Promise<void> {
    await this.buildContext();
    const b = this.board;
    if (this.context && this.pickupNote) this.context += `\n\n### Pickup point\n${this.pickupNote}`;
    if (this.context && b && this.boardModeOn) {
      const services = b.services?.length
        ? `\nServices on this board (folder patterns): ${b.services.map((x) => `${x.id}=${x.match.join("|")}`).join(", ")}`
        : "";
      const rules = b.rules?.trim()
        ? `\n\n## Project rules for the ${b.name} board\n${b.rules.trim()}`
        : "";
      const registers = b.registers?.length
        ? `\nExisting registers: ${b.registers.map((r) => `${r.topic} → ${r.url}`).join("; ")}`
        : "";
      this.context += `\n\n${boardModeProtocol(this.host)}${services}${rules}${registers}`;
    }
  }
  async setupBoard(a: Record<string, unknown>): Promise<BoardReply> {
    const s = this.sess;
    if (!s || this.ignored) return reply("The board is not available in this folder.");
    const reg = await this.store.loadRegistry();
    const rootPath = norm(str(a.root || s.suggestedRoot || s.cwd));
    const label = str(a.label || base(rootPath));
    if (!isInside(s.cwd, rootPath))
      return reply(`The root ${rootPath} must contain this chat's folder (${s.cwd}).`);
    let b: Board | undefined;
    if (a.action === "attach") {
      const key = str(a.boardId || a.name).toLowerCase();
      b = reg.boards.find((x) => x.id === key || x.name.toLowerCase() === key);
      if (!b)
        return reply(
          `No board "${str(a.boardId || a.name)}". Boards: ${reg.boards.map((x) => x.name).join(", ") || "none"}.`,
        );
      if (!b.roots.some((r) => sameRoot(r.path, rootPath))) b.roots.push({ path: rootPath, label });
    } else {
      const name = str(a.name).trim();
      if (!name)
        return reply(
          "Ask the person for the board name first, then call board_setup again with name.",
        );
      const dup = reg.boards.find((x) => x.name.toLowerCase() === name.toLowerCase());
      if (dup)
        return reply(
          `A board named "${dup.name}" already exists. To add this workspace to it, call board_setup with action "attach".`,
        );
      let id = slug(name);
      for (let n = 2; reg.boards.some((x) => x.id === id); n++) id = `${slug(name)}-${n}`;
      b = { id, name, roots: [{ path: rootPath, label }], createdAt: this.now() };
      reg.boards.push(b);
    }
    await this.store.saveRegistry(reg);
    this.reported = true;
    await this.resolve();
    await this.save({});
    await this.rebuildContext();
    const attach = a.action === "attach";
    return reply(
      `${attach ? `Added workspace "${label}" (${rootPath}) to` : "Created"} the ${b.name} board. Workspaces: ${b.roots.map((r) => `${r.label} = ${r.path}`).join(", ")}. You can now create or link tasks with board_link.`,
      `Board: ${attach ? "added this workspace to" : "created"} ${b.name}`,
    );
  }

  async linkTask(a: Record<string, unknown>): Promise<BoardReply> {
    const s = this.sess;
    if (!s || this.ignored) return reply("The board is not available in this folder.");
    if (!this.board) return reply(await this.unassignedHelp());
    const chat = this.host === "t3" ? "thread" : "chat";
    if (a.decline) {
      await this.save({ linkDeclined: true, taskId: null });
      await this.rebuildContext();
      return reply(`Noted: this ${chat} stays unlinked.`);
    }
    let t: Task | null = null;
    if (a.taskId) t = await this.loadTask(slug(str(a.taskId)));
    if (!t && a.taskId && !a.newTaskTitle) {
      const all = await this.listTasks();
      t = all.find((x) => x.title.toLowerCase() === str(a.taskId).toLowerCase()) ?? null;
      if (!t)
        return reply(
          `No task "${str(a.taskId)}". Active tasks: ${all.map((x) => `${x.id} (${x.title})`).join(", ") || "none"}. Pass newTaskTitle to create one.`,
        );
    }
    if (!t) {
      const title = str(a.newTaskTitle ?? a.taskId, "Untitled task");
      const id = await this.store.freeTaskId(this.boardId, slug(title));
      t = {
        id,
        title,
        description: str(a.description),
        status: "active",
        createdAt: this.now(),
        updatedAt: this.now(),
        lastAction: null,
        items: [],
        sessions: [],
        level: 1,
        parentId: null,
      };
    }
    // Ownership: a module/feature worked on by another workspace copy is blocked unless the
    // person overrides once or takes over; a soft-released one is taken over freely.
    let ownerNote = "";
    const holder = await this.ownerHolder(t);
    if (holder?.owner && !sameRoot(holder.owner.root, s.workspace)) {
      const o = holder.owner;
      const said = str(a.personSaid).trim();
      if (a.override && o.state !== "soft" && said.length < 2)
        return reply(
          `BLOCKED: overriding "${holder.title}" (owned by workspace ${o.label}) needs the person's approval. Ask them, then call board_link again with override and personSaid set to their words.`,
        );
      if (o.state === "soft" || a.override === "takeover") {
        const from = o.label;
        if (o.state === "soft" && o.pickup?.length)
          this.pickupNote = `Picked up "${holder.title}" from workspace ${from}, soft-released at:\n${o.pickup.map((r) => `- ${repoLine(r)}`).join("\n")}\nBefore continuing: in this workspace, for each repo fetch and check out that branch, confirm HEAD matches (or is a fast-forward of) that commit, and stop if there are uncommitted changes or the branch has diverged. Then continue with the next step.`;
        this.ownerHistory(holder, o.state === "soft" ? "takeover-after-soft-release" : "takeover", {
          from,
          to: s.workspaceLabel,
        });
        holder.owner = {
          root: s.workspace,
          label: s.workspaceLabel,
          state: "owned",
          since: this.now(),
        };
        if (holder !== t) await this.saveTask(holder);
        ownerNote = `Ownership of "${holder.title}" moved from ${from} to ${s.workspaceLabel}.`;
      } else if (a.override === "once") {
        t.overrides = [
          ...(t.overrides ?? []),
          {
            workspace: s.workspaceLabel,
            at: this.now(),
            session: s.sessionId,
            said: said || "via /task --override",
          },
        ];
        ownerNote = `Working here by a one-time override: "${holder.title}" stays owned by workspace ${o.label}. Coordinate branches with that copy.`;
      } else {
        return reply(
          `BLOCKED: "${holder.title}" is owned by workspace ${o.label} (since ${new Date(o.since).toISOString().slice(0, 10)}). ${chat === "thread" ? "Threads" : "Chats"} in ${s.workspaceLabel} can't pick it up without the person's say-so. Ask them: (1) override once — call board_link again with override "once"; (2) take over — override "takeover" (ownership moves here); (3) leave it.`,
        );
      }
    } else if (!holder) {
      const node = await this.ownerNodeOf(t);
      // Only modules are claimed automatically; a master task is owned only when set on purpose.
      if (levelOf(node) === 2) {
        const target = node.id === t.id ? t : node;
        target.owner = {
          root: s.workspace,
          label: s.workspaceLabel,
          state: "owned",
          since: this.now(),
        };
        this.ownerHistory(target, "claimed", { to: s.workspaceLabel });
        if (target !== t) await this.saveTask(target);
      }
    }
    this.reported = true;
    if (!t.sessions.some((x) => x.sessionId === s.sessionId))
      t.sessions.push({
        sessionId: s.sessionId,
        linkedAt: this.now(),
        workspaceLabel: s.workspaceLabel,
      });
    if (a.description && !t.description) t.description = str(a.description);
    await this.saveTask(t);
    await this.save({ taskId: t.id, linkDeclined: false });
    await this.rebuildContext();
    return reply(
      `Linked this ${chat} to the task.${ownerNote ? ` ${ownerNote}` : ""}\n\n${await this.describeTask(t, true)}\n\n${toolRules(this.host)}`,
      `Board: linked to ${t.title}`,
    );
  }

  /** Unlinks the chat from its task (the person's `/task off`, or the UI's unlink). */
  async unlink(): Promise<BoardReply> {
    await this.save({ taskId: null, linkDeclined: true });
    await this.rebuildContext();
    return reply(`This ${this.host === "t3" ? "thread" : "chat"} is no longer linked to a task.`);
  }

  private async requireTask(a: Record<string, unknown>): Promise<Task | string> {
    if (!this.board)
      return "This chat is not on a board yet: ask the person, then call board_setup.";
    const id = a.taskId ? slug(str(a.taskId)) : this.sess?.taskId;
    if (!id) return "This chat is not linked to a task: call board_link first.";
    const t = await this.loadTask(id);
    if (!t) return `No task "${id}".`;
    // Writes respect ownership too: another workspace's module needs an override for this chat.
    const holder = await this.ownerHolder(t);
    if (
      holder?.owner &&
      holder.owner.state === "owned" &&
      !sameRoot(holder.owner.root, this.sess?.workspace) &&
      !this.hasOverride(t)
    )
      return `BLOCKED: "${holder.title}" is owned by workspace ${holder.owner.label}. This chat (workspace ${this.sess?.workspaceLabel}) may not change it unless the person agrees to an override — ask them, then call board_link with override and personSaid.`;
    return t;
  }

  private lastAction(text: string) {
    return {
      text: clip(text, 300),
      sessionId: this.sess?.sessionId ?? "",
      workspaceLabel: this.sess?.workspaceLabel ?? "",
      at: this.now(),
    };
  }

  private newId(prefix: string, upper = false, suffixMax = 0): string {
    const t = this.now().toString(36);
    return `${prefix}${upper ? t.toUpperCase() : t}${suffixMax ? this.store.clock.random(suffixMax) : ""}`;
  }

  async updateTask(a: Record<string, unknown>): Promise<BoardReply> {
    const t = await this.requireTask(a);
    if (typeof t === "string") return reply(t);
    const by = this.sess?.sessionId;
    if (a.lastAction) {
      t.lastAction = this.lastAction(str(a.lastAction));
      this.lastActionSetThisTurn = true;
    }
    if (a.description) t.description = str(a.description);
    if (a.title) t.title = str(a.title);
    if (a.status === "active" || a.status === "paused" || a.status === "done") t.status = a.status;
    if (Array.isArray(a.services)) t.services = [...new Set(a.services.map(String))];
    if (a.mainService !== undefined) t.mainService = a.mainService ? str(a.mainService) : null;
    if (a.kind === "feature" || a.kind === "backlog") t.kind = a.kind;
    for (const it of (Array.isArray(a.add) ? a.add : []) as Array<{
      kind?: unknown;
      text?: unknown;
    }>) {
      if (it.kind === "decision") {
        t.decisions = [
          ...(t.decisions ?? []),
          {
            id: this.newId("D-", true, 9),
            title: str(it.text),
            description: "",
            level: levelOf(t),
            raisedFrom: null,
            refs: [],
            options: "",
            verdict: "",
            status: "open",
            at: this.now(),
            by,
          },
        ];
        continue;
      }
      const kind: ItemKind = it.kind === "mandatory" ? "mandatory" : "todo";
      t.items.push({
        id: this.newId(kind[0] ?? "t", false, 99),
        kind,
        text: str(it.text),
        done: false,
        at: this.now(),
        by,
      });
    }
    for (const id of (Array.isArray(a.resolve) ? a.resolve : []) as unknown[]) {
      const it = t.items.find((i) => i.id === id);
      if (it) it.done = true;
    }
    await this.saveTask(t);
    await this.rebuildContext();
    return reply(
      `Board updated for "${t.title}". Open items: ${t.items.filter((i) => !i.done).length}.`,
    );
  }

  async savePlan(a: Record<string, unknown>): Promise<BoardReply> {
    const t = await this.requireTask(a);
    if (typeof t === "string") return reply(t);
    const md = str(a.markdown);
    if (!md.trim()) return reply("markdown is empty: nothing saved.");
    await this.store.io.write(this.store.planPath(this.boardId, t.id), md);
    await this.saveTask(t);
    await this.rebuildContext();
    const nx = nextStep(md);
    return reply(`Plan saved for "${t.title}".${nx ? ` Next step: ${nx.id} – ${nx.text}.` : ""}`);
  }

  private byLine(): string {
    const s = this.sess;
    return `${this.host === "t3" ? "thread" : "chat"} ${s?.sessionId ?? "?"} in ${s?.workspaceLabel ?? "?"}${s?.subfolder ? `/${s.subfolder}` : ""}`;
  }

  async writeHandoff(a: Record<string, unknown>): Promise<BoardReply> {
    const t = await this.requireTask(a);
    if (typeof t === "string") return reply(t);
    const step = safeFileName(str(a.step)) || `note-${this.now()}`;
    const s = this.sess;
    const header = `<!-- by ${this.byLine()}${s?.branch ? ` (${s.branch})` : ""}, ${stamp(this.now())} -->\n`;
    await this.store.io.write(
      this.store.stepHandoffPath(this.boardId, t.id, step),
      header + str(a.markdown),
    );
    let plan = await this.readPlan(t.id);
    if (plan && a.markStepDone !== false) {
      plan = tickStep(plan, step);
      await this.store.io.write(this.store.planPath(this.boardId, t.id), plan);
    }
    t.lastAction = this.lastAction(
      str(a.lastAction ?? `Finished ${step}: ${firstPara(str(a.markdown))}`),
    );
    this.lastActionSetThisTurn = true;
    await this.saveTask(t);
    await this.rebuildContext();
    const nx = nextStep(plan);
    return reply(
      `Handoff ${step} saved.${nx ? ` Next step: ${nx.id} – ${nx.text}.` : " No unticked steps left."}`,
    );
  }

  async createTask(a: Record<string, unknown>): Promise<BoardReply> {
    if (!this.board) return reply(await this.unassignedHelp());
    const title = str(a.title).trim();
    if (!title) return reply("title is required.");
    let par: Task | null = null;
    if (a.parentId) {
      par = await this.loadTask(slug(str(a.parentId)));
      if (!par) return reply(`No task "${str(a.parentId)}".`);
      if (levelOf(par) >= 3)
        return reply(
          `"${par.title}" is a Level 3 task and can't have subtasks. Promote it first (board_promote), then create subtasks under it.`,
        );
    }
    const id = await this.store.freeTaskId(this.boardId, slug(title));
    const level = (par ? levelOf(par) + 1 : 1) as Level;
    const t: Task = {
      id,
      title,
      description: str(a.description),
      status: "active",
      createdAt: this.now(),
      updatedAt: this.now(),
      lastAction: null,
      items: [],
      sessions: [],
      level,
      parentId: par?.id ?? null,
    };
    if (level === 1) t.kind = a.kind === "backlog" ? "backlog" : "feature";
    if (Array.isArray(a.services)) t.services = a.services.map(String);
    if (a.mainService) t.mainService = str(a.mainService);
    if (a.bug) t.bug = true;
    if (a.fixes) {
      const orig = await this.loadTask(slug(str(a.fixes)));
      if (orig)
        t.links = [
          {
            to: orig.id,
            type: "fixes",
            note: str(a.description),
            at: this.now(),
            by: this.sess?.sessionId,
          },
        ];
    }
    await this.saveTask(t);
    if (a.plan) await this.store.io.write(this.store.planPath(this.boardId, id), str(a.plan));
    if (par && a.fromStep) {
      const pp = this.store.planPath(this.boardId, par.id);
      const plan = await this.store.readText(pp);
      const marked = markStepDelegated(plan, str(a.fromStep), id);
      if (marked !== plan) await this.store.io.write(pp, marked);
    }
    this.reported = true;
    await this.rebuildContext();
    const pickUp =
      this.host === "t3"
        ? `Start it with Continue in new thread on task ${id}.`
        : `A chat picks it up with /task ${id}.`;
    return reply(
      `Created Level ${level} ${LEVEL_NAME[level]} "${title}" (id ${id})${par ? ` under "${par.title}"` : ""}. ${pickUp}`,
    );
  }

  async promoteTask(a: Record<string, unknown>): Promise<BoardReply> {
    const t = await this.requireTask(a);
    if (typeof t === "string") return reply(t);
    const lv = levelOf(t);
    if (lv === 1) return reply(`"${t.title}" is already a master task.`);
    const par = t.parentId ? await this.loadTask(t.parentId) : null;
    t.origin = [...(t.origin ?? []), ...(par ? [{ id: par.id, title: par.title }] : [])];
    t.parentId = par?.parentId ?? null;
    t.level = (lv - 1) as Level;
    for (const d of t.decisions ?? []) if (d.level === lv) d.level = t.level;
    await this.saveTask(t);
    // Its subtree moves up one level with it.
    for (const k of await this.store.childrenOf(this.boardId, t.id)) {
      k.level = (levelOf(k) - 1 || 1) as Level;
      await this.saveTask(k);
    }
    await this.rebuildContext();
    return reply(
      `Promoted "${t.title}" to Level ${t.level} (${LEVEL_NAME[t.level]})${t.parentId ? ` under ${t.parentId}` : ""}. It keeps its plan, handoffs and chats; ${par ? `"${par.title}" stays reachable as a former parent. ` : ""}You can now create subtasks under it with board_create_task (fromStep turns a plan step into one).`,
    );
  }

  /**
   * Rewrites the living handoff. `t3Checkpoint` is the T3 checkpoint ref of the turn it was
   * written in, when the host has one; it goes in the header so the handoff points at exact code.
   */
  async checkpoint(a: Record<string, unknown>, t3Checkpoint?: string): Promise<BoardReply> {
    const t = await this.requireTask(a);
    if (typeof t === "string") return reply(t);
    const md = str(a.markdown).trim();
    if (!md) return reply("markdown is empty: nothing saved.");
    const header = `<!-- living handoff, rewritten in place · last by ${this.byLine()}, ${stamp(this.now())}${t3Checkpoint ? ` · checkpoint ${t3Checkpoint}` : ""} -->\n`;
    await this.store.io.write(this.livingPath(t.id), header + md + "\n");
    const repos = await this.reposFor(t).catch(() => [] as RepoState[]);
    if (repos.length) t.repoState = repos;
    this.pickupNote = "";
    if (a.lastAction) {
      t.lastAction = this.lastAction(str(a.lastAction));
      this.lastActionSetThisTurn = true;
    }
    await this.saveTask(t);
    await this.rebuildContext();
    return reply(
      `Living handoff saved: ${this.livingPath(t.id)}${repos.length ? `\nRepo state recorded:\n${repos.map((r) => `- ${repoLine(r)}`).join("\n")}` : ""}\n${resumeHint(this.host, t.id)}`,
    );
  }

  async fileDecision(a: Record<string, unknown>): Promise<BoardReply> {
    const cur = await this.requireTask(a);
    if (typeof cur === "string") return reply(cur);
    const anc = await this.store.ancestorsOf(this.boardId, cur);
    const chain = [cur, ...anc];
    if (a.action === "add" || !a.action) {
      const title = str(a.title).trim();
      if (!title) return reply("title is required.");
      const want = Number(a.level ?? levelOf(cur));
      const owner = chain.find((x) => levelOf(x) <= want) ?? chain[chain.length - 1] ?? cur;
      const d: Decision = {
        id: this.newId("D-", true),
        title,
        description: str(a.description),
        level: levelOf(owner),
        raisedFrom: owner.id === cur.id ? null : { id: cur.id, title: cur.title },
        refs: Array.isArray(a.refs) ? a.refs.map(String) : [],
        options: str(a.options),
        verdict: "",
        status: "open",
        at: this.now(),
        by: this.sess?.sessionId,
      };
      if (a.recommendation) {
        const max = Math.max(
          0,
          ...(await this.listTasks()).flatMap((x) =>
            (x.decisions ?? []).map((y) => Number(str(y.rec?.r).replace(/\D/g, "")) || 0),
          ),
        );
        d.rec = {
          r: a.r ? str(a.r) : `R${max + 1}`,
          area: str(a.area),
          lldCheck: str(a.lldCheck),
          register: a.register ? str(a.register) : null,
          implemented: null,
        };
      }
      // `owner` may be `cur` or an ancestor: either way it is the object we save.
      owner.decisions = [...(owner.decisions ?? []), d];
      await this.saveTask(owner);
      await this.rebuildContext();
      if (d.rec)
        return reply(
          `Recommendation ${d.rec.r} (${d.id}) recorded at Level ${d.level} on "${owner.title}"${d.rec.register ? ` — also add it to the ${d.rec.register} register as ${d.rec.r}` : ""}. Name ${d.rec.r} in your reply. It stays open until the person records the team's decision.`,
        );
      return reply(
        `Decision ${d.id} filed at Level ${d.level} on "${owner.title}"${d.raisedFrom ? `, mapped to "${cur.title}" where it was raised` : ""}. It is open until the person records a verdict.`,
      );
    }
    // decide / update / drop: find it on this task, its parents, or (by id) anywhere on the board
    const id = str(a.id);
    const has = (x: Task) => (x.decisions ?? []).some((d) => d.id === id || d.rec?.r === id);
    const owner = chain.find(has) ?? (await this.listTasks()).find(has);
    const d = owner?.decisions?.find((x) => x.id === id || x.rec?.r === id);
    if (!owner || !d) return reply(`No decision "${id}".`);
    if (a.title) d.title = str(a.title);
    if (a.description) d.description = str(a.description);
    if (a.options) d.options = str(a.options);
    if (Array.isArray(a.refs)) d.refs = a.refs.map(String);
    if (a.action === "implemented") {
      if (!d.rec) return reply("Only recommendations have a How implemented record.");
      const opt = (k: string) => (a[k] === undefined ? undefined : str(a[k]));
      d.rec.implemented = {
        problem: opt("problem"),
        approach: opt("approach"),
        api: opt("api"),
        code: opt("code"),
        tests: opt("tests"),
        at: this.now(),
      };
    }
    if (a.action === "decide") {
      d.status = "decided";
      d.verdict = str(a.verdict);
      d.decidedAt = this.now();
    }
    if (a.action === "drop") {
      d.status = "dropped";
      d.verdict = str(a.verdict);
    }
    if (a.action === "reopen") d.status = "open";
    await this.saveTask(owner);
    await this.rebuildContext();
    return reply(`Decision ${d.id} on "${owner.title}" is now ${d.status}.`);
  }

  async saveMasterPlan(a: Record<string, unknown>): Promise<BoardReply> {
    const t = await this.requireTask(a);
    if (typeof t === "string") return reply(t);
    const anc = await this.store.ancestorsOf(this.boardId, t);
    const master = levelOf(t) === 1 ? t : (anc[anc.length - 1] ?? t);
    const md = str(a.markdown).trim();
    if (!md) return reply("markdown is empty: nothing saved.");
    await this.store.io.write(this.masterPath(master.id), md + "\n");
    await this.saveTask(master);
    await this.rebuildContext();
    return reply(
      `Master plan saved for "${master.title}": ${this.masterPath(master.id)}. Break it down with board_create_task (modules, then tasks), each tied to a part of this plan.`,
    );
  }

  async mapDoc(a: Record<string, unknown>): Promise<BoardReply> {
    const cur = await this.requireTask(a);
    if (typeof cur === "string") return reply(cur);
    const chain = [cur, ...(await this.store.ancestorsOf(this.boardId, cur))];
    if (a.action === "remove") {
      for (const t of chain)
        if ((t.docs ?? []).some((d) => d.id === a.id)) {
          t.docs = (t.docs ?? []).filter((d) => d.id !== a.id);
          await this.saveTask(t);
          await this.rebuildContext();
          return reply(`Removed ${str(a.id)} from "${t.title}".`);
        }
      return reply(`No doc "${str(a.id)}".`);
    }
    const ref = str(a.ref).trim();
    if (!ref) return reply("ref (a path or URL) is required.");
    const want = Number(a.level ?? levelOf(cur));
    const owner = chain.find((x) => levelOf(x) <= want) ?? chain[chain.length - 1] ?? cur;
    const title = str(a.title).trim() || ref.split(/[\\/]/).pop() || ref;
    const d = {
      id: this.newId("doc-"),
      kind: str(a.kind, "Reference"),
      title,
      ref,
      note: str(a.note),
      at: this.now(),
      by: this.sess?.sessionId,
    };
    owner.docs = [...(owner.docs ?? []), d];
    await this.saveTask(owner);
    await this.rebuildContext();
    return reply(
      `Mapped [${d.kind}] ${title} to ${LEVEL_NAME[levelOf(owner)]} "${owner.title}" (${d.id}).`,
    );
  }

  async linkTasks(a: Record<string, unknown>): Promise<BoardReply> {
    const cur = await this.requireTask(a);
    if (typeof cur === "string") return reply(cur);
    const other = await this.loadTask(slug(str(a.to)));
    if (!other) return reply(`No task "${str(a.to)}". Use board_find to look it up.`);
    let type = str(a.type, "related");
    let from = cur;
    let to = other;
    const flip = LINK_FLIP[type];
    if (flip) {
      type = flip[0];
      from = other;
      to = cur;
    }
    if (type !== "blocked_by" && type !== "found_during" && type !== "related" && type !== "fixes")
      return reply("type must be blocked_by, blocks, found_during, led_to, related or fixes.");
    if (from.id === to.id) return reply("A task cannot link to itself.");
    from.links = (from.links ?? []).filter((l) => !(l.to === to.id && l.type === type));
    if (a.action !== "remove")
      from.links.push({
        to: to.id,
        type,
        note: str(a.note),
        at: this.now(),
        by: this.sess?.sessionId,
      });
    await this.saveTask(from);
    await this.rebuildContext();
    return reply(
      a.action === "remove"
        ? "Removed the link."
        : `Linked: "${from.title}" ${type.replace("_", " ")} "${to.title}".`,
    );
  }

  async moveTask(a: Record<string, unknown>): Promise<BoardReply> {
    const t = await this.requireTask(a);
    if (typeof t === "string") return reply(t);
    const all = await this.listTasks();
    const par = a.parentId ? all.find((x) => x.id === slug(str(a.parentId))) : null;
    if (a.parentId && !par) return reply(`No task "${str(a.parentId)}".`);
    const kids = (id: string) => all.filter((x) => x.parentId === id);
    const desc = (id: string): Task[] => kids(id).flatMap((k) => [k, ...desc(k.id)]);
    if (par && (par.id === t.id || desc(t.id).some((d) => d.id === par.id)))
      return reply("Cannot move a task under itself.");
    const height = (id: string): number => 1 + Math.max(0, ...kids(id).map((k) => height(k.id)));
    const newLevel = par ? levelOf(par) + 1 : 1;
    if (newLevel + height(t.id) - 1 > 3) return reply("That would go deeper than 3 levels.");
    const delta = newLevel - levelOf(t);
    const old = t.parentId ? all.find((x) => x.id === t.parentId) : null;
    if (old && old.id !== par?.id)
      t.origin = [...(t.origin ?? []), { id: old.id, title: old.title }];
    t.parentId = par?.id ?? null;
    for (const x of [t, ...desc(t.id)]) {
      x.level = Math.min(3, Math.max(1, levelOf(x) + delta)) as Level;
      if (x.level === 1 && !x.kind) x.kind = "feature";
      await this.saveTask(x);
    }
    await this.rebuildContext();
    return reply(
      `Moved "${t.title}" to ${par ? `"${par.title}" (now Level ${t.level})` : "the top level (master task)"}.`,
    );
  }

  async findTasks(a: Record<string, unknown>): Promise<BoardReply> {
    if (!this.board) return reply(await this.unassignedHelp());
    const q = str(a.query).toLowerCase().split(/\s+/).filter(Boolean);
    const svc = a.service ? str(a.service).toLowerCase() : "";
    const all = await this.listTasks();
    const byId = new Map(all.map((x) => [x.id, x]));
    const pathOf = (x: Task) => {
      const p: string[] = [];
      let c: Task | undefined = x;
      for (let i = 0; i < 3 && c; i++) {
        p.unshift(c.title);
        c = c.parentId ? byId.get(c.parentId) : undefined;
      }
      return p.join(" › ");
    };
    const hits = all.filter(
      (x) =>
        (a.includeDone || x.status !== "done") &&
        (!svc || (x.services ?? []).includes(svc) || x.mainService === svc) &&
        q.every((w) => `${x.title} ${x.description} ${x.id}`.toLowerCase().includes(w)),
    );
    if (!hits.length) return reply("No matching tasks.");
    return reply(
      hits
        .slice(0, 25)
        .map(
          (x) =>
            `- ${x.id} [L${levelOf(x)}${levelOf(x) === 1 ? ` ${x.kind ?? "feature"}` : ""}, ${x.status}] ${pathOf(x)}${x.services?.length ? ` · services: ${x.services.join(", ")}` : ""}`,
        )
        .join("\n"),
    );
  }

  async releaseOwnership(a: Record<string, unknown>): Promise<BoardReply> {
    const t = await this.requireTask(a);
    if (typeof t === "string") return reply(t);
    const holder = await this.ownerHolder(t);
    if (!holder?.owner) return reply("Nobody owns this module or master task.");
    if (!sameRoot(holder.owner.root, this.sess?.workspace))
      return reply(
        `Only workspace ${holder.owner.label} (the owner) can release "${holder.title}".`,
      );
    if (a.action === "reclaim") {
      const { softAt: _softAt, ...owned } = holder.owner;
      holder.owner = { ...owned, state: "owned" };
      this.ownerHistory(holder, "reclaim", { to: holder.owner.label });
      await this.saveTask(holder);
      await this.rebuildContext();
      return reply(`"${holder.title}" is owned by ${holder.owner.label} again.`);
    }
    if (a.action === "free") {
      this.ownerHistory(holder, "release", { from: holder.owner.label });
      holder.owner = null;
      await this.saveTask(holder);
      await this.rebuildContext();
      return reply(`Released "${holder.title}": the next workspace to link claims it.`);
    }
    // soft: only when everything is pushed, clean and checkpointed after the last commit
    const repos = await this.reposFor(holder);
    const problems: string[] = [];
    if (!repos.length) problems.push("no repos found — tag the services it touches first");
    for (const r of repos) {
      if (!r.upstream) problems.push(`${r.name}: branch ${r.branch} has no upstream — push it`);
      else if (r.ahead) problems.push(`${r.name}: ${r.ahead} commit(s) on ${r.branch} not pushed`);
      if (r.dirty) problems.push(`${r.name}: ${r.dirty} uncommitted change(s)`);
    }
    const all = await this.listTasks();
    const desc = (id: string): Task[] =>
      all.filter((x) => x.parentId === id).flatMap((k) => [k, ...desc(k.id)]);
    let handoffAt = 0;
    for (const x of [holder, ...desc(holder.id)]) {
      try {
        handoffAt = Math.max(handoffAt, (await this.store.io.stat(this.livingPath(x.id))).mtimeMs);
      } catch {}
    }
    const lastCommit = Math.max(0, ...repos.map((r) => r.lastCommitAt));
    if (repos.length && handoffAt < lastCommit)
      problems.push("the living handoff is older than the last commit — checkpoint first");
    if (problems.length)
      return reply(`Not ready for a soft release:\n${problems.map((x) => `- ${x}`).join("\n")}`);
    holder.owner = { ...holder.owner, state: "soft", softAt: this.now(), pickup: repos };
    this.ownerHistory(holder, "soft-release", { from: holder.owner.label });
    await this.saveTask(holder);
    await this.rebuildContext();
    return reply(
      `Soft-released "${holder.title}". Another workspace can take over from:\n${repos.map((r) => `- ${repoLine(r)}`).join("\n")}\nThis ${this.host === "t3" ? "thread" : "chat"} should stop working on it unless it reclaims it (board_release reclaim).`,
    );
  }

  async readTask(a: Record<string, unknown>): Promise<BoardReply> {
    const t = await this.requireTask(a);
    if (typeof t === "string") return reply(t);
    let text = await this.describeTask(t, true);
    if (a.step) {
      const h = await this.store.readText(
        this.store.stepHandoffPath(this.boardId, t.id, safeFileName(str(a.step))),
      );
      text += `\n\n### Handoff ${str(a.step)}\n${h || "(none)"}`;
    }
    return reply(text);
  }

  /** Runs a board tool by its name (`board_link`, …); null for a name that isn't a board tool. */
  runTool(
    name: string,
    args: Record<string, unknown>,
    extra?: { readonly t3Checkpoint?: string },
  ): Promise<BoardReply> | null {
    switch (name) {
      case "board_setup":
        return this.setupBoard(args);
      case "board_link":
        return this.linkTask(args);
      case "board_update":
        return this.updateTask(args);
      case "board_plan":
        return this.savePlan(args);
      case "board_handoff":
        return this.writeHandoff(args);
      case "board_create_task":
        return this.createTask(args);
      case "board_decision":
        return this.fileDecision(args);
      case "board_master_plan":
        return this.saveMasterPlan(args);
      case "board_doc":
        return this.mapDoc(args);
      case "board_release":
        return this.releaseOwnership(args);
      case "board_link_task":
        return this.linkTasks(args);
      case "board_move":
        return this.moveTask(args);
      case "board_find":
        return this.findTasks(args);
      case "board_promote":
        return this.promoteTask(args);
      case "board_checkpoint":
        return this.checkpoint(args, extra?.t3Checkpoint);
      case "board_read":
        return this.readTask(args);
      default:
        return null;
    }
  }
}

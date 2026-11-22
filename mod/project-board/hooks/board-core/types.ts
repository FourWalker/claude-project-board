/**
 * The Project Board's data model, as stored under `~/.claude-board` (see the board repo's
 * docs/DATA-LAYOUT.md). The Claude Code mod and T3 Code both read and write these shapes, so a
 * field added here must stay optional and old files must keep loading.
 *
 * @module board-core/types
 */

export type ItemKind = "decision" | "todo" | "mandatory";
export type Level = 1 | 2 | 3;
export type TaskStatus = "active" | "paused" | "done";
export type LinkType = "blocked_by" | "found_during" | "related" | "fixes";

export interface Implemented {
  problem?: string | undefined;
  approach?: string | undefined;
  api?: string | undefined;
  code?: string | undefined;
  tests?: string | undefined;
  at?: number | undefined;
}

export interface Decision {
  id: string;
  title: string;
  description: string;
  level: Level;
  raisedFrom: { id: string; title: string } | null;
  refs: string[];
  options: string;
  verdict: string;
  status: "open" | "decided" | "dropped";
  at: number;
  decidedAt?: number | undefined;
  by?: string | undefined;
  /** Recommendations carry a board-wide R# (or the R# of an external register they mirror). */
  rec?:
    | {
        r: string;
        area: string;
        lldCheck: string;
        register: string | null;
        implemented: Implemented | null;
      }
    | undefined;
}

export interface Item {
  id: string;
  kind: ItemKind;
  text: string;
  done: boolean;
  at: number;
  by?: string | undefined;
}

export interface RepoState {
  repo: string;
  name: string;
  branch: string;
  head: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  dirty: number;
  lastCommitAt: number;
  at: number;
  service?: string | undefined;
}

export interface Owner {
  root: string;
  label: string;
  state: "owned" | "soft";
  since: number;
  softAt?: number | undefined;
  pickup?: RepoState[] | undefined;
}

export interface TaskDoc {
  id: string;
  kind: string;
  title: string;
  ref: string;
  note: string;
  at: number;
  by?: string | undefined;
}

export interface TaskLink {
  to: string;
  type: LinkType;
  note: string;
  at: number;
  by?: string | undefined;
}

export interface TaskSessionRef {
  sessionId: string;
  linkedAt: number;
  workspaceLabel: string;
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  createdAt: number;
  updatedAt: number;
  lastAction: { text: string; sessionId: string; workspaceLabel: string; at: number } | null;
  items: Item[];
  sessions: TaskSessionRef[];
  /** 1 = master task, 2 = module, 3 = task. Missing means 1 (tasks made before levels existed). */
  level?: Level | undefined;
  parentId?: string | null | undefined;
  /** Former ancestors kept after a promotion or move, so their handoffs stay reachable. */
  origin?: { id: string; title: string }[] | undefined;
  decisions?: Decision[] | undefined;
  docs?: TaskDoc[] | undefined;
  /** Level 1 only: a feature (has a master plan) or a service backlog. */
  kind?: "feature" | "backlog" | undefined;
  mainService?: string | null | undefined;
  /** Service ids this task touches. */
  services?: string[] | undefined;
  /** Outgoing links; the board shows the reverse side on the other task. */
  links?: TaskLink[] | undefined;
  /** Modules and master tasks: which workspace copy works on it (tasks inherit). */
  owner?: Owner | null | undefined;
  ownerHistory?:
    | {
        type: string;
        at: number;
        by?: string | undefined;
        from?: string | undefined;
        to?: string | undefined;
      }[]
    | undefined;
  overrides?:
    | { workspace: string; at: number; session: string; said?: string | undefined }[]
    | undefined;
  /** Each repo's branch / HEAD / push / clean state, recorded at every checkpoint. */
  repoState?: RepoState[] | undefined;
  /** A fix for a bug found in finished work (linked with "fixes" to the original task). */
  bug?: boolean | undefined;
}

export interface Service {
  id: string;
  name: string;
  match: string[];
}

export interface Root {
  path: string;
  label: string;
}

export interface Board {
  id: string;
  name: string;
  roots: Root[];
  createdAt: number;
  boardMode?: boolean | undefined;
  services?: Service[] | undefined;
  registers?: { id: string; topic: string; url: string }[] | undefined;
  rules?: string | undefined;
}

export interface Registry {
  version: 1;
  boards: Board[];
}

/**
 * Where a chat runs. Claude Code chats are the mod's sessions; T3 threads are reported by the
 * T3 Code fork for any provider. Missing means a Claude Code chat (records made before T3).
 */
export type SessionSource =
  | { kind: "claude-code" }
  | {
      kind: "t3-thread";
      threadId: string;
      projectId?: string | undefined;
      environmentId?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
    };

export interface Session {
  sessionId: string;
  projectId: string | null;
  taskId: string | null;
  linkDeclined: boolean;
  cwd: string;
  workspace: string;
  workspaceLabel: string;
  subfolder: string;
  branch: string;
  status: "working" | "idle" | "ended";
  title: string;
  lastPrompt: string;
  lastAnswer: string;
  turnStartedAt: number;
  updatedAt: number;
  heartbeatAt: number;
  resumeId?: string | undefined;
  hostSessionId?: string | undefined;
  surface?: string | undefined;
  supersededBy?: string | undefined;
  movedTo?: string | undefined;
  suggestedRoot?: string | undefined;
  suggestedName?: string | undefined;
  boardModeOff?: boolean | undefined;
  source?: SessionSource | undefined;
}

// Claude Project Board — reporter mod.
// Each chat finds its board through the board registry (%USERPROFILE%/.claude-board/boards.json):
// a board lists the root folders of its workspace copies, and a chat whose folder is inside a
// root belongs to that board. A chat in a folder no board covers is "unassigned": nothing is
// created until the person names a board (Claude asks first). Layout: docs/DATA-LAYOUT.md.
import type { Register } from 'claude-code'

type Kind = 'decision' | 'todo' | 'mandatory'
type Decision = {
  id: string
  title: string
  description: string
  level: 1 | 2 | 3
  raisedFrom: { id: string; title: string } | null
  refs: string[]
  options: string
  verdict: string
  status: 'open' | 'decided' | 'dropped'
  at: number
  decidedAt?: number
  by?: string
  // Recommendations carry a board-wide R# (or the R# of an external register they mirror).
  rec?: { r: string; area: string; lldCheck: string; register: string | null; implemented: { problem?: string; approach?: string; api?: string; code?: string; tests?: string; at?: number } | null }
}
type Item = { id: string; kind: Kind; text: string; done: boolean; at: number; by?: string }
type Task = {
  id: string
  title: string
  description: string
  status: 'active' | 'paused' | 'done'
  createdAt: number
  updatedAt: number
  lastAction: { text: string; sessionId: string; workspaceLabel: string; at: number } | null
  items: Item[]
  sessions: { sessionId: string; linkedAt: number; workspaceLabel: string }[]
  // 1 = master task, 2 = module, 3 = task. Missing means 1 (tasks made before levels existed).
  level?: 1 | 2 | 3
  parentId?: string | null
  // Former ancestors kept after a promotion, so their handoffs stay reachable.
  origin?: { id: string; title: string }[]
  decisions?: Decision[]
  // Documents mapped to this task (tech spec, HLD, LLD, API spec, …): references, read when needed.
  docs?: { id: string; kind: string; title: string; ref: string; note: string; at: number; by?: string }[]
  // Level 1 only: a feature (has a master plan) or a service backlog (a service's own bugs and gaps).
  kind?: 'feature' | 'backlog'
  mainService?: string | null
  // Service ids this task touches (auto-tagged from the files a chat edits, editable on the board).
  services?: string[]
  // Outgoing links; the board shows the reverse side on the other task.
  links?: { to: string; type: 'blocked_by' | 'found_during' | 'related' | 'fixes'; note: string; at: number; by?: string }[]
  // Modules and master tasks: which workspace copy works on it (tasks inherit).
  owner?: Owner | null
  ownerHistory?: { type: string; at: number; by?: string; from?: string; to?: string }[]
  overrides?: { workspace: string; at: number; session: string; said?: string }[]
  // Each repo's branch / HEAD / push / clean state, recorded at every checkpoint.
  repoState?: RepoState[]
  // A fix for a bug found in finished work (linked with "fixes" to the original task).
  bug?: boolean
}
type Service = { id: string; name: string; match: string[] }
type RepoState = { repo: string; name: string; branch: string; head: string; upstream: string | null; ahead: number | null; behind: number | null; dirty: number; lastCommitAt: number; at: number; service?: string }
type Owner = { root: string; label: string; state: 'owned' | 'soft'; since: number; softAt?: number; pickup?: RepoState[] }
type Root = { path: string; label: string }
type Board = { id: string; name: string; roots: Root[]; createdAt: number; boardMode?: boolean; services?: Service[]; registers?: { id: string; topic: string; url: string }[]; rules?: string }
type Registry = { version: 1; boards: Board[] }
type Sess = {
  sessionId: string
  projectId: string | null
  taskId: string | null
  linkDeclined: boolean
  cwd: string
  workspace: string
  workspaceLabel: string
  subfolder: string
  branch: string
  status: 'working' | 'idle' | 'ended'
  title: string
  lastPrompt: string
  lastAnswer: string
  turnStartedAt: number
  updatedAt: number
  heartbeatAt: number
  resumeId?: string
  hostSessionId?: string
  surface?: string
  supersededBy?: string
  movedTo?: string
  suggestedRoot?: string
  suggestedName?: string
  boardModeOff?: boolean
}

const HEARTBEAT_MS = 30_000
// VS Code's placeholder folder for untrusted workspaces, and similar: never reported.
const IGNORED = /\/globalStorage\/|\/untrusted-start(\/|$)/i

// Module state: rebuilt by session.start on every (re)load.
let root = '' // ~/.claude-board
let board: Board | null = null
let projectDir = ''
let sess: Sess | null = null
let ignored = false
let boardContext = ''
let lastActionSetThisTurn = false
let heartbeat: { cancel: () => void } | null = null
// A chat is written only once the person has spoken in it (or it was linked/set up),
// so background runs that never take a prompt leave nothing behind.
let reported = false
// Tools and commands wait for session setup, which can still be running right after a reload.
let ready: Promise<void> = Promise.resolve()

const now = () => Date.now()
const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'task'
const norm = (p: string) =>
  p.replace(/\\/g, '/').replace(/\/+$/, '').replace(/^([a-z]):/, (_m: string, d: string) => d.toUpperCase() + ':')
const base = (p: string) => p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p
const parent = (p: string) =>
  /^[A-Za-z]:\/?$|^\/$/.test(p) ? '' : (p.replace(/\/[^/]*$/, '') || '/').replace(/^([A-Za-z]:)$/, '$1/')
const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s)
const firstPara = (s: string) =>
  s
    .replace(/```[\s\S]*?```/g, ' ')
    .split(/\n\s*\n/)
    .map(x => x.replace(/[#*_`>|]/g, '').replace(/\s+/g, ' ').trim())
    .find(x => x.length > 0) ?? ''

async function readJson<V>($: any, path: string, fallback: V): Promise<V> {
  try {
    return JSON.parse(await $.fs.read(path)) as V
  } catch {
    return fallback
  }
}
const writeJson = ($: any, path: string, v: unknown) => $.fs.write(path, JSON.stringify(v, null, 2))
async function readText($: any, path: string): Promise<string> {
  try {
    return await $.fs.read(path)
  } catch {
    return ''
  }
}

const regPath = () => `${root}/boards.json`
const taskDir = (id: string) => `${projectDir}/tasks/${id}`
const sessPath = (id: string) => (board ? `${projectDir}/sessions/${id}.json` : `${root}/unassigned/${id}.json`)

async function loadRegistry($: any): Promise<Registry> {
  const r = await readJson<Registry | null>($, regPath(), null)
  return r && Array.isArray(r.boards) ? r : { version: 1, boards: [] }
}

function findBoard(reg: Registry, cwd: string): { board: Board; root: Root } | null {
  const c = norm(cwd).toLowerCase()
  let best: { board: Board; root: Root } | null = null
  for (const b of reg.boards)
    for (const r of b.roots) {
      const rp = norm(r.path).toLowerCase()
      if ((c === rp || c.startsWith(rp + '/')) && (!best || rp.length > norm(best.root.path).length)) best = { board: b, root: r }
    }
  return best
}

async function saveSess($: any, patch: Partial<Sess>) {
  if (!sess || ignored) return
  sess = { ...sess, ...patch, updatedAt: now(), heartbeatAt: now() }
  if (reported) await writeJson($, sessPath(sess.sessionId), sess)
}

async function loadTask($: any, id: string): Promise<Task | null> {
  if (!projectDir) return null
  return readJson<Task | null>($, `${taskDir(id)}/task.json`, null)
}
async function saveTask($: any, t: Task) {
  t.updatedAt = now()
  await writeJson($, `${taskDir(t.id)}/task.json`, t)
}

async function listTasks($: any): Promise<Task[]> {
  if (!projectDir) return []
  try {
    const out: Task[] = []
    for (const d of await $.fs.list(`${projectDir}/tasks`)) if (d.kind === 'dir') {
      const t = await loadTask($, d.name)
      if (t) out.push(t)
    }
    return out
  } catch {
    return []
  }
}

// ---- services ------------------------------------------------------------------
// A file belongs to a service when its path contains one of the service's folder patterns
// (e.g. "/BE/invoice-microservice/"), wherever the workspace copy or a linked folder puts it.
const warnedServices = new Set<string>()
function serviceOfPath(file: string): Service | null {
  const f = '/' + norm(String(file || '')).toLowerCase() + '/'
  let best: Service | null = null
  let bestLen = 0
  for (const svc of board?.services ?? [])
    for (const m of svc.match) {
      const pat = '/' + m.toLowerCase().replace(/^\/+|\/+$/g, '') + '/'
      if (f.includes(pat) && pat.length > bestLen) { best = svc; bestLen = pat.length }
    }
  return best
}
async function tagService($: any, file: string, ran: any) {
  try {
    if (!board || !sess?.taskId || ignored || !ran || ran.deny !== undefined || ran.isError) return ran
    const svc = serviceOfPath(file)
    if (!svc) return ran
    const t = await loadTask($, sess.taskId)
    if (!t) return ran
    const had = t.services ?? []
    if (had.includes(svc.id)) return ran
    t.services = [...had, svc.id]
    await saveTask($, t)
    await rebuildContext($)
    if (!had.length || warnedServices.has(svc.id)) return ran
    warnedServices.add(svc.id)
    const note = `Board: this edit is in ${svc.name}, outside this task's services so far (${had.map(svcName).join(', ')}). If it is a bug or extra work beyond this task's scope, stop and follow the out-of-scope protocol (ask: new task in another chat / fix here with recorded scope / task for later). If it is genuinely part of this task, carry on; the task is now tagged ${svc.name}.`
    return { ...ran, context: [...(ran.context ?? []), note] }
  } catch {
    return ran
  }
}
// ---- git state of a module's repos ----------------------------------------------
let pickupNote = '' // shown to a chat that just took over a soft-released module, until it checkpoints
async function gitState($: any, dir: string): Promise<RepoState | null> {
  const g = async (...a: string[]) => {
    try {
      const r = await $.process.run(['git', '-C', dir, ...a], { timeoutMs: 8000 })
      return r.exitCode === 0 ? String(r.stdout).trim() : null
    } catch { return null }
  }
  const top = await g('rev-parse', '--show-toplevel')
  if (!top) return null
  const upstream = await g('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  let ahead: number | null = null, behind: number | null = null
  if (upstream) { const c = await g('rev-list', '--left-right', '--count', `${upstream}...HEAD`); if (c) { const [b, a] = c.split(/\s+/).map(Number); behind = b ?? null; ahead = a ?? null } }
  const status = (await g('status', '--porcelain')) ?? ''
  return {
    repo: norm(top), name: base(top), branch: (await g('rev-parse', '--abbrev-ref', 'HEAD')) ?? '?', head: (await g('rev-parse', '--short', 'HEAD')) ?? '?',
    upstream, ahead, behind, dirty: status.split('\n').filter(Boolean).length,
    lastCommitAt: Number((await g('log', '-1', '--format=%ct')) ?? 0) * 1000, at: now(),
  }
}
// The repos a task's module works in: its tree's service folders inside this workspace,
// falling back to the chat's own repo when nothing is tagged yet.
async function reposFor($: any, t: Task): Promise<RepoState[]> {
  const node = await ownerNodeOf($, t)
  const all = await listTasks($)
  const desc = (id: string): Task[] => all.filter(x => x.parentId === id).flatMap(k => [k, ...desc(k.id)])
  const tree = [node, ...desc(node.id)]
  const ids = new Set(tree.flatMap(x => [...(x.services ?? []), ...(x.mainService ? [x.mainService] : [])]))
  const seen = new Map<string, RepoState>()
  for (const svc of board?.services ?? []) if (ids.has(svc.id)) for (const m of svc.match) {
    const dir = `${sess?.workspace}/${m}`
    if (!(await $.fs.exists(dir).catch(() => false))) continue
    const st = await gitState($, dir)
    if (st && !seen.has(st.repo)) seen.set(st.repo, { ...st, service: svc.id })
  }
  if (!seen.size && sess) { const st = await gitState($, sess.cwd); if (st) seen.set(st.repo, st) }
  return [...seen.values()]
}
const repoLine = (r: RepoState) => `${r.name} · ${r.branch} @ ${r.head} · ${!r.upstream ? 'not pushed (no upstream)' : r.ahead ? `${r.ahead} commit(s) not pushed` : 'pushed'}${r.behind ? `, ${r.behind} behind` : ''} · ${r.dirty ? `${r.dirty} uncommitted` : 'clean'}`
// Ownership lives on modules and master tasks; a task belongs to its module's (else feature's) owner.
async function ownerNodeOf($: any, t: Task): Promise<Task> {
  if (levelOf(t) === 3 && t.parentId) return (await loadTask($, t.parentId)) ?? t
  return t
}
async function ownerHolder($: any, t: Task): Promise<Task | null> {
  let cur: Task | null = await ownerNodeOf($, t)
  for (let i = 0; i < 3 && cur; i++) {
    if (cur.owner) return cur
    cur = cur.parentId ? await loadTask($, cur.parentId) : null
  }
  return null
}
const sameRoot = (a?: string, b?: string) => !!a && !!b && norm(a).toLowerCase() === norm(b).toLowerCase()
function ownerHistory(t: Task, type: string, extra: Record<string, string | undefined>) {
  t.ownerHistory = [...(t.ownerHistory ?? []), { type, at: now(), by: sess?.sessionId, ...extra }].slice(-30)
}

const svcName = (id: string) => board?.services?.find(x => x.id === id)?.name ?? id

// ---- hierarchy -------------------------------------------------------------
const LEVEL_NAME = { 1: 'master task', 2: 'module', 3: 'task' } as const
const levelOf = (t: Task): 1 | 2 | 3 => (t.level === 2 || t.level === 3 ? t.level : 1)
const livingPath = (id: string) => `${taskDir(id)}/handoff.md`
const masterPath = (id: string) => `${taskDir(id)}/masterplan.md`
async function ancestorsOf($: any, t: Task): Promise<Task[]> {
  const out: Task[] = []
  let cur: Task | null = t
  for (let i = 0; i < 3 && cur?.parentId; i++) {
    cur = await loadTask($, cur.parentId)
    if (cur) out.push(cur)
  }
  return out // nearest first
}
async function childrenOf($: any, id: string): Promise<Task[]> {
  return (await listTasks($)).filter(t => t.parentId === id).sort((a, b) => a.createdAt - b.createdAt)
}
const crumb = (t: Task, anc: Task[]) => [...anc].reverse().map(a => a.title).concat(t.title).join(' › ')
const objectiveLine = (md: string) =>
  (md.split(/\r?\n/).find(l => /^\s*(objective|goal)\s*:/i.test(l)) ?? firstPara(md.replace(/<!--[\s\S]*?-->/g, ''))).trim()

// ---- plan helpers -------------------------------------------------------
const STEP = /^(\s*[-*]\s+\[)([ xX])(\]\s+)([A-Za-z]*\d+[A-Za-z0-9.]*|[A-Z][A-Za-z0-9.]*)[:.)]?\s*(.*)$/
function nextStep(plan: string): { id: string; text: string } | null {
  for (const line of plan.split(/\r?\n/)) {
    const m = STEP.exec(line)
    if (m && m[2] === ' ') return { id: m[4] ?? '', text: (m[5] ?? '').replace(/\s*→\s*\(task [A-Za-z0-9-]+\)/, '') }
  }
  return null
}
function tickStep(plan: string, id: string): string {
  return plan
    .split(/\r?\n/)
    .map(line => {
      const m = STEP.exec(line)
      return m && (m[4] ?? '').toLowerCase() === id.toLowerCase() ? line.replace(/\[ \]/, '[x]') : line
    })
    .join('\n')
}
async function latestHandoff($: any, id: string): Promise<{ step: string; text: string } | null> {
  try {
    const files = (await $.fs.list(`${taskDir(id)}/handoffs`)).filter((f: any) => f.name.endsWith('.md'))
    if (!files.length) return null
    files.sort((a: any, b: any) => b.mtimeMs - a.mtimeMs)
    return { step: files[0].name.replace(/\.md$/, ''), text: await readText($, `${taskDir(id)}/handoffs/${files[0].name}`) }
  } catch {
    return null
  }
}

// ---- context for the model ---------------------------------------------
async function describeTask($: any, t: Task, full: boolean): Promise<string> {
  const plan = await readText($, `${taskDir(t.id)}/plan.md`)
  const next = nextStep(plan)
  const living = await readText($, livingPath(t.id))
  const ho = living ? null : await latestHandoff($, t.id)
  const open = t.items.filter(i => !i.done)
  const anc = await ancestorsOf($, t)
  const kids = await childrenOf($, t.id)
  const lv = levelOf(t)
  const lines = [
    `Task "${t.title}" (Level ${lv} ${LEVEL_NAME[lv]}, id: ${t.id}, status: ${t.status}) on the ${board?.name ?? '?'} board.`,
    anc.length ? `Path: ${crumb(t, anc)}` : '',
    t.description ? `Purpose: ${t.description}` : 'Purpose: (not written yet — ask or infer, then save it with board_update.description)',
    next ? `Next step: ${next.id} – ${next.text}` : plan ? 'Every plan step is ticked.' : 'No plan saved yet.',
    t.lastAction ? `Last action (${t.lastAction.workspaceLabel}): ${t.lastAction.text}` : '',
    `Living handoff: ${livingPath(t.id)}${living ? '' : ' (not written yet)'}`,
  ]
  if (open.length) lines.push('Open items:', ...open.map(i => `- [${i.kind}] ${i.text} (id ${i.id})`))
  const decs: string[] = []
  for (const d of t.decisions ?? []) if (d.status === 'open') decs.push(`- ${d.id} [L${d.level}, open] ${d.title}${d.raisedFrom ? ` (raised in ${d.raisedFrom.title})` : ''}`)
  for (const a of anc) for (const d of a.decisions ?? []) {
    if (d.status === 'open') decs.push(`- ${d.id} [L${d.level} on "${a.title}", open] ${d.title}${d.raisedFrom?.id === t.id ? ' (raised here)' : ''}`)
    else if (d.status === 'decided') decs.push(`- ${d.id} [L${d.level} on "${a.title}", decided] ${d.title} → ${clip(d.verdict, 140)}`)
  }
  for (const d of t.decisions ?? []) if (d.status === 'decided') decs.push(`- ${d.id} [L${d.level}, decided] ${d.title} → ${clip(d.verdict, 140)}`)
  if (decs.length) lines.push('Decisions bearing on this task (decided ones are binding; open ones are not settled):', ...decs.slice(0, 20))
  if (lv === 1) lines.push(`Kind: ${t.kind === 'backlog' ? 'service backlog (a service\'s own bugs and gaps)' : 'feature'}${t.mainService ? ` · main service: ${svcName(t.mainService)}` : ''}`)
  if (t.services?.length) lines.push(`Services touched: ${t.services.map(svcName).join(', ')}`)
  const holder = await ownerHolder($, t)
  if (holder?.owner) {
    const o = holder.owner
    const here = sameRoot(o.root, sess?.workspace)
    lines.push(`Ownership: "${holder.title}" is ${o.state === 'soft' ? 'soft-released by' : 'owned by'} workspace ${o.label}${here ? ' (this one)' : ''}.${!here && o.state === 'owned' ? (hasOverride(t) ? ' This chat works here by a one-time override the person gave — coordinate branches with that copy.' : ' This chat must not change it unless the person agrees to an override.') : ''}${here && o.state === 'soft' ? ' Reclaim it (board_release reclaim) before continuing here, or let another workspace take over.' : ''}`)
  }
  if (t.repoState?.length) lines.push('Repo state at the last checkpoint:', ...t.repoState.map(r => `- ${repoLine(r)}`))
  if (t.bug) lines.push('This task fixes a bug found after the original work was done.')
  const linkLines: string[] = []
  for (const l of t.links ?? []) {
    const o = await loadTask($, l.to)
    if (!o) { linkLines.push(`- ${l.type} ${l.to} (missing/archived)`); continue }
    const nx = nextStep(await readText($, `${taskDir(o.id)}/plan.md`))
    if (l.type === 'blocked_by') linkLines.push(o.status === 'done' ? `- Blocker resolved: "${o.title}" (${o.id}) is done.` : `- BLOCKED BY "${o.title}" (${o.id}, ${o.status}${nx ? `, next: ${nx.id} – ${nx.text}` : ''}). Don't start work that depends on it.`)
    else if (l.type === 'fixes') linkLines.push(`- Fixes "${o.title}" (${o.id}, ${o.status}) — its living handoff: ${livingPath(o.id)}`)
    else linkLines.push(`- ${l.type === 'found_during' ? 'Found during' : 'Related to'} "${o.title}" (${o.id}, ${o.status})${l.note ? ` — ${clip(l.note, 80)}` : ''}`)
  }
  for (const o of await listTasks($)) for (const l of o.links ?? []) if (l.to === t.id) {
    if (l.type === 'fixes') { if (o.status !== 'done') linkLines.push(`- Open fix: "${o.title}" (${o.id}) fixes a bug in this work.`); continue }
    linkLines.push(l.type === 'blocked_by' ? `- Blocks "${o.title}" (${o.id}, ${o.status}) — finishing this unblocks it.` : l.type === 'found_during' ? `- Led to "${o.title}" (${o.id}, ${o.status}), found during this work.` : `- Related to "${o.title}" (${o.id}, ${o.status})`)
  }
  if (linkLines.length) lines.push('Linked tasks:', ...linkLines.slice(0, 15))
  if (kids.length) {
    lines.push(`Subtasks (Level ${lv + 1}):`)
    for (const k of kids) {
      const nx = nextStep(await readText($, `${taskDir(k.id)}/plan.md`))
      lines.push(`- ${k.id}: ${k.title} [${k.status}]${nx ? ` next: ${nx.id} – ${nx.text}` : ''}`)
    }
  }
  const master = levelOf(t) === 1 ? t : anc[anc.length - 1]
  if (master) {
    const mp = await readText($, masterPath(master.id))
    if (mp && master.id !== t.id) lines.push(`Master plan of "${master.title}": ${masterPath(master.id)} — ${clip(objectiveLine(mp), 160)} (read it when this task's scope is unclear)`)
    else if (!mp && master.id === t.id) lines.push(`Master plan: not written yet (${masterPath(t.id)}). Planning chats write it first with board_master_plan, unless the person brings their own.`)
  }
  const docLines: string[] = []
  for (const d of t.docs ?? []) docLines.push(`- [${d.kind}] ${d.title}: ${d.ref}${d.note ? ` — ${clip(d.note, 100)}` : ''}`)
  for (const a of anc) for (const d of a.docs ?? []) docLines.push(`- [${d.kind}, from ${LEVEL_NAME[levelOf(a)]} "${a.title}"] ${d.title}: ${d.ref}`)
  if (docLines.length) lines.push('Docs and references (read one only when the current step needs it):', ...docLines.slice(0, 25))
  if (anc.length || t.origin?.length) {
    lines.push('Parent context (read a parent\'s handoff file only when the next step needs it):')
    for (const a of anc) {
      const aplan = nextStep(await readText($, `${taskDir(a.id)}/plan.md`))
      const ah = await readText($, livingPath(a.id))
      lines.push(`- Level ${levelOf(a)} "${a.title}" (id ${a.id}): ${a.description || 'no purpose written'}${aplan ? ` · next: ${aplan.id} – ${aplan.text}` : ''}${ah ? ` · handoff ${livingPath(a.id)} — ${clip(objectiveLine(ah), 160)}` : ''}`)
    }
    for (const o of t.origin ?? []) lines.push(`- Former parent "${o.title}" (id ${o.id}) · handoff ${livingPath(o.id)}`)
  }
  if (full) {
    if (levelOf(t) === 1) {
      const mp = await readText($, masterPath(t.id))
      if (mp) lines.push('', '### Master plan (masterplan.md)', clip(mp, 6000))
    }
    if (plan) lines.push('', '### Plan (plan.md)', clip(plan, 7000))
    if (living) lines.push('', '### Living handoff (handoff.md)', clip(living, 4000))
    else if (ho) lines.push('', `### Latest step note (${ho.step})`, clip(ho.text, 3500))
  }
  return lines.filter(Boolean).join('\n')
}

const TOOL_RULES = `Board rules:
- Always name plan steps by id AND name ("A2 – Retry handling"), never the id alone, so the person knows what it means.
- After a meaningful piece of work, call board_update with a one-line lastAction (what was done, in plain words).
- When a plan step is finished, call board_handoff with that step's id and a short step note (what was done, files touched, how to test). It ticks the step. Then rewrite the task's living handoff with board_checkpoint.
- Delegate work by creating subtasks with board_create_task (modules under a master task, tasks under a module). If a task is bigger than expected, suggest board_promote.
- When you create or change the plan, save the whole plan with board_plan (phases as "## Phase A — name" headings, steps as "- [ ] A1 name" checkboxes).
- Record todos and must-dos with board_update.add. Record decisions with board_decision: give a title, the context (description), options or your recommendation, and references (handoff/doc paths, URLs). YOU choose its level: the level of the narrowest task it affects — a question that only affects this task stays here; one that affects the module or the whole master task goes to that level even if it came up here (it stays mapped to this task). Record a verdict only when the person tells you what was decided; a recommendation is not a verdict.
- A master task has a master plan (the implementation plan its modules and tasks are broken down from): write or update it with board_master_plan. Each task's phase checklist stays in board_plan.
- Map documents with board_doc when they come up (tech spec, HLD, LLD, API spec, design, runbook): title, kind, path or URL, one-line note, on the level they cover. Don't copy their content into handoffs; read them only when needed.
- If a plan for this task already exists elsewhere (a file in the repo, a handoffs folder, ~/.claude/plans), import it with board_plan instead of starting over.`

const BOARD_MODE = `## Board Mode (this workspace's protocol)
The person works one phase per chat and moves to a new chat when one fills up. Continuity lives in each task's living handoff, not in chat history.
1. Start of a linked chat: rebuild context from the task, its living handoff and the parent context above. Verify each affected repo's branch, HEAD and working changes before acting; if they differ from the handoff, reconcile first. The handoff does not authorize pending actions. Read code only where the next step needs it.
2. Living handoff: ONE per task, rewritten in place with board_checkpoint — never appended, no dated update sections. Shape: Objective · Workspace · Repository (each affected repo) · Branch / HEAD · Working changes · Verified results (checks run and their results) · Not verified · Decisions and constraints (with why; mark recommendations as such) · Next step (one concrete action) · Relevant references (path:line or commands) · Resume line. About 30-40 lines / 400 words. Never copy secrets (passwords, tokens, keys, connection strings) into it.
3. Checkpoint (board_checkpoint) when a plan step finishes (plus board_handoff for that step), after an important decision, before suggesting a new chat, and when the person says "checkpoint" or runs /checkpoint. Then reply with: the handoff path, the 3-5 lines that changed, and "Resume: run /task <task id> in a new chat."
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
12. Token hygiene: redirect long builds, tests and logs to <workspace>/.local-run/logs/<task id>/<name>.log, capture the exit code, read with tail/grep. Reference file:line instead of pasting. Replies: result, files changed, next step.`
const servicesLine = () => (board?.services?.length ? `\nServices on this board (folder patterns): ${board.services.map(x => `${x.id}=${x.match.join('|')}`).join(', ')}` : '')
const boardModeOn = () => !!board?.boardMode && !sess?.boardModeOff

async function unassignedHelp($: any): Promise<string> {
  const reg = await loadRegistry($)
  const list = reg.boards.map(b => `- ${b.name} (id ${b.id}; workspaces: ${b.roots.map(r => `${r.label} = ${r.path}`).join(', ')})`)
  return `This chat's folder (${sess?.cwd}) is not on any board yet.
Suggested root for it: ${sess?.suggestedRoot} — suggested board name: ${sess?.suggestedName}.
${list.length ? `Existing boards:\n${list.join('\n')}` : 'There are no boards yet.'}
Before creating any task, ask the person ONE question: create a new board (ask for its name, offering "${sess?.suggestedName}" and root ${sess?.suggestedRoot}), or add this workspace to one of the existing boards (if one looks like the same project, say so). Then call board_setup with their answer. Never create a board without asking.`
}

async function rebuildContext($: any) {
  await buildContext($)
  if (boardContext && pickupNote) boardContext += `\n\n### Pickup point\n${pickupNote}`
  if (boardContext && board && boardModeOn()) boardContext += `\n\n${BOARD_MODE}${servicesLine()}${board.rules?.trim() ? `\n\n## Project rules for the ${board.name} board\n${board.rules.trim()}` : ''}${board.registers?.length ? `\nExisting registers: ${board.registers.map(r => `${r.topic} → ${r.url}`).join('; ')}` : ''}`
}

async function buildContext($: any) {
  if (!sess || ignored) { boardContext = ''; return }
  if (!board) {
    boardContext = `## Claude Project Board\n${await unassignedHelp($)}\nOnly raise this when the person wants a task tracked (or runs /task); don't interrupt one-off questions.`
    return
  }
  const where = `workspace "${sess.workspaceLabel}" (${sess.workspace})${sess.subfolder ? `, folder ${sess.subfolder}` : ''}${sess.branch ? `, branch ${sess.branch}` : ''}`
  const head = `## Claude Project Board\nThis chat runs in ${where} of the ${board.name} board. Other chats may work on the same board in its other workspace copies: ${board.roots.map(r => r.label).join(', ')}.`
  if (sess.taskId) {
    const t = await loadTask($, sess.taskId)
    if (t) {
      boardContext = `${head}\nThis chat is linked to a task. Continue from the plan and the latest handoff below without asking the person to re-explain them.\n\n${await describeTask($, t, true)}\n\n${TOOL_RULES}`
      return
    }
  }
  if (sess.linkDeclined) {
    boardContext = `${head}\nThis chat is not linked to a board task (the person chose not to). Don't ask about linking again; board_link is there if they ask.`
    return
  }
  const tasks = (await listTasks($)).filter(t => t.status !== 'done')
  const list = await Promise.all(tasks.map(async t => {
    const nx = nextStep(await readText($, `${taskDir(t.id)}/plan.md`))
    return `- ${t.id}: ${t.title}${nx ? ` (next: ${nx.id} – ${nx.text})` : ''}`
  }))
  boardContext = `${head}
This chat is not linked to a board task yet.${list.length ? `\nActive tasks on the board:\n${list.join('\n')}` : ' The board has no active tasks.'}
Once you understand what the person is working on: if it clearly matches an active task, ask once "Link this chat to <task>?"; if it is new multi-step work, offer once to create a task for it. On yes call board_link; on no call board_link with decline: true. Don't ask for one-off questions.
When linked, the tool returns the task's plan and handoff: continue from them.`
}

// ---- board resolution ----------------------------------------------------
async function suggestRoot($: any, cwd: string): Promise<{ root: string; name: string }> {
  // Nearest folder at or above the chat's folder holding a *.code-workspace file.
  for (let d = cwd; d; d = parent(d)) {
    try {
      const ws = (await $.fs.list(d)).find((f: any) => f.kind === 'file' && /\.code-workspace$/i.test(f.name))
      if (ws) {
        const n = ws.name.replace(/\.code-workspace$/i, '').replace(/[-_ .]*(copy|\d+)$/i, '').trim()
        return { root: d, name: n.length <= 5 ? n.toUpperCase() : n }
      }
    } catch {}
  }
  const repo = await $.session.repo().catch(() => null)
  const r = repo?.root ? norm(repo.root) : cwd
  return { root: r, name: base(r).replace(/[-_ .]*(copy|\d+)$/i, '') || base(r) }
}

async function branchOf($: any, dir: string): Promise<string> {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], { cwd: dir, timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() : ''
  } catch {
    return ''
  }
}

// Places the chat on its board (or leaves it unassigned) and loads/creates its record.
async function resolve($: any) {
  if (!sess) return
  const reg = await loadRegistry($)
  const hit = findBoard(reg, sess.cwd)
  const wasUnassigned = !board
  const oldPath = sessPath(sess.sessionId)
  board = hit?.board ?? null
  projectDir = board ? `${root}/projects/${board.id}` : ''
  if (hit) {
    const rp = norm(hit.root.path)
    const sub = norm(sess.cwd).slice(rp.length).replace(/^\//, '')
    sess = { ...sess, projectId: hit.board.id, workspace: rp, workspaceLabel: hit.root.label, subfolder: sub }
    // Coming from unassigned: mark that record moved and carry its fields into the board.
    if (wasUnassigned) {
      const un = await readJson<Sess | null>($, oldPath, null)
      if (un && !un.movedTo) {
        await writeJson($, oldPath, { ...un, movedTo: hit.board.id })
        sess = { ...sess, title: sess.title || un.title, lastPrompt: sess.lastPrompt || un.lastPrompt, lastAnswer: sess.lastAnswer || un.lastAnswer }
        reported = true
      }
    }
  } else {
    const sug = await suggestRoot($, sess.cwd)
    sess = { ...sess, projectId: null, workspace: sess.cwd, workspaceLabel: base(sess.cwd), subfolder: '', suggestedRoot: sug.root, suggestedName: sug.name }
  }
}

async function init($: any, cwd: string) {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  root = `${norm(home)}/.claude-board`
  const where = norm((await $.session.root().catch(() => cwd)) || cwd)
  ignored = IGNORED.test(where + '/')
  if (ignored) return
  const sessionId: string = await $.session.id()
  // The desktop app's own id for this chat (local_…): what claude://code/continue?session= takes.
  const hostSessionId = (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) || undefined
  const surface = (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) || undefined
  board = null
  sess = {
    sessionId, projectId: null, taskId: null, linkDeclined: false, cwd: where, workspace: where,
    workspaceLabel: base(where), subfolder: '', branch: await branchOf($, where), status: 'idle',
    title: '', lastPrompt: '', lastAnswer: '', turnStartedAt: 0, updatedAt: now(), heartbeatAt: now(),
    hostSessionId, surface,
  }
  await resolve($)
  let prev = await readJson<Sess | null>($, sessPath(sessionId), null)
  reported = prev !== null && !prev.movedTo
  // The app can give the same chat a new engine id (after /clear, a restart): carry the
  // earlier record's task link over and mark that record as replaced by this one.
  if (board && hostSessionId) {
    try {
      const older: Sess[] = []
      for (const f of await $.fs.list(`${projectDir}/sessions`)) {
        if (!f.name.endsWith('.json') || f.name === `${sessionId}.json`) continue
        const o = await readJson<Sess | null>($, `${projectDir}/sessions/${f.name}`, null)
        if (o && o.hostSessionId === hostSessionId && !o.supersededBy) older.push(o)
      }
      older.sort((a, b) => b.updatedAt - a.updatedAt)
      for (const o of older) {
        prev = prev ?? o
        await writeJson($, `${projectDir}/sessions/${o.sessionId}.json`, { ...o, status: 'ended', supersededBy: sessionId })
        if (!o.taskId) continue
        const t = await loadTask($, o.taskId)
        if (!t) continue
        t.sessions = t.sessions.filter(x => x.sessionId !== o.sessionId && x.sessionId !== sessionId)
        t.sessions.push({ sessionId, linkedAt: now(), workspaceLabel: sess.workspaceLabel })
        if (t.lastAction?.sessionId === o.sessionId) t.lastAction.sessionId = sessionId
        await saveTask($, t)
      }
      if (older.length) reported = true
    } catch {}
  }
  if (prev) sess = { ...sess, taskId: prev.taskId ?? null, linkDeclined: prev.linkDeclined ?? false, title: prev.title ?? '', lastPrompt: prev.lastPrompt ?? '', lastAnswer: prev.lastAnswer ?? '' }
  await saveSess($, {})
  await rebuildContext($)
}

// ---- board setup -----------------------------------------------------------
async function setupBoard($: any, a: any) {
  await ready.catch(() => {})
  if (!sess || ignored) return ok('The board is not available in this folder.')
  const reg = await loadRegistry($)
  const rootPath = norm(String(a.root || sess.suggestedRoot || sess.cwd))
  const label = String(a.label || base(rootPath))
  if (!norm(sess.cwd).toLowerCase().startsWith(rootPath.toLowerCase()))
    return ok(`The root ${rootPath} must contain this chat's folder (${sess.cwd}).`)
  let b: Board | undefined
  if (a.action === 'attach') {
    const key = String(a.boardId || a.name || '').toLowerCase()
    b = reg.boards.find(x => x.id === key || x.name.toLowerCase() === key)
    if (!b) return ok(`No board "${a.boardId || a.name}". Boards: ${reg.boards.map(x => x.name).join(', ') || 'none'}.`)
    if (!b.roots.some(r => norm(r.path).toLowerCase() === rootPath.toLowerCase())) b.roots.push({ path: rootPath, label })
  } else {
    const name = String(a.name || '').trim()
    if (!name) return ok('Ask the person for the board name first, then call board_setup again with name.')
    const dup = reg.boards.find(x => x.name.toLowerCase() === name.toLowerCase())
    if (dup) return ok(`A board named "${dup.name}" already exists. To add this workspace to it, call board_setup with action "attach".`)
    let id = slug(name)
    for (let n = 2; reg.boards.some(x => x.id === id); n++) id = `${slug(name)}-${n}`
    b = { id, name, roots: [{ path: rootPath, label }], createdAt: now() }
    reg.boards.push(b)
  }
  await writeJson($, regPath(), reg)
  reported = true
  await resolve($)
  await saveSess($, {})
  await rebuildContext($)
  $.ui.toast(`Board: ${a.action === 'attach' ? 'added this workspace to' : 'created'} ${b.name}`)
  return ok(`${a.action === 'attach' ? `Added workspace "${label}" (${rootPath}) to` : `Created`} the ${b.name} board. Workspaces: ${b.roots.map(r => `${r.label} = ${r.path}`).join(', ')}. You can now create or link tasks with board_link.`)
}

// ---- tool handlers ---------------------------------------------------------
function ok(text: string) {
  return { result: text, text }
}

async function linkTask($: any, a: any) {
  await ready.catch(() => {})
  if (!sess || ignored) return ok('The board is not available in this folder.')
  if (!board) return ok(await unassignedHelp($))
  if (a.decline) {
    await saveSess($, { linkDeclined: true, taskId: null })
    await rebuildContext($)
    return ok('Noted: this chat stays unlinked.')
  }
  let t: Task | null = null
  if (a.taskId) t = await loadTask($, slug(a.taskId))
  if (!t && a.taskId && !a.newTaskTitle) {
    const all = await listTasks($)
    t = all.find(x => x.title.toLowerCase() === String(a.taskId).toLowerCase()) ?? null
    if (!t) return ok(`No task "${a.taskId}". Active tasks: ${all.map(x => `${x.id} (${x.title})`).join(', ') || 'none'}. Pass newTaskTitle to create one.`)
  }
  if (!t) {
    const title = String(a.newTaskTitle ?? a.taskId ?? 'Untitled task')
    let id = slug(title)
    for (let n = 2; await loadTask($, id); n++) id = `${slug(title)}-${n}`
    t = { id, title, description: String(a.description ?? ''), status: 'active', createdAt: now(), updatedAt: now(), lastAction: null, items: [], sessions: [], level: 1, parentId: null }
  }
  // Ownership: a module/feature worked on by another workspace copy is blocked unless the
  // person overrides once or takes over; a soft-released one is taken over freely.
  let ownerNote = ''
  {
    const holder = await ownerHolder($, t)
    if (holder?.owner && !sameRoot(holder.owner.root, sess.workspace)) {
      const o = holder.owner
      // An override through the tool needs the person's own words approving it.
      const said = String(a.personSaid ?? '').trim()
      if (a.override && o.state !== 'soft' && said.length < 2)
        return ok(`BLOCKED: overriding "${holder.title}" (owned by workspace ${o.label}) needs the person's approval. Ask them, then call board_link again with override and personSaid set to their words.`)
      if (o.state === 'soft' || a.override === 'takeover') {
        const from = o.label
        if (o.state === 'soft' && o.pickup?.length)
          pickupNote = `Picked up "${holder.title}" from workspace ${from}, soft-released at:\n${o.pickup.map(r => `- ${repoLine(r)}`).join('\n')}\nBefore continuing: in this workspace, for each repo fetch and check out that branch, confirm HEAD matches (or is a fast-forward of) that commit, and stop if there are uncommitted changes or the branch has diverged. Then continue with the next step.`
        ownerHistory(holder, o.state === 'soft' ? 'takeover-after-soft-release' : 'takeover', { from, to: sess.workspaceLabel })
        holder.owner = { root: sess.workspace, label: sess.workspaceLabel, state: 'owned', since: now() }
        await saveTask($, holder)
        ownerNote = `Ownership of "${holder.title}" moved from ${from} to ${sess.workspaceLabel}.`
      } else if (a.override === 'once') {
        t.overrides = [...(t.overrides ?? []), { workspace: sess.workspaceLabel, at: now(), session: sess.sessionId, said: said || 'via /task --override' }]
        ownerNote = `Working here by a one-time override: "${holder.title}" stays owned by workspace ${o.label}. Coordinate branches with that copy.`
      } else {
        return ok(`BLOCKED: "${holder.title}" is owned by workspace ${o.label} (since ${new Date(o.since).toISOString().slice(0, 10)}). Chats in ${sess.workspaceLabel} can't pick it up without the person's say-so. Ask them: (1) override once — call board_link again with override "once"; (2) take over — override "takeover" (ownership moves here); (3) leave it.`)
      }
    } else if (!holder) {
      const node = await ownerNodeOf($, t)
      // Only modules are claimed automatically; a master task is owned only when set on purpose.
      if (levelOf(node) === 2) {
        const target = node.id === t.id ? t : node
        target.owner = { root: sess.workspace, label: sess.workspaceLabel, state: 'owned', since: now() }
        ownerHistory(target, 'claimed', { to: sess.workspaceLabel })
        if (target !== t) await saveTask($, target)
      }
    }
  }
  reported = true
  if (!t.sessions.some(s => s.sessionId === sess!.sessionId))
    t.sessions.push({ sessionId: sess.sessionId, linkedAt: now(), workspaceLabel: sess.workspaceLabel })
  if (a.description && !t.description) t.description = String(a.description)
  await saveTask($, t)
  await saveSess($, { taskId: t.id, linkDeclined: false })
  await rebuildContext($)
  $.ui.toast(`Board: linked to ${t.title}`)
  return ok(`Linked this chat to the task.${ownerNote ? ` ${ownerNote}` : ''}\n\n${await describeTask($, t, true)}\n\n${TOOL_RULES}`)
}

async function requireTask($: any, a: any): Promise<Task | string> {
  await ready.catch(() => {})
  if (!board) return 'This chat is not on a board yet: ask the person, then call board_setup.'
  const id = a.taskId ? slug(a.taskId) : sess?.taskId
  if (!id) return 'This chat is not linked to a task: call board_link first.'
  const t = await loadTask($, id)
  if (!t) return `No task "${id}".`
  // Writes respect ownership too: another workspace's module needs an override for this chat.
  const holder = await ownerHolder($, t)
  if (holder?.owner && holder.owner.state === 'owned' && !sameRoot(holder.owner.root, sess?.workspace) && !hasOverride(t))
    return `BLOCKED: "${holder.title}" is owned by workspace ${holder.owner.label}. This chat (workspace ${sess?.workspaceLabel}) may not change it unless the person agrees to an override — ask them, then call board_link with override and personSaid.`
  return t
}
// A one-time override counts for the chat that received it (and for the task it was given on).
const hasOverride = (t: Task) => (t.overrides ?? []).some(o => o.session === sess?.sessionId)

async function updateTask($: any, a: any) {
  const t = await requireTask($, a)
  if (typeof t === 'string') return ok(t)
  const by = sess?.sessionId
  if (a.lastAction) {
    t.lastAction = { text: clip(String(a.lastAction), 300), sessionId: by ?? '', workspaceLabel: sess?.workspaceLabel ?? '', at: now() }
    lastActionSetThisTurn = true
  }
  if (a.description) t.description = String(a.description)
  if (a.title) t.title = String(a.title)
  if (a.status && ['active', 'paused', 'done'].includes(a.status)) t.status = a.status
  if (Array.isArray(a.services)) t.services = [...new Set(a.services.map(String))] as string[]
  if (a.mainService !== undefined) t.mainService = a.mainService ? String(a.mainService) : null
  if (a.kind === 'feature' || a.kind === 'backlog') t.kind = a.kind
  for (const it of a.add ?? []) {
    if (it.kind === 'decision') {
      t.decisions = [...(t.decisions ?? []), { id: `D-${now().toString(36).toUpperCase()}${Math.floor(Math.random() * 9)}`, title: String(it.text), description: '', level: levelOf(t), raisedFrom: null, refs: [], options: '', verdict: '', status: 'open', at: now(), by }]
      continue
    }
    const kind: Kind = ['todo', 'mandatory'].includes(it.kind) ? it.kind : 'todo'
    t.items.push({ id: `${kind[0]}${now().toString(36)}${Math.floor(Math.random() * 99)}`, kind, text: String(it.text), done: false, at: now(), by })
  }
  for (const id of a.resolve ?? []) {
    const it = t.items.find(i => i.id === id)
    if (it) it.done = true
  }
  await saveTask($, t)
  await rebuildContext($)
  return ok(`Board updated for "${t.title}". Open items: ${t.items.filter(i => !i.done).length}.`)
}

async function savePlan($: any, a: any) {
  const t = await requireTask($, a)
  if (typeof t === 'string') return ok(t)
  const md = String(a.markdown ?? '')
  if (!md.trim()) return ok('markdown is empty: nothing saved.')
  await $.fs.write(`${taskDir(t.id)}/plan.md`, md)
  await saveTask($, t)
  await rebuildContext($)
  const nx = nextStep(md)
  return ok(`Plan saved for "${t.title}".${nx ? ` Next step: ${nx.id} – ${nx.text}.` : ''}`)
}

async function writeHandoff($: any, a: any) {
  const t = await requireTask($, a)
  if (typeof t === 'string') return ok(t)
  const step = String(a.step ?? '').replace(/[^A-Za-z0-9._-]/g, '') || `note-${now()}`
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
  const header = `<!-- by chat ${sess?.sessionId ?? '?'} in ${sess?.workspaceLabel ?? '?'}${sess?.subfolder ? `/${sess.subfolder}` : ''}${sess?.branch ? ` (${sess.branch})` : ''}, ${stamp} -->\n`
  await $.fs.write(`${taskDir(t.id)}/handoffs/${step}.md`, header + String(a.markdown ?? ''))
  let plan = await readText($, `${taskDir(t.id)}/plan.md`)
  if (plan && a.markStepDone !== false) {
    plan = tickStep(plan, step)
    await $.fs.write(`${taskDir(t.id)}/plan.md`, plan)
  }
  t.lastAction = {
    text: clip(String(a.lastAction ?? `Finished ${step}: ${firstPara(String(a.markdown ?? ''))}`), 300),
    sessionId: sess?.sessionId ?? '', workspaceLabel: sess?.workspaceLabel ?? '', at: now(),
  }
  lastActionSetThisTurn = true
  await saveTask($, t)
  await rebuildContext($)
  const nx = nextStep(plan)
  return ok(`Handoff ${step} saved.${nx ? ` Next step: ${nx.id} – ${nx.text}.` : ' No unticked steps left.'}`)
}

async function createTask($: any, a: any) {
  await ready.catch(() => {})
  if (!board) return ok(await unassignedHelp($))
  const title = String(a.title ?? '').trim()
  if (!title) return ok('title is required.')
  let parent: Task | null = null
  if (a.parentId) {
    parent = await loadTask($, slug(a.parentId))
    if (!parent) return ok(`No task "${a.parentId}".`)
    if (levelOf(parent) >= 3) return ok(`"${parent.title}" is a Level 3 task and can't have subtasks. Promote it first (board_promote), then create subtasks under it.`)
  }
  let id = slug(title)
  for (let n = 2; await loadTask($, id); n++) id = `${slug(title)}-${n}`
  const level = (parent ? levelOf(parent) + 1 : 1) as 1 | 2 | 3
  const t: Task = { id, title, description: String(a.description ?? ''), status: 'active', createdAt: now(), updatedAt: now(), lastAction: null, items: [], sessions: [], level, parentId: parent?.id ?? null }
  if (level === 1) t.kind = a.kind === 'backlog' ? 'backlog' : 'feature'
  if (Array.isArray(a.services)) t.services = a.services.map(String)
  if (a.mainService) t.mainService = String(a.mainService)
  if (a.bug) t.bug = true
  if (a.fixes) {
    const orig = await loadTask($, slug(String(a.fixes)))
    if (orig) t.links = [{ to: orig.id, type: 'fixes', note: String(a.description ?? ''), at: now(), by: sess?.sessionId }]
  }
  await saveTask($, t)
  if (a.plan) await $.fs.write(`${taskDir(id)}/plan.md`, String(a.plan))
  if (parent && a.fromStep) {
    const pp = `${taskDir(parent.id)}/plan.md`
    const plan = await readText($, pp)
    const marked = plan.split(/\r?\n/).map(line => {
      const m = STEP.exec(line)
      return m && (m[4] ?? '').toLowerCase() === String(a.fromStep).toLowerCase() && !line.includes('(task ') ? `${line} → (task ${id})` : line
    }).join('\n')
    if (marked !== plan) await $.fs.write(pp, marked)
  }
  reported = true
  await rebuildContext($)
  return ok(`Created Level ${level} ${LEVEL_NAME[level]} "${title}" (id ${id})${parent ? ` under "${parent.title}"` : ''}. A chat picks it up with /task ${id}.`)
}

async function promoteTask($: any, a: any) {
  const t = await requireTask($, a)
  if (typeof t === 'string') return ok(t)
  const lv = levelOf(t)
  if (lv === 1) return ok(`"${t.title}" is already a master task.`)
  const parent = t.parentId ? await loadTask($, t.parentId) : null
  t.origin = [...(t.origin ?? []), ...(parent ? [{ id: parent.id, title: parent.title }] : [])]
  t.parentId = parent?.parentId ?? null
  t.level = (lv - 1) as 1 | 2
  for (const d of t.decisions ?? []) if (d.level === lv) d.level = t.level
  await saveTask($, t)
  // Its subtree moves up one level with it.
  for (const k of await childrenOf($, t.id)) { k.level = (levelOf(k) - 1 || 1) as 1 | 2 | 3; await saveTask($, k) }
  await rebuildContext($)
  return ok(`Promoted "${t.title}" to Level ${t.level} (${LEVEL_NAME[t.level]})${t.parentId ? ` under ${t.parentId}` : ''}. It keeps its plan, handoffs and chats; ${parent ? `"${parent.title}" stays reachable as a former parent. ` : ''}You can now create subtasks under it with board_create_task (fromStep turns a plan step into one).`)
}

async function checkpoint($: any, a: any) {
  const t = await requireTask($, a)
  if (typeof t === 'string') return ok(t)
  const md = String(a.markdown ?? '').trim()
  if (!md) return ok('markdown is empty: nothing saved.')
  const stamp = new Date().toISOString().replace('T', ' ').slice(0, 16)
  const header = `<!-- living handoff, rewritten in place · last by chat ${sess?.sessionId ?? '?'} in ${sess?.workspaceLabel ?? '?'}${sess?.subfolder ? `/${sess.subfolder}` : ''}, ${stamp} -->\n`
  await $.fs.write(livingPath(t.id), header + md + '\n')
  const repos = await reposFor($, t).catch(() => [] as RepoState[])
  if (repos.length) t.repoState = repos
  pickupNote = ''
  if (a.lastAction) {
    t.lastAction = { text: clip(String(a.lastAction), 300), sessionId: sess?.sessionId ?? '', workspaceLabel: sess?.workspaceLabel ?? '', at: now() }
    lastActionSetThisTurn = true
  }
  await saveTask($, t)
  await rebuildContext($)
  return ok(`Living handoff saved: ${livingPath(t.id)}${repos.length ? `\nRepo state recorded:\n${repos.map(r => `- ${repoLine(r)}`).join('\n')}` : ''}\nResume: run /task ${t.id} in a new chat.`)
}

async function fileDecision($: any, a: any) {
  const cur = await requireTask($, a)
  if (typeof cur === 'string') return ok(cur)
  const anc = await ancestorsOf($, cur)
  const chain = [cur, ...anc]
  if (a.action === 'add' || !a.action) {
    const title = String(a.title ?? '').trim()
    if (!title) return ok('title is required.')
    const want = Number(a.level ?? levelOf(cur))
    const owner = chain.find(x => levelOf(x) <= want) ?? chain[chain.length - 1] ?? cur
    const d: Decision = {
      id: `D-${now().toString(36).toUpperCase()}`, title, description: String(a.description ?? ''), level: levelOf(owner),
      raisedFrom: owner.id === cur.id ? null : { id: cur.id, title: cur.title },
      refs: Array.isArray(a.refs) ? a.refs.map(String) : [], options: String(a.options ?? ''), verdict: '', status: 'open', at: now(), by: sess?.sessionId,
    }
    if (a.recommendation) {
      const max = Math.max(0, ...(await listTasks($)).flatMap(x => (x.decisions ?? []).map(y => Number(String(y.rec?.r ?? '').replace(/\D/g, '')) || 0)))
      d.rec = { r: a.r ? String(a.r) : `R${max + 1}`, area: String(a.area ?? ''), lldCheck: String(a.lldCheck ?? ''), register: a.register ? String(a.register) : null, implemented: null }
    }
    owner.decisions = [...(owner.decisions ?? []), d]
    await saveTask($, owner)
    await rebuildContext($)
    if (d.rec) return ok(`Recommendation ${d.rec.r} (${d.id}) recorded at Level ${d.level} on "${owner.title}"${d.rec.register ? ` — also add it to the ${d.rec.register} register as ${d.rec.r}` : ''}. Name ${d.rec.r} in your reply. It stays open until the person records the team's decision.`)
    return ok(`Decision ${d.id} filed at Level ${d.level} on "${owner.title}"${d.raisedFrom ? `, mapped to "${cur.title}" where it was raised` : ''}. It is open until the person records a verdict.`)
  }
  // decide / update / drop: find it on this task, its parents, or (by id) anywhere on the board
  const id = String(a.id ?? '')
  let owner: Task | undefined = chain.find(x => (x.decisions ?? []).some(d => d.id === id || d.rec?.r === id))
  if (!owner) owner = (await listTasks($)).find(x => (x.decisions ?? []).some(d => d.id === id || d.rec?.r === id))
  const d = owner?.decisions?.find(x => x.id === id || x.rec?.r === id)
  if (!owner || !d) return ok(`No decision "${id}".`)
  if (a.title) d.title = String(a.title)
  if (a.description) d.description = String(a.description)
  if (a.options) d.options = String(a.options)
  if (Array.isArray(a.refs)) d.refs = a.refs.map(String)
  if (a.action === 'implemented') {
    if (!d.rec) return ok('Only recommendations have a How implemented record.')
    d.rec.implemented = { problem: a.problem, approach: a.approach, api: a.api, code: a.code, tests: a.tests, at: now() }
  }
  if (a.action === 'decide') { d.status = 'decided'; d.verdict = String(a.verdict ?? ''); d.decidedAt = now() }
  if (a.action === 'drop') { d.status = 'dropped'; d.verdict = String(a.verdict ?? '') }
  if (a.action === 'reopen') d.status = 'open'
  await saveTask($, owner)
  await rebuildContext($)
  return ok(`Decision ${d.id} on "${owner.title}" is now ${d.status}.`)
}

async function saveMasterPlan($: any, a: any) {
  const t = await requireTask($, a)
  if (typeof t === 'string') return ok(t)
  const anc = await ancestorsOf($, t)
  const master = levelOf(t) === 1 ? t : anc[anc.length - 1] ?? t
  const md = String(a.markdown ?? '').trim()
  if (!md) return ok('markdown is empty: nothing saved.')
  await $.fs.write(masterPath(master.id), md + '\n')
  await saveTask($, master)
  await rebuildContext($)
  return ok(`Master plan saved for "${master.title}": ${masterPath(master.id)}. Break it down with board_create_task (modules, then tasks), each tied to a part of this plan.`)
}

async function mapDoc($: any, a: any) {
  const cur = await requireTask($, a)
  if (typeof cur === 'string') return ok(cur)
  if (a.action === 'remove') {
    for (const t of [cur, ...(await ancestorsOf($, cur))]) {
      if ((t.docs ?? []).some(d => d.id === a.id)) { t.docs = (t.docs ?? []).filter(d => d.id !== a.id); await saveTask($, t); await rebuildContext($); return ok(`Removed ${a.id} from "${t.title}".`) }
    }
    return ok(`No doc "${a.id}".`)
  }
  const ref = String(a.ref ?? '').trim()
  if (!ref) return ok('ref (a path or URL) is required.')
  const chain = [cur, ...(await ancestorsOf($, cur))]
  const want = Number(a.level ?? levelOf(cur))
  const owner = chain.find(x => levelOf(x) <= want) ?? chain[chain.length - 1] ?? cur
  const title = String(a.title ?? '').trim() || ref.split(/[\\/]/).pop() || ref
  const d = { id: `doc-${now().toString(36)}`, kind: String(a.kind ?? 'Reference'), title, ref, note: String(a.note ?? ''), at: now(), by: sess?.sessionId }
  owner.docs = [...(owner.docs ?? []), d]
  await saveTask($, owner)
  await rebuildContext($)
  return ok(`Mapped [${d.kind}] ${title} to ${LEVEL_NAME[levelOf(owner)]} "${owner.title}" (${d.id}).`)
}

const LINK_FLIP: Record<string, ['blocked_by' | 'found_during', boolean]> = { blocks: ['blocked_by', true], led_to: ['found_during', true] }
async function linkTasks($: any, a: any) {
  const cur = await requireTask($, a)
  if (typeof cur === 'string') return ok(cur)
  const other = await loadTask($, slug(String(a.to ?? '')))
  if (!other) return ok(`No task "${a.to}". Use board_find to look it up.`)
  let type = String(a.type ?? 'related')
  let from = cur, to = other
  const flip = LINK_FLIP[type]
  if (flip) { type = flip[0]; from = other; to = cur }
  if (!['blocked_by', 'found_during', 'related', 'fixes'].includes(type)) return ok('type must be blocked_by, blocks, found_during, led_to, related or fixes.')
  if (from.id === to.id) return ok('A task cannot link to itself.')
  from.links = (from.links ?? []).filter(l => !(l.to === to.id && l.type === type))
  if (a.action !== 'remove') from.links.push({ to: to.id, type: type as any, note: String(a.note ?? ''), at: now(), by: sess?.sessionId })
  await saveTask($, from)
  await rebuildContext($)
  return ok(a.action === 'remove' ? `Removed the link.` : `Linked: "${from.title}" ${type.replace('_', ' ')} "${to.title}".`)
}

async function moveTask($: any, a: any) {
  const t = await requireTask($, a)
  if (typeof t === 'string') return ok(t)
  const all = await listTasks($)
  const parent = a.parentId ? all.find(x => x.id === slug(String(a.parentId))) : null
  if (a.parentId && !parent) return ok(`No task "${a.parentId}".`)
  const kids = (id: string) => all.filter(x => x.parentId === id)
  const desc = (id: string): Task[] => kids(id).flatMap(k => [k, ...desc(k.id)])
  if (parent && (parent.id === t.id || desc(t.id).some(d => d.id === parent.id))) return ok('Cannot move a task under itself.')
  const height = (id: string): number => 1 + Math.max(0, ...kids(id).map(k => height(k.id)))
  const newLevel = parent ? levelOf(parent) + 1 : 1
  if (newLevel + height(t.id) - 1 > 3) return ok('That would go deeper than 3 levels.')
  const delta = newLevel - levelOf(t)
  const old = t.parentId ? all.find(x => x.id === t.parentId) : null
  if (old && old.id !== parent?.id) t.origin = [...(t.origin ?? []), { id: old.id, title: old.title }]
  t.parentId = parent?.id ?? null
  for (const x of [t, ...desc(t.id)]) {
    const target = x.id === t.id ? t : x
    target.level = Math.min(3, Math.max(1, levelOf(target) + delta)) as 1 | 2 | 3
    if (target.level === 1 && !target.kind) target.kind = 'feature'
    await saveTask($, target)
  }
  await rebuildContext($)
  return ok(`Moved "${t.title}" to ${parent ? `"${parent.title}" (now Level ${t.level})` : 'the top level (master task)'}.`)
}

async function findTasks($: any, a: any) {
  await ready.catch(() => {})
  if (!board) return ok(await unassignedHelp($))
  const q = String(a.query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
  const svc = a.service ? String(a.service).toLowerCase() : ''
  const all = await listTasks($)
  const byId = new Map(all.map(x => [x.id, x]))
  const pathOf = (x: Task) => { const p: string[] = []; let c: Task | undefined = x; for (let i = 0; i < 3 && c; i++) { p.unshift(c.title); c = c.parentId ? byId.get(c.parentId) : undefined } return p.join(' › ') }
  const hits = all.filter(x => (a.includeDone || x.status !== 'done')
    && (!svc || (x.services ?? []).includes(svc) || x.mainService === svc)
    && q.every(w => `${x.title} ${x.description} ${x.id}`.toLowerCase().includes(w)))
  if (!hits.length) return ok('No matching tasks.')
  return ok(hits.slice(0, 25).map(x => `- ${x.id} [L${levelOf(x)}${levelOf(x) === 1 ? ` ${x.kind ?? 'feature'}` : ''}, ${x.status}] ${pathOf(x)}${x.services?.length ? ` · services: ${x.services.join(', ')}` : ''}`).join('\n'))
}

async function releaseOwnership($: any, a: any) {
  const t = await requireTask($, a)
  if (typeof t === 'string') return ok(t)
  const holder = await ownerHolder($, t)
  if (!holder?.owner) return ok('Nobody owns this module or master task.')
  if (!sameRoot(holder.owner.root, sess?.workspace)) return ok(`Only workspace ${holder.owner.label} (the owner) can release "${holder.title}".`)
  if (a.action === 'reclaim') {
    holder.owner = { ...holder.owner, state: 'owned' }
    delete holder.owner.softAt
    ownerHistory(holder, 'reclaim', { to: holder.owner.label })
    await saveTask($, holder); await rebuildContext($)
    return ok(`"${holder.title}" is owned by ${holder.owner.label} again.`)
  }
  if (a.action === 'free') {
    ownerHistory(holder, 'release', { from: holder.owner.label })
    holder.owner = null
    await saveTask($, holder); await rebuildContext($)
    return ok(`Released "${holder.title}": the next workspace to link claims it.`)
  }
  // soft: only when everything is pushed, clean and checkpointed after the last commit
  const repos = await reposFor($, holder)
  const problems: string[] = []
  if (!repos.length) problems.push('no repos found — tag the services it touches first')
  for (const r of repos) {
    if (!r.upstream) problems.push(`${r.name}: branch ${r.branch} has no upstream — push it`)
    else if (r.ahead) problems.push(`${r.name}: ${r.ahead} commit(s) on ${r.branch} not pushed`)
    if (r.dirty) problems.push(`${r.name}: ${r.dirty} uncommitted change(s)`)
  }
  const all = await listTasks($)
  const desc = (id: string): Task[] => all.filter(x => x.parentId === id).flatMap(k => [k, ...desc(k.id)])
  let handoffAt = 0
  for (const x of [holder, ...desc(holder.id)]) { try { handoffAt = Math.max(handoffAt, (await $.fs.stat(livingPath(x.id))).mtimeMs) } catch {} }
  const lastCommit = Math.max(0, ...repos.map(r => r.lastCommitAt))
  if (repos.length && handoffAt < lastCommit) problems.push('the living handoff is older than the last commit — checkpoint first')
  if (problems.length) return ok(`Not ready for a soft release:\n${problems.map(x => `- ${x}`).join('\n')}`)
  holder.owner = { ...holder.owner, state: 'soft', softAt: now(), pickup: repos }
  ownerHistory(holder, 'soft-release', { from: holder.owner.label })
  await saveTask($, holder); await rebuildContext($)
  return ok(`Soft-released "${holder.title}". Another workspace can take over from:\n${repos.map(r => `- ${repoLine(r)}`).join('\n')}\nThis chat should stop working on it unless it reclaims it (board_release reclaim).`)
}

// /board open: start the board server shipped inside this plugin (if it isn't running) and open
// this board in its own window. No setup on the person's machine beyond Node.
const BOARD_PORT = 4317
async function openBoard($: any): Promise<string> {
  const server = `${norm($.plugin.root)}/app/server.js`
  if (!(await $.fs.exists(server).catch(() => false))) return `The board app isn't in this plugin (${server}).`
  const url = `http://localhost:${BOARD_PORT}/${board ? `?project=${encodeURIComponent(board.id)}` : ''}`
  const win = (await $.env.get('OS')) === 'Windows_NT'
  const ps = (cmd: string) => $.process.run(['powershell', '-NoProfile', '-NonInteractive', '-Command', cmd], { timeoutMs: 15000 })
  try {
    if (win) {
      const quoted = server.replace(/\//g, '\\').replace(/'/g, "''")
      await ps(`Start-Process -FilePath node -ArgumentList '"${quoted}"' -WindowStyle Hidden`)
      await $.clock.sleep(900)
      const edge = await ps(`try { Start-Process msedge -ArgumentList '--app=${url}' -ErrorAction Stop; 'edge' } catch { Start-Process '${url}'; 'browser' }`)
      return `Board opened${String(edge.stdout).includes('edge') ? ' in its own window' : ' in your browser'}: ${url}`
    }
    await $.process.run(['sh', '-c', `nohup node "${server}" >/dev/null 2>&1 &`], { timeoutMs: 10000 })
    await $.clock.sleep(900)
    await $.process.run([(await $.env.get('OSTYPE'))?.includes('darwin') ? 'open' : 'xdg-open', url], { timeoutMs: 10000 }).catch(() => null)
    return `Board opened: ${url}`
  } catch (err) {
    return `Couldn't start the board (${String(err)}). Is Node.js installed? You can start it by hand: node "${server}"`
  }
}

async function readTask($: any, a: any) {
  const t = await requireTask($, a)
  if (typeof t === 'string') return ok(t)
  let text = await describeTask($, t, true)
  if (a.step) {
    const h = await readText($, `${taskDir(t.id)}/handoffs/${String(a.step).replace(/[^A-Za-z0-9._-]/g, '')}.md`)
    text += `\n\n### Handoff ${a.step}\n${h || '(none)'}`
  }
  return ok(text)
}

const SCHEMA = {
  setup: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['create', 'attach'], description: 'create a new board, or attach this workspace to an existing one.' },
      name: { type: 'string', description: 'create: the board name the person chose. attach: the board name.' },
      boardId: { type: 'string', description: 'attach: the board id.' },
      root: { type: 'string', description: 'The workspace root folder; defaults to the suggested root. Must contain this chat\'s folder.' },
      label: { type: 'string', description: 'Short label for this workspace copy (defaults to the root folder name).' },
    },
    required: ['action'],
  },
  create: {
    type: 'object',
    properties: {
      title: { type: 'string' },
      parentId: { type: 'string', description: 'Parent task id. Omit for a Level 1 master task; a master task\'s child is a Level 2 module, a module\'s child a Level 3 task.' },
      description: { type: 'string', description: 'One-line purpose.' },
      plan: { type: 'string', description: 'Optional plan stub ("## Phase A — name" / "- [ ] A1 name").' },
      fromStep: { type: 'string', description: 'Parent plan step id this subtask takes over (marks it in the parent plan).' },
      kind: { type: 'string', enum: ['feature', 'backlog'], description: 'Level 1 only: a feature, or a service backlog for one service\'s own bugs and gaps.' },
      bug: { type: 'boolean', description: 'This task fixes a bug found after the work was done.' },
      fixes: { type: 'string', description: 'With bug: the id of the finished task the bug is in (adds a "fixes" link).' },
      services: { type: 'array', items: { type: 'string' }, description: 'Service ids it touches (from the board\'s service list).' },
      mainService: { type: 'string', description: 'Level 1 only: the main service (for a backlog, the service it belongs to).' },
    },
    required: ['title'],
  },
  decision: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'decide', 'update', 'drop', 'reopen', 'implemented'] },
      id: { type: 'string', description: 'Decision id (D-…) or R# for decide/update/drop/reopen/implemented.' },
      title: { type: 'string', description: 'add: the question to decide.' },
      description: { type: 'string', description: 'Context: what is being decided and why it matters.' },
      level: { type: 'number', enum: [1, 2, 3], description: 'add: the level it belongs to (1 master task, 2 module, 3 task) — the narrowest task it affects. Filed on that ancestor of the linked task and mapped back to it.' },
      options: { type: 'string', description: 'Options considered and any recommendation (marked as a recommendation).' },
      refs: { type: 'array', items: { type: 'string' }, description: 'Handoff/doc paths or URLs that hold the detail.' },
      verdict: { type: 'string', description: 'decide/drop: what the person/team decided (or why dropped).' },
      recommendation: { type: 'boolean', description: 'add: this is a recommendation for the register (gets an R#).' },
      area: { type: 'string', description: 'Recommendation: the area it concerns.' },
      lldCheck: { type: 'string', description: 'Recommendation: what the LLD/spec says about it.' },
      register: { type: 'string', description: 'Recommendation: the topic of an existing register it is also written to.' },
      r: { type: 'string', description: 'Recommendation: the R# used in that existing register, so both match.' },
      problem: { type: 'string' }, approach: { type: 'string' }, api: { type: 'string', description: 'New API: method, path, purpose, responses.' },
      code: { type: 'string', description: 'Repo, branch, commit, classes.' }, tests: { type: 'string' },
      taskId: { type: 'string', description: 'Defaults to the linked task.' },
    },
    required: ['action'],
  },
  masterPlan: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Any task in the tree; the master plan belongs to its Level 1 master task.' },
      markdown: { type: 'string', description: 'The WHOLE master implementation plan (replaces the previous one): goal, scope, architecture, modules and their tasks, sequencing, risks.' },
    },
    required: ['markdown'],
  },
  doc: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'remove'] },
      kind: { type: 'string', enum: ['Tech spec', 'HLD', 'LLD', 'API spec', 'Design', 'Runbook', 'Reference', 'Other'] },
      title: { type: 'string' },
      ref: { type: 'string', description: 'Absolute file path or URL.' },
      note: { type: 'string', description: 'One line: what it covers / when to read it.' },
      level: { type: 'number', enum: [1, 2, 3], description: 'The level it covers (defaults to the linked task\'s level).' },
      id: { type: 'string', description: 'remove: the doc id.' },
      taskId: { type: 'string', description: 'Defaults to the linked task.' },
    },
    required: ['action'],
  },
  linkTask: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['add', 'remove'] },
      to: { type: 'string', description: 'The other task\'s id.' },
      type: { type: 'string', enum: ['blocked_by', 'blocks', 'found_during', 'led_to', 'related', 'fixes'], description: 'From this task\'s side: it is blocked_by / blocks / was found_during / led_to / is related to the other.' },
      note: { type: 'string' },
      taskId: { type: 'string', description: 'Defaults to the linked task.' },
    },
    required: ['to', 'type'],
  },
  move: {
    type: 'object',
    properties: { taskId: { type: 'string' }, parentId: { type: 'string', description: 'New parent id; omit or empty to make it a master task.' } },
  },
  find: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Words to match in title/description.' }, service: { type: 'string', description: 'Only tasks tagged with this service id.' }, includeDone: { type: 'boolean' } },
  },
  release: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['soft', 'reclaim', 'free'], description: 'soft: ready for another workspace to pick up (must be pushed, clean, checkpointed); reclaim: undo a soft release; free: drop ownership.' },
      taskId: { type: 'string', description: 'Defaults to the linked task (its module or master task is released).' },
    },
    required: ['action'],
  },
  promote: { type: 'object', properties: { taskId: { type: 'string', description: 'Defaults to the linked task.' } } },
  checkpoint: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Defaults to the linked task.' },
      markdown: { type: 'string', description: 'The WHOLE living handoff (it replaces the previous one). Objective, Workspace, Repository, Branch / HEAD, Working changes, Verified results, Not verified, Decisions and constraints, Next step, Relevant references, Resume. No secrets.' },
      lastAction: { type: 'string', description: 'Optional one-line summary for the board note.' },
    },
    required: ['markdown'],
  },
  link: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Id (or exact title) of an existing task to link to.' },
      newTaskTitle: { type: 'string', description: 'Create a new task with this title and link to it.' },
      description: { type: 'string', description: 'What the task is for (new tasks).' },
      decline: { type: 'boolean', description: 'The person said not to link this chat.' },
      override: { type: 'string', enum: ['once', 'takeover'], description: 'Only after the person agreed, when the module is owned by another workspace: work here once, or move ownership here.' },
      personSaid: { type: 'string', description: 'With override: the person\'s own words approving it (required).' },
    },
  },
  update: {
    type: 'object',
    properties: {
      taskId: { type: 'string', description: 'Defaults to the linked task.' },
      lastAction: { type: 'string', description: 'One plain line: what was just done.' },
      description: { type: 'string' },
      title: { type: 'string' },
      status: { type: 'string', enum: ['active', 'paused', 'done'] },
      add: {
        type: 'array',
        items: {
          type: 'object',
          properties: { kind: { type: 'string', enum: ['decision', 'todo', 'mandatory'] }, text: { type: 'string' } },
          required: ['kind', 'text'],
        },
      },
      resolve: { type: 'array', items: { type: 'string' }, description: 'Item ids now settled/done.' },
      services: { type: 'array', items: { type: 'string' }, description: 'Replace the task\'s service tags.' },
      mainService: { type: 'string' },
      kind: { type: 'string', enum: ['feature', 'backlog'] },
    },
  },
  plan: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      markdown: { type: 'string', description: 'The WHOLE plan. "## Phase A — name" headings, "- [ ] A1 name" steps, "- [x]" when done.' },
    },
    required: ['markdown'],
  },
  handoff: {
    type: 'object',
    properties: {
      taskId: { type: 'string' },
      step: { type: 'string', description: 'Plan step id, e.g. A1.' },
      markdown: { type: 'string', description: 'What was done, files touched, decisions, what is left, how to test.' },
      lastAction: { type: 'string', description: 'Optional one-line summary for the board note.' },
      markStepDone: { type: 'boolean', description: 'Tick the step in plan.md (default true).' },
    },
    required: ['step', 'markdown'],
  },
  read: {
    type: 'object',
    properties: { taskId: { type: 'string' }, step: { type: 'string', description: 'Also return this step\'s handoff.' } },
  },
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    try {
      heartbeat?.cancel()
      ready = init($, e.cwd)
      await ready
      if (!ignored) {
        await $.command.register({ name: 'task', description: 'Board: /task lists tasks · /task <name> links (creates if new) · /task off unlinks', argumentHint: '[task name | off]' } as any)
        await $.command.register({ name: 'board', description: 'Board: /board · /board new <name> · /board add <board> · /board list · /board mode on|off · /board release [soft|reclaim|free] · /board open', argumentHint: '[new | add | list | mode | release | open]' } as any)
        await $.tool.register({ name: 'board_setup', description: 'Create a board for this chat\'s workspace, or add this workspace to an existing board. Only after the person answered which.', inputSchema: SCHEMA.setup })
        await $.tool.register({ name: 'board_link', description: 'Link this chat to a task on its board (or create one, or record that the person declined). Returns the task\'s plan and latest handoff.', inputSchema: SCHEMA.link })
        await $.tool.register({ name: 'board_update', description: 'Update the linked board task: last action line, description, title, status, and add/resolve decisions, todos and must-dos.', inputSchema: SCHEMA.update })
        await $.tool.register({ name: 'board_plan', description: 'Save the whole plan (markdown) for the board task.', inputSchema: SCHEMA.plan })
        await $.tool.register({ name: 'board_handoff', description: 'Write the handoff note for a finished plan step and tick it in the plan.', inputSchema: SCHEMA.handoff })
        await $.tool.register({ name: 'board_create_task', description: 'Create a task on the board: a Level 1 master task, a Level 2 module under it, or a Level 3 task under a module. Use it to delegate parts of a plan to later chats.', inputSchema: SCHEMA.create })
        await $.tool.register({ name: 'board_decision', description: 'Record or settle a decision on the board, filed at the level it affects (1 master task, 2 module, 3 task) and mapped to the task where it came up.', inputSchema: SCHEMA.decision })
        await $.tool.register({ name: 'board_master_plan', description: 'Write or replace the master implementation plan of the linked task\'s master task (what its modules and tasks are broken down from).', inputSchema: SCHEMA.masterPlan })
        await $.tool.register({ name: 'board_doc', description: 'Map a document (tech spec, HLD, LLD, API spec, design, runbook, reference) to a board task by path or URL, or remove one.', inputSchema: SCHEMA.doc })
        await $.tool.register({ name: 'board_release', description: 'Soft-release, reclaim or drop this workspace\'s ownership of the linked task\'s module or master task.', inputSchema: SCHEMA.release })
        await $.tool.register({ name: 'board_link_task', description: 'Link this task to another (blocked_by, blocks, found_during, led_to, related), e.g. when out-of-scope work is split off.', inputSchema: SCHEMA.linkTask })
        await $.tool.register({ name: 'board_move', description: 'Move a task (with its subtasks) under another parent, e.g. from a feature into a service backlog.', inputSchema: SCHEMA.move })
        await $.tool.register({ name: 'board_find', description: 'Find tasks on the board by words and/or service — check for an existing task before creating one.', inputSchema: SCHEMA.find })
        await $.tool.register({ name: 'board_promote', description: 'Promote a task one level up (task → module → master task) when it is bigger than expected; its subtree moves with it.', inputSchema: SCHEMA.promote })
        await $.tool.register({ name: 'board_checkpoint', description: 'Rewrite the task\'s living handoff in place (the file new chats resume from).', inputSchema: SCHEMA.checkpoint })
        await $.tool.register({ name: 'board_read', description: 'Read a board task: purpose, open items, plan, latest handoff, or a given step\'s handoff.', inputSchema: SCHEMA.read })
        heartbeat = $.clock.every(HEARTBEAT_MS, async () => {
          if (sess && sess.status !== 'ended') await saveSess($, {})
        })
      }
    } catch (err) {
      $.ui.log(`project-board: setup failed: ${String(err)}`)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && sess && !ignored) {
      lastActionSetThisTurn = false
      const text = e.text.trim()
      sess.branch = await branchOf($, sess.cwd)
      if (!board) await resolve($).catch(() => {}) // a board may have been created meanwhile
      // App/system notices (<task-notification>, <side-sessions-event>, …) aren't the person's words.
      const isNotice = /^<[a-z][\w-]*[\s>]/i.test(text)
      if (!isNotice && text) reported = true
      await saveSess($, isNotice
        ? { status: 'working', turnStartedAt: now(), title: /^</.test(sess.title) ? '' : sess.title }
        : { status: 'working', turnStartedAt: now(), lastPrompt: clip(text, 500), title: (!/^</.test(sess.title) && sess.title) || clip(text.split('\n')[0] ?? '', 90) },
      ).catch(() => {})
      await rebuildContext($).catch(() => {})
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && sess && !ignored) {
      const summary = clip(firstPara(e.answer ?? ''), 300)
      await saveSess($, { status: 'idle', lastAnswer: clip(e.answer ?? '', 800) }).catch(() => {})
      if (board && sess.taskId && !lastActionSetThisTurn && summary) {
        const t = await loadTask($, sess.taskId)
        if (t) {
          t.lastAction = { text: summary, sessionId: sess.sessionId, workspaceLabel: sess.workspaceLabel, at: now() }
          await saveTask($, t).catch(() => {})
        }
      }
    }
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    heartbeat?.cancel()
    await saveSess($, { status: 'ended', resumeId: e.resume?.id }).catch(() => {})
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    if (!boardContext) return r
    return { ...r, sections: [...r.sections, { id: 'project-board:context', text: boardContext, scope: 'session' as const }] }
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    await ready.catch(() => {})
    if (!sess || ignored) return { text: 'The board is not available in this folder.' }
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const reg = await loadRegistry($)
    if (verb === 'open') return { text: await openBoard($) }
    if (verb === 'release') {
      const r = await releaseOwnership($, { action: arg === 'reclaim' ? 'reclaim' : arg === 'free' ? 'free' : 'soft' })
      return { text: r.text }
    }
    if (verb === 'mode') {
      const v = arg.toLowerCase()
      if (v === 'off' || v === 'on') { await saveSess($, { boardModeOff: v === 'off' }); await rebuildContext($) }
      return { text: `Board Mode for this chat: ${boardModeOn() ? 'on' : 'off'}${board?.boardMode ? '' : ' (it is off for this whole board; turn it on in the board\'s ⚙ settings)'}.` }
    }
    if (verb === 'list') {
      return { text: reg.boards.map(b => `${b.name}: ${b.roots.map(r => `${r.label} (${r.path})`).join(', ')}`).join('\n') || 'No boards yet.' }
    }
    if (verb === 'new' || verb === 'add') {
      if (!arg) return { text: verb === 'new' ? `Usage: /board new <name>   (root: ${sess.suggestedRoot ?? sess.cwd})` : 'Usage: /board add <board name>' }
      const r = await setupBoard($, verb === 'new' ? { action: 'create', name: arg } : { action: 'attach', name: arg })
      return { text: r.text }
    }
    if (board) {
      return { text: `Board: ${board.name} · workspace ${sess.workspaceLabel} (${sess.workspace})${sess.subfolder ? ` · folder ${sess.subfolder}` : ''}${sess.taskId ? ` · task ${sess.taskId}` : ''}\nWorkspaces: ${board.roots.map(r => r.label).join(', ')}` }
    }
    return {
      text: `This folder isn't on a board yet.\nSuggested: /board new ${sess.suggestedName}   (root ${sess.suggestedRoot})${reg.boards.length ? `\nOr add it to: ${reg.boards.map(b => `/board add ${b.name}`).join(' · ')}` : ''}`,
    }
  })

  on('command.run', { command: 'task' }, async ($, e) => {
    await ready.catch(() => {})
    const arg = e.args.trim()
    if (!sess || ignored) return { text: 'The board is not available in this folder.' }
    if (!board) {
      return {
        text: `This folder isn't on a board yet, so the task can't be saved.\nCreate one: /board new ${sess.suggestedName}   (root ${sess.suggestedRoot}) — or add it to an existing board with /board add <name>.`,
        context: [`The person tried /task ${arg} but this folder has no board. ${await unassignedHelp($)} After board_setup, create/link the task "${arg}" with board_link.`],
      }
    }
    if (!arg) {
      const tasks = await listTasks($)
      const cur = sess.taskId ? `Linked to: ${sess.taskId}\n` : 'Not linked.\n'
      const lines = tasks.map(t => `${t.id === sess!.taskId ? '▸' : ' '} ${t.id} — ${t.title} [${t.status}]`)
      return { text: `${cur}${lines.join('\n') || 'No tasks yet. /task <name> creates one.'}` }
    }
    if (arg === 'off') {
      await saveSess($, { taskId: null, linkDeclined: true })
      await rebuildContext($)
      return { text: 'This chat is no longer linked to a task.' }
    }
    const override = /--takeover\b/.test(arg) ? 'takeover' : /--override\b/.test(arg) ? 'once' : undefined
    const name = arg.replace(/--(takeover|override)\b/g, '').trim()
    const exists = (await loadTask($, slug(name))) || (await listTasks($)).find(t => t.title.toLowerCase() === name.toLowerCase())
    const r = await linkTask($, exists ? { taskId: exists.id, override, personSaid: override ? `typed /task --${override === 'once' ? 'override' : 'takeover'}` : undefined } : { newTaskTitle: name })
    if (r.text.startsWith('BLOCKED')) return { text: `${r.text.split('. Ask them')[0]}.\nRun /task ${name} --override to work here once, or /task ${name} --takeover to move it to this workspace.` }
    return { text: exists ? `Linked to task "${exists.title}".` : `Created task "${arg}" on ${board.name} and linked this chat.`, context: [r.text] }
  })

  on('tool.call', { tool: 'mcp__project-board__board_setup' } as any, async ($: any, e: any) => {
    try {
      return await setupBoard($, e)
    } catch (err) {
      return { isError: true as const, result: `board_setup failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_link' } as any, async ($: any, e: any) => {
    try {
      return await linkTask($, e)
    } catch (err) {
      return { isError: true as const, result: `board_link failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_update' } as any, async ($: any, e: any) => {
    try {
      return await updateTask($, e)
    } catch (err) {
      return { isError: true as const, result: `board_update failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_plan' } as any, async ($: any, e: any) => {
    try {
      return await savePlan($, e)
    } catch (err) {
      return { isError: true as const, result: `board_plan failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_handoff' } as any, async ($: any, e: any) => {
    try {
      return await writeHandoff($, e)
    } catch (err) {
      return { isError: true as const, result: `board_handoff failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_create_task' } as any, async ($: any, e: any) => {
    try {
      return await createTask($, e)
    } catch (err) {
      return { isError: true as const, result: `board_create_task failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_decision' } as any, async ($: any, e: any) => {
    try {
      return await fileDecision($, e)
    } catch (err) {
      return { isError: true as const, result: `board_decision failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_master_plan' } as any, async ($: any, e: any) => {
    try {
      return await saveMasterPlan($, e)
    } catch (err) {
      return { isError: true as const, result: `board_master_plan failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_doc' } as any, async ($: any, e: any) => {
    try {
      return await mapDoc($, e)
    } catch (err) {
      return { isError: true as const, result: `board_doc failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_release' } as any, async ($: any, e: any) => {
    try {
      return await releaseOwnership($, e)
    } catch (err) {
      return { isError: true as const, result: `board_release failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_link_task' } as any, async ($: any, e: any) => {
    try {
      return await linkTasks($, e)
    } catch (err) {
      return { isError: true as const, result: `board_link_task failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_move' } as any, async ($: any, e: any) => {
    try {
      return await moveTask($, e)
    } catch (err) {
      return { isError: true as const, result: `board_move failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_find' } as any, async ($: any, e: any) => {
    try {
      return await findTasks($, e)
    } catch (err) {
      return { isError: true as const, result: `board_find failed: ${String(err)}` }
    }
  })
  // Auto-tag the linked task with the services whose files this chat edits, and flag the first
  // edit in a service outside the task's services so the out-of-scope protocol kicks in.
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => {
    const ran = await next(e)
    return tagService($, (e as any).file_path, ran)
  })
  on('tool.call', { tool: 'Write' }, async ($, e, next) => {
    const ran = await next(e)
    return tagService($, (e as any).file_path, ran)
  })
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => {
    const ran = await next(e)
    return tagService($, (e as any).notebook_path, ran)
  })
  on('tool.call', { tool: 'mcp__project-board__board_promote' } as any, async ($: any, e: any) => {
    try {
      return await promoteTask($, e)
    } catch (err) {
      return { isError: true as const, result: `board_promote failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_checkpoint' } as any, async ($: any, e: any) => {
    try {
      return await checkpoint($, e)
    } catch (err) {
      return { isError: true as const, result: `board_checkpoint failed: ${String(err)}` }
    }
  })
  on('tool.call', { tool: 'mcp__project-board__board_read' } as any, async ($: any, e: any) => {
    try {
      return await readTask($, e)
    } catch (err) {
      return { isError: true as const, result: `board_read failed: ${String(err)}` }
    }
  })
}

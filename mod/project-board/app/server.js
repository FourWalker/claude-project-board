// Claude Project Board — local server. No dependencies: `node server.js`.
// Serves the board UI and a small JSON API over %USERPROFILE%\.claude-board.
'use strict'
const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const { spawn, execFileSync } = require('child_process')

const PORT = Number(process.env.BOARD_PORT || 4317)
const ROOT = process.env.BOARD_ROOT || path.join(os.homedir(), '.claude-board')
const PROJECTS = path.join(ROOT, 'projects')
const PUBLIC = path.join(__dirname, 'public')
const SETTINGS = path.join(ROOT, 'board-settings.json')
const OFFLINE_MS = 2.5 * 60 * 1000

const DEFAULT_SETTINGS = {
  // {id} = the chat's session id. The Claude app handles claude:// links.
  jumpUrl: 'claude://code/continue?session={id}',
  openWorkspaceInVSCode: false,
  // VS Code chats: 'sidebar' (needs the Project Board Bridge extension) or 'tab'.
  vscodeOpenIn: 'sidebar',
}

// ---------- helpers ----------
const readJson = (p, fb = null) => {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')) } catch { return fb }
}
const readText = p => { try { return fs.readFileSync(p, 'utf8') } catch { return '' } }
const writeJson = (p, v) => {
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const tmp = p + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2))
  fs.renameSync(tmp, p)
}
const listDir = p => { try { return fs.readdirSync(p, { withFileTypes: true }) } catch { return [] } }
const safe = s => String(s || '').replace(/[^A-Za-z0-9._-]/g, '')
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'task'
const settings = () => ({ ...DEFAULT_SETTINGS, ...readJson(SETTINGS, {}) })

const STEP = /^(\s*[-*]\s+\[)([ xX])(\]\s+)([A-Za-z]*\d+[A-Za-z0-9.]*|[A-Z][A-Za-z0-9.]*)[:.)]?\s*(.*)$/
function parsePlan(md) {
  const phases = []
  let cur = null
  for (const line of md.split(/\r?\n/)) {
    const h = /^#{2,3}\s+(.*)$/.exec(line)
    if (h) { cur = { title: h[1].trim(), steps: [] }; phases.push(cur); continue }
    const m = STEP.exec(line)
    if (m) {
      if (!cur) { cur = { title: 'Plan', steps: [] }; phases.push(cur) }
      const child = /→\s*\(task ([A-Za-z0-9-]+)\)/.exec(m[5])
      cur.steps.push({ id: m[4], text: m[5].replace(/\s*→\s*\(task [A-Za-z0-9-]+\)/, ''), done: m[2] !== ' ', childId: child ? child[1] : null })
    }
  }
  const all = phases.flatMap(p => p.steps)
  const next = all.find(s => !s.done) || null
  return { phases, next, done: all.filter(s => s.done).length, total: all.length }
}

// The desktop app keeps one record per chat (claude-code-sessions\…\local_*.json) pairing its own
// id (local_…) with the engine's (cliSessionId). Only those ids and the title are read, cached 20s.
let appIndex = { at: 0, map: new Map() }
function appSessions() {
  if (Date.now() - appIndex.at < 20000) return appIndex.map
  const map = new Map()
  const dataRoot = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Claude-Data')
  const walk = (dir, depth) => {
    for (const d of listDir(dir)) {
      const p = path.join(dir, d.name)
      if (d.isDirectory() && depth > 0) walk(p, depth - 1)
      else if (d.isFile() && /^local_[A-Za-z0-9-]+\.json$/.test(d.name)) {
        const j = readJson(p)
        if (j && j.cliSessionId) map.set(j.cliSessionId, { hostSessionId: j.sessionId, appTitle: j.title || '', isArchived: !!j.isArchived })
        if (j && j.lastAssistantCliSessionId && !map.has(j.lastAssistantCliSessionId))
          map.set(j.lastAssistantCliSessionId, { hostSessionId: j.sessionId, appTitle: j.title || '', isArchived: !!j.isArchived })
      }
    }
  }
  for (const inst of listDir(dataRoot)) if (inst.isDirectory()) walk(path.join(dataRoot, inst.name, 'claude-code-sessions'), 2)
  appIndex = { at: Date.now(), map }
  return map
}

function sessionsOf(projectId) {
  const dir = path.join(PROJECTS, safe(projectId), 'sessions')
  const now = Date.now()
  return listDir(dir)
    .filter(d => d.isFile() && d.name.endsWith('.json'))
    .map(d => readJson(path.join(dir, d.name)))
    .filter(Boolean)
    .filter(s => !s.supersededBy)
    .filter(s => s.taskId || s.lastPrompt || s.title) // helper runs that never took a prompt
    .map(s => ({ ...appSessions().get(s.sessionId), ...s }))
    .map(s => ({ ...s, workspace: upperDrive(s.workspace || '') }))
    .map(s => ({
      ...s,
      title: s.appTitle || s.title,
      live: s.status === 'ended' ? 'ended' : now - (s.heartbeatAt || 0) > OFFLINE_MS ? 'offline' : s.status,
    }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
    // One desktop chat can leave several records (its engine id changes): keep the newest.
    .filter((s, i, all) => !s.hostSessionId || all.findIndex(o => o.hostSessionId === s.hostSessionId) === i)
}
const upperDrive = p => String(p).replace(/\\/g, '/').replace(/^([a-z]):/, (_, d) => d.toUpperCase() + ':')

function taskOf(projectId, taskId, sessions) {
  const dir = path.join(PROJECTS, safe(projectId), 'tasks', safe(taskId))
  const t = readJson(path.join(dir, 'task.json'))
  if (!t) return null
  const planMd = readText(path.join(dir, 'plan.md'))
  const handoffs = listDir(path.join(dir, 'handoffs'))
    .filter(d => d.isFile() && d.name.endsWith('.md'))
    .map(d => {
      const st = fs.statSync(path.join(dir, 'handoffs', d.name))
      return { step: d.name.replace(/\.md$/, ''), at: st.mtimeMs }
    })
    .sort((a, b) => b.at - a.at)
  const linked = sessions.filter(s => s.taskId === t.id)
  const superseded = new Set(listDir(path.join(PROJECTS, safe(projectId), 'sessions'))
    .map(d => readJson(path.join(PROJECTS, safe(projectId), 'sessions', d.name)))
    .filter(s => s && s.supersededBy).map(s => s.sessionId))
  // Sessions the task remembers but whose file is gone stay listed as ended.
  for (const ref of t.sessions || [])
    if (!superseded.has(ref.sessionId) && !linked.some(s => s.sessionId === ref.sessionId))
      linked.push({ sessionId: ref.sessionId, workspaceLabel: ref.workspaceLabel, live: 'ended', title: '(chat no longer reporting)' })
  const living = readText(path.join(dir, 'handoff.md'))
  const masterPlan = readText(path.join(dir, 'masterplan.md'))
  const docs = t.docs || []
  const lv = t.level === 2 || t.level === 3 ? t.level : 1
  const decisions = (t.decisions || []).map(d => ({ ...d, owner: t.id, ownerTitle: t.title, level: d.level || lv }))
  return { ...t, owner: t.owner || null, ownerHistory: t.ownerHistory || [], overrides: t.overrides || [], repoState: t.repoState || [], bug: !!t.bug, kind: lv === 1 ? (t.kind === 'backlog' ? 'backlog' : 'feature') : undefined, mainService: t.mainService || null, services: t.services || [], links: t.links || [], decisions, docs, masterPlan, masterPlanPath: path.join(dir, 'masterplan.md'), handoffPath: path.join(dir, 'handoff.md'), level: lv, parentId: t.parentId || null, origin: t.origin || [], planMd, plan: parsePlan(planMd), handoffs, living, linked, working: linked.filter(s => s.live === 'working').length }
}

// ---------- board registry (boards.json): each board lists its workspace roots ----------
const REGISTRY = path.join(ROOT, 'boards.json')
const loadRegistry = () => {
  const r = readJson(REGISTRY, null)
  return r && Array.isArray(r.boards) ? r : { version: 1, boards: [] }
}
const saveRegistry = r => writeJson(REGISTRY, r)
const boardById = (reg, id) => reg.boards.find(b => b.id === id)
const normPath = p => upperDrive(String(p || '').trim()).replace(/\/+$/, '')

function board(projectId) {
  const pdir = path.join(PROJECTS, safe(projectId))
  const b = boardById(loadRegistry(), projectId)
  const legacy = readJson(path.join(pdir, 'project.json'), null)
  const project = b
    ? { id: b.id, name: b.name, roots: b.roots, boardMode: !!b.boardMode, services: b.services || [], registers: b.registers || [], rules: b.rules || '', workspaces: Object.fromEntries(b.roots.map(r => [normPath(r.path), { label: r.label }])) }
    : { id: projectId, name: legacy?.name || projectId, roots: [], workspaces: {}, unregistered: true }
  const sessions = sessionsOf(projectId)
  const tasks = listDir(path.join(pdir, 'tasks'))
    .filter(d => d.isDirectory())
    .map(d => taskOf(projectId, d.name, sessions))
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  // Collision warning: more than one working chat in the same workspace.
  const byWs = {}
  for (const s of sessions) if (s.live === 'working') (byWs[s.workspace] = byWs[s.workspace] || []).push(s.sessionId)
  const collisions = Object.entries(byWs).filter(([, ids]) => ids.length > 1).map(([ws, ids]) => ({ workspace: ws, sessions: ids }))
  return { project, tasks, sessions, collisions, now: Date.now() }
}

function projects() {
  return loadRegistry().boards.map(b => {
    const tasks = listDir(path.join(PROJECTS, safe(b.id), 'tasks')).filter(x => x.isDirectory()).length
    const working = sessionsOf(b.id).filter(s => s.live === 'working').length
    return { id: b.id, name: b.name, tasks, working, workspaces: b.roots.length, roots: b.roots }
  })
}

// Chats in folders no board covers (the mod keeps them under unassigned/ until a board exists).
function unassigned() {
  const dir = path.join(ROOT, 'unassigned')
  const now = Date.now()
  return listDir(dir)
    .filter(d => d.isFile() && d.name.endsWith('.json'))
    .map(d => readJson(path.join(dir, d.name)))
    .filter(s => s && !s.movedTo && (s.lastPrompt || s.title) && now - (s.updatedAt || 0) < 14 * 86400000)
    .map(s => ({ ...s, live: s.status === 'ended' ? 'ended' : now - (s.heartbeatAt || 0) > OFFLINE_MS ? 'offline' : s.status }))
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

// ---------- mutations ----------
function taskPath(pid, tid) { return path.join(PROJECTS, safe(pid), 'tasks', safe(tid), 'task.json') }
function mutateTask(pid, tid, fn) {
  const p = taskPath(pid, tid)
  const t = readJson(p)
  if (!t) throw new Error('no such task')
  fn(t)
  t.updatedAt = Date.now()
  writeJson(p, t)
  return t
}

// ---------- git state of a module's repos (for checkpoints and soft release) ----------
function gitState(dir) {
  const g = (...a) => { try { return execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', timeout: 8000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return null } }
  const top = g('rev-parse', '--show-toplevel')
  if (!top) return null
  const upstream = g('rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}')
  let ahead = null, behind = null
  if (upstream) { const c = g('rev-list', '--left-right', '--count', `${upstream}...HEAD`); if (c) [behind, ahead] = c.split(/\s+/).map(Number) }
  return {
    repo: top.replace(/\\/g, '/'), name: path.basename(top), branch: g('rev-parse', '--abbrev-ref', 'HEAD'), head: g('rev-parse', '--short', 'HEAD'),
    upstream, ahead, behind, dirty: (g('status', '--porcelain') || '').split('\n').filter(Boolean).length,
    lastCommitAt: Number(g('log', '-1', '--format=%ct') || 0) * 1000, at: Date.now(),
  }
}
function allTasks(project) {
  return listDir(path.join(PROJECTS, safe(project), 'tasks')).filter(d => d.isDirectory()).map(d => readJson(taskPath(project, d.name))).filter(Boolean)
}
function subtreeOf(all, id) { const kids = all.filter(x => x.parentId === id); return kids.flatMap(k => [k, ...subtreeOf(all, k.id)]) }
// Repos a feature/module works in: its services' folders inside the given workspace root.
function reposFor(project, nodeId, root) {
  const b = boardById(loadRegistry(), project)
  const all = allTasks(project)
  const node = all.find(x => x.id === nodeId)
  if (!node) throw new Error('no such task')
  const tree = [node, ...subtreeOf(all, nodeId)]
  const ids = new Set(tree.flatMap(x => [...(x.services || []), ...(x.mainService ? [x.mainService] : [])]))
  const seen = new Map()
  for (const svc of (b && b.services) || []) if (ids.has(svc.id)) for (const m of svc.match) {
    const dir = path.join(root, m)
    if (!fs.existsSync(dir)) continue
    const st = gitState(dir)
    if (st && !seen.has(st.repo)) seen.set(st.repo, { ...st, service: svc.id })
  }
  return { repos: [...seen.values()], tree }
}
function releaseCheck(project, nodeId, root) {
  const { repos, tree } = reposFor(project, nodeId, root)
  const problems = []
  if (!repos.length) problems.push('no repos found for its services in this workspace — tag the services it touches first')
  for (const r of repos) {
    if (!r.upstream) problems.push(`${r.name}: branch ${r.branch} has no upstream — push it first`)
    else if (r.ahead > 0) problems.push(`${r.name}: ${r.ahead} commit(s) on ${r.branch} not pushed`)
    if (r.dirty > 0) problems.push(`${r.name}: ${r.dirty} uncommitted change(s)`)
  }
  const lastCommit = Math.max(0, ...repos.map(r => r.lastCommitAt))
  const handoffAt = Math.max(0, ...tree.map(x => { try { return fs.statSync(path.join(PROJECTS, safe(project), 'tasks', safe(x.id), 'handoff.md')).mtimeMs } catch { return 0 } }))
  if (repos.length && handoffAt < lastCommit) problems.push('the living handoff is older than the last commit — checkpoint first')
  return { ok: !problems.length, problems, pickup: repos }
}
const ownerNode = (project, task) => {
  const t = readJson(taskPath(project, task))
  if (!t) throw new Error('no such task')
  if ((t.level || 1) === 3) throw new Error('ownership is set on modules and master tasks')
  return t
}
const history = (t, type, extra) => { t.ownerHistory = [...(t.ownerHistory || []), { type, at: Date.now(), by: 'board', ...extra }].slice(-30) }

function checkRoot(p) {
  const n = normPath(p)
  if (!n || !path.isAbsolute(n.replace(/\//g, path.sep))) throw new Error('give a full folder path, e.g. D:\\nfx')
  if (!fs.existsSync(n) || !fs.statSync(n).isDirectory()) throw new Error(`folder not found: ${n}`)
  const reg = loadRegistry()
  for (const b of reg.boards) for (const r of b.roots)
    if (normPath(r.path).toLowerCase() === n.toLowerCase()) throw new Error(`${n} is already a workspace of ${b.name}`)
  return n
}

const actions = {
  createBoard({ name, root, label }) {
    name = String(name || '').trim()
    if (!name) throw new Error('board name is required')
    const reg = loadRegistry()
    if (reg.boards.some(b => b.name.toLowerCase() === name.toLowerCase())) throw new Error(`a board named ${name} already exists`)
    const rp = checkRoot(root)
    let id = slug(name)
    for (let n = 2; boardById(reg, id) || fs.existsSync(path.join(PROJECTS, id)); n++) id = `${slug(name)}-${n}`
    const b = { id, name, roots: [{ path: rp, label: String(label || '').trim() || path.basename(rp) }], createdAt: Date.now() }
    reg.boards.push(b)
    saveRegistry(reg)
    return b
  },
  renameBoard({ project, name }) {
    const reg = loadRegistry(), b = boardById(reg, project)
    if (!b) throw new Error('no such board')
    if (String(name || '').trim()) b.name = String(name).trim()
    saveRegistry(reg)
    return b
  },
  addRoot({ project, root, label }) {
    const reg = loadRegistry(), b = boardById(reg, project)
    if (!b) throw new Error('no such board')
    const rp = checkRoot(root)
    b.roots.push({ path: rp, label: String(label || '').trim() || path.basename(rp) })
    saveRegistry(reg)
    return b
  },
  removeRoot({ project, root }) {
    const reg = loadRegistry(), b = boardById(reg, project)
    if (!b) throw new Error('no such board')
    b.roots = b.roots.filter(r => normPath(r.path).toLowerCase() !== normPath(root).toLowerCase())
    saveRegistry(reg)
    return b
  },
  labelRoot({ project, root, label }) {
    const reg = loadRegistry(), b = boardById(reg, project)
    if (!b) throw new Error('no such board')
    const r = b.roots.find(x => normPath(x.path).toLowerCase() === normPath(root).toLowerCase())
    if (r && String(label || '').trim()) r.label = String(label).trim()
    saveRegistry(reg)
    return b
  },
  createTask({ project, title, description, parentId, fromStep, kind, services, mainService, bug }) {
    title = String(title || '').trim()
    if (!title) throw new Error('title is required')
    let parent = null
    if (parentId) {
      parent = readJson(taskPath(project, parentId))
      if (!parent) throw new Error('no such parent task')
      if ((parent.level || 1) >= 3) throw new Error('a Level 3 task cannot have subtasks: promote it first')
    }
    let id = slug(title)
    for (let n = 2; fs.existsSync(taskPath(project, id)); n++) id = `${slug(title)}-${n}`
    const t = { id, title, description: description || '', status: 'active', createdAt: Date.now(), updatedAt: Date.now(), lastAction: null, items: [], sessions: [], level: parent ? (parent.level || 1) + 1 : 1, parentId: parent ? parent.id : null }
    if (!parent) t.kind = kind === 'backlog' ? 'backlog' : 'feature'
    if (Array.isArray(services)) t.services = services
    if (mainService) t.mainService = mainService
    if (bug) t.bug = true
    if (parent && fromStep) {
      const pp = path.join(PROJECTS, safe(project), 'tasks', safe(parent.id), 'plan.md')
      const md = readText(pp).split(/\r?\n/).map(line => {
        const m = STEP.exec(line)
        return m && m[4].toLowerCase() === String(fromStep).toLowerCase() && !line.includes('(task ') ? `${line} → (task ${id})` : line
      }).join('\n')
      fs.writeFileSync(pp, md)
    }
    writeJson(taskPath(project, id), t)
    return t
  },
  promoteTask({ project, task }) {
    const t = readJson(taskPath(project, task))
    if (!t) throw new Error('no such task')
    const lv = t.level || 1
    if (lv === 1) throw new Error('already a master task')
    const parent = t.parentId ? readJson(taskPath(project, t.parentId)) : null
    t.origin = [...(t.origin || []), ...(parent ? [{ id: parent.id, title: parent.title }] : [])]
    t.parentId = parent ? parent.parentId || null : null
    t.level = lv - 1
    for (const d of t.decisions || []) if ((d.level || lv) === lv) d.level = t.level
    t.updatedAt = Date.now()
    writeJson(taskPath(project, task), t)
    for (const d of listDir(path.join(PROJECTS, safe(project), 'tasks'))) {
      const k = d.isDirectory() && readJson(taskPath(project, d.name))
      if (k && k.parentId === t.id) { k.level = Math.max(1, (k.level || 1) - 1); writeJson(taskPath(project, d.name), k) }
    }
    return t
  },
  // Decisions live on the task at the level they belong to; raisedFrom maps them back to
  // the task where they came up (e.g. a broad question raised in a Level 3 task, filed at Level 1).
  addDecision({ project, task, level, title, description, refs, options, rec, area, lldCheck, register }) {
    title = String(title || '').trim()
    if (!title) throw new Error('title is required')
    const cur = readJson(taskPath(project, task))
    if (!cur) throw new Error('no such task')
    let owner = cur
    for (let i = 0; i < 3 && (owner.level || 1) > Number(level || cur.level || 1) && owner.parentId; i++) {
      const p = readJson(taskPath(project, owner.parentId))
      if (!p) break
      owner = p
    }
    const d = {
      id: `D-${Date.now().toString(36).toUpperCase()}`, title, description: String(description || ''),
      level: owner.level || 1, raisedFrom: owner.id === cur.id ? null : { id: cur.id, title: cur.title },
      refs: (Array.isArray(refs) ? refs : String(refs || '').split(/\r?\n/)).map(s => String(s).trim()).filter(Boolean),
      options: String(options || ''), verdict: '', status: 'open', at: Date.now(), by: 'board',
    }
    if (rec) {
      // Board-wide R# (max + 1), shared with numbers mirrored from external registers.
      const max = Math.max(0, ...allTasks(project).flatMap(x => (x.decisions || []).map(y => Number(String(y.rec?.r || '').replace(/\D/g, '')) || 0)))
      d.rec = { r: `R${max + 1}`, area: String(area || ''), lldCheck: String(lldCheck || ''), register: register || null, implemented: null }
    }
    return mutateTask(project, owner.id, t => { t.decisions = [...(t.decisions || []), d] })
  },
  updateDecision({ project, owner, id, patch }) {
    return mutateTask(project, owner, t => {
      const d = (t.decisions || []).find(x => x.id === id)
      if (!d) throw new Error('no such decision')
      for (const k of ['title', 'description', 'options', 'verdict', 'status']) if (patch[k] !== undefined) d[k] = String(patch[k])
      if (d.rec) {
        for (const k of ['area', 'lldCheck', 'register']) if (patch[k] !== undefined) d.rec[k] = patch[k]
        if (patch.implemented) d.rec.implemented = { ...(d.rec.implemented || {}), ...patch.implemented, at: Date.now() }
      }
      if (patch.status === 'decided') d.decidedAt = Date.now()
    })
  },
  deleteDecision({ project, owner, id }) {
    return mutateTask(project, owner, t => { t.decisions = (t.decisions || []).filter(x => x.id !== id) })
  },
  // ---- services (board-level list: name → folder patterns) ----
  // ---- register / rules ----
  saveRegisters({ project, registers }) {
    const reg = loadRegistry(), b = boardById(reg, project)
    if (!b) throw new Error('no such board')
    b.registers = (registers || []).map(x => ({ id: slug(x.id || x.topic), topic: String(x.topic || x.id).trim(), url: String(x.url || '').trim() })).filter(x => x.topic)
    saveRegistry(reg)
    return b
  },
  saveRules({ project, rules }) {
    const reg = loadRegistry(), b = boardById(reg, project)
    if (!b) throw new Error('no such board')
    b.rules = String(rules || '')
    saveRegistry(reg)
    return b
  },
  // ---- ownership ----
  setOwner({ project, task, root, label }) {
    const t = ownerNode(project, task)
    const b = boardById(loadRegistry(), project)
    const r = (b?.roots || []).find(x => normPath(x.path).toLowerCase() === normPath(root).toLowerCase())
    if (!r) throw new Error('not a workspace of this board')
    history(t, t.owner ? 'takeover' : 'assigned', { from: t.owner?.label, to: r.label })
    t.owner = { root: normPath(r.path), label: label || r.label, state: 'owned', since: Date.now() }
    writeJson(taskPath(project, task), t)
    return t
  },
  releaseCheck({ project, task }) {
    const t = ownerNode(project, task)
    if (!t.owner) throw new Error('nobody owns it')
    return releaseCheck(project, task, t.owner.root)
  },
  softRelease({ project, task }) {
    const t = ownerNode(project, task)
    if (!t.owner) throw new Error('nobody owns it')
    const c = releaseCheck(project, task, t.owner.root)
    if (!c.ok) throw new Error('not ready: ' + c.problems.join('; '))
    t.owner = { ...t.owner, state: 'soft', softAt: Date.now(), pickup: c.pickup }
    history(t, 'soft-release', { from: t.owner.label })
    writeJson(taskPath(project, task), t)
    return t
  },
  reclaim({ project, task }) {
    const t = ownerNode(project, task)
    if (!t.owner) throw new Error('nobody owns it')
    t.owner = { ...t.owner, state: 'owned', softAt: undefined }
    history(t, 'reclaim', { to: t.owner.label })
    writeJson(taskPath(project, task), t)
    return t
  },
  releaseOwner({ project, task }) {
    const t = ownerNode(project, task)
    if (t.owner) history(t, 'release', { from: t.owner.label })
    t.owner = null
    writeJson(taskPath(project, task), t)
    return t
  },
  saveServices({ project, services }) {
    const reg = loadRegistry(), b = boardById(reg, project)
    if (!b) throw new Error('no such board')
    b.services = (services || []).map(x => ({
      id: slug(x.id || x.name), name: String(x.name || x.id).trim(),
      match: (Array.isArray(x.match) ? x.match : String(x.match || '').split(',')).map(m => String(m).trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')).filter(Boolean),
    })).filter(x => x.name)
    saveRegistry(reg)
    return b
  },
  setServices({ project, task, services, mainService }) {
    return mutateTask(project, task, t => {
      if (services) t.services = [...new Set(services.map(String))]
      if (mainService !== undefined) t.mainService = mainService || null
    })
  },
  // ---- links: stored on the task they start from; the board computes the reverse side ----
  addLink({ project, from, to, type, note }) {
    const flip = { blocks: 'blocked_by', led_to: 'found_during' }
    if (flip[type]) { [from, to] = [to, from]; type = flip[type] }
    if (!['blocked_by', 'found_during', 'related', 'fixes'].includes(type)) throw new Error('unknown link type')
    if (from === to) throw new Error('a task cannot link to itself')
    if (!readJson(taskPath(project, to))) throw new Error('no such task')
    return mutateTask(project, from, t => {
      t.links = (t.links || []).filter(l => !(l.to === to && l.type === type))
      t.links.push({ to, type, note: String(note || ''), at: Date.now(), by: 'board' })
    })
  },
  removeLink({ project, owner, to, type }) {
    return mutateTask(project, owner, t => { t.links = (t.links || []).filter(l => !(l.to === to && l.type === type)) })
  },
  // ---- move: re-parent a task (and its subtree) ----
  moveTask({ project, task, parentId }) {
    const all = listDir(path.join(PROJECTS, safe(project), 'tasks')).filter(d => d.isDirectory()).map(d => readJson(taskPath(project, d.name))).filter(Boolean)
    const byId = Object.fromEntries(all.map(t => [t.id, t]))
    const t = byId[task]
    if (!t) throw new Error('no such task')
    const parent = parentId ? byId[parentId] : null
    if (parentId && !parent) throw new Error('no such destination')
    const kidsOf = id => all.filter(x => x.parentId === id)
    const desc = id => kidsOf(id).flatMap(k => [k, ...desc(k.id)])
    if (parent && (parent.id === t.id || desc(t.id).some(d => d.id === parent.id))) throw new Error('cannot move a task under itself')
    const height = id => 1 + Math.max(0, ...kidsOf(id).map(k => height(k.id)))
    const newLevel = parent ? (parent.level || 1) + 1 : 1
    if (newLevel + height(t.id) - 1 > 3) throw new Error('it would go deeper than 3 levels; promote or move its subtasks first')
    const delta = newLevel - (t.level || 1)
    const old = t.parentId ? byId[t.parentId] : null
    if (old && old.id !== (parent && parent.id)) t.origin = [...(t.origin || []), { id: old.id, title: old.title }]
    t.parentId = parent ? parent.id : null
    for (const x of [t, ...desc(t.id)]) {
      x.level = (x.level || 1) + delta
      for (const d of x.decisions || []) d.level = Math.min(3, Math.max(1, (d.level || x.level) + delta))
      if (x.level === 1 && !x.kind) x.kind = 'feature'
      x.updatedAt = Date.now()
      writeJson(taskPath(project, x.id), x)
    }
    return t
  },
  saveMasterPlan({ project, task, markdown }) {
    fs.writeFileSync(path.join(PROJECTS, safe(project), 'tasks', safe(task), 'masterplan.md'), String(markdown || ''))
    return { ok: true }
  },
  // Docs mapped to a task (tech spec, HLD, LLD, API spec, …): references, not copies.
  addDoc({ project, task, kind, title, ref, note }) {
    ref = String(ref || '').trim()
    if (!ref) throw new Error('a path or URL is required')
    return mutateTask(project, task, t => {
      t.docs = [...(t.docs || []), {
        id: `doc-${Date.now().toString(36)}`, kind: String(kind || 'Reference'),
        title: String(title || '').trim() || path.basename(ref.replace(/[?#].*$/, '')) || ref,
        ref, note: String(note || ''), at: Date.now(), by: 'board',
      }]
    })
  },
  removeDoc({ project, task, id }) {
    return mutateTask(project, task, t => { t.docs = (t.docs || []).filter(d => d.id !== id) })
  },
  openDoc({ ref }) {
    ref = String(ref || '').trim()
    if (/^https?:\/\//i.test(ref)) { openExternal(ref); return { ok: true, how: 'browser' } }
    if (!fs.existsSync(ref)) throw new Error(`file not found: ${ref}`)
    openVSCode(ref)
    return { ok: true, how: 'vscode' }
  },
  saveLiving({ project, task, markdown }) {
    fs.writeFileSync(path.join(PROJECTS, safe(project), 'tasks', safe(task), 'handoff.md'), String(markdown || ''))
    return { ok: true }
  },
  setBoardMode({ project, on }) {
    const reg = loadRegistry(), b = boardById(reg, project)
    if (!b) throw new Error('no such board')
    b.boardMode = !!on
    saveRegistry(reg)
    return b
  },
  updateTask({ project, task, patch }) {
    return mutateTask(project, task, t => {
      for (const k of ['title', 'description', 'status', 'kind']) if (patch[k] !== undefined) t[k] = patch[k]
    })
  },
  addItem({ project, task, kind, text }) {
    return mutateTask(project, task, t => {
      t.items.push({ id: `${kind[0]}${Date.now().toString(36)}`, kind, text, done: false, at: Date.now(), by: 'board' })
    })
  },
  toggleItem({ project, task, id }) {
    return mutateTask(project, task, t => { const i = t.items.find(x => x.id === id); if (i) i.done = !i.done })
  },
  deleteItem({ project, task, id }) {
    return mutateTask(project, task, t => { t.items = t.items.filter(x => x.id !== id) })
  },
  savePlan({ project, task, markdown }) {
    fs.writeFileSync(path.join(PROJECTS, safe(project), 'tasks', safe(task), 'plan.md'), markdown)
    return { ok: true }
  },
  toggleStep({ project, task, step }) {
    const p = path.join(PROJECTS, safe(project), 'tasks', safe(task), 'plan.md')
    const md = readText(p).split(/\r?\n/).map(line => {
      const m = STEP.exec(line)
      if (!m || m[4].toLowerCase() !== String(step).toLowerCase()) return line
      return line.replace(/\[[ xX]\]/, m[2] === ' ' ? '[x]' : '[ ]')
    }).join('\n')
    fs.writeFileSync(p, md)
    return { ok: true }
  },
  linkSession({ project, task, sessionId }) {
    const sp = path.join(PROJECTS, safe(project), 'sessions', safe(sessionId) + '.json')
    const s = readJson(sp)
    if (!s) throw new Error('no such chat')
    s.taskId = task || null
    s.linkDeclined = !task
    writeJson(sp, s)
    if (task) mutateTask(project, task, t => {
      if (!t.sessions.some(x => x.sessionId === sessionId)) t.sessions.push({ sessionId, linkedAt: Date.now(), workspaceLabel: s.workspaceLabel })
    })
    return { ok: true }
  },
  forgetSession({ project, sessionId }) {
    try { fs.unlinkSync(path.join(PROJECTS, safe(project), 'sessions', safe(sessionId) + '.json')) } catch {}
    return { ok: true }
  },
  jump({ project, sessionId }) {
    const st = settings()
    const s = { ...appSessions().get(sessionId), ...readJson(path.join(PROJECTS, safe(project), 'sessions', safe(sessionId) + '.json'), {}) }
    if (!s.hostSessionId) { appIndex.at = 0; Object.assign(s, appSessions().get(sessionId) || {}) }
    const resume = `claude --resume ${sessionId}`
    // Desktop chats carry the app's own id (local_…), which claude:// links take.
    if (s.hostSessionId && /^local_[A-Za-z0-9-]{1,64}$/.test(s.hostSessionId)) {
      const url = st.jumpUrl.replace('{id}', encodeURIComponent(s.hostSessionId))
      openExternal(url)
      if (st.openWorkspaceInVSCode && s.workspace) openVSCode(s.workspace)
      return { ok: true, how: 'app', url, resume }
    }
    // VS Code extension chats: open the chat's workspace (the extension resumes sessions of the
    // folder that's open), then hand the extension its own link.
    if (s.surface === 'claude-vscode' && s.workspace) {
      openVSCode(s.workspace)
      // With the Project Board Bridge extension the chat opens in the Claude sidebar;
      // the Claude extension's own link always opens a full editor tab.
      const url = bridgeInstalled()
        ? `vscode://local.project-board-bridge/open?session=${encodeURIComponent(sessionId)}&in=${st.vscodeOpenIn === 'tab' ? 'tab' : 'sidebar'}`
        : `vscode://anthropic.claude-code/open?session=${encodeURIComponent(sessionId)}`
      setTimeout(() => { try { openExternal(url) } catch {} }, 2500)
      return { ok: true, how: 'vscode', url, resume }
    }
    // Terminal chats (or a chat whose mod predates this): no link opens them; the UI shows how to resume.
    return { ok: true, how: 'manual', resume, workspace: s.workspace || '' }
  },
  openWorkspace({ workspace }) {
    if (workspace) openVSCode(workspace)
    return { ok: true }
  },
  saveSettings({ patch }) {
    const next = { ...settings(), ...patch }
    writeJson(SETTINGS, next)
    return next
  },
}

function bridgeInstalled() {
  return listDir(path.join(os.homedir(), '.vscode', 'extensions')).some(d => d.isDirectory() && d.name.startsWith('local.project-board-bridge-'))
}

// `code` is a .cmd on Windows, so it runs through the shell: refuse shell metacharacters.
function openVSCode(target) {
  const p = String(target)
  if (/["&|<>^%!`]/.test(p)) throw new Error('that path contains characters that are not allowed')
  spawn('code', [`"${p}"`], { shell: true, detached: true, stdio: 'ignore' }).unref()
}

// URLs and claude:// / vscode:// links open through the OS handler, never through a shell.
function openExternal(url) {
  const u = String(url)
  if (!/^(https?|claude|vscode):\/\/[^\s"<>`]+$/i.test(u)) throw new Error('not an allowed link')
  if (process.platform === 'win32') spawn('rundll32', ['url.dll,FileProtocolHandler', u], { detached: true, stdio: 'ignore' }).unref()
  else spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [u], { detached: true, stdio: 'ignore' }).unref()
}

// ---------- http ----------
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json' }
const send = (res, code, body, type = 'application/json') => {
  res.writeHead(code, { 'Content-Type': type + '; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`)
  // Only this machine: refuse requests from other origins.
  const origin = req.headers.origin
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'forbidden' })
  try {
    if (u.pathname === '/api/projects') return send(res, 200, projects())
    if (u.pathname === '/api/unassigned') return send(res, 200, unassigned())
    if (u.pathname === '/api/board') return send(res, 200, board(u.searchParams.get('project')))
    if (u.pathname === '/api/settings') return send(res, 200, settings())
    if (u.pathname === '/api/handoff') {
      const p = path.join(PROJECTS, safe(u.searchParams.get('project')), 'tasks', safe(u.searchParams.get('task')), 'handoffs', safe(u.searchParams.get('step')) + '.md')
      return send(res, 200, { markdown: readText(p) })
    }
    if (u.pathname.startsWith('/api/') && req.method === 'POST') {
      const name = u.pathname.slice(5)
      if (!actions[name]) return send(res, 404, { error: 'unknown action' })
      let body = ''
      req.on('data', c => { body += c; if (body.length > 2e6) req.destroy() })
      req.on('end', () => {
        try { send(res, 200, actions[name](JSON.parse(body || '{}'))) } catch (e) { send(res, 400, { error: String(e.message || e) }) }
      })
      return
    }
    let file = u.pathname === '/' ? '/index.html' : u.pathname
    file = path.join(PUBLIC, path.normalize(file).replace(/^([\\/]\.\.)+/, ''))
    if (!file.startsWith(PUBLIC) || !fs.existsSync(file)) return send(res, 404, 'not found', 'text/plain')
    return send(res, 200, fs.readFileSync(file), TYPES[path.extname(file)] || 'application/octet-stream')
  } catch (e) {
    return send(res, 500, { error: String(e.message || e) })
  }
})

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { console.log(`Board already running on http://localhost:${PORT}`); process.exit(0) }
  throw e
})
server.listen(PORT, '127.0.0.1', () => console.log(`Claude Project Board on http://localhost:${PORT}  (data: ${ROOT})`))

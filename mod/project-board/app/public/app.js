'use strict'
const $ = s => document.querySelector(s)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const params = new URLSearchParams(location.search)
const projectId = params.get('project')
const COLORS = ['yellow', 'green', 'blue', 'pink', 'purple', 'orange']
const KINDS = [['mandatory', 'Mandatory'], ['decision', 'Open decisions'], ['todo', 'To do']]

let data = null
let filter = localGet('filter') || 'active'
let view = localGet('view') || 'tree' // tree | 1 | 2 | 3
let open = null // { taskId, tab, openSteps:Set }
let detailSig = ''

function localGet(k) { try { return localStorage.getItem('pb:' + k) } catch { return null } }
function localSet(k, v) { try { localStorage.setItem('pb:' + k, v) } catch {} }
function hash(s) { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) | 0; return Math.abs(h) }
const colorOf = id => `var(--note-${COLORS[hash(id) % COLORS.length]})`
function ago(t) {
  if (!t) return ''
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}
function dur(t) { const m = Math.floor((Date.now() - t) / 60000); return m < 1 ? '<1m' : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m` }

function toast(msg, ms = 3200) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false
  clearTimeout(toast.h); toast.h = setTimeout(() => (t.hidden = true), ms)
}

async function api(name, body) {
  const r = await fetch('/api/' + name, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  const j = await r.json()
  if (!r.ok) throw new Error(j.error || r.statusText)
  return j
}
const act = async (name, body) => {
  try { const r = await api(name, { project: projectId, ...body }); await refresh(); return r } catch (e) { toast('Failed: ' + e.message) }
}

// ---------- tiny markdown ----------
function md(src) {
  const lines = String(src || '').replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)
  let out = '', inList = false, inCode = false, code = ''
  const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
  const close = () => { if (inList) { out += '</ul>'; inList = false } }
  for (const l of lines) {
    if (/^```/.test(l)) { if (inCode) { out += `<pre><code>${esc(code)}</code></pre>`; code = ''; inCode = false } else { close(); inCode = true } continue }
    if (inCode) { code += l + '\n'; continue }
    const h = /^(#{1,4})\s+(.*)/.exec(l)
    if (h) { close(); out += `<h3>${inline(h[2])}</h3>`; continue }
    const li = /^\s*[-*]\s+(\[[ xX]\]\s+)?(.*)/.exec(l)
    if (li) { if (!inList) { out += '<ul>'; inList = true } out += `<li>${li[1] ? (li[1].includes(' ]') ? '☐ ' : '☑ ') : ''}${inline(li[2])}</li>`; continue }
    close()
    if (l.trim()) out += `<p>${inline(l)}</p>`
  }
  close(); if (inCode) out += `<pre><code>${esc(code)}</code></pre>`
  return `<div class="md">${out}</div>`
}

// ---------- data ----------
async function refresh() {
  if (!projectId) return
  const first = !data
  try { data = await api('board?project=' + encodeURIComponent(projectId)) } catch (e) { return }
  render()
  // Opened with ?task=<master task>: go straight to its page.
  if (first) { const tid = params.get('task'); if (tid && byId(tid)) showPage(tid) }
}

// ---------- hierarchy (1 master task › 2 module › 3 task) ----------
const LEVELS = { 1: 'Master task', 2: 'Module', 3: 'Task' }
const byId = id => data.tasks.find(t => t.id === id)
const kidsOf = id => data.tasks.filter(t => t.parentId === id).sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))
const subtree = t => [t, ...kidsOf(t.id).flatMap(subtree)]
const rollLinked = t => subtree(t).flatMap(x => x.linked)
function ancestors(t) {
  const out = []
  let c = t
  for (let i = 0; i < 3 && c && c.parentId; i++) { c = byId(c.parentId); if (c) out.unshift(c) }
  return out
}
// ---------- services and links ----------
const svcList = () => data?.project?.services || []
const svcName = id => svcList().find(s => s.id === id)?.name || id
const tagsOf = t => [...new Set([...(t.mainService ? [t.mainService] : []), ...(t.services || [])])]
const pathOf = t => [...ancestors(t), t].map(x => x.title).join(' › ')
// Unfinished tasks this one is blocked by (links point at the blocker).
const blockersOf = t => (t.links || []).filter(l => l.type === 'blocked_by').map(l => byId(l.to)).filter(o => o && o.status !== 'done')
const blockedIn = t => subtree(t).filter(x => blockersOf(x).length)
// Fix tasks pointing at this (finished) task that aren't done yet.
const openFixesOf = t => data.tasks.filter(x => x.status !== 'done' && (x.links || []).some(l => l.type === 'fixes' && l.to === t.id))
// Ownership: modules and master tasks; a task belongs to its module's, else its feature's, owner.
function ownerHolderOf(t) {
  let c = t.level === 3 && t.parentId ? byId(t.parentId) : t
  for (let i = 0; i < 3 && c; i++) { if (c.owner) return c; c = c.parentId ? byId(c.parentId) : null }
  return null
}
function ownerChip(t) {
  const h = ownerHolderOf(t)
  if (!h) return ''
  const o = h.owner
  const inherited = h.id !== t.id
  return `<span class="owner ${o.state}" title="${o.state === 'soft' ? 'Soft-released: another workspace can take over' : 'Owned by this workspace copy'}${inherited ? ` (via ${esc(h.title)})` : ''}">${o.state === 'soft' ? '🤝 ready · ' : '🏠 '}${esc(o.label)}</span>`
}
const LINK_GROUPS = {
  'out:fixes': 'Fixes', 'in:fixes': 'Fixed by',
  'out:blocked_by': 'Blocking us', 'in:blocked_by': 'We block',
  'out:found_during': 'Came from', 'in:found_during': 'Spun off from our work',
  'out:related': 'Related', 'in:related': 'Related',
}
// Links between this task's tree and tasks outside it, from the tree's point of view.
function externalLinks(t) {
  const inside = new Set(subtree(t).map(x => x.id))
  const out = []
  for (const x of data.tasks) for (const l of x.links || []) {
    const fromIn = inside.has(x.id), toIn = inside.has(l.to)
    if (fromIn === toIn) continue
    const other = fromIn ? byId(l.to) : x
    const ours = fromIn ? x : byId(l.to)
    out.push({ group: LINK_GROUPS[`${fromIn ? 'out' : 'in'}:${l.type}`], other, ours, owner: x.id, to: l.to, type: l.type, note: l.note, missing: !other })
  }
  return out
}
function linkedHtml(t, compact) {
  const links = externalLinks(t)
  const groups = {}
  for (const l of links) (groups[l.group] = groups[l.group] || []).push(l)
  const order = ['Blocking us', 'We block', 'Fixed by', 'Fixes', 'Came from', 'Spun off from our work', 'Related']
  let h = links.length ? order.filter(g => groups[g]).map(g => `<div class="lgroup"><div class="lg-h ${g === 'Blocking us' ? 'bad' : ''}">${g}</div>${groups[g].map(l => l.missing
      ? `<div class="lrow small muted">${esc(l.to)} (archived or missing) <button class="x" data-rmlink="${esc(l.owner)}" data-to="${esc(l.to)}" data-type="${esc(l.type)}">✕</button></div>`
      : `<div class="lrow"><span class="dot ${liveOf(l.other)}"></span><div class="t"><button class="crumb" data-open="${esc(l.other.id)}">${esc(l.other.title)}</button>
          <div class="small muted">${esc(ancestors(l.other).map(a => a.title).join(' › ') || LEVELS[l.other.level])} · ${esc(l.other.status)}${l.ours.id !== t.id ? ` · ↔ ${esc(l.ours.title)}` : ''}${l.note ? ` · ${esc(l.note)}` : ''}</div></div>
          <button class="x" title="Remove link" data-rmlink="${esc(l.owner)}" data-to="${esc(l.to)}" data-type="${esc(l.type)}">✕</button></div>`).join('')}</div>`).join('')
    : `<div class="small muted">No links to other ${compact ? 'tasks' : 'features, modules or backlogs'} yet.</div>`
  const inside = new Set(subtree(t).map(x => x.id))
  const targets = data.tasks.filter(x => !inside.has(x.id)).sort((a, b) => pathOf(a).localeCompare(pathOf(b)))
  if (targets.length) h += `<form class="linkform" data-addlink>
    <select name="type"><option value="blocked_by">is blocked by</option><option value="blocks">blocks</option><option value="found_during">was found during</option><option value="led_to">led to</option><option value="related">is related to</option><option value="fixes">fixes (bug in)</option></select>
    <select name="to">${targets.map(x => `<option value="${esc(x.id)}">${esc(pathOf(x))}</option>`).join('')}</select>
    <button class="btn small">Link</button></form>`
  return h
}

// Items directly under a service backlog read as "Backlog item" rather than "Module".
const inBacklog = t => { const r = ancestors(t)[0]; return !!(r && r.kind === 'backlog') }
const levelLabel = t => t.level === 1 ? (t.kind === 'backlog' ? 'Service backlog' : LEVELS[1]) : t.level === 2 && inBacklog(t) ? 'Backlog item' : LEVELS[t.level]

const liveOf = t => {
  const l = rollLinked(t)
  return l.some(s => s.live === 'working') ? 'working' : l.some(s => s.live === 'idle') ? 'idle' : 'offline'
}

function sessionStatus(task) {
  const linked = rollLinked(task)
  const w = linked.filter(s => s.live === 'working')
  if (w.length) {
    const where = [...new Set(w.map(s => s.workspaceLabel))].join(', ')
    const viaKids = w.filter(s => !task.linked.includes(s)).length
    return { cls: 'working', text: `Working · ${where} · ${dur(Math.min(...w.map(s => s.turnStartedAt || Date.now())))}${viaKids ? ` · ${viaKids} in subtasks` : ''}` }
  }
  const idle = linked.filter(s => s.live === 'idle')
  if (idle.length) return { cls: 'idle', text: `Idle · ${idle.length} chat${idle.length > 1 ? 's' : ''} open` }
  if (linked.length) return { cls: 'offline', text: 'No chat open' }
  return { cls: 'none', text: 'No chats linked yet' }
}

// ---------- render ----------
function render() {
  const { project, tasks, sessions, collisions } = data
  document.title = `${project.name} · Project Board`
  $('#projectName').textContent = project.name
  const live = new Set(sessions.filter(s => s.live === 'working').map(s => s.workspace))
  $('#workspaces').innerHTML = Object.entries(project.workspaces || {})
    .map(([ws, w]) => `<button class="chip ${live.has(ws) ? 'live' : ''}" data-ws="${esc(ws)}" title="${esc(ws)} — open in VS Code">${esc(w.label)}${live.has(ws) ? ' ●' : ''}</button>`).join('')
  const col = $('#collision')
  col.hidden = !collisions.length
  if (collisions.length) col.textContent = `⚠ ${collisions.map(c => `${c.sessions.length} chats working in ${c.workspace.split(/[\\/]/).pop()}`).join(' · ')}`
  document.querySelectorAll('#filter button').forEach(b => b.classList.toggle('on', b.dataset.f === filter))

  document.querySelectorAll('#viewMode button').forEach(b => b.classList.toggle('on', b.dataset.v === view))
  const okStatus = t => filter === 'all' || t.status === filter
  const board = $('#board')
  board.className = `board ${view === 'tree' || view === 'svc' ? 'mode-tree' : 'mode-grid'}`
  if (view === 'register') {
    board.className = 'board mode-reg'
    board.innerHTML = registerHtml()
  } else if (view === 'svc') {
    // One column per service: every task tagged with it, from any feature or backlog.
    const cols = svcList().map(s => ({ s, list: tasks.filter(t => okStatus(t) && tagsOf(t).includes(s.id)) })).filter(c => c.list.length)
    const untagged = tasks.filter(t => okStatus(t) && t.level === 3 && !tagsOf(t).length)
    board.innerHTML = cols.length || untagged.length ? cols.map(({ s, list }) => `<section class="col svc-col"><div class="svc-h"><b>${esc(s.name)}</b><span class="count">${list.length}</span>
        <div class="small muted mono">${esc(s.match.join(' · '))}</div></div>
        ${list.map(svcRow).join('')}</section>`).join('')
      + (untagged.length ? `<section class="col svc-col"><div class="svc-h"><b>No service yet</b><span class="count">${untagged.length}</span></div>${untagged.map(svcRow).join('')}</section>` : '')
      : `<div class="empty">No tasks are tagged with a service yet. Tags are added automatically when a chat edits files in a service's folder, or set them in a task's Services card.</div>`
  } else if (view === 'tree') {
    const roots = tasks.filter(t => t.level === 1 || !t.parentId || !byId(t.parentId)).filter(okStatus)
    board.innerHTML = roots.length ? roots.map(colHtml).join('') : emptyHtml(tasks.length)
  } else {
    // One level at a time; Level 2 and 3 notes carry their parent path at the bottom.
    const lv = Number(view)
    const list = tasks.filter(t => t.level === lv).filter(okStatus)
    board.innerHTML = list.length ? list.map(t => noteHtml(t, ancestors(t))).join('')
      : `<div class="empty">No ${filter === 'all' ? '' : filter + ' '}Level ${lv} ${LEVELS[lv].toLowerCase()}s.</div>`
  }
  $('#panel').innerHTML = panelHtml(tasks, sessions)
  if (open) renderDetail()
  if (page) renderPage()
}

function emptyHtml(any) {
  if (any) return `<div class="empty">No ${filter} tasks.</div>`
  return `<div class="empty"><b>No tasks yet.</b><br><br>In any Claude chat on this project type <code>/task SFTP</code>,<br>or just start working — Claude will offer to put it on the board.<br><br>You can also press <b>+ New task</b>.</div>`
}

// One column per master task: its note, then its modules, each listing its tasks.
function colHtml(t) {
  const mods = kidsOf(t.id)
  return `<section class="col">${noteHtml(t)}${mods.map(l2Html).join('')}
    <button class="add-sub" data-addsub="${esc(t.id)}">+ Module</button></section>`
}

function l2Html(m) {
  const st = sessionStatus(m)
  const p = m.plan
  const tasks = kidsOf(m.id)
  return `<div class="note l2 ${m.status === 'done' ? 'is-done' : ''}" data-task="${esc(m.id)}" style="--c:${colorOf(m.id)}" tabindex="0">
    <div class="lvl">${levelLabel(m)}${m.status !== 'active' ? ` · ${esc(m.status)}` : ''}</div>
    ${blockedBadge(m)}${ownerChip(m) ? `<div class="ownrow">${ownerChip(m)}</div>` : ''}
    <h3>${esc(m.title)}</h3>
    ${p.total ? `<div class="next">${p.next ? `Next: <b>${esc(p.next.id)}</b> – ${esc(p.next.text)}` : '<b>All steps done</b>'}</div>
      <div class="progress"><i style="width:${Math.round((p.done / p.total) * 100)}%"></i></div>` : ''}
    ${tasks.length ? `<div class="l3list">${tasks.map(l3Row).join('')}</div>` : ''}
    <div class="row-add"><button class="add-sub small" data-addsub="${esc(m.id)}">+ Task</button></div>
    <div class="status ${st.cls}"><span class="dot"></span>${esc(st.text)}</div>
  </div>`
}

// ---------- recommendations register: every R# on the board ----------
let regFilter = 'open'
function registerHtml() {
  const rnum = d => Number(String(d.rec.r).replace(/\D/g, '')) || 0
  const all = data.tasks.flatMap(t => (t.decisions || []).filter(d => d.rec).map(d => ({ d, t }))).sort((a, b) => rnum(a.d) - rnum(b.d))
  const list = all.filter(({ d }) => regFilter === 'all' || (regFilter === 'open' ? d.status === 'open' : d.status !== 'open'))
  const regs = data.project.registers || []
  const regOf = d => d.rec.register && regs.find(r => r.id === d.rec.register || r.topic === d.rec.register)
  return `<div class="reg">
    <div class="hrow"><div><h2 style="font-size:18px">Recommendations register</h2>
      <div class="small muted">Every recommendation on this board, numbered across the board. Topics with their own register (${regs.map(r => `<a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.topic)}</a>`).join(', ') || 'none set'}) are mirrored with the same R#. Nothing is decided until the team's decision is recorded.</div></div>
      <div class="seg">${['open', 'decided', 'all'].map(f => `<button data-regf="${f}" class="${regFilter === f ? 'on' : ''}">${f[0].toUpperCase() + f.slice(1)} (${all.filter(({ d }) => f === 'all' || (f === 'open' ? d.status === 'open' : d.status !== 'open')).length})</button>`).join('')}</div></div>
    ${list.length ? `<table class="regtable"><thead><tr><th>R#</th><th>Area</th><th>Recommendation</th><th>Task</th><th>Status</th><th>Decision</th><th>Implemented</th></tr></thead><tbody>
      ${list.map(({ d, t }) => `<tr data-open-dec="${esc(d.raisedFrom?.id || t.id)}">
        <td class="rnum">${esc(d.rec.r)}${regOf(d) ? ` <a href="${esc(regOf(d).url)}" target="_blank" rel="noopener" title="Also in the ${esc(regOf(d).topic)} register">↗</a>` : ''}</td>
        <td>${esc(d.rec.area || '—')}</td>
        <td><b>${esc(d.title)}</b>${d.description ? `<div class="small muted">${esc(d.description.slice(0, 160))}${d.description.length > 160 ? '…' : ''}</div>` : ''}</td>
        <td class="small">${esc(pathOf(d.raisedFrom ? byId(d.raisedFrom.id) || t : t))}</td>
        <td><span class="badge ${d.status === 'decided' ? 'working' : ''}">${esc(d.status)}</span></td>
        <td class="small">${esc(d.verdict || '')}</td>
        <td>${d.rec.implemented ? '✓' : d.status === 'decided' ? '<span class="small muted">pending</span>' : ''}</td></tr>`).join('')}
    </tbody></table>` : `<div class="empty">No ${regFilter === 'all' ? '' : regFilter + ' '}recommendations yet. In Board Mode, Claude records each recommendation here and names its R# in the reply.</div>`}
  </div>`
}

function svcRow(t) {
  return `<div class="svc-row ${t.status === 'done' ? 'is-done' : ''}" data-openrow="${esc(t.id)}">
    <div class="hrow"><span><span class="dot ${liveOf(t)}"></span> <b>${blockersOf(t).length ? '⛔ ' : ''}${t.bug ? '🐞 ' : ''}${esc(t.title)}</b></span><span class="lvlb">${levelLabel(t)}</span></div>
    ${ancestors(t).length ? `<div class="small muted">${esc(ancestors(t).map(a => a.title).join(' › '))}</div>` : ''}
    ${t.plan.next ? `<div class="small">Next: ${esc(t.plan.next.id)} – ${esc(t.plan.next.text)}</div>` : ''}
  </div>`
}

// "Blocked by X" on the task itself; "N blocked" rolled up on modules and master tasks.
function blockedBadge(t) {
  return blockedOnly(t) + bugBadge(t)
}
// "🐞 Bug" on a fix task; "🐞 N open fix" on finished work it fixes, rolled up on modules and features.
function bugBadge(t) {
  const own = openFixesOf(t)
  const below = subtree(t).filter(x => x.id !== t.id).flatMap(openFixesOf)
  let h = t.bug ? `<div class="bugb">🐞 Bug fix${(t.links || []).find(l => l.type === 'fixes' && byId(l.to)) ? ` · ${esc(byId((t.links || []).find(l => l.type === 'fixes').to).title)}` : ''}</div>` : ''
  if (own.length) h += `<div class="bugb open">🐞 ${own.length} open fix${own.length > 1 ? 'es' : ''}${t.status === 'done' ? ' · done' : ''}</div>`
  else if (below.length) h += `<div class="bugb open soft">🐞 ${below.length} open fix${below.length > 1 ? 'es' : ''} below</div>`
  return h
}
function blockedOnly(t) {
  const own = blockersOf(t)
  if (own.length) return `<div class="blocked" title="${esc(own.map(o => pathOf(o)).join('\n'))}">⛔ Blocked by ${esc(own[0].title)}${own.length > 1 ? ` +${own.length - 1}` : ''}</div>`
  const below = blockedIn(t).filter(x => x.id !== t.id)
  return below.length ? `<div class="blocked soft">⛔ ${below.length} blocked below</div>` : ''
}

function l3Row(k) {
  const nx = k.plan.next
  return `<div class="l3row ${k.status === 'done' ? 'is-done' : ''}" data-task="${esc(k.id)}" title="${esc(k.description || '')}">
    <span class="dot ${liveOf(k)}"></span><span class="t">${blockersOf(k).length ? '⛔ ' : ''}${k.bug ? '🐞 ' : ''}${openFixesOf(k).length ? '🐞 ' : ''}${esc(k.title)}</span>
    <span class="n">${k.status === 'done' ? 'done' : nx ? esc(nx.id) : k.plan.total ? '✓' : ''}</span></div>`
}

function noteHtml(t, parentTag) {
  const st = sessionStatus(t)
  const mods = kidsOf(t.id)
  const nTasks = t.level === 1 ? mods.reduce((n, m) => n + kidsOf(m.id).length, 0) : 0
  const openDec = (t.decisions || []).filter(d => d.status === 'open').length
  const p = t.plan
  const open = t.items.filter(i => !i.done)
  const mand = open.filter(i => i.kind === 'mandatory').length
  const dec = open.filter(i => i.kind === 'decision').length
  const wss = [...new Set(t.linked.filter(s => s.live !== 'ended').map(s => s.workspaceLabel))]
  const kidsLabel = t.level === 1
    ? (mods.length ? ` · ${mods.length} module${mods.length > 1 ? 's' : ''} · ${nTasks} task${nTasks === 1 ? '' : 's'}` : '')
    : (mods.length ? ` · ${mods.length} task${mods.length > 1 ? 's' : ''}` : '')
  return `<div class="note l${t.level}" data-task="${esc(t.id)}" style="--c:${colorOf(t.id)};--tilt:${(hash(t.id) % 5 - 2) * 0.5}deg" tabindex="0">
    <div class="lvl">${t.level === 1 && t.kind === 'backlog' ? `Service backlog${t.mainService ? ` · ${esc(svcName(t.mainService))}` : ''}` : LEVELS[t.level]}${kidsLabel}${t.status !== 'active' ? ` · ${esc(t.status)}` : ''}</div>
    ${blockedBadge(t)}
    <h3>${esc(t.title)}</h3>
    ${t.description ? `<div class="desc">${esc(t.description)}</div>` : ''}
    ${p.total ? `<div class="next">${p.next ? `Next: <b>${esc(p.next.id)}</b> – ${esc(p.next.text)}` : '<b>All steps done</b>'}</div>
      <div class="progress" title="${p.done}/${p.total} steps"><i style="width:${Math.round((p.done / p.total) * 100)}%"></i></div>` : '<div class="next muted">No plan yet</div>'}
    <div class="meta">
      ${p.total ? `<span>${p.done}/${p.total} steps</span>` : ''}
      ${mand ? `<span class="mand">${mand} must-do</span>` : ''}
      ${openDec + dec ? `<span>${openDec + dec} decision${openDec + dec > 1 ? 's' : ''}</span>` : ''}
      ${ownerChip(t)}
      ${tagsOf(t).slice(0, 4).map(s => `<span class="svc">${esc(svcName(s))}</span>`).join('')}
      ${wss.map(w => `<span>${esc(w)}</span>`).join('')}
    </div>
    <div class="last" data-jump="${esc(t.lastAction?.sessionId || '')}" title="${t.lastAction ? 'Jump to the chat that did this' : ''}">
      <div class="lbl"><span>Last action${t.lastAction ? ` · ${esc(t.lastAction.workspaceLabel || '')} · ${ago(t.lastAction.at)}` : ''}</span>${t.lastAction ? '<span class="go">Open chat ↗</span>' : ''}</div>
      <div class="txt">${t.lastAction ? esc(t.lastAction.text) : '<span class="muted">Nothing yet</span>'}</div>
    </div>
    <div class="status ${st.cls}"><span class="dot"></span>${esc(st.text)}</div>
    ${parentTag && parentTag.length ? `<div class="ptag">↑ ${parentTag.map(a => `<button class="crumb" data-open="${esc(a.id)}">${esc(a.title)}</button>`).join(' › ')}</div>` : ''}
  </div>`
}

function panelHtml(tasks, sessions) {
  const active = tasks.filter(t => t.status !== 'done')
  let h = ''
  for (const [kind, label] of KINDS) {
    if (kind === 'decision') {
      const ds = active.flatMap(t => (t.decisions || []).filter(d => d.status === 'open').map(d => ({ d, t })))
      const legacy = active.flatMap(t => t.items.filter(i => i.kind === 'decision' && !i.done).map(i => ({ i, t })))
      h += `<h2>${label}<span class="count">${ds.length + legacy.length}</span></h2>`
      h += ds.length + legacy.length ? ds.map(({ d, t }) => `<div class="pi decision" data-open-dec="${esc(d.raisedFrom?.id || t.id)}"><span class="bar"></span><div class="t"><span class="lvlb">L${d.level}</span> ${esc(d.title)}
          <div class="task">${esc(t.title)}${d.raisedFrom ? ` · raised in ${esc(d.raisedFrom.title)}` : ''}</div></div></div>`).join('')
        + legacy.map(({ i, t }) => `<div class="pi decision" data-open-dec="${esc(t.id)}"><span class="bar"></span><div class="t">${esc(i.text)}<div class="task">${esc(t.title)}</div></div></div>`).join('')
        : `<div class="none">None</div>`
      continue
    }
    const items = active.flatMap(t => t.items.filter(i => i.kind === kind && !i.done).map(i => ({ ...i, task: t })))
    h += `<h2>${label}<span class="count">${items.length}</span></h2>`
    h += items.length ? items.map(i => `<div class="pi ${kind}" data-task="${esc(i.task.id)}" data-tab="items"><span class="bar"></span><div class="t">${esc(i.text)}<div class="task">${esc(i.task.title)}</div></div></div>`).join('') : `<div class="none">None</div>`
  }
  const blocked = active.filter(t => blockersOf(t).length)
  if (blocked.length) h = `<h2>Blocked<span class="count">${blocked.length}</span></h2>` + blocked.map(t => `<div class="pi mandatory" data-openrow="${esc(t.id)}"><span class="bar"></span><div class="t">⛔ ${esc(t.title)}<div class="task">by ${esc(blockersOf(t).map(o => o.title).join(', '))}</div></div></div>`).join('') + h
  const unlinked = sessions.filter(s => !s.taskId && (s.live === 'working' || s.live === 'idle'))
  h += `<h2>Unlinked chats<span class="count">${unlinked.length}</span></h2>`
  h += unlinked.length ? unlinked.map(s => `<div class="chat-row"><span class="dot ${s.live}"></span>
      <span class="t" title="${esc(s.lastPrompt)}">${esc(s.title || 'New chat')} <span class="muted">· ${esc(s.workspaceLabel)}</span></span>
      <select data-link="${esc(s.sessionId)}"><option value="">Link to…</option>${active.map(t => `<option value="${esc(t.id)}">${esc(t.title)}</option>`).join('')}</select>
      <button class="icon-btn" data-jumpid="${esc(s.sessionId)}" data-ws="${esc(s.workspace)}" title="Open chat">↗</button></div>`).join('')
    : `<div class="none">Every open chat is on a task.</div>`
  return h
}

// ---------- task views: a modal for modules and tasks, a page for master tasks ----------
let page = null
let pageSig = ''
const S = () => open || page // the view the person is acting in
const newState = (taskId, tab) => ({ taskId, tab, openSteps: new Set(), editLiving: false, editPlan: false, editMaster: false, showMaster: false })
const busy = el => el.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)

function openAny(taskId, tab) {
  const t = byId(taskId)
  if (t && t.level === 1) return openMaster(taskId, !tab || tab === 'chats' ? 'overview' : tab)
  openTask(taskId, tab)
}
function openTask(taskId, tab) {
  open = newState(taskId, tab || 'chats')
  detailSig = ''
  $('#scrim').hidden = false; $('#detail').hidden = false
  renderDetail(true)
}
function closeTask() { open = null; $('#scrim').hidden = true; $('#detail').hidden = true }

function showPage(taskId, tab) {
  page = newState(taskId, tab || 'overview')
  pageSig = ''
  $('#page').hidden = false
  document.querySelector('.layout').hidden = true
  renderPage(true)
}
function openMaster(taskId, tab) {
  if (open) closeTask()
  const u = new URL(location.href)
  u.searchParams.set('task', taskId)
  history.pushState({ task: taskId }, '', u)
  showPage(taskId, tab)
}
function closeMaster(push = true) {
  page = null
  $('#page').hidden = true
  document.querySelector('.layout').hidden = false
  if (push) { const u = new URL(location.href); u.searchParams.delete('task'); history.pushState({}, '', u) }
  render()
}
window.addEventListener('popstate', () => {
  const tid = new URLSearchParams(location.search).get('task')
  if (open) closeTask()
  if (tid && data && byId(tid)) showPage(tid)
  else if (page) closeMaster(false)
})
function rerender() { return open ? renderDetail(true) : renderPage(true) }

function tabsFor(t, master) {
  const kids = kidsOf(t.id)
  const tabs = master ? [['overview', 'Overview']] : [['chats', `Chats (${t.linked.length})`]]
  tabs.push(['plan', 'Plan & Docs'], ['handoff', 'Handoff'])
  if (!master && (t.level < 3 || kids.length)) tabs.push(['subtasks', `${t.level === 1 ? 'Modules' : 'Tasks'} (${kids.length})`])
  tabs.push(['decisions', `Decisions (${decisionsFor(t).open})`])
  if (master) tabs.push(['chats', `Chats (${rollLinked(t).length})`])
  return tabs
}

function headHtml(t, master, tabs) {
  const anc = ancestors(t)
  return `<div class="crumbs">${master ? `<button class="crumb" data-closepage>← Board</button><span>·</span>` : anc.map(a => `<button class="crumb" data-open="${esc(a.id)}">${esc(a.title)}</button><span>›</span>`).join('')}<span class="lvlb">${levelLabel(t)}</span>
      ${t.origin?.length ? `<span class="small" title="Promoted; former parents stay readable">· promoted from ${t.origin.map(o => esc(o.title)).join(' › ')}</span>` : ''}</div>
    <div class="row1">
      <input class="title" value="${esc(t.title)}" data-field="title" aria-label="Title">
      ${t.level > 1 ? `<button class="btn small" data-promote title="Move this up one level; its subtasks move with it">Promote to ${LEVELS[t.level - 1]}</button>` : ''}
      <button class="btn small" data-move title="Move under another master task or module (e.g. into a service backlog)">Move…</button>
      <select data-field="status">${['active', 'paused', 'done'].map(s => `<option ${t.status === s ? 'selected' : ''}>${s}</option>`).join('')}</select>
      <button class="icon-btn" ${master ? 'data-closepage' : 'data-close'} aria-label="Close">✕</button>
    </div>
    <textarea class="desc" data-field="description" rows="2" placeholder="What is this ${LEVELS[t.level].toLowerCase()} for?">${esc(t.description)}</textarea>
    <div class="tabs">${tabs.map(([k, l]) => `<button data-tabset="${k}" class="${S().tab === k ? 'on' : ''}">${l}</button>`).join('')}</div>`
}

function tabBody(t, master) {
  const tab = S().tab
  return tab === 'overview' ? overviewHtml(t)
    : tab === 'chats' ? chatsHtml(t, master)
    : tab === 'plan' ? planDocsHtml(t)
    : tab === 'handoff' ? handoffHtml(t)
    : tab === 'subtasks' ? subtasksHtml(t)
    : decisionsHtml(t)
}

function renderDetail(force) {
  const t = data.tasks.find(x => x.id === open.taskId)
  if (!t) return closeTask()
  if (t.level === 1) { const tab = open.tab; closeTask(); return openMaster(t.id, tab === 'chats' ? 'overview' : tab) }
  const sig = JSON.stringify([t, open.tab, [...open.openSteps], open.editPlan, open.showMaster, Math.floor(Date.now() / 60000)])
  const el = $('#detail')
  if (!force && (sig === detailSig || busy(el))) return
  detailSig = sig
  const scroll = el.querySelector('.d-body')?.scrollTop || 0
  el.style.setProperty('--c', colorOf(t.id))
  const tabs = tabsFor(t, false)
  if (!tabs.some(([k]) => k === open.tab)) open.tab = 'chats'
  el.innerHTML = `<div class="d-head">${headHtml(t, false, tabs)}</div>
    <div class="d-body"><div>${tabBody(t, false)}</div><div>${sideHtml(t)}</div></div>`
  el.querySelector('.d-body').scrollTop = scroll
}

function renderPage(force) {
  if (!page || !data) return
  const t = byId(page.taskId)
  if (!t) return closeMaster()
  const saved = open
  open = null // so S() is the page while it draws
  try {
    const el = $('#page')
    const sig = JSON.stringify([t, kidsOf(t.id).map(subtree), page.tab, [...page.openSteps], page.editPlan, page.editMaster, Math.floor(Date.now() / 60000)])
    if (!force && (sig === pageSig || busy(el))) return
    pageSig = sig
    const scroll = el.scrollTop
    el.style.setProperty('--c', colorOf(t.id))
    const tabs = tabsFor(t, true)
    if (!tabs.some(([k]) => k === page.tab)) page.tab = 'overview'
    document.title = `${t.title} · ${data.project.name}`
    el.innerHTML = `<div class="d-head page-head">${headHtml(t, true, tabs)}</div>
      <div class="page-body">${page.tab === 'overview' ? overviewHtml(t) : `<div class="d-body page-cols"><div>${tabBody(t, true)}</div><div>${sideHtml(t)}</div></div>`}</div>`
    el.scrollTop = scroll
  } finally { open = saved }
}

// Master task overview: 60% modules and their tasks · 20% chats · 20% must-dos and to-dos.
function overviewHtml(t) {
  const mods = kidsOf(t.id)
  const order = { working: 0, idle: 1, offline: 2, ended: 3 }
  const tree = subtree(t)
  const chats = tree.flatMap(x => x.linked.map(s => ({ s, x }))).sort((a, b) => order[a.s.live] - order[b.s.live] || (b.s.updatedAt || 0) - (a.s.updatedAt || 0))
  const modCard = m => {
    const p = m.plan, st = sessionStatus(m), tasks = kidsOf(m.id)
    return `<div class="note l2 ov-mod ${m.status === 'done' ? 'is-done' : ''}" data-task="${esc(m.id)}" style="--c:${colorOf(m.id)}">
      <div class="lvl">${levelLabel(m)}${m.status !== 'active' ? ` · ${esc(m.status)}` : ''}</div>
      ${blockedBadge(m)}${ownerChip(m) ? `<div class="ownrow">${ownerChip(m)}</div>` : ''}
      <h3>${esc(m.title)}</h3>
      ${m.description ? `<div class="desc">${esc(m.description)}</div>` : ''}
      ${p.total ? `<div class="next">${p.next ? `Next: <b>${esc(p.next.id)}</b> – ${esc(p.next.text)}` : '<b>All steps done</b>'}</div><div class="progress"><i style="width:${Math.round((p.done / p.total) * 100)}%"></i></div>` : ''}
      ${tasks.length ? `<div class="l3list">${tasks.map(k => `<div class="l3row ${k.status === 'done' ? 'is-done' : ''}" data-task="${esc(k.id)}"><span class="dot ${liveOf(k)}"></span><span class="t">${blockersOf(k).length ? '⛔ ' : ''}${k.bug ? '🐞 ' : ''}${openFixesOf(k).length ? '🐞 ' : ''}${esc(k.title)}</span>
          <span class="nx small">${k.status === 'done' ? 'done' : k.plan.next ? `${esc(k.plan.next.id)} – ${esc(k.plan.next.text)}` : ''}</span></div>`).join('')}</div>` : ''}
      <div class="row-add"><button class="add-sub small" data-addsub="${esc(m.id)}">+ Task</button></div>
      <div class="status ${st.cls}"><span class="dot"></span>${esc(st.text)}</div>
    </div>`
  }
  const items = kind => tree.flatMap(x => x.items.filter(i => i.kind === kind && !i.done).map(i => ({ i, x })))
  const itemList = kind => {
    const l = items(kind)
    return l.length ? l.map(({ i, x }) => `<label class="item"><input type="checkbox" data-item="${esc(i.id)}" data-owner="${esc(x.id)}"><span>${esc(i.text)}${x.id !== t.id ? `<br><button class="crumb small muted" data-open="${esc(x.id)}">${esc(x.title)}</button>` : ''}</span></label>`).join('') : '<div class="small muted" style="padding:2px 4px">None</div>'
  }
  return `<div class="ov">
    <section class="ov-col ov-main"><h4>Modules and tasks <span class="count">${mods.length}</span></h4>
      ${mods.length ? `<div class="ov-mods">${mods.map(modCard).join('')}</div>` : `<div class="card muted">No modules yet. Break the master plan down here, or ask the planning chat to (board_create_task).</div>`}
      <form class="items-add" data-addsubform><input name="title" placeholder="New module…" required><button class="btn small primary">Add module</button></form>
      <h4 style="margin-top:22px">Linked tasks <span class="count">${externalLinks(t).length}</span></h4>
      <div class="card linked">${linkedHtml(t)}</div>
    </section>
    <section class="ov-col"><h4>Chats <span class="count">${chats.length}</span></h4>
      ${chats.length ? chats.map(({ s, x }) => `<div class="mini-chat"><span class="dot ${s.live}"></span>
        <div class="t"><b>${esc(s.title || 'Chat')}</b><div class="small muted">${x.id === t.id ? 'master task' : `<button class="crumb" data-open="${esc(x.id)}">${esc(x.title)}</button>`} · ${esc(s.workspaceLabel || '')} · ${s.live === 'working' ? `working ${dur(s.turnStartedAt)}` : ago(s.updatedAt)}</div></div>
        <button class="icon-btn" data-jumpid="${esc(s.sessionId)}" title="Open chat">↗</button></div>`).join('') : '<div class="small muted">No chats linked yet.</div>'}
    </section>
    <section class="ov-col"><h4>Mandatory</h4>${itemList('mandatory')}
      <h4 style="margin-top:14px">To do</h4>${itemList('todo')}
      <form class="items-add" data-additem><select name="kind"><option value="mandatory">Mandatory</option><option value="todo" selected>To do</option></select><input name="text" placeholder="Add…" required><button class="btn small">Add</button></form>
      ${decisionsFor(t).open ? `<div class="card hl" data-tabjump="decisions" style="cursor:pointer;margin-top:14px"><b>${decisionsFor(t).open} open decision${decisionsFor(t).open > 1 ? 's' : ''}</b><div class="small muted">Decisions tab</div></div>` : ''}
    </section>
  </div>`
}

function chatsHtml(t, rollup) {
  // On a master task, every chat in its tree, tagged with the task it works on.
  const list = rollup ? subtree(t).flatMap(x => x.linked.map(s => ({ ...s, _task: x }))) : t.linked
  if (!list.length) return `<div class="card muted">No chats linked yet. In a chat, type <code>/task ${esc(t.id)}</code> or pick it under “Unlinked chats”.</div>`
  const order = { working: 0, idle: 1, offline: 2, ended: 3 }
  return `<h4>Pick a chat to jump to</h4>` + [...list].sort((a, b) => order[a.live] - order[b.live] || (b.updatedAt || 0) - (a.updatedAt || 0)).map(s => `
    <div class="chat">
      <div class="row"><span class="t">${esc(s.title || 'Chat')}${s._task && s._task.id !== t.id ? ` <button class="crumb small muted" data-open="${esc(s._task.id)}">${esc(s._task.title)}</button>` : ''}</span>
        <span class="badge ${s.live}">${s.live === 'working' ? `working · ${dur(s.turnStartedAt)}` : s.live}</span>
        <button class="btn small primary" data-jumpid="${esc(s.sessionId)}" data-ws="${esc(s.workspace || '')}">Open chat ↗</button></div>
      <div class="small muted">${esc(s.workspaceLabel || '')}${s.subfolder ? ` / ${esc(s.subfolder)}` : ''}${s.branch ? ` · ${esc(s.branch)}` : ''} · ${ago(s.updatedAt)}${t.lastAction?.sessionId === s.sessionId ? ' · <b>did the last action</b>' : ''}</div>
      ${s.lastPrompt ? `<div class="p"><b>Asked:</b> ${esc(s.lastPrompt)}</div>` : ''}
      ${s.lastAnswer ? `<div class="p"><b>Answered:</b> ${esc(s.lastAnswer)}</div>` : ''}
      <div class="row small"><button class="btn small" data-unlink="${esc(s.sessionId)}">Unlink</button><button class="btn small" data-copy="claude --resume ${esc(s.sessionId)}">Copy resume command</button></div>
    </div>`).join('')
}

function livingHtml(t) {
  if (S().editLiving) return `<div class="card"><h4>Living handoff</h4>
    <textarea class="plan" id="livingText" spellcheck="false" style="min-height:260px">${esc(t.living || '')}</textarea>
    <div style="display:flex;gap:8px;margin-top:8px"><button class="btn primary small" data-saveliving>Save</button><button class="btn small" data-editliving="0">Cancel</button></div></div>`
  return `<div class="card living"><h4 style="display:flex;justify-content:space-between">Living handoff <span>
      <button class="btn small" data-copy="/task ${esc(t.id)}" title="Paste in a new chat to continue this task">Copy resume</button>
      <button class="btn small" data-editliving="1">Edit</button></span></h4>
    ${t.living ? md(t.living) : '<div class="small muted">Not written yet. In Board Mode, Claude rewrites it at each checkpoint (/checkpoint).</div>'}</div>`
}

// ---------- decisions ----------
// own: filed on this task · up: raised here, filed at a higher level · inherited: parents' decisions
function decisionsFor(t) {
  const anc = ancestors(t)
  const own = t.decisions || []
  const up = anc.flatMap(a => (a.decisions || []).filter(d => d.raisedFrom?.id === t.id))
  const inherited = anc.flatMap(a => (a.decisions || []).filter(d => d.raisedFrom?.id !== t.id))
  const legacy = t.items.filter(i => i.kind === 'decision')
  const open = [...own, ...up].filter(d => d.status === 'open').length + legacy.filter(i => !i.done).length
  return { own, up, inherited, legacy, open }
}

function refHtml(r) {
  if (/^https?:\/\//.test(r)) return `<a href="${esc(r)}" target="_blank" rel="noopener">${esc(r)}</a>`
  return `<code>${esc(r)}</code> <button class="ho" data-copy="${esc(r)}">Copy</button>`
}

function decisionCard(d, here) {
  const decided = d.status === 'decided', dropped = d.status === 'dropped'
  const reg = d.rec?.register && (data.project.registers || []).find(r => r.id === d.rec.register || r.topic === d.rec.register)
  const impl = d.rec?.implemented
  return `<div class="dcard ${d.status} ${d.rec ? 'rec' : ''}">
    <div class="dhead">${d.rec ? `<span class="rnum">${esc(d.rec.r)}</span>` : ''}<span class="lvlb">L${d.level} ${d.rec ? 'recommendation' : 'decision'}</span><b>${esc(d.title)}</b>
      <span class="badge ${decided ? 'working' : ''}">${esc(d.status)}</span><span class="small muted">${esc(d.id)}</span></div>
    <div class="small muted">${d.owner !== here ? `Filed on ${LEVELS[d.level].toLowerCase()} <button class="crumb" data-open="${esc(d.owner)}">${esc(d.ownerTitle)}</button>` : ''}${d.raisedFrom ? `${d.owner !== here ? ' · ' : ''}raised in <button class="crumb" data-open="${esc(d.raisedFrom.id)}">${esc(d.raisedFrom.title)}</button>` : ''} · ${ago(d.at)}</div>
    ${d.rec ? `<div class="small">${d.rec.area ? `<b>Area:</b> ${esc(d.rec.area)} · ` : ''}${reg ? `Also in the <a href="${esc(reg.url)}" target="_blank" rel="noopener">${esc(reg.topic)} register ↗</a>` : 'Board register'}</div>` : ''}
    ${d.description ? `${d.rec ? '<div class="small"><b>Reason:</b></div>' : ''}${md(d.description)}` : ''}
    ${d.options ? `<div class="small"><b>Options / recommendation:</b></div>${md(d.options)}` : ''}
    ${d.rec?.lldCheck ? `<div class="small"><b>LLD check:</b> ${esc(d.rec.lldCheck)}</div>` : ''}
    ${d.rec && decided ? (impl ? `<div class="impl"><b>How implemented</b>${['problem', 'approach', 'api', 'code', 'tests'].filter(k => impl[k]).map(k => `<div class="small"><b>${{ problem: 'Problem', approach: 'Approach', api: 'New API', code: 'Code', tests: 'Tests' }[k]}:</b> ${esc(impl[k])}</div>`).join('')}</div>`
      : `<details class="impl"><summary class="small">Record how it was implemented</summary><form class="dform" data-dimpl="${esc(d.id)}" data-owner="${esc(d.owner)}">
          <input name="problem" placeholder="Problem"><input name="approach" placeholder="Approach"><input name="api" placeholder="New API (method, path, purpose, responses)">
          <input name="code" placeholder="Code (repo, branch, commit, classes)"><input name="tests" placeholder="Tests"><button class="btn small primary">Save</button></form></details>`) : ''}
    ${d.refs?.length ? `<div class="small"><b>References:</b></div><ul class="refs">${d.refs.map(r => `<li>${refHtml(r)}</li>`).join('')}</ul>` : ''}
    ${decided || dropped ? `<div class="verdict"><b>${decided ? 'Verdict' : 'Dropped'}</b>${d.decidedAt ? ` · ${ago(d.decidedAt)}` : ''}: ${esc(d.verdict || '—')}
        <button class="ho" data-dreopen="${esc(d.id)}" data-owner="${esc(d.owner)}">Reopen</button></div>`
      : `<form class="items-add" data-dverdict="${esc(d.id)}" data-owner="${esc(d.owner)}"><input name="verdict" placeholder="Verdict (what was decided, by whom)…" required>
        <button class="btn small primary" name="act" value="decided">Decide</button><button type="button" class="btn small" data-ddrop="${esc(d.id)}" data-owner="${esc(d.owner)}">Drop</button></form>`}
  </div>`
}

function decisionsHtml(t) {
  const { own, up, inherited, legacy } = decisionsFor(t)
  const sort = a => [...a].sort((x, y) => (x.status === 'open' ? 0 : 1) - (y.status === 'open' ? 0 : 1) || y.at - x.at)
  let h = `<div class="small muted" style="margin-bottom:10px">Claude files each decision at the level it affects: a broad question that comes up in a task is filed on the module or master task, and stays mapped to the task where it was raised.</div>`
  h += `<h4>On this ${LEVELS[t.level].toLowerCase()} (${own.length})</h4>` + (own.length ? sort(own).map(d => decisionCard(d, t.id)).join('') : '<div class="small muted">None.</div>')
  if (up.length) h += `<h4 style="margin-top:16px">Raised here, filed higher up (${up.length})</h4>` + sort(up).map(d => decisionCard(d, t.id)).join('')
  if (inherited.length) h += `<h4 style="margin-top:16px">From parent levels (${inherited.length})</h4>` + sort(inherited).map(d => decisionCard(d, t.id)).join('')
  if (legacy.length) h += `<h4 style="margin-top:16px">Quick decision notes</h4>` + legacy.map(i => `<label class="item ${i.done ? 'done' : ''}"><input type="checkbox" ${i.done ? 'checked' : ''} data-item="${esc(i.id)}"><span>${esc(i.text)}</span></label>`).join('')
  const anc = ancestors(t)
  h += `<div class="card" style="margin-top:16px"><h4>New decision</h4><form class="dform" data-dadd>
    <input name="title" placeholder="The question to decide" required>
    <textarea name="description" rows="3" placeholder="Context: what's being decided and why it matters"></textarea>
    <textarea name="options" rows="2" placeholder="Options / recommendation (optional)"></textarea>
    <textarea name="refs" rows="2" placeholder="References, one per line: handoff paths, docs, URLs (optional)"></textarea>
    <label class="row small"><input type="checkbox" name="rec"> Recommendation for the register (gets an R#)</label>
    <div class="recfields"><input name="area" placeholder="Area (recommendations)"><input name="lldCheck" placeholder="LLD check (what the spec says)">
      <select name="register"><option value="">Board register</option>${(data.project.registers || []).map(r => `<option value="${esc(r.id)}">${esc(r.topic)} register</option>`).join('')}</select></div>
    <div style="display:flex;gap:8px;align-items:center"><span class="small muted">File at</span><select name="level">
      <option value="${t.level}">this ${LEVELS[t.level].toLowerCase()} (L${t.level})</option>
      ${[...anc].reverse().map(a => `<option value="${a.level}">${LEVELS[a.level].toLowerCase()}: ${esc(a.title)} (L${a.level})</option>`).join('')}
    </select><button class="btn small primary">Add decision</button></div></form></div>`
  return h
}

function subtasksHtml(t) {
  const kids = kidsOf(t.id)
  const what = t.level === 1 ? 'module' : 'task'
  let h = kids.length ? kids.map(k => {
    const nx = k.plan.next, st = sessionStatus(k), sub = kidsOf(k.id)
    return `<div class="chat" data-open="${esc(k.id)}" style="cursor:pointer">
      <div class="row"><span class="dot ${liveOf(k)}" style="width:8px;height:8px;border-radius:50%;background:var(--${liveOf(k) === 'working' ? 'working' : liveOf(k) === 'idle' ? 'idle' : 'offline'})"></span>
        <span class="t">${esc(k.title)}</span><span class="badge">${esc(k.status)}</span></div>
      ${k.description ? `<div class="p">${esc(k.description)}</div>` : ''}
      <div class="small muted">${nx ? `Next: ${esc(nx.id)} – ${esc(nx.text)}` : k.plan.total ? 'All steps done' : 'No plan yet'}${sub.length ? ` · ${sub.length} task${sub.length > 1 ? 's' : ''}` : ''} · ${esc(st.text)}</div>
    </div>`
  }).join('') : `<div class="card muted">No ${what}s yet.</div>`
  if (t.level < 3) h += `<form class="items-add" data-addsubform><input name="title" placeholder="New ${what} title…" required><button class="btn small primary">Add ${what}</button></form>
    <div class="small muted" style="margin-top:6px">You can also turn a plan step into a ${what} from the Plan tab.</div>`
  else h += `<div class="small muted" style="margin-top:8px">Tasks are the lowest level. Promote this task to break it down further.</div>`
  return h
}

// ---------- Plan & Docs: master plan, phase plan, mapped documents ----------
const DOC_KINDS = ['Tech spec', 'HLD', 'LLD', 'API spec', 'Design', 'Runbook', 'Reference', 'Other']

function planDocsHtml(t) {
  return masterPlanHtml(t) + phasePlanHtml(t) + docsHtml(t)
}

function masterPlanHtml(t) {
  if (t.level !== 1) {
    const m = ancestors(t)[0]
    if (!m) return ''
    return `<div class="card"><h4 class="hrow">Master plan · ${esc(m.title)} <button class="btn small" data-togglemaster>${S().showMaster ? 'Hide' : 'Show'}</button></h4>
      ${S().showMaster ? (m.masterPlan ? md(m.masterPlan) : '<div class="small muted">Not written yet.</div>') : `<div class="small muted">This ${LEVELS[t.level].toLowerCase()} is part of the master plan of <button class="crumb" data-open="${esc(m.id)}">${esc(m.title)}</button>.</div>`}</div>`
  }
  if (S().editMaster) return `<div class="card"><h4>Master plan</h4>
    <textarea class="plan" id="masterText" spellcheck="false" style="min-height:340px" placeholder="# Implementation plan&#10;Goal · scope · architecture · modules and their tasks · sequencing · risks">${esc(t.masterPlan || '')}</textarea>
    <div class="hrow" style="margin-top:8px"><span><button class="btn primary small" data-savemaster>Save master plan</button> <button class="btn small" data-editmaster="0">Cancel</button></span></div></div>`
  return `<div class="card master"><h4 class="hrow">Master plan <span><button class="btn small" data-copy="${esc(t.masterPlanPath)}" title="Copy the file path">Copy path</button> <button class="btn small" data-editmaster="1">${t.masterPlan ? 'Edit' : 'Write my own'}</button></span></h4>
    ${t.masterPlan ? md(t.masterPlan) : `<div class="small muted">No master plan yet. The planning chat drafts the implementation plan first (<code>board_master_plan</code>) and breaks the modules and tasks down from it — or write your own.</div>`}</div>`
}

function phasePlanHtml(t) {
  const p = t.plan
  if (S().editPlan) return `<div class="card"><h4>Plan · phases</h4>
    <textarea class="plan" id="planText" spellcheck="false" placeholder="## Phase A — Name&#10;- [ ] A1 First step&#10;- [ ] A2 Second step">${esc(t.planMd)}</textarea>
    <div class="hrow" style="margin-top:8px"><span><button class="btn primary small" data-saveplan>Save plan</button> <button class="btn small" data-editplan="0">Cancel</button></span><span class="small muted">“- [ ] A1 name” lines; the first unticked one is the next step.</span></div></div>`
  let h = `<div class="card"><h4 class="hrow">Plan · phases <button class="btn small" data-editplan="1">${p.total ? 'Edit' : 'Write'}</button></h4>`
  if (!p.total) return h + `<div class="small muted">No phase checklist yet.</div></div>`
  const notes = new Set(t.handoffs.map(x => x.step.toLowerCase()))
  h += p.next ? `<div class="nextline">Next: <b>${esc(p.next.id)}</b> – ${esc(p.next.text)}</div>` : `<div class="nextline"><b>Every step is done.</b></div>`
  for (const ph of p.phases) {
    h += `<div class="phase"><h5>${esc(ph.title)}</h5>`
    for (const s of ph.steps) {
      const child = s.childId && byId(s.childId)
      h += `<div class="step ${s.done ? 'done' : ''} ${p.next && p.next.id === s.id ? 'next' : ''}">
        <input type="checkbox" ${s.done ? 'checked' : ''} data-step="${esc(s.id)}" aria-label="Done">
        <span class="sid">${esc(s.id)}</span><span class="stx">${esc(s.text)}</span>
        ${child ? `<button class="ho" data-open="${esc(child.id)}" title="This step is its own ${LEVELS[child.level].toLowerCase()}">→ ${esc(child.title)}</button>`
          : t.level < 3 && !s.done ? `<button class="ho sub" data-step2task="${esc(s.id)}" data-text="${esc(s.text)}" title="Make this step a ${t.level === 1 ? 'module' : 'task'} of its own">→ ${t.level === 1 ? 'module' : 'task'}</button>` : ''}
        ${notes.has(s.id.toLowerCase()) ? `<button class="ho" data-tabjump="handoff" title="This step has a note in the Handoff tab">note</button>` : ''}</div>`
    }
    h += `</div>`
  }
  return h + `</div>`
}

function docRow(d, removable, from) {
  const url = /^https?:\/\//i.test(d.ref)
  return `<div class="doc"><span class="lvlb">${esc(d.kind)}</span>
    <div class="t"><b>${esc(d.title)}</b>${from ? ` <span class="small muted">· from ${from}</span>` : ''}<div class="small mono">${esc(d.ref)}</div>${d.note ? `<div class="small muted">${esc(d.note)}</div>` : ''}</div>
    <span class="acts"><button class="ho" data-opendoc="${esc(d.ref)}">${url ? 'Open ↗' : 'Open'}</button><button class="ho" data-copy="${esc(d.ref)}">Copy</button>${removable ? `<button class="ho" data-rmdoc="${esc(d.id)}" title="Remove">✕</button>` : ''}</span></div>`
}

function docsHtml(t) {
  const own = t.docs || []
  const inherited = ancestors(t).flatMap(a => (a.docs || []).map(d => ({ d, a })))
  return `<div class="card"><h4>Docs & references</h4>
    <div class="small muted" style="margin-bottom:8px">Specs and designs this ${LEVELS[t.level].toLowerCase()} relies on. Chats see the list and read a document only when the step needs it.</div>
    ${own.length ? own.map(d => docRow(d, true)).join('') : '<div class="small muted">None mapped here yet.</div>'}
    ${inherited.length ? `<h5 style="margin:12px 0 4px">From parent levels</h5>${inherited.map(({ d, a }) => docRow(d, false, `${LEVELS[a.level].toLowerCase()} ${esc(a.title)}`)).join('')}` : ''}
    <form class="docform" data-adddoc>
      <select name="kind">${DOC_KINDS.map(k => `<option>${k}</option>`).join('')}</select>
      <input name="title" placeholder="Title (optional)">
      <input name="ref" placeholder="File path or URL" required spellcheck="false">
      <input name="note" placeholder="What it covers / when to read it">
      <button class="btn small primary">Add</button>
    </form></div>`
}

// ---------- workspace ownership ----------
const repoRow = r => `<div class="repo"><b>${esc(r.name)}</b> <span class="mono small">${esc(r.branch)} @ ${esc(r.head)}</span>
  <span class="rs ${!r.upstream || r.ahead ? 'bad' : 'ok'}">${!r.upstream ? 'not pushed' : r.ahead ? `${r.ahead} not pushed` : 'pushed'}</span>
  <span class="rs ${r.dirty ? 'bad' : 'ok'}">${r.dirty ? `${r.dirty} uncommitted` : 'clean'}</span>${r.behind ? `<span class="rs">${r.behind} behind</span>` : ''}</div>`

function workspaceCard(t) {
  const roots = data.project.roots || []
  if (t.level === 3) {
    const h = ownerHolderOf(t)
    return `<div class="card"><h4>Workspace</h4>${h ? `${ownerChip(t)} <span class="small muted">via ${esc(levelLabel(h).toLowerCase())} <button class="crumb" data-open="${esc(h.id)}">${esc(h.title)}</button></span>` : '<span class="small muted">No owner yet — the first chat that links to its module claims it.</span>'}
      ${(t.overrides || []).length ? `<div class="small muted" style="margin-top:6px">Overrides: ${t.overrides.map(o => `${esc(o.workspace)} (${ago(o.at)})`).join(', ')}</div>` : ''}</div>`
  }
  const o = t.owner
  const hist = (t.ownerHistory || []).slice(-4).reverse()
  return `<div class="card"><h4>Workspace</h4>
    <div class="svcrow" style="grid-template-columns:1fr"><select data-owner-set><option value="">${o ? 'Release (nobody)' : 'Nobody owns it'}</option>
      ${roots.map(r => `<option value="${esc(r.path)}" ${o && normP(o.root) === normP(r.path) ? 'selected' : ''}>${o && normP(o.root) === normP(r.path) ? (o.state === 'soft' ? '🤝 ready to pick up · ' : '🏠 ') : ''}${esc(r.label)}</option>`).join('')}</select></div>
    ${o ? `<div class="hrow" style="margin-top:8px">${o.state === 'soft'
        ? `<span class="small">Soft-released ${ago(o.softAt)} — any workspace can take over.</span><button class="btn small" data-reclaim>Reclaim</button>`
        : `<span class="small muted">Owned since ${ago(o.since)}</span><button class="btn small" data-softrelease title="Let another workspace pick it up from the pushed branch">Soft release</button>`}</div>` : ''}
    ${o?.state === 'soft' && o.pickup?.length ? `<div class="small" style="margin-top:8px"><b>Pickup point</b></div>${o.pickup.map(repoRow).join('')}` : ''}
    <div id="relcheck"></div>
    ${hist.length ? `<div class="small muted" style="margin-top:8px">${hist.map(x => `${esc(x.type)}${x.from ? ` from ${esc(x.from)}` : ''}${x.to ? ` → ${esc(x.to)}` : ''} · ${ago(x.at)}`).join('<br>')}</div>` : ''}
  </div>`
}
const normP = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()

// ---------- Handoff: the agent's living handoff and per-step notes ----------
function handoffHtml(t) {
  let h = `<div class="small muted" style="margin-bottom:10px">For chat-to-chat transfer: the living handoff is what a new chat resumes from (rewritten at each <code>/checkpoint</code>); step notes record each finished phase.</div>`
  h += livingHtml(t)
  const holder = ownerHolderOf(t)
  if (t.repoState?.length || holder?.owner?.pickup?.length) h += `<div class="card"><h4 class="hrow">Repo state <span class="small muted">${t.repoState?.length ? `at the last checkpoint · ${ago(Math.max(...t.repoState.map(r => r.at)))}` : ''}</span></h4>
    ${(t.repoState || []).map(repoRow).join('')}
    ${holder?.owner?.state === 'soft' ? `<div class="small" style="margin-top:8px"><b>Soft-release pickup point</b> (${esc(holder.owner.label)})</div>${holder.owner.pickup.map(repoRow).join('')}` : ''}</div>`
  h += `<div class="card"><h4>Step notes</h4>`
  h += t.handoffs.length ? t.handoffs.map(o => `<div class="step"><span class="sid">${esc(o.step)}</span><span class="stx small muted">${ago(o.at)}</span>
      <button class="ho" data-ho="${esc(o.step)}">${S().openSteps.has(o.step) ? 'Hide' : 'Open'}</button></div>
      ${S().openSteps.has(o.step) ? `<div class="handoff" data-hobody="${esc(o.step)}" data-task="${esc(t.id)}">Loading…</div>` : ''}`).join('')
    : '<div class="small muted">None yet.</div>'
  queueMicrotask(loadHandoffs)
  return h + `</div>`
}
async function loadHandoffs() {
  for (const el of document.querySelectorAll('[data-hobody]')) {
    if (el.dataset.loaded) continue
    el.dataset.loaded = '1'
    const r = await api(`handoff?project=${encodeURIComponent(projectId)}&task=${encodeURIComponent(el.dataset.task)}&step=${encodeURIComponent(el.dataset.hobody)}`)
    el.innerHTML = md(r.markdown) || '<span class="muted">Empty</span>'
  }
}

function sideHtml(t) {
  let h = `<div class="card"><h4>Last action</h4>${t.lastAction ? `<div>${esc(t.lastAction.text)}</div><div class="small muted" style="margin:4px 0 8px">${esc(t.lastAction.workspaceLabel)} · ${ago(t.lastAction.at)}</div><button class="btn small" data-jumpid="${esc(t.lastAction.sessionId)}">Open that chat ↗</button>` : '<span class="muted">Nothing yet</span>'}</div>`
  h += workspaceCard(t)
  if (t.status === 'done' || openFixesOf(t).length) h += `<div class="card"><h4>Bugs</h4>
    ${openFixesOf(t).map(f => `<div class="lrow"><span class="t">🐞 <button class="crumb" data-open="${esc(f.id)}">${esc(f.title)}</button><div class="small muted">${esc(pathOf(f))} · ${esc(f.status)}</div></span></div>`).join('') || '<div class="small muted">No open fixes.</div>'}
    <button class="btn small" data-reportbug style="margin-top:6px">🐞 Report a bug in this</button></div>`
  // Services: kind and main service on master tasks; tags (auto-added from edited files) on all.
  const svcs = svcList()
  h += `<div class="card"><h4>Services</h4>
    ${t.level === 1 ? `<div class="svcrow"><select data-kind><option value="feature" ${t.kind !== 'backlog' ? 'selected' : ''}>Feature</option><option value="backlog" ${t.kind === 'backlog' ? 'selected' : ''}>Service backlog</option></select>
      <select data-mainsvc><option value="">${t.kind === 'backlog' ? 'Service…' : 'Main service…'}</option>${svcs.map(s => `<option value="${esc(s.id)}" ${t.mainService === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('')}</select></div>` : ''}
    <div class="chips" style="margin:6px 0">${(t.services || []).map(s => `<span class="svc">${esc(svcName(s))} <button class="x" data-rmsvc="${esc(s)}" title="Remove tag">✕</button></span>`).join('') || '<span class="small muted">No service tags yet — added automatically when a chat edits files.</span>'}</div>
    ${svcs.length ? `<select data-addsvc><option value="">+ Tag a service…</option>${svcs.filter(s => !(t.services || []).includes(s.id)).map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select>` : '<div class="small muted">Set up the board\'s services in ⚙.</div>'}
  </div>`
  if (!(page && !open && page.tab === 'overview')) h += `<div class="card linked"><h4>Linked tasks</h4>${linkedHtml(t, true)}</div>`
  const anc = ancestors(t)
  if (anc.length || t.origin?.length) {
    h += `<div class="card"><h4>Parent context</h4>`
    for (const a of [...anc].reverse()) {
      const obj = (a.living || '').split(/\r?\n/).find(l => /^\s*(objective|goal)\s*:/i.test(l))
      h += `<div class="pctx"><button class="crumb" data-open="${esc(a.id)}">${LEVELS[a.level]}: ${esc(a.title)}</button>
        <div class="small muted">${esc(obj ? obj.replace(/^\s*\w+\s*:\s*/, '') : a.description || 'No handoff yet')}</div></div>`
    }
    for (const o of t.origin || []) if (byId(o.id)) h += `<div class="pctx"><button class="crumb" data-open="${esc(o.id)}">Former parent: ${esc(o.title)}</button></div>`
    h += `<div class="small muted" style="margin-top:6px">Chats on this task see these summaries and read the full handoffs when needed.</div></div>`
  }
  const dOpen = decisionsFor(t).open
  if (dOpen) h += `<div class="card hl" data-tabjump="decisions" style="cursor:pointer"><b>${dOpen} open decision${dOpen > 1 ? 's' : ''}</b> <span class="small muted">— see the Decisions tab</span></div>`
  h += `<div class="card"><h4>Important</h4>`
  for (const [kind, label] of KINDS.filter(([k]) => k !== 'decision')) {
    const items = t.items.filter(i => i.kind === kind)
    h += `<div class="kind-h ${kind}">${label}</div>`
    h += items.length ? items.map(i => `<label class="item ${i.done ? 'done' : ''}"><input type="checkbox" ${i.done ? 'checked' : ''} data-item="${esc(i.id)}"><span>${esc(i.text)}</span><button class="x" data-delitem="${esc(i.id)}" title="Delete">✕</button></label>`).join('') : '<div class="small muted" style="padding:2px 4px">None</div>'
  }
  h += `<form class="items-add" data-additem><select name="kind">${KINDS.filter(([k]) => k !== 'decision').map(([k, l]) => `<option value="${k}">${l.replace('Open ', '')}</option>`).join('')}</select><input name="text" placeholder="Add…" required><button class="btn small">Add</button></form></div>`
  return h
}

// ---------- jump ----------
async function jump(sessionId, workspace) {
  if (!sessionId) return
  try {
    const r = await api('jump', { project: projectId, sessionId })
    if (r.how === 'app') return toast('Opening the chat in the Claude app…')
    if (r.how === 'vscode') return toast('Opening the workspace in VS Code, then the chat in the Claude panel…', 5000)
    showResume(r)
  } catch (e) { toast('Could not open: ' + e.message) }
}

// ---------- move ----------
function openMove(t) {
  const inside = new Set(subtree(t).map(x => x.id))
  const height = x => 1 + Math.max(0, ...kidsOf(x.id).map(height))
  const h = height(t)
  const dests = [{ id: '', label: 'Top level — make it a master task', level: 0 }]
    .concat(data.tasks.filter(x => x.level < 3 && !inside.has(x.id) && x.id !== t.parentId).map(x => ({ id: x.id, label: pathOf(x) + (x.kind === 'backlog' ? '  (service backlog)' : ''), level: x.level })))
    .filter(d => d.level + 1 + h - 1 <= 3)
    .filter(d => !(d.id === '' && t.level === 1))
  const dlg = $('#moveDlg'), f = dlg.querySelector('form')
  dlg.dataset.task = t.id
  $('#moveInfo').textContent = `Move “${t.title}”${kidsOf(t.id).length ? ' and its subtasks' : ''}. It keeps its plan, handoffs, chats and links.`
  f.dest.innerHTML = dests.map(d => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('')
  dlg.showModal()
}

function renderRoots() {
  const roots = data?.project?.roots || []
  $('#rootsList').innerHTML = roots.length
    ? roots.map(r => `<div class="root-row"><span class="p" title="${esc(r.path)}">${esc(r.path)}</span>
        <input value="${esc(r.label)}" data-rootlabel="${esc(r.path)}" aria-label="Label">
        <button type="button" class="btn small" data-rmroot="${esc(r.path)}">Remove</button></div>`).join('')
    : '<div class="small muted">No workspaces yet.</div>'
}

function showResume(r) {
  const d = $('#resume')
  d.querySelector('code').textContent = r.resume
  d.querySelector('[data-openws]').hidden = !r.workspace
  d.querySelector('[data-openws]').dataset.ws = r.workspace || ''
  d.querySelector('.ws').textContent = r.workspace ? `in ${r.workspace}` : 'in the folder the chat ran in'
  d.showModal()
}

// ---------- events ----------
document.addEventListener('click', async e => {
  const t = e.target
  const c = sel => t.closest(sel)
  if (c('[data-regf]')) { regFilter = c('[data-regf]').dataset.regf; return render() }
  if (c('#viewMode button')) { view = c('#viewMode button').dataset.v; localSet('view', view); return render() }
  if (c('#filter button')) { filter = c('#filter button').dataset.f; localSet('filter', filter); return render() }
  if (c('[data-ws]') && c('.chips')) return api('openWorkspace', { workspace: c('[data-ws]').dataset.ws }).then(() => toast('Opening workspace in VS Code…'))
  if (c('[data-jumpid]')) { e.stopPropagation(); return jump(c('[data-jumpid]').dataset.jumpid, c('[data-jumpid]').dataset.ws) }
  if (c('.note .last') && c('.last').dataset.jump) return jump(c('.last').dataset.jump)
  if (c('[data-addsub]')) {
    e.stopPropagation()
    const parent = byId(c('[data-addsub]').dataset.addsub)
    const what = parent.level === 1 ? 'module' : 'task'
    const title = prompt(`New ${what} under “${parent.title}”:`)
    if (title && title.trim()) await act('createTask', { title: title.trim(), parentId: parent.id })
    return
  }
  if (c('[data-openrow]')) return openAny(c('[data-openrow]').dataset.openrow, 'chats')
  if (c('[data-rmlink]')) { const b = c('[data-rmlink]'); if (confirm('Remove this link?')) await act('removeLink', { owner: b.dataset.rmlink, to: b.dataset.to, type: b.dataset.type }); return }
  if (c('[data-rmsvc]')) { const tk = byId(S().taskId); return act('setServices', { task: tk.id, services: (tk.services || []).filter(s => s !== c('[data-rmsvc]').dataset.rmsvc) }) }
  if (c('[data-move]')) return openMove(byId(S().taskId))
  if (c('[data-softrelease]')) {
    const out = $('#relcheck')
    try {
      const chk = await api('releaseCheck', { project: projectId, task: S().taskId })
      if (!chk.ok) { out.innerHTML = `<div class="relbad"><b>Not ready for a soft release</b><ul>${chk.problems.map(p => `<li>${esc(p)}</li>`).join('')}</ul></div>`; return }
      out.innerHTML = `<div class="small"><b>Ready</b> — another workspace can take over from:</div>${chk.pickup.map(repoRow).join('')}`
      if (confirm('Everything is pushed, clean and checkpointed. Soft-release it so another workspace can take over?')) { await act('softRelease', { task: S().taskId }); toast('Soft-released') }
    } catch (err) { out.innerHTML = `<div class="relbad">${esc(err.message)}</div>` }
    return
  }
  if (c('[data-reclaim]')) return act('reclaim', { task: S().taskId }).then(r => r && toast('Reclaimed'))
  if (c('[data-reportbug]')) {
    const orig = byId(S().taskId)
    const title = prompt(`Bug in “${orig.title}” — short title for the fix task:`)
    if (!title || !title.trim()) return
    const parentId = orig.level === 3 ? orig.parentId : orig.id
    const fix = await act('createTask', { title: title.trim(), parentId, bug: true, services: orig.services || [] })
    if (fix) { await act('addLink', { from: fix.id, to: orig.id, type: 'fixes' }); toast('Fix task created and linked'); openAny(fix.id, 'chats') }
    return
  }
  if (c('[data-closepage]')) return closeMaster()
  if (c('[data-editmaster]')) { S().editMaster = c('[data-editmaster]').dataset.editmaster === '1'; return rerender() }
  if (c('[data-savemaster]')) { await act('saveMasterPlan', { task: S().taskId, markdown: $('#masterText').value }); S().editMaster = false; toast('Master plan saved'); return rerender() }
  if (c('[data-togglemaster]')) { S().showMaster = !S().showMaster; return rerender() }
  if (c('[data-editplan]')) { S().editPlan = c('[data-editplan]').dataset.editplan === '1'; return rerender() }
  if (c('[data-opendoc]')) { try { const r = await api('openDoc', { ref: c('[data-opendoc]').dataset.opendoc }); toast(r.how === 'browser' ? 'Opening in your browser…' : 'Opening in VS Code…') } catch (err) { toast(err.message, 5000) } return }
  if (c('[data-rmdoc]')) { if (confirm('Remove this document from the task? (The file itself is not touched.)')) await act('removeDoc', { task: S().taskId, id: c('[data-rmdoc]').dataset.rmdoc }); return }
  if (c('[data-open-dec]')) return openAny(c('[data-open-dec]').dataset.openDec, 'decisions')
  if (c('[data-open]')) return openAny(c('[data-open]').dataset.open, 'plan')
  if (c('.l3row')) return openTask(c('.l3row').dataset.task, 'chats')
  if (c('.note')) return openAny(c('.note').dataset.task, 'chats')
  if (c('[data-promote]')) {
    const tk = byId(S().taskId)
    if (!confirm(`Promote “${tk.title}” to ${LEVELS[tk.level - 1]}?\nIt keeps its plan, handoffs and chats; its subtasks move up with it.`)) return
    await act('promoteTask', { task: tk.id }); return rerender()
  }
  if (c('[data-step2task]')) {
    const b = c('[data-step2task]')
    const title = prompt('Title for the new subtask:', b.dataset.text)
    if (title && title.trim()) { await act('createTask', { title: title.trim(), parentId: S().taskId, fromStep: b.dataset.step2task }); toast('Subtask created') }
    return
  }
  if (c('[data-ddrop]')) {
    const b = c('[data-ddrop]'), why = prompt('Why is this decision dropped? (optional)') ?? null
    if (why === null) return
    return act('updateDecision', { owner: b.dataset.owner, id: b.dataset.ddrop, patch: { status: 'dropped', verdict: why } })
  }
  if (c('[data-dreopen]')) { const b = c('[data-dreopen]'); return act('updateDecision', { owner: b.dataset.owner, id: b.dataset.dreopen, patch: { status: 'open' } }) }
  if (c('[data-editliving]')) { S().editLiving = c('[data-editliving]').dataset.editliving === '1'; return rerender() }
  if (c('[data-saveliving]')) { await act('saveLiving', { task: S().taskId, markdown: $('#livingText').value }); S().editLiving = false; toast('Handoff saved'); return rerender() }
  if (c('.pi')) return openAny(c('.pi').dataset.task, 'chats')
  if (c('[data-close]') || t.id === 'scrim') return closeTask()
  if (c('[data-tabjump]')) { S().tab = c('[data-tabjump]').dataset.tabjump; return rerender() }
  if (c('[data-tabset]')) { S().tab = c('[data-tabset]').dataset.tabset; return rerender() }
  if (c('[data-ho]')) { const id = c('[data-ho]').dataset.ho; S().openSteps.has(id) ? S().openSteps.delete(id) : S().openSteps.add(id); return rerender() }
  if (c('[data-unlink]')) return act('linkSession', { sessionId: c('[data-unlink]').dataset.unlink, task: null })
  if (c('[data-copyresume]')) { const cmd = $('#resume code').textContent; try { await navigator.clipboard.writeText(cmd); toast('Copied') } catch { toast(cmd, 8000) } return }
  if (c('[data-openws]')) { await api('openWorkspace', { workspace: c('[data-openws]').dataset.ws }); return toast('Opening the workspace in VS Code…') }
  if (c('[data-copy]')) { try { await navigator.clipboard.writeText(c('[data-copy]').dataset.copy); toast('Copied') } catch { toast(c('[data-copy]').dataset.copy, 8000) } return }
  if (c('[data-delitem]')) { e.preventDefault(); return act('deleteItem', { task: S().taskId, id: c('[data-delitem]').dataset.delitem }) }
  if (c('[data-saveplan]')) { await act('savePlan', { task: S().taskId, markdown: $('#planText').value }); toast('Plan saved'); S().tab = 'plan'; S().editPlan = false; return rerender() }
  if (t.id === 'newTask') {
    const title = prompt('Task title (e.g. SFTP, Peppol Hub, TICKET-123):')
    if (title && title.trim()) { const r = await act('createTask', { title: title.trim() }); if (r) openAny(r.id, 'plan') }
  }
  if (t.id === 'settingsBtn') {
    const s = await api('settings'); const f = $('#settings form')
    f.jumpUrl.value = s.jumpUrl; f.openWorkspaceInVSCode.checked = !!s.openWorkspaceInVSCode
    f.boardName.value = data?.project?.name || ''
    f.boardMode.checked = !!data?.project?.boardMode
    f.services.value = svcList().map(s => `${s.id} | ${s.name} | ${s.match.join(', ')}`).join('\n')
    f.rules.value = data?.project?.rules || ''
    f.registers.value = (data?.project?.registers || []).map(r => `${r.topic} | ${r.url}`).join('\n')
    renderRoots()
    $('#settings').showModal()
  }
  if (c('[data-addroot]')) {
    const f = $('#settings form')
    try {
      await api('addRoot', { project: projectId, root: f.newRoot.value, label: f.newLabel.value })
      f.newRoot.value = ''; f.newLabel.value = ''
      await refresh(); renderRoots(); toast('Workspace added')
    } catch (err) { toast(err.message, 5000) }
  }
  if (c('[data-rmroot]')) {
    const p = c('[data-rmroot]').dataset.rmroot
    if (!confirm(`Remove workspace ${p} from this board?\nIts tasks stay; chats there stop reporting to this board.`)) return
    await api('removeRoot', { project: projectId, root: p }); await refresh(); renderRoots()
  }
})
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && open) closeTask()
  if (e.key === 'Enter' && e.target.classList?.contains('note')) openAny(e.target.dataset.task, 'chats')
})
document.addEventListener('change', e => {
  const t = e.target
  if (t.matches('[data-owner-set]')) {
    if (!t.value) { if (!confirm('Release ownership? The next workspace to link to it claims it.')) return rerender(); return act('releaseOwner', { task: S().taskId }) }
    return act('setOwner', { task: S().taskId, root: t.value }).then(r => r && toast('Owner set'))
  }
  if (t.matches('[data-kind]')) return act('updateTask', { task: S().taskId, patch: { kind: t.value } })
  if (t.matches('[data-mainsvc]')) return act('setServices', { task: S().taskId, mainService: t.value || null })
  if (t.matches('[data-addsvc]') && t.value) { const tk = byId(S().taskId); return act('setServices', { task: tk.id, services: [...(tk.services || []), t.value] }) }
  if (t.dataset.rootlabel) return api('labelRoot', { project: projectId, root: t.dataset.rootlabel, label: t.value }).then(refresh).then(() => toast('Label saved'))
  if (t.dataset.uaboard !== undefined && t.value) {
    const s = t.dataset.uaboard
    return api('addRoot', { project: t.value, root: t.dataset.root, label: '' })
      .then(() => { toast('Workspace added — the chat joins the board on its next message'); picker() })
      .catch(err => toast(err.message, 5000))
  }
  if (t.dataset.link !== undefined && t.value) return act('linkSession', { sessionId: t.dataset.link, task: t.value }).then(() => toast('Chat linked'))
  if (t.dataset.step) return act('toggleStep', { task: S().taskId, step: t.dataset.step })
  if (t.dataset.item) return act('toggleItem', { task: t.dataset.owner || S().taskId, id: t.dataset.item })
  if (t.dataset.field) return act('updateTask', { task: S().taskId, patch: { [t.dataset.field]: t.value } })
})
document.addEventListener('submit', e => {
  if (e.target.matches('[data-addlink]')) {
    e.preventDefault()
    const f = e.target
    act('addLink', { from: S().taskId, to: f.to.value, type: f.type.value }).then(r => r && toast('Linked'))
    return
  }
  if (e.target.matches('[data-adddoc]')) {
    e.preventDefault()
    const f = e.target
    act('addDoc', { task: S().taskId, kind: f.kind.value, title: f.title.value.trim(), ref: f.ref.value.trim(), note: f.note.value.trim() })
      .then(r => { if (r) { toast('Document mapped'); f.reset() } })
    return
  }
  if (e.target.matches('[data-dadd]')) {
    e.preventDefault()
    const f = e.target
    act('addDecision', { task: S().taskId, level: Number(f.level.value), title: f.title.value.trim(), description: f.description.value, options: f.options.value, refs: f.refs.value,
      rec: f.rec.checked, area: f.area.value.trim(), lldCheck: f.lldCheck.value.trim(), register: f.register.value || null })
      .then(r => r && toast(Number(f.level.value) < byId(S().taskId).level ? 'Decision filed higher up and mapped to this task' : 'Decision added'))
    return
  }
  if (e.target.matches('[data-dimpl]')) {
    e.preventDefault()
    const f = e.target
    act('updateDecision', { owner: f.dataset.owner, id: f.dataset.dimpl, patch: { implemented: Object.fromEntries(['problem', 'approach', 'api', 'code', 'tests'].map(k => [k, f[k].value.trim()]).filter(([, v]) => v)) } })
      .then(r => r && toast('Implementation recorded'))
    return
  }
  if (e.target.matches('[data-dverdict]')) {
    e.preventDefault()
    const f = e.target
    act('updateDecision', { owner: f.dataset.owner, id: f.dataset.dverdict, patch: { verdict: f.verdict.value.trim(), status: 'decided' } })
    return
  }
  if (e.target.matches('[data-addsubform]')) {
    e.preventDefault()
    const title = e.target.title.value.trim()
    if (title) act('createTask', { title, parentId: S().taskId })
    return
  }
  if (e.target.matches('[data-additem]')) {
    e.preventDefault()
    const f = e.target
    act('addItem', { task: S().taskId, kind: f.kind.value, text: f.text.value.trim() })
    f.text.value = ''
  }
})
$('#settings').addEventListener('close', async () => {
  if ($('#settings').returnValue !== 'save') return
  const f = $('#settings form')
  await api('saveSettings', { patch: { jumpUrl: f.jumpUrl.value.trim(), openWorkspaceInVSCode: f.openWorkspaceInVSCode.checked } })
  if (projectId && f.boardName.value.trim() && f.boardName.value.trim() !== data?.project?.name)
    await api('renameBoard', { project: projectId, name: f.boardName.value.trim() })
  if (projectId && f.boardMode.checked !== !!data?.project?.boardMode)
    await api('setBoardMode', { project: projectId, on: f.boardMode.checked })
  if (projectId) {
    // One service per line: id | Name | folder pattern, folder pattern
    const services = f.services.value.split(/\r?\n/).map(l => l.split('|').map(x => x.trim())).filter(p => p[0])
      .map(([id, name, match]) => ({ id, name: name || id, match: (match || '').split(',').map(m => m.trim()).filter(Boolean) }))
    if (JSON.stringify(services.map(s => [s.id, s.name, s.match])) !== JSON.stringify(svcList().map(s => [s.id, s.name, s.match])))
      await api('saveServices', { project: projectId, services })
    if (f.rules.value !== (data.project.rules || '')) await api('saveRules', { project: projectId, rules: f.rules.value })
    const registers = f.registers.value.split(/\r?\n/).map(l => l.split('|').map(x => x.trim())).filter(p => p[0]).map(([topic, url]) => ({ topic, url: url || '' }))
    if (JSON.stringify(registers.map(r => [r.topic, r.url])) !== JSON.stringify((data.project.registers || []).map(r => [r.topic, r.url])))
      await api('saveRegisters', { project: projectId, registers })
  }
  await refresh()
  toast('Settings saved')
})
$('#moveDlg').addEventListener('close', async () => {
  const dlg = $('#moveDlg')
  if (dlg.returnValue !== 'move') return
  const r = await act('moveTask', { task: dlg.dataset.task, parentId: dlg.querySelector('form').dest.value || null })
  if (r) { toast('Moved'); if (open) renderDetail(true); if (page) renderPage(true) }
})
$('#scrim').addEventListener('click', closeTask)

// ---------- picker / start ----------
async function picker() {
  const [list, ua] = await Promise.all([api('projects'), api('unassigned')])
  const el = $('#picker'); el.hidden = false
  document.title = 'Project Board'
  el.innerHTML = `<div class="inner"><h2>Open a board</h2>
    <div class="muted">Each board lists the root folder of every copy of its project. Chats inside those folders report to it.</div>
    <div class="grid">${list.map(p => `<a class="proj" href="?project=${encodeURIComponent(p.id)}" style="text-decoration:none;color:inherit"><b>${esc(p.name)}</b>
      <div class="small muted">${p.tasks} task${p.tasks === 1 ? '' : 's'} · ${p.roots.map(r => esc(r.label)).join(', ') || 'no workspaces'}${p.working ? ` · <span style="color:var(--working)">${p.working} working</span>` : ''}</div></a>`).join('') || '<div class="muted">No boards yet.</div>'}</div>

    <div class="section"><h3>New board</h3>
      <div class="small muted">Name it, and give the root folder of one workspace copy. You can add the other copies in the board's ⚙ settings.</div>
      <form class="newboard" id="newBoard">
        <input name="name" placeholder="Board name (e.g. NEFX)" required>
        <input name="root" placeholder="Root folder (e.g. D:\\nfx)" required spellcheck="false">
        <input name="label" placeholder="Label (optional)">
        <button class="btn primary">Create</button>
      </form>
    </div>

    <div class="section"><h3>Chats with no board yet <span class="count">${ua.length}</span></h3>
      ${ua.length ? ua.map(s => `<div class="ua"><span class="dot ${s.live}" style="width:8px;height:8px;border-radius:50%;background:var(--${s.live === 'working' ? 'working' : 'idle'})"></span>
        <div class="t"><b>${esc(s.title || 'Chat')}</b><div class="small muted">${esc(s.cwd || s.workspace)} · ${ago(s.updatedAt)}</div>
        <div class="small muted">Suggested: <b>${esc(s.suggestedName || '')}</b> at ${esc(s.suggestedRoot || '')}</div></div>
        <button class="btn small primary" data-fromchat='${esc(JSON.stringify({ name: s.suggestedName, root: s.suggestedRoot }))}'>Create board from this</button>
        ${list.length ? `<select data-uaboard="${esc(s.sessionId)}" data-root="${esc(s.suggestedRoot || s.cwd)}"><option value="">Add to board…</option>${list.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select>` : ''}
      </div>`).join('') : '<div class="small muted">None. Chats in folders no board covers show up here.</div>'}
    </div></div>`
}
document.addEventListener('submit', async e => {
  if (e.target.id !== 'newBoard') return
  e.preventDefault()
  const f = e.target
  try {
    const b = await api('createBoard', { name: f.name.value, root: f.root.value, label: f.label.value })
    location.href = `?project=${encodeURIComponent(b.id)}`
  } catch (err) { toast(err.message, 6000) }
})
document.addEventListener('click', e => {
  const b = e.target.closest('[data-fromchat]')
  if (!b) return
  const v = JSON.parse(b.dataset.fromchat), f = $('#newBoard')
  f.name.value = v.name || ''; f.root.value = (v.root || '').replace(/\//g, '\\'); f.name.focus()
  f.scrollIntoView({ behavior: 'smooth', block: 'center' })
})

if (!projectId) picker()
else { refresh(); setInterval(refresh, 3000) }

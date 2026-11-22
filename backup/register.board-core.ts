// Claude Project Board — reporter mod.
// The board's rules, storage, context and tools live in board-core (copied from the T3 Code fork's
// packages/board-core by tools/sync-board-core.mjs; edit them there). This file only connects a
// Claude Code chat to it: the session's events, the board_* tools, /board and /task, /board open.
// Layout of the shared data: docs/DATA-LAYOUT.md.
import type { Register } from 'claude-code'
import { BOARD_TOOLS, BoardChat, BoardStore, norm, type BoardGit, type BoardIO, type RepoState } from './board-core/index.ts'

const HEARTBEAT_MS = 30_000
const BOARD_PORT = 4317

// Module state: rebuilt by session.start on every (re)load.
let chat: BoardChat | null = null
let heartbeat: { cancel: () => void } | null = null
// Tools and commands wait for session setup, which can still be running right after a reload.
let ready: Promise<void> = Promise.resolve()
// The ports below call the latest `$` a hook was given.
let cur: any = null
// T3 Code reports its own threads (any provider) to the board; a Claude chat it runs stands down.
let standDown = false

const io: BoardIO = {
  read: p => cur.fs.read(p),
  write: (p, d) => cur.fs.write(p, d),
  list: async p => ((await cur.fs.list(p)) as any[]).map(f => ({ name: f.name, kind: f.kind === 'dir' ? ('dir' as const) : ('file' as const), mtimeMs: f.mtimeMs ?? 0 })),
  exists: p => cur.fs.exists(p),
  stat: p => cur.fs.stat(p),
}

async function git(dir: string, args: string[], timeoutMs = 8000): Promise<string | null> {
  try {
    const r = await cur.process.run(['git', '-C', dir, ...args], { timeoutMs })
    return r.exitCode === 0 ? String(r.stdout).trim() : null
  } catch {
    return null
  }
}

const gitPort: BoardGit = {
  root: async dir => {
    const top = await git(dir, ['rev-parse', '--show-toplevel'])
    return top ? norm(top) : null
  },
  branch: async dir => (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], 5000)) ?? '',
  state: async (dir): Promise<RepoState | null> => {
    const top = await git(dir, ['rev-parse', '--show-toplevel'])
    if (!top) return null
    const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    let ahead: number | null = null, behind: number | null = null
    if (upstream) { const c = await git(dir, ['rev-list', '--left-right', '--count', `${upstream}...HEAD`]); if (c) { const [b, a] = c.split(/\s+/).map(Number); behind = b ?? null; ahead = a ?? null } }
    const status = (await git(dir, ['status', '--porcelain'])) ?? ''
    return {
      repo: norm(top), name: norm(top).split('/').pop() || top, branch: (await git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'])) ?? '?', head: (await git(dir, ['rev-parse', '--short', 'HEAD'])) ?? '?',
      upstream, ahead, behind, dirty: status.split('\n').filter(Boolean).length,
      lastCommitAt: Number((await git(dir, ['log', '-1', '--format=%ct'])) ?? 0) * 1000, at: Date.now(),
    }
  },
}

async function init($: any, cwd: string) {
  standDown = !!(await $.env.get('T3_BOARD_HOST'))
  if (standDown) { chat = null; return }
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  chat = new BoardChat(new BoardStore(`${norm(home)}/.claude-board`, io), gitPort, 'claude-code')
  await chat.open({
    sessionId: await $.session.id(),
    cwd: (await $.session.root().catch(() => cwd)) || cwd,
    // The desktop app's own id for this chat (local_…): what claude://code/continue?session= takes.
    hostSessionId: (await $.env.get('CLAUDE_CODE_HOST_SESSION_ID')) || undefined,
    surface: (await $.env.get('CLAUDE_CODE_ENTRYPOINT')) || undefined,
    source: { kind: 'claude-code' },
  })
}

const live = () => (chat && !chat.ignored && chat.sess ? chat : null)

// /board open: start the board server shipped inside this plugin (if it isn't running) and open
// this board in its own window. No setup on the person's machine beyond Node.
async function openBoard($: any): Promise<string> {
  const server = `${norm($.plugin.root)}/app/server.js`
  if (!(await $.fs.exists(server).catch(() => false))) return `The board app isn't in this plugin (${server}).`
  const board = chat?.board
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

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    cur = $
    try {
      heartbeat?.cancel()
      ready = init($, e.cwd)
      await ready
      if (live()) {
        await $.command.register({ name: 'task', description: 'Board: /task lists tasks · /task <name> links (creates if new) · /task off unlinks', argumentHint: '[task name | off]' } as any)
        await $.command.register({ name: 'board', description: 'Board: /board · /board new <name> · /board add <board> · /board list · /board mode on|off · /board release [soft|reclaim|free] · /board open', argumentHint: '[new | add | list | mode | release | open]' } as any)
        for (const t of BOARD_TOOLS) await $.tool.register({ name: t.name, description: t.description, inputSchema: t.inputSchema as any })
        heartbeat = $.clock.every(HEARTBEAT_MS, async () => { await chat?.heartbeat() })
      }
    } catch (err) {
      $.ui.log(`project-board: setup failed: ${String(err)}`)
    }
    return next(e)
  })

  on('turn.start', async ($, e, next) => {
    cur = $
    if (e.agentId === undefined) await live()?.turnStart(e.text).catch(() => {})
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    cur = $
    if (e.agentId === undefined) await live()?.turnComplete(e.answer ?? '').catch(() => {})
    return next(e)
  })

  on('session.end', async ($, e, next) => {
    cur = $
    heartbeat?.cancel()
    await chat?.end(e.resume?.id).catch(() => {})
    return next(e)
  })

  on('prompt.compose', async ($, e, next) => {
    const r = await next(e)
    const text = live()?.context
    if (!text) return r
    return { ...r, sections: [...r.sections, { id: 'project-board:context', text, scope: 'session' as const }] }
  })

  on('command.run', { command: 'board' }, async ($, e) => {
    cur = $
    await ready.catch(() => {})
    const c = live()
    if (!c || !c.sess) return { text: 'The board is not available in this folder.' }
    const sess = c.sess
    const board = c.board
    const [verb = '', ...rest] = e.args.trim().split(/\s+/)
    const arg = rest.join(' ')
    const reg = await c.store.loadRegistry()
    if (verb === 'open') return { text: await openBoard($) }
    if (verb === 'release') return { text: (await c.releaseOwnership({ action: arg === 'reclaim' ? 'reclaim' : arg === 'free' ? 'free' : 'soft' })).text }
    if (verb === 'mode') {
      const v = arg.toLowerCase()
      if (v === 'off' || v === 'on') { await c.save({ boardModeOff: v === 'off' }); await c.rebuildContext() }
      return { text: `Board Mode for this chat: ${c.boardModeOn ? 'on' : 'off'}${board?.boardMode ? '' : ' (it is off for this whole board; turn it on in the board\'s ⚙ settings)'}.` }
    }
    if (verb === 'list') return { text: reg.boards.map(b => `${b.name}: ${b.roots.map(r => `${r.label} (${r.path})`).join(', ')}`).join('\n') || 'No boards yet.' }
    if (verb === 'new' || verb === 'add') {
      if (!arg) return { text: verb === 'new' ? `Usage: /board new <name>   (root: ${sess.suggestedRoot ?? sess.cwd})` : 'Usage: /board add <board name>' }
      const r = await c.setupBoard(verb === 'new' ? { action: 'create', name: arg } : { action: 'attach', name: arg })
      if (r.toast) $.ui.toast(r.toast)
      return { text: r.text }
    }
    if (board) return { text: `Board: ${board.name} · workspace ${sess.workspaceLabel} (${sess.workspace})${sess.subfolder ? ` · folder ${sess.subfolder}` : ''}${sess.taskId ? ` · task ${sess.taskId}` : ''}\nWorkspaces: ${board.roots.map(r => r.label).join(', ')}` }
    return { text: `This folder isn't on a board yet.\nSuggested: /board new ${sess.suggestedName}   (root ${sess.suggestedRoot})${reg.boards.length ? `\nOr add it to: ${reg.boards.map(b => `/board add ${b.name}`).join(' · ')}` : ''}` }
  })

  on('command.run', { command: 'task' }, async ($, e) => {
    cur = $
    await ready.catch(() => {})
    const c = live()
    const arg = e.args.trim()
    if (!c || !c.sess) return { text: 'The board is not available in this folder.' }
    const sess = c.sess
    const board = c.board
    if (!board) {
      return {
        text: `This folder isn't on a board yet, so the task can't be saved.\nCreate one: /board new ${sess.suggestedName}   (root ${sess.suggestedRoot}) — or add it to an existing board with /board add <name>.`,
        context: [`The person tried /task ${arg} but this folder has no board. ${await c.unassignedHelp()} After board_setup, create/link the task "${arg}" with board_link.`],
      }
    }
    const tasks = await c.store.listTasks(board.id)
    if (!arg) {
      const head = sess.taskId ? `Linked to: ${sess.taskId}\n` : 'Not linked.\n'
      const lines = tasks.map(t => `${t.id === sess.taskId ? '▸' : ' '} ${t.id} — ${t.title} [${t.status}]`)
      return { text: `${head}${lines.join('\n') || 'No tasks yet. /task <name> creates one.'}` }
    }
    if (arg === 'off') return { text: (await c.unlink()).text }
    const override = /--takeover\b/.test(arg) ? 'takeover' : /--override\b/.test(arg) ? 'once' : undefined
    const name = arg.replace(/--(takeover|override)\b/g, '').trim()
    const key = name.toLowerCase()
    const slugKey = key.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
    const exists = tasks.find(t => t.id === slugKey) ?? tasks.find(t => t.title.toLowerCase() === key)
    const r = await c.linkTask(exists ? { taskId: exists.id, override, personSaid: override ? `typed /task --${override === 'once' ? 'override' : 'takeover'}` : undefined } : { newTaskTitle: name })
    if (r.toast) $.ui.toast(r.toast)
    if (r.text.startsWith('BLOCKED')) return { text: `${r.text.split('. Ask them')[0]}.\nRun /task ${name} --override to work here once, or /task ${name} --takeover to move it to this workspace.` }
    return { text: exists ? `Linked to task "${exists.title}".` : `Created task "${arg}" on ${board.name} and linked this chat.`, context: [r.text] }
  })

  for (const t of BOARD_TOOLS) {
    on('tool.call', { tool: `mcp__project-board__${t.name}` } as any, async ($: any, e: any) => {
      cur = $
      await ready.catch(() => {})
      try {
        const c = live()
        if (!c) return { result: 'The board is not available in this folder.', text: 'The board is not available in this folder.' }
        const r = await c.runTool(t.name, e)
        if (!r) return { isError: true as const, result: `${t.name} is not a board tool.` }
        if (r.toast) $.ui.toast(r.toast)
        return { result: r.text, text: r.text }
      } catch (err) {
        return { isError: true as const, result: `${t.name} failed: ${String(err)}` }
      }
    })
  }

  // Auto-tag the linked task with the services whose files this chat edits, and flag the first
  // edit in a service outside the task's services so the out-of-scope protocol kicks in.
  const tag = async ($: any, file: unknown, ran: any) => {
    cur = $
    try {
      if (!ran || ran.deny !== undefined || ran.isError) return ran
      const note = await live()?.fileChanged(String(file || ''))
      return note ? { ...ran, context: [...(ran.context ?? []), note] } : ran
    } catch {
      return ran
    }
  }
  on('tool.call', { tool: 'Edit' }, async ($, e, next) => tag($, (e as any).file_path, await next(e)))
  on('tool.call', { tool: 'Write' }, async ($, e, next) => tag($, (e as any).file_path, await next(e)))
  on('tool.call', { tool: 'NotebookEdit' }, async ($, e, next) => tag($, (e as any).notebook_path, await next(e)))
}

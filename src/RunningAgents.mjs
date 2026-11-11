import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { AGENTS, agentSessions } from './AgentProcesses.mjs'
import { logFailure, message, requireCondition } from './messages.mjs'
import { processTable } from './ProcessTable.mjs'
import { linkLogs } from './SessionLinks.mjs'
import { ACTIVE_MS, OPEN_STEPS, sessionStatus } from './SessionStatus.mjs'

/** Some calls in one turn share one view, so they make one `ps` call. `scannedAt` gives the age of the view. */
export const SNAPSHOT_TTL_MS = 5000
/**
 * A session with at least this CPU load, with its helpers, in percent of one core, is active. On the Mac of the author,
 * 31 idle sessions of Claude Code, Codex and OpenCode had at most 4.8 percent in 186 samples. A session that ran a
 * tool had 32 to 78 percent. A session that waits for the model uses little CPU, so a log write is the other sign of
 * an active session.
 */
export const ACTIVE_CPU_PERCENT = 10
export const RUNNING_LIMIT = 50
export const RUNNING_MAX_LIMIT = 200
export const STATES = ['orphan', 'active', 'idle']
const systemClock = { now: () => Date.now() }
const CURSOR = /^([0-2])\.(\d{1,15})\.(\d{1,10})(?:\.(\d{1,3}))?$/

/** A row without a log sorts by the start time of its process. `slot` orders the sessions of one process. */
const sortKey = row => [STATES.indexOf(row.state), row.lastActivityAt ?? row.startedAt, row.pid, row.slot]
/** The orphans first, then the active and the idle sessions, and the newest activity first in each group. */
const compare = (left, right) => left[0] - right[0] || right[1] - left[1] || right[2] - left[2] || (right[3] ?? 0) - (left[3] ?? 0)
const iso = time => Number.isFinite(time) ? new Date(time).toISOString() : null

/**
 * The view of the agent sessions that run on this machine, for the tool `agents_running`. It reads the process table,
 * gets the working directory and the open session logs of each new session process, and takes the session ID, the
 * title and the task directory of a Megachat child from the state. With the consent of the user, [logs] gives the live
 * table of the session files: then each row gets its log, and the log gives the session ID, the title, the time of the
 * last write and the status. Without the consent, Megachat reads no session file.
 */
export class RunningAgents {
  constructor(state, { table = processTable(), clock = systemClock, daemonPid = process.pid, logs = () => undefined } = {}) {
    Object.assign(this, { state, table, clock, daemonPid, logs })
    // The data of each session process until the process ends: `{ startedAt, cwd, files, resolvedAt }`. A PID with
    // another start time is another process.
    this.directories = new Map()
    // The last time of a CPU load of each session process, for the state `active`.
    this.busy = new Map()
    this.linked = new Set()
  }

  /**
   * The view of the last 5 seconds, or a new one. Two calls at the same time share one scan. A change of the consent
   * makes a new view at once.
   */
  async view() {
    if (this.last && this.clock.now() - this.last.scannedAt < SNAPSHOT_TTL_MS && this.last.logs === Boolean(this.logs())) return this.last
    this.scanning ??= this.scan().then(view => { this.last = view; return view }).finally(() => { this.scanning = undefined })
    return this.scanning
  }

  async scan() {
    const scannedAt = this.clock.now()
    const incomplete = []
    if (!this.table.supported) return { scannedAt, rows: [], incomplete: [message('running.incomplete.platform', this.table.platform)], logs: false }
    let processes = []
    try { processes = await this.table.processes() }
    catch (error) {
      logFailure('log.running', error)
      incomplete.push(message('running.incomplete.processes'))
    }
    const sessions = agentSessions(processes, { daemonPid: this.daemonPid, runs: Object.values((await this.state.snapshot()).runs) })
    const live = new Map(processes.map(item => [item.pid, item.startedAt]))
    for (const [pid, known] of this.directories) if (live.get(pid) !== known.startedAt) this.directories.delete(pid)
    for (const [pid, known] of this.busy) if (live.get(pid) !== known.startedAt) this.busy.delete(pid)
    for (const row of sessions) if (row.cpu >= ACTIVE_CPU_PERCENT) this.busy.set(row.pid, { startedAt: row.startedAt, at: scannedAt })
    const catalog = this.logs()
    await this.#resolve(sessions, catalog)
    const rows = sessions.map(row => ({ ...row, cwd: row.run ? row.run.cwd : this.directories.get(row.pid)?.cwd ?? null,
      files: this.directories.get(row.pid)?.files ?? [] }))
    const unreadable = rows.filter(row => row.cwd === null).length
    if (unreadable) incomplete.push(message('running.incomplete.cwd', unreadable))
    const view = catalog ? await this.#withLogs(rows, catalog, scannedAt, incomplete)
      : rows.map(row => this.#row(row, { sessionId: row.run?.sessionId ?? '' }, scannedAt))
    view.sort((left, right) => compare(sortKey(left), sortKey(right)))
    return { scannedAt, rows: view, incomplete, logs: Boolean(catalog) }
  }

  /**
   * Gets the working directory and the open session logs of each new session process in one call. The state gives
   * the task directory of a Megachat child, so only the other sessions need `lsof`. The open logs of a Codex process
   * change when it loads another session, so a write to a Codex log that no row has makes Megachat ask again.
   */
  async #resolve(sessions, catalog) {
    const since = this.resolvedAt ?? -Infinity
    const moved = new Set(catalog ? catalog.sources.filter(source => source.keepsOpen && [...catalog.of(source.agent)]
      .some(record => record.mtimeMs > since && !this.linked.has(record.path))).map(source => source.agent) : [])
    const wanted = sessions.filter(row => !row.run && (!this.directories.has(row.pid) || moved.has(row.agent))).map(row => row.pid)
    if (!wanted.length) return
    try {
      const resolvedAt = this.clock.now()
      const found = await this.table.resolve(wanted)
      for (const row of sessions) {
        if (!wanted.includes(row.pid)) continue
        const known = this.directories.get(row.pid)
        const item = found.get(row.pid) ?? { cwd: null, files: [] }
        // A Codex process closes the log of an idle session. The last open logs stay the logs of the process.
        const files = item.files?.length ? item.files : known?.files ?? []
        this.directories.set(row.pid, { startedAt: row.startedAt, cwd: item.cwd ?? known?.cwd ?? null, files })
      }
      this.resolvedAt = resolvedAt
    }
    catch (error) { logFailure('log.running', error) }
  }

  /** Links each row to its logs. A row of a process with several open logs becomes one row for each session. */
  async #withLogs(rows, catalog, now, incomplete) {
    for (const row of rows) {
      if (!row.run && !row.files.length && catalog.source(row.agent)?.processSession)
        row.process = await catalog.processSession(row.agent, row.pid, row.startedAt)
    }
    // A log that a row names and that the table has not read yet is read now, so a new session shows at once.
    const wanted = new Set(rows.flatMap(row => row.files.filter(path => catalog.get(path)?.agent === row.agent || !catalog.get(path))))
    for (const row of rows) {
      const id = row.run?.sessionId ?? row.process?.sessionId
      if (!id) continue
      const known = catalog.session(row.agent, id)
      const path = known?.path ?? (row.process?.cwd ? catalog.source(row.agent)?.pathOf?.(row.process.cwd, id) : undefined)
      if (path) wanted.add(path)
    }
    await Promise.all([...wanted].filter(path => !catalog.get(path)?.read).map(path => catalog.ensure(path).catch(() => undefined)))
    const links = linkLogs(rows, catalog)
    this.linked = new Set([...links.values()].flat().map(link => link.record?.path).filter(Boolean))
    const view = []
    let unlinked = 0
    let unreadable = 0
    for (const row of rows) {
      const found = links.get(row)
      found.forEach((link, slot) => {
        view.push(this.#row(row, link, now, { slot, shared: found.length > 1 }))
        if (row.agent !== 'opencode' && !link.record?.read) unlinked++
        if (link.record?.error) unreadable++
      })
    }
    const { progress } = catalog
    if (!progress.recent) incomplete.push(message('running.incomplete.reading', progress.done, progress.total))
    if (unlinked) incomplete.push(message('running.incomplete.unlinked', unlinked))
    if (unreadable) incomplete.push(message('running.incomplete.unreadable', unreadable))
    return view
  }

  /**
   * One row of the view. `active`: the CPU load of the process now or in the last 2 minutes, or a log write in the last
   * 2 minutes. The CPU load of a process with several sessions counts only for its sessions with an open step.
   */
  #row(row, { record, sessionId }, now, { slot = 0, shared = false } = {}) {
    const known = record?.read ? record : undefined
    const lastActivityAt = Number.isFinite(record?.mtimeMs) ? Math.floor(record.mtimeMs) : null
    const busyAt = this.busy.get(row.pid)?.at
    const cpu = busyAt !== undefined && now - busyAt < ACTIVE_MS && (!shared || OPEN_STEPS.has(known?.step))
    const written = lastActivityAt !== null && now - lastActivityAt < ACTIVE_MS
    return {
      pid: row.pid, slot, agent: row.agent, startedAt: row.startedAt, parent: row.parent, cwd: row.cwd,
      sessionId: sessionId ?? '', title: row.run?.title || known?.title || '',
      status: known ? sessionStatus(known, now) : null, lastActivityAt,
      state: row.orphan ? 'orphan' : cpu || written ? 'active' : 'idle',
    }
  }

  /**
   * One page of the sessions. [project] selects the sessions with the working directory in that directory. The cursor
   * is the sort key of the last row of the page, so a page stays in place when a session starts or ends between calls.
   */
  async query({ agent, project, state, limit = RUNNING_LIMIT, cursor } = {}) {
    requireCondition(agent === undefined || AGENTS.includes(agent))
    requireCondition(state === undefined || STATES.includes(state))
    requireCondition(Number.isSafeInteger(limit) && limit >= 1 && limit <= RUNNING_MAX_LIMIT)
    requireCondition(project === undefined || typeof project === 'string' && /^(\/|~(\/|$))/.test(project.trim()) && project.length <= 4096)
    const after = cursor === undefined ? undefined : CURSOR.exec(cursor)?.slice(1).map(part => part === undefined ? 0 : Number(part))
    requireCondition(cursor === undefined || after)
    const directory = project === undefined ? undefined : await realDirectory(project)
    const view = await this.view()
    const matching = view.rows.filter(row => (agent === undefined || row.agent === agent) && (state === undefined || row.state === state)
      && (directory === undefined || row.cwd !== null && (row.cwd === directory || row.cwd.startsWith(directory.endsWith(sep) ? directory : directory + sep))))
    const rest = after ? matching.filter(row => compare(sortKey(row), after) > 0) : matching
    const page = rest.slice(0, limit)
    const more = rest.length > limit
    return {
      sessions: page.map(row => ({
        agent: row.agent, sessionId: row.sessionId, title: row.title, cwd: row.cwd, state: row.state, status: row.status,
        startedAt: iso(row.startedAt), lastActivityAt: iso(row.lastActivityAt), pid: row.pid, parent: row.parent,
      })),
      nextCursor: more ? sortKey(page.at(-1)).join('.') : null, truncated: more,
      scannedAt: iso(view.scannedAt),
      incomplete: [...view.incomplete, ...(view.logs ? [] : [message('running.incomplete.logs')]),
        ...(matching.some(row => row.agent === 'opencode') ? [message('running.incomplete.opencode')] : [])],
    }
  }
}

/**
 * The real path of a directory that the user named, an absolute path or a path that starts with `~`, so that it
 * compares with the working directory from `lsof`. A directory that does not exist keeps its path.
 */
async function realDirectory(project) {
  const path = resolve(project.trim().replace(/^~/, homedir()))
  try { return await realpath(path) }
  catch { return path }
}

import { realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { resolve, sep } from 'node:path'
import { AGENTS, agentSessions } from './AgentProcesses.mjs'
import { logFailure, message, requireCondition } from './messages.mjs'
import { processTable } from './ProcessTable.mjs'

/** Some calls in one turn share one view, so they make one `ps` call. `scannedAt` gives the age of the view. */
export const SNAPSHOT_TTL_MS = 5000
/**
 * A session with at least this CPU load, with its helpers, in percent of one core, is active. On the Mac of the author,
 * 31 idle sessions of Claude Code, Codex and OpenCode had at most 4.8 percent in 186 samples. A session that ran a
 * tool had 32 to 78 percent. A session that waits for the model uses little CPU, so it is idle here until the session
 * logs give the time of the last write.
 */
export const ACTIVE_CPU_PERCENT = 10
export const RUNNING_LIMIT = 50
export const RUNNING_MAX_LIMIT = 200
export const STATES = ['orphan', 'active', 'idle']
const systemClock = { now: () => Date.now() }
const CURSOR = /^([0-2])\.(\d{1,15})\.(\d{1,10})$/

const sortKey = row => [STATES.indexOf(row.state), row.startedAt, row.pid]
/** The orphans first, then the active and the idle sessions, and the newest start first in each group. */
const compare = (left, right) => left[0] - right[0] || right[1] - left[1] || right[2] - left[2]

/**
 * The view of the agent sessions that run on this machine, for the tool `agents_running`. It reads the process table,
 * gets the working directory of each new session process, and takes the session ID, the title and the task directory
 * of a Megachat child from the state. It reads no session log yet: the log of a session will give its status, its
 * title and the time of its last write.
 */
export class RunningAgents {
  constructor(state, { table = processTable(), clock = systemClock, daemonPid = process.pid } = {}) {
    Object.assign(this, { state, table, clock, daemonPid })
    // The working directory of each session process, until the process ends. A PID with another start time is another process.
    this.directories = new Map()
  }

  /** The view of the last 5 seconds, or a new one. Two calls at the same time share one scan. */
  async view() {
    if (this.last && this.clock.now() - this.last.scannedAt < SNAPSHOT_TTL_MS) return this.last
    this.scanning ??= this.scan().then(view => { this.last = view; return view }).finally(() => { this.scanning = undefined })
    return this.scanning
  }

  async scan() {
    const scannedAt = this.clock.now()
    const incomplete = []
    if (!this.table.supported) return { scannedAt, rows: [], incomplete: [message('running.incomplete.platform', this.table.platform)] }
    let processes = []
    try { processes = await this.table.processes() }
    catch (error) {
      logFailure('log.running', error)
      incomplete.push(message('running.incomplete.processes'))
    }
    const sessions = agentSessions(processes, { daemonPid: this.daemonPid, runs: Object.values((await this.state.snapshot()).runs) })
    const live = new Map(processes.map(item => [item.pid, item.startedAt]))
    for (const [pid, known] of this.directories) if (live.get(pid) !== known.startedAt) this.directories.delete(pid)
    // The state gives the task directory of a Megachat child, so only the other sessions need `lsof`.
    const unknown = sessions.filter(row => !row.run && !this.directories.has(row.pid)).map(row => row.pid)
    if (unknown.length) {
      try {
        const found = await this.table.resolve(unknown)
        for (const row of sessions) if (unknown.includes(row.pid)) this.directories.set(row.pid, { startedAt: row.startedAt, cwd: found.get(row.pid)?.cwd ?? null })
      }
      catch (error) { logFailure('log.running', error) }
    }
    const rows = sessions.map(row => ({ ...row, cwd: row.run ? row.run.cwd : this.directories.get(row.pid)?.cwd ?? null,
      state: row.orphan ? 'orphan' : row.cpu >= ACTIVE_CPU_PERCENT ? 'active' : 'idle' })).sort((left, right) => compare(sortKey(left), sortKey(right)))
    const unreadable = rows.filter(row => row.cwd === null).length
    if (unreadable) incomplete.push(message('running.incomplete.cwd', unreadable))
    return { scannedAt, rows, incomplete }
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
    const after = cursor === undefined ? undefined : CURSOR.exec(cursor)?.slice(1).map(Number)
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
        agent: row.agent, sessionId: row.run?.sessionId ?? '', title: row.run?.title ?? '', cwd: row.cwd, state: row.state, status: null,
        startedAt: new Date(row.startedAt).toISOString(), lastActivityAt: null, pid: row.pid, parent: row.parent,
      })),
      nextCursor: more ? sortKey(page.at(-1)).join('.') : null, truncated: more,
      scannedAt: new Date(view.scannedAt).toISOString(),
      incomplete: [...view.incomplete, message('running.incomplete.logs'),
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

import { randomUUID } from 'node:crypto'
import { agentSessions, identityOf } from './AgentProcesses.mjs'
import { logEvent, message, MegachatError, requireCondition } from './messages.mjs'

/**
 * The lifetime of a stop request. After it, the dialog of the client gives no signal, and the process can be another
 * one.
 */
export const STOP_REQUEST_MS = 5 * 60 * 1000
/** The limit of the PIDs of one call. */
export const STOP_MAX_PIDS = 20
export const SIGNALS = ['SIGTERM', 'SIGKILL']
/** The options of the dialog: `stop` sends the signal one time, `keep` sends none. There is no option for always. */
export const STOP_OPTIONS = ['stop', 'keep']
/** The count of the closed requests that the view keeps, so a client can close its dialog with the outcome. */
const KEPT_CLOSED = 32
const systemClock = { now: () => Date.now() }
const systemTimer = (run, ms) => {
  const timer = setTimeout(run, ms)
  timer.unref?.()
  return () => clearTimeout(timer)
}
const iso = time => new Date(time).toISOString()

/**
 * The tool `agents_stop`: it stops an orphan agent session with a signal, after an answer of the user in the permission
 * dialog of the client. The call makes a stop request and waits for the answer in the turn. The client shows the request
 * through `session/request_permission`, and only an answer there (`/stop/answer`) sends the signal. No argument of the
 * tool can send it. Directly before the signal, Megachat reads the process table again. The process must have the same
 * PID, the same start time and the same command, and its state must still be `orphan`.
 *
 * The requests stay in the memory of the daemon. A restart of the daemon removes each one, and the tool does not run
 * again after a restart. The process table, the signal function, the clock and the timer come from the caller, so a test
 * sends no real signal.
 */
export class AgentStop {
  constructor(state, { table, running, kill = (pid, signal) => process.kill(pid, signal), clock = systemClock, timer = systemTimer,
    daemonPid = process.pid, daemonParentPid = process.ppid, uid = process.geteuid?.() } = {}) {
    Object.assign(this, { state, table, running, kill, clock, timer, daemonPid, daemonParentPid, uid })
    // The open request by its ID, at most one: `{ id, turnId, signal, createdAt, targets, delivered, settle, cancelTimer }`.
    this.requests = new Map()
    // The status of each closed request by its ID: `allowed`, `declined`, `expired`, `replaced` or `cancelled`.
    this.closed = new Map()
    this.listeners = new Set()
    // The processes that got SIGTERM from this tool: `{ startedAt, identity }` by PID. Only such a process can get SIGKILL.
    this.terminated = new Map()
  }

  /**
   * One call of the tool. It returns when the user answered the dialog, when the request expired, or when a later call
   * replaced it. [abortSignal] ends the wait when the turn stops.
   */
  async call({ pids, signal = 'SIGTERM', ...other } = {}, { abortSignal } = {}) {
    requireCondition(Object.keys(other).length === 0)
    requireCondition(Array.isArray(pids) && pids.length >= 1 && pids.length <= STOP_MAX_PIDS && pids.every(Number.isSafeInteger))
    requireCondition(new Set(pids).size === pids.length && SIGNALS.includes(signal))
    // A protected PID refuses the call before each other check.
    for (const pid of pids) if (pid <= 1 || pid === this.daemonPid || pid === this.daemonParentPid) throw new MegachatError('stopProtected', pid)
    if (!this.table.supported) throw new MegachatError('stopPlatform', this.table.platform)
    const processes = await this.table.processes()
    this.checkOwners(pids, processes)
    const state = await this.state.snapshot()
    if (state.current?.kind !== 'user' || state.current.cancelling) throw new MegachatError('stopEvent')
    for (const [pid, sent] of this.terminated) if (processes.find(item => item.pid === pid)?.startedAt !== sent.startedAt) this.terminated.delete(pid)
    const { targets, refused } = await this.targets(pids, signal, processes, state)
    const shown = targets.map(({ identity, startedAt, ...target }) => ({ ...target, startedAt: iso(startedAt) }))
    if (!targets.length) {
      logEvent('log.stop.refused', signal, pids.join(','), 'none')
      return { signal, outcome: 'none', targets: [], refused, note: message('stop.result.none') }
    }
    const request = this.open(signal, state.current.id, targets)
    const answer = await this.wait(request, abortSignal)
    if (answer === 'stop') {
      const sent = await this.send(request, abortSignal)
      return { ...sent, targets: shown, refused: [...refused, ...sent.refused] }
    }
    const note = answer === 'expired' ? message(request.delivered ? 'stop.result.expired' : 'stop.result.unseen', STOP_REQUEST_MS / 60000)
      : message(`stop.result.${answer}`)
    return { signal, outcome: answer, stopped: [], targets: shown, refused, note }
  }

  /** Refuses the daemon, its parent, each process above them, and a process of another user or of an unknown user. */
  checkOwners(pids, processes) {
    const protectedPids = this.ancestors(processes)
    const byPid = new Map(processes.map(item => [item.pid, item]))
    for (const pid of pids) {
      if (protectedPids.has(pid)) throw new MegachatError('stopProtected', pid)
      if (byPid.has(pid) && (!Number.isSafeInteger(this.uid) || byPid.get(pid).uid !== this.uid)) throw new MegachatError('stopOtherUser', pid)
    }
  }

  /** The daemon, its parent and each process above them. */
  ancestors(processes) {
    const byPid = new Map(processes.map(item => [item.pid, item]))
    const found = new Set()
    for (const start of [this.daemonPid, this.daemonParentPid])
      for (let pid = start; pid > 1 && !found.has(pid) && found.size < 256; pid = byPid.get(pid)?.ppid ?? 0) found.add(pid)
    return found
  }

  /** The sessions of the process table now, by PID, with the authority of the state for the children of Megachat. */
  sessions(processes, state) {
    return new Map(agentSessions(processes, { daemonPid: this.daemonPid, runs: Object.values(state.runs) }).map(row => [row.pid, row]))
  }

  /** The reason that a process cannot get [signal] now, or undefined. */
  refusal(pid, signal, session) {
    if (!session) return message('stop.refused.notSession', pid)
    if (session.ownership === 'unknown') return message('stop.refused.unknown', pid, session.parent.name, session.parent.pid)
    if (session.ownership !== 'orphan') return message('stop.refused.owned', pid, session.parent.kind, session.parent.name, session.parent.pid)
    if (signal === 'SIGKILL') {
      const sent = this.terminated.get(pid)
      if (!sent || sent.startedAt !== session.startedAt || sent.identity !== session.identity) return message('stop.refused.noTerm', pid)
    }
    return undefined
  }

  /** The processes that would get [signal], and the refused PIDs with their reasons. */
  async targets(pids, signal, processes, state) {
    const sessions = this.sessions(processes, state)
    const view = await this.running.view().catch(() => ({ rows: [] }))
    const targets = []
    const refused = []
    for (const pid of pids) {
      const session = sessions.get(pid)
      const reason = this.refusal(pid, signal, session)
      if (reason) { refused.push({ pid, reason }); continue }
      // The view gives the project and the sessions of the process, when it has the same process.
      const rows = view.rows.filter(row => row.pid === pid && row.startedAt === session.startedAt)
      targets.push({ pid, startedAt: session.startedAt, identity: session.identity, agent: session.agent, program: session.program,
        cwd: session.run?.cwd ?? rows[0]?.cwd ?? null, parent: session.parent,
        sessions: rows.map(row => ({ sessionId: row.sessionId, title: row.title })) })
    }
    return { targets, refused }
  }

  /**
   * Makes a request for the dialog. It replaces each open request: the client cannot remove a dialog that it shows, so
   * the answer to an earlier dialog must find no open request.
   */
  open(signal, turnId, targets) {
    for (const old of this.requests.values()) this.close(old, 'replaced')
    const request = { id: randomUUID(), turnId, signal, createdAt: this.clock.now(), delivered: false,
      targets: targets.map(({ pid, startedAt, identity, agent, cwd }) => ({ pid, startedAt, identity, agent, cwd })) }
    request.answer = new Promise(resolve => { request.settle = resolve })
    request.cancelTimer = this.timer(() => this.close(request, 'expired'), STOP_REQUEST_MS)
    this.requests.set(request.id, request)
    this.publish()
    return request
  }

  /** Waits for the answer of the user, the expiry or a replacement. A stop of the turn closes the request. */
  async wait(request, abortSignal) {
    if (!abortSignal) return request.answer
    const aborted = new Promise((_, reject) => {
      request.onAbort = () => { reject(abortSignal.reason); this.close(request, 'cancelled') }
      abortSignal.addEventListener('abort', request.onAbort, { once: true })
      if (abortSignal.aborted) request.onAbort()
    })
    try { return await Promise.race([request.answer, aborted]) }
    finally { abortSignal.removeEventListener('abort', request.onAbort) }
  }

  /** Closes an open request with [status], and gives the status to the waiting call. */
  close(request, status) {
    if (this.requests.get(request.id) !== request) return false
    request.cancelTimer()
    this.requests.delete(request.id)
    this.closed.set(request.id, status)
    while (this.closed.size > KEPT_CLOSED) this.closed.delete(this.closed.keys().next().value)
    request.settle(status === 'allowed' ? 'stop' : status)
    this.publish()
    return true
  }

  /**
   * The answer of the user in the dialog of the client. Only the first answer to an open request counts. An answer to a
   * request that expired, that got an answer, that a later request replaced, or that the daemon does not know (as after
   * a restart) is refused, and it sends no signal.
   */
  answer(id, optionId) {
    requireCondition(typeof id === 'string' && id.length <= 100 && STOP_OPTIONS.includes(optionId))
    const request = this.requests.get(id)
    if (request && this.clock.now() - request.createdAt >= STOP_REQUEST_MS) this.close(request, 'expired')
    if (!this.requests.has(id)) {
      logEvent('log.stop.late')
      throw new MegachatError('stopClosed')
    }
    this.close(request, optionId === 'stop' ? 'allowed' : 'declined')
    return { accepted: true }
  }

  /**
   * Sends the signal after the answer `stop`. The turn of the request must still run. Directly before the signal, a new
   * read of the process table: each process must be the same process and still an orphan, else no signal goes out at all.
   */
  async send(request, abortSignal) {
    const { signal, targets } = request
    const pids = targets.map(target => target.pid)
    abortSignal?.throwIfAborted()
    const processes = await this.table.processes()
    this.checkOwners(pids, processes)
    const state = await this.state.snapshot()
    if (state.current?.id !== request.turnId || state.current.cancelling) throw new MegachatError('stopEvent')
    abortSignal?.throwIfAborted()
    const sessions = this.sessions(processes, state)
    const byPid = new Map(processes.map(item => [item.pid, item]))
    const refused = []
    for (const target of targets) {
      const current = byPid.get(target.pid)
      if (!current) refused.push({ pid: target.pid, reason: message('stop.refused.gone', target.pid) })
      else if (current.startedAt !== target.startedAt || identityOf(current) !== target.identity)
        refused.push({ pid: target.pid, reason: message('stop.refused.changed', target.pid) })
      else {
        const reason = this.refusal(target.pid, signal, sessions.get(target.pid))
        if (reason) refused.push({ pid: target.pid, reason })
      }
    }
    if (refused.length) {
      logEvent('log.stop.refused', signal, pids.join(','), refused.map(item => item.pid).join(','))
      return { signal, outcome: 'changed', stopped: [], refused, note: message('stop.result.refused') }
    }
    const stopped = []
    for (const target of targets) {
      let outcome = 'sent'
      try { this.kill(target.pid, signal) }
      catch (error) { outcome = error?.code === 'ESRCH' ? 'ended' : error?.code === 'EPERM' ? 'denied' : 'failed' }
      if (outcome === 'sent' && signal === 'SIGTERM') this.terminated.set(target.pid, { startedAt: target.startedAt, identity: target.identity })
      if (signal === 'SIGKILL') this.terminated.delete(target.pid)
      stopped.push({ pid: target.pid, outcome })
    }
    logEvent('log.stop', signal, stopped.map(item => `${item.pid}:${item.outcome}`).join(','))
    return { signal, outcome: 'stopped', stopped, refused: [], note: message(signal === 'SIGTERM' ? 'stop.result.term' : 'stop.result.kill') }
  }

  /**
   * The requests for the clients: each open request with its PIDs, agents and project directories, and the status of the
   * last closed requests. It holds no command line and no session content.
   */
  view() {
    return {
      requests: [...this.requests.values()].map(request => ({ id: request.id, signal: request.signal,
        expiresAt: iso(request.createdAt + STOP_REQUEST_MS),
        targets: request.targets.map(({ pid, agent, cwd }) => ({ pid, agent, cwd })) })),
      closed: [...this.closed].map(([id, status]) => ({ id, status })),
    }
  }

  /** Calls [listener] with the view after each change. Gives the function that ends the watch. */
  watch(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  publish() {
    const view = this.view()
    for (const listener of this.listeners) listener(view)
  }

  /** Records that a client stream got [view], so an expiry can tell whether a client had the dialog. */
  delivered(view) {
    for (const item of view.requests) {
      const request = this.requests.get(item.id)
      if (request) request.delivered = true
    }
  }

  /** Closes each open request at the stop of the daemon. */
  stop() {
    for (const request of [...this.requests.values()]) this.close(request, 'cancelled')
  }
}

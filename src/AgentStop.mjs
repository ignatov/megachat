import { randomBytes } from 'node:crypto'
import { agentSessions, identityOf } from './AgentProcesses.mjs'
import { logEvent, message, MegachatError, requireCondition } from './messages.mjs'

/**
 * The time in which the user can confirm a stop. After it, the confirmation is not valid, and the process can be
 * another one.
 */
export const STOP_CONFIRMATION_MS = 5 * 60 * 1000
/** The limit of the PIDs of one call. */
export const STOP_MAX_PIDS = 20
export const SIGNALS = ['SIGTERM', 'SIGKILL']
/** The limit of the open confirmations. A new one removes the oldest one. */
const MAX_CONFIRMATIONS = 32
const systemClock = { now: () => Date.now() }
const iso = time => new Date(time).toISOString()

/**
 * The tool `agents_stop`: it stops an orphan agent session with a signal, in two steps. The first call gives the list of
 * the processes and a confirmation. The second call, in a later turn of the user, sends the signal with that
 * confirmation. Directly before the signal, Megachat reads the process table again. The process must have the same
 * PID, the same start time and the same command, and its state must still be `orphan`.
 *
 * The process table, the signal function and the clock come from the caller, so a test sends no real signal. The
 * confirmations stay in the memory of the daemon: a restart of the daemon makes each one invalid.
 */
export class AgentStop {
  constructor(state, { table, running, kill = (pid, signal) => process.kill(pid, signal), clock = systemClock,
    daemonPid = process.pid, daemonParentPid = process.ppid, uid = process.geteuid?.() } = {}) {
    Object.assign(this, { state, table, running, kill, clock, daemonPid, daemonParentPid, uid })
    // Each open confirmation by its token: `{ signal, turnId, createdAt, targets: [{ pid, startedAt, identity }] }`.
    this.confirmations = new Map()
    // The tokens that a call used or that expired, so that the answer can say why a token is not valid.
    this.spent = new Map()
    // The processes that got SIGTERM from this tool: `{ startedAt, identity }` by PID. Only such a process can get SIGKILL.
    this.terminated = new Map()
  }

  /** One call of the tool: without [confirmation] the first step, with it the second step. */
  async call({ pids, signal = 'SIGTERM', confirmation } = {}) {
    requireCondition(Array.isArray(pids) && pids.length >= 1 && pids.length <= STOP_MAX_PIDS && pids.every(Number.isSafeInteger))
    requireCondition(new Set(pids).size === pids.length && SIGNALS.includes(signal))
    requireCondition(confirmation === undefined || typeof confirmation === 'string' && /^[0-9a-f]{32}$/.test(confirmation))
    // A protected PID refuses the call before each other check.
    for (const pid of pids) if (pid <= 1 || pid === this.daemonPid || pid === this.daemonParentPid) throw new MegachatError('stopProtected', pid)
    if (!this.table.supported) throw new MegachatError('stopPlatform', this.table.platform)
    const processes = await this.table.processes()
    const protectedPids = this.ancestors(processes)
    const byPid = new Map(processes.map(item => [item.pid, item]))
    for (const pid of pids) {
      if (protectedPids.has(pid)) throw new MegachatError('stopProtected', pid)
      if (byPid.has(pid) && (!Number.isSafeInteger(this.uid) || byPid.get(pid).uid !== this.uid)) throw new MegachatError('stopOtherUser', pid)
    }
    const state = await this.state.snapshot()
    if (state.current?.kind !== 'user') throw new MegachatError('stopEvent')
    this.expire()
    for (const [pid, sent] of this.terminated) if (byPid.get(pid)?.startedAt !== sent.startedAt) this.terminated.delete(pid)
    return confirmation === undefined ? this.prepare(pids, signal, processes, state) : this.stop(pids, signal, confirmation, processes, state)
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

  /** The first step: the processes that would get [signal], the refused PIDs, and a confirmation for the processes. */
  async prepare(pids, signal, processes, state) {
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
    if (!targets.length) {
      logEvent('log.stop.refused', signal, pids.join(','), 'none')
      return { signal, confirmation: null, targets: [], refused, note: message('stop.preview.none') }
    }
    const token = randomBytes(16).toString('hex')
    const createdAt = this.clock.now()
    this.confirmations.set(token, { signal, turnId: state.current.id, createdAt,
      targets: targets.map(({ pid, startedAt, identity }) => ({ pid, startedAt, identity })) })
    while (this.confirmations.size > MAX_CONFIRMATIONS) this.retire(this.confirmations.keys().next().value, 'expired')
    return {
      signal, confirmation: token, expiresAt: iso(createdAt + STOP_CONFIRMATION_MS),
      targets: targets.map(({ identity, startedAt, ...target }) => ({ ...target, startedAt: iso(startedAt) })),
      refused, note: message('stop.preview.note', targets.map(target => target.pid).join(', ')),
    }
  }

  /**
   * The second step. The confirmation is valid one time only, in a later turn of the user, before its expiry, for the
   * same PIDs and the same signal. Then each process must be the same process and still an orphan, else no signal goes
   * out at all.
   */
  async stop(pids, signal, token, processes, state) {
    const known = this.confirmations.get(token)
    if (!known) throw new MegachatError(this.spent.get(token) === 'used' ? 'stopUsed' : this.spent.get(token) === 'expired' ? 'stopExpired' : 'stopUnknown',
      STOP_CONFIRMATION_MS / 60000)
    // Each check of a confirmation uses it, so a second call with the same token gets no signal.
    this.retire(token, 'used')
    if (known.turnId === state.current.id) throw new MegachatError('stopSameTurn')
    const confirmed = known.targets.map(target => target.pid)
    if (known.signal !== signal || confirmed.length !== pids.length || !pids.every(pid => confirmed.includes(pid))) throw new MegachatError('stopOther')
    // Directly before the signal, a new read of the process table. The table of the call is new already.
    const sessions = this.sessions(processes, state)
    const byPid = new Map(processes.map(item => [item.pid, item]))
    const refused = []
    for (const target of known.targets) {
      const session = sessions.get(target.pid)
      if (!byPid.has(target.pid)) refused.push({ pid: target.pid, reason: message('stop.refused.gone', target.pid) })
      else if (byPid.get(target.pid).startedAt !== target.startedAt || identityOf(byPid.get(target.pid)) !== target.identity)
        refused.push({ pid: target.pid, reason: message('stop.refused.changed', target.pid) })
      else {
        const reason = this.refusal(target.pid, signal, session)
        if (reason) refused.push({ pid: target.pid, reason })
      }
    }
    if (refused.length) {
      logEvent('log.stop.refused', signal, pids.join(','), refused.map(item => item.pid).join(','))
      return { signal, stopped: [], refused, note: message('stop.result.refused') }
    }
    const stopped = []
    for (const target of known.targets) {
      let outcome = 'sent'
      try { this.kill(target.pid, signal) }
      catch (error) { outcome = error?.code === 'ESRCH' ? 'ended' : error?.code === 'EPERM' ? 'denied' : 'failed' }
      if (outcome === 'sent' && signal === 'SIGTERM') this.terminated.set(target.pid, { startedAt: target.startedAt, identity: target.identity })
      if (signal === 'SIGKILL') this.terminated.delete(target.pid)
      stopped.push({ pid: target.pid, outcome })
    }
    logEvent('log.stop', signal, stopped.map(item => `${item.pid}:${item.outcome}`).join(','))
    return { signal, stopped, refused: [], note: message(signal === 'SIGTERM' ? 'stop.result.term' : 'stop.result.kill') }
  }

  /** Removes the expired confirmations, and keeps a bounded record of the spent tokens. */
  expire() {
    const now = this.clock.now()
    for (const [token, known] of this.confirmations) if (now - known.createdAt >= STOP_CONFIRMATION_MS) this.retire(token, 'expired')
    while (this.spent.size > 4 * MAX_CONFIRMATIONS) this.spent.delete(this.spent.keys().next().value)
  }

  retire(token, why) {
    this.confirmations.delete(token)
    this.spent.set(token, why)
  }
}

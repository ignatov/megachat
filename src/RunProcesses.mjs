import { execFile } from 'node:child_process'

/**
 * The processes of a Claude or Codex child run, for its supervisor (see `child-supervisor.mjs` and the capability
 * `child-processes`). A process of the run is the agent, a process that the record has with the same start time and
 * user, a process whose parent is a process of the run, or a process in a process group that a process of the run made,
 * with a live process of the run in it. No name, no command line and no environment variable selects a process.
 *
 * A process can join only a process group of its own session, and it cannot change to a session that it did not make.
 * So a process in the same group as a live process of the run descends from the run.
 */

/** The time between two reads of the record while the agent runs. */
export const READ_INTERVAL_MS = 1000
/**
 * The time limits of one read of the process table: a read of the record while the agent runs, and a read at the end.
 * A read that takes longer gives no table. Under a high load of the machine, one read took 1.15 seconds.
 */
export const READ_TIMEOUT_MS = 5000
export const END_READ_TIMEOUT_MS = 2000
/** The longest wait between SIGTERM and SIGKILL. */
export const TERM_WAIT_MS = 1000
/** The time between two looks at the processes that got SIGTERM. */
export const LOOK_MS = 50
/**
 * The checks of `refusal`. The log line of a refusal gives the number. A process that ended (`GONE`) is the usual case,
 * so it gives no log line.
 */
export const CHECK = { PROTECTED: 1, GONE: 2, UNRECORDED: 3, OLDER: 4, GROUP: 5 }

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
// The locale C gives `lstart` as "Thu Nov 12 19:31:46 2026" on each machine.
const LINE = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s*$/
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,pgid=,uid=,lstart=']
const PS_ENVIRONMENT = { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }

/**
 * Reads the output of `ps -A -o pid=,ppid=,pgid=,uid=,lstart=` in the locale C into a map from each PID to
 * `{ pid, ppid, pgid, uid, start, startedAt }`. `start` is the text of the start time, which two reads give the same for
 * one process, and `startedAt` is the start time in seconds. A line of another form, such as a cut line, gives no
 * process.
 */
export function parseTable(output) {
  const table = new Map()
  for (const line of String(output).split('\n')) {
    const match = LINE.exec(line)
    if (!match) continue
    const [, pid, ppid, pgid, uid, month, day, hours, minutes, seconds, year] = match
    const monthIndex = MONTHS.indexOf(month)
    const startedAt = new Date(Number(year), monthIndex, Number(day), Number(hours), Number(minutes), Number(seconds)).getTime() / 1000
    if (monthIndex < 0 || !Number.isFinite(startedAt)) continue
    table.set(Number(pid), { pid: Number(pid), ppid: Number(ppid), pgid: Number(pgid), uid: Number(uid),
      start: `${year} ${month} ${day} ${hours}:${minutes}:${seconds}`, startedAt })
  }
  return table
}

/**
 * One read of the process table of macOS. It gets no command line, so `AgentProcesses.mjs` stays the only module that
 * reads one. An exit code other than 0, an error and the time limit reject, and their output does not count.
 */
export function readTable(timeout = READ_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    execFile('/bin/ps', PS_ARGS, { env: PS_ENVIRONMENT, encoding: 'latin1', timeout, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => error ? reject(error) : resolve(parseTable(stdout)))
  })
}

/** An empty record: the live processes of the run by PID, each PID that it had with its start time, and the agent. */
export const newRecord = () => ({ live: new Map(), known: new Map(), agent: null })

/** The PIDs of [starts] (the supervisor and the daemon) and each process above them in [table]. */
export function protectedPids(table, starts) {
  const found = new Set()
  for (const start of starts) {
    for (let pid = start; Number.isSafeInteger(pid) && pid > 1 && !found.has(pid) && found.size < 256; pid = table?.get(pid)?.ppid ?? 0) found.add(pid)
  }
  return found
}

/**
 * The processes of the run in [table], by PID. [agentPid] is the PID of the agent while the supervisor has not seen
 * its exit, else 0. [guarded] holds the protected PIDs. A process of another user is never a process of the run.
 */
export function selectRun(table, record, { agentPid, uid, guarded }) {
  const members = new Map()
  const eligible = row => row.pid > 1 && row.uid === uid && !guarded.has(row.pid)
  const agent = agentPid ? table.get(agentPid) : undefined
  if (agent && eligible(agent) && (!record.agent || record.agent.start === agent.start)) members.set(agent.pid, agent)
  for (const row of table.values()) {
    const known = record.live.get(row.pid)
    if (known && known.start === row.start && known.uid === row.uid && eligible(row)) members.set(row.pid, row)
  }
  for (let grown = true; grown;) {
    grown = false
    const groups = new Set([...members.values()].map(row => row.pgid))
    for (const row of table.values()) {
      if (members.has(row.pid) || !eligible(row)) continue
      const byParent = row.ppid > 1 && members.has(row.ppid)
      // A group that a process of the run made: its ID is a PID of the run, and a live process of the run is in it.
      const byGroup = groups.has(row.pgid) && (members.has(row.pgid) || record.known.has(row.pgid))
      if (byParent || byGroup) {
        members.set(row.pid, row)
        grown = true
      }
    }
  }
  return members
}

/** Makes [members], the processes of the run of one read, the live part of [record]. */
export function updateRecord(record, members, agentPid) {
  record.live = new Map([...members].map(([pid, row]) => [pid, { start: row.start, uid: row.uid, pgid: row.pgid, startedAt: row.startedAt }]))
  for (const [pid, row] of members) record.known.set(pid, row.start)
  if (!record.agent && agentPid && members.has(agentPid)) record.agent = { pid: agentPid, start: members.get(agentPid).start, startedAt: members.get(agentPid).startedAt }
}

/**
 * The guards of a signal to [pid]: the number of the first check of `CHECK` that fails, or 0. [table] is the read
 * directly before the signal. The guards read only the record, the table, the protected PIDs and the user, and not the
 * selection, so a defect of the selection cannot reach a process of the user.
 */
export function refusal(pid, { table, record, guarded, uid }) {
  if (!Number.isSafeInteger(pid) || pid <= 1 || guarded.has(pid)) return CHECK.PROTECTED
  const row = table?.get(pid)
  if (!row) return CHECK.GONE
  const known = record.live.get(pid)
  if (row.uid !== uid || !known || known.start !== row.start || known.uid !== row.uid) return CHECK.UNRECORDED
  // A process of the run cannot be older than its agent. The start time has a resolution of 1 second.
  if (!record.agent || row.startedAt < record.agent.startedAt) return CHECK.OLDER
  if (!record.known.has(row.pgid)) return CHECK.GROUP
  return 0
}

/**
 * The record and the end of the processes of one run. The platform, the read, the signal function, the clock and the
 * wait come from the caller, so a test sends no real signal. [report] gets the PID and the check of each refusal.
 * [daemon] is the parent of the supervisor at its start, and [parent] gives its parent now.
 *
 * The end `keep` is the end of before: SIGKILL to the process group of the agent at once. The end `clean` also ends
 * each process of the run: SIGTERM, a wait of at most [termWaitMs], then SIGKILL. On a platform other than macOS, each
 * end is `keep`. In the end `clean`, the process group of the agent gets SIGTERM first, then the read of the table
 * runs, then each other process of the run gets SIGTERM.
 */
export class RunProcesses {
  constructor({ agentPid, platform = process.platform, read = readTable, kill = (pid, signal) => process.kill(pid, signal),
    report = () => {}, self = process.pid, daemon = process.ppid, parent = () => daemon, uid = process.geteuid?.(),
    now = () => Date.now(), wait = ms => new Promise(resolve => setTimeout(resolve, ms)), interval = READ_INTERVAL_MS,
    termWaitMs = TERM_WAIT_MS } = {}) {
    Object.assign(this, { agentPid, platform, read, kill, report, self, daemon, parent, uid, now, wait, interval, termWaitMs })
    this.record = newRecord()
    this.agentAlive = true
    this.stopped = false
    this.reads = 0
  }

  get enabled() { return this.platform === 'darwin' && Number.isSafeInteger(this.uid) }

  /** Starts the reads of the record: one now, and one each [interval] after the end of the read before it. */
  start() {
    if (!this.enabled) return
    const next = async () => {
      if (this.stopped || !this.agentAlive) return
      await this.refresh()
      if (!this.stopped && this.agentAlive) this.timer = setTimeout(next, this.interval)
    }
    next()
  }

  agentExited() { this.agentAlive = false }

  /** A read of the table, or null when the read failed. */
  async readOnce(timeout = READ_TIMEOUT_MS) {
    this.reads++
    try { return await this.read(timeout) }
    catch { return null }
  }

  async refresh() {
    const table = await this.readOnce()
    if (table && !this.stopped) this.update(table)
    return table
  }

  guarded(table) { return protectedPids(table, [this.self, this.daemon, this.parent()]) }

  update(table) {
    const agentPid = this.agentAlive ? this.agentPid : 0
    updateRecord(this.record, selectRun(table, this.record, { agentPid, uid: this.uid, guarded: this.guarded(table) }), agentPid)
  }

  /** True when the record has a process outside the process group of the agent. */
  outside() { return [...this.record.live.values()].some(entry => entry.pgid !== this.agentPid) }

  /** Sends [signal] to [pid] only when `refusal` gives 0 for [table]. Gives true when the signal went out. */
  send(pid, signal, table) {
    const check = refusal(pid, { table, record: this.record, guarded: this.guarded(table), uid: this.uid })
    if (check) {
      if (check !== CHECK.GONE) this.report(pid, check)
      return false
    }
    try { this.kill(pid, signal) }
    catch { return false }
    return true
  }

  /** The signal of before: to the process group of the agent. */
  signalGroup(signal) {
    const pid = this.agentPid
    if (!Number.isSafeInteger(pid) || pid <= 1 || [this.self, this.daemon, this.parent()].includes(pid)) return
    try { this.kill(-pid, signal) }
    catch {}
  }

  exists(target) {
    try { this.kill(target, 0); return true }
    catch (error) { return error?.code === 'EPERM' }
  }

  /** Ends the run with the end `keep` or `clean`. */
  async end(mode) {
    this.stopped = true
    clearTimeout(this.timer)
    if (mode !== 'clean' || !this.enabled) {
      this.signalGroup('SIGKILL')
      return
    }
    // The agent gets SIGTERM before the read, so its error output ends as fast as before (see `AcpRunService`).
    this.signalGroup('SIGTERM')
    let table = null
    if (this.outside()) {
      table = await this.readOnce(END_READ_TIMEOUT_MS)
      if (table) this.update(table)
    }
    const targets = table ? [...this.record.live.keys()].filter(pid => pid !== this.agentPid) : []
    const sent = targets.filter(pid => this.send(pid, 'SIGTERM', table))
    const running = () => this.exists(-this.agentPid) || sent.some(pid => this.exists(pid))
    // The first looks come soon, because most processes end at once at SIGTERM.
    for (let look = 0, deadline = this.now() + this.termWaitMs; running() && this.now() < deadline; look++) {
      await this.wait(Math.min(LOOK_MS, 5 * 2 ** look))
    }
    if (!running()) return
    const again = sent.length ? await this.readOnce(END_READ_TIMEOUT_MS) : null
    this.signalGroup('SIGKILL')
    if (!again) return
    this.update(again)
    for (const pid of this.record.live.keys()) if (pid !== this.agentPid) this.send(pid, 'SIGKILL', again)
  }
}

import { execFile } from 'node:child_process'
import { logEvent, logFailure } from './messages.mjs'
import { terminalStates } from './MegachatState.mjs'
import { directoriesOf } from './ProjectDirectories.mjs'
import { directoryOf } from './SessionLog.mjs'
import { readTokprof } from './Tokprof.mjs'
import { isWorkingDate, localDate, nextWorkdayStart, reportPeriod, zonedTime } from './Workday.mjs'

/**
 * The longest wait of the timer. A timer of a computer that slept comes late, so the timer looks at the clock again
 * after this time, and a missed report comes soon after the computer wakes.
 */
export const REPORT_RECHECK_MS = 15 * 60000
const LIST_LIMIT = 30
const TITLE_LIMIT = 80
const SESSION_PROJECTS = 20
const SESSION_TITLES = 5
const COMMIT_PROJECTS = 20
const COMMITS = 30
const GIT_TIMEOUT_MS = 10000
/** The request IDs of the automatic turns. Each other input is a turn of the user. */
const AUTOMATIC_REQUEST = /^(children|sessions|morning):/

const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); timer.unref(); return timer },
  clearTimeout: timer => clearTimeout(timer),
}

/** The time settings of the report: `workday.start`, `workday.days` and `workday.timezone`, also with `workday.enabled` off. */
export function reportWorkday(values) {
  return { start: values['workday.start'], days: values['workday.days'], timezone: values['workday.timezone'] }
}

/**
 * The timer of the morning report, the first scheduler of the daemon. It keeps no time in memory: each check takes the
 * next time from the settings and the clock. On a working day after `workday.start`, when the state has no report of
 * that date, it calls [prepare] with the date, also after a missed timer. [lastDate] reads the date of the last report
 * from the state, so a restart sends no second report. Checks run one at a time.
 */
export class MorningReport {
  constructor({ clock = systemClock, values, lastDate, prepare }) {
    Object.assign(this, { clock, values, lastDate, prepare })
    this.closed = false
    this.running = Promise.resolve()
  }

  /** Checks now, and then at the next start of a working day. A change of a setting calls it again. */
  check() {
    this.running = this.running.then(() => this.#check()).catch(error => logFailure('log.report.failed', error))
    return this.running
  }

  async #check() {
    this.cancel()
    if (this.closed) return
    const values = this.values()
    if (!values['report.morning']) return
    const workday = reportWorkday(values)
    // A failed report keeps no date, so the next check tries again.
    try { if (await this.due(workday)) await this.prepare(localDate(this.clock.now(), workday.timezone)) }
    catch (error) { logFailure('log.report.failed', error) }
    if (this.closed) return
    const now = this.clock.now()
    const next = nextWorkdayStart(workday, now) ?? Infinity
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.check() }, Math.min(REPORT_RECHECK_MS, next - now))
  }

  /** True when today is a working day, its start is past, and the state has no report of today. */
  async due(workday) {
    const now = this.clock.now()
    const today = localDate(now, workday.timezone)
    return isWorkingDate(workday, today) && now >= zonedTime(today, workday.start, workday.timezone) && await this.lastDate() !== today
  }

  cancel() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  async close() {
    this.closed = true
    this.cancel()
    await this.running
  }
}

const iso = time => Number.isFinite(time) ? new Date(time).toISOString() : null
const cents = usd => Math.round(usd * 100) / 100
const titleOf = run => (run.title ?? run.prompt ?? '').replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT)
const child = run => ({ title: titleOf(run), project: run.cwd, agent: run.agent ?? 'claude', status: run.status })

/** The commits of [cwd] in the time from [from] to [to], from `git log` with a time limit. Gives `undefined` on a failure. */
function commitsOf(cwd, from, to, environment, signal) {
  return new Promise(resolve => {
    execFile('git', ['-C', cwd, 'log', '--all', '--no-merges', `--since=${iso(from)}`, `--until=${iso(to)}`, `--max-count=${COMMITS + 1}`,
      '--format=%h %s'], { env: environment, timeout: GIT_TIMEOUT_MS, maxBuffer: 256 * 1024, windowsHide: true, signal },
    (error, stdout) => resolve(error ? undefined : stdout.split('\n').filter(Boolean)))
  })
}

/** The sessions of the index with activity in the period, by project. */
async function sessionsOf(store, directories, from, to) {
  if (!store) return { state: 'off' }
  const projects = new Map()
  for (const row of await store.activeSessions(from, to)) {
    const project = directoryOf(row.cwd, directories)?.cwd ?? row.cwd
    const item = projects.get(project) ?? { project, sessions: 0, agents: {}, titles: [] }
    item.sessions++
    item.agents[row.agent] = (item.agents[row.agent] ?? 0) + 1
    if (row.title && item.titles.length < SESSION_TITLES) item.titles.push(row.title.replace(/\s+/g, ' ').trim().slice(0, TITLE_LIMIT))
    projects.set(project, item)
  }
  const sorted = [...projects.values()].sort((left, right) => right.sessions - left.sessions)
  return { state: 'on', projects: sorted.slice(0, SESSION_PROJECTS), moreProjects: Math.max(0, sorted.length - SESSION_PROJECTS) }
}

/**
 * The data of the morning report of [date], or `null` for a period without activity: no turn of the user, no child run
 * and no spend of Megachat. The daemon collects it, and the main agent only writes the text. The money of Megachat
 * and the money of the other sessions stay apart: the key of Megachat paid the first, and the accounts of the agents
 * paid the second, so tokprof gives only its API-equivalent cost. [signal] stops the commands at the stop of the daemon.
 */
export async function collectReportData({ state, date, workday, spend, sessionStore, home, stateDirectory, environment = process.env,
  now = Date.now(), tokprofTimeoutMs, signal }) {
  const timezone = workday.timezone
  const period = reportPeriod(workday, date)
  const from = zonedTime(period.from, '00:00', timezone)
  const to = zonedTime(date, '00:00', timezone)
  const inPeriod = time => Number.isFinite(time) && time >= from && time < to
  const userTurns = Object.entries(state.inputs)
    .filter(([requestId, input]) => !AUTOMATIC_REQUEST.test(requestId) && inPeriod(input.admittedAt)).length
  const runs = Object.values(state.runs)
  const periodRuns = runs.filter(run => inPeriod(run.createdAt) || inPeriod(run.finishedAt))
  const days = spend.daily(period.dates)
  if (!userTurns && !periodRuns.length && !days.some(day => day.usd > 0)) return null
  const finished = runs.filter(run => terminalStates.has(run.status) && inPeriod(run.finishedAt))
  const directories = directoriesOf(state)
  const commits = []
  let unreadable = 0
  const repositories = directories.filter(directory => directory.origin !== 'megachat')
  for (const directory of repositories.slice(0, COMMIT_PROJECTS)) {
    if (signal?.aborted) return null
    const lines = await commitsOf(directory.cwd, from, to, environment, signal)
    if (!lines) { unreadable++; continue }
    if (!lines.length) continue
    commits.push({ project: directory.cwd, commits: lines.slice(0, COMMITS).map(line => line.slice(0, 120)), more: lines.length > COMMITS })
  }
  const megachatUsd = days.reduce((sum, day) => sum + day.usd, 0)
  const piUsd = days.reduce((sum, day) => sum + day.piUsd, 0)
  const tokprof = await readTokprof({ since: period.from, until: date, environment, home, stateDirectory, timeoutMs: tokprofTimeoutMs,
    signal })
  return {
    date, period: { from: period.from, to: period.to, timezone },
    userTurns,
    children: {
      done: finished.filter(run => run.status === 'completed').slice(-LIST_LIMIT).map(child),
      failed: finished.filter(run => ['failed', 'cancelled', 'interrupted'].includes(run.status)).slice(-LIST_LIMIT).map(child),
      running: runs.filter(run => !terminalStates.has(run.status)).slice(-LIST_LIMIT).map(child),
    },
    permissionsWaiting: Object.values(state.permissions).filter(permission => permission.status === 'pending').slice(-LIST_LIMIT)
      .map(permission => ({ ...child(state.runs[permission.runId] ?? {}), since: iso(permission.createdAt) })),
    sessions: await sessionsOf(sessionStore, directories, from, to),
    commits: { projects: commits, moreProjects: Math.max(0, repositories.length - COMMIT_PROJECTS), unreadableProjects: unreadable },
    money: {
      megachat: { paidBy: 'megachatKey', usd: cents(megachatUsd), mainAgentUsd: cents(megachatUsd - piUsd), piChildrenUsd: cents(piUsd),
        days: days.map(day => ({ day: day.day, usd: cents(day.usd), piChildrenUsd: cents(day.piUsd) })) },
      otherSessions: { paidBy: 'agentAccounts', costKind: 'apiEquivalent', ...tokprof },
    },
    collectedAt: iso(now),
  }
}

/** Logs the outcome of a prepared report with no content: the date, and whether a turn follows. */
export function logReport(date, data) {
  logEvent(data ? 'log.report.ready' : 'log.report.empty', date)
}

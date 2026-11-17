import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { promisify } from 'node:util'
import { executableFile } from './CentralConfigurationService.mjs'
import { logEvent, logFailure, MegachatError, message } from './messages.mjs'

/**
 * The cloud sessions of the Central login of the user (see the capability `cloud-sessions`). The plugin `airc` of
 * JetBrains Central lists them: the sessions that Air, Air Web and the automations started in JCP Cloud. Megachat only
 * reads the list. It cannot start, cancel or continue a cloud session. A cloud note is a fixed text from a template, as a
 * note about the agent sessions is (see `SessionNotes.mjs`): the daemon writes it into the conversation without a run.
 */

/** The interval of the reads of the list. A cloud session runs for minutes or hours, and each read is a network request. */
export const CLOUD_CHECK_MS = 2 * 60000
/** The count of the sessions that one read asks `airc` for. */
export const CLOUD_LIST_LIMIT = 50
/** The default count of the sessions in the output of `agents_cloud`. */
export const CLOUD_TOOL_LIMIT = 20
/** The time limits of `central plugins` and of a read of the list. */
export const PLUGINS_TIMEOUT_MS = 10000
export const READ_TIMEOUT_MS = 30000
const READ_BUFFER = 4 * 1024 * 1024
const PLUGINS_BUFFER = 1024 * 1024
/** The statuses that give a note: the session finished, failed, or waits for the user. */
export const CLOUD_NOTE_STATUSES = new Set(['FINISHED', 'USER_INPUT_REQUIRED', 'ERROR', 'ABORTED'])
/** The statuses of a failed session, and of a session that runs. `SUSPENDED` is a stopped environment that can continue. */
export const CLOUD_FAILED = new Set(['ERROR', 'ABORTED'])
export const CLOUD_RUNNING = new Set(['LAUNCHING', 'STARTING_CONTAINER', 'RUNNING'])
/** The lines of one note. The other sessions get one line with their count. */
export const CLOUD_NOTE_LINES = 10
/** The records that the state keeps, their longest age, and the age after which a read renews a record. */
export const CLOUD_RECORDS = 200
export const CLOUD_RECORD_MS = 30 * 86400000
export const CLOUD_RENEW_MS = 86400000
/** The count of the sessions in each list of the part `cloud` of the morning report. */
const REPORT_LIMIT = 30
const NAME_LIMIT = 80
const COMMENT_LIMIT = 200
const ERROR_LINE_LIMIT = 200

const execute = promisify(execFile)

/**
 * Finds the binary of the plugin `airc` with one call of `central plugins`. Central prints one line for each plugin,
 * with the fields separated by tabs: the ID, the version, the state, `present=`, `origin=`, `source=<directory>` and
 * `hooks=`. The binary is the `executable` of the `manifest.json` in the source directory. Gives `{ path }`, or
 * `{ reason }` with `central` (the call failed), `plugin` (no active plugin `airc`) or `executable` (no binary).
 */
export async function locateAirc({ central, env, timeoutMs = PLUGINS_TIMEOUT_MS } = {}) {
  if (!central) return { reason: 'central' }
  let stdout
  try { ({ stdout } = await execute(central, ['plugins'], { env, timeout: timeoutMs, maxBuffer: PLUGINS_BUFFER })) }
  catch { return { reason: 'central' } }
  const fields = String(stdout).split('\n').map(line => line.split('\t')).find(line => line[0] === 'airc')
  if (!fields || fields[2] !== 'active') return { reason: 'plugin' }
  const source = fields.find(field => field.startsWith('source='))?.slice('source='.length)
  if (!source || !isAbsolute(source)) return { reason: 'executable' }
  try {
    const { executable } = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
    const path = typeof executable === 'string' ? resolve(source, executable) : undefined
    // The binary must be in the directory of the plugin.
    return path && path.startsWith(source + sep) && await executableFile(path) ? { path } : { reason: 'executable' }
  }
  catch { return { reason: 'executable' } }
}

const text = value => typeof value === 'string' ? value : undefined
const short = value => (typeof value === 'number' || typeof value === 'string') && /^[\w-]{1,32}$/.test(String(value)) ? String(value) : '?'

/** The error of a failed read. `cloudReason` and `exitCode` are fixed words for the log, without the output of `airc`. */
function cloudError(reason, exitCode, code, ...args) {
  return Object.assign(new MegachatError(code, ...args), { cloudReason: reason, exitCode })
}

function readError(error, timeoutMs) {
  // A stop of the daemon or of the tool call is no failure of `airc`.
  if (error?.name === 'AbortError') return error
  const line = String(error?.stderr ?? '').split('\n').map(item => item.trim()).find(Boolean)?.slice(0, ERROR_LINE_LIMIT)
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return cloudError('output', '-', 'cloudOutput')
  if (error?.killed) return cloudError('timeout', '-', 'cloudTimeout', Math.round(timeoutMs / 1000))
  if (typeof error?.code === 'number') return line ? cloudError('exit', error.code, 'cloudExit', error.code, line)
    : cloudError('exit', error.code, 'cloudExitSilent', error.code)
  return cloudError('start', short(error?.code ?? error?.signal), 'cloudStart', short(error?.code ?? error?.signal))
}

/** One cloud session with the fields of the type of `airc`, and no other field. */
function sessionOf(item) {
  const repositories = (Array.isArray(item.repositories) ? item.repositories : []).filter(repository => repository && typeof repository === 'object')
    .map(repository => Object.fromEntries(['host', 'organization', 'repository', 'branch', 'resultsBranch']
      .filter(field => text(repository[field]) !== undefined).map(field => [field, repository[field]])))
  return { id: item.id, name: text(item.name) ?? '', status: text(item.status) ?? '',
    ...(text(item.statusComment) ? { statusComment: item.statusComment } : {}), agent: text(item.agent) ?? '', repositories,
    updatedAt: text(item.updatedAt) ?? null, ...(text(item.taskId) ? { taskId: item.taskId } : {}) }
}

/**
 * Reads the cloud sessions with `airc sessions --limit 50`, with the `PATH` of Central in [env]. The output must be a
 * JSON array of objects with a string `id`. Else the read fails with a `MegachatError` that gives the exit code and the
 * first line of the error output to the main agent. [signal] ends `airc` at the stop of the daemon.
 */
export async function readCloudSessions(airc, { env, timeoutMs = READ_TIMEOUT_MS, signal } = {}) {
  let stdout
  try { ({ stdout } = await execute(airc, ['sessions', '--limit', String(CLOUD_LIST_LIMIT)], { env, timeout: timeoutMs, maxBuffer: READ_BUFFER, signal })) }
  catch (error) { throw readError(error, timeoutMs) }
  let list
  try { list = JSON.parse(stdout) }
  catch { throw cloudError('output', '-', 'cloudOutput') }
  if (!Array.isArray(list) || !list.every(item => item && typeof item === 'object' && typeof item.id === 'string' && item.id))
    throw cloudError('output', '-', 'cloudOutput')
  return list.map(sessionOf)
}

/** Writes the line of a failed read or check to the log. The line never holds the output of `airc`. */
export function logCloudFailure(error) {
  if (error?.cloudReason) logEvent('log.cloud.failed', error.cloudReason, short(error.exitCode))
  else logFailure('log.cloud.failed', error, 'other', '-')
}

/**
 * The output of `agents_cloud` from the [sessions] of a read: the sessions with the status [status], without regard to
 * the case, at most [limit] of them. `more` is true when more sessions match.
 */
export function cloudToolOutput(sessions, { status, limit = CLOUD_TOOL_LIMIT } = {}) {
  const wanted = typeof status === 'string' && status.trim() ? status.trim().toUpperCase() : undefined
  const matching = wanted ? sessions.filter(session => session.status.toUpperCase() === wanted) : sessions
  return { sessions: matching.slice(0, limit), more: matching.length > limit }
}

/** The key of the record of a cloud session: a hash of its ID. So the state holds no session ID. */
export function cloudKey(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 32)
}

/**
 * The plan of one read from the [watch] of the state (`{ since, records }`) and the [sessions] of the read at the time
 * [now]. `due` holds the sessions that need a note: a status of a note, a record with another status or no record, and
 * a change at or after the start of the watch. Their records change only when the note goes out. `changes` holds the
 * records that change without a note: a new status, or a record older than [CLOUD_RENEW_MS], so the record of a listed
 * session does not expire and give a second note.
 */
export function planCloudNotes(watch, sessions, now) {
  const records = watch?.records ?? {}
  const since = watch?.since
  const due = []
  const changes = {}
  const seen = new Set()
  for (const session of sessions) {
    const key = cloudKey(session.id)
    if (seen.has(key)) continue
    seen.add(key)
    const record = records[key]
    const updatedAt = Date.parse(session.updatedAt ?? '')
    if (CLOUD_NOTE_STATUSES.has(session.status) && record?.status !== session.status && Number.isFinite(since)
      && Number.isFinite(updatedAt) && updatedAt >= since) due.push({ key, session })
    else if (record?.status !== session.status || !(now - record.seenAt < CLOUD_RENEW_MS)) changes[key] = { status: session.status, seenAt: now }
  }
  return { due, changes }
}

/**
 * Keeps the records small: a record older than [CLOUD_RECORD_MS] goes, and then the oldest records until
 * [CLOUD_RECORDS] stay.
 */
export function pruneCloudRecords(records, now) {
  for (const [key, record] of Object.entries(records)) if (!(now - record.seenAt < CLOUD_RECORD_MS)) delete records[key]
  const keys = Object.keys(records).sort((left, right) => records[left].seenAt - records[right].seenAt)
  for (const key of keys.slice(0, Math.max(0, keys.length - CLOUD_RECORDS))) delete records[key]
}

/** A text of `airc` on one line, without the characters that change the Markdown of the chat. */
function oneLine(value, limit) {
  const line = String(value ?? '').replace(/[\s`*_[\]<>|]+/g, ' ').replace(/"/g, "'").trim()
  return line.length <= limit ? line : `${line.slice(0, limit - 1).trimEnd()}…`
}

const AGENTS = { claude: 'Claude Code', codex: 'Codex', 'github-copilot': 'GitHub Copilot', junie: 'Junie' }
const agentName = agent => AGENTS[agent] ?? (oneLine(agent, 40) || message('cloud.note.unknownAgent'))
const repositoryOf = session => {
  const first = session.repositories?.[0]
  return first?.organization && first?.repository ? `${first.organization}/${first.repository}` : first?.repository
}

/** One line of a note: the agent, the name, the first repository, the new status, the results branch or the comment. */
function noteLine(session) {
  const name = oneLine(session.name, NAME_LIMIT)
  const repository = repositoryOf(session)
  const parts = [message(`cloud.note.line.${session.status}`, agentName(session.agent), name ? `"${name}"` : message('cloud.note.untitled'),
    repository ? oneLine(repository, NAME_LIMIT) : message('cloud.note.noRepository'))]
  const branch = oneLine(session.repositories?.[0]?.resultsBranch, NAME_LIMIT)
  const comment = oneLine(session.statusComment, COMMENT_LIMIT)
  if (session.status === 'FINISHED' && branch) parts.push(message('cloud.note.branch', branch))
  if (CLOUD_FAILED.has(session.status) && comment) parts.push(message('cloud.note.comment', comment))
  return parts.join(' ')
}

/** The text of one note for the sessions of [due]: one line for each session, at most [CLOUD_NOTE_LINES]. */
export function cloudNoteText(due) {
  const sessions = due.map(item => item.session)
  const lines = sessions.slice(0, CLOUD_NOTE_LINES).map(noteLine)
  if (sessions.length > CLOUD_NOTE_LINES) lines.push(message('cloud.note.more', sessions.length - CLOUD_NOTE_LINES))
  return [message(sessions.length === 1 ? 'cloud.note.title.one' : 'cloud.note.title.many', sessions.length), ...lines,
    message('cloud.note.end')].join('\n')
}

/**
 * The part `cloud` of the data of the morning report from the [sessions] of a read. [inPeriod] tells whether a time is
 * in the period of the report. A finished or failed session counts when its last change is in the period. A session
 * that waits or runs counts at the time of the read.
 */
export function cloudReportPart(sessions, inPeriod) {
  const entry = session => ({ name: session.name, status: session.status, agent: session.agent, repository: repositoryOf(session) ?? null,
    resultsBranch: session.repositories?.[0]?.resultsBranch ?? null, statusComment: session.statusComment ?? null, updatedAt: session.updatedAt })
  const changed = session => inPeriod(Date.parse(session.updatedAt ?? ''))
  const part = filter => sessions.filter(filter).slice(0, REPORT_LIMIT).map(entry)
  return { state: 'on',
    finished: part(session => session.status === 'FINISHED' && changed(session)),
    failed: part(session => CLOUD_FAILED.has(session.status) && changed(session)),
    waiting: part(session => session.status === 'USER_INPUT_REQUIRED'),
    running: part(session => CLOUD_RUNNING.has(session.status)) }
}

const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); timer.unref(); return timer },
  clearTimeout: timer => clearTimeout(timer),
}

/**
 * The timer of the reads. It runs only while the cloud sessions are on: the setting `cloud.sessions` and an active
 * plugin `airc`. The first read of a watch calls [start], which keeps the start of the watch in the state. Each read
 * gets the list with [list], with a signal for the stop, and gives the plan to [deliver], which writes the note and the records in one commit and
 * gives `{ sent, waiting }`. While the conversation sleeps ([sleeping]), a check runs no `airc` and only sets the next
 * timer. A note that could not go out, because a turn ran, sets `waiting`: the end of the turn then reads at once.
 * Reads run one at a time.
 */
export class CloudWatch {
  constructor({ clock = systemClock, list, sleeping = () => false, start, deliver }) {
    Object.assign(this, { clock, list, sleeping, start, deliver })
    this.on = false
    this.closed = false
    this.started = false
    this.waiting = false
    this.running = Promise.resolve()
    // The stop of the daemon ends a read that runs, so the stop does not wait for `airc`.
    this.lifetime = new AbortController()
  }

  /** Turns the reads on or off. A change to on reads at once. */
  apply(on) {
    if (this.closed || on === this.on) return
    this.on = on
    this.started = false
    this.waiting = false
    if (on) this.check()
    else this.cancel()
  }

  /** Reads now, and again after [CLOUD_CHECK_MS]. */
  check() {
    if (!this.on || this.closed) return this.running
    this.running = this.running.then(() => this.#check()).catch(logCloudFailure)
    return this.running
  }

  /** The end of a turn: a note that waits for it goes out now. */
  turnEnded() {
    if (this.waiting) this.check()
  }

  async #check() {
    this.cancel()
    if (!this.on || this.closed) return
    try {
      if (!this.started) {
        await this.start(this.clock.now())
        this.started = true
      }
      if (!this.sleeping()) {
        const sessions = await this.list(this.lifetime.signal)
        if (this.on && !this.closed) {
          const now = this.clock.now()
          const { sent, waiting } = await this.deliver(watch => {
            const plan = planCloudNotes(watch, sessions, now)
            return { ...plan, text: plan.due.length ? cloudNoteText(plan.due) : undefined }
          }, now)
          this.waiting = waiting
          // The log gets the count only: a note holds the names and the repositories of the cloud sessions.
          if (sent) logEvent('log.cloud', sent)
        }
      }
    }
    catch (error) { if (!this.closed) logCloudFailure(error) }
    if (!this.on || this.closed) return
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.check() }, CLOUD_CHECK_MS)
  }

  cancel() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  async close() {
    this.closed = true
    this.on = false
    this.cancel()
    this.lifetime.abort()
    await this.running
  }
}

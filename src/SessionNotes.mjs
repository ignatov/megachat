import { createHash } from 'node:crypto'
import { basename } from 'node:path'
import { logEvent, logFailure, message } from './messages.mjs'

/**
 * The notes about the agent sessions on the machine that wait for the user for a long time. The status of a session is
 * a reading of its log and of the process file of Claude Code (see `SessionStatus.mjs`), so a note says it in careful
 * words. A note is a fixed text from a template. It needs no model request: the daemon writes it into the conversation
 * as a message of the assistant, without a run (see `MegachatState.sessionNote`). The client shows it at once, and the
 * replay shows it again.
 */

/** The interval of the check of the running sessions while the notes are on. */
export const NOTE_CHECK_MS = 60000
/**
 * The time of a wait for a permission before a note goes out. The user often answers a prompt in some minutes, and a
 * note before that time is noise. 5 minutes is half the time after which a session with an open step becomes `stuck`.
 */
export const PERMISSION_NOTE_MS = 5 * 60000
/** The statuses that give a note. A finished turn (`waiting_for_user`, `idle`) is the usual state of a session. */
export const NOTE_STATUSES = new Set(['waiting_for_permission', 'stuck'])
/** The lines of one note. The other sessions get one line with their count. */
export const NOTE_LINES = 10
/** The records of the sent notes that the state keeps, and their longest age. */
export const NOTE_RECORDS = 200
export const NOTE_RECORD_MS = 30 * 86400000
/** The kind of the entry of a note in the conversation. */
export const NOTE_KIND = 'air.megachat.note'
/** The provider of the model message of a note. It tells a note from a reply of a model. */
export const NOTE_PROVIDER = 'megachat'
const TITLE_LIMIT = 80

const agentName = agent => ({ claude: 'Claude Code', codex: 'Codex', pi: 'pi', opencode: 'OpenCode' })[agent] ?? String(agent ?? '?')

/**
 * The key of the record of a session: a hash of the agent, the session ID and the process. So the state holds no
 * session ID, no path and no title. A session that continues in a new process is a new session here.
 */
export function noteKey(row) {
  return createHash('sha256').update(JSON.stringify([row.agent, row.sessionId ?? '', row.pid, row.startedAt, row.slot ?? 0]))
    .digest('hex').slice(0, 32)
}

/**
 * True when the row [row] of the view of `agents_running` gives a note at the time [now]: a session that is `stuck`, or
 * a session outside Megachat that waits for a permission for [PERMISSION_NOTE_MS] or more. A child of Megachat that
 * waits for a permission shows a dialog in the chat, so it gets no note.
 */
export function needsNote(row, now) {
  if (!NOTE_STATUSES.has(row.status) || !Number.isFinite(row.statusSince)) return false
  if (row.status === 'stuck') return true
  return row.parent?.kind !== 'megachat' && now - row.statusSince >= PERMISSION_NOTE_MS
}

/**
 * The plan of one check from the [records] of the sent notes and the [rows] of a view at the time [now]. `due` holds the
 * rows that need a note. `changes` holds the records that change without a note. A session gets one note for each
 * state: a record keeps the status and its start time (`since`). When the view shows the session in another state, the
 * record gets `left`. Only a new start time after `left` gives a new note, so a reading that comes and goes, and a
 * restart of the daemon, give no second note for the same wait.
 */
export function planNotes(records, rows, now) {
  const due = []
  const changes = {}
  for (const row of rows) {
    if (!row.status) continue
    const key = noteKey(row)
    const record = records[key]
    if (needsNote(row, now)) {
      if (!record || record.status !== row.status || record.left && record.since !== row.statusSince) due.push({ key, row })
      else if (record.left) changes[key] = { ...record, left: false }
    }
    else if (record && !record.left && (row.status !== record.status || row.statusSince !== record.since)) changes[key] = { ...record, left: true }
  }
  return { due, changes }
}

/** The time of a wait in plain words. */
function duration(ms) {
  const minutes = Math.max(1, Math.floor(ms / 60000))
  return minutes < 120 ? message('notes.minutes', minutes) : message('notes.hours', Math.round(minutes / 60))
}

/** The title of a session on one line, without the characters that change the Markdown of the chat. */
function titleOf(row) {
  const title = String(row.title ?? '').replace(/[\s`*_[\]<>|]+/g, ' ').replace(/"/g, "'").trim()
  if (!title) return message('notes.untitled')
  return title.length <= TITLE_LIMIT ? `"${title}"` : `"${title.slice(0, TITLE_LIMIT - 1).trimEnd()}…"`
}

/**
 * The text of one note for the rows of [due] at the time [now]: one line for each session, with the agent, the project
 * name, the title, the state and how long. The waits for a permission come first, then the longest waits.
 */
export function noteText(due, now) {
  const rows = due.map(item => item.row).sort((left, right) => (left.status === 'waiting_for_permission' ? 0 : 1)
    - (right.status === 'waiting_for_permission' ? 0 : 1) || left.statusSince - right.statusSince)
  const lines = rows.slice(0, NOTE_LINES).map(row => message(`notes.line.${row.status}`,
    row.parent?.kind === 'megachat' ? message('notes.child', agentName(row.agent)) : agentName(row.agent),
    row.cwd ? basename(row.cwd) : message('notes.noProject'), titleOf(row), duration(now - row.statusSince)))
  if (rows.length > NOTE_LINES) lines.push(message('notes.more', rows.length - NOTE_LINES))
  return [message(rows.length === 1 ? 'notes.title.one' : 'notes.title.many', rows.length), ...lines, message('notes.end')].join('\n')
}

/** The model message of a note. It has no usage, so the size of the context does not count it as a measured request. */
export function noteMessage(text, now) {
  return { role: 'assistant', content: [{ type: 'text', text }], api: NOTE_PROVIDER, provider: NOTE_PROVIDER, model: 'note',
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: 'stop', timestamp: now }
}

/** True when the model message [model] is a note of Megachat and no reply of a model. */
export const isNoteMessage = model => model?.role === 'assistant' && model.provider === NOTE_PROVIDER

/**
 * Keeps the records of the sent notes small: a record older than [NOTE_RECORD_MS] goes, and then the oldest records
 * until [NOTE_RECORDS] stay. The process of an old record has ended, so its session does not come back with its key.
 */
export function pruneRecords(records, now) {
  for (const [key, record] of Object.entries(records)) if (!(now - record.notedAt < NOTE_RECORD_MS)) delete records[key]
  const keys = Object.keys(records).sort((left, right) => records[left].notedAt - records[right].notedAt)
  for (const key of keys.slice(0, Math.max(0, keys.length - NOTE_RECORDS))) delete records[key]
}

const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); timer.unref(); return timer },
  clearTimeout: timer => clearTimeout(timer),
}

/**
 * The timer of the notes. It runs only while the setting `sessions.notes` is on with the consent `sessions.index`. Else
 * it reads nothing and has no timer. Each check reads the view of `agents_running` with [view], and gives the plan to
 * [deliver], which writes the note and the records in one commit of the state. While the conversation sleeps
 * ([sleeping]), the plan has no text: the records still follow the states, and the note waits. So a session that still
 * waits when the conversation wakes, for example at the start of the working day, gets its note then, and a wait that
 * ended at night gives none. Checks run one at a time.
 */
export class SessionNotes {
  constructor({ clock = systemClock, view, sleeping = () => false, deliver }) {
    Object.assign(this, { clock, view, sleeping, deliver })
    this.on = false
    this.closed = false
    this.running = Promise.resolve()
  }

  /** Turns the checks on or off. A change to on checks at once. */
  apply(on) {
    if (this.closed || on === this.on) return
    this.on = on
    if (on) this.check()
    else this.cancel()
  }

  /** Checks now, and again after [NOTE_CHECK_MS]. The end of a turn calls it too, so a note that waits goes out soon. */
  check() {
    if (!this.on || this.closed) return this.running
    this.running = this.running.then(() => this.#check()).catch(error => logFailure('log.notes.failed', error))
    return this.running
  }

  async #check() {
    this.cancel()
    if (!this.on || this.closed) return
    try {
      const view = await this.view()
      if (this.on && !this.closed && view?.logs) {
        const now = this.clock.now()
        const asleep = this.sleeping()
        const sent = await this.deliver(records => {
          const plan = planNotes(records, view.rows, now)
          return { ...plan, text: plan.due.length && !asleep ? noteText(plan.due, now) : undefined }
        }, now)
        // The log gets the count only: a note holds the titles and the projects of the private sessions of the user.
        if (sent) logEvent('log.notes', sent)
      }
    }
    catch (error) { logFailure('log.notes.failed', error) }
    if (!this.on || this.closed) return
    this.timer = this.clock.setTimeout(() => { this.timer = undefined; this.check() }, NOTE_CHECK_MS)
  }

  cancel() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  async close() {
    this.closed = true
    this.on = false
    this.cancel()
    await this.running
  }
}

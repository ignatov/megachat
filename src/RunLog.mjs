import { logEvent, message } from './messages.mjs'

/** The most characters of a text in a line of the run log. */
const TEXT_LIMIT = 200

/** A word of a line: an ID, a name or a number. `-` stands for a value that is not known. */
const word = value => typeof value === 'string' && /^[\w.:-]{1,80}$/.test(value) ? value : value === undefined || value === null || value === '' ? '-' : 'other'

/** A text of a line as JSON text, so no control character breaks the line and no text reads as a field. */
const quote = value => typeof value === 'string' && value ? JSON.stringify(value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, TEXT_LIMIT)) : '-'

/**
 * Writes the line for the start of a run: [kind] says how the run came, `spawn`, `send`, `resume` (a session of the
 * agent that the user names), `steer-restart`, `steer-followup`, `continue` (an automatic continuation after an
 * interruption) or `recovery` (the same, after a restart of the daemon). The line holds no prompt, no output and no
 * token. The title and the directory are quoted.
 */
export function logRunStart(run, kind) {
  logEvent('log.run.start', word(run.id), kind, word(run.resumeOf), word(run.childSessionId), word(run.providerSessionId),
    word(run.agent ?? 'claude'), quote(run.cwd), quote(run.title))
}

/** The description of the end of [run] that a commit of the state makes. It holds plain values, no draft. */
export function endOf(run, status, { errorClass, now = Date.now() } = {}) {
  return { id: run.id, status, errorClass, durationMs: Math.max(0, (run.finishedAt ?? now) - (run.startedAt ?? run.createdAt ?? now)),
    stopReason: run.stopReason, error: run.error }
}

/** The first sentence of the error text of a run: the fixed part, which has no text of the agent. */
const headOf = text => text.split(/(?<=\.)\s/)[0]

/**
 * Writes the lines for the end of a run: the error line, when the run failed or stopped on an error, and then the line
 * of the end. [end] comes from `endOf`, and it can have `resumedBy`, the ID of the continuation that replaced the run.
 * A time limit gives the status `timeout`. The class says what kind of error it was: `login`, `timeout`,
 * `outputLimit`, `agentAnswer`, `agentExit`, `spawn`, `daemonStop`, `daemonRestart`, `stopReason`, the code of a
 * `MegachatError`, or `other`.
 */
export function logRunEnd(end) {
  const status = end.errorClass === 'timeout' ? 'timeout' : end.status
  const stop = typeof end.stopReason === 'string' && /^[\w.-]{1,40}$/.test(end.stopReason) ? end.stopReason : undefined
  if ((status === 'failed' || status === 'interrupted' || status === 'timeout') && (end.error || end.errorClass || status === 'failed')) {
    const text = typeof end.error === 'string' && end.error ? headOf(end.error) : stop ? message('log.run.stopReason', stop) : ''
    logEvent('log.run.error', word(end.id), word(end.errorClass ?? (end.error ? 'other' : 'stopReason')), quote(text))
  }
  logEvent('log.run.end', word(end.id), status, end.durationMs, word(stop), word(end.resumedBy))
}

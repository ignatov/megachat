/**
 * The status of a running session from the tail of its log. The status is a reading of the log, not a fact from the
 * agent: the log tells the last step of the session and the time of the last write, and nothing more. Claude Code,
 * Codex and pi write no record of a permission request to the log. Only the process file of Claude Code tells that a
 * session waits for a permission or for the answer to a question, and only the state of Megachat tells it for a child
 * of Megachat. So only these sessions can get the status `waiting_for_permission`.
 */

/**
 * A log write or a CPU load in this time makes a session active. An agent writes a record for each tool call, each
 * tool result and each reply, and a long step of the model seldom takes more than a minute.
 */
export const ACTIVE_MS = 2 * 60 * 1000
/**
 * An open step without a write for this time makes a session stuck. A build or a test run can take some minutes
 * without a log write, and 10 minutes is longer than the usual tool. Codex writes no record of a permission prompt,
 * so a Codex session that waits for a permission for 10 minutes is stuck here too.
 */
export const STUCK_MS = 10 * 60 * 1000
/**
 * A finished turn without a write for this time makes a session idle. A user usually answers in some minutes, so a
 * session that waits for its user for 30 minutes is idle.
 */
export const IDLE_MS = 30 * 60 * 1000
/**
 * The steps that a source parser gives while the agent owes the next step. The other steps are `reply` and `end` after
 * a finished turn, and `none` for a log without a turn.
 */
export const OPEN_STEPS = new Set(['call', 'result', 'prompt', 'open'])

/**
 * The time after the start of a wait in a process file in which a log write still belongs to the step before the
 * wait. The log and the process file are two writes, so the write of the tool call can come some seconds after the
 * status.
 */
export const WAIT_WRITE_SLACK_MS = 10000
/** A time of a process file at most this much after the scan is valid. A later time is no real status. */
const FUTURE_SLACK_MS = 60000

/**
 * The status that the process file of a session gives, `waiting_for_permission` or `waiting_for_user`, or undefined.
 * [process] is `{ sessionId, wait: { status, since } }` from the process file, [sessionId] is the session of the row,
 * [record] is its log, [busy] tells a CPU load of the process at this scan. The process file is a hint of another
 * program, so it counts only for the session of the row, at a time that is not in the future, without a log write
 * after the start of the wait, and not at a CPU load when the wait started 2 minutes ago or more: a process that waits
 * uses no CPU.
 */
export function processWaitStatus(process, sessionId, record, busy, now) {
  const since = process?.wait?.since
  if (!Number.isFinite(since) || !sessionId || process.sessionId !== sessionId || since > now + FUTURE_SLACK_MS) return undefined
  if (!Number.isFinite(record?.mtimeMs) || record.mtimeMs > since + WAIT_WRITE_SLACK_MS) return undefined
  return busy && now - since >= ACTIVE_MS ? undefined : process.wait.status
}

/**
 * The status of a session with a live process from its log [record], at the time [now], or null for a log without a
 * known step. `working`: the tail ends with a tool call, a tool result or a message without a reply, and the last
 * write is less than 10 minutes old. A step without a write and without a CPU load for 2 to 10 minutes stays working,
 * because the log cannot tell a slow tool from a prompt of the agent. `stuck`: such an open step and no write for
 * 10 minutes or more. `waiting_for_user`: the tail ends with a finished turn. `idle`: a finished turn and no write for
 * 30 minutes or more.
 */
export function sessionStatus(record, now) {
  if (!record?.step || !Number.isFinite(record.mtimeMs)) return null
  const quiet = now - record.mtimeMs
  if (OPEN_STEPS.has(record.step)) return quiet >= STUCK_MS ? 'stuck' : 'working'
  return quiet >= IDLE_MS ? 'idle' : 'waiting_for_user'
}

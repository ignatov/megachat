/**
 * The status of a running session from the tail of its log. The status is a reading of the log, not a fact from the
 * agent: the log tells the last step of the session and the time of the last write, and nothing more. Claude Code,
 * Codex and pi write no record of a permission request to the log. So Megachat never gives the status
 * `waiting_for_permission`: without the state request of Air, it is not knowable.
 */

/**
 * A log write or a CPU load in this time makes a session active. An agent writes a record for each tool call, each
 * tool result and each reply, and a long step of the model seldom takes more than a minute.
 */
export const ACTIVE_MS = 2 * 60 * 1000
/**
 * An open step without a write for this time makes a session stuck. A build or a test run can take some minutes
 * without a log write, and 10 minutes is longer than the usual tool. Claude Code and Codex write no record of a
 * permission prompt, so a session that waits for a permission for 10 minutes is stuck here too.
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

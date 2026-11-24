import { DaemonClient, processEnded, STOP_WAIT_MS } from './DaemonClient.mjs'
import { message } from './messages.mjs'

/** The longest wait for the answer of `/health`. A daemon that does not answer in this time counts as gone. */
export const HEALTH_TIMEOUT_MS = 2000

/** The client of the daemon of the state directory [directory], or `undefined` when no daemon answers `/health`. */
export async function runningDaemon(directory) {
  try {
    const client = await DaemonClient.connect(directory)
    client.health = await client.json('/health', undefined, AbortSignal.timeout(HEALTH_TIMEOUT_MS))
    return client
  }
  catch { return undefined }
}

/**
 * The work of a daemon from its `/state` [state]: whether a turn runs, and the child runs that are not in a final state.
 * `uninstall` and the request `_agent/stop` stop a daemon only without such work, so a stop interrupts no admitted work.
 */
export async function workOf(state) {
  // The module of the state is large, and only this check needs it. So each other command does not load it.
  const { terminalStates } = await import('./MegachatState.mjs')
  return { turn: Boolean(state.current), runs: Object.values(state.runs ?? {}).filter(run => !terminalStates.has(run.status)) }
}

/** One line for the turn and one line for each child run that is not in a final state, from the `/state` [state]. */
export async function workLines(state) {
  const work = await workOf(state)
  return [...(work.turn ? [message('uninstall.busyTurn')] : []),
    ...work.runs.map(run => message('uninstall.busyRun', run.id, run.agent ?? 'claude', run.status, run.title ?? ''))]
}

/**
 * Stops the daemon of [client] with `/shutdown`, and waits until its process [pid] ends, at most [timeoutMs]. Gives
 * true when the process ended.
 */
export async function stopDaemon(client, pid, timeoutMs = STOP_WAIT_MS) {
  try { await client.json('/shutdown', {}) }
  catch { /* The daemon may close the connection while it stops. */ }
  return processEnded(pid, timeoutMs)
}

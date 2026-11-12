/** The states of a child run between its start and its end. A run in one of these states holds the slot. */
const activeStates = new Set(['launching', 'ready', 'dispatched', 'running', 'approval'])

/**
 * The one place for a child run in the daemon. The ACP run service and the pi run service share it, so the daemon runs
 * at most one child at a time, ACP or pi. The queue order holds across both services: a service takes only the first
 * queued run that may start now. The state shows a run as active only after its commit, so the holder in memory closes
 * the gap between the choice of a run and that commit.
 */
export class ChildSlot {
  constructor() {
    this.holder = null
    this.listeners = new Set()
  }

  /** Takes the slot for the queued [run] when no child runs and [run] is the first queued run that may start now. */
  take(snapshot, run, now = Date.now()) {
    if (this.holder !== null) return false
    const runs = Object.values(snapshot.runs)
    if (runs.some(item => item.id !== run.id && activeStates.has(item.status))) return false
    if (runs.find(item => item.status === 'admitted' && (item.notBefore ?? 0) <= now)?.id !== run.id) return false
    this.holder = run.id
    return true
  }

  /** Takes the slot for [run], which was active when the last daemon stopped and continues now. */
  resume(snapshot, run) {
    if (this.holder !== null || Object.values(snapshot.runs).some(item => item.id !== run.id && activeStates.has(item.status))) return false
    this.holder = run.id
    return true
  }

  /** Frees the slot of [runId] and tells each service, so the next queued run can start. */
  release(runId) {
    if (this.holder !== runId) return
    this.holder = null
    for (const listener of this.listeners) listener()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

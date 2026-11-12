import { directoryKey, isWithin } from './ProjectDirectories.mjs'
import { DEFAULT_PARALLEL_CHILDREN, MAX_PARALLEL_CHILDREN } from './Settings.mjs'

export { directoryKey }

/** The states of a child run between its start and its end. A run in one of these states holds a place of the pool. */
const activeStates = new Set(['launching', 'ready', 'dispatched', 'running', 'approval'])
/** The count of the directories whose real path the pool keeps. The listed directories are fewer. */
const KEPT_DIRECTORIES = 256

/** True when two directory keys are one directory, or one of them is in the other: then they are one checkout. */
export const overlaps = (first, second) => isWithin(first, second) || isWithin(second, first)

/** The count of the places for a value of `children.parallel`. A value out of the range gives the default. */
const placesOf = value => Number.isInteger(value) && value >= 1 && value <= MAX_PARALLEL_CHILDREN ? value : DEFAULT_PARALLEL_CHILDREN

/**
 * The places for the child runs in the daemon. The ACP run service and the pi run service share one pool, so the limit
 * counts the Claude, Codex and pi children together. [limit] gives the count of the places at each start: the setting
 * `children.parallel`. So a change applies to the next start, and it never stops a child that runs.
 *
 * Two children never run in one checkout at the same time, whatever the limit is: two agents that change one checkout
 * break the work of each other. So two runs conflict when the real path of one directory is the real path of the other,
 * or a directory in it. A queued run waits while a conflicting run runs, and also behind a conflicting run that is
 * earlier in the queue and waits. So a run in a directory with many subdirectories gets its turn. A queued run does not
 * stop a run behind it that conflicts with no earlier run.
 *
 * At most [piPlaces] pi children run at the same time, inside the limit. Pi Durable can run two child conversations at
 * the same time. But a daemon of v0.3.0 follows a dispatched pi run after a restart only when no other child is active,
 * so two dispatched pi runs would stop each child of such a daemon. A queued pi run that waits for this place does not
 * stop a queued run of another agent behind it in another checkout.
 *
 * Among the runs that can start, the queue order holds across both services: a service starts only a run that the walk
 * of the queue gives a place. A continuation for a message of the user (`urgent`) comes before the older queued runs,
 * because the user waits for the message. With the limit 1, the walk gives the first urgent run, else the first run,
 * when no child runs. The state shows a run as active only after its commit, so the holders in memory close the gap
 * between the choice of a run and that commit.
 */
export class ChildPool {
  constructor({ limit = () => DEFAULT_PARALLEL_CHILDREN, piPlaces = 1 } = {}) {
    this.limit = limit
    this.piPlaces = piPlaces
    /** The place of each run that a service started, by run ID, until its service releases it. */
    this.holders = new Map()
    this.listeners = new Set()
    this.directories = new Map()
  }

  /** The place of [run]: the key of its directory, and whether it is a pi run. */
  place(run) {
    let directory = this.directories.get(run.cwd)
    if (directory === undefined) {
      if (this.directories.size >= KEPT_DIRECTORIES) this.directories.clear()
      directory = directoryKey(run.cwd)
      this.directories.set(run.cwd, directory)
    }
    return { directory, pi: run.agent === 'pi' }
  }

  /**
   * Takes a place for the queued [run] when the walk of the queue gives it one. The walk goes through the runs that may
   * start now, the urgent ones first, each group in the queue order. A run waits when its directory conflicts with a
   * run that runs or with an earlier run of the walk, or when it is a pi run and the pi children have no free place.
   * Each other run takes a place until the places are full.
   */
  take(snapshot, run, now = Date.now()) {
    if (this.holders.has(run.id)) return false
    const runs = Object.values(snapshot.runs)
    const places = [...this.holders.values()]
    for (const item of runs) {
      if (activeStates.has(item.status) && !this.holders.has(item.id)) places.push(this.place(item))
    }
    // The directories of the runs that run, and of the earlier runs of the walk, also of the runs that wait.
    const claimed = places.map(place => place.directory)
    let pi = places.filter(place => place.pi).length
    let used = places.length
    const limit = placesOf(this.limit())
    const ready = runs.filter(item => item.status === 'admitted' && (item.notBefore ?? 0) <= now)
    for (const item of [...ready.filter(item => item.urgent === true), ...ready.filter(item => item.urgent !== true)]) {
      if (used >= limit) return false
      const place = this.place(item)
      const waits = claimed.some(directory => overlaps(directory, place.directory)) || place.pi && pi >= this.piPlaces
      if (!waits && item.id === run.id) {
        this.holders.set(run.id, place)
        return true
      }
      claimed.push(place.directory)
      if (waits) continue
      if (place.pi) pi++
      used++
    }
    return false
  }

  /**
   * Takes a place for [run], which was dispatched when the last daemon stopped and continues now. Pi Durable continues
   * each such run, whatever the limit is. So the run takes its place without a check, and it counts for each later start.
   */
  resume(run) {
    if (this.holders.has(run.id)) return false
    this.holders.set(run.id, this.place(run))
    return true
  }

  /** Frees the place of [runId] and tells each service, so the next queued run can start. */
  release(runId) {
    if (!this.holders.delete(runId)) return
    for (const listener of this.listeners) listener()
  }

  subscribe(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}

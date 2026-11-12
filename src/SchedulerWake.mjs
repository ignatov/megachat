import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { logEvent, logFailure } from './messages.mjs'

/**
 * A guard against a lost wake-up of the scheduler of Pi Durable 1.5.0 (issue #25). A task that waits for the tasks that
 * it owns, such as a generation that waits for the tool calls of its round, can stay `waiting` after each task of its
 * wait ended. Then the turn never ends, and only a new open of the state runs the task.
 *
 * The cause is in the reservation pass of the scheduler. The pass reads its candidates, and it removes each candidate
 * that waits from its set of candidates after an `await`. When the publication of the end of the last task of the wait
 * comes in that gap, the publication adds the waiting task to the set again, and the pass then removes it. No later
 * event adds it again.
 *
 * The guard follows the stored commits. After each commit that ends a task with an owner, it looks at the owner in a
 * commit of its own, one macrotask later. When the owner still waits and each task of its wait ended, the commit writes
 * the record of the owner again, with no change. The publication of that record makes the task a candidate again, and
 * the scheduler then runs it. The commit goes on the line of the session after the pass that removed the task, so the
 * pass cannot remove it again. A task that the scheduler already took is no longer `waiting`, so the guard writes
 * nothing for it, and it never starts work twice.
 *
 * Gives the function that stops the guard.
 */
export function wakeFinishedWaits(harness, context = BACKGROUND_CONTEXT) {
  const owners = new Set()
  let timer
  let stopped = false
  const check = async () => {
    timer = undefined
    const ids = [...owners]
    owners.clear()
    if (stopped || ids.length === 0) return
    const written = []
    await harness.commit(async tx => {
      written.length = 0
      for (const id of ids) {
        const owner = await tx.task(id)
        if (owner?.state.status !== 'waiting') continue
        let ended = true
        for (const member of owner.state.on) {
          if ((await tx.task(member))?.state.status !== 'terminal') { ended = false; break }
        }
        // The write of the same record is a change of the task for the scheduler. Pi Durable has no public call for it.
        if (!ended) continue
        tx.setTask(owner)
        written.push(id)
      }
    }, context)
    // The ID of a task is a number. The log line has no content of the task.
    for (const id of written) logEvent('log.schedulerWake.write', Number(id))
  }
  const observation = harness.observeCommits({
    advance(publication) {
      for (const change of publication.changes) {
        if (change.type === 'task' && change.value.state.status === 'terminal' && change.value.owner !== undefined) owners.add(change.value.owner)
      }
      // The observer must not call the session. The check also comes after the reservation pass that the publication
      // started, so a sound pass takes the task first, and the guard then writes nothing.
      if (owners.size > 0 && timer === undefined && !stopped) timer = setImmediate(() => check().catch(error => {
        if (!stopped) logFailure('log.schedulerWake', error)
      }))
    },
    end() { stopped = true },
  })
  return () => {
    stopped = true
    clearImmediate(timer)
    observation.detach()
  }
}

import { logFailure } from './messages.mjs'

/** The time between two tries to write the setup note while a turn or an input blocks it. */
export const ONBOARDING_RETRY_MS = 10000

/**
 * The delivery of the setup note on its own (see the capability `settings`, requirement "Setup note on its own"). The
 * daemon calls it after the start. It writes the note when the conversation is fresh, the onboarding is pending and
 * the conversation is idle, and it tries again each [retryMs] while a turn, a run or an input blocks the write. The
 * state keeps the field `onboardingOffer`, so a restart gives no second note. `done` of the result ends with the
 * delivery, and `close()` ends the tries.
 */
export function startOnboardingNote(state, pending, { retryMs = ONBOARDING_RETRY_MS } = {}) {
  let closed = false
  let timer
  let wake
  const result = { close: () => { closed = true; clearTimeout(timer); wake?.() } }
  result.done = (async () => {
    try {
      while (!closed && !(await state.writeOnboardingNote(pending))) {
        await new Promise(resolve => { wake = resolve; timer = setTimeout(resolve, retryMs); timer.unref() })
      }
    }
    catch (error) { if (!closed) logFailure('log.onboarding.noteFailed', error) }
  })()
  return result
}

import { logEvent, logFailure } from './messages.mjs'
import { CACHE_RETENTION, environmentSetting } from './Settings.mjs'
import { idleEnd, isSleeping, isWorkingTime } from './Workday.mjs'

export { CACHE_TTL_VARIABLE, DEFAULT_KEEPALIVE_HOURS, KEEPALIVE_HOURS_VARIABLE, KEEPALIVE_VARIABLE } from './Settings.mjs'
/** Below this size of the model context, a cold cache costs too little for a keep-alive request. */
export const KEEPALIVE_MIN_TOKENS = 20000
/** The part of the cache lifetime after which the idle daemon acts. `tokprof bench` measured this part. */
const LIFETIME_PART = 5 / 6

/** The keep-alive settings from the environment alone, without the stored settings. */
export function keepAliveSettings(environment = process.env) {
  return {
    retention: CACHE_RETENTION[environmentSetting('cache.ttl', environment)],
    enabled: environmentSetting('keepAlive.enabled', environment),
    windowMs: environmentSetting('keepAlive.hours', environment) * 3600000,
  }
}

const systemClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); timer.unref(); return timer },
  clearTimeout: timer => clearTimeout(timer),
}

/**
 * Keeps the prompt cache of an idle conversation warm, or makes the conversation small before the cache expires.
 *
 * A model request after the lifetime of the cache writes the whole context to the cache again. That costs 40 cache
 * reads with the 1-hour cache of Claude Opus 5.5, and it takes a long time. So at 5/6 of the lifetime after the last
 * model request, the idle daemon does one of these:
 * - Above [compactTokens], it calls [compact]. The next turn then starts from the summary.
 * - Between [minTokens] and [compactTokens], it calls [ping], which reads the cache and so starts its lifetime again.
 *   It does this until [windowMs] after the last turn. After that, the user is away, and a cold cache costs less than
 *   more requests.
 *
 * [workday] holds the working-day settings of `workdaySettings`, or it is `undefined`. With these settings, the idle
 * daemon sends no keep-alive request outside the working hours. Outside the working hours, it acts only when the
 * user did no turn for `idleMinutes`. Then the conversation goes to sleep: above [compactTokens] it gets the summary,
 * and no request goes out until the next turn. This summary comes also on a cold cache: the summary request sends the
 * conversation as a transcript with its own system prompt and no cache retention, so it reads no prompt cache, and a
 * cold cache does not change its cost. In the working hours, the idle daemon acts as without [workday].
 *
 * [tokens] returns the size of the model context. [ping] gets an abort signal and returns the usage of its request.
 */
export class PromptCacheKeepAlive {
  constructor({ ttlMs, windowMs, minTokens = KEEPALIVE_MIN_TOKENS, compactTokens, workday, tokens, ping, compact, clock = systemClock }) {
    Object.assign(this, { ttlMs, windowMs, minTokens, compactTokens, workday, tokens, ping, compact, clock })
    this.busy = false
    this.closed = false
  }

  /** A turn runs. No request goes out until its end, and a keep-alive request that runs stops. */
  turnStarted() {
    this.busy = true
    this.cancel()
  }

  /**
   * The conversation is idle since [at], the time of its last model request. The kind of the turn tells which idle time
   * starts again:
   * - The `keepAlive.hours` window starts again after each turn but the morning report (`morning`), which comes while
   *   the user can be away. Without an earlier turn, the window has no start, and it is not open.
   * - The idle time of the working day ([userIdleSince]) starts again only after a turn of the user (`user`). So a chain
   *   of child results at night does not keep the conversation awake.
   * A restart gives the end of the last turn of the user from the state as [userIdleSince].
   */
  turnEnded(at = this.clock.now(), { kind = 'user', userIdleSince } = {}) {
    this.busy = false
    if (kind !== 'morning') this.idleSince = at
    else this.idleSince ??= -Infinity
    if (userIdleSince !== undefined) this.userIdleSince = userIdleSince
    else if (kind === 'user') this.userIdleSince = at
    this.schedule(at)
  }

  schedule(lastRequestAt) {
    this.lastRequestAt = lastRequestAt
    this.wake(lastRequestAt + this.ttlMs * LIFETIME_PART)
  }

  /** Runs [tick] at the time [at]. */
  wake(at) {
    this.cancel()
    if (this.closed) return
    const delayMs = Math.max(0, at - this.clock.now())
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      this.running = this.tick().catch(error => logFailure('log.keepalive.failed', error))
    }, delayMs)
  }

  async tick() {
    if (this.busy || this.closed) return
    const now = this.clock.now()
    const resting = this.workday !== undefined && !isWorkingTime(this.workday, now)
    // A timer of a computer that slept comes late. The cache is then cold, and a keep-alive request would write it, not
    // read it. In the working hours the user is then likely back, and a summary now would make the next turn wait, so
    // the idle daemon does nothing. Outside the working hours, no keep-alive request goes out at all.
    if (!resting && now - this.lastRequestAt >= this.ttlMs) return
    // The user can still work after the end of the working hours. So the conversation goes to sleep only after the idle
    // time, and until then no request goes out.
    if (resting && !isSleeping(this.workday, now, this.userIdleSince)) {
      this.wake(idleEnd(this.workday, this.userIdleSince))
      return
    }
    const size = await this.tokens()
    if (this.busy || this.closed) return
    if (size > this.compactTokens) {
      const outcome = await this.compact()
      const cold = now - this.lastRequestAt >= this.ttlMs
      logEvent(cold ? 'log.workday.compactCold' : 'log.keepalive.compact', size, outcome.compacted ? 'done' : outcome.reason)
      if (resting) logEvent('log.workday.sleep', size)
      return
    }
    if (resting) {
      logEvent('log.workday.sleep', size)
      return
    }
    if (size < this.minTokens || now - this.idleSince > this.windowMs) return
    const abort = this.abort = new AbortController()
    let usage
    try { usage = await this.ping(abort.signal) }
    finally { if (this.abort === abort) this.abort = undefined }
    if (abort.signal.aborted) return
    logEvent('log.keepalive.ping', size, usage.input, usage.cacheRead, usage.cacheWrite, usage.output, usage.cost?.total ?? 0)
    if (!this.busy) this.schedule(now)
  }

  cancel() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
    this.abort?.abort()
  }

  async close() {
    this.closed = true
    this.cancel()
    await this.running
  }
}

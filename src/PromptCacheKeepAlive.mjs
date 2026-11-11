import { logEvent, logFailure } from './messages.mjs'

/** The lifetime of the prompt cache that each model request asks for: `1h` or `5m`. */
export const CACHE_TTL_VARIABLE = 'MEGACHAT_CACHE_TTL'
/** The value `0` stops each keep-alive request and each summary of an idle conversation. */
export const KEEPALIVE_VARIABLE = 'MEGACHAT_KEEPALIVE'
/** The time after the last turn, in hours, in which keep-alive requests go out. */
export const KEEPALIVE_HOURS_VARIABLE = 'MEGACHAT_KEEPALIVE_HOURS'
export const DEFAULT_KEEPALIVE_HOURS = 6
/** Below this size of the model context, a cold cache costs too little for a keep-alive request. */
export const KEEPALIVE_MIN_TOKENS = 20000
/** The part of the cache lifetime after which the idle daemon acts. `tokprof bench` measured this part. */
const LIFETIME_PART = 5 / 6

export function keepAliveSettings(environment = process.env) {
  const hours = Number(environment[KEEPALIVE_HOURS_VARIABLE]?.trim() || NaN)
  return {
    retention: environment[CACHE_TTL_VARIABLE]?.trim() === '5m' ? 'short' : 'long',
    enabled: environment[KEEPALIVE_VARIABLE]?.trim() !== '0',
    windowMs: (Number.isFinite(hours) && hours >= 0 && hours <= 168 ? hours : DEFAULT_KEEPALIVE_HOURS) * 3600000,
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
 * [tokens] returns the size of the model context. [ping] gets an abort signal and returns the usage of its request.
 */
export class PromptCacheKeepAlive {
  constructor({ ttlMs, windowMs, minTokens = KEEPALIVE_MIN_TOKENS, compactTokens, tokens, ping, compact, clock = systemClock }) {
    Object.assign(this, { ttlMs, windowMs, minTokens, compactTokens, tokens, ping, compact, clock })
    this.busy = false
    this.closed = false
  }

  /** A turn runs. No request goes out until its end, and a keep-alive request that runs stops. */
  turnStarted() {
    this.busy = true
    this.cancel()
  }

  /** The conversation is idle since [at], the time of its last model request. */
  turnEnded(at = this.clock.now()) {
    this.busy = false
    this.idleSince = at
    this.schedule(at)
  }

  schedule(lastRequestAt) {
    this.cancel()
    if (this.closed) return
    this.lastRequestAt = lastRequestAt
    const delayMs = Math.max(0, lastRequestAt + this.ttlMs * LIFETIME_PART - this.clock.now())
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      this.running = this.tick().catch(error => logFailure('log.keepalive.failed', error))
    }, delayMs)
  }

  async tick() {
    if (this.busy || this.closed) return
    const now = this.clock.now()
    // A timer of a computer that slept comes late. The cache is then cold, and a request would write it, not read it.
    if (now - this.lastRequestAt >= this.ttlMs) return
    const size = await this.tokens()
    if (this.busy || this.closed) return
    if (size > this.compactTokens) {
      const outcome = await this.compact()
      logEvent('log.keepalive.compact', size, outcome.compacted ? 'done' : outcome.reason)
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

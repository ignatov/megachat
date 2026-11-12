/**
 * A clock that starts at the UTC time [start] and moves only in `advance`. `advance` runs each timer that comes due, and
 * waits for [settled] after it.
 */
export function fakeClock(start = '2026-11-11T12:00:00Z') {
  let now = Date.parse(start)
  const timers = new Set()
  return {
    now: () => now,
    setTimeout: (callback, delayMs) => { const timer = { at: now + delayMs, callback }; timers.add(timer); return timer },
    clearTimeout: timer => timers.delete(timer),
    async advance(ms, settled = () => {}) {
      const end = now + ms
      for (;;) {
        const [next] = [...timers].filter(timer => timer.at <= end).sort((a, b) => a.at - b.at)
        if (!next) break
        timers.delete(next)
        now = Math.max(now, next.at)
        next.callback()
        await settled()
      }
      now = Math.max(now, end)
    },
    /** The time passes, but no timer runs, as on a computer that sleeps. */
    sleep(ms) { now += ms },
  }
}

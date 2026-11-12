import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { calculateCost } from '@earendil-works/pi-ai/models'

const SCHEMA = 1
const WARNINGS = ['none', 'pending', 'shown']
const systemClock = { now: () => Date.now() }
/** The count of the earlier days that the file keeps for the morning report. */
const KEPT_DAYS = 31

/** The local day of [time] as `YYYY-MM-DD`. The count of the spend starts again at the local midnight. */
export function localDay(time) {
  const date = new Date(time)
  return [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part, index) => String(part).padStart(index ? 2 : 4, '0')).join('-')
}

/**
 * The cost of one model request in USD. A provider of pi-ai gives the cost in the usage. A provider without a cost,
 * such as the fake provider of a test, gets the cost from the token counts and the prices of the model data, as pi-ai
 * calculates it.
 */
export function requestCost(usage, model) {
  const total = usage?.cost?.total
  if (Number.isFinite(total) && total > 0) return total
  if (!usage || !model?.cost) return 0
  const counts = { input: usage.input ?? 0, output: usage.output ?? 0, cacheRead: usage.cacheRead ?? 0, cacheWrite: usage.cacheWrite ?? 0 }
  const cost = calculateCost(model, { ...counts, ...(usage.cacheWrite1h ? { cacheWrite1h: usage.cacheWrite1h } : {}), cost: {} }).total
  return Number.isFinite(cost) ? cost : 0
}

const validCount = count => count !== null && typeof count === 'object' && Number.isFinite(count.usd) && count.usd >= 0
  && Number.isFinite(count.piUsd) && count.piUsd >= 0
/** The valid entries of the stored earlier days. A file of an earlier build has none. */
const validDays = days => days !== null && typeof days === 'object' && !Array.isArray(days)
  ? Object.fromEntries(Object.entries(days).filter(([day, count]) => /^\d{4}-\d\d-\d\d$/.test(day) && validCount(count))) : {}

const validData = data => data !== null && typeof data === 'object' && data.schema === SCHEMA && typeof data.day === 'string'
  && Number.isFinite(data.usd) && data.usd >= 0 && WARNINGS.includes(data.warning)

/**
 * The spend of the main agent on the local day, in the file `spend.json` of the state directory, so a restart keeps it.
 * The warning goes from `none` to `pending` when the spend passes the limit, and to `shown` after the turn that had it.
 * So the user gets one warning on each day. Without a path, the count stays in memory, for a test.
 * `piUsd` is the part of `usd` that the pi children spent. `days` keeps the counts of the last [KEPT_DAYS] earlier days
 * for the morning report. A file of an earlier build has neither, and an earlier build keeps the count of the day.
 */
export class DailySpend {
  /** A file that the daemon cannot read gives a new count. The count is no setting, so the loss is small. */
  static async open(path, clock = systemClock) {
    let data
    if (path) {
      try { data = JSON.parse(await readFile(path, 'utf8')) }
      catch { data = undefined }
    }
    return new DailySpend(path, clock, validData(data) ? data : undefined)
  }

  constructor(path, clock, data) {
    Object.assign(this, { path, clock, data: data ?? { schema: SCHEMA, day: localDay(clock.now()), usd: 0, warning: 'none' } })
    this.queue = Promise.resolve()
  }

  /** The count of today. A new local day starts a new count, and the count of the earlier day goes to `days`. */
  today() {
    const day = localDay(this.clock.now())
    if (this.data.day === day) return this.data
    const days = { ...validDays(this.data.days) }
    if (this.data.usd > 0) days[this.data.day] = { usd: this.data.usd, piUsd: this.data.piUsd ?? 0 }
    const kept = Object.keys(days).filter(item => item < day).sort().slice(-KEPT_DAYS)
    this.data = { schema: SCHEMA, day, usd: 0, warning: 'none', days: Object.fromEntries(kept.map(item => [item, days[item]])) }
    return this.data
  }

  /**
   * Adds the cost of one request. [source] `pi` counts it also as a cost of the pi children. Gives true when the spend
   * passed [limit] with this request.
   */
  add(usd, limit, source) {
    const data = this.today()
    data.usd += usd
    if (source === 'pi') data.piUsd = (data.piUsd ?? 0) + usd
    const passed = this.check(limit)
    this.save()
    return passed
  }

  /** The spend of each of [dates], `YYYY-MM-DD`: in USD, and the part of the pi children. A day without a count gives 0. */
  daily(dates) {
    const data = this.today()
    const days = validDays(data.days)
    return dates.map(day => {
      const count = day === data.day ? { usd: data.usd, piUsd: data.piUsd ?? 0 } : days[day] ?? { usd: 0, piUsd: 0 }
      return { day, usd: count.usd, piUsd: count.piUsd }
    })
  }

  /** Makes the warning pending when the spend is above [limit] and no warning went out today. `0` is no limit. */
  check(limit) {
    const data = this.today()
    if (!(limit > 0 && data.usd > limit && data.warning === 'none')) return false
    data.warning = 'pending'
    return true
  }

  /**
   * The warning for the next turn with its day, or `undefined`. A lower limit can make a warning pending, and a higher
   * one hides it.
   */
  notice(limit) {
    if (this.check(limit)) this.save()
    const data = this.today()
    return data.warning === 'pending' && limit > 0 && data.usd > limit ? { day: data.day, usd: data.usd, limit } : undefined
  }

  /** Gives [notice] when it is a warning of today, else `undefined`. The spend of an earlier day is not the spend of today. */
  current(notice) {
    return notice && notice.day === localDay(this.clock.now()) ? notice : undefined
  }

  /** The turn with the warning of [day] ended, so the warning does not come again on that day. */
  shown(day) {
    const data = this.today()
    if (data.day !== day || data.warning !== 'pending') return
    data.warning = 'shown'
    this.save()
  }

  /**
   * The spend of today for the output of `agents_settings get`. `warned` tells that a turn with the warning ended today.
   * `warningPending` tells that the warning waits for the end of a turn that has it.
   */
  report(limit) {
    const data = this.today()
    return { day: data.day, usd: Math.round(data.usd * 10000) / 10000, limit, warned: data.warning === 'shown',
      warningPending: data.warning === 'pending' }
  }

  /** Writes a copy through a temporary file and a rename, one write at a time. A failed write keeps the count in memory. */
  save() {
    if (!this.path) return this.queue
    const text = `${JSON.stringify(this.data)}\n`
    this.queue = this.queue.then(async () => {
      const temporary = `${this.path}.${process.pid}.tmp`
      await writeFile(temporary, text, { mode: 0o600 })
      if (process.platform !== 'win32') await chmod(temporary, 0o600)
      await rename(temporary, this.path)
    }).catch(() => {})
    return this.queue
  }
}

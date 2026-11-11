import { chmod, readFile, rename, writeFile } from 'node:fs/promises'
import { calculateCost } from '@earendil-works/pi-ai/models'

const SCHEMA = 1
const WARNINGS = ['none', 'pending', 'shown']
const systemClock = { now: () => Date.now() }

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

const validData = data => data !== null && typeof data === 'object' && data.schema === SCHEMA && typeof data.day === 'string'
  && Number.isFinite(data.usd) && data.usd >= 0 && WARNINGS.includes(data.warning)

/**
 * The spend of the main agent on the local day, in the file `spend.json` of the state directory, so a restart keeps it.
 * The warning goes from `none` to `pending` when the spend passes the limit, and to `shown` after the turn that had it.
 * So the user gets one warning on each day. Without a path, the count stays in memory, for a test.
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

  /** The count of today. A new local day starts a new count. */
  today() {
    const day = localDay(this.clock.now())
    if (this.data.day !== day) this.data = { schema: SCHEMA, day, usd: 0, warning: 'none' }
    return this.data
  }

  /** Adds the cost of one request. Gives true when the spend passed [limit] with this request. */
  add(usd, limit) {
    this.today().usd += usd
    const passed = this.check(limit)
    this.save()
    return passed
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

  /** The spend of today for the output of `agents_settings get`. */
  report(limit) {
    const data = this.today()
    return { day: data.day, usd: Math.round(data.usd * 10000) / 10000, limit, warned: data.warning !== 'none' }
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

/** The days of the week, in the order of a week that starts on Monday. */
export const WEEKDAYS = Object.freeze(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'])
export const DEFAULT_WORKDAY_DAYS = Object.freeze(WEEKDAYS.slice(0, 5))
/** The value of `workday.timezone` for the timezone of the system. */
export const SYSTEM_TIMEZONE = 'auto'

const formats = new Map()
function format(timezone) {
  const key = timezone ?? SYSTEM_TIMEZONE
  if (!formats.has(key)) {
    formats.set(key, new Intl.DateTimeFormat('en-US', { timeZone: key === SYSTEM_TIMEZONE ? undefined : key,
      weekday: 'short', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
  }
  return formats.get(key)
}

/** The name of the timezone that [timezone] selects. `auto` gives the timezone of the system. */
export function resolvedTimezone(timezone) {
  return format(timezone).resolvedOptions().timeZone
}

/** True when `Intl` knows [timezone]. */
export function knownTimezone(timezone) {
  try { format(timezone); return true }
  catch { return false }
}

const partsOf = (at, timezone) => Object.fromEntries(format(timezone).formatToParts(at).map(part => [part.type, part.value]))

/** The day of the week and the minute of the day at the time [at], in milliseconds, in [timezone]. */
export function localTime(at, timezone) {
  const parts = partsOf(at, timezone)
  return { day: parts.weekday.toLowerCase(), minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

/** The local date of the time [at] in [timezone], as `YYYY-MM-DD`. */
export function localDate(at, timezone) {
  const parts = partsOf(at, timezone)
  return `${parts.year}-${parts.month}-${parts.day}`
}

const minuteOf = time => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
}
const dateUtc = date => {
  const [year, month, day] = date.split('-').map(Number)
  return Date.UTC(year, month - 1, day)
}

/** The date [count] calendar days after [date]. A negative [count] gives an earlier date. */
export function addDays(date, count) {
  return new Date(dateUtc(date) + count * 86400000).toISOString().slice(0, 10)
}

/** The day of the week of [date], from [WEEKDAYS]. */
export function weekdayOf(date) {
  return WEEKDAYS[(new Date(dateUtc(date)).getUTCDay() + 6) % 7]
}

/** The local time of [at] in [timezone] as the milliseconds of a UTC time with the same digits. */
function wallClock(at, timezone) {
  const parts = partsOf(at, timezone)
  return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute))
}

/**
 * The time, in milliseconds, of the local [time] `HH:MM` on [date] in [timezone]. Two steps with the offset of the
 * timezone find it, also next to a change of the daylight saving time. A local time that the change skips gives the
 * time after the gap. A local time that occurs two times gives the second one.
 */
export function zonedTime(date, time, timezone) {
  const wall = dateUtc(date) + minuteOf(time) * 60000
  const first = wall - (wallClock(wall, timezone) - wall)
  return wall - (wallClock(first, timezone) - first)
}

/**
 * The working-day settings of the effective [values], or `undefined` when `workday.enabled` is off. The keep-alive gets
 * this object, so a change of each part gives a new keep-alive.
 */
export function workdaySettings(values) {
  if (!values['workday.enabled']) return undefined
  return { start: values['workday.start'], end: values['workday.end'], days: values['workday.days'],
    timezone: values['workday.timezone'], idleMinutes: values['workday.idleMinutes'] }
}

/**
 * True when the time [at], in milliseconds, is in the working hours of [workday]: `start` and `end` as `HH:MM`, `days`
 * from [WEEKDAYS], and `timezone`. `Intl` gives the local time, so a change of the daylight saving time moves the
 * working hours with the clock of the user. A `start` after `end` gives working hours that go past midnight: they start
 * on a working day and end on the next day. A `start` equal to `end` gives the whole day of each working day.
 * The function reads nothing else, so the keep-alive and a timer can use it with each clock.
 */
export function isWorkingTime(workday, at) {
  const { day, minute } = localTime(at, workday.timezone)
  const start = minuteOf(workday.start)
  const end = minuteOf(workday.end)
  if (start === end) return workday.days.includes(day)
  if (start < end) return workday.days.includes(day) && minute >= start && minute < end
  const previous = WEEKDAYS[(WEEKDAYS.indexOf(day) + WEEKDAYS.length - 1) % WEEKDAYS.length]
  return (minute >= start && workday.days.includes(day)) || (minute < end && workday.days.includes(previous))
}

/** True when [date] is a working day of [workday]. */
export function isWorkingDate(workday, date) {
  return workday.days.includes(weekdayOf(date))
}

/**
 * The time, in milliseconds, of the next start of a working day after the time [at]: `start` on the next date that is
 * a working day of `days`, in `timezone`. A start equal to [at] is not after it. The timer of the morning report uses it.
 */
export function nextWorkdayStart(workday, at) {
  const today = localDate(at, workday.timezone)
  for (let offset = 0; offset <= WEEKDAYS.length; offset++) {
    const date = addDays(today, offset)
    if (!isWorkingDate(workday, date)) continue
    const start = zonedTime(date, workday.start, workday.timezone)
    if (start > at) return start
  }
  return undefined
}

/**
 * The calendar days that the report of [date] covers: from the working day before [date] up to the day before [date].
 * So the report of a Monday covers Friday, Saturday and Sunday of a week from Monday to Friday. `from` and `to` are the
 * first and the last date, and `dates` holds each date.
 */
export function reportPeriod(workday, date) {
  for (let offset = 1; offset <= WEEKDAYS.length; offset++) {
    if (!isWorkingDate(workday, addDays(date, -offset))) continue
    const dates = Array.from({ length: offset }, (_, index) => addDays(date, index - offset))
    return { from: dates[0], to: dates.at(-1), dates }
  }
  return undefined
}

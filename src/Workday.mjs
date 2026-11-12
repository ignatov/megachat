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
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }))
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

/** The day of the week and the minute of the day at the time [at], in milliseconds, in [timezone]. */
export function localTime(at, timezone) {
  const parts = Object.fromEntries(format(timezone).formatToParts(at).map(part => [part.type, part.value]))
  return { day: parts.weekday.toLowerCase(), minute: Number(parts.hour) * 60 + Number(parts.minute) }
}

const minuteOf = time => {
  const [hours, minutes] = time.split(':').map(Number)
  return hours * 60 + minutes
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

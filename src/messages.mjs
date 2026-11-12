import { readFileSync } from 'node:fs'

const messages = Object.fromEntries(readFileSync(new URL('../resources/Megachat.properties', import.meta.url), 'utf8')
  .split('\n').filter(line => line && !line.startsWith('#')).map(line => {
    const index = line.indexOf('=')
    return [line.slice(0, index), line.slice(index + 1)]
  }))

export function message(key, ...args) {
  if (!(key in messages)) throw new Error(`Unknown message: ${key}`)
  return messages[key].replace(/\{(\d+)\}/g, (_, index) => String(args[Number(index)] ?? ''))
}

export class MegachatError extends Error {
  constructor(code, ...args) {
    super(message(`error.${code}`, ...args))
    this.code = code
  }
}

/** Refuses a request with the code [code] when [condition] is false. [args] fill the text of the code. */
export function requireCondition(condition, code = 'invalid', ...args) {
  if (!condition) throw new MegachatError(code, ...args)
}

/** The duration [ms] in minutes for a text, with at most two significant digits. */
export function minutesOf(ms) {
  return String(Number((ms / 60000).toPrecision(2)))
}

/**
 * Describes an error for the log of the daemon without its message. The message of an error can hold a secret: the
 * error of a failed command holds its output, and the error of a JSON parse quotes its input. So the description has
 * only the name, the code, the signal, the fixed text of an SQLite error, and the code locations of the stack.
 * The text of a `MegachatError` comes from the resources, so it is safe.
 */
export function describeError(error) {
  if (error instanceof MegachatError) return `${error.code}: ${error.message}`
  if (error === null || typeof error !== 'object') return typeof error
  const short = value => (typeof value === 'string' || typeof value === 'number') && /^[\w.:-]{1,64}$/.test(String(value)) ? String(value) : undefined
  const fields = [
    ['name', short(error.name)], ['code', short(error.code)], ['signal', short(error.signal)],
    ['sqlite', short(error.code)?.startsWith('ERR_SQLITE') && typeof error.errstr === 'string' ? error.errstr.slice(0, 100) : undefined],
  ].filter(([, value]) => value !== undefined).map(([name, value]) => `${name}=${value}`)
  const frames = typeof error.stack === 'string'
    ? error.stack.split('\n').filter(line => /^\s+at /.test(line)).slice(0, 6).map(line => line.trim()) : []
  return [fields.join(' ') || 'error', ...frames].join(' | ')
}

/** Writes one line about a failure to the standard error, which is the log of a daemon that `start` started. */
export function logFailure(key, error, ...args) {
  process.stderr.write(`${new Date().toISOString()} ${message(key, ...args)} ${describeError(error)}\n`)
}

/**
 * Writes one line about a failed child run to the standard error, and then each line of [text] with the prefix `  | `,
 * so no line of an agent looks like a line of the daemon. [args] and [text] hold a text of an agent, so the caller
 * gives them through the filter of the error output (`errorOutputText` and `answerText` of `SessionText.mjs`) first.
 */
export function logChildText(key, args, text = '') {
  const block = text ? text.split('\n').filter((line, index, lines) => line || index < lines.length - 1).map(line => `  | ${line}\n`).join('') : ''
  process.stderr.write(`${new Date().toISOString()} ${message(key, ...args)}\n${block}`)
}

/** Writes one line about an event to the standard error. Each argument is a number or a fixed word, never a content. */
export function logEvent(key, ...args) {
  process.stderr.write(`${new Date().toISOString()} ${message(key, ...args)}\n`)
}

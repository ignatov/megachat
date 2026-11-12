import { message } from './messages.mjs'

/** The characters of an entry that the session index keeps, tool outputs included: about 2 KB. */
export const ENTRY_TEXT_LIMIT = 2000
/**
 * The characters of an entry that a parser of a session file gives. The parser cuts a long tool output early, so a
 * large line costs no large string. The secret filter then reads a bounded text.
 */
export const SOURCE_TEXT_LIMIT = 8000
/** The characters of a title that the session index keeps. */
export const TITLE_LIMIT = 200

/**
 * True when [value] is the text of Basic authentication: the base64 text of `user:password`. So a word after "Basic",
 * as in "Basic usage", stays.
 */
function basicCredentials(value) {
  if (value.length % 4 !== 0) return false
  const decoded = Buffer.from(value, 'base64').toString('utf8')
  return decoded.includes(':') && !/[\u0000-\u001f\u007f\ufffd]/.test(decoded)
}

/**
 * The key of a gateway in the path of its base URL, as JetBrains Central gives it: `scheme://host/.../wire/<key>/...`.
 * The segment after `/wire/` goes, whatever its shape, and the rest of the URL stays. The path has at most 32 segments
 * before `/wire/`, so a long URL takes a linear time. A text that the filter changed already stays. A match holds no
 * white space.
 */
const WIRE_KEY = { pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#"'`<>\\]+(?:\/[^\s/?#"'`<>\\]*){0,32}?\/wire\/)([^\s/?#"'`<>\\]+)/gi, keep: true,
  accept: (secret, marker) => !marker.startsWith(secret) }
/**
 * The patterns of the text that looks like a secret. A pattern without `keep` replaces the whole match. A pattern with
 * `keep` has two groups: the text before the secret, which stays, and the secret. `accept` can refuse a match. The
 * list is a best effort: a secret of another shape stays in the text.
 */
const SECRET_PATTERNS = [
  WIRE_KEY,
  { pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { pattern: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g },
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { pattern: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { pattern: /\b(Bearer\s+)([A-Za-z0-9._~+/=-]{16,})/gi, keep: true },
  // Basic authentication: `Authorization: Basic <base64 of user:password>`.
  { pattern: /\b(Basic\s+)([A-Za-z0-9+/]{4,}={0,2})(?![A-Za-z0-9+/=])/gi, keep: true, accept: basicCredentials },
  // The password in the user information of a URL: `scheme://user:password@host`. The user stays. A URL with a user
  // and no password, such as `ssh://git@host/repo`, and an `ssh` remote such as `git@host:owner/repo.git` stay. The
  // scheme has at most 32 characters, so a long word takes a linear time.
  { pattern: /\b([a-z][a-z0-9+.-]{0,31}:\/\/[^\s/?#@:"'`<>\\]*:)([^\s/?#@"'`<>\\]+)(?=@)/gi, keep: true },
  // The password of the option `-u` or `--user` of curl: `curl -u user:password`. The user stays.
  { pattern: /(\bcurl\b[^\n]{0,1000}?\s(?:-u|--user)(?:\s+|=)\\?["']?[^\s:"'\\]+:)([^\s"'\\]+)/g, keep: true },
]
/** The names of an assignment of a secret. The name has at most 64 characters before the word, so a long line of hex with dashes takes a linear time. */
const SECRET_NAME = String.raw`(?:[A-Za-z0-9_-]{0,64}?(?:password|passwd|pass[_-]?phrase|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?)\\?["']?\s*[:=]\s*`
/**
 * An assignment with a value in quotes, such as `PASSPHRASE="correct horse battery staple"` or `"password": "..."`,
 * with a value of at least 8 characters and at least one letter. The value can hold spaces, so a passphrase goes as a
 * whole. A quote can have a backslash before it, as in the JSON text of the arguments of a tool call. The quotes stay.
 */
const QUOTED_ASSIGNMENT = new RegExp(String.raw`\b(${SECRET_NAME})(?:(\\?")([^"\\\n]{8,})(?=\\?")|(\\?')([^'\\\n]{8,})(?=\\?'))`, 'gi')
/**
 * An assignment such as `password=...`, `"api_key": "..."` or `TOKEN: ...` with a value of at least 8 characters and
 * at least one letter. A number, such as a count of tokens, stays. A quote can have a backslash before it, as in the
 * JSON text of the arguments of a tool call: `\"password\": \"...\"`. A value has no backslash. A value without quotes
 * ends at a space, so a sentence after the name, as in "password: see the vault", stays except a first long word.
 */
const ASSIGNMENT = new RegExp(String.raw`\b(${SECRET_NAME}\\?["']?)((?=[^\s"'\`,;&\\]*[A-Za-z])[^\s"'\`,;&\\]{8,})`, 'gi')

/** The values that a [KnownSecrets] keeps. A key that changed stays for a time, because a child can still show it. */
const KNOWN_SECRET_LIMIT = 32
/** The shortest value that a [KnownSecrets] keeps, so a short value cannot remove a common word from a text. */
const KNOWN_SECRET_MINIMUM = 8

/**
 * The exact secret values that this process knows at run time, such as the key of JetBrains Central and the base URL
 * that holds it. The filter removes each occurrence of a value, also when no pattern matches its shape. The values stay
 * in a private field of the memory only: no method gives them, and an inspection or a JSON text of the object shows
 * none of them. The newest values stay, at most [KNOWN_SECRET_LIMIT], so a key that changes while the daemon runs keeps
 * its earlier value too.
 */
export class KnownSecrets {
  #values = []
  #longestFirst = []

  /** Adds [values]. A value that is not a text or that is shorter than [KNOWN_SECRET_MINIMUM] characters is ignored. */
  add(...values) {
    for (const value of values) {
      if (typeof value !== 'string' || value.length < KNOWN_SECRET_MINIMUM) continue
      const index = this.#values.indexOf(value)
      if (index >= 0) this.#values.splice(index, 1)
      this.#values.unshift(value)
    }
    this.#values.length = Math.min(this.#values.length, KNOWN_SECRET_LIMIT)
    // A longer value goes first, so an address goes as a whole and not only its key.
    this.#longestFirst = [...this.#values].sort((first, second) => second.length - first.length)
  }

  /** Replaces each occurrence of a known value in [text] with [marker]. */
  redact(text, marker) {
    let result = text
    for (const value of this.#longestFirst) if (result.includes(value)) result = result.replaceAll(value, marker)
    return result
  }

  /**
   * The length of the longest end of [text] that is the start of a known value, and not the whole value. A text that
   * comes in parts must hold back this end, because the next part can complete the value. The length tells nothing of
   * a value that the text does not hold already.
   */
  partialEnd(text) {
    let longest = 0
    const last = text.charCodeAt(text.length - 1)
    for (const value of this.#values) {
      for (let length = Math.min(value.length - 1, text.length); length > longest; length--) {
        // A quick check of the last character first, so a long value costs little.
        if (value.charCodeAt(length - 1) === last && text.endsWith(value.slice(0, length))) { longest = length; break }
      }
    }
    return longest
  }
}

/**
 * Removes the own secret of Megachat from a text of a child that the state keeps: each exact value of [known], an
 * optional [KnownSecrets], and the path segment after `/wire/` of a URL. The output of a run, `agents_inspect`, the
 * result report and the conversation storage get this text. The other patterns of [redactSecrets] do not apply here:
 * they are a best effort for an index, they can change data that the main agent needs, and the child sent the text to
 * its provider already.
 */
export function redactOwnSecrets(text, known) {
  const marker = message('sessions.secret')
  const { pattern, accept } = WIRE_KEY
  return (known ? known.redact(text, marker) : text)
    .replace(pattern, (match, kept, secret) => accept(secret, marker) ? `${kept}${marker}` : match)
}

/** The characters that a [ChildTextFilter] holds back at most, as a transcript holds back a paragraph. */
export const HELD_TEXT_LIMIT = 16000

/**
 * The filter of [redactOwnSecrets] for a text that comes in parts, such as the reply of a child in chunks. A secret can
 * come in two parts, and a filter of each part alone, or of the kept text again after each part, then keeps the second
 * part of the secret. So the filter holds back the end of the text that the next part can still make a secret: the
 * text after the last white space, because a match of the `/wire/` pattern holds no white space, and the longest end
 * that is the start of a known value. Each other text is final, and the filter gives it at once. At most
 * [HELD_TEXT_LIMIT] characters wait: a longer word goes out in parts, so a secret across such a cut can stay.
 */
export class ChildTextFilter {
  #held = ''
  /** The length of the last word of the text that waits, so a part reads only its own characters. */
  #word = 0

  /** [known] is an optional [KnownSecrets]. */
  constructor(known) { this.known = known }

  /** Takes the next part of the text, and gives the filtered text that no later part can change. */
  push(text) {
    const whole = this.#held + text
    // The last word: the text after the last white space, as the pattern reads white space.
    let start = text.length
    while (start > 0 && !/\s/.test(text[start - 1])) start--
    const word = start > 0 ? text.length - start : this.#word + text.length
    const held = Math.min(Math.max(word, this.known?.partialEnd(whole) ?? 0), HELD_TEXT_LIMIT)
    let cut = whole.length - held
    // The cut must not separate the two halves of a character.
    if (cut > 0 && cut < whole.length && /[\uD800-\uDBFF]/.test(whole[cut - 1])) cut--
    this.#held = whole.slice(cut)
    this.#word = Math.min(word, this.#held.length)
    return cut ? redactOwnSecrets(whole.slice(0, cut), this.known) : ''
  }

  /** The filtered text that waits, for the end of the text. The text that waits stays, so a second call gives it again. */
  end() { return this.#held ? redactOwnSecrets(this.#held, this.known) : '' }
}

/**
 * Replaces each text that looks like a secret with a marker. [known] is an optional [KnownSecrets]: each of its exact
 * values goes first.
 */
export function redactSecrets(text, known) {
  const marker = message('sessions.secret')
  let result = known ? known.redact(text, marker) : text
  for (const { pattern, keep, accept } of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, kept, secret) => !keep ? marker : accept && !accept(secret, marker) ? match : `${kept}${marker}`)
  }
  result = result.replace(QUOTED_ASSIGNMENT, (match, name, double, doubleValue, single, singleValue) => {
    const value = doubleValue ?? singleValue
    return /[A-Za-z]/.test(value) && !value.startsWith(marker) ? `${name}${double ?? single}${marker}` : match
  })
  // A value that an earlier pattern replaced starts with the marker, and it stays.
  return result.replace(ASSIGNMENT, (match, name, value, offset, whole) => whole.startsWith(marker, offset + name.length) ? match : `${name}${marker}`)
}

/** The characters of the error output of a child run that the daemon keeps in its memory: twice the logged text. */
export const ERROR_OUTPUT_KEPT = 8000
/** The characters of the error output of a failed child run that go to the log of the daemon. */
export const ERROR_OUTPUT_LOGGED = 4000
/** The characters of each part of the reason in the error of a failed run. */
export const REASON_PART_LIMIT = 300
/** An ANSI escape sequence: a CSI sequence, an OSC sequence, or a sequence of two characters. */
const ANSI_SEQUENCE = /\u001b(?:\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g
/** Each control character except the tab and the line feed. */
const CONTROL_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g
/** The words that mark a line of an error output that tells the reason of a failure. */
const REASON_WORDS = /error|fail|denied|refused|invalid|unauthorized|forbidden|cannot|unable|exception/i

/** The end of [text] with at most [limit] characters. The cut does not separate the two halves of a character. */
export function textEnd(text, limit) {
  if (text.length <= limit) return text
  const kept = text.slice(-limit)
  return /^[\uDC00-\uDFFF]/.test(kept) ? kept.slice(1) : kept
}

/** The start of [text] with at most [limit] characters. The cut does not separate the two halves of a character. */
export function textStart(text, limit) {
  if (text.length <= limit) return text
  const kept = text.slice(0, limit)
  return /[\uD800-\uDBFF]$/.test(kept) ? kept.slice(0, -1) : kept
}

/**
 * [text] without ANSI escape sequences and control characters, with a line feed for each line end. A terminal that
 * shows the log then shows only the text.
 */
export function plainText(text) {
  return text.replace(/\r\n?/g, '\n').replace(ANSI_SEQUENCE, '').replace(CONTROL_CHARACTER, '')
}

/**
 * The error output of a child run as the log and the error of the run get it. [raw] is the end of the output that the
 * daemon kept. [cutStart] tells that the daemon dropped the start of the output: the first word can then be the second
 * half of a secret, so it goes. [open] tells that the output did not end: the next chunk can complete a secret, so the
 * last word and the longest end that is the start of a known value go. Then the full filter of [redactSecrets] runs on
 * the whole text, with the exact values of [known], an optional `KnownSecrets`. The output did not go to a provider, so
 * the other patterns apply too. The cut to [limit] characters comes last, after the filter.
 */
export function errorOutputText(raw, { cutStart = false, open = false, known, limit = ERROR_OUTPUT_LOGGED } = {}) {
  let text = raw
  if (cutStart) {
    const space = text.search(/\s/)
    text = space < 0 ? '' : text.slice(space + 1)
  }
  if (open) {
    let end = text.length
    while (end > 0 && !/\s/.test(text[end - 1])) end--
    text = text.slice(0, end)
    const partial = known?.partialEnd(text) ?? 0
    if (partial) text = text.slice(0, -partial)
  }
  return textEnd(redactSecrets(plainText(text), known), limit)
}

/**
 * The line of [text] for the reason in the error of a failed run: the last line with one of [REASON_WORDS], else the
 * last line that is not empty, at most [REASON_PART_LIMIT] characters. The last line of a Node.js crash names the
 * version of Node.js, so the line that names the error goes first. A line that [shown] holds already does not count.
 */
export function reasonLine(text, shown = '') {
  const lines = text.split('\n').map(line => line.trim()).filter(line => line && !shown.includes(line))
  const line = lines.findLast(item => REASON_WORDS.test(item)) ?? lines.at(-1)
  return line === undefined ? '' : textStart(line, REASON_PART_LIMIT)
}

/**
 * The text of an error answer of an agent: its message, then the `details` of its data, else the data as JSON text,
 * through the full filter. Both adapters of ACP give an internal error the message "Internal error" and the data
 * `{ "details": <the message of the error> }`, so the cause is in the data. [known] is an optional `KnownSecrets`.
 */
export function answerText(answer, known) {
  const { message: text, data } = answer
  const details = typeof data?.details === 'string' ? data.details : data === undefined || data === null ? '' : JSON.stringify(data)
  return redactSecrets(plainText([typeof text === 'string' ? text : '', details].filter(Boolean).join(': ')), known)
}

/**
 * The text of an entry as the session index keeps it: without secrets, and cut to about 2 KB. `clipped` tells that the
 * index lost a part of the text. The filter reads twice the limit first, so a secret across the limit is not cut in
 * two before the filter sees it. [known] is an optional [KnownSecrets].
 */
export function indexedText(text, known) {
  const clean = redactSecrets(text.length > 2 * ENTRY_TEXT_LIMIT ? text.slice(0, 2 * ENTRY_TEXT_LIMIT) : text, known)
  const clipped = text.length > ENTRY_TEXT_LIMIT || clean.length > ENTRY_TEXT_LIMIT
  let kept = clipped ? clean.slice(0, ENTRY_TEXT_LIMIT) : clean
  // The cut must not leave the first half of a character at the end.
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1)
  return { text: kept, clipped }
}

/**
 * A title as the session index keeps it: without secrets, and cut to [TITLE_LIMIT] characters. A title of a session
 * file, such as a custom title of Claude Code or a thread name of Codex, can be long and can hold a secret. [known] is an
 * optional [KnownSecrets].
 */
export function indexedTitle(title, known) {
  let kept = redactSecrets(title.slice(0, 2 * ENTRY_TEXT_LIMIT), known).slice(0, TITLE_LIMIT)
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1)
  return kept
}

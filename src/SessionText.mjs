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
 * The patterns of the text that looks like a secret. A pattern without `keep` replaces the whole match. A pattern with
 * `keep` has two groups: the text before the secret, which stays, and the secret. `accept` can refuse a match. The
 * list is a best effort: a secret of another shape stays in the text.
 */
const SECRET_PATTERNS = [
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

/** Replaces each text that looks like a secret with a marker. */
export function redactSecrets(text) {
  const marker = message('sessions.secret')
  let result = text
  for (const { pattern, keep, accept } of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, kept, secret) => !keep ? marker : accept && !accept(secret) ? match : `${kept}${marker}`)
  }
  result = result.replace(QUOTED_ASSIGNMENT, (match, name, double, doubleValue, single, singleValue) => {
    const value = doubleValue ?? singleValue
    return /[A-Za-z]/.test(value) && !value.startsWith(marker) ? `${name}${double ?? single}${marker}` : match
  })
  // A value that an earlier pattern replaced starts with the marker, and it stays.
  return result.replace(ASSIGNMENT, (match, name, value, offset, whole) => whole.startsWith(marker, offset + name.length) ? match : `${name}${marker}`)
}

/**
 * The text of an entry as the session index keeps it: without secrets, and cut to about 2 KB. `clipped` tells that the
 * index lost a part of the text. The filter reads twice the limit first, so a secret across the limit is not cut in
 * two before the filter sees it.
 */
export function indexedText(text) {
  const clean = redactSecrets(text.length > 2 * ENTRY_TEXT_LIMIT ? text.slice(0, 2 * ENTRY_TEXT_LIMIT) : text)
  const clipped = text.length > ENTRY_TEXT_LIMIT || clean.length > ENTRY_TEXT_LIMIT
  let kept = clipped ? clean.slice(0, ENTRY_TEXT_LIMIT) : clean
  // The cut must not leave the first half of a character at the end.
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1)
  return { text: kept, clipped }
}

/**
 * A title as the session index keeps it: without secrets, and cut to [TITLE_LIMIT] characters. A title of a session
 * file, such as a custom title of Claude Code or a thread name of Codex, can be long and can hold a secret.
 */
export function indexedTitle(title) {
  let kept = redactSecrets(title.slice(0, 2 * ENTRY_TEXT_LIMIT)).slice(0, TITLE_LIMIT)
  if (/[\uD800-\uDBFF]$/.test(kept)) kept = kept.slice(0, -1)
  return kept
}

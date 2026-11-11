import { message } from './messages.mjs'

/** The characters of an entry that the session index keeps, tool outputs included: about 2 KB. */
export const ENTRY_TEXT_LIMIT = 2000
/**
 * The characters of an entry that a parser of a session file gives. The parser cuts a long tool output early, so a
 * large line costs no large string. The secret filter then reads a bounded text.
 */
export const SOURCE_TEXT_LIMIT = 8000

/**
 * The patterns of the text that looks like a secret. Each one replaces the whole match, or for an assignment only the
 * value after the name. The list is a best effort: a secret of another shape stays in the text.
 */
const SECRET_PATTERNS = [
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g,
  /\bsk-[A-Za-z0-9_-]{16,}/g,
  /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g,
  /\b(Bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi,
]
/**
 * An assignment such as `password=...`, `"api_key": "..."` or `TOKEN: ...` with a value of at least 8 characters and
 * at least one letter. A number, such as a count of tokens, stays.
 */
const ASSIGNMENT = /\b((?:[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|credential)s?)["']?\s*[:=]\s*["']?)((?=[^\s"'`,;&]*[A-Za-z])[^\s"'`,;&]{8,})/gi

/** Replaces each text that looks like a secret with a marker. */
export function redactSecrets(text) {
  const marker = message('sessions.secret')
  let result = text
  for (const pattern of SECRET_PATTERNS) result = result.replace(pattern, (match, prefix) => typeof prefix === 'string' ? `${prefix}${marker}` : marker)
  return result.replace(ASSIGNMENT, (match, name, value) => value === marker ? match : `${name}${marker}`)
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

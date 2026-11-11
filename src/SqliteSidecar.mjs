import { chmod, open, rm } from 'node:fs/promises'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'

/** True for the SQLite errors of a damaged file: `SQLITE_CORRUPT` and `SQLITE_NOTADB`. */
export const corrupt = error => [11, 26].includes((error?.errcode ?? 0) & 0xff)

/** SQLite folds Latin diacritics only; `ё` and `е` are the same letter for search. */
export const fold = text => text.replace(/ё/g, 'е').replace(/Ё/g, 'Е')

/** Search terms of a query: whitespace-separated substrings of at least 3 characters, or [] for a short query. */
export function queryTerms(query) {
  return [...new Set(query.trim().split(/\s+/).filter(term => [...term].length >= 3))]
}

/** The FTS5 expression that matches each term as a substring. */
export const matchExpression = terms => terms.map(term => `"${fold(term).replaceAll('"', '""')}"`).join(' AND ')

/** The statement of a trigram FTS5 table that holds no copy of the text. The text of a row can be deleted by its rowid. */
export const FTS_TABLE = `CREATE VIRTUAL TABLE fts USING fts5(body, tokenize='trigram remove_diacritics 1', detail=full, content='', contentless_delete=1)`

/** Deletes the database file of a sidecar index and its journal files. */
export async function deleteSidecar(path) {
  await Promise.all(['', '-wal', '-shm'].map(suffix => rm(`${path}${suffix}`, { force: true })))
}

/**
 * Opens the SQLite file of an index next to the conversation with the mode 0600. [prepare] gets the database. It checks
 * the stored version and makes or resets the tables. A damaged file is deleted and made again one time, because an
 * index holds only data that Megachat can read again.
 */
export async function openSidecar(path, prepare) {
  const attempt = async () => {
    await (await open(path, 'a', 0o600)).close()
    await chmod(path, 0o600)
    const db = await openNodeSqliteDatabase(path)
    try { await prepare(db); return db }
    catch (error) { await db.close().catch(() => {}); throw error }
  }
  try { return await attempt() }
  catch (error) {
    if (!corrupt(error)) throw error
    await deleteSidecar(path)
    return attempt()
  }
}

/** A short excerpt around the first matching term, matching case-insensitively and with folded diacritics. */
export function snippet(text, terms, before = 120, after = 240) {
  const chars = Array.from(text)
  // One UTF-16 unit per character, so positions in the haystack are positions in `chars`.
  const plain = ch => {
    const folded = fold(ch).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
    return folded.length === 1 ? folded : ch.length === 1 ? ch : '￿'
  }
  const haystack = chars.map(plain).join('')
  let position = -1
  for (const term of terms) {
    const found = haystack.indexOf(Array.from(term, plain).join(''))
    if (found >= 0 && (position < 0 || found < position)) position = found
  }
  const start = Math.max(0, position - before)
  const end = Math.min(chars.length, Math.max(position, 0) + after)
  return `${start > 0 ? '…' : ''}${chars.slice(start, end).join('')}${end < chars.length ? '…' : ''}`
}

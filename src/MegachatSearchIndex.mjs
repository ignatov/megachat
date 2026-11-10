import { chmod, open, rm } from 'node:fs/promises'
import { openNodeSqliteDatabase } from '@earendil-works/chord/sqlite/node'

const VERSION = 2
const TOOL_TEXT_LIMIT = 2000
/** Entry IDs are allocated before commit, so a lower ID can commit after a higher one; catch-up rereads this many. */
const OVERLAP = 16
/** Matches ranked together: the newest first, then older ones window by window. */
export const RANK_WINDOW = 2000
const corrupt = error => [11, 26].includes((error?.errcode ?? 0) & 0xff)

const project = cwd => typeof cwd === 'string' ? `${cwd.split('/').filter(Boolean).at(-1) ?? cwd} (${cwd})` : ''
const clip = (text, limit, full) => full || text.length <= limit ? text : `${text.slice(0, limit)}…`

/** Human-readable text of a Megachat event: child results or a project change, without IDs and digests. */
function eventText(data, full) {
  if (data?.type === 'children') {
    const results = Array.isArray(data.results) ? data.results : []
    // Each result gets a share of the limit, so a long first output does not hide the other results.
    const share = Math.max(400, Math.floor(TOOL_TEXT_LIMIT / Math.max(1, results.length)))
    return results.map(run => clip([`Task ${run.status ?? ''} in ${project(run.cwd)}`, run.prompt, run.output, run.error]
      .filter(part => typeof part === 'string' && part).join('\n'), share, full)).join('\n\n')
  }
  if (data?.type === 'project')
    return clip([`Project changed: ${project(data.cwd)}`, ...(Array.isArray(data.paths) ? data.paths : [])].join('\n'), TOOL_TEXT_LIMIT, full)
  return ''
}

/** Text of an entry as the index sees it, or undefined for entries it does not index. */
export function entryText(entry, { full = false } = {}) {
  if (entry.head !== undefined || entry.kind === 'pi.system') return undefined
  const timestamp = entry.model?.find(model => Number.isFinite(model.timestamp))?.timestamp
  if (entry.kind === 'air.megachat.event') {
    const text = eventText(entry.data, full)
    return text ? { role: 'event', timestamp, text } : undefined
  }
  const parts = []
  let role
  for (const model of entry.model ?? []) {
    if (model.role === 'system') continue
    role ??= model.role
    const blocks = typeof model.content === 'string' ? [{ type: 'text', text: model.content }] : model.content ?? []
    let text = blocks.map(block => block.type === 'text' ? block.text
      : block.type === 'toolCall' ? `${block.name} ${JSON.stringify(block.arguments ?? {}).slice(0, TOOL_TEXT_LIMIT)}` : '')
      .filter(Boolean).join('\n')
    if (model.role === 'toolResult' && !full) text = text.slice(0, TOOL_TEXT_LIMIT)
    if (text) parts.push(text)
  }
  return parts.length ? { role, timestamp, text: parts.join('\n') } : undefined
}

/** SQLite folds Latin diacritics only; `ё` and `е` are the same letter for search. */
const fold = text => text.replace(/ё/g, 'е').replace(/Ё/g, 'Е')

/** Search terms of a query: whitespace-separated substrings of at least 3 characters, or [] for a short query. */
export function queryTerms(query) {
  return [...new Set(query.trim().split(/\s+/).filter(term => [...term].length >= 3))]
}

/**
 * A full-text index of the Megachat conversation in its own SQLite file next to pi-durable's database. It derives
 * everything from committed entries, so it can be dropped and rebuilt at any time.
 */
export class MegachatSearchIndex {
  /** `read(minEntryId, cursor)` returns an ascending page of committed entries: `{ items, next }`. */
  static async open(path, read) {
    const index = new MegachatSearchIndex(path, read)
    try { await index.#open() }
    catch (error) {
      if (!corrupt(error)) throw error
      await index.#delete()
      await index.#open()
    }
    return index
  }

  constructor(path, read) {
    this.path = path
    this.read = read
    this.queue = Promise.resolve()
  }

  async #open() {
    await (await open(this.path, 'a', 0o600)).close()
    await chmod(this.path, 0o600)
    this.db = await openNodeSqliteDatabase(this.path)
    try {
      await this.db.exec('CREATE TABLE IF NOT EXISTS meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, last_entry_id INTEGER NOT NULL)')
      const meta = await this.db.get('SELECT version FROM meta WHERE singleton = 1')
      if (meta?.version !== VERSION) await this.#reset()
      else await this.db.get('SELECT count(*) AS count FROM fts')
    }
    catch (error) { await this.db.close().catch(() => {}); this.db = undefined; throw error }
  }

  async #reset() {
    await this.db.transaction(async tx => {
      await tx.exec('DROP TABLE IF EXISTS fts')
      await tx.exec(`CREATE VIRTUAL TABLE fts USING fts5(body, tokenize='trigram remove_diacritics 1', detail=full, content='', contentless_delete=1)`)
      await tx.run('INSERT OR REPLACE INTO meta (singleton, version, last_entry_id) VALUES (1, ?, 0)', VERSION)
    })
  }

  async #delete() {
    await this.db?.close().catch(() => {})
    this.db = undefined
    await Promise.all(['', '-wal', '-shm'].map(suffix => rm(`${this.path}${suffix}`, { force: true })))
  }

  #serial(operation) {
    const result = this.queue.then(operation)
    this.queue = result.catch(() => {})
    return result
  }

  /** Runs an operation; a corrupt file is deleted and rebuilt from the entries once. */
  async #guard(operation) {
    try { return await operation() }
    catch (error) {
      if (!corrupt(error)) throw error
      await this.#delete()
      await this.#open()
      await this.#catchUp()
      return operation()
    }
  }

  async #write(tx, entry) {
    const indexed = entryText(entry)
    if (indexed) await tx.run('INSERT OR REPLACE INTO fts (rowid, body) VALUES (?, ?)', entry.id, fold(indexed.text))
    await tx.run('UPDATE meta SET last_entry_id = max(last_entry_id, ?) WHERE singleton = 1', entry.id)
  }

  /** Indexes one committed entry. */
  append(entry) {
    return this.#serial(() => this.#guard(() => this.db.transaction(tx => this.#write(tx, entry))))
  }

  /** Indexes the entries committed since the last indexed one. */
  catchUp() { return this.#serial(() => this.#guard(() => this.#catchUp())) }

  async #catchUp() {
    const last = (await this.db.get('SELECT last_entry_id AS id FROM meta WHERE singleton = 1')).id
    let cursor
    let indexed = 0
    do {
      const page = await this.read(Math.max(1, last - OVERLAP + 1), cursor)
      await this.db.transaction(async tx => {
        for (const entry of page.items) {
          if (entry.id <= last && await tx.get('SELECT rowid FROM fts WHERE rowid = ?', entry.id)) continue
          await this.#write(tx, entry)
          indexed++
        }
      })
      cursor = page.next
    } while (cursor)
    return indexed
  }

  /** Drops the index and indexes every entry again. */
  rebuild() {
    return this.#serial(() => this.#guard(async () => { await this.#reset(); return this.#catchUp() }))
  }

  /** Removes an entry that is no longer part of the conversation history, such as one a rewind dropped. */
  remove(entryId) {
    return this.#serial(() => this.#guard(() => this.db.run('DELETE FROM fts WHERE rowid = ?', entryId)))
  }

  /** Entry IDs matching every term as a substring, best bm25 first; undefined when the query has no term to search. */
  search(query, { limit = 10, offset = 0 } = {}) {
    const terms = queryTerms(query)
    if (!terms.length) return Promise.resolve(undefined)
    const match = terms.map(term => `"${fold(term).replaceAll('"', '""')}"`).join(' AND ')
    return this.#serial(() => this.#guard(async () => {
      // bm25 over every match of a common term costs ~100 ms per 10^5 entries, so it ranks windows of the newest
      // matches; later pages continue into older windows.
      const window = Math.floor(offset / RANK_WINDOW)
      const rows = await this.db.all(`SELECT id FROM (SELECT rowid AS id, rank FROM fts WHERE fts MATCH ? ORDER BY rowid DESC
        LIMIT ${RANK_WINDOW + 1} OFFSET ?) ORDER BY rank`, match, window * RANK_WINDOW)
      // The extra, oldest row only tells whether an older window exists.
      const oldest = rows.reduce((min, row) => Math.min(min, row.id), Infinity)
      const ranked = rows.length > RANK_WINDOW ? rows.filter(row => row.id !== oldest) : rows
      const ids = ranked.slice(offset % RANK_WINDOW, offset % RANK_WINDOW + limit).map(row => row.id)
      return { ids, more: offset % RANK_WINDOW + ids.length < ranked.length || rows.length > RANK_WINDOW, terms }
    }))
  }

  async lastEntryId() {
    return this.#serial(async () => (await this.db.get('SELECT last_entry_id AS id FROM meta WHERE singleton = 1')).id)
  }

  close() { return this.#serial(async () => { await this.db?.close(); this.db = undefined }) }
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

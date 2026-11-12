import { corrupt, deleteSidecar, fold, FTS_TABLE, matchExpression, openSidecar, queryTerms, snippet } from './SqliteSidecar.mjs'

export { queryTerms, snippet }

const VERSION = 2
const TOOL_TEXT_LIMIT = 2000
/**
 * The tool of the learned memory. The index skips its calls and their results, so a forgotten entry does not come back
 * through a history search. The tool is newer than version 2 of the index, so an index of an earlier build holds no
 * such call, and the index needs no rebuild.
 */
const MEMORY_TOOL = 'agents_memory'
/** Entry IDs are allocated before commit, so a lower ID can commit after a higher one; catch-up rereads this many. */
const OVERLAP = 16
/** Matches ranked together: the newest first, then older ones window by window. */
export const RANK_WINDOW = 2000

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
  if (data?.type === 'sessions') {
    const unfinished = Array.isArray(data.unfinished) ? data.unfinished : []
    return clip([`Past sessions indexed: ${data.sessions ?? 0} sessions in ${data.projects ?? 0} projects`,
      ...unfinished.map(session => `${session.agent ?? ''} ${session.title ?? ''} ${project(session.cwd)}`.trim())].join('\n'), TOOL_TEXT_LIMIT, full)
  }
  // Megachat up to v0.3.0 wrote the entry of a project event. An old history keeps such entries, so the index reads them.
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
    if (model.role === 'system' || model.role === 'toolResult' && model.toolName === MEMORY_TOOL) continue
    role ??= model.role
    const blocks = typeof model.content === 'string' ? [{ type: 'text', text: model.content }] : model.content ?? []
    let text = blocks.map(block => block.type === 'text' ? block.text
      : block.type === 'toolCall' && block.name !== MEMORY_TOOL ? `${block.name} ${JSON.stringify(block.arguments ?? {}).slice(0, TOOL_TEXT_LIMIT)}` : '')
      .filter(Boolean).join('\n')
    if (model.role === 'toolResult' && !full) text = text.slice(0, TOOL_TEXT_LIMIT)
    if (text) parts.push(text)
  }
  return parts.length ? { role, timestamp, text: parts.join('\n') } : undefined
}

/**
 * A full-text index of the Megachat conversation in its own SQLite file next to pi-durable's database. It derives
 * everything from committed entries, so it can be dropped and rebuilt at any time.
 */
export class MegachatSearchIndex {
  /** `read(minEntryId, cursor)` returns an ascending page of committed entries: `{ items, next }`. */
  static async open(path, read) {
    const index = new MegachatSearchIndex(path, read)
    await index.#open()
    return index
  }

  constructor(path, read) {
    this.path = path
    this.read = read
    this.queue = Promise.resolve()
  }

  async #open() {
    this.db = await openSidecar(this.path, async db => {
      await db.exec('CREATE TABLE IF NOT EXISTS meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, last_entry_id INTEGER NOT NULL)')
      const meta = await db.get('SELECT version FROM meta WHERE singleton = 1')
      if (meta?.version !== VERSION) await this.#reset(db)
      else await db.get('SELECT count(*) AS count FROM fts')
    })
  }

  async #reset(db = this.db) {
    await db.transaction(async tx => {
      await tx.exec('DROP TABLE IF EXISTS fts')
      await tx.exec(FTS_TABLE)
      await tx.run('INSERT OR REPLACE INTO meta (singleton, version, last_entry_id) VALUES (1, ?, 0)', VERSION)
    })
  }

  async #delete() {
    await this.db?.close().catch(() => {})
    this.db = undefined
    await deleteSidecar(this.path)
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
    const match = matchExpression(terms)
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

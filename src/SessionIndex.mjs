import { sep } from 'node:path'
import { corrupt, deleteSidecar, fold, FTS_TABLE, matchExpression, openSidecar } from './SqliteSidecar.mjs'
import { indexedTitle } from './SessionText.mjs'

/** A change of the tables or of the parsers needs a new version. A file of another version is made again. */
export const VERSION = 2
/**
 * The matches that bm25 ranks together: the matches with the highest entry IDs first, then older ones window by
 * window, as in the conversation index. bm25 costs up to about 50 µs for each match of a common term, so the window is
 * smaller than there.
 */
export const RANK_WINDOW = 300
/** The windows that one search reads at most to fill a page with sessions. */
const WINDOWS_PER_PAGE = 2
/**
 * The entry ID of an entry is the ID of its scope, an agent and a `cwd`, times this span, plus a count. So the scope of
 * a match comes from its ID without a read of a table, and a search of a directory skips the other matches cheaply.
 * The span leaves 2^21 scopes in the safe integers of JavaScript.
 */
export const SCOPE_SPAN = 2 ** 32
const SCOPE_SHIFT = 32
/** The entries that one transaction deletes. A larger count blocks the event loop longer. */
const DELETE_BATCH = 500
const PAGE = 10
/**
 * The pages of one merge step of the trigram index. FTS5 merges its segments in the transaction of a write by default,
 * and such a merge of large segments blocks the event loop for a long time. So the import merges in small steps.
 */
const MERGE_PAGES = 8

/**
 * The live table of the session files of the machine, for the tool `agents_running`: the metadata of each file and the
 * last step of its tail, with no message text. It is not a part of the index, so a file of the same version gets it
 * without a new import.
 */
const LOGS_TABLE = `CREATE TABLE IF NOT EXISTS logs (path TEXT PRIMARY KEY, agent TEXT NOT NULL, ino TEXT NOT NULL, size INTEGER NOT NULL,
  offset INTEGER NOT NULL, session_id TEXT, cwd TEXT, title TEXT, title_rank INTEGER, started_at INTEGER, last_write_at INTEGER, last_step TEXT)`

const TABLES = [
  'CREATE TABLE meta (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), version INTEGER NOT NULL, first_pass_at INTEGER, announce INTEGER NOT NULL)',
  // The import state of each session file. `state` is `indexed`, or `outside` for a session in no listed directory.
  // `tail` is a hash of the last bytes before `offset`, so the import finds a file that a writer rewrote in place.
  `CREATE TABLE files (id INTEGER PRIMARY KEY, path TEXT NOT NULL UNIQUE, agent TEXT NOT NULL, session INTEGER, cwd TEXT,
    size INTEGER NOT NULL, mtime_ms INTEGER NOT NULL, ino TEXT NOT NULL, offset INTEGER NOT NULL, state TEXT NOT NULL, tail TEXT)`,
  'CREATE INDEX files_session ON files (session)',
  'CREATE TABLE scopes (id INTEGER PRIMARY KEY, agent TEXT NOT NULL, cwd TEXT NOT NULL, next INTEGER NOT NULL DEFAULT 0, UNIQUE (agent, cwd))',
  `CREATE TABLE sessions (id INTEGER PRIMARY KEY, agent TEXT NOT NULL, session_id TEXT NOT NULL, cwd TEXT NOT NULL, title TEXT,
    title_rank INTEGER NOT NULL DEFAULT -1, started_at INTEGER, updated_at INTEGER NOT NULL, entry_count INTEGER NOT NULL DEFAULT 0,
    last_kind TEXT, UNIQUE (agent, session_id))`,
  // `key` is the entry ID of the provider: a fork or a copy of a session gives the same key, and the entry is in the
  // index one time. The rows are small, because a search reads the session of each match from this table.
  `CREATE TABLE entries (id INTEGER PRIMARY KEY, session INTEGER NOT NULL, file INTEGER, agent TEXT NOT NULL, key TEXT NOT NULL,
    role TEXT NOT NULL, tool TEXT, timestamp INTEGER, clipped INTEGER NOT NULL, UNIQUE (agent, key))`,
  'CREATE INDEX entries_session ON entries (session, id)',
  'CREATE INDEX entries_file ON entries (file)',
  // The text of each entry, cut to about 2 KB, so a snippet needs no read of the session file.
  'CREATE TABLE texts (id INTEGER PRIMARY KEY, text TEXT NOT NULL)',
  FTS_TABLE,
  LOGS_TABLE,
]

/** The SQL condition and its arguments for a session in [cwd] or in a directory below it. */
const scope = (cwd, table = 's') => {
  const prefix = cwd.endsWith(sep) ? cwd : `${cwd}${sep}`
  return { sql: `(${table}.cwd = ? OR substr(${table}.cwd, 1, ?) = ?)`, args: [cwd, prefix.length, prefix] }
}
/** The SQL condition for a session after the last session of a page, in the order of the last activity. */
const keyset = ({ updated, id } = {}) => updated === undefined
  ? { sql: '', args: [] } : { sql: ' AND (s.updated_at < ? OR s.updated_at = ? AND s.id < ?)', args: [updated, updated, id] }
const keysetNext = rows => rows.length > PAGE ? { updated: rows[PAGE - 1].updated_at, id: rows[PAGE - 1].id } : undefined
const iso = time => Number.isFinite(time) ? new Date(time).toISOString() : null
const sessionInfo = row => ({ sessionId: row.session_id, title: row.title ?? undefined, cwd: row.cwd, updatedAt: iso(row.updated_at),
  ...(Number.isFinite(row.started_at) ? { startedAt: iso(row.started_at) } : {}) })

/**
 * The index of the past sessions of Claude Code, Codex and pi in `sessions.sqlite`, apart from the conversation. It
 * holds the import state of each session file, the data of each session, and the cut text of each entry with a trigram
 * FTS5 index. Megachat can delete it at each time and import the files again.
 */
export class SessionIndex {
  static async open(path) {
    const index = new SessionIndex(path)
    await index.#open()
    return index
  }

  constructor(path) { this.path = path }

  async #open() {
    this.db = await openSidecar(this.path, async db => {
      const meta = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
      const version = meta ? (await db.get('SELECT version FROM meta WHERE singleton = 1'))?.version : undefined
      if (version !== VERSION) {
        // A new file tells the user a summary after its first pass. A file that a new version makes again does not.
        await this.#reset(db, meta ? 0 : 1)
      }
      else {
        await db.get('SELECT count(*) AS count FROM fts')
        await db.exec(LOGS_TABLE)
      }
    })
  }

  async #reset(db, announce) {
    await db.transaction(async tx => {
      for (const table of ['fts', 'texts', 'entries', 'sessions', 'scopes', 'files', 'meta', 'logs']) await tx.exec(`DROP TABLE IF EXISTS ${table}`)
      for (const statement of TABLES) await tx.exec(statement)
      await tx.exec("INSERT INTO fts (fts, rank) VALUES ('automerge', 0)")
      await tx.exec("INSERT INTO fts (fts, rank) VALUES ('crisismerge', 64)")
      await tx.run('INSERT INTO meta (singleton, version, first_pass_at, announce) VALUES (1, ?, NULL, ?)', VERSION, announce)
    })
  }

  /** Runs an operation. A damaged file is deleted and made again, and `damaged` tells the service to import again. */
  async #guard(operation) {
    try { return await operation() }
    catch (error) {
      if (!corrupt(error)) throw error
      await this.db?.close().catch(() => {})
      await deleteSidecar(this.path)
      await this.#open()
      this.damaged = true
      throw error
    }
  }

  async meta() { return this.#guard(() => this.db.get('SELECT first_pass_at AS firstPassAt, announce FROM meta WHERE singleton = 1')) }

  markFirstPass(time) { return this.#guard(() => this.db.run('UPDATE meta SET first_pass_at = ?, announce = 0 WHERE singleton = 1', time)) }

  file(path) { return this.#guard(() => this.db.get('SELECT * FROM files WHERE path = ?', path)) }

  async files() { return this.#guard(() => this.db.all('SELECT * FROM files')) }

  /** Records a file of a session outside the listed directories. The import does not read it again until it changes. */
  outside(file, cwd) {
    return this.#guard(() => this.db.run(`INSERT INTO files (path, agent, session, cwd, size, mtime_ms, ino, offset, state)
      VALUES (?, ?, NULL, ?, ?, ?, ?, 0, 'outside') ON CONFLICT (path) DO UPDATE SET session = NULL, cwd = excluded.cwd,
      size = excluded.size, mtime_ms = excluded.mtime_ms, ino = excluded.ino, offset = 0, state = 'outside', tail = NULL`,
    file.path, file.agent, cwd ?? null, file.size, Math.floor(file.mtimeMs), file.ino))
  }

  /** Stores the size and the time of a file that changed without a change of its import. */
  touch(file) {
    return this.#guard(() => this.db.run('UPDATE files SET size = ?, mtime_ms = ? WHERE path = ?', file.size, Math.floor(file.mtimeMs), file.path))
  }

  /**
   * Writes one batch of a file in one transaction: the session data of [meta], the entries, and the import state up to
   * [offset], with the hash `file.tail` of the bytes before it. An entry with a key that the index has already is
   * skipped. Gives the count of the new entries.
   */
  write(file, meta, entries, offset) {
    return this.#guard(() => this.db.transaction(async tx => {
      const mtime = Math.floor(file.mtimeMs)
      await tx.run(`INSERT INTO sessions (agent, session_id, cwd, title, title_rank, started_at, updated_at) VALUES (?, ?, ?, NULL, -1, ?, ?)
        ON CONFLICT (agent, session_id) DO UPDATE SET updated_at = max(updated_at, excluded.updated_at),
        started_at = coalesce(min(started_at, excluded.started_at), started_at, excluded.started_at)`,
      file.agent, meta.sessionId, meta.cwd, meta.startedAt ?? null, mtime)
      const session = await tx.get('SELECT id, cwd, title, title_rank AS titleRank FROM sessions WHERE agent = ? AND session_id = ?', file.agent, meta.sessionId)
      await tx.run('INSERT INTO scopes (agent, cwd) VALUES (?, ?) ON CONFLICT (agent, cwd) DO NOTHING', file.agent, session.cwd)
      session.scope = (await tx.get('SELECT id FROM scopes WHERE agent = ? AND cwd = ?', file.agent, session.cwd)).id
      // Each title of a session file goes through the secret filter and the limit here, before the store keeps it.
      const named = meta.title === undefined ? undefined : indexedTitle(meta.title)
      let title = named !== undefined && meta.titleRank >= session.titleRank && named !== session.title
        ? { text: named, rank: meta.titleRank } : undefined
      const { id: fileId } = await tx.get(`INSERT INTO files (path, agent, session, cwd, size, mtime_ms, ino, offset, state, tail)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'indexed', ?) ON CONFLICT (path) DO UPDATE SET session = excluded.session, cwd = excluded.cwd,
        size = excluded.size, mtime_ms = excluded.mtime_ms, ino = excluded.ino, offset = excluded.offset, state = 'indexed',
        tail = excluded.tail RETURNING id`,
      file.path, file.agent, session.id, meta.cwd, file.size, mtime, file.ino, offset, file.tail ?? null)
      let added = 0
      let last
      for (const entry of entries) {
        const row = await tx.get(`INSERT INTO entries (id, session, file, agent, key, role, tool, timestamp, clipped) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (agent, key) DO NOTHING RETURNING id`, await this.#nextId(tx, session.scope), session.id, fileId, file.agent, entry.key,
        entry.role, entry.tool ?? null, entry.timestamp ?? null, entry.clipped ? 1 : 0)
        if (!row) continue
        await tx.run('INSERT INTO texts (id, text) VALUES (?, ?)', row.id, entry.text)
        await tx.run('INSERT INTO fts (rowid, body) VALUES (?, ?)', row.id, fold(entry.text))
        added++
        last = entry
        // Without a title, the first prompt of the user names the session.
        if (!title && session.titleRank < 0 && entry.role === 'user' && !entry.tool && !session.title) {
          title = { text: entry.text.split('\n').find(line => line.trim())?.trim().slice(0, 100), rank: 0 }
          session.titleRank = 0
        }
      }
      if (title?.text) await this.#title(tx, session, file.agent, meta.sessionId, title)
      if (added) {
        await tx.run('UPDATE sessions SET entry_count = entry_count + ?, last_kind = ?, updated_at = max(updated_at, ?) WHERE id = ?',
          added, last.tool ?? last.role, last.timestamp ?? 0, session.id)
      }
      return added
    }))
  }

  /**
   * The next entry ID in the range of [scope]. The count after the scope is one sequence for each scope, so a search
   * can skip each entry that came after its first page.
   */
  async #nextId(tx, scope) {
    const { next } = await tx.get('UPDATE scopes SET next = (SELECT max(next) FROM scopes) + 1 WHERE id = ? RETURNING next', scope)
    return scope * SCOPE_SPAN + next
  }

  /** Runs one bounded merge step of the trigram index. Gives false when the index had no merge work. */
  mergeStep() {
    return this.#guard(async () => {
      const before = (await this.db.get('SELECT total_changes() AS count')).count
      await this.db.run("INSERT INTO fts (fts, rank) VALUES ('merge', ?)", MERGE_PAGES)
      // The command itself counts as one change. A merge writes rows of the index, so it counts more.
      return (await this.db.get('SELECT total_changes() AS count')).count - before > 1
    })
  }

  /** The title is an entry of its own, so a search finds a session by its title too. */
  async #title(tx, session, agent, providerId, title) {
    const sessionId = session.id
    await tx.run('UPDATE sessions SET title = ?, title_rank = ? WHERE id = ?', title.text, title.rank, sessionId)
    const key = `title:${providerId}`
    const old = await tx.get('SELECT id FROM entries WHERE agent = ? AND key = ?', agent, key)
    if (old) {
      await tx.run('UPDATE texts SET text = ? WHERE id = ?', title.text, old.id)
      await tx.run('DELETE FROM fts WHERE rowid = ?', old.id)
      await tx.run('INSERT INTO fts (rowid, body) VALUES (?, ?)', old.id, fold(title.text))
      return
    }
    const row = await tx.get(`INSERT INTO entries (id, session, file, agent, key, role, tool, timestamp, clipped)
      VALUES (?, ?, NULL, ?, ?, 'title', NULL, NULL, 0) RETURNING id`, await this.#nextId(tx, session.scope), sessionId, agent, key)
    await tx.run('INSERT INTO texts (id, text) VALUES (?, ?)', row.id, title.text)
    await tx.run('INSERT INTO fts (rowid, body) VALUES (?, ?)', row.id, fold(title.text))
  }

  /**
   * Deletes the entries that a file gave, in batches, and the import state of the file. A session without a file then
   * leaves the index. [pause] runs between the batches, so the event loop does not stay blocked.
   */
  async dropFile(path, pause = async () => {}) {
    const fileId = (await this.file(path))?.id
    for (;;) {
      const removed = await this.#guard(() => this.db.transaction(async tx => {
        const rows = await tx.all('SELECT id FROM entries WHERE file = ? LIMIT ?', fileId ?? -1, DELETE_BATCH)
        if (rows.length) await this.#deleteEntries(tx, rows.map(row => row.id))
        return rows.length
      }))
      if (removed < DELETE_BATCH) break
      await pause()
    }
    await this.#guard(() => this.db.transaction(async tx => {
      const file = await tx.get('SELECT session FROM files WHERE path = ?', path)
      await tx.run('DELETE FROM files WHERE path = ?', path)
      if (file?.session == null || await tx.get('SELECT 1 FROM files WHERE session = ?', file.session)) {
        if (file?.session != null) {
          const count = await tx.get('SELECT count(*) AS count FROM entries WHERE session = ? AND role != ?', file.session, 'title')
          await tx.run('UPDATE sessions SET entry_count = ? WHERE id = ?', count.count, file.session)
        }
        return
      }
      // The entries of other files with the same session, such as the title, go with the session.
      await this.#deleteEntries(tx, (await tx.all('SELECT id FROM entries WHERE session = ?', file.session)).map(row => row.id))
      await tx.run('DELETE FROM sessions WHERE id = ?', file.session)
    }))
  }

  async #deleteEntries(tx, ids) {
    for (const id of ids) await tx.run('DELETE FROM fts WHERE rowid = ?', id)
    for (let start = 0; start < ids.length; start += DELETE_BATCH) {
      const part = ids.slice(start, start + DELETE_BATCH)
      const marks = part.map(() => '?').join(',')
      await tx.run(`DELETE FROM texts WHERE id IN (${marks})`, ...part)
      await tx.run(`DELETE FROM entries WHERE id IN (${marks})`, ...part)
    }
  }

  /** True when the index has a session of [agent] in [cwd] or below it. */
  async hasSessions(agent, cwd) {
    const where = scope(cwd)
    return Boolean(await this.#guard(() => this.db.get(`SELECT 1 AS found FROM sessions s WHERE s.agent = ? AND ${where.sql} LIMIT 1`, agent, ...where.args)))
  }

  /**
   * The sessions of [agent] in [cwd] with an entry or a title that matches each of [terms], best bm25 first, one hit
   * for each session. bm25 over each match of a common term is slow, so it ranks windows of the matches with the
   * highest IDs. [position] is `{ before, offset }`: the entry ID below which the current window starts, and the
   * sessions of that window that a page gave already, and `until`, the last count of the sequence of the entry IDs at
   * the first page. A later page skips each newer entry, so a new match does not move the ranked list under the
   * offset. Gives `{ hits, next }`. `next` is undefined after the last page.
   */
  async search(agent, cwd, terms, position = {}) {
    const where = scope(cwd, 'scopes')
    const match = matchExpression(terms)
    return this.#guard(async () => {
      const scopes = (await this.db.all(`SELECT id FROM scopes WHERE agent = ? AND ${where.sql}`, agent, ...where.args)).map(row => row.id)
      if (!scopes.length) return { hits: [], next: undefined }
      const until = position.until ?? (await this.db.get('SELECT coalesce(max(next), 0) AS next FROM scopes')).next
      const inScope = `(fts.rowid >> ${SCOPE_SHIFT}) IN (${scopes.join(',')}) AND (fts.rowid & ${SCOPE_SPAN - 1}) <= ${until}`
      let before = position.before ?? Number.MAX_SAFE_INTEGER
      let offset = position.offset ?? 0
      // A session with a match above the current window had its page there already.
      const shown = new Set(before === Number.MAX_SAFE_INTEGER ? [] : (await this.db.all(`SELECT DISTINCT e.session AS session FROM fts
        JOIN entries e ON e.id = fts.rowid WHERE fts MATCH ? AND fts.rowid >= ? AND ${inScope} ORDER BY fts.rowid DESC`, match, before))
        .map(row => row.session))
      const hits = []
      let more = true
      for (let read = 0; read < WINDOWS_PER_PAGE && hits.length < PAGE && more; read++) {
        const rows = await this.db.all(`SELECT fts.rowid AS id, e.session AS session, rank FROM fts JOIN entries e ON e.id = fts.rowid
          WHERE fts MATCH ? AND fts.rowid < ? AND ${inScope} ORDER BY fts.rowid DESC LIMIT ${RANK_WINDOW + 1}`, match, before)
        more = rows.length > RANK_WINDOW
        if (more) rows.length = RANK_WINDOW
        const best = new Map()
        for (const row of rows) {
          if (shown.has(row.session)) continue
          const known = best.get(row.session)
          if (!known || row.rank < known.rank) best.set(row.session, row)
        }
        const ranked = [...best.values()].sort((left, right) => left.rank - right.rank)
        const page = ranked.slice(offset, offset + PAGE - hits.length)
        for (const row of page) {
          const entry = await this.db.get('SELECT key, role, tool, timestamp, text, clipped FROM entries JOIN texts USING (id) WHERE id = ?', row.id)
          const session = await this.db.get('SELECT * FROM sessions WHERE id = ?', row.session)
          hits.push({ session: sessionInfo(session), entry: this.#entry(entry) })
        }
        if (offset + page.length < ranked.length) { offset += page.length; return { hits, next: { before, offset, until } } }
        // Each session of this window is on a page now, so the next window starts below it.
        for (const row of ranked) shown.add(row.session)
        if (more) before = rows.at(-1).id
        offset = 0
      }
      return { hits, next: more ? { before, offset: 0, until } : undefined }
    })
  }

  /**
   * The sessions of [agent] in [cwd], the last active first, a page after [position]. The position is the time and the
   * row ID of the last session of the page before, so a session that becomes active does not move a later page.
   */
  async list(agent, cwd, position = {}) {
    const where = scope(cwd)
    const after = keyset(position)
    return this.#guard(async () => {
      const rows = await this.db.all(`SELECT * FROM sessions s WHERE s.agent = ? AND ${where.sql}${after.sql} ORDER BY s.updated_at DESC, s.id DESC
        LIMIT ${PAGE + 1}`, agent, ...where.args, ...after.args)
      return { sessions: rows.slice(0, PAGE).map(sessionInfo), next: keysetNext(rows) }
    })
  }

  /** The sessions of [agent] in [cwd] with [text] in the title, for a query that is too short for the trigram index. */
  async titled(agent, cwd, text, position = {}) {
    const where = scope(cwd)
    const after = keyset(position)
    return this.#guard(async () => {
      const rows = await this.db.all(`SELECT * FROM sessions s WHERE s.agent = ? AND ${where.sql} AND instr(lower(s.title), lower(?)) > 0${after.sql}
        ORDER BY s.updated_at DESC, s.id DESC LIMIT ${PAGE + 1}`, agent, ...where.args, text, ...after.args)
      return { sessions: rows.slice(0, PAGE).map(sessionInfo), next: keysetNext(rows) }
    })
  }

  /** The session [sessionId] of [agent] in [cwd] or below it, or undefined. */
  async session(agent, cwd, sessionId) {
    const where = scope(cwd)
    const row = await this.#guard(() => this.db.get(`SELECT * FROM sessions s WHERE s.agent = ? AND s.session_id = ? AND ${where.sql}`,
      agent, sessionId, ...where.args))
    return row ? { id: row.id, info: sessionInfo(row) } : undefined
  }

  /** The entries of a session after the entry ID [after], in the order of the import, without the title. */
  async entries(session, after = 0, limit = 20) {
    return this.#guard(async () => {
      const rows = await this.db.all(`SELECT id, key, role, tool, timestamp, text, clipped FROM entries JOIN texts USING (id)
        WHERE session = ? AND role != 'title' AND id > ? ORDER BY id LIMIT ${limit + 1}`, session, after)
      return { entries: rows.slice(0, limit).map(row => ({ ...this.#entry(row), rowId: row.id })), more: rows.length > limit }
    })
  }

  #entry(row) {
    return { id: row.key, role: row.role, ...(row.tool ? { tool: row.tool } : {}), timestamp: iso(row.timestamp), text: row.text, clipped: row.clipped === 1 }
  }

  /** The ID of the provider and the `cwd` of the session with the row ID [id]. */
  async sessionOf(id) {
    return this.#guard(() => this.db.get('SELECT session_id AS sessionId, cwd FROM sessions WHERE id = ?', id))
  }

  /** Each session with the data of a summary, the last active first. */
  async sessions() {
    return this.#guard(() => this.db.all('SELECT agent, session_id, cwd, title, updated_at, entry_count, last_kind FROM sessions ORDER BY updated_at DESC'))
  }

  /** Each row of the live table of the session files. */
  async logs() { return this.#guard(() => this.db.all('SELECT * FROM logs')) }

  /** Stores the metadata of one session file of the live table. */
  saveLog(record) {
    return this.#guard(() => this.db.run(`INSERT INTO logs (path, agent, ino, size, offset, session_id, cwd, title, title_rank, started_at,
      last_write_at, last_step) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (path) DO UPDATE SET agent = excluded.agent,
      ino = excluded.ino, size = excluded.size, offset = excluded.offset, session_id = excluded.session_id, cwd = excluded.cwd,
      title = excluded.title, title_rank = excluded.title_rank, started_at = excluded.started_at, last_write_at = excluded.last_write_at,
      last_step = excluded.last_step`, record.path, record.agent, record.ino, record.size, record.offset, record.sessionId ?? null,
    record.cwd ?? null, record.title ?? null, record.titleRank ?? null, record.startedAt ?? null, Math.floor(record.mtimeMs), record.step ?? null))
  }

  dropLog(path) { return this.#guard(() => this.db.run('DELETE FROM logs WHERE path = ?', path)) }

  /** The count of the sessions and of the entries without the titles. */
  async counts() {
    return this.#guard(() => this.db.get(`SELECT (SELECT count(*) FROM sessions) AS sessions,
      (SELECT coalesce(sum(entry_count), 0) FROM sessions) AS entries`))
  }

  close() { return this.db?.close() }
}


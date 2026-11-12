import { createHash } from 'node:crypto'
import { watch as watchFiles } from 'node:fs'
import * as fileSystem from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { logFailure } from './messages.mjs'
import { directoriesOf } from './ProjectDirectories.mjs'
import { SessionCatalog } from './SessionCatalog.mjs'
import { SessionIndex } from './SessionIndex.mjs'
import { directoryOf, isCompressed, readLines } from './SessionLog.mjs'
import { sessionSources } from './SessionSources.mjs'
import { indexedText } from './SessionText.mjs'
import { deleteSidecar } from './SqliteSidecar.mjs'

const DAY_MS = 86400000
/** The bytes that the import reads at most to find the `cwd` of a new session file. */
const PEEK_BYTES = 1024 * 1024
/** A pass with this count of files to read shows a background task also after the first pass. */
const VISIBLE_PASS = 20
/** The task of a pass changes at each tenth of the files, so the chat gets at most eleven updates for one pass. */
const STEPS = 10
/** The longest time that a search waits for the import of the files of its directory. */
const SEARCH_BUDGET_MS = 2000
/** The origins of the listed directories in the order of the first pass: the projects of an IDE first. */
const ORIGIN_RANK = { ide: 0, megachat: 1, known: 2 }
const SUMMARY_UNFINISHED = 5
/** The lines of one transaction of the import. The trigram index of an entry of 2 KB takes about 1 ms. */
const BATCH_LINES = 8
const BATCH_BYTES = 128 * 1024
/** The bytes before the offset of the import that the hash of a file covers. */
const TAIL_BYTES = 128

/** Gives the event loop to other work, such as a turn of the chat, between two batches of the import. */
const pause = () => new Promise(resolve => setImmediate(resolve))
const identity = stat => ({ size: stat.size, mtimeMs: stat.mtimeMs, ino: String(stat.ino) })
/** The session ID that the name of a file gives, when the file names none: the name without `.jsonl` or `.jsonl.zst`. */
const nameOf = path => basename(path).replace(/\.jsonl(?:\.zst)?$/, '')

/**
 * Imports the past sessions of Claude Code, Codex and pi of the listed directories into `sessions.sqlite`, with the
 * consent of the user only. With the setting `sessions.index` off, it reads no session file, watches no directory of a
 * provider, and keeps no index file. The import runs in batches with a pause between them, so the chat stays usable.
 * The first pass takes the files of the projects of an IDE first, and the newest files first. After it, the import
 * catches up at the start of the daemon, on a change of a file, and on a new listed directory.
 *
 * The same consent covers the live table of the session files of the machine (`SessionCatalog`) for the tool
 * `agents_running`: it reads the metadata and the tail of each session file, also outside the listed directories. The
 * index of the message text stays limited to the listed directories. One watch of each provider root serves both.
 * [catalog] gives the options of the live table, such as its own file system, clock and timers for a test.
 * [secrets] is an optional `KnownSecrets`: the filter of each text and title of the import removes its exact values too.
 */
export class SessionIndexService {
  constructor({ path, state, home, environment, sources = sessionSources({ home, environment }), fs = fileSystem, watch = watchFiles,
    clock = Date, debounceMs = 2000, catalog = {}, secrets } = {}) {
    Object.assign(this, { path, state, sources, fs, watch, clock, debounceMs, catalogOptions: catalog, secrets })
    this.on = false
    this.days = 0
    this.pending = { full: false, paths: new Set() }
    /** The sources with a root that appeared after the start. The next pass gives their files to the live table. */
    this.appeared = new Set()
    this.locks = new Map()
    this.watchers = []
    this.loop = undefined
    this.applying = Promise.resolve()
    this.progress = undefined
    this.directories = []
  }

  get enabled() { return this.on && Boolean(this.index) }

  /** The index file for the tools while the consent is on, else undefined. */
  get store() { return this.enabled ? this.index : undefined }

  /** The live table of the session files while the consent is on, else undefined. */
  get logs() { return this.enabled ? this.catalog : undefined }

  /** Takes the settings `sessions.index` and `sessions.days`. A change applies at once. Calls run one at a time. */
  apply(values) {
    const next = this.applying.then(async () => {
      const on = values['sessions.index'] === 'on'
      const days = values['sessions.days']
      if (!on) {
        if (this.on || this.index) await this.#stop()
        this.on = false
        // The user took the consent back, or never gave it, so no index file stays.
        await deleteSidecar(this.path)
        return
      }
      const changed = days !== this.days
      this.days = days
      // The consent counts as on only after a start that succeeded, so the next apply tries a failed start again.
      if (!this.on) { await this.#start(); return }
      if (changed) this.#request({ full: true })
    })
    this.applying = next.catch(() => {})
    return next
  }

  async #start() {
    this.lifetime = new AbortController()
    try {
      this.index = await SessionIndex.open(this.path, { secrets: this.secrets })
      const meta = await this.index.meta()
      this.firstPassAt = meta.firstPassAt ?? undefined
      this.announce = meta.announce === 1
      this.subscription = await this.state.watch()
      this.directories = directoriesOf(this.subscription.value)
      this.directoryKey = JSON.stringify(this.directories.map(directory => directory.cwd).sort())
      this.subscription.start(call => { if (call.kind === 'value') this.#observe(call.value) })
      this.catalog = new SessionCatalog({ index: this.index, sources: this.sources, fs: this.fs, clock: this.clock, secrets: this.secrets, ...this.catalogOptions })
      await this.catalog.start()
    }
    catch (error) {
      // A failed start keeps nothing open, so the next apply starts again from the beginning.
      this.lifetime.abort()
      await this.subscription?.stop().catch(() => {})
      this.subscription = undefined
      await this.catalog?.close().catch(() => {})
      this.catalog = undefined
      await this.index?.close().catch(() => {})
      this.index = undefined
      throw error
    }
    this.on = true
    for (const source of this.sources) this.#watchRoot(source)
    this.#request({ full: true })
  }

  async #stop() {
    this.lifetime?.abort()
    clearTimeout(this.timer)
    this.timer = undefined
    for (const watcher of this.watchers) watcher.close()
    this.watchers = []
    await this.subscription?.stop()
    this.subscription = undefined
    await this.loop?.catch(() => {})
    await Promise.allSettled([...this.locks.values()])
    await this.catalog?.close()
    this.catalog = undefined
    this.pending = { full: false, paths: new Set() }
    this.progress = undefined
    await this.index?.close()
    this.index = undefined
    await this.state.sessionsOff()
  }

  /** A new listed directory brings its old sessions, and a removed one takes its sessions out. */
  #observe(snapshot) {
    const directories = directoriesOf(snapshot)
    const key = JSON.stringify(directories.map(directory => directory.cwd).sort())
    this.directories = directories
    if (key === this.directoryKey) return
    this.directoryKey = key
    this.#request({ full: true })
  }

  /**
   * Watches the root of a source recursively. For a root that does not exist yet, it watches the nearest parent that
   * exists, without recursion. Each session file goes to the live table, and a file of a listed directory goes to the
   * import too. Gives true when the root has its watch.
   */
  #watchRoot(source) {
    let watcher
    try {
      watcher = this.watch(source.root, { recursive: true, persistent: false }, (_event, file) => {
        if (typeof file !== 'string' || !this.on) return
        if (source.matches(file)) this.catalog?.changed(join(source.root, file))
        if (!source.relevant(file, this.directories)) return
        this.pending.paths.add(join(source.root, file))
        this.timer ??= setTimeout(() => { this.timer = undefined; this.#request({}) }, this.debounceMs)
      })
    }
    catch { this.#watchParent(source); return false }
    watcher.on?.('error', () => {})
    this.watchers.push(watcher)
    return true
  }

  /**
   * Watches the nearest parent of a missing root that exists. When the next directory on the path to the root appears,
   * this watch closes and the root gets its watch again. A root that then exists gets a pass, which imports its files
   * and gives each session file of the root to the live table.
   */
  #watchParent(source) {
    let directory = dirname(source.root)
    for (;;) {
      const next = relative(directory, source.root).split(sep)[0]
      let watcher
      try {
        watcher = this.watch(directory, { persistent: false }, (_event, file) => {
          if (!this.on || typeof file === 'string' && file !== next) return
          watcher.close()
          this.watchers = this.watchers.filter(item => item !== watcher)
          if (!this.#watchRoot(source)) return
          this.appeared.add(source)
          this.#request({ full: true })
        })
      }
      catch {
        if (dirname(directory) === directory) return
        directory = dirname(directory)
        continue
      }
      watcher.on?.('error', () => {})
      this.watchers.push(watcher)
      return
    }
  }

  #request({ full = false }) {
    // A pass that failed runs again on the next request, such as a change of a session file.
    if (full || this.passFailed) { this.pending.full = true; this.passFailed = false }
    this.loop ??= this.#run().finally(() => { this.loop = undefined })
  }

  async #run() {
    while (this.enabled && !this.lifetime.signal.aborted && (this.pending.full || this.pending.paths.size)) {
      const { full, paths } = this.pending
      this.pending = { full: false, paths: new Set() }
      try {
        if (full) await this.#pass()
        else await this.#importPaths([...paths])
      }
      catch (error) {
        if (this.lifetime.signal.aborted) return
        logFailure('log.sessions', error)
        // A damaged file was made again, so the next pass imports each file again.
        if (this.index.damaged) { this.index.damaged = false; this.firstPassAt = undefined; this.pending.full = true; await pause() }
        else if (full) this.passFailed = true
      }
    }
  }

  /** Resolves when no import and no read of the live table runs or waits. A test uses it. */
  async idle() {
    await this.applying
    while (this.loop || this.timer) {
      await this.loop
      if (this.timer) await new Promise(resolve => setTimeout(resolve, this.debounceMs + 10))
    }
    await this.catalog?.idle()
  }

  get cutoff() { return this.days > 0 ? this.clock.now() - this.days * DAY_MS : -Infinity }

  #source(path) {
    return this.sources.find(source => !relative(source.root, path).startsWith('..') && relative(source.root, path) !== '')
  }

  /** The session files of the listed directories with their file data, without the files above the age limit. */
  async #candidates(directories) {
    const cutoff = this.cutoff
    const candidates = []
    for (const source of this.sources) {
      for (const file of await source.files(directories, this.fs)) {
        const stat = await this.fs.stat(file.path).catch(() => undefined)
        if (!stat?.isFile() || stat.mtimeMs < cutoff) continue
        candidates.push({ source, ...file, ...identity(stat) })
      }
    }
    return candidates
  }

  /**
   * The work of a file: none, a read of its new lines, or a new import. A file that the import could not read gets a
   * new try at a [retry]: a pass or a watch event of the file. A chmod changes no size and no modification time, so
   * only such a try finds a file that became readable again. A search does not try it again.
   */
  #needsWork(row, file, directories, retry = false) {
    if (!row) return true
    if (row.state === 'unreadable') return retry || row.ino !== file.ino || row.size !== file.size || Math.floor(file.mtimeMs) !== row.mtime_ms
    if (row.state === 'outside') return row.ino !== file.ino || row.cwd === null && row.size !== file.size || Boolean(row.cwd && directoryOf(row.cwd, directories))
    return row.ino !== file.ino || row.size !== file.size || Math.floor(file.mtimeMs) !== row.mtime_ms
  }

  /**
   * One pass over each session file of the listed directories. It removes the files that are gone, above the age
   * limit or out of the listed directories, and it reads the new data of each other file.
   */
  async #pass() {
    const signal = this.lifetime.signal
    for (const source of this.appeared) {
      this.appeared.delete(source)
      for (const { path } of await source.all(this.fs)) this.catalog?.changed(path)
    }
    const directories = directoriesOf(await this.state.snapshot())
    this.directories = directories
    const candidates = await this.#candidates(directories)
    const present = new Set(candidates.map(file => file.path))
    for (const row of await this.index.files()) {
      if (signal.aborted) return
      const gone = !present.has(row.path) || row.session != null && !directoryOf(row.cwd, directories)
      if (gone) { await this.#drop(row.path); await pause() }
    }
    const rows = new Map((await this.index.files()).map(row => [row.path, row]))
    const work = []
    for (const file of candidates) {
      const row = rows.get(file.path)
      // A file that the import could not read before it knew the session is a new file for the order of the pass.
      if (this.#needsWork(row, file, directories, true)) work.push({ ...file, row: row?.state === 'unreadable' && row.session == null ? undefined : row })
    }
    const first = this.firstPassAt === undefined
    const visible = first || work.length >= VISIBLE_PASS
    // A task ID of Air must be new, so the ID of a pass has the time and a count.
    this.passes = (this.passes ?? 0) + 1
    const passId = `${this.clock.now().toString(36)}-${this.passes}`
    let done = 0
    let step = -1
    const report = async () => {
      this.progress = { done, total: work.length, first }
      const next = work.length ? Math.floor(done / work.length * STEPS) : STEPS
      if (!visible || next === step || done === work.length) return
      step = next
      await this.state.sessionsTask({ id: `sessions:${passId}:${step}`, done, total: work.length })
    }
    try {
      await report()
      // A new file without a project in its path needs its `cwd` first, so the order can put the projects of an IDE first.
      const ordered = []
      for (const file of work) {
        if (signal.aborted) return
        if (!file.directory && !file.row) {
          try {
            file.cwd = (await this.#peek(file.source, file.path)) ?? null
            file.directory = file.cwd ? directoryOf(file.cwd, directories) : undefined
            if (!file.directory) await this.index.outside({ ...file, agent: file.source.agent }, file.cwd)
          }
          catch (error) { await this.#failed(file, error); file.directory = undefined }
          if (!file.directory) {
            done++
            await report()
            continue
          }
        }
        ordered.push(file)
      }
      const rank = file => ORIGIN_RANK[file.directory?.origin ?? (file.row?.cwd && directoryOf(file.row.cwd, directories)?.origin)] ?? 3
      ordered.sort((left, right) => rank(left) - rank(right) || right.mtimeMs - left.mtimeMs)
      for (const file of ordered) {
        if (signal.aborted) return
        try { await this.#import(file, directories, { signal, retry: true }) }
        catch (error) { await this.#failed(file, error) }
        done++
        await report()
      }
    }
    finally {
      this.progress = undefined
      // After a stop, the stop clears the task.
      if (visible && !signal.aborted) await this.state.sessionsTask(null)
    }
    if (first && !signal.aborted) {
      this.firstPassAt = this.clock.now()
      await this.index.markFirstPass(this.firstPassAt)
      if (this.announce) await this.state.sessionsIndexed(await this.#summary(passId, directories))
      this.announce = false
    }
  }

  /** Imports the files that a watch named. A file that is gone leaves the index. */
  async #importPaths(paths) {
    const directories = this.directories
    for (const path of paths) {
      if (this.lifetime.signal.aborted) return
      const source = this.#source(path)
      if (!source) continue
      const stat = await this.fs.stat(path).catch(() => undefined)
      if (!stat?.isFile() || stat.mtimeMs < this.cutoff) {
        if (await this.index.file(path)) await this.#drop(path)
        // Codex replaces a plain session file with its compressed file, and back. The other form then has the session.
        const sibling = source.sibling?.(path)
        if (sibling && !paths.includes(sibling) && (await this.fs.stat(sibling).catch(() => undefined))?.isFile()) this.pending.paths.add(sibling)
        continue
      }
      const file = { source, path, ...identity(stat) }
      try { await this.#import(file, directories, { signal: this.lifetime.signal, retry: true }) }
      catch (error) { await this.#failed(file, error) }
    }
  }

  /**
   * Records a file that the import could not read, for example a file without the read permission, so the import
   * reads it again after a change of the file, at the next pass and at a watch event of the file, and not before each
   * search. The log names only the agent. A stop or a damaged index file ends the pass.
   */
  async #failed(file, error) {
    if (this.lifetime.signal.aborted || this.index.damaged) throw error
    logFailure('log.sessions.file', error, file.source.agent)
    // A file in the index keeps its entries and its offset, so its next import reads only the lines after the offset.
    await this.index.unreadable({ ...file, agent: file.source.agent }).catch(() => {})
  }

  /**
   * Deletes the entries of a file and its import state. Another file of the same session can hold a copy of an entry
   * that the index kept only for this file, as after a move of the file to the archive. So each other file of the
   * session gets a new import from its start, and the import adds the entries that went away.
   */
  async #drop(path) {
    const others = await this.index.dropFile(path, pause)
    for (const other of others) this.pending.paths.add(other)
    if (others.length) this.#request({})
  }

  /** Runs one import of a file at a time. A second import of the same file waits for the first one. */
  async #import(file, directories, options) {
    while (this.locks.has(file.path)) await this.locks.get(file.path).catch(() => {})
    const work = this.#importFile(file, directories, options)
    this.locks.set(file.path, work)
    try { return await work }
    finally { this.locks.delete(file.path) }
  }

  /** Reads the first lines of a file until the session tells its `cwd`. */
  async #peek(source, path) {
    for await (const batch of readLines(this.fs, path, { end: PEEK_BYTES, batchLines: 8, compressed: isCompressed(path) })) {
      for (const line of batch.lines) {
        const cwd = this.#parse(source, line, path)?.meta?.cwd
        if (cwd) return cwd
      }
    }
    return undefined
  }

  /**
   * True when a file that the import read to its end is smaller now, or has the same size and another modification
   * time. A writer of a session file only adds lines, so the same size with a new time means a rewrite in place, also
   * of bytes before the last [TAIL_BYTES] that the hash of the tail does not cover. A `touch` also gives a new import.
   * A file of the size -1 has an import that did not reach its end, and only the hash of the tail tells a rewrite.
   */
  #rewritten(row, file) {
    return row.size >= 0 && (file.size < row.size || file.size === row.size && Math.floor(file.mtimeMs) !== row.mtime_ms)
  }

  /** A hash of the [TAIL_BYTES] bytes before [offset], or null at the start of the file. */
  async #tail(path, offset) {
    if (offset <= 0) return null
    const length = Math.min(TAIL_BYTES, offset)
    const handle = await this.fs.open(path, 'r')
    try {
      const buffer = Buffer.alloc(length)
      const { bytesRead } = await handle.read(buffer, 0, length, offset - length)
      return createHash('sha256').update(buffer.subarray(0, bytesRead)).digest('base64url').slice(0, 22)
    }
    finally { await handle.close() }
  }

  #parse(source, line, path) {
    let value
    try { value = JSON.parse(line) }
    catch { return undefined }
    return value && typeof value === 'object' && !Array.isArray(value) ? source.parse(value, line, path) : undefined
  }

  /**
   * Imports the new complete lines of one file. A smaller file or another inode means a truncation or a rotation, and
   * other bytes before the offset mean a rewrite in place: the import then takes the whole file again. A compressed
   * file gets no new lines, so each change of it makes a new import of the whole file. Of the two forms of one session
   * file, the import takes the form that the agent reads first, and the other form leaves the index. Gives false when
   * [deadline] or a stop ended the import before the end.
   */
  async #importFile(file, directories, { signal, deadline, retry = false }) {
    const { source, path } = file
    const agent = source.agent
    const stat = await this.fs.stat(path).catch(() => undefined)
    if (!stat?.isFile()) return true
    Object.assign(file, identity(stat))
    const sibling = source.sibling?.(path)
    if (sibling) {
      if (source.prefers(sibling) && (await this.fs.stat(sibling).catch(() => undefined))?.isFile()) {
        if (await this.index.file(path)) await this.#drop(path)
        return true
      }
      if (await this.index.file(sibling)) await this.#drop(sibling)
    }
    const compressed = isCompressed(path)
    let row = await this.index.file(path)
    if (row && !this.#needsWork(row, file, directories, retry)) return true
    // A file that the import could not read before it knew the session is a new file.
    if (row?.state === 'unreadable' && row.session == null) row = undefined
    if (row?.state === 'outside') {
      if (row.ino === file.ino && row.cwd && !directoryOf(row.cwd, directories)) { await this.index.touch({ ...file, agent }); return true }
      row = undefined
    }
    if (row && (compressed || row.ino !== file.ino || file.size < row.offset || this.#rewritten(row, file)
      || await this.#tail(path, row.offset) !== row.tail)) {
      await this.#drop(path)
      row = undefined
    }
    let meta
    if (row) meta = { ...(await this.index.sessionOf(row.session)) }
    else {
      const cwd = file.cwd !== undefined ? file.cwd : await this.#peek(source, path)
      if (!cwd || !directoryOf(cwd, directories)) { await this.index.outside({ ...file, agent }, cwd ?? null); return true }
      meta = { cwd }
    }
    // The size of a file is stored only after the import reached its end, so a stopped import continues later.
    const partial = { ...file, agent, size: -1, tail: row?.tail ?? null }
    let offset = row?.offset ?? 0
    // The size of a compressed file is no size of its text, so its reader reads to the end of the text.
    for await (const batch of readLines(this.fs, path, { start: offset, end: compressed ? undefined : file.size, batchBytes: BATCH_BYTES,
      batchLines: BATCH_LINES, compressed })) {
      const entries = []
      for (const line of batch.lines) {
        const parsed = this.#parse(source, line, path)
        if (!parsed) continue
        const found = parsed.meta ?? {}
        meta.sessionId ??= found.sessionId
        meta.startedAt ??= found.startedAt
        if (found.title !== undefined && !(meta.titleRank > found.titleRank)) Object.assign(meta, { title: found.title, titleRank: found.titleRank })
        if (parsed.entry) entries.push({ ...parsed.entry, ...indexedText(parsed.entry.text, this.secrets) })
      }
      meta.sessionId ??= nameOf(path)
      partial.tail = compressed ? null : await this.#tail(path, batch.end)
      await this.index.write(partial, meta, entries, batch.end)
      while (await this.index.mergeStep()) await pause()
      delete meta.title
      delete meta.titleRank
      offset = batch.end
      await pause()
      if (signal?.aborted || deadline !== undefined && this.clock.now() > deadline) return false
    }
    meta.sessionId ??= nameOf(path)
    if (offset === (row?.offset ?? 0)) await this.index.write(partial, meta, [], offset)
    await this.index.touch({ ...file, agent })
    return true
  }

  /** The summary of the first pass for the main agent: the counts, and the last unfinished sessions. */
  async #summary(passId, directories) {
    const sessions = await this.index.sessions()
    const agents = { claude: 0, codex: 0, pi: 0 }
    const projects = new Set()
    let entries = 0
    for (const session of sessions) {
      agents[session.agent] = (agents[session.agent] ?? 0) + 1
      entries += session.entry_count
      const directory = directoryOf(session.cwd, directories)
      if (directory) projects.add(directory.cwd)
    }
    // A session that did not end with a reply of the agent is unfinished: the last entry is a prompt or a tool step.
    const unfinished = sessions.filter(session => session.last_kind && session.last_kind !== 'assistant').slice(0, SUMMARY_UNFINISHED)
      .map(session => ({ agent: session.agent, sessionId: session.session_id, title: session.title ?? null, cwd: session.cwd,
        updatedAt: new Date(session.updated_at).toISOString() }))
    return { passId, sessions: sessions.length, projects: projects.size, entries, agents, unfinished }
  }

  /**
   * Imports the new data of the files of [cwd] before a search, at most for a short time. During the first pass, the
   * pass imports them. Gives true when the index is complete for [cwd].
   */
  async catchUp(cwd) {
    if (!this.enabled) return false
    if (this.firstPassAt === undefined) return false
    const signal = this.lifetime.signal
    const deadline = this.clock.now() + SEARCH_BUDGET_MS
    const directories = this.directories
    const listed = directories.filter(directory => directory.cwd === cwd || directory.cwd.startsWith(`${cwd}${sep}`))
    const scope = listed.length ? listed : [{ cwd, origin: 'known' }]
    for (const file of await this.#candidates(scope)) {
      if (signal.aborted || this.clock.now() > deadline) return false
      const row = await this.index.file(file.path)
      // A Codex file names no project in its path, so only a file of this directory or a new file counts.
      if (row && row.cwd && !scope.some(directory => directoryOf(row.cwd, [directory]))) continue
      if (!this.#needsWork(row, file, directories)) continue
      if (!await this.#import(file, directories, { signal, deadline })) return false
    }
    return true
  }

  /** The state of the index for the tools: off, importing or ready, and the progress of a pass. */
  async status() {
    if (!this.enabled) return { state: 'off' }
    const counts = await this.index.counts().catch(() => undefined)
    return { state: this.firstPassAt === undefined ? 'importing' : 'ready', ...(counts ?? {}),
      ...(this.progress ? { progress: { done: this.progress.done, total: this.progress.total } } : {}) }
  }

  async close() {
    await this.applying
    if (this.on || this.index) {
      this.lifetime?.abort()
      clearTimeout(this.timer)
      for (const watcher of this.watchers) watcher.close()
      await this.subscription?.stop()
      await this.loop?.catch(() => {})
      await Promise.allSettled([...this.locks.values()])
      await this.catalog?.close()
      this.catalog = undefined
      await this.index?.close()
      this.index = undefined
      this.on = false
    }
  }
}

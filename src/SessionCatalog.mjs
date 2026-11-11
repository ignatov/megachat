import * as fileSystem from 'node:fs/promises'
import { relative } from 'node:path'
import { logFailure } from './messages.mjs'
import { parseLine, readLines, timeOf } from './SessionLog.mjs'
import { readBackward } from './SessionTail.mjs'

const HOUR_MS = 3600000
/**
 * The interval of the size poll. macOS reports a write to a file only when the file closes, and Codex keeps its
 * session file open. So a poll of the size finds a write of an open file 0 to 2 seconds after it.
 */
export const POLL_MS = 2000
/** Only a file with a write in this time gets the size poll: an older file belongs to no running session or to an idle one. */
export const POLL_WINDOW_MS = HOUR_MS
/** The first pass reads the files with a change in this time first, because they hold the running sessions. */
export const RECENT_MS = 24 * HOUR_MS
/** The bytes at the end of a file that give the last step and the title. */
export const TAIL_BYTES = 64 * 1024
/** A tail without a step reads more lines backwards, at most this count of bytes. One tool result can be a large line. */
export const TAIL_LIMIT = 1024 * 1024
/** The bytes at the start of a file that give the session data. The first line of a Codex file has about 22 KB. */
const HEAD_BYTES = 1024 * 1024
/** An append of more bytes reads the tail again, and not each new line. */
const APPEND_LIMIT = 4 * TAIL_BYTES

/** Gives the event loop to other work between two files of a pass. */
const pause = () => new Promise(resolve => setImmediate(resolve))

const fromRow = row => ({ path: row.path, agent: row.agent, ino: row.ino, size: row.size, offset: row.offset, sessionId: row.session_id ?? undefined,
  cwd: row.cwd ?? undefined, title: row.title ?? undefined, titleRank: row.title_rank ?? undefined, startedAt: row.started_at ?? undefined,
  mtimeMs: row.last_write_at, step: row.last_step ?? undefined, read: true, error: false })

/**
 * The live table of the session files of Claude Code, Codex and pi on the machine, for the tool `agents_running`. It
 * exists only with the consent of the user, the setting `sessions.index`. For each file it keeps the path, the inode,
 * the size, the byte offset of the read, the agent, the session ID, the `cwd`, the title, the start time, the time of
 * the last write and the last step, and no message text. `sessions.sqlite` keeps the table, so a restart answers at
 * once. A query reads the memory.
 *
 * The first pass reads the head and the tail of each file: the files with a change in the last 24 hours first, the
 * newest first, and then the other files. After it, the table reads a file on a change event of the watch of the
 * provider roots, and a size poll every 2 seconds finds a write to a file that stays open. A read takes only the
 * appended lines. A smaller file or another inode means that the file is read again. Each file opens read-only.
 */
export class SessionCatalog {
  constructor({ index, sources, fs = fileSystem, clock = Date, timers = globalThis, pollMs = POLL_MS }) {
    Object.assign(this, { index, sources, fs, clock, timers, pollMs })
    this.records = new Map()
    this.locks = new Map()
    this.queue = new Set()
    this.progress = { done: 0, total: 0, recent: false, complete: false }
  }

  async start() {
    for (const row of await this.index.logs()) this.records.set(row.path, fromRow(row))
    this.lifetime = new AbortController()
    this.timer = this.timers.setInterval(() => { this.#poll().catch(error => logFailure('log.sessions', error)) }, this.pollMs)
    this.timer?.unref?.()
    this.passing = this.#pass().catch(error => { if (!this.lifetime.signal.aborted) logFailure('log.sessions', error) })
  }

  async close() {
    this.lifetime?.abort()
    this.timers.clearInterval(this.timer)
    await this.passing
    await this.draining
    await this.polling
    await Promise.allSettled([...this.locks.values()])
  }

  /** Resolves when no pass, read or poll runs. A test uses it. */
  async idle() {
    while (this.draining || this.polling || this.locks.size || this.queue.size) {
      await this.passing
      await this.draining
      await this.polling
      await Promise.allSettled([...this.locks.values()])
    }
    await this.passing
  }

  source(agent) { return this.sources.find(source => source.agent === agent) }

  #sourceOf(path) {
    return this.sources.find(source => {
      const part = relative(source.root, path)
      return part && !part.startsWith('..') && source.matches(part)
    })
  }

  /** The record of a file, or undefined. A record with `read` false has only the data of the file name and its stat. */
  get(path) { return this.records.get(path) }

  /** Each record of [agent]. */
  * of(agent) { for (const record of this.records.values()) if (record.agent === agent) yield record }

  /** The newest record of the session [sessionId] of [agent], also before its first read: the file name tells the ID. */
  session(agent, sessionId) {
    let found
    for (const record of this.of(agent)) {
      if ((record.sessionId ?? record.nameId) === sessionId && (!found || record.mtimeMs > found.mtimeMs)) found = record
    }
    return found
  }

  /** Reads the file at [path] now when the table has no read of it. Gives its record or undefined. */
  async ensure(path) {
    if (!this.records.get(path)?.read) await this.read(path)
    return this.records.get(path)
  }

  /** The session of a running process from a process file of its agent, such as Claude Code writes, or undefined. */
  async processSession(agent, pid, startedAt) {
    return this.source(agent)?.processSession?.(pid, startedAt, this.fs)
  }

  /** Takes a change event of the watch of a provider root. The file is read soon, one read at a time. */
  changed(path) {
    if (!this.lifetime || this.lifetime.signal.aborted || !this.#sourceOf(path)) return
    this.queue.add(path)
    this.draining ??= this.#drain().finally(() => { this.draining = undefined })
  }

  async #drain() {
    while (this.queue.size && !this.lifetime.signal.aborted) {
      const [path] = this.queue
      this.queue.delete(path)
      await this.read(path).catch(error => logFailure('log.sessions', error))
    }
  }

  /** Stats each file with a write in the last hour. A file with another size or inode is read. */
  #poll() {
    if (this.polling) return this.polling
    this.polling = (async () => {
      const since = this.clock.now() - POLL_WINDOW_MS
      for (const record of [...this.records.values()]) {
        if (this.lifetime.signal.aborted) return
        if (!record.read || !(record.mtimeMs >= since)) continue
        const stat = await this.fs.stat(record.path).catch(() => undefined)
        if (!stat || String(stat.ino) !== record.ino || stat.size !== record.size) this.changed(record.path)
      }
    })().finally(() => { this.polling = undefined })
    return this.polling
  }

  /**
   * The first pass: each session file of each source. A file that is gone leaves the table. The files with a change in
   * the last 24 hours come first, the newest first. A file with the size and the inode of its record is not read again.
   */
  async #pass() {
    const signal = this.lifetime.signal
    const found = []
    for (const source of this.sources) {
      for (const { path } of await source.all(this.fs)) {
        if (signal.aborted) return
        const stat = await this.fs.stat(path).catch(() => undefined)
        if (stat?.isFile()) found.push({ source, path, stat })
      }
    }
    const present = new Set(found.map(file => file.path))
    for (const path of [...this.records.keys()]) if (!present.has(path)) await this.#drop(path)
    for (const { source, path, stat } of found) {
      if (!this.records.has(path)) this.records.set(path, { path, agent: source.agent, nameId: source.nameId(path), mtimeMs: stat.mtimeMs, read: false })
    }
    const recent = this.clock.now() - RECENT_MS
    const newest = (left, right) => right.stat.mtimeMs - left.stat.mtimeMs
    const first = found.filter(file => file.stat.mtimeMs >= recent).sort(newest)
    const rest = found.filter(file => file.stat.mtimeMs < recent).sort(newest)
    this.progress = { done: 0, total: found.length, recent: !first.length, complete: false }
    for (const file of [...first, ...rest]) {
      if (signal.aborted) return
      await this.read(file.path, file.stat).catch(error => logFailure('log.sessions', error))
      this.progress.done++
      if (this.progress.done >= first.length) this.progress.recent = true
      await pause()
    }
    this.progress.recent = true
    this.progress.complete = true
  }

  async #drop(path) {
    this.records.delete(path)
    await this.index.dropLog(path)
  }

  /** Reads the new data of one file. Two reads of one file run one after the other. */
  async read(path, stat) {
    while (this.locks.has(path)) await this.locks.get(path).catch(() => {})
    const work = this.#read(path, stat)
    this.locks.set(path, work)
    try { return await work }
    finally { this.locks.delete(path) }
  }

  async #read(path, known) {
    const source = this.#sourceOf(path)
    if (!source) return
    let stat = known
    try { stat ??= await this.fs.stat(path) }
    catch (error) {
      if (error.code === 'ENOENT') await this.#drop(path)
      else this.#failed(path, source)
      return
    }
    if (!stat.isFile()) { await this.#drop(path); return }
    const ino = String(stat.ino)
    const old = this.records.get(path)
    if (old?.read && !old.error && old.ino === ino && old.size === stat.size && Math.floor(old.mtimeMs) === Math.floor(stat.mtimeMs)) return
    let record
    try {
      record = old?.read && !old.error && old.ino === ino && stat.size >= old.size && stat.size - old.offset <= APPEND_LIMIT
        ? await this.#append(source, old, stat)
        : await this.#full(source, path, stat, old?.read && old.ino === ino && stat.size >= old.size ? old : undefined)
    }
    catch (error) {
      if (error.code === 'ENOENT') { await this.#drop(path); return }
      this.#failed(path, source)
      return
    }
    Object.assign(record, { path, agent: source.agent, nameId: source.nameId(path), ino, size: stat.size, mtimeMs: stat.mtimeMs, read: true, error: false })
    this.records.set(path, record)
    await this.index.saveLog(record)
  }

  /** Marks a file that Megachat cannot read, so the tool names it in `incomplete`. */
  #failed(path, source) {
    const old = this.records.get(path)
    this.records.set(path, { ...(old ?? { path, agent: source.agent, nameId: source.nameId(path) }), error: true })
  }

  /** Takes the data of one parsed line into [record]. A newer title of the same rank replaces an older one. */
  #take(record, item, { newer }) {
    const { value, parsed } = item
    const meta = parsed.meta ?? {}
    record.sessionId ??= meta.sessionId
    record.cwd ??= meta.cwd
    record.startedAt ??= meta.startedAt ?? timeOf(value.timestamp)
    if (meta.title !== undefined && (record.titleRank === undefined || meta.titleRank > record.titleRank || newer && meta.titleRank === record.titleRank))
      Object.assign(record, { title: meta.title, titleRank: meta.titleRank })
  }

  /** Reads the appended complete lines after the offset of [old]. */
  async #append(source, old, stat) {
    const record = { ...old }
    for await (const batch of readLines(this.fs, old.path, { start: old.offset, end: stat.size })) {
      for (const line of batch.lines) {
        const item = parseLine(source, line, old.path)
        if (!item) continue
        this.#take(record, item, { newer: true })
        if (item.parsed.step) record.step = item.parsed.step
      }
      record.offset = batch.end
    }
    return record
  }

  /**
   * Reads a file from its head and its tail. The head gives the session data that the first lines hold, and the tail
   * gives the last step and the newest title. [old] keeps its title when the file is the same file.
   */
  async #full(source, path, stat, old) {
    const record = old ? { sessionId: old.sessionId, cwd: old.cwd, startedAt: old.startedAt, title: old.title, titleRank: old.titleRank } : {}
    for await (const batch of readLines(this.fs, path, { end: Math.min(stat.size, HEAD_BYTES), chunkBytes: TAIL_BYTES, batchLines: 8 })) {
      for (const line of batch.lines) {
        const item = parseLine(source, line, path)
        if (item) this.#take(record, item, { newer: true })
      }
      if (record.cwd && record.startedAt !== undefined && (record.sessionId || source.agent === 'claude')) break
    }
    // The tail comes newest first, so only a title of a higher rank replaces one that the tail gave already.
    const tail = {}
    let offset
    let step
    let whole = true
    for await (const { line, start, end, cut } of readBackward(this.fs, path, { end: stat.size, budget: TAIL_LIMIT })) {
      // Without a complete line in the read part, the next read starts at the end of the file.
      offset ??= cut ? stat.size : end
      if (cut) { whole = false; break }
      const item = line ? parseLine(source, line, path) : undefined
      if (item) {
        step ??= item.parsed.step
        this.#take(tail, item, { newer: false })
      }
      const bytes = stat.size - start
      if (bytes >= TAIL_LIMIT || bytes >= TAIL_BYTES && step) { whole = false; break }
    }
    // A log without a step in each of its lines has no turn yet: the session waits for its first message.
    if (!step && whole) step = 'none'
    if (tail.title !== undefined && !(record.titleRank > tail.titleRank)) Object.assign(record, { title: tail.title, titleRank: tail.titleRank })
    record.cwd ??= tail.cwd
    record.sessionId ??= tail.sessionId
    return Object.assign(record, { offset: offset ?? 0, step })
  }
}

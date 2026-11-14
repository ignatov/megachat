import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { appendFile, chmod, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { message, MegachatError, requireCondition } from './messages.mjs'
import { OPEN_STEPS } from './SessionStatus.mjs'
import { parseLine, readLines } from './SessionLog.mjs'
import { indexedText } from './SessionText.mjs'

const execute = promisify(execFile)

/** The prefix that Air puts before the title of an archived session: `AGENT_SESSION_ARCHIVED_THREAD_TITLE_PREFIX` of Air. */
export const ARCHIVED_TITLE_PREFIX = '[archived] '
/** The longest title that Claude Code keeps: `CLAUDE_CLI_THREAD_TITLE_LIMIT` of Air. */
export const TITLE_CAP = 200
export const ARCHIVE_FILE = 'session-archive.jsonl'
export const ARCHIVE_MAX_SESSIONS = 50
export const PAGE_LIMIT = 20
export const EXIT_WAIT_MS = 10000
/** A Codex row with a log write in this time is refused: Codex writes no record of a permission request. */
export const CODEX_QUIET_MS = 10 * 60 * 1000
/** A row with a log write in this time gets a warning. */
export const RECENT_MS = 60 * 60 * 1000
const STATUSES_REFUSED = new Set(['working', 'stuck', 'waiting_for_permission'])
const OWNERS_STOPPED = new Set(['terminal', 'multiplexer'])
const HELPERS = /mcp|helper|caffeinate/i
const TICKET = /\b([A-Z][A-Z0-9]{1,9}-\d{1,6})\b/g
const NOT_TICKETS = new Set(['UTF-8', 'UTF-16', 'SHA-1', 'SHA-256', 'SHA-512', 'ISO-8601', 'TLS-1', 'AES-128', 'AES-256', 'MD-5', 'RFC-2119'])
const GITHUB = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+/g
const COMMIT = /\[[^\]\s]+(?: \(root-commit\))? ([0-9a-f]{7,40})\]/g
const PUSH = /\b[0-9a-f]{7,40}\.\.([0-9a-f]{7,40})\s+\S+ -> /g
const EDIT_CALL = /^(?:Edit|Write|MultiEdit|NotebookEdit|edit|write)\b/
const EDIT_PATH = /"(?:file_path|notebook_path|path)":\s?"((?:[^"\\]|\\.)+)"/g
const PATCH_PATH = /\*\*\* (?:Update|Add) File: (\S[^\n]*)/g
const RUN_ENDED = new Set(['completed', 'failed', 'cancelled', 'stopped', 'abandoned'])

/** The title as Air normalizes it: each run of white space is one space, trimmed. `undefined` for an empty title. */
const normalized = text => {
  const value = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : ''
  return value || undefined
}
const defaultTitle = sessionId => `Session ${String(sessionId).slice(0, 8)}`
const cap = title => title.length <= TITLE_CAP ? title : title.slice(0, TITLE_CAP).trim()
export const isArchivedTitle = title => typeof title === 'string' && title.startsWith(ARCHIVED_TITLE_PREFIX)
/** The title without the prefix, with the default title for an empty one: `resolveAgentThreadArchivedTitleState` of Air. */
export const visibleTitle = (title, sessionId) =>
  normalized(isArchivedTitle(title) ? title.slice(ARCHIVED_TITLE_PREFIX.length) : title) ?? defaultTitle(sessionId)
/** The title that Air stores for an archived session. The cap counts the prefix, as Air does. */
export const archivedTitle = (title, sessionId) => cap(ARCHIVED_TITLE_PREFIX + visibleTitle(title, sessionId))
/** The title that Air stores after a Reopen. */
export const restoredTitle = (title, sessionId) => cap(visibleTitle(title, sessionId))

/** The command that continues a session. */
export const resumeCommand = (agent, sessionId) => agent === 'claude' ? `claude --resume ${sessionId}`
  : agent === 'codex' ? `codex resume ${sessionId}` : `pi --session ${sessionId}`

/** The bytes of the title records of Claude Code, as Air writes them: `custom-title`, then `agent-name`. */
const claudeRecords = (sessionId, title) => [['custom-title', 'customTitle'], ['agent-name', 'agentName']]
  .map(([type, field]) => `${JSON.stringify({ type, [field]: title, sessionId })}\n`).join('')

/** The title state of a log from its last 256 KB: `{ archived, title }`, or undefined for a log without a title record. */
export async function titleState(agent, path, fs) {
  const handle = await fs.open(path, 'r')
  let text
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, 256 * 1024)
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, size - length)
    text = buffer.toString('utf8')
  }
  finally { await handle.close() }
  let agentName
  let customTitle
  let info
  for (const line of text.split('\n')) {
    if (!line.includes('"type"')) continue
    let value
    try { value = JSON.parse(line) } catch { continue }
    if (agent === 'claude' && value?.type === 'agent-name' && typeof value.agentName === 'string' && value.agentName.trim()) agentName = value.agentName
    if (agent === 'claude' && value?.type === 'custom-title' && typeof value.customTitle === 'string' && value.customTitle.trim()) customTitle = value.customTitle
    if (agent === 'pi' && value?.type === 'session_info' && typeof value.name === 'string' && value.name.trim()) info = value.name
  }
  // Air ranks the last agent name before the last custom title.
  const title = agent === 'claude' ? agentName ?? customTitle : info
  return title === undefined ? undefined : { archived: isArchivedTitle(title), title }
}

/** The IDs of the entries of a pi log, and the last one, for the new `session_info` line. */
async function piEntries(path) {
  const ids = new Set()
  let leaf = null
  for (const line of (await readFile(path, 'utf8')).split('\n')) {
    if (!line.includes('"id"')) continue
    try {
      const value = JSON.parse(line)
      if (value?.type !== 'session' && typeof value?.id === 'string') { ids.add(value.id); leaf = value.id }
    } catch { /* A broken line is no entry. */ }
  }
  return { ids, leaf }
}

/**
 * Writes the title records of an archive or a restore, as Air does, to the log of a session that no process runs.
 * Claude Code: a `custom-title` and an `agent-name` line in one append, and the sidecar `custom-title.json` only when it
 * exists. pi: one `session_info` line. Writes nothing when the state and the title already match, and gives `false` then.
 * [title] is the title that the index knows, for a log without a title record.
 */
export async function writeTitle({ agent, path, sessionId, archive, title, now = Date.now() }, fs) {
  requireCondition(agent === 'claude' || agent === 'pi')
  requireCondition(/^[^/\\]+$/.test(String(sessionId)))
  const current = await titleState(agent, path, fs)
  const next = archive ? archivedTitle(current?.title ?? title, sessionId) : restoredTitle(current?.title ?? title, sessionId)
  if (current ? current.title === next : !archive) return false
  if (agent === 'claude') {
    await appendFile(path, claudeRecords(sessionId, next), { flag: 'a' })
    const sidecar = join(dirname(path), String(sessionId), 'custom-title.json')
    if ((await stat(sidecar).catch(() => undefined))?.isFile()) {
      const temporary = `${sidecar}.tmp.${randomBytes(8).toString('hex')}`
      await writeFile(temporary, JSON.stringify({ customTitle: next }), { mode: 0o600 })
      await rename(temporary, sidecar)
    }
    return true
  }
  const { ids, leaf } = await piEntries(path)
  let id
  do { id = randomBytes(4).toString('hex') } while (ids.has(id))
  await appendFile(path, `${JSON.stringify({ type: 'session_info', id, parentId: leaf, timestamp: new Date(now).toISOString(), name: next })}\n`, { flag: 'a' })
  return true
}

/** The cards of `session-archive.jsonl`: an append-only file. A line with `update` changes the card with its ID and time. */
export class ArchiveCards {
  /** A service without a state directory (a test) has no file: it reads no card and refuses to write one. */
  constructor(directory) { this.path = directory ? join(directory, ARCHIVE_FILE) : undefined }

  async append(value) {
    requireCondition(this.path, 'archiveState')
    await mkdir(dirname(this.path), { recursive: true })
    await appendFile(this.path, `${JSON.stringify(value)}\n`, { mode: 0o600 })
    await chmod(this.path, 0o600)
  }

  /** Each card with its updates, the newest first. */
  async all() {
    let text
    try { text = await readFile(this.path ?? '', 'utf8') } catch { return [] }
    const cards = new Map()
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let value
      try { value = JSON.parse(line) } catch { continue }
      const key = `${value.agent}:${value.sessionId}:${value.archivedAt}`
      if (value.update) { if (cards.has(key)) Object.assign(cards.get(key), value.update); continue }
      cards.set(key, value)
    }
    return [...cards.values()].sort((left, right) => right.archivedAt.localeCompare(left.archivedAt))
  }

  async update(card, update) { await this.append({ update, agent: card.agent, sessionId: card.sessionId, archivedAt: card.archivedAt }) }

  /** One page, with a cursor that is the count of the cards before it. [query] must match each word in the text of a card. */
  async page({ query, cursor, limit = PAGE_LIMIT } = {}) {
    const start = cursor === undefined ? 0 : Number(cursor)
    requireCondition(Number.isSafeInteger(start) && start >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100)
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean)
    const found = (await this.all()).filter(card => {
      if (!words.length) return true
      const text = [card.title, card.firstPrompt, card.lastPrompt, card.lastReply, card.cwd, ...(card.tickets ?? []), ...(card.files ?? []), ...(card.commits ?? [])]
        .filter(Boolean).join('\n').toLowerCase()
      return words.every(word => text.includes(word))
    })
    return { cards: found.slice(start, start + limit), nextCursor: start + limit < found.length ? String(start + limit) : null }
  }
}

const systemClock = { now: () => Date.now() }
const systemSleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const defaultGit = async (args, cwd) => {
  try { return (await execute('git', args, { cwd, timeout: 5000, maxBuffer: 1024 * 1024 })).stdout } catch { return undefined }
}
const defaultCodex = async args => { await execute('codex', args, { timeout: 30000 }) }
const iso = time => Number.isFinite(time) ? new Date(time).toISOString() : null

/**
 * The tool `agents_archive`: it archives agent sessions, as the action Done of Air does, and it keeps a card of each
 * one. The order for a row (see the design of the change `session-archive`): the checks, the card, the stop of the
 * process (only for the owner `terminal` or `multiplexer`, and an orphan), a wait for its end, the hide. The hide is the
 * title record that Air writes for Claude Code and pi, and `codex archive` for Codex. The dialog is the one of
 * `agents_stop`: only the answer `archive` of the user starts the steps. The checks run again after the answer.
 */
export class SessionArchive {
  constructor({ state, running, stopper, catalog, directory, codexArchive, fs, secrets, clock = systemClock, sleep = systemSleep, git = defaultGit, codex = defaultCodex, exitWaitMs = EXIT_WAIT_MS }) {
    Object.assign(this, { state, running, stopper, catalog, codexArchive, fs, secrets, clock, sleep, git, codex, exitWaitMs })
    this.cards = new ArchiveCards(directory)
  }

  async call({ action, sessions, query, cursor, ...other } = {}, { abortSignal } = {}) {
    requireCondition(Object.keys(other).length === 0)
    requireCondition(['archive', 'restore', 'list', 'search'].includes(action))
    if (action === 'list' || action === 'search') {
      requireCondition(action === 'list' ? query === undefined : typeof query === 'string' && query.trim() && query.length <= 200)
      return this.cards.page({ query, cursor })
    }
    requireCondition(Array.isArray(sessions) && sessions.length >= 1 && sessions.length <= ARCHIVE_MAX_SESSIONS)
    requireCondition(sessions.every(item => item && ['claude', 'codex', 'pi'].includes(item.agent) && typeof item.sessionId === 'string' && /^[\w.:-]{1,100}$/.test(item.sessionId)))
    requireCondition(new Set(sessions.map(item => `${item.agent}:${item.sessionId}`)).size === sessions.length)
    const catalog = this.catalog()
    if (!catalog) throw new MegachatError('archiveConsent')
    return action === 'archive' ? this.archive(sessions, catalog, abortSignal) : this.restore(sessions, catalog)
  }

  /** The log record of a session from the live table, read now. */
  async record(catalog, { agent, sessionId }) {
    const known = catalog.session(agent, sessionId)
    return known ? (await catalog.ensure(known.path)) ?? known : undefined
  }

  /** The live rows of a session now, with the owner of each process, from one read of the table. */
  async processes(agent, sessionId) {
    const view = await this.running.view()
    const processes = await this.running.table.processes()
    const owners = this.stopper.sessions(processes, await this.state.snapshot())
    return { rows: view.rows.filter(row => row.agent === agent && row.sessionId === sessionId), processes, owners, view }
  }

  /**
   * The row of a session for the dialog: `{ item, record, live, notes, action, warnings }`, or `{ item, refused }` with
   * the reason that the model gives to the user, or `{ item, skipped }` for a session that is archived already.
   */
  async prepare(item, catalog) {
    const record = await this.record(catalog, item)
    if (!record?.path) return { item, refused: message('archive.refused.unknown', item.agent, item.sessionId) }
    const now = this.clock.now()
    if (await this.archivedState(item.agent, { ...record, sessionId: item.sessionId })) return { item, record, skipped: message('archive.skipped.already') }
    const { rows, processes, owners, view } = await this.processes(item.agent, item.sessionId)
    const snapshot = await this.state.snapshot()
    if (Object.values(snapshot.runs).some(run => run.providerSessionId === item.sessionId && run.agent === item.agent && !RUN_ENDED.has(run.status)))
      return { item, refused: message('archive.refused.run') }
    const live = rows.filter(row => row.pid)
    for (const row of live) {
      if (STATUSES_REFUSED.has(row.status) || OPEN_STEPS.has(record.step)) return { item, refused: message('archive.refused.busy', row.status ?? record.step) }
      if (processes.some(other => other.ppid === row.pid && !HELPERS.test(other.command ?? other.name ?? '')))
        return { item, refused: message('archive.refused.tool', row.pid) }
    }
    if (item.agent === 'codex' && Number.isFinite(record.mtimeMs) && now - record.mtimeMs < CODEX_QUIET_MS) return { item, refused: message('archive.refused.codex') }
    const targets = []
    const notes = []
    for (const row of live) {
      const owner = owners.get(row.pid)
      if (owner && (owner.ownership === 'orphan' || owner.ownership === 'owned' && OWNERS_STOPPED.has(owner.parent.kind)))
        targets.push({ pid: row.pid, startedAt: row.startedAt, identity: owner.identity, owner: owner.ownership === 'orphan' ? 'orphan' : owner.parent.kind })
      else notes.push({ pid: row.pid, owner: owner?.parent?.kind ?? 'unknown', name: owner?.parent?.name ?? '' })
    }
    const warnings = await this.warnings(item, record, now, view)
    return { item, record, live: targets, notes, action: notes.length ? 'card' : targets.length ? 'stop' : 'hide', warnings }
  }

  /** True when Codex keeps the log of [sessionId] in its folder of archived sessions, as `codex archive` and Air leave it. */
  async codexArchived(sessionId) {
    if (!this.codexArchive) return false
    return (await this.fs.readdir(this.codexArchive).catch(() => [])).some(name => name.includes(sessionId) && /\.jsonl(\.zst)?$/.test(name))
  }

  async archivedState(agent, record) {
    if (agent === 'codex') return this.codexArchived(record.sessionId ?? record.nameId)
    return (await titleState(agent, record.path, this.fs).catch(() => undefined))?.archived === true
  }

  async warnings(item, record, now, view) {
    const warnings = []
    if (record.cwd) {
      const status = await this.git(['status', '--porcelain'], record.cwd)
      const files = status ? status.split('\n').filter(Boolean).length : 0
      if (files) warnings.push(message('archive.warning.uncommitted', files))
      const ahead = Number((await this.git(['rev-list', '--count', '@{u}..HEAD'], record.cwd))?.trim())
      if (ahead > 0) warnings.push(message('archive.warning.ahead', ahead))
      if (view.rows.some(row => row.pid && row.cwd === record.cwd && !(row.agent === item.agent && row.sessionId === item.sessionId))) warnings.push(message('archive.warning.shared'))
    }
    if (Number.isFinite(record.mtimeMs) && now - record.mtimeMs < RECENT_MS) warnings.push(message('archive.warning.recent', Math.max(1, Math.round((now - record.mtimeMs) / 60000))))
    return warnings
  }

  async archive(sessions, catalog, abortSignal) {
    const prepared = await Promise.all(sessions.map(item => this.prepare(item, catalog)))
    const refused = prepared.filter(row => row.refused).map(row => ({ ...row.item, reason: row.refused }))
    const skipped = prepared.filter(row => row.skipped).map(row => ({ ...row.item, reason: row.skipped }))
    const rows = prepared.filter(row => row.action)
    if (!rows.length) return { outcome: 'none', archived: [], refused, skipped, note: message('archive.result.none') }
    const dialog = rows.map(row => ({ agent: row.item.agent, cwd: row.record.cwd ?? null, title: row.record.title ?? '', lastActivityAt: iso(row.record.mtimeMs),
      action: row.action, owner: row.live[0]?.owner ?? row.notes[0]?.owner ?? null, warnings: row.warnings }))
    const { answer, turnId } = await this.stopper.confirm('archive', dialog, abortSignal)
    if (answer !== 'stop') return { outcome: answer, archived: [], refused, skipped, note: message(`archive.result.${answer}`) }
    const archived = []
    for (const row of rows) {
      await this.stopper.ensureTurn(turnId, abortSignal)
      archived.push(await this.run(row.item, catalog))
    }
    return { outcome: 'archived', archived, refused, skipped, note: message('archive.result.archived') }
  }

  /** The steps for one confirmed row. A failure stops the steps of this row, and the result names it. */
  async run(item, catalog) {
    const result = { ...item }
    try {
      // The checks again: the user answered some time after the dialog.
      const row = await this.prepare(item, catalog)
      if (row.refused || row.skipped) return { ...result, step: 'check', error: row.refused ?? row.skipped }
      const card = await this.card(row)
      await this.cards.append(card)
      let live = row.live
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        if (!live.length) break
        await this.stopper.terminate(live, signal)
        live = await this.wait(row)
      }
      if (live.length) {
        await this.cards.update(card, { hidden: 'pending' })
        return { ...result, hidden: 'pending', step: 'stop', error: message('archive.error.alive') }
      }
      if (row.notes.length) {
        await this.cards.update(card, { hidden: 'pending' })
        return { ...result, hidden: 'pending', note: message('archive.note.owner', row.notes.map(note => `${note.name || note.owner} (${note.owner})`).join(', ')) }
      }
      const hidden = await this.hide(row.item, row.record)
      await this.cards.update(card, { hidden })
      return { ...result, hidden, resume: card.resume.command }
    }
    catch (error) {
      if (error?.name === 'AbortError') throw error
      return { ...result, step: 'error', error: message('archive.error.step', String(error?.code ?? error?.message ?? error).slice(0, 200)) }
    }
  }

  /** The target processes that still run after the signal, waited for up to [exitWaitMs]. */
  async wait(row) {
    const end = this.clock.now() + this.exitWaitMs
    for (;;) {
      const { rows } = await this.processes(row.item.agent, row.item.sessionId)
      const alive = row.live.filter(target => rows.some(item => item.pid === target.pid && item.startedAt === target.startedAt))
      if (!alive.length || this.clock.now() >= end) return alive
      await this.sleep(250)
    }
  }

  /** Hides a session that no process runs: the title records of Air, or `codex archive`. Gives the kind of the hide. */
  async hide({ agent, sessionId }, record) {
    if (agent === 'codex') {
      await this.codex(['archive', sessionId])
      return 'codex'
    }
    const { rows } = await this.processes(agent, sessionId)
    if (rows.some(row => row.pid)) throw new MegachatError('archiveLive')
    await writeTitle({ agent, path: record.path, sessionId, archive: true, title: record.title, now: this.clock.now() }, this.fs)
    return (await titleState(agent, record.path, this.fs))?.archived ? 'title' : 'pending'
  }

  async restore(sessions, catalog) {
    const restored = []
    const refused = []
    const refuse = (item, reason) => refused.push({ ...item, reason })
    for (const item of sessions) {
      // A Codex log of the folder of archived sessions is in no live table, so only the folder tells that it exists.
      const record = item.agent === 'codex' ? {} : await this.record(catalog, item)
      if (item.agent === 'codex' ? !await this.codexArchived(item.sessionId) : !record?.path) {
        refuse(item, item.agent === 'codex' ? message('archive.skipped.notArchived') : message('archive.refused.unknown', item.agent, item.sessionId))
        continue
      }
      const { rows } = await this.processes(item.agent, item.sessionId)
      if (rows.some(row => row.pid)) { refuse(item, message('archive.refused.live')); continue }
      try {
        if (item.agent === 'codex') {
          await this.codex(['unarchive', item.sessionId])
        }
        else {
          const state = await titleState(item.agent, record.path, this.fs).catch(() => undefined)
          if (!state?.archived) { refuse(item, message('archive.skipped.notArchived')); continue }
          await writeTitle({ agent: item.agent, path: record.path, sessionId: item.sessionId, archive: false, title: state.title, now: this.clock.now() }, this.fs)
        }
        const card = (await this.cards.all()).find(found => found.agent === item.agent && found.sessionId === item.sessionId && !found.restoredAt)
        const restoredAt = new Date(this.clock.now()).toISOString()
        if (card) await this.cards.update(card, { restoredAt })
        restored.push({ ...item, restoredAt, resume: resumeCommand(item.agent, item.sessionId) })
      }
      catch (error) { refuse(item, message('archive.error.step', String(error?.code ?? error?.message ?? error).slice(0, 200))) }
    }
    return { outcome: 'restored', restored, refused, note: message('archive.result.restored') }
  }

  /** The card of a row. No model makes it: the log, the clock and `git` give each field. */
  async card(row) {
    const { item, record } = row
    const facts = await readFacts(this.fs, this.catalog().source(item.agent), record.path)
    const clean = (text, limit) => text === undefined ? undefined : indexedText(String(text).slice(0, limit * 2), this.secrets).text.slice(0, limit)
    const branch = record.cwd ? (await this.git(['rev-parse', '--abbrev-ref', 'HEAD'], record.cwd))?.trim() || undefined : undefined
    return {
      agent: item.agent, sessionId: item.sessionId, title: clean(visibleTitle(record.title ?? '', item.sessionId), TITLE_CAP), cwd: record.cwd ?? null,
      owner: row.live[0]?.owner ?? row.notes[0]?.owner ?? 'none',
      startedAt: iso(record.startedAt), lastActivityAt: iso(record.mtimeMs), archivedAt: new Date(this.clock.now()).toISOString(),
      firstPrompt: clean(facts.firstPrompt, 500), lastPrompt: clean(facts.lastPrompt, 500), lastReply: clean(facts.lastReply, 1000),
      branch, commits: facts.commits.slice(-20), tickets: facts.tickets.slice(0, 20).map(text => clean(text, 200)), files: facts.files.slice(-50).map(text => clean(text, 500)),
      resume: { arguments: { agent: item.agent, sessionId: item.sessionId, cwd: record.cwd ?? null }, command: resumeCommand(item.agent, item.sessionId) },
      hidden: 'pending', warnings: row.warnings,
    }
  }
}

/** Reads a whole log once and takes the facts of a card. A line above the limit of the reader is skipped. */
async function readFacts(fs, source, path) {
  const facts = {}
  const tickets = new Set()
  const commits = new Set()
  const files = new Set()
  for await (const { lines } of readLines(fs, path, { batchLines: 256, compressed: path.endsWith('.zst') })) {
    for (const line of lines) {
      const entry = parseLine(source, line, path)?.parsed.entry
      if (!entry) continue
      for (const [, id] of entry.text.matchAll(TICKET)) if (!NOT_TICKETS.has(id)) tickets.add(id)
      for (const [url] of entry.text.matchAll(GITHUB)) tickets.add(url)
      if (entry.role === 'user' && !entry.tool) { facts.firstPrompt ??= entry.text; facts.lastPrompt = entry.text }
      else if (entry.role === 'assistant' && !entry.tool) facts.lastReply = entry.text
      if (entry.tool === 'result') {
        for (const [, hash] of entry.text.matchAll(COMMIT)) commits.add(hash)
        for (const [, hash] of entry.text.matchAll(PUSH)) commits.add(hash)
      }
      if (entry.tool === 'call') {
        const call = entry.text.split('\n').find(part => EDIT_CALL.test(part)) ?? ''
        for (const [, name] of call.matchAll(EDIT_PATH)) { try { files.add(JSON.parse(`"${name}"`)) } catch { files.add(name) } }
        for (const [, name] of entry.text.matchAll(PATCH_PATH)) files.add(name.trim())
      }
    }
  }
  return { ...facts, commits: [...commits], tickets: [...tickets], files: [...files] }
}

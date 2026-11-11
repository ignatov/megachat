import { Buffer } from 'node:buffer'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { ClaudeSessionHistoryService } from './ClaudeSessionHistoryService.mjs'
import { CodexSessionHistoryService } from './CodexSessionHistoryService.mjs'
import { message, requireCondition } from './messages.mjs'
import { listedDirectory } from './ProjectDirectories.mjs'
import { newestPage } from './SessionTail.mjs'
import { queryTerms, snippet } from './SqliteSidecar.mjs'

const cursorKey = randomBytes(32)
const sign = payload => createHmac('sha256', cursorKey).update(payload).digest()
// Cursors round-trip through the model, so they carry a per-process signature and are revalidated on return.
const encode = value => {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${payload}.${sign(payload).toString('base64url')}`
}
const sessionIdPattern = /^[a-zA-Z0-9_-]{1,200}$/
const providerCursor = value => value === null || (typeof value === 'string' && value.length <= 4096)
const count = value => Number.isSafeInteger(value) && value >= 0
/** The position in the index of a search, of a list or of a session: the fields of each one are counts. */
const indexPosition = value => value && typeof value === 'object' && !Array.isArray(value)
  && Object.entries(value).every(([key, item]) => ['before', 'offset', 'after'].includes(key) && count(item))
/** pi has no live source. Its sessions come only from the index of past sessions. */
const INDEX_ONLY = 'pi'
/** The entries of one page of a read from the end of a log. */
export const NEWEST_LIMIT = 20
export const NEWEST_MAX_LIMIT = 100

/**
 * Searches the session histories only in the listed directories: the projects of an IDE, the known repositories, and
 * the workspace. With the consent of the user, the index of past sessions answers first. The live provider answers
 * when the index is off, when the index has no session of the agent in the directory, and for a query that is too
 * short for the index.
 */
export class SessionHistoryService {
  constructor(state, providers = { claude: new ClaudeSessionHistoryService(), codex: new CodexSessionHistoryService() }, index = undefined) {
    this.state = state
    this.providers = providers
    this.index = index
  }

  get indexed() { return Boolean(this.index?.enabled) }

  /** Accepts a known agent. pi needs the index. */
  agent(agent) {
    requireCondition(typeof agent === 'string' && (Object.hasOwn(this.providers, agent) || agent === INDEX_ONLY))
    requireCondition(agent !== INDEX_ONLY || this.indexed, 'sessionsIndexOff')
    return agent
  }

  async workspace(cwd) {
    return listedDirectory(await this.state.snapshot(), cwd, this.state.home)
  }

  position(cursor, expected) {
    if (cursor === undefined || cursor === null) return null
    requireCondition(typeof cursor === 'string' && cursor.length <= 16000)
    const [payload, signature, ...rest] = cursor.split('.')
    requireCondition(rest.length === 0 && payload && signature)
    const actual = Buffer.from(signature, 'base64url')
    const wanted = sign(payload)
    requireCondition(actual.length === wanted.length && timingSafeEqual(actual, wanted))
    let value
    try { value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) }
    catch { requireCondition(false) }
    requireCondition(value && typeof value === 'object' && Object.entries(expected).every(([key, item]) => value[key] === item))
    requireCondition(providerCursor(value.historyCursor))
    return value
  }

  async search({ cwd, agent = 'all', query = '', cursor } = {}) {
    cwd = await this.workspace(cwd)
    requireCondition(typeof query === 'string' && query.length <= 200)
    if (agent !== 'all') this.agent(agent)
    requireCondition(agent !== 'all' || !cursor)
    const indexed = this.indexed
    const agents = agent === 'all' ? [...Object.keys(this.providers), ...(indexed ? [INDEX_ONLY] : [])] : [agent]
    const position = agent === 'all' ? null : this.position(cursor, { cwd, agent, query })
    if (position?.index !== undefined) requireCondition(indexed && indexPosition(position.index))
    else if (position) {
      requireCondition(Array.isArray(position.sessions) && position.sessions.length <= 10)
      requireCondition(position.sessions.every(session => session && typeof session === 'object'
        && typeof session.sessionId === 'string' && sessionIdPattern.test(session.sessionId)
        && (session.title === undefined || session.title === null || typeof session.title === 'string')))
      requireCondition(providerCursor(position.listCursor))
      requireCondition(Number.isSafeInteger(position.unreadableSessions) && position.unreadableSessions >= 0)
    }
    // The import of the new lines of the files of this directory is cheap, so a search sees the last messages. A failed
    // import, such as of a file without the read permission, makes the index pages incomplete and fails no page.
    const caughtUp = indexed ? await this.index.catchUp(cwd).catch(() => false) : false
    const pages = await Promise.all(agents.map(async agent => {
      try {
        if (indexed && (!position || position.index)) {
          const page = await this.indexPage(cwd, agent, query, position?.index, caughtUp)
          if (page) return page
        }
        if (agent === INDEX_ONLY) return { agent, matches: [], complete: false, error: message('error.sessionsIndexOff') }
        return await this.searchPage(cwd, agent, query, position?.index ? null : position)
      }
      catch { return { agent, matches: [], complete: false, error: message('error.sessions') } }
    }))
    return { cwd, query, pages, ...(indexed ? { index: await this.index.status() } : {}) }
  }

  /**
   * A page of the index for [agent], or undefined when the index has no data for the request: no session of the agent
   * in the directory, or a short query for an agent with a live source. One match is one session with its best hit.
   */
  async indexPage(cwd, agent, query, position, caughtUp) {
    const index = this.index.store
    if (!index) return undefined
    const live = agent !== INDEX_ONLY
    if (live && !await index.hasSessions(agent, cwd)) return undefined
    const terms = queryTerms(query)
    if (live && query.trim() && !terms.length) return undefined
    let matches
    let next
    if (terms.length) {
      const found = await index.search(agent, cwd, terms, position)
      matches = found.hits.map(hit => {
        const text = snippet(hit.entry.text, terms)
        return { ...hit.session, id: hit.entry.id, role: hit.entry.role, ...(hit.entry.tool ? { tool: hit.entry.tool } : {}),
          timestamp: hit.entry.timestamp, text, truncated: hit.entry.clipped || text !== hit.entry.text }
      })
      next = found.next
    }
    else {
      const found = query.trim() ? await index.titled(agent, cwd, query.trim(), position?.offset) : await index.list(agent, cwd, position?.offset)
      matches = found.sessions.map(session => ({ ...session, text: session.title ?? '' }))
      next = found.next
    }
    const complete = caughtUp && !next
    return { agent, source: 'index', matches, complete,
      ...(caughtUp ? {} : { error: message('sessions.incomplete') }),
      nextCursor: next ? encode({ cwd, agent, query, historyCursor: null, index: next }) : null }
  }

  async searchPage(cwd, agent, query, position) {
    const identity = { cwd, agent, query }
    const source = this.providers[agent]
    if (!position || position.sessions.length === 0) {
      const page = await source.list(cwd, position?.listCursor ?? null)
      position = { ...identity, sessions: page.sessions, listCursor: page.nextCursor, historyCursor: null,
        unreadableSessions: position?.unreadableSessions ?? 0 }
    }
    const matches = []
    let scannedPages = 0
    while (position.sessions.length && scannedPages < 5) {
      const session = position.sessions[0]
      let match
      if (!query || session.title?.toLowerCase().includes(query.toLowerCase())) match = { text: session.title ?? '' }
      else {
        scannedPages++
        try {
          const page = await source.read(cwd, session.sessionId, position.historyCursor)
          match = page.entries.find(entry => entry.text.toLowerCase().includes(query.toLowerCase()))
          position.historyCursor = page.nextCursor
        }
        catch {
          position.unreadableSessions++
          position.historyCursor = null
        }
      }
      if (match) matches.push({ ...session, ...this.excerpt(match, query) })
      if (match || !position.historyCursor) {
        position.sessions.shift()
        position.historyCursor = null
      }
    }
    const more = position.sessions.length > 0 || position.listCursor !== null
    return { agent, matches, scannedPages, complete: !more && position.unreadableSessions === 0,
      unreadableSessions: position.unreadableSessions,
      ...(position.unreadableSessions ? { error: message('error.sessions') } : {}),
      nextCursor: more ? encode(position) : null }
  }

  async read({ cwd, agent, sessionId, cursor, query = '' } = {}) {
    cwd = await this.workspace(cwd)
    this.agent(agent)
    requireCondition(typeof sessionId === 'string' && sessionIdPattern.test(sessionId))
    requireCondition(typeof query === 'string' && query.length <= 200)
    const identity = { cwd, agent, sessionId, query }
    const position = this.position(cursor, identity)
    if (position?.index !== undefined) requireCondition(this.indexed && indexPosition(position.index))
    if (this.indexed && (!position || position.index)) {
      const page = await this.indexRead(identity, position?.index?.after ?? 0)
      if (page) return page
    }
    requireCondition(agent !== INDEX_ONLY, 'missing')
    const page = await this.providers[agent].read(cwd, sessionId, position?.historyCursor ?? null)
    return { agent, session: page.session,
      entries: page.entries.filter(entry => entry.text.toLowerCase().includes(query.toLowerCase())).map(entry => this.excerpt(entry, query)),
      nextCursor: page.nextCursor === null ? null : encode({ ...identity, historyCursor: page.nextCursor }) }
  }

  /**
   * Reads a session from the end of its log: the last [limit] messages, tool calls and tool results, and a cursor to
   * the older page. [query] selects the entries inside the session. Only the main agent has this read, for each
   * session of the live table of the session files, also outside the listed directories. It needs the consent of the
   * user, the setting `sessions.index`. The read is bounded, so a log of 600 MB opens at once.
   */
  async readNewest({ agent, sessionId, cursor, query = '', limit = NEWEST_LIMIT } = {}) {
    const logs = this.index?.logs
    requireCondition(logs, 'sessionsLogsOff')
    requireCondition(typeof agent === 'string' && logs.source(agent))
    requireCondition(typeof sessionId === 'string' && sessionIdPattern.test(sessionId))
    requireCondition(typeof query === 'string' && query.length <= 200)
    requireCondition(Number.isSafeInteger(limit) && limit >= 1 && limit <= NEWEST_MAX_LIMIT)
    const identity = { order: 'newest', agent, sessionId, query }
    const position = this.position(cursor, identity)
    const found = logs.session(agent, sessionId)
    requireCondition(found, 'missing')
    const record = await logs.ensure(found.path)
    requireCondition(record?.read, 'missing')
    // A cursor holds an offset in one file. Another file or a rotation makes the offset meaningless.
    if (position) requireCondition(count(position.before) && position.path === record.path && position.ino === record.ino)
    let page
    try { page = await newestPage(logs.fs, logs.source(agent), record.path, { before: position?.before, limit, query }) }
    catch { requireCondition(false, 'missing') }
    return {
      agent, source: 'log', order: 'newest',
      session: { sessionId, cwd: record.cwd ?? null, title: record.title ?? null,
        lastActivityAt: Number.isFinite(record.mtimeMs) ? new Date(record.mtimeMs).toISOString() : null },
      entries: page.entries.map(({ key, timestamp, clipped, ...entry }) => {
        const excerpt = this.excerpt({ id: key, ...entry, timestamp: Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null }, query)
        return { ...excerpt, truncated: excerpt.truncated || clipped }
      }),
      nextCursor: page.before === null ? null : encode({ ...identity, historyCursor: null, before: page.before, path: record.path, ino: record.ino }),
    }
  }

  /** A page of a session from the index, or undefined when the index does not hold the session. */
  async indexRead(identity, after) {
    const { cwd, agent, sessionId, query } = identity
    // A failed import does not stop the read: the index gives the entries that it holds.
    await this.index.catchUp(cwd).catch(() => false)
    const index = this.index.store
    const session = index && await index.session(agent, cwd, sessionId)
    if (!session) return undefined
    const page = await index.entries(session.id, after)
    const needle = query.toLowerCase()
    const entries = page.entries.filter(entry => entry.text.toLowerCase().includes(needle)).map(({ rowId, clipped, ...entry }) => {
      const excerpt = this.excerpt(entry, query)
      return { ...excerpt, truncated: excerpt.truncated || clipped }
    })
    return { agent, source: 'index', session: session.info, entries,
      nextCursor: page.more ? encode({ ...identity, historyCursor: null, index: { after: page.entries.at(-1).rowId } }) : null }
  }

  excerpt(entry, query) {
    const textOffset = Math.max(0, entry.text.toLowerCase().indexOf(query.toLowerCase()) - 300)
    const text = entry.text.slice(textOffset, textOffset + 1200)
    return { ...entry, text, textOffset, truncated: text.length < entry.text.length }
  }

  async close() { await Promise.all(Object.values(this.providers).map(provider => provider.close())) }
}

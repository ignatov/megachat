import { Buffer } from 'node:buffer'
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { ClaudeSessionHistoryService } from './ClaudeSessionHistoryService.mjs'
import { CodexSessionHistoryService } from './CodexSessionHistoryService.mjs'
import { message, requireCondition } from './messages.mjs'

const cursorKey = randomBytes(32)
const sign = payload => createHmac('sha256', cursorKey).update(payload).digest()
// Cursors round-trip through the model, so they carry a per-process signature and are revalidated on return.
const encode = value => {
  const payload = Buffer.from(JSON.stringify(value)).toString('base64url')
  return `${payload}.${sign(payload).toString('base64url')}`
}
const sessionIdPattern = /^[a-zA-Z0-9_-]{1,200}$/
const providerCursor = value => value === null || (typeof value === 'string' && value.length <= 4096)

/** Searches provider histories only in projects registered by the user. */
export class SessionHistoryService {
  constructor(state, providers = { claude: new ClaudeSessionHistoryService(), codex: new CodexSessionHistoryService() }) {
    this.state = state
    this.providers = providers
  }

  async workspace(cwd) {
    requireCondition(typeof cwd === 'string' && cwd.length <= 4096)
    const canonical = await realpath(cwd)
    requireCondition((await this.state.snapshot()).workspaces.includes(canonical), 'workspace')
    return canonical
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
    requireCondition(agent === 'all' || Object.hasOwn(this.providers, agent))
    requireCondition(agent !== 'all' || !cursor)
    const agents = agent === 'all' ? Object.keys(this.providers) : [agent]
    const position = agent === 'all' ? null : this.position(cursor, { cwd, agent, query })
    if (position) {
      requireCondition(Array.isArray(position.sessions) && position.sessions.length <= 10)
      requireCondition(position.sessions.every(session => session && typeof session === 'object'
        && typeof session.sessionId === 'string' && sessionIdPattern.test(session.sessionId)
        && (session.title === undefined || session.title === null || typeof session.title === 'string')))
      requireCondition(providerCursor(position.listCursor))
      requireCondition(Number.isSafeInteger(position.unreadableSessions) && position.unreadableSessions >= 0)
    }
    const pages = await Promise.all(agents.map(async agent => {
      try { return await this.searchPage(cwd, agent, query, position) }
      catch { return { agent, matches: [], complete: false, error: message('error.sessions') } }
    }))
    return { cwd, query, pages }
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
    requireCondition(Object.hasOwn(this.providers, agent))
    requireCondition(typeof sessionId === 'string' && sessionIdPattern.test(sessionId))
    requireCondition(typeof query === 'string' && query.length <= 200)
    const identity = { cwd, agent, sessionId, query }
    const position = this.position(cursor, identity)
    const page = await this.providers[agent].read(cwd, sessionId, position?.historyCursor ?? null)
    return { agent, session: page.session,
      entries: page.entries.filter(entry => entry.text.toLowerCase().includes(query.toLowerCase())).map(entry => this.excerpt(entry, query)),
      nextCursor: page.nextCursor === null ? null : encode({ ...identity, historyCursor: page.nextCursor }) }
  }

  excerpt(entry, query) {
    const textOffset = Math.max(0, entry.text.toLowerCase().indexOf(query.toLowerCase()) - 300)
    const text = entry.text.slice(textOffset, textOffset + 1200)
    return { ...entry, text, textOffset, truncated: text.length < entry.text.length }
  }

  async close() { await Promise.all(Object.values(this.providers).map(provider => provider.close())) }
}

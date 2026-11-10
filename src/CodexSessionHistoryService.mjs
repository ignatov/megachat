import { realpath } from 'node:fs/promises'
import { CentralConfigurationService } from './CentralConfigurationService.mjs'
import { CodexAppServerClient } from './CodexAppServerClient.mjs'
import { requireCondition } from './messages.mjs'

const appServerCursor = value => value === null || (typeof value === 'string' && value.length <= 4096)

/** Parses a provider cursor that came back through the model; any malformed shape is a normal validation error. */
function parseCursor(cursor, valid) {
  requireCondition(typeof cursor === 'string' && cursor.length <= 8192)
  let value
  try { value = JSON.parse(cursor) }
  catch { requireCondition(false) }
  requireCondition(value !== null && typeof value === 'object' && !Array.isArray(value) && valid(value))
  return value
}

export class CodexSessionHistoryService {
  /** Launches Codex through JetBrains Central like runs do unless a test supplies its own app-server. */
  constructor(launch = () => new CentralConfigurationService().codexAppServerLaunch()) { this.launch = launch }

  async connection() {
    if (this.client && !this.client.closed) return this.client
    this.opening ??= Promise.resolve(typeof this.launch === 'function' ? this.launch() : this.launch)
      .then(launch => CodexAppServerClient.open(launch)).then(client => this.client = client).finally(() => { this.opening = null })
    return this.opening
  }

  async list(cwd, cursor) {
    const position = cursor === null ? { archived: false, cursor: null }
      : parseCursor(cursor, value => typeof value.archived === 'boolean' && appServerCursor(value.cursor))
    const page = await (await this.connection()).request('thread/list', {
      cwd, cursor: position.cursor, archived: position.archived, limit: 10, sortKey: 'updated_at', modelProviders: [],
      sourceKinds: ['cli', 'vscode', 'exec', 'appServer', 'unknown'],
    })
    const next = page.nextCursor ? { ...position, cursor: page.nextCursor } : position.archived ? null : { archived: true, cursor: null }
    return { sessions: page.data.map(thread => this.info(thread)), nextCursor: next ? JSON.stringify(next) : null }
  }

  info(thread) {
    return { sessionId: thread.id, title: thread.name || thread.preview, cwd: thread.cwd,
      updatedAt: new Date(thread.updatedAt * 1000).toISOString() }
  }

  async read(cwd, sessionId, cursor) {
    const client = await this.connection()
    const { thread } = await client.request('thread/read', { threadId: sessionId })
    requireCondition(thread.cwd && await realpath(thread.cwd) === cwd, 'missing')
    const position = cursor === null ? { cursor: null, offset: 0 }
      : parseCursor(cursor, value => appServerCursor(value.cursor) && Number.isSafeInteger(value.offset) && value.offset >= 0)
    const page = await client.request('thread/turns/list', {
      threadId: sessionId, cursor: position.cursor, limit: 1, sortDirection: 'asc', itemsView: 'full',
    })
    const messages = page.data.flatMap(turn => turn.items ?? []).filter(item => ['userMessage', 'agentMessage'].includes(item.type))
    const entries = messages.slice(position.offset, position.offset + 20).map(item => ({
      id: item.id, role: item.type === 'userMessage' ? 'user' : 'assistant',
      text: item.type === 'agentMessage' ? item.text
        : (item.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n'),
    }))
    const next = position.offset + 20 < messages.length ? { ...position, offset: position.offset + 20 }
      : page.nextCursor ? { cursor: page.nextCursor, offset: 0 } : null
    return { session: this.info(thread), entries, nextCursor: next ? JSON.stringify(next) : null }
  }

  async close() {
    await this.opening?.catch(() => {})
    this.client?.close()
  }
}

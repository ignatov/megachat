import { getSessionInfo, getSessionMessages, listSessions } from '@anthropic-ai/claude-agent-sdk'
import { realpath } from 'node:fs/promises'
import { requireCondition } from './messages.mjs'

export class ClaudeSessionHistoryService {
  async list(cwd, cursor) {
    const offset = cursor === null ? 0 : Number(cursor)
    requireCondition(Number.isSafeInteger(offset) && offset >= 0)
    const sessions = await listSessions({ dir: cwd, includeWorktrees: false, includeProgrammatic: true, offset, limit: 10 })
    return { sessions: sessions.map(session => this.info(session)), nextCursor: sessions.length === 10 ? String(offset + 10) : null }
  }

  info(session) {
    return { sessionId: session.sessionId, title: session.summary, cwd: session.cwd,
      updatedAt: new Date(session.lastModified).toISOString() }
  }

  async read(cwd, sessionId, cursor) {
    const session = await getSessionInfo(sessionId, { dir: cwd })
    requireCondition(session && (!session.cwd || await realpath(session.cwd) === cwd), 'missing')
    const offset = cursor === null ? 0 : Number(cursor)
    requireCondition(Number.isSafeInteger(offset) && offset >= 0)
    const messages = await getSessionMessages(sessionId, { dir: cwd, offset, limit: 20 })
    const entries = messages.map(item => {
      const content = item.message?.content
      return { id: item.uuid, role: item.type, text: typeof content === 'string' ? content
        : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n') }
    })
    return { session: this.info(session), entries, nextCursor: messages.length === 20 ? String(offset + 20) : null }
  }

  close() {}
}

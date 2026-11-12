import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { requireCondition } from './messages.mjs'

const context = BACKGROUND_CONTEXT
const PAGE = 20
const blockText = content => typeof content === 'string' ? content
  : content.filter(block => block.type === 'text').map(block => block.text).join('\n')

/** The text of one model message of a transcript: the text blocks, else the names and arguments of the tool calls. */
function messageText(model) {
  const text = blockText(model.content)
  if (text || model.role !== 'assistant') return text
  return model.content.filter(block => block.type === 'toolCall').map(block => `${block.name}(${JSON.stringify(block.arguments ?? {})})`).join('; ')
}

/**
 * Reads the transcript of a native pi child for `agents_session_history` with the agent `pi`. The session ID of a child
 * is the ID of its conversation in `conversation.sqlite`. Only a pi run of the state names such a session, so a log of
 * the pi command-line agent cannot have the same ID.
 */
export class PiChildHistory {
  constructor(harness, state) {
    this.harness = harness
    this.state = state
  }

  /** The last pi run of the state in [cwd] with the session [sessionId], or `undefined`. */
  async owns(cwd, sessionId) {
    const { runs } = await this.state.snapshot()
    return Object.values(runs).findLast(run => run.agent === 'pi' && run.cwd === cwd && run.providerSessionId === sessionId)
  }

  /** One page of the messages, oldest first. [cursor] is the ID of the first entry of the page. */
  async read(cwd, sessionId, cursor) {
    const run = await this.owns(cwd, sessionId)
    requireCondition(run, 'missing')
    const minEntryId = cursor === null ? 0 : Number(cursor)
    requireCondition(Number.isSafeInteger(minEntryId) && minEntryId >= 0)
    const conversation = await this.harness.conversation(Number(sessionId), context)
    requireCondition(conversation, 'missing')
    const page = await conversation.entries({ order: 'ascending', minEntryId }, PAGE + 1, undefined, context)
    const items = page.items.slice(0, PAGE)
    const entries = items.flatMap(entry => (entry.model ?? []).filter(model => ['user', 'assistant', 'toolResult'].includes(model.role))
      .map(model => ({ id: String(entry.id), role: model.role, ...(model.toolName ? { tool: model.toolName } : {}),
        timestamp: Number.isFinite(model.timestamp) ? new Date(model.timestamp).toISOString() : null, text: messageText(model) }))
      .filter(entry => entry.text))
    const next = page.items.length > PAGE ? page.items[PAGE].id : null
    return { session: { sessionId, cwd, title: run.title ?? null }, entries, nextCursor: next === null ? null : String(next) }
  }
}

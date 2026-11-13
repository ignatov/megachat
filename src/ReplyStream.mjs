/** `MEGACHAT_STREAM=0` stops the stream of the partial reply. Then the chat gets a reply when its entry is written. */
export const STREAM_VARIABLE = 'MEGACHAT_STREAM'
/** The shortest time between two stream events of one client: at most 20 events in a second. */
export const STREAM_INTERVAL_MS = 50

/** The clock and the timer of the stream. A test gives a fake clock, so that the time moves only when the test moves it. */
const systemClock = {
  now: () => performance.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: timer => clearTimeout(timer),
}

export function streamEnabled(environment = process.env) {
  return environment[STREAM_VARIABLE]?.trim() !== '0'
}

/** The text of an assistant message, as the chat shows it: its text blocks without a separator. */
export const replyText = model => model.content.filter(block => block.type === 'text').map(block => block.text).join('')

/**
 * The kind of the entry that tells the model about a turn that the user stopped. The entry is for the model only: the
 * chat shows the partial text from the entry of the stopped request, so it does not show this entry.
 */
export const STOPPED_KIND = 'air.megachat.stopped'

/** The stop reasons of an assistant message that Pi Durable leaves out of the model context. */
const UNFINISHED_STOP_REASONS = new Set(['aborted', 'error', 'deferred'])

/**
 * The text that the model gets for a turn that the user stopped: the partial reply of the turn, then the marker. Pi
 * Durable keeps a partial reply as an entry with the stop reason `aborted`, and it leaves that message out of the model
 * context. Without this text, the model sees two messages of the user one after the other, and it answers both.
 * [entries] are the newest entries of the conversation, the newest first. The turn starts at an entry `pi.user` or
 * `air.megachat.event`. Gives undefined when the turn ended with a full reply, because the model already sees it.
 */
export function stoppedReplyText(entries, marker) {
  for (const entry of entries) {
    const model = entry.model?.at(-1)
    if (entry.head !== undefined || entry.kind === 'pi.user' || entry.kind === 'air.megachat.event' || model?.role === 'user') return marker
    if (!model) continue
    if (model.role !== 'assistant') return marker
    if (!UNFINISHED_STOP_REASONS.has(model.stopReason)) return undefined
    const partial = replyText(model).trimEnd()
    return partial ? `${partial}\n\n${marker}` : marker
  }
  return marker
}

/**
 * The reply that the model writes now, from the `pi.live` document of a view of the conversation. The task ID and the
 * attempt identify one model request. The entry of the reply has the same task ID in `byTaskId`.
 */
export function partialReply(view) {
  const live = view.docs?.['pi.live']
  if (!live?.run || !live.generation) return undefined
  return { taskId: live.run.taskId, attempt: live.generation.attempt,
    text: live.generation.message ? replyText(live.generation.message) : '' }
}

/**
 * Sends the partial reply of the root conversation to one client as `stream` events. An event holds the text after
 * `offset`, so the events of one reply join into its text. A client that connects in the middle of a reply gets the
 * text so far in its first event. Text that arrives faster than the interval waits for the next event. The entry of
 * the reply ends the stream: the client takes the remaining text from the entry.
 */
export class ReplyStream {
  /** [onSent] gets each event and the time when the stream sends it, on [clock]. */
  constructor(publish, { intervalMs = STREAM_INTERVAL_MS, onFirstText, onSent, clock = systemClock } = {}) {
    this.publish = publish
    this.intervalMs = intervalMs
    this.onFirstText = onFirstText
    this.onSent = onSent
    this.clock = clock
    this.lastAt = -Infinity
  }

  /** Takes each view of the conversation, in order. */
  async observe(view) {
    const partial = partialReply(view)
    if (!partial) { this.stop(); this.reply = undefined; return }
    if (this.reply?.taskId !== partial.taskId || this.reply.attempt !== partial.attempt) {
      // Only a request that this stream saw before its first text has a known start time.
      this.reply = { taskId: partial.taskId, attempt: partial.attempt, sent: 0, startedAt: partial.text ? undefined : this.clock.now() }
    }
    this.reply.text = partial.text
    if (this.sendable() <= this.reply.sent) return
    const wait = this.lastAt + this.intervalMs - this.clock.now()
    if (wait <= 0) await this.flush()
    else this.timer ??= this.clock.setTimeout(() => { this.timer = undefined; this.flush().catch(() => {}) }, wait)
  }

  /** The length of the text that can go out. One half of a character of two UTF-16 units waits for the other half. */
  sendable() {
    const { text } = this.reply
    const last = text.charCodeAt(text.length - 1)
    return last >= 0xd800 && last <= 0xdbff ? text.length - 1 : text.length
  }

  async flush() {
    this.stop()
    const reply = this.reply
    if (!reply) return
    const end = this.sendable()
    if (end <= reply.sent) return
    const event = { taskId: reply.taskId, attempt: reply.attempt, offset: reply.sent, text: reply.text.slice(reply.sent, end) }
    if (reply.sent === 0 && reply.startedAt !== undefined) this.onFirstText?.(event, this.clock.now() - reply.startedAt)
    reply.sent = end
    this.lastAt = this.clock.now()
    this.onSent?.(event, this.lastAt)
    await this.publish('stream', event)
  }

  stop() {
    this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }
}

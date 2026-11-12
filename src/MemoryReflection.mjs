import { randomUUID } from 'node:crypto'
import { ENTRY_LIMIT, forgottenTopic, unsafeReason } from './MegachatMemory.mjs'
import { logEvent, logFailure, message } from './messages.mjs'
import { nextWorkdayStart } from './Workday.mjs'

/** A pass waits for this time after the end of the last turn. */
export const REFLECTION_IDLE_MS = 60000
/** A pass is due after this count of completed turns of the user since the last pass. */
export const REFLECTION_TURNS = 10
/** The newest part of the conversation after the last pass that a request reads, in characters. */
export const REFLECTION_CHARACTERS = 60000
export const REFLECTION_MAX_TOKENS = 1000
export const REFLECTION_TIMEOUT_MS = 120000
/** The most adds and the most proposals that one pass takes from the answer. */
export const REFLECTION_ADDS = 5
export const REFLECTION_PROPOSALS = 3
/** A timer that waits for the working hours looks at the clock again after this time, as the waiting results do. */
const RECHECK_MS = 15 * 60000
const ANSWER_LINE = /^\s*(?:[-*]\s+)?(add user|add notes|propose)\s*:\s*(.+?)\s*$/i

const blockText = content => typeof content === 'string' ? content
  : (content ?? []).filter(block => block.type === 'text').map(block => block.text).join('\n')

/**
 * The transcript that a pass reads from the retained [entries] after its position: the items `{ role, text }` with the
 * role `user` or `assistant`. It holds only the messages of the user and the text of the replies in a turn of the user.
 * A turn starts at an entry `pi.user` (a turn of the user) or `air.megachat.event` (an automatic turn: a child result,
 * the summary of the past sessions or the morning report). So a tool call, a tool result, a note, a summary and each
 * entry of an automatic turn stay out: text that the user did not write must not become a memory. The entries before
 * the first start of a turn stay out too. Gives the items in their order and the ID of the last entry.
 */
export function reflectionItems(entries, lastEntryId) {
  const items = []
  let user = false
  let last = lastEntryId
  for (const entry of entries) {
    if (!(entry.id <= last)) last = entry.id
    if (entry.head !== undefined) continue
    if (entry.kind === 'air.megachat.event') { user = false; continue }
    if (entry.kind === 'pi.user') user = true
    if (!user || entry.kind !== 'pi.user' && entry.kind !== 'pi.assistant') continue
    for (const model of entry.model ?? []) {
      const text = blockText(model.content).trim()
      if (!text || model.role !== 'user' && model.role !== 'assistant') continue
      items.push({ role: model.role, text })
    }
  }
  return { items, lastEntryId: last }
}

/**
 * The JSON text of one item. `JSON.stringify` escapes each quote and each line break of the text, so a text cannot
 * close its item and look like an item of another role. The escape of `<`, `>` and `&` keeps a text such as
 * `</conversation>` from the end of the tag of the request, and the result is still JSON.
 */
const encoded = item => JSON.stringify({ role: item.role, text: item.text })
  .replace(/[<>&\u2028\u2029]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`)

/**
 * The newest [items] as a JSON array of at most [limit] characters, or an empty text without an item. The limit applies
 * to whole items, the newest first. The oldest item that does not fit keeps only the end of its text after `…`, when
 * some of it fits: the cut is in the text before the escape, at the border of a code point, so the JSON stays valid.
 */
export function transcriptJson(items, limit = REFLECTION_CHARACTERS) {
  const kept = []
  let size = 2
  for (const item of [...items].reverse()) {
    const separator = kept.length ? 1 : 0
    const whole = encoded(item)
    if (size + separator + whole.length <= limit) {
      kept.unshift(whole)
      size += separator + whole.length
      continue
    }
    const characters = [...item.text]
    const tail = count => encoded({ role: item.role, text: `…${characters.slice(characters.length - count).join('')}` })
    // The length of the JSON text grows with the count of the kept characters, so a binary search finds the most.
    let low = 0
    let high = characters.length - 1
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (size + separator + tail(middle).length <= limit) low = middle
      else high = middle - 1
    }
    if (low > 0) kept.unshift(tail(low))
    break
  }
  return kept.length ? `[${kept.join(',')}]` : ''
}

/**
 * The adds and the proposals of the answer [text]. Each other line is ignored. [complete] is false when the answer
 * stopped at its token limit: its last line can be cut, so it is ignored.
 */
export function parseReflection(text, { complete = true } = {}) {
  const lines = text.split('\n')
  if (!complete) lines.pop()
  const adds = []
  const proposals = []
  for (const line of lines) {
    const match = ANSWER_LINE.exec(line)
    if (!match) continue
    const kind = match[1].toLowerCase().replace(/\s+/, ' ')
    if (kind === 'propose') { if (proposals.length < REFLECTION_PROPOSALS) proposals.push(match[2]) }
    else if (adds.length < REFLECTION_ADDS) adds.push({ section: kind === 'add user' ? 'user' : 'notes', text: match[2] })
  }
  return { adds, proposals }
}

/**
 * The reflection: a background pass that reads the conversation after its position and adds entries to `memory.md`.
 * The state field `memoryReflection` holds the position (`throughEntryId`), the count of the completed turns of the user
 * since the last pass (`userTurns`), `due`, the `notice` for the next turn, and the answer of a pass that did not finish
 * its writes (`pass`).
 *
 * A pass starts only when it is due, no turn runs, [REFLECTION_IDLE_MS] passed after the end of the last turn, the
 * conversation does not sleep (see `sleeping` of the service), the setting `memory.reflection` is on, and the spend of
 * the day is not above a daily limit. The request does not go through Pi Durable, so it never holds the live run of the
 * conversation, and a turn never waits for it. A turn that starts during a pass does not stop it: the pass makes one
 * request, and its writes go through the queue of the memory when the answer comes. Only the close of the service and
 * a forget stop a request.
 *
 * Each add goes through `MegachatMemory.change`, the write of the tool, with the request ID
 * `reflection:<pass>:<index>`: the checks, the topic rule, the cap, the duplicate check and the versions. The state
 * records the answer before the first write and each write after it, so a restart finishes the writes of the stored
 * answer, each one time, and sends no second request.
 */
export class MemoryReflection {
  constructor({ state, memory, read, complete, prompt, clock, values, sleeping, workday, spent }) {
    Object.assign(this, { state, memory, read, complete, prompt, clock, values, sleeping, workday, spent })
    this.idleSince = clock.now()
    this.turns = 0
    this.closed = false
    this.checking = Promise.resolve()
  }

  /** A turn starts, or a message of the user comes: the timer stops. A request that runs does not stop. */
  turnStarted() {
    this.turns++
    this.#clearTimer()
  }

  /** A turn ended: the idle time starts again, and a due pass waits for its end. */
  turnEnded() {
    this.idleSince = this.clock.now()
    return this.check()
  }

  /** The daemon starts: a stored answer gets its writes, and a due pass waits for the idle time. */
  resume() {
    this.idleSince = this.clock.now()
    return this.check()
  }

  /**
   * A summary completed, so a pass is due. A pass that runs now read the conversation before the summary, and its end
   * clears `due`. So the end of that pass makes the pass due again.
   */
  async summarized() {
    if (this.running) this.summaryDuringPass = true
    await this.state.reflectionDue()
    return this.check()
  }

  /**
   * A forget changed the state: the position is the newest entry, and a stored answer lost its adds that are not
   * written. The request that runs stops, and its answer is discarded.
   */
  forgotten() {
    this.abort?.abort()
  }

  /** Looks at the state, and starts a pass or a timer. One check runs at a time. */
  check() {
    const next = this.checking.then(() => this.#check())
    this.checking = next.catch(error => logFailure('log.reflection.failed', error))
    return this.checking
  }

  async close() {
    this.closed = true
    this.#clearTimer()
    this.abort?.abort()
    await this.checking
    await this.running
  }

  async #check() {
    if (this.closed || this.running) return
    this.#clearTimer()
    const turns = this.turns
    const snapshot = await this.state.snapshot()
    const reflection = snapshot.memoryReflection
    if (!reflection || snapshot.current || turns !== this.turns) return
    const on = this.values()['memory.reflection']
    if (reflection.pass) {
      // The setting went off after the answer: the writes do not occur, and the position moves past the conversation.
      if (!on) return this.#skip()
      return this.#start(() => this.#finish(reflection.pass))
    }
    // With the setting off, the position follows each turn of the user, so a later pass does not read that conversation.
    if (!on) return reflection.due || reflection.userTurns > 0 ? this.#skip() : undefined
    if (!reflection.due) return
    const now = this.clock.now()
    const at = this.idleSince + REFLECTION_IDLE_MS
    if (now < at) return this.#wake(at - now)
    if (this.sleeping()) {
      const start = nextWorkdayStart(this.workday(), now) ?? Infinity
      return this.#wake(Math.min(RECHECK_MS, start - now))
    }
    // The spend of the day changes only with a request, and a request comes with a turn. So the next turn looks again.
    if (this.spent()) { logEvent('log.reflection.limit'); return }
    this.#start(() => this.#run(reflection))
  }

  /**
   * Runs the pass [task]. A turn that ends during the pass finds it running and starts no timer, so the end of the pass
   * looks at the state again: a pass that is still due waits for the idle time.
   */
  #start(task) {
    this.summaryDuringPass = false
    this.running = task().finally(async () => {
      if (this.summaryDuringPass && !this.closed) await this.state.reflectionDue().catch(error => logFailure('log.reflection.failed', error))
      this.summaryDuringPass = false
      this.running = undefined
      this.check()
    })
  }

  /** Moves the position to the newest entry without a request, because the setting is off. */
  async #skip() {
    const { lastEntryId } = await this.#transcript(Infinity)
    await this.state.reflectionSkipped(lastEntryId)
    logEvent('log.reflection.off', lastEntryId)
  }

  #wake(delayMs) {
    if (this.closed) return
    this.timer = this.clock.setTimeout(() => {
      this.timer = undefined
      this.check()
    }, Math.max(0, delayMs))
  }

  #clearTimer() {
    if (this.timer !== undefined) this.clock.clearTimeout(this.timer)
    this.timer = undefined
  }

  /** The entries after [through], in pages. [through] `Infinity` reads only the ID of the newest entry. */
  async #transcript(through) {
    if (through === Infinity) {
      const newest = await this.read.newest()
      return { items: [], lastEntryId: newest }
    }
    const entries = []
    let cursor
    do {
      const page = await this.read.entries(through + 1, cursor)
      entries.push(...page.items)
      cursor = page.next
    } while (cursor)
    return reflectionItems(entries, through)
  }

  async #run(reflection) {
    const abort = this.abort = new AbortController()
    try {
      const { items, lastEntryId } = await this.#transcript(reflection.throughEntryId)
      if (abort.signal.aborted) return logEvent('log.reflection.stopped')
      const conversation = transcriptJson(items)
      // Without a message of the user, the pass needs no request.
      if (!conversation.includes('{"role":"user"'))
        return await this.state.reflectionDone({ id: null, throughEntryId: lastEntryId, userTurns: reflection.userTurns })
      const limit = this.values()['memory.characters']
      const topics = await this.memory.topics()
      const text = [`<conversation>\n${conversation}\n</conversation>`, `<memory>\n${await this.memory.section(limit)}\n</memory>`,
        ...(topics.length ? [message('memory.reflection.topics', topics.join('; '))] : []), this.prompt.instructions].join('\n\n')
      const answer = await this.complete({ system: this.prompt.system, text, signal: abort.signal, characters: conversation.length })
      // Only a close or a forget stops the request. An answer that stopped for another reason, also at the time limit,
      // is a failure, so the pass waits for the next trigger and does not pay for the same request again and again.
      if (abort.signal.aborted) return logEvent('log.reflection.stopped')
      if (answer.stopReason !== 'stop' && answer.stopReason !== 'length') throw new Error(`reflection ${answer.stopReason}`)
      const parsed = parseReflection(blockText(answer.content), { complete: answer.stopReason === 'stop' })
      // A proposal goes into the prompt of the next turn, so it passes the checks of an entry and the topic rule.
      const proposals = parsed.proposals.filter(proposal => [...proposal].length <= ENTRY_LIMIT && !unsafeReason(proposal, this.memory.secrets)
        && !forgottenTopic(proposal, topics))
      const pass = { id: randomUUID(), throughEntryId: lastEntryId, userTurns: reflection.userTurns, adds: parsed.adds, proposals,
        dropped: parsed.proposals.length - proposals.length, lines: [] }
      // A forget during the request moved the position, so the answer of the conversation before the forget is discarded.
      if (!await this.state.reflectionAnswered(pass, reflection.throughEntryId)) return logEvent('log.reflection.stopped')
      return await this.#finish(pass)
    }
    catch (error) {
      if (abort.signal.aborted) return logEvent('log.reflection.stopped')
      logFailure('log.reflection.failed', error)
      await this.state.reflectionFailed().catch(() => {})
    }
    finally { if (this.abort === abort) this.abort = undefined }
  }

  /**
   * The writes of the stored [pass], from the first add without a record of the pass. A write that a restart cut off
   * runs again with its request ID, so the record of `memoryWrites` gives its result, and the file gets no second copy.
   */
  async #finish(pass) {
    try { await this.#writes(pass) }
    catch (error) {
      // A pass whose writes fail does not start again in a loop: it keeps the writes that it did, and the position moves.
      logFailure('log.reflection.failed', error)
      if (this.closed) return
      await this.state.reflectionDone(pass).catch(() => {})
    }
  }

  /**
   * The writes of [pass]. The check of the stored answer and the record of the outcome run in the queue of the memory,
   * as the write of a forget does. So after a forget, no add of the answer that the forget dropped gets into the file.
   */
  async #writes(pass) {
    const limit = this.values()['memory.characters']
    let refused = 0
    for (let index = pass.lines.length; index < pass.adds.length; index++) {
      const requestId = `reflection:${pass.id}:${index}`
      const recorded = (await this.state.snapshot()).memoryWrites?.[requestId]
      const add = pass.adds[index]
      const result = await this.memory.change({ action: 'add', section: add.section, text: add.text }, limit, {
        recorded, record: write => this.state.memoryWritten(requestId, write),
        proceed: async () => { const stored = (await this.state.snapshot()).memoryReflection?.pass; return stored?.id === pass.id && index < stored.adds.length },
        settled: result => this.state.reflectionAdded(pass.id, index, result.changed ? result.line : null) })
      if (result.reason === 'stopped') break
      if (!result.changed) {
        refused++
        logEvent('log.reflection.refused', result.reason)
      }
    }
    const done = await this.state.reflectionDone(pass)
    logEvent('log.reflection.result', done.lines.length, refused, pass.dropped ?? 0, done.proposals)
  }
}

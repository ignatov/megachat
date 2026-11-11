import { readFile } from 'node:fs/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createRegistry, defineExtension, defineTool, Harness } from '@earendil-works/pi-durable'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { composeInstructions } from './MegachatHome.mjs'
import { MegachatState, terminalStates } from './MegachatState.mjs'
import { logFailure, message, requireCondition } from './messages.mjs'
import { waitForState } from './waitForState.mjs'
import { SessionHistoryService } from './SessionHistoryService.mjs'
import { entryText, MegachatSearchIndex, queryTerms, snippet } from './MegachatSearchIndex.mjs'

const context = BACKGROUND_CONTEXT
const result = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }] })

export class PiMegachatService {
  static async open(storage, models, model = { provider: 'anthropic', modelId: 'claude-opus-5-5' }, sessionProviders, { searchPath, resumeDelayMs, reportRetryDelayMs, userInstructionsPath } = {}) {
    const registry = createRegistry()
    const harness = await Harness.open(storage, {
      models, registry,
      settings: { retry: { enabled: false }, stream: { timeoutMs: 60000, maxRetries: 0 } },
      // Pi Durable reports each failure of a task, an extension or the storage here, and nowhere else.
      onReport: report => logFailure('log.report', report.error, [report.kind, report.reason, report.extension, report.task?.kind]
        .filter(part => typeof part === 'string' && /^[\w.:-]{1,64}$/.test(part)).join(' ')),
    }, context)
    const instructions = await composeInstructions(
      await readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8'), userInstructionsPath)
    const root = await harness.root(context, { agent: { model, thinkingLevel: 'low', maxTurns: 20, instructions } })
    await root.configure({ model, instructions }, context)
    const state = new MegachatState(harness, root, { resumeDelayMs, reportRetryDelayMs })
    await state.initialize()
    await state.recover()
    const service = new PiMegachatService(harness, root, state, sessionProviders)
    if (searchPath) service.search = await MegachatSearchIndex.open(searchPath, (minEntryId, cursor) =>
      root.entries({ order: 'ascending', minEntryId }, 200, cursor, context))
    registry.install(service.extension())
    return service
  }

  constructor(harness, root, state, sessionProviders) {
    this.harness = harness
    this.root = root
    this.state = state
    this.sessions = new SessionHistoryService(state, sessionProviders)
    this.waiters = new Map()
    this.lifetime = new AbortController()
    this.eventPump = Promise.resolve()
    this.pendingUserInputs = 0
    // A storage error ends the harness. Each later request then fails, so the owner of this service must stop.
    this.failed = new Promise(resolve => {
      harness.closed.then(end => { if (end.kind === 'failed') resolve(end.error) }, () => {})
    })
  }

  extension() {
    const tool = (name, parameters, execute) => defineTool({
      name: `agents_${name}`, description: message(`tool.${name}`), parameters, replay: 'safe', execute,
    })
    const inspect = async args => result(await this.state.readRun(args.runId))
    return defineExtension({ name: 'air.megachat', tools: [
      tool('list', obj({}), async () => {
        const state = await this.state.snapshot()
        const { declines, silenced, suggestion } = state.initiative
        const runs = Object.values(state.runs).map(run => ({ runId: run.id, childSessionId: run.childSessionId, agent: run.agent ?? 'claude',
          cwd: run.cwd, status: run.status, title: run.title, prompt: run.prompt.slice(0, 200) }))
        return result({ agents: ['claude', 'codex'], workspaces: state.workspaces, runs, initiative: { declines, silenced, suggestion } })
      }),
      tool('history', obj({ beforeEntryId: opt(int({ minimum: 1 })), query: opt(str({ maxLength: 200 })), cursor: opt(str({ maxLength: 20 })) }),
        async args => result(await this.history(args))),
      tool('sessions', obj({ cwd: str(), agent: opt(str()), query: opt(str({ maxLength: 200 })), cursor: opt(str()) }),
        async args => result(await this.sessions.search(args))),
      tool('session_history', obj({ cwd: str(), agent: str(), sessionId: str(), query: opt(str({ maxLength: 200 })), cursor: opt(str()) }),
        async args => result(await this.sessions.read(args))),
      tool('suggest', obj({ proposal: str() }), async (args, api) =>
        result(await this.state.proposal(`tool:${api.taskId}:suggest`, args.proposal))),
      tool('feedback', obj({ decision: str() }), async (args, api) =>
        result(await this.state.feedback(`tool:${api.taskId}:feedback`, args.decision))),
      tool('spawn', obj({ cwd: str(), prompt: str(), agent: opt(str()), title: opt(str({ maxLength: 60 })) }), async (args, api) =>
        result(await this.state.admitChild(`tool:${api.taskId}:spawn`, args))),
      tool('resume', obj({ cwd: str(), agent: str(), sessionId: str(), prompt: str(), title: opt(str({ maxLength: 60 })) }), async (args, api) => {
        await this.sessions.read(args)
        return result(await this.state.admitChild(`tool:${api.taskId}:resume`, {
          cwd: args.cwd, agent: args.agent, providerSessionId: args.sessionId, prompt: args.prompt, title: args.title,
        }))
      }),
      tool('send', obj({ childSessionId: str(), cwd: str(), prompt: str(), title: opt(str({ maxLength: 60 })) }), async (args, api) =>
        result(await this.state.admitChild(`tool:${api.taskId}:send`, args))),
      tool('inspect', obj({ runId: str() }), inspect),
      tool('wait', obj({ runId: str() }), inspect),
      tool('cancel', obj({ runId: str() }), async args => {
        const state = await this.state.snapshot()
        requireCondition(state.current, 'inactive')
        await this.state.cancel(state.current.id, args.runId)
        return result(await this.state.readRun(args.runId))
      }),
      tool('close', obj({ childSessionId: str() }), async args => {
        await this.state.closeChild(args.childSessionId)
        return result({ closed: true })
      }),
    ] })
  }

  async resume() {
    const snapshot = await this.state.snapshot()
    if (snapshot.current) this.follow(snapshot.inputs[snapshot.current.requestId])
    this.eventWatch = await this.state.watch()
    const observe = snapshot => {
      if (snapshot.current) return
      const now = Date.now()
      const unreported = Object.values(snapshot.runs).filter(run => terminalStates.has(run.status) && !run.reported)
      const resultsPending = unreported.some(run => (run.reportAfter ?? 0) <= now)
      // A report that waits for its repeat changes no state when its time comes. So a timer looks again.
      const waiting = unreported.filter(run => run.reportAfter > now).map(run => run.reportAfter)
      if (waiting.length && !this.reportTimer && !this.lifetime.signal.aborted) {
        this.reportTimer = setTimeout(() => {
          this.reportTimer = null
          this.state.snapshot().then(observe).catch(() => {})
        }, Math.min(...waiting) - now)
        this.reportTimer.unref()
      }
      const projectPending = !snapshot.initiative.silenced && Object.keys(snapshot.initiative.pending).length > 0
      if (!resultsPending && !projectPending) return
      this.eventPump = this.eventPump.then(async () => {
        if (this.lifetime.signal.aborted || this.pendingUserInputs) return
        const receipt = await this.state.nextChildResults() ?? await this.state.nextProjectEvent()
        if (receipt) this.follow(receipt)
      }).catch(error => {
        if (this.lifetime.signal.aborted) return
        process.stderr.write(`${message('error.event')}\n`)
        logFailure('log.event', error)
      })
    }
    observe(this.eventWatch.value)
    this.eventWatch.start(call => { if (call.kind === 'value') observe(call.value) })
    this.harness.resume()
  }

  async submit(requestId, text) {
    this.pendingUserInputs++
    try {
      const interrupted = await this.state.interruptAutomaticTurn()
      if (interrupted) {
        await this.root.abort(context)
        await waitForState(this.state, state => !state.current ? true : undefined,
          { signal: this.lifetime.signal, timeoutMs: 60000 })
      }
      const receipt = await this.state.submit(requestId, text)
      if (receipt.status === 'running') this.follow(receipt)
      return receipt
    }
    finally { this.pendingUserInputs-- }
  }

  follow(receipt) {
    if (this.waiters.has(receipt.mainRunId)) return
    const promise = this.finish(receipt)
    this.waiters.set(receipt.mainRunId, promise)
    promise.finally(() => this.waiters.delete(receipt.mainRunId)).catch(() => {})
  }

  async finish(receipt) {
    let status
    let reason
    try {
      const submission = await this.harness.submission(receipt.continuationId ?? receipt.submissionId, context)
      const settled = await submission.wait(context)
      status = settled.status === 'done' ? 'completed' : 'interrupted'
      if (settled.status !== 'done') reason = settled.reason
    }
    catch { this.lifetime.signal.throwIfAborted(); status = 'interrupted' }
    await this.state.settleInput(receipt.mainRunId, status, reason)
    this.search?.catchUp().catch(() => {
      if (!this.lifetime.signal.aborted) process.stderr.write(`${message('error.search')}\n`)
    })
  }

  /** Cancels the current turn. With [expectedRunId], it cancels only that turn, and tells whether it did. */
  async cancel(expectedRunId) {
    const snapshot = await this.state.snapshot()
    if (!snapshot.current || expectedRunId && snapshot.current.id !== expectedRunId) return false
    await this.state.cancel(snapshot.current.id)
    await this.root.abort(context)
    return true
  }

  /** Reads the retained transcript, including entries outside the active model context. */
  async history({ beforeEntryId, query = '', cursor } = {}) {
    requireCondition(beforeEntryId === undefined || Number.isSafeInteger(beforeEntryId) && beforeEntryId > 0)
    requireCondition(typeof query === 'string' && query.length <= 200)
    requireCondition(cursor === undefined || /^\d{1,9}$/.test(cursor))
    if (this.search && beforeEntryId === undefined && queryTerms(query).length) return this.searchHistory(query, Number(cursor ?? 0))
    const page = await this.root.entries({ order: 'descending',
      ...(beforeEntryId === undefined ? {} : { maxEntryId: beforeEntryId - 1 }),
    }, 50, undefined, context)
    const entries = []
    let characters = 0
    let scanned = 0
    let lastId
    for (const entry of page.items) {
      if (characters >= 24000) break
      scanned++
      lastId = entry.id
      if (entry.kind === 'air.megachat.event' || entry.head !== undefined) continue
      for (const model of entry.model ?? []) {
        if (model.role !== 'user' && model.role !== 'assistant') continue
        const text = typeof model.content === 'string' ? model.content
          : model.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
        const match = text.toLowerCase().indexOf(query.toLowerCase())
        if (!text || match < 0) continue
        const textOffset = Math.max(0, match - 2000)
        const retained = text.slice(textOffset, textOffset + 12000)
        entries.push({ entryId: entry.id, role: model.role,
          timestamp: Number.isFinite(model.timestamp) ? new Date(model.timestamp).toISOString() : null,
          text: retained, textOffset, truncated: retained.length < text.length })
        characters += retained.length
      }
    }
    return { entries, scannedEntries: scanned,
      nextBeforeEntryId: page.next || scanned < page.items.length ? lastId : null,
      now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  }

  /** Ranked matches from the search index; `nextCursor` pages through them. */
  async searchHistory(query, offset) {
    await this.search.catchUp()
    const found = await this.search.search(query, { limit: 10, offset })
    const hits = []
    for (const entryId of found.ids) {
      const [entry] = (await this.root.entries({ minEntryId: entryId, maxEntryId: entryId }, 1, undefined, context)).items
      const indexed = entry && entryText(entry, { full: true })
      if (!indexed) { await this.search.remove(entryId); continue }
      hits.push({ entryId, role: indexed.role,
        timestamp: Number.isFinite(indexed.timestamp) ? new Date(indexed.timestamp).toISOString() : null,
        snippet: snippet(indexed.text, found.terms) })
    }
    return { query, hits, nextCursor: found.more ? String(offset + found.ids.length) : null,
      indexedThroughEntryId: await this.search.lastEntryId(),
      now: new Date().toISOString(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
  }

  async view() {
    const watch = await this.root.watch(context, { min: 100, max: 200 })
    const value = watch.value
    await watch.stop()
    return value
  }

  async close() {
    this.lifetime.abort()
    clearTimeout(this.reportTimer)
    await this.eventWatch?.stop()
    await this.eventPump.catch(() => {})
    await this.search?.close()
    await this.harness.close(context)
    await Promise.allSettled([...this.waiters.values()])
    await this.sessions.close()
  }
}

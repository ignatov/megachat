import { readFile, realpath } from 'node:fs/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import { CompactionTask, createRegistry, DEFAULT_COMPACTION_POLICY, defineExtension, defineTool, Harness, hook, ProviderDoc } from '@earendil-works/pi-durable'
import { int, obj, opt, str } from '@earendil-works/pi-schema'
import { composeInstructions, ensurePrivateDirectory } from './MegachatHome.mjs'
import { MegachatState, terminalStates } from './MegachatState.mjs'
import { logEvent, logFailure, message, requireCondition } from './messages.mjs'
import { directoriesOf } from './ProjectDirectories.mjs'
import { keepAliveSettings, PromptCacheKeepAlive } from './PromptCacheKeepAlive.mjs'
import { STREAM_INTERVAL_MS } from './ReplyStream.mjs'
import { suggestionsEnabled } from './Suggestions.mjs'
import { waitForState } from './waitForState.mjs'
import { SessionHistoryService } from './SessionHistoryService.mjs'
import { entryText, MegachatSearchIndex, queryTerms, snippet } from './MegachatSearchIndex.mjs'

const context = BACKGROUND_CONTEXT
const result = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }] })

/** The size of the model context, in tokens, above which the conversation gets a summary. This variable replaces it. */
export const COMPACT_TOKENS_VARIABLE = 'MEGACHAT_COMPACT_TOKENS'
export const DEFAULT_COMPACT_TOKENS = 100000
/** A summary request reads the whole context that it replaces, so it gets more time than a reply. */
const SUMMARY_TIMEOUT_MS = 600000
const SUMMARY_MAX_TOKENS = 16000
const SUMMARY_TOOL_RESULT_LIMIT = 2000
const SUMMARY_TASK_LIMIT = 30
/** The main agent and a keep-alive request think at the same level. Another level would miss the prompt cache. */
const THINKING_LEVEL = 'low'
const STREAM_TIMEOUT_MS = 60000
/** The lifetimes of the prompt cache of a model that states none: those of Anthropic. */
const CACHE_LIFETIME_SECONDS = { short: 300, long: 3600 }

export function compactTokens(environment = process.env) {
  const value = environment[COMPACT_TOKENS_VARIABLE]
  return value !== undefined && /^[1-9]\d{0,8}$/.test(value.trim()) ? Number(value.trim()) : DEFAULT_COMPACT_TOKENS
}

/**
 * Pi Durable has no absolute limit. It starts a summary in the background above
 * `contextWindow - reserveTokens - backgroundTokens`, and a request waits for a summary above
 * `contextWindow - reserveTokens`. So the reserve puts the background limit at [tokens]. A model with a window that is
 * too small for this keeps the limits of Pi Durable.
 */
export function compactionSettings(contextWindow, tokens) {
  const reserveTokens = contextWindow - tokens - DEFAULT_COMPACTION_POLICY.backgroundTokens
  return reserveTokens >= DEFAULT_COMPACTION_POLICY.reserveTokens ? { reserveTokens } : {}
}

const blockText = content => typeof content === 'string' ? content
  : content.filter(block => block.type === 'text').map(block => block.text).join('\n')

/** The messages as plain text, so that the model reads a transcript and does not continue it. */
function transcript(messages) {
  const parts = []
  for (const model of messages) {
    if (model.role === 'user' && blockText(model.content)) parts.push(`[User]: ${blockText(model.content)}`)
    if (model.role === 'assistant') {
      if (blockText(model.content)) parts.push(`[Assistant]: ${blockText(model.content)}`)
      const calls = model.content.filter(block => block.type === 'toolCall')
        .map(block => `${block.name}(${JSON.stringify(block.arguments ?? {})})`)
      if (calls.length) parts.push(`[Assistant tool calls]: ${calls.join('; ')}`)
    }
    if (model.role === 'toolResult' && blockText(model.content))
      parts.push(`[Tool result]: ${blockText(model.content).slice(0, SUMMARY_TOOL_RESULT_LIMIT)}`)
  }
  return parts.join('\n\n')
}

export class PiMegachatService {
  static async open(storage, models, model = { provider: 'anthropic', modelId: 'claude-opus-5-5' }, sessionProviders, { searchPath, resumeDelayMs, reportRetryDelayMs, userInstructionsPath, compactTokens: limit = compactTokens(), keepAlive: keepAliveOptions, workspacePath, stateDirectory, home, projectRoots, suggestions = suggestionsEnabled() } = {}) {
    // A task without a project works in this directory of Megachat, not in a directory of an IDE.
    if (workspacePath) await ensurePrivateDirectory(workspacePath)
    const workspace = workspacePath ? await realpath(workspacePath) : undefined
    const keepAlive = { ...keepAliveSettings(), ...keepAliveOptions }
    const registry = createRegistry()
    const contextWindow = models.getModel(model.provider, model.modelId)?.contextWindow ?? 0
    const harness = await Harness.open(storage, {
      models, registry,
      settings: { retry: { enabled: false }, stream: { timeoutMs: STREAM_TIMEOUT_MS, maxRetries: 0, cacheRetention: keepAlive.retention }, compaction: compactionSettings(contextWindow, limit),
        // Pi Durable puts the partial reply into `pi.live` at this interval. The daemon sends it to the chat from there.
        progress: { partialIntervalMs: STREAM_INTERVAL_MS } },
      // Pi Durable reports each failure of a task, an extension or the storage here, and nowhere else.
      onReport: report => logFailure('log.report', report.error, [report.kind, report.reason, report.extension, report.task?.kind]
        .filter(part => typeof part === 'string' && /^[\w.:-]{1,64}$/.test(part)).join(' ')),
    }, context)
    // Without suggestions, the rules have one line that stops a proposal. With suggestions, they have the suggestion rules.
    const bundled = await readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')
    const suggestionRules = suggestions ? await readFile(new URL('../resources/instructions-suggestions.md', import.meta.url), 'utf8')
      : `${message('instructions.noSuggestions')}\n`
    const instructions = await composeInstructions(`${bundled.trimEnd()}\n${suggestionRules}`, userInstructionsPath)
    const root = await harness.root(context, { agent: { model, thinkingLevel: THINKING_LEVEL, maxTurns: 20, instructions } })
    await root.configure({ model, instructions }, context)
    const state = new MegachatState(harness, root, { resumeDelayMs, reportRetryDelayMs, workspace, stateDirectory, home, projectRoots, suggestions })
    await state.initialize()
    await state.recover()
    const service = new PiMegachatService(harness, root, state, sessionProviders)
    service.suggestions = suggestions
    service.model = model
    service.models = models
    service.cacheRetention = keepAlive.retention
    if (keepAlive.enabled) service.keepAlive = new PromptCacheKeepAlive({
      ttlMs: (models.getModel(model.provider, model.modelId)?.promptCache?.[keepAlive.retention] ?? CACHE_LIFETIME_SECONDS[keepAlive.retention]) * 1000,
      windowMs: keepAlive.windowMs, compactTokens: limit, clock: keepAlive.clock,
      ...(keepAlive.minTokens === undefined ? {} : { minTokens: keepAlive.minTokens }),
      tokens: () => service.contextTokens(), ping: signal => service.ping(signal), compact: () => service.compact(),
    })
    // The first paragraph of the file is the system prompt of a summary request. The rest follows the conversation.
    const [system, ...rest] = (await readFile(new URL('../resources/compaction.md', import.meta.url), 'utf8')).trim().split('\n\n')
    service.summaryPrompt = { system, instructions: rest.join('\n\n') }
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
    return defineExtension({ name: 'air.megachat', hooks: [
      hook(CompactionTask, { beforeCompact: (compaction, api, hookContext) => this.summarize(compaction, api, hookContext) }),
    ], tools: [
      tool('list', obj({}), async () => {
        const state = await this.state.snapshot()
        const runs = Object.values(state.runs).map(run => ({ runId: run.id, childSessionId: run.childSessionId, agent: run.agent ?? 'claude',
          cwd: run.cwd, status: run.status, title: run.title, prompt: run.prompt.slice(0, 200) }))
        return result({ agents: ['claude', 'codex'], workspaces: directoriesOf(state), runs,
          ...(this.suggestions ? { initiative: { declines: state.initiative.declines, silenced: state.initiative.silenced, suggestion: state.initiative.suggestion } } : {}) })
      }),
      tool('history', obj({ beforeEntryId: opt(int({ minimum: 1 })), query: opt(str({ maxLength: 200 })), cursor: opt(str({ maxLength: 20 })) }),
        async args => result(await this.history(args))),
      tool('sessions', obj({ cwd: str(), agent: opt(str()), query: opt(str({ maxLength: 200 })), cursor: opt(str()) }),
        async args => result(await this.sessions.search(args))),
      tool('session_history', obj({ cwd: str(), agent: str(), sessionId: str(), query: opt(str({ maxLength: 200 })), cursor: opt(str()) }),
        async args => result(await this.sessions.read(args))),
      // The suggestion tools exist only with `MEGACHAT_SUGGESTIONS=1`. The stored suggestion state stays without them.
      ...(this.suggestions ? [
        tool('suggest', obj({ proposal: str() }), async (args, api) =>
          result(await this.state.proposal(`tool:${api.taskId}:suggest`, args.proposal))),
        tool('feedback', obj({ decision: str() }), async (args, api) =>
          result(await this.state.feedback(`tool:${api.taskId}:feedback`, args.decision))),
      ] : []),
      tool('projects', obj({ action: str(), cwd: opt(str({ maxLength: 4096 })) }), async args => {
        requireCondition(['list', 'add', 'remove'].includes(args.action))
        const changed = args.action === 'add' ? { added: (await this.state.addProject(args.cwd)).cwd }
          : args.action === 'remove' ? { removed: (await this.state.removeProject(args.cwd)).cwd } : {}
        return result({ ...changed, workspaces: directoriesOf(await this.state.snapshot()) })
      }),
      tool('spawn', obj({ cwd: str(), prompt: str(), agent: opt(str()), title: opt(str({ maxLength: 60 })) }), async (args, api) =>
        result(await this.state.admitChild(`tool:${api.taskId}:spawn`, { ...args, cwd: await this.state.directory(args.cwd) }))),
      tool('resume', obj({ cwd: str(), agent: str(), sessionId: str(), prompt: str(), title: opt(str({ maxLength: 60 })) }), async (args, api) => {
        await this.sessions.read(args)
        return result(await this.state.admitChild(`tool:${api.taskId}:resume`, {
          cwd: await this.state.directory(args.cwd), agent: args.agent, providerSessionId: args.sessionId, prompt: args.prompt, title: args.title,
        }))
      }),
      tool('send', obj({ childSessionId: str(), cwd: str(), prompt: str(), title: opt(str({ maxLength: 60 })) }), async (args, api) =>
        result(await this.state.admitChild(`tool:${api.taskId}:send`, { ...args, cwd: await this.state.directory(args.cwd) }))),
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

  /**
   * Writes the summary of each compaction. Pi Durable gives its own instructions only to a manual compaction, so this
   * hook gives the instructions of Megachat to each one. The tasks come from the state, not from the model, so the
   * summary cannot lose them. Without a result, Pi Durable writes its own summary.
   */
  async summarize(compaction, api, hookContext) {
    const model = api.models.getModel(this.model.provider, this.model.modelId)
    if (!model) return undefined
    const focus = compaction.instructions ? `\n\nAdditional focus: ${compaction.instructions}` : ''
    const text = `<conversation>\n${transcript(compaction.messages)}\n</conversation>\n\n${this.summaryPrompt.instructions}${focus}`
    const answer = await api.models.completeSimple(model, { messages: [
      { role: 'system', content: this.summaryPrompt.system, timestamp: Date.now() },
      { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
    ] }, { timeoutMs: SUMMARY_TIMEOUT_MS, maxRetries: 0, cacheRetention: 'none', signal: hookContext?.abortSignal,
      maxTokens: model.maxTokens > 0 ? Math.min(SUMMARY_MAX_TOKENS, model.maxTokens) : SUMMARY_MAX_TOKENS })
    logEvent('log.summary', answer.usage.input, answer.usage.cacheRead, answer.usage.cacheWrite, answer.usage.output, answer.usage.cost?.total ?? 0)
    const summary = answer.stopReason === 'stop' && !answer.content.some(block => block.type === 'toolCall')
      ? blockText(answer.content).trim() : ''
    if (!summary) return undefined
    const state = await this.state.snapshot()
    const tasks = Object.values(state.runs)
      .filter(run => !terminalStates.has(run.status) || !run.reported)
      .slice(-SUMMARY_TASK_LIMIT)
      .map(run => `- ${run.status}: ${run.title ?? run.prompt.slice(0, 80)} (${run.agent ?? 'claude'}, ${run.cwd})`)
    return { summary: tasks.length ? `${summary}\n\n## Child tasks in the daemon state\n${tasks.join('\n')}` : summary }
  }

  /**
   * Replaces the older part of the model context with a summary, between turns. The retained conversation and the
   * search index keep each entry. A second call while one runs gets the result of the first.
   */
  compact() {
    return this.compacting ??= (async () => {
      await waitForState(this.state, state => !state.current ? true : undefined, { signal: this.lifetime.signal, timeoutMs: null })
      const taskId = await this.root.compact(undefined, context)
      const { outcome } = (await this.harness.waitForTask(taskId, context)).state
      if (outcome.status !== 'completed') return { compacted: false, reason: outcome.status }
      // No submission means that the context has nothing older than the part that stays.
      if (outcome.result.submissionId === undefined) return { compacted: false, reason: 'nothing' }
      const placed = await (await this.harness.submission(outcome.result.submissionId, context)).wait(context)
      return placed.status === 'done' ? { compacted: true } : { compacted: false, reason: placed.reason ?? placed.status }
    })().finally(() => { this.compacting = undefined })
  }

  /**
   * The size of the next model request: the usage of the last reply, plus an estimate of the messages after it.
   * A summary replaces the reply with the usage, so the context after a summary has an estimate only.
   */
  async contextTokens() {
    const { messages } = await this.root.context(context)
    const measured = messages.findLastIndex(model => model.role === 'assistant' && calculateContextTokens(model.usage) > 0)
    return messages.slice(measured + 1).reduce((sum, model) => sum + estimateMessageTokens(model),
      measured < 0 ? 0 : calculateContextTokens(messages[measured].usage))
  }

  /**
   * Sends the model context as the main agent sends it, for one output token. The request reads the prompt cache, and
   * that starts the lifetime of the cache again. The conversation does not get the reply. Returns the usage.
   */
  async ping(signal) {
    const model = this.models.getModel(this.model.provider, this.model.modelId)
    const { messages } = await this.root.context(context)
    const answer = await this.models.completeSimple(model, { messages: [...messages] }, {
      timeoutMs: STREAM_TIMEOUT_MS, maxRetries: 0, cacheRetention: this.cacheRetention, maxTokens: 1, reasoning: THINKING_LEVEL, signal,
      sessionId: (await this.harness.snapshot(ProviderDoc, this.root.id, context))?.sessionId,
    })
    if (answer.stopReason === 'error') throw new Error('keep-alive')
    return answer.usage
  }

  /** The time of the last message of the model context. After a restart, it stands for the last model request. */
  async lastMessageTime() {
    const { messages } = await this.root.context(context)
    return messages.findLast(model => Number.isFinite(model.timestamp))?.timestamp
  }

  async resume() {
    const snapshot = await this.state.snapshot()
    if (snapshot.current) this.follow(snapshot.inputs[snapshot.current.requestId])
    if (snapshot.current) this.keepAlive?.turnStarted()
    else {
      const last = await this.lastMessageTime()
      if (last !== undefined) this.keepAlive?.turnEnded(last)
    }
    let running = Boolean(snapshot.current)
    this.eventWatch = await this.state.watch()
    const observe = snapshot => {
      if (running !== Boolean(snapshot.current)) {
        running = Boolean(snapshot.current)
        if (running) this.keepAlive?.turnStarted()
        else this.keepAlive?.turnEnded()
      }
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
    await this.keepAlive?.close()
    await this.eventWatch?.stop()
    await this.eventPump.catch(() => {})
    await this.search?.close()
    await this.harness.close(context)
    await Promise.allSettled([...this.waiters.values()])
    await this.sessions.close()
  }
}

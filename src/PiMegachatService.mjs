import { readFile, realpath } from 'node:fs/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import { CompactionTask, createRegistry, DEFAULT_COMPACTION_POLICY, defineExtension, defineTool, Harness, hook, ProviderDoc } from '@earendil-works/pi-durable'
import { bool, int, num, obj, opt, str, union } from '@earendil-works/pi-schema'
import { ensurePrivateDirectory, readUserInstructions, withUserInstructions } from './MegachatHome.mjs'
import { MegachatState, terminalStates } from './MegachatState.mjs'
import { logEvent, logFailure, message, requireCondition } from './messages.mjs'
import { directoriesOf } from './ProjectDirectories.mjs'
import { PromptCacheKeepAlive } from './PromptCacheKeepAlive.mjs'
import { STREAM_INTERVAL_MS } from './ReplyStream.mjs'
import { CACHE_RETENTION, environmentSetting, MegachatSettings, modelRef, SettingsStore } from './Settings.mjs'
import { waitForState } from './waitForState.mjs'
import { SessionHistoryService } from './SessionHistoryService.mjs'
import { entryText, MegachatSearchIndex, queryTerms, snippet } from './MegachatSearchIndex.mjs'

const context = BACKGROUND_CONTEXT
const result = value => ({ output: [{ type: 'text', text: JSON.stringify(value) }] })

export { COMPACT_TOKENS_VARIABLE, DEFAULT_COMPACT_TOKENS } from './Settings.mjs'
/** A summary request reads the whole context that it replaces, so it gets more time than a reply. */
const SUMMARY_TIMEOUT_MS = 600000
const SUMMARY_MAX_TOKENS = 16000
const SUMMARY_TOOL_RESULT_LIMIT = 2000
const SUMMARY_TASK_LIMIT = 30
const STREAM_TIMEOUT_MS = 60000
/** The lifetimes of the prompt cache of a model that states none: those of Anthropic. */
const CACHE_LIFETIME_SECONDS = { short: 300, long: 3600 }
const resource = name => readFile(new URL(`../resources/${name}`, import.meta.url), 'utf8')

/** The limit of a summary from the environment alone, without the stored settings. */
export function compactTokens(environment = process.env) {
  return environmentSetting('compaction.tokens', environment)
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

/**
 * The settings of the harness for the effective [values]. Pi Durable reads them at each use, so a new value applies to
 * the next model request without a new harness.
 */
function harnessSettings(values, models) {
  const { provider, modelId } = modelRef(values['coordinator.model'])
  return {
    retry: { enabled: false },
    stream: { timeoutMs: STREAM_TIMEOUT_MS, maxRetries: 0, cacheRetention: CACHE_RETENTION[values['cache.ttl']] },
    compaction: compactionSettings(models.getModel(provider, modelId)?.contextWindow ?? 0, values['compaction.tokens']),
    // Pi Durable puts the partial reply into `pi.live` at this interval. The daemon sends it to the chat from there.
    progress: { partialIntervalMs: STREAM_INTERVAL_MS },
  }
}

/**
 * The rules of the main agent that the settings give: the reply style, the suggestion rules, and the setup rules while
 * the onboarding is pending. The defaults give the rules from before the settings. The rules are a section of their
 * own, so a change sends only this section to the model again, and not the bundled rules.
 */
function settingsRules(values, onboarding, rules) {
  const language = values['reply.language']
  return [
    message(`instructions.length.${values['reply.length']}`),
    language === 'auto' ? message('instructions.language.auto') : message('instructions.language', language),
    ...(values['reply.quoteRequest'] ? [message('instructions.quoteRequest')] : []),
    values['reply.suggestions'] ? rules.suggestions.trimEnd() : message('instructions.noSuggestions'),
    onboarding === 'pending' ? rules.onboarding.trimEnd() : message('instructions.settings'),
  ].join('\n')
}

/** The choices of the root conversation that the settings give. The rules of the user follow the bundled rules. */
function agentOf(values, rules) {
  return { model: modelRef(values['coordinator.model']), thinkingLevel: values['coordinator.thinking'],
    instructions: withUserInstructions(rules.bundled, rules.user) }
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
  /**
   * An explicit [model], `compactTokens`, `suggestions` or `keepAlive` setting wins over the environment and over
   * `settings.json`, for a test. The daemon passes none of them.
   */
  static async open(storage, models, model, sessionProviders, { searchPath, resumeDelayMs, reportRetryDelayMs, userInstructionsPath, settingsPath, compactTokens: limit, keepAlive: keepAliveOptions = {}, workspacePath, stateDirectory, home, projectRoots, suggestions, environment = process.env } = {}) {
    // A task without a project works in this directory of Megachat, not in a directory of an IDE.
    if (workspacePath) await ensurePrivateDirectory(workspacePath)
    const workspace = workspacePath ? await realpath(workspacePath) : undefined
    const { windowMs, retention, enabled } = keepAliveOptions
    const overrides = Object.fromEntries(Object.entries({
      'coordinator.model': model && `${model.provider}/${model.modelId}`, 'compaction.tokens': limit, 'reply.suggestions': suggestions,
      'keepAlive.enabled': enabled, 'keepAlive.hours': windowMs === undefined ? undefined : windowMs / 3600000,
      'cache.ttl': retention === undefined ? undefined : retention === 'short' ? '5m' : '1h',
    }).filter(([, value]) => value !== undefined))
    const settings = new MegachatSettings(await SettingsStore.open(settingsPath), { environment, overrides, models })
    const values = settings.values()
    // The rules of the user come from the file at the start of the daemon only.
    const rules = { bundled: await resource('instructions.md'), suggestions: await resource('instructions-suggestions.md'),
      onboarding: await resource('instructions-onboarding.md'), user: await readUserInstructions(userInstructionsPath) }
    const live = { harness: harnessSettings(values, models) }
    const registry = createRegistry()
    const harness = await Harness.open(storage, {
      models, registry, settings: () => live.harness,
      // Pi Durable reports each failure of a task, an extension or the storage here, and nowhere else.
      onReport: report => logFailure('log.report', report.error, [report.kind, report.reason, report.extension, report.task?.kind]
        .filter(part => typeof part === 'string' && /^[\w.:-]{1,64}$/.test(part)).join(' ')),
    }, context)
    const agent = agentOf(values, rules)
    const root = await harness.root(context, { agent: { ...agent, maxTurns: 20 } })
    await root.configure(agent, context)
    const state = new MegachatState(harness, root, { resumeDelayMs, reportRetryDelayMs, workspace, stateDirectory, home, projectRoots, suggestions: values['reply.suggestions'] })
    await state.initialize()
    await state.recover()
    const service = new PiMegachatService(harness, root, state, sessionProviders)
    Object.assign(service, { models, registry, settings, rules, live, agent, keepAliveOptions })
    service.adopt(values)
    // The first paragraph of the file is the system prompt of a summary request. The rest follows the conversation.
    const [system, ...rest] = (await resource('compaction.md')).trim().split('\n\n')
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
    // The keep-alive objects that a change of a setting replaced. Their last request can still run.
    this.retired = []
    this.settingsPending = false
    this.applying = Promise.resolve()
    // A storage error ends the harness. Each later request then fails, so the owner of this service must stop.
    this.failed = new Promise(resolve => {
      harness.closed.then(end => { if (end.kind === 'failed') resolve(end.error) }, () => {})
    })
  }

  /**
   * Takes the effective [values] for each part of the service that reads a setting outside the stored choices of the
   * root conversation: the harness settings, the rules of the section `settings`, the model of a summary and of a
   * keep-alive request, the suggestion tools, and the keep-alive.
   * Returns true when the keep-alive is new.
   */
  adopt(values) {
    this.values = values
    this.onboarding = this.settings.onboarding
    this.live.harness = harnessSettings(values, this.models)
    this.model = modelRef(values['coordinator.model'])
    this.thinkingLevel = values['coordinator.thinking']
    this.cacheRetention = CACHE_RETENTION[values['cache.ttl']]
    this.suggestions = values['reply.suggestions']
    // With suggestions, the prompt of an event turn lets the main agent offer a next step.
    this.state.eventSuffix = this.suggestions ? '.suggest' : ''
    const ttlSeconds = this.models.getModel(this.model.provider, this.model.modelId)?.promptCache?.[this.cacheRetention]
      ?? CACHE_LIFETIME_SECONDS[this.cacheRetention]
    const keepAlive = values['keepAlive.enabled'] ? { ttlMs: ttlSeconds * 1000, windowMs: values['keepAlive.hours'] * 3600000,
      compactTokens: values['compaction.tokens'] } : null
    if (JSON.stringify(keepAlive) === this.keepAliveKey) return false
    this.keepAliveKey = JSON.stringify(keepAlive)
    if (this.keepAlive) this.retired.push(this.keepAlive.close().catch(() => {}))
    const { clock, minTokens } = this.keepAliveOptions
    this.keepAlive = keepAlive ? new PromptCacheKeepAlive({ ...keepAlive, clock, ...(minTokens === undefined ? {} : { minTokens }),
      tokens: () => this.contextTokens(), ping: signal => this.ping(signal), compact: () => this.compact() }) : undefined
    return true
  }

  /**
   * Applies the stored settings when no turn runs, else at the end of the turn. A change of the model, the thinking
   * level or the tools in the middle of a turn is not safe: a tool call of one model would then go to another model.
   */
  async settingsChanged() {
    this.settingsPending = true
    if (!(await this.state.snapshot()).current) await this.applySettings()
  }

  /** Applies the effective settings to the root conversation, the tools and the keep-alive. Calls run one at a time. */
  applySettings() {
    const next = this.applying.then(async () => {
      if (!this.settingsPending) return
      this.settingsPending = false
      const values = this.settings.values()
      const renewed = this.adopt(values)
      this.registry.install(this.extension())
      const agent = agentOf(values, this.rules)
      if (JSON.stringify(agent) !== JSON.stringify(this.agent)) {
        await this.root.configure(agent, context)
        this.agent = agent
      }
      logEvent('log.settings.applied')
      // A new keep-alive of an idle daemon starts from the last model request, as after a restart.
      if (renewed && this.keepAlive && this.resumed && !(await this.state.snapshot()).current) {
        const last = await this.lastMessageTime()
        if (last !== undefined) this.keepAlive.turnEnded(last)
      }
    })
    this.applying = next.catch(() => {})
    return next
  }

  /** The tool `agents_settings`. A project event or a child result cannot change a setting. */
  async settingsTool(args) {
    requireCondition(['get', 'set', 'reset', 'onboarding'].includes(args.action))
    if (args.action === 'get') return this.settings.describe()
    requireCondition(!['event', 'report'].includes((await this.state.snapshot()).current?.kind), 'settingEvent')
    let changed
    if (args.action === 'onboarding') {
      changed = await this.settings.setOnboarding(args.status)
      // A new setup starts in the same turn, so the agent gets the setup rules now and not only in the next turn.
      if (args.status === 'pending') changed.rules = this.rules.onboarding.trim()
    }
    else if (args.action === 'set') {
      requireCondition(args.value !== undefined, 'settingValue')
      changed = await this.settings.set(args.key, args.value)
    }
    else changed = await this.settings.reset(args.key)
    await this.settingsChanged()
    return changed
  }

  extension() {
    const tool = (name, parameters, execute) => defineTool({
      name: `agents_${name}`, description: message(`tool.${name}`), parameters, replay: 'safe', execute,
    })
    const inspect = async args => result(await this.state.readRun(args.runId))
    return defineExtension({ name: 'air.megachat', sections: [
      // The section reads the adopted settings, so a change in a turn reaches the model only in the next turn.
      { key: 'settings', render: () => settingsRules(this.values, this.onboarding, this.rules) },
    ], hooks: [
      hook(CompactionTask, { beforeCompact: (compaction, api, hookContext) => this.summarize(compaction, api, hookContext) }),
    ], tools: [
      tool('list', obj({}), async () => {
        const state = await this.state.snapshot()
        const runs = Object.values(state.runs).map(run => ({ runId: run.id, childSessionId: run.childSessionId, agent: run.agent ?? 'claude',
          cwd: run.cwd, status: run.status, title: run.title, prompt: run.prompt.slice(0, 200) }))
        return result({ agents: ['claude', 'codex'], workspaces: directoriesOf(state), runs,
          ...(this.suggestions ? { initiative: { declines: state.initiative.declines, silenced: state.initiative.silenced, suggestion: state.initiative.suggestion } } : {}) })
      }),
      tool('settings', obj({ action: str(), key: opt(str({ maxLength: 100 })), value: opt(union([str({ maxLength: 200 }), num(), bool()])),
        status: opt(str({ maxLength: 20 })) }), async args => result(await this.settingsTool(args))),
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
      timeoutMs: STREAM_TIMEOUT_MS, maxRetries: 0, cacheRetention: this.cacheRetention, maxTokens: 1, signal,
      // Pi Durable sends no reasoning option for the level `off`, so the keep-alive request does the same.
      ...(this.thinkingLevel === 'off' ? {} : { reasoning: this.thinkingLevel }),
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
    this.resumed = true
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
    // The turn still holds the state, so the next turn starts with the new settings.
    if (this.settingsPending) await this.applySettings().catch(error => logFailure('log.settings.failed', error))
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
    await Promise.allSettled(this.retired)
    await this.eventWatch?.stop()
    await this.eventPump.catch(() => {})
    await this.search?.close()
    await this.harness.close(context)
    await Promise.allSettled([...this.waiters.values()])
    await this.sessions.close()
  }
}

import { readFile, realpath } from 'node:fs/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { calculateContextTokens, estimateMessageTokens } from '@earendil-works/pi-ai/utils/estimate'
import { CompactionTask, createRegistry, DEFAULT_COMPACTION_POLICY, defineExtension, defineTool, GenerationTask, Harness, hook, InboxDoc, LiveDoc, ProviderDoc } from '@earendil-works/pi-durable'
import { arr, bool, int, num, obj, opt, str, union } from '@earendil-works/pi-schema'
import { DailySpend, requestCost } from './DailySpend.mjs'
import { ensurePrivateDirectory, readUserInstructions, withUserInstructions } from './MegachatHome.mjs'
import { MegachatMemory } from './MegachatMemory.mjs'
import { automaticKinds, findSteer, lastUserTurnEnd, MegachatState, permissionOpen, terminalStates } from './MegachatState.mjs'
import { updateTime } from './MegachatUpdate.mjs'
import { MemoryReflection, REFLECTION_MAX_TOKENS, REFLECTION_TIMEOUT_MS } from './MemoryReflection.mjs'
import { collectReportData, logReport, MorningReport, REPORT_RECHECK_MS, reportWorkday } from './MorningReport.mjs'
import { childAgent, childEnvironment, childExtension } from './PiChild.mjs'
import { PiChildHistory } from './PiChildHistory.mjs'
import { logEvent, logFailure, message, requireCondition } from './messages.mjs'
import { directoriesOf } from './ProjectDirectories.mjs'
import { PromptCacheKeepAlive } from './PromptCacheKeepAlive.mjs'
import { STOPPED_KIND, STREAM_INTERVAL_MS, stoppedReplyText } from './ReplyStream.mjs'
import { RunningAgents } from './RunningAgents.mjs'
import { AgentStop } from './AgentStop.mjs'
import { CACHE_RETENTION, CHILD_STEPS, environmentSetting, MegachatSettings, modelRef, notesOn, PROJECT_SETTINGS, SettingsStore, suggestionMode } from './Settings.mjs'
import { isNoteMessage, SessionNotes } from './SessionNotes.mjs'
import { waitForState } from './waitForState.mjs'
import { isSleeping, isWorkingDate, localDate, nextWorkdayStart, workdaySettings, zonedTime } from './Workday.mjs'
import { SessionHistoryService } from './SessionHistoryService.mjs'
import { SessionIndexService } from './SessionIndexService.mjs'
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
/** The steering request of the run service has a limit of 20 seconds, so the tool waits a little longer. */
const STEER_WAIT_MS = 30000
/** The lifetimes of the prompt cache of a model that states none: those of Anthropic. */
const CACHE_LIFETIME_SECONDS = { short: 300, long: 3600 }
const resource = name => readFile(new URL(`../resources/${name}`, import.meta.url), 'utf8')
/** The clock of the working day without a test. A timer does not keep the process alive. */
const workdayClock = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => { const timer = setTimeout(callback, delayMs); timer.unref(); return timer },
  clearTimeout: timer => clearTimeout(timer),
}
/**
 * The extension of the main agent. A conversation without its own choice selects only this extension, so the main
 * conversation does not get the tool `read` of a pi child, and a pi child, which selects its own extension, gets nothing
 * of the main agent.
 */
const MAIN_EXTENSION = 'air.megachat'

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
 * the next model request without a new harness. The limit of a summary is for the model of the main agent only: a pi
 * child with a model of a smaller window keeps the limits of Pi Durable.
 */
function harnessSettings(values, models) {
  const { provider, modelId } = modelRef(values['coordinator.model'])
  return {
    extensions: [{ name: MAIN_EXTENSION }],
    retry: { enabled: false },
    stream: { timeoutMs: STREAM_TIMEOUT_MS, maxRetries: 0, cacheRetention: CACHE_RETENTION[values['cache.ttl']] },
    compaction: { modelOverrides: { [values['coordinator.model']]:
      compactionSettings(models.getModel(provider, modelId)?.contextWindow ?? 0, values['compaction.tokens']) } },
    // Pi Durable puts the partial reply into `pi.live` at this interval. The daemon sends it to the chat from there.
    progress: { partialIntervalMs: STREAM_INTERVAL_MS },
  }
}

/**
 * The rules of the main agent that the settings give: the reply style, the suggestion rules, and the setup rules while
 * the onboarding is pending. The defaults give the rules from before the settings. The rules are a section of their
 * own, so a change sends only this section to the model again, and not the bundled rules. [projects] gives the project
 * values as `[directory, text]`, one line for each project.
 */
function settingsRules(values, onboarding, rules, notice, projects = []) {
  const language = values['reply.language']
  return [
    message(`instructions.length.${values['reply.length']}`),
    language === 'auto' ? message('instructions.language.auto') : message('instructions.language', language),
    ...(values['reply.quoteRequest'] ? [message('instructions.quoteRequest')] : []),
    { off: message('instructions.noSuggestions'), reply: rules.suggestions.trimEnd(), ghost: rules.ghost.trimEnd() }[values['reply.suggestions']],
    message('instructions.children', values['children.agent'], ...CHILD_STEPS.map(step => values[`children.${step}`])),
    message('instructions.claude', values['children.permissionMode'], values['children.claudeModel']),
    message('instructions.codex', values['children.codexModel']),
    message('instructions.projects', PROJECT_SETTINGS.join(', ')),
    ...(projects.length ? projects.map(([directory, text]) => message('instructions.project', directory, text)) : [message('instructions.projects.none')]),
    onboarding === 'pending' ? rules.onboarding.trimEnd() : message('instructions.settings'),
    message('instructions.notes', notesOn(values) ? 'on' : 'off'),
    ...(notice ? [message('instructions.spend', notice.usd.toFixed(2), notice.limit)] : []),
  ].join('\n')
}

/**
 * The rules paragraph that the daemon adds to the prompt of each child, from the settings at the time of the dispatch.
 * The daemon adds it, not the main agent, so a child gets the rules of the user also when the main agent forgets them.
 */
export function childRulesText(values) {
  return [message('child.rules'), ...CHILD_STEPS.map(step => message(`child.rule.${step}.${values[`children.${step}`]}`))].join('\n')
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

/**
 * The messages of a keep-alive request: the model context, and a short user message of the keep-alive when the context
 * does not end with a user message. The conversation does not get that message.
 */
export function keepAliveMessages(messages) {
  const last = messages.findLast(model => model.role !== 'system')
  return last === undefined || last.role === 'user' ? [...messages]
    : [...messages, { role: 'user', content: [{ type: 'text', text: message('keepalive.prompt') }], timestamp: Date.now() }]
}

export class PiMegachatService {
  /**
   * An explicit [model], `compactTokens`, `suggestions` or `keepAlive` setting wins over the environment and over
   * `settings.json`, for a test. The daemon passes none of them. [clock] gives the time of the daily spend, for a test.
   * [accountCheck] checks the accounts of the child agents for the tool `agents_accounts`. [processTable] replaces the
   * process table of the platform for the tool `agents_running`, and [clock] also gives the age of its view, for a test.
   * [stop] gives the signal function of the tool `agents_stop`, and the PID and the user of the daemon, for a test.
   * [promptSuggestionLifetimeMs] replaces the lifetime of a prompt suggestion, for a test. [morningReport] gives the
   * clock of the working day and the time limit of tokprof, for a test. The clock gives the time of the timer of the
   * morning report, of the idle time of the conversation, of the wait of a child result, and of the notes about the
   * waiting sessions. [notes] replaces the view of the running sessions of the notes, for a test. [secrets] is a
   * `KnownSecrets` with the exact values of the own secret of Megachat: the state and the session index remove them.
   * [memoryPath] is the path of `memory.md`. Without it, the main agent has no memory section, no tool
   * `agents_memory` and no reflection, for a test. [memory] gives the hooks of the memory, for a test.
   */
  static async open(storage, models, model, sessionProviders, { secrets, searchPath, sessionsPath, sessionIndex: indexOptions = {}, resumeDelayMs, reportRetryDelayMs, userInstructionsPath, settingsPath, memoryPath, memory: memoryOptions = {}, compactTokens: limit, keepAlive: keepAliveOptions = {}, workspacePath, stateDirectory, home, projectRoots, suggestions, environment = process.env, spendPath, clock, accountCheck, processTable, stop: stopOptions = {}, promptSuggestionLifetimeMs, morningReport: reportOptions = {}, notes: notesOptions = {} } = {}) {
    // A task without a project works in this directory of Megachat, not in a directory of an IDE.
    if (workspacePath) await ensurePrivateDirectory(workspacePath)
    const workspace = workspacePath ? await realpath(workspacePath) : undefined
    const { windowMs, retention, enabled } = keepAliveOptions
    const overrides = Object.fromEntries(Object.entries({
      'coordinator.model': model && `${model.provider}/${model.modelId}`, 'compaction.tokens': limit,
      // A test can give the mode as a boolean, as for the stored value of v0.3.0.
      'reply.suggestions': suggestions === undefined ? undefined : suggestionMode(suggestions),
      'keepAlive.enabled': enabled, 'keepAlive.hours': windowMs === undefined ? undefined : windowMs / 3600000,
      'cache.ttl': retention === undefined ? undefined : retention === 'short' ? '5m' : '1h',
    }).filter(([, value]) => value !== undefined))
    const settings = new MegachatSettings(await SettingsStore.open(settingsPath), { environment, overrides, models, home })
    const values = settings.values()
    // The rules of the user come from the file at the start of the daemon only.
    const rules = { bundled: await resource('instructions.md'), suggestions: await resource('instructions-suggestions.md'),
      ghost: await resource('instructions-suggestions-ghost.md'),
      onboarding: await resource('instructions-onboarding.md'), user: await readUserInstructions(userInstructionsPath) }
    const live = { harness: harnessSettings(values, models) }
    const registry = createRegistry()
    const harness = await Harness.open(storage, {
      models, registry, settings: () => live.harness,
      // Only a pi child gets an environment, and it reads only the files of its project.
      env: childEnvironment,
      // Pi Durable reports each failure of a task, an extension or the storage here, and nowhere else.
      onReport: report => logFailure('log.report', report.error, [report.kind, report.reason, report.extension, report.task?.kind]
        .filter(part => typeof part === 'string' && /^[\w.:-]{1,64}$/.test(part)).join(' ')),
    }, context)
    const agent = agentOf(values, rules)
    const root = await harness.root(context, { agent: { ...agent, maxTurns: 20 } })
    await root.configure(agent, context)
    const state = new MegachatState(harness, root, { resumeDelayMs, reportRetryDelayMs, workspace, stateDirectory, home, projectRoots, suggestions: values['reply.suggestions'], promptSuggestionLifetimeMs, secrets })
    await state.initialize()
    await state.recover()
    const service = new PiMegachatService(harness, root, state, sessionProviders)
    Object.assign(service, { models, registry, settings, rules, live, agent, keepAliveOptions, accountCheck, reportOptions, home,
      stateDirectory, environment,
      spend: await DailySpend.open(spendPath, clock),
      // The live table of the session logs exists only with the consent of the user, as the index does.
      running: new RunningAgents(state, { table: processTable, clock, logs: () => service.sessionIndex?.logs }) })
    service.stopper = new AgentStop(state, { table: service.running.table, running: service.running, clock, ...stopOptions })
    service.adopt(values)
    await service.dropPromptSuggestion()
    service.workdayClock = reportOptions.clock ?? workdayClock
    service.morningReport = new MorningReport({ clock: service.workdayClock, values: () => service.settings.values(),
      lastDate: async () => (await state.snapshot()).morningReport.lastDate, prepare: date => service.prepareMorningReport(date) })
    // The notes start in `resume`, and only with the setting `sessions.notes` and the consent `sessions.index`.
    service.sessionNotes = new SessionNotes({ clock: service.workdayClock, view: notesOptions.view ?? (() => service.running.view()),
      sleeping: () => service.sleeping(), deliver: (plan, now) => state.sessionNote(plan, now) })
    // The first paragraph of the file is the system prompt of a summary request. The rest follows the conversation.
    const [system, ...rest] = (await resource('compaction.md')).trim().split('\n\n')
    service.summaryPrompt = { system, instructions: rest.join('\n\n') }
    if (searchPath) service.search = await MegachatSearchIndex.open(searchPath, (minEntryId, cursor) =>
      root.entries({ order: 'ascending', minEntryId }, 200, cursor, context))
    // The index of the past sessions starts in `resume`, and only with the consent of the user.
    if (sessionsPath) {
      service.sessionIndex = new SessionIndexService({ path: sessionsPath, state, home, environment, secrets, ...indexOptions })
      service.sessions.index = service.sessionIndex
    }
    service.sessions.children = new PiChildHistory(harness, state)
    if (memoryPath) {
      service.memory = new MegachatMemory(memoryPath, { secrets, ...memoryOptions })
      // The first paragraph of the file is the system prompt of a reflection request. The rest follows the memory.
      const [reflectionSystem, ...reflectionRest] = (await resource('reflection.md')).trim().split('\n\n')
      service.reflection = new MemoryReflection({ state, memory: service.memory, clock: service.workdayClock,
        prompt: { system: reflectionSystem, instructions: reflectionRest.join('\n\n') },
        read: { entries: (minEntryId, cursor) => root.entries({ order: 'ascending', minEntryId }, 200, cursor, context), newest: () => state.newestEntryId() },
        complete: request => service.reflect(request), values: () => service.values, sleeping: () => service.sleeping(),
        workday: () => workdaySettings(service.values),
        spent: () => { const limit = service.settings.entry('budget.dailyUsd').value; return limit > 0 && service.spend.today().usd > limit } })
    }
    service.childExtension = childExtension((usage, model) => service.countSpend(usage, model, 'pi'))
    registry.install(service.childExtension)
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
   * keep-alive request, the suggestion tools, and the keep-alive with the working day.
   * Returns true when the keep-alive is new.
   */
  adopt(values) {
    this.values = values
    this.projectRules = this.settings.projectRules()
    this.onboarding = this.settings.onboarding
    this.live.harness = harnessSettings(values, this.models)
    this.model = modelRef(values['coordinator.model'])
    this.thinkingLevel = values['coordinator.thinking']
    this.cacheRetention = CACHE_RETENTION[values['cache.ttl']]
    // The mode of the suggestions: `off`, `reply` or `ghost`.
    this.suggestions = values['reply.suggestions']
    this.state.suggestionMode = this.suggestions
    // The warning about the spend is a line of the rules, so it changes only between two turns, as each setting does.
    this.notice = this.spend.notice(values['budget.dailyUsd'])
    // With suggestions, the prompt of an event turn lets the main agent offer a next step.
    this.state.eventSuffix = this.suggestions === 'off' ? '' : '.suggest'
    // A change of the time of the morning report takes a new time at once.
    const reportKey = JSON.stringify([values['report.morning'], reportWorkday(values)])
    if (this.reportKey !== undefined && reportKey !== this.reportKey && this.resumed) this.morningReport?.check()
    this.reportKey = reportKey
    const ttlSeconds = this.models.getModel(this.model.provider, this.model.modelId)?.promptCache?.[this.cacheRetention]
      ?? CACHE_LIFETIME_SECONDS[this.cacheRetention]
    const keepAlive = values['keepAlive.enabled'] ? { ttlMs: ttlSeconds * 1000, windowMs: values['keepAlive.hours'] * 3600000,
      compactTokens: values['compaction.tokens'], workday: workdaySettings(values) } : null
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
      await this.dropPromptSuggestion()
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

  /**
   * Counts the cost of one model request of the main agent, or of a pi child with [source] `pi`. When the spend of the
   * day passes the limit, the warning goes into the rules of the next turn. A failure here must not fail the request, so
   * it goes to the log only.
   */
  countSpend(usage, model, source) {
    try {
      if (this.spend.add(requestCost(usage, model), this.settings.entry('budget.dailyUsd').value, source))
        this.settingsChanged().catch(error => logFailure('log.settings.failed', error))
    }
    catch (error) { logFailure('log.settings.failed', error) }
  }

  /**
   * The model of the next pi child in [cwd]: the setting `children.piModel` of that directory, or the model of the main
   * agent when the model registry does not know the setting, as with the models of a test.
   */
  piModel(cwd) {
    const values = this.settings.values(cwd)
    const model = modelRef(values['children.piModel'])
    return this.models.getModel(model.provider, model.modelId) ? model : modelRef(values['coordinator.model'])
  }

  /** The choices of the conversation of a pi child in [cwd] at its dispatch. */
  childAgent(cwd) {
    return childAgent(cwd, this.piModel(cwd), this.childExtension)
  }

  /**
   * The rules paragraph of the next child in [cwd]. It reads the stored settings, so a change in a turn reaches the next
   * child, and a project value of the directory wins over the global value.
   */
  childRules(cwd) {
    return childRulesText(this.settings.values(cwd))
  }

  /**
   * The tool `agents_settings`. A turn of a child result, of the sessions summary or of the morning report cannot change
   * a setting, also not a project value.
   */
  async settingsTool(args) {
    requireCondition(['get', 'set', 'reset', 'onboarding'].includes(args.action))
    if (args.action === 'get') {
      return { ...this.settings.describe(), spend: { ...this.spend.report(this.settings.entry('budget.dailyUsd').value), note: message('settings.spend.note') },
        ...(this.sessionIndex ? { sessionIndex: await this.sessionIndex.status() } : {}), sessionNotes: this.notesStatus() }
    }
    requireCondition(!automaticKinds.has((await this.state.snapshot()).current?.kind), 'settingEvent')
    let changed
    if (args.action === 'onboarding') {
      changed = await this.settings.setOnboarding(args.status)
      // A new setup starts in the same turn, so the agent gets the setup rules now and not only in the next turn.
      if (args.status === 'pending') changed.rules = this.rules.onboarding.trim()
    }
    else if (args.action === 'set') {
      requireCondition(args.value !== undefined, 'settingValue')
      const before = this.settings.values()['report.morning']
      changed = await this.settings.set(args.key, args.value, args.project)
      if (args.key === 'report.morning' && !before && this.settings.values()['report.morning']) await this.skipReportOfToday()
    }
    else changed = await this.settings.reset(args.key, args.project)
    // The consent to the session index applies at once: the import starts or stops in this turn. So do the notes.
    if (args.action !== 'onboarding') {
      await this.sessionIndex?.apply(this.settings.values())
      if (this.resumed) this.sessionNotes.apply(notesOn(this.settings.values()))
      if (args.key === 'sessions.notes' || args.key === 'sessions.index') changed = { ...changed, sessionNotes: this.notesStatus() }
    }
    await this.settingsChanged()
    return changed
  }

  /** Whether the notes about the waiting sessions are on, and why not when the setting is on without the consent. */
  notesStatus() {
    const values = this.settings.values()
    return { on: notesOn(values), ...(values['sessions.notes'] === 'on' && !notesOn(values) ? { note: message('settings.notes.consent') } : {}) }
  }

  /**
   * The user turned the morning report on. After the start of a working day, the first report comes on the next working
   * day, so the report does not interrupt the conversation that turned it on.
   */
  async skipReportOfToday() {
    const workday = reportWorkday(this.settings.values())
    const now = this.workdayClock.now()
    const today = localDate(now, workday.timezone)
    if (isWorkingDate(workday, today) && now >= zonedTime(today, workday.start, workday.timezone)) await this.state.morningReportDone(today)
  }

  /**
   * Collects the data of the morning report of [date]. A period without activity gets no turn, and the state keeps the
   * date all the same. Else the data waits in the state for its turn, which the event pump starts.
   */
  async prepareMorningReport(date) {
    const state = await this.state.snapshot()
    if (state.morningReport.lastDate === date) return
    const workday = reportWorkday(this.settings.values())
    const data = await collectReportData({ state, date, workday, spend: this.spend, sessionStore: this.sessionIndex?.store,
      home: this.home, stateDirectory: this.stateDirectory, environment: this.environment,
      now: this.workdayClock.now(), tokprofTimeoutMs: this.reportOptions.tokprofTimeoutMs, signal: this.lifetime.signal })
    if (this.lifetime.signal.aborted) return
    const stored = data ? await this.state.morningReportReady(date, data) : await this.state.morningReportDone(date)
    if (stored) logReport(date, data)
  }

  /**
   * The tool `agents_steer`. The state records the message before a send, and the run service, which owns the connection
   * to the agent, sends it. The result waits for the outcome at most [STEER_WAIT_MS]. After that time the message stays
   * recorded, and the outcome is `pending`.
   */
  async steer(requestId, args) {
    const recorded = await this.state.steer(requestId, args)
    const outcome = recorded.outcome ?? await waitForState(this.state, state => findSteer(state, recorded.id)?.item.outcome ?? undefined,
      { signal: this.lifetime.signal, timeoutMs: STEER_WAIT_MS })
    return { childSessionId: args.childSessionId, runId: recorded.runId, steerId: recorded.id, mode: recorded.mode, outcome: outcome ?? 'pending' }
  }

  /** The morning report reads and writes the report, and nothing else. A tool that starts or changes something refuses it. */
  async refuseInMorningReport() {
    requireCondition((await this.state.snapshot()).current?.kind !== 'morning', 'morningReport')
  }

  extension() {
    const tool = (name, parameters, execute, description = `tool.${name}`, replay = 'safe') => defineTool({
      name: `agents_${name}`, description: message(description), parameters, replay, execute,
    })
    const ghost = this.suggestions === 'ghost'
    const inspect = async args => result(await this.state.readRun(args.runId))
    return defineExtension({ name: MAIN_EXTENSION, sections: [
      // The section reads the adopted settings, so a change in a turn reaches the model only in the next turn.
      { key: 'settings', render: () => settingsRules(this.values, this.onboarding, this.rules, this.spend.current(this.notice), this.projectRules) },
      // The section is always there when the daemon has a memory, so a change of the file changes only this section.
      ...(this.memory ? [{ key: 'memory', render: () => this.memorySection() }] : []),
    ], hooks: [
      // Each reply of the model, also a reply with tool calls, is one request that costs money.
      hook(GenerationTask, { afterResponse: (answer, api) => this.countSpend(answer.usage, api.models.getModel(answer.provider, answer.model)) }),
      hook(CompactionTask, { beforeCompact: (compaction, api, hookContext) => this.summarize(compaction, api, hookContext) }),
    ], tools: [
      tool('list', obj({}), async () => {
        const state = await this.state.snapshot()
        // An ended run without a reported result gets its own result message after this turn, as in the morning report.
        const runs = Object.values(state.runs).map(run => ({ runId: run.id, childSessionId: run.childSessionId, agent: run.agent ?? 'claude',
          cwd: run.cwd, status: run.status, title: run.title, prompt: run.prompt.slice(0, 200),
          ...(terminalStates.has(run.status) && !run.reported ? { separateResult: true } : {}) }))
        // Each directory names the agent of a new task in it: a project value of children.agent wins over the global value.
        const workspaces = directoriesOf(state).map(item => ({ ...item, defaultAgent: this.settings.values(item.cwd)['children.agent'] }))
        return result({ agents: ['claude', 'codex', 'pi'], defaultAgent: this.settings.values()['children.agent'], workspaces, runs,
          ...(this.suggestions !== 'off' ? { initiative: { declines: state.initiative.declines, silenced: state.initiative.silenced, suggestion: state.initiative.suggestion } } : {}) })
      }),
      tool('settings', obj({ action: str(), key: opt(str({ maxLength: 100 })),
        value: opt(union([str({ maxLength: 2000 }), num(), bool(), arr(str({ maxLength: 200 }), { maxItems: 50 })])),
        status: opt(str({ maxLength: 20 })), project: opt(str({ maxLength: 4096 })) }), async args => result(await this.settingsTool(args))),
      // A check that runs gives its result also to a second call, so two calls do not start four agents.
      tool('accounts', obj({}), async () => {
        await this.refuseInMorningReport()
        requireCondition(this.accountCheck, 'unavailable')
        this.checking ??= this.accountCheck().finally(() => { this.checking = undefined })
        return result(await this.checking)
      }),
      tool('history', obj({ beforeEntryId: opt(int({ minimum: 1 })), query: opt(str({ maxLength: 200 })), cursor: opt(str({ maxLength: 20 })) }),
        async args => result(await this.history(args))),
      tool('sessions', obj({ cwd: str(), agent: opt(str()), query: opt(str({ maxLength: 200 })), cursor: opt(str()) }),
        async args => result(await this.sessions.search(args))),
      // Only the main agent reads a session from the end of its log, also outside the listed directories. The tool
      // `session_history` of the children has no `order`, so it keeps the limit to the listed directories.
      tool('session_history', obj({ cwd: opt(str()), agent: str(), sessionId: str(), query: opt(str({ maxLength: 200 })), cursor: opt(str()),
        order: opt(str({ maxLength: 10 })), limit: opt(int({ minimum: 1, maximum: 100 })) }), async args => {
        const { order, limit, ...rest } = args
        requireCondition(order === undefined || order === 'oldest' || order === 'newest')
        return result(order === 'newest' ? await this.sessions.readNewest({ ...rest, limit }) : await this.sessions.read(rest))
      }),
      // The tool reads the processes only. The children do not get it: their MCP server has the history tools only.
      tool('running', obj({ agent: opt(str({ maxLength: 20 })), project: opt(str({ maxLength: 4096 })), state: opt(str({ maxLength: 20 })),
        limit: opt(int({ minimum: 1, maximum: 200 })), cursor: opt(str({ maxLength: 64 })) }), async args => result(await this.running.query(args))),
      // The call waits in the turn for the answer of the user in the dialog of the client. A stop of the turn ends the
      // wait. The call does not run again after a restart of the daemon, and a restart removes each stop request.
      tool('stop', obj({ pids: arr(int(), { maxItems: 20 }), signal: opt(str({ maxLength: 10 })) }),
        async (args, api, callContext) => result(await this.stopper.call(args, { abortSignal: callContext?.abortSignal })), undefined, 'unsafe'),
      // The suggestion tools exist only in the modes `reply` and `ghost`. The stored suggestion state stays without them.
      // In the `ghost` mode the result tells the agent that the client shows the text, so the reply does not repeat it.
      ...(this.suggestions !== 'off' ? [
        tool('suggest', obj({ proposal: str() }), async (args, api) => {
          const decision = await this.state.proposal(`tool:${api.taskId}:suggest`, args.proposal)
          return result(ghost && decision.allowed ? { ...decision, note: message('suggest.ghost.note') } : decision)
        }, ghost ? 'tool.suggest.ghost' : 'tool.suggest'),
        tool('feedback', obj({ decision: str() }), async (args, api) =>
          result(await this.state.feedback(`tool:${api.taskId}:feedback`, args.decision))),
      ] : []),
      tool('projects', obj({ action: str(), cwd: opt(str({ maxLength: 4096 })), name: opt(str({ maxLength: 100 })) }), async (args, api) => {
        requireCondition(['list', 'add', 'remove', 'discover', 'create'].includes(args.action))
        if (args.action === 'discover') return result(await this.state.discoverProjects())
        const changed = args.action === 'add' ? { added: (await this.state.addProject(args.cwd)).cwd }
          : args.action === 'create' ? { created: (await this.state.createProject(`tool:${api.taskId}:create`, args.name,
            this.settings.values()['projects.newRoot'])).cwd }
          : args.action === 'remove' ? { removed: (await this.state.removeProject(args.cwd)).cwd } : {}
        return result({ ...changed, workspaces: directoriesOf(await this.state.snapshot()) })
      }),
      // A project value of children.agent in the directory of the task wins over the global value.
      tool('spawn', obj({ cwd: str(), prompt: str(), agent: opt(str()), title: opt(str({ maxLength: 60 })) }), async (args, api) => {
        const cwd = await this.state.directory(args.cwd)
        return result(await this.state.admitChild(`tool:${api.taskId}:spawn`, { ...args, cwd },
          { defaultAgent: this.settings.values(cwd)['children.agent'] }))
      }),
      tool('resume', obj({ cwd: str(), agent: str(), sessionId: str(), prompt: str(), title: opt(str({ maxLength: 60 })) }), async (args, api) => {
        await this.sessions.read(args)
        return result(await this.state.admitChild(`tool:${api.taskId}:resume`, {
          cwd: await this.state.directory(args.cwd), agent: args.agent, providerSessionId: args.sessionId, prompt: args.prompt, title: args.title,
        }))
      }),
      tool('send', obj({ childSessionId: str(), cwd: str(), prompt: str(), title: opt(str({ maxLength: 60 })) }), async (args, api) =>
        result(await this.state.admitChild(`tool:${api.taskId}:send`, { ...args, cwd: await this.state.directory(args.cwd) }))),
      // The children do not get this tool: their MCP server has the history tools only.
      tool('steer', obj({ childSessionId: str({ maxLength: 200 }), prompt: str(), mode: opt(str({ maxLength: 20 })) }), async (args, api) =>
        result(await this.steer(`tool:${api.taskId}:steer`, { childSessionId: args.childSessionId, prompt: args.prompt, mode: args.mode ?? 'queue' }))),
      tool('inspect', obj({ runId: str() }), inspect),
      tool('wait', obj({ runId: str() }), inspect),
      tool('cancel', obj({ runId: str() }), async args => {
        const state = await this.state.snapshot()
        requireCondition(state.current, 'inactive')
        await this.state.cancel(state.current.id, args.runId)
        return result(await this.state.readRun(args.runId))
      }),
      tool('close', obj({ childSessionId: str() }), async args => {
        await this.refuseInMorningReport()
        await this.state.closeChild(args.childSessionId)
        return result({ closed: true })
      }),
      // The limits of the schema are above the limits of an entry, so the tool gives the reason `tooLong` for a long text.
      ...(this.memory ? [tool('memory', obj({ action: str({ maxLength: 20 }), section: opt(str({ maxLength: 20 })),
        text: opt(str({ maxLength: 4000 })), match: opt(str({ maxLength: 4000 })), topic: opt(str({ maxLength: 1000 })) }),
      async (args, api) => result(await this.memoryTool(`tool:${api.taskId}:memory`, args)))] : []),
    ] })
  }

  /**
   * The text of the section `memory`. Pi Durable renders each section before each model request, so the section reads
   * `memory.md` only at the first request of a turn and keeps that text for the other requests of the turn. A write of
   * the tool in a turn reaches the model through the tool result, and the section in the next turn.
   */
  async memorySection() {
    const snapshot = await this.state.snapshot()
    const turn = snapshot.current?.id
    if (turn !== undefined && this.memoryShown?.turn === turn) return this.memoryShown.text
    // The notice of the reflection: the line of each add and each proposal of the passes after the last turn.
    const notice = snapshot.memoryReflection?.notice
    const shown = notice?.lines.length ? `\n${message('memory.reflection.notice')}\n${notice.lines.join('\n')}` : ''
    const text = `${await this.memory.section(this.values['memory.characters'])}${shown}`
    this.memoryShown = { turn, text, notice: shown ? [...notice.lines] : undefined }
    return text
  }

  /**
   * Sends one reflection request: the [system] prompt and the user message [text], with the model of the main agent,
   * as the summary request does. The request has no prompt cache, no reasoning, at most [REFLECTION_MAX_TOKENS] output
   * tokens and a time limit of [REFLECTION_TIMEOUT_MS]. It does not go through Pi Durable. Its cost counts in the spend.
   */
  async reflect({ system, text, signal, characters }) {
    const model = this.models.getModel(this.model.provider, this.model.modelId)
    if (!model) throw new Error('model')
    const answer = await this.models.completeSimple(model, { messages: [
      { role: 'system', content: system, timestamp: Date.now() },
      { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
    ] }, { timeoutMs: REFLECTION_TIMEOUT_MS, maxRetries: 0, cacheRetention: 'none', signal,
      maxTokens: model.maxTokens > 0 ? Math.min(REFLECTION_MAX_TOKENS, model.maxTokens) : REFLECTION_MAX_TOKENS })
    logEvent('log.reflection', answer.usage?.input ?? 0, answer.usage?.output ?? 0, answer.usage?.cost?.total ?? 0, characters)
    this.countSpend(answer.usage, model)
    return answer
  }

  /**
   * The tool `agents_memory`. A turn of a child result, of the sessions summary or of the morning report can only
   * `show`. The call runs again after a restart that cut it off, so [requestId] keys its outcome: the state records the
   * digests of the file before and after the write and the result before the rename. A call that runs again gives that
   * result when the file has the digest after the write, applies its action again when the file has the digest before
   * it, and else changes nothing (see `MegachatMemory.change`). A forget removes the other records after its rename.
   */
  async memoryTool(requestId, args) {
    const limit = this.values['memory.characters']
    if (args.action === 'show') return this.memory.show(limit)
    const state = await this.state.snapshot()
    if (automaticKinds.has(state.current?.kind)) return { changed: false, reason: 'automatic', note: message('memory.automatic') }
    const journal = { recorded: state.memoryWrites?.[requestId], record: write => this.state.memoryWritten(requestId, write),
      // A forget also stops the reflection from learning the fact again (see `MegachatState.memoryForgotten`).
      forgotten: async info => { await this.state.memoryForgotten(requestId, info); this.reflection?.forgotten() } }
    return args.action === 'undo' ? this.memory.undo(limit, journal) : this.memory.change(args, limit, journal)
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
    // The topics of `## Do not remember`: the summary drops them, so a forgotten fact does not stay in the summary. A
    // topic that the checks of a write refuse is not in the list.
    const topics = await this.memory?.topics().catch(() => []) ?? []
    const forgotten = topics.length ? `\n\n${message('memory.summary', topics.join('; '))}` : ''
    const text = `<conversation>\n${transcript(compaction.messages)}\n</conversation>\n\n${this.summaryPrompt.instructions}${forgotten}${focus}`
    const answer = await api.models.completeSimple(model, { messages: [
      { role: 'system', content: this.summaryPrompt.system, timestamp: Date.now() },
      { role: 'user', content: [{ type: 'text', text }], timestamp: Date.now() },
    ] }, { timeoutMs: SUMMARY_TIMEOUT_MS, maxRetries: 0, cacheRetention: 'none', signal: hookContext?.abortSignal,
      maxTokens: model.maxTokens > 0 ? Math.min(SUMMARY_MAX_TOKENS, model.maxTokens) : SUMMARY_MAX_TOKENS })
    logEvent('log.summary', answer.usage.input, answer.usage.cacheRead, answer.usage.cacheWrite, answer.usage.output, answer.usage.cost?.total ?? 0)
    this.countSpend(answer.usage, model)
    const summary = answer.stopReason === 'stop' && !answer.content.some(block => block.type === 'toolCall')
      ? blockText(answer.content).trim() : ''
    if (!summary) return undefined
    // A completed summary makes a pass of the reflection due. The pass waits for the end of each turn.
    if (this.reflection) this.reflection.summarized().catch(error => logFailure('log.reflection.failed', error))
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
   * An idle context ends with a message of the assistant: the last reply, or a note of Megachat. Claude Opus 5.5 refuses
   * such a request ("This model does not support assistant message prefill"). So a short user message of the keep-alive
   * follows the context. It comes after the cached prefix, so the request still reads the whole context from the cache.
   */
  async ping(signal) {
    const model = this.models.getModel(this.model.provider, this.model.modelId)
    const { messages } = await this.root.context(context)
    const request = keepAliveMessages(messages)
    const answer = await this.models.completeSimple(model, { messages: request }, {
      timeoutMs: STREAM_TIMEOUT_MS, maxRetries: 0, cacheRetention: this.cacheRetention, maxTokens: 1, signal,
      // Pi Durable sends no reasoning option for the level `off`, so the keep-alive request does the same.
      ...(this.thinkingLevel === 'off' ? {} : { reasoning: this.thinkingLevel }),
      sessionId: (await this.harness.snapshot(ProviderDoc, this.root.id, context))?.sessionId,
    })
    this.countSpend(answer.usage, model)
    if (answer.stopReason === 'error') throw new Error('keep-alive')
    return answer.usage
  }

  /**
   * The time of the last message of the model context. After a restart, it stands for the last model request. A note
   * of Megachat is no model request, so it does not count.
   */
  async lastMessageTime() {
    const { messages } = await this.root.context(context)
    return messages.findLast(model => Number.isFinite(model.timestamp) && !isNoteMessage(model))?.timestamp
  }

  async resume() {
    const snapshot = await this.state.snapshot()
    if (snapshot.current) this.follow(snapshot.inputs[snapshot.current.requestId])
    // After a restart, the state gives the end of the last turn of the user, and the last message stands for the last
    // model request.
    this.userIdleSince = lastUserTurnEnd(snapshot)
    if (snapshot.current) this.keepAlive?.turnStarted()
    else {
      const last = await this.lastMessageTime()
      if (last !== undefined) this.keepAlive?.turnEnded(last, { kind: 'restart', userIdleSince: this.userIdleSince })
    }
    let running = Boolean(snapshot.current)
    let kind = snapshot.current?.kind
    this.eventWatch = await this.state.watch()
    const observe = snapshot => {
      if (running !== Boolean(snapshot.current)) {
        running = Boolean(snapshot.current)
        if (running) {
          this.keepAlive?.turnStarted()
          this.reflection?.turnStarted()
        }
        else {
          // Only a turn of the user ends the idle time of the working day. A turn of a child result or of the sessions
          // summary starts the window of keep-alive requests again, and the morning report does not.
          if (kind === 'user') this.userIdleSince = this.workdayClock.now()
          this.keepAlive?.turnEnded(undefined, { kind })
          // A note that waited for the end of the turn goes out now.
          this.sessionNotes.check()
          this.reflection?.turnEnded()
        }
      }
      kind = snapshot.current?.kind ?? kind
      if (snapshot.current) { this.watchPromptSuggestion(snapshot); return }
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
      this.watchPromptSuggestion(snapshot)
      const resultsWait = resultsPending && this.resultsWait(snapshot)
      if (resultsWait) this.watchWaitingResults(observe)
      const sessionsPending = Boolean(snapshot.sessionIndex?.summary)
      const reportPending = Boolean(snapshot.morningReport?.pending)
      if ((!resultsPending || resultsWait) && !sessionsPending && !reportPending) return
      this.eventPump = this.eventPump.then(async () => {
        if (this.lifetime.signal.aborted || this.pendingUserInputs) return
        const receipt = (this.resultsWait(await this.state.snapshot()) ? null : await this.state.nextChildResults()) ?? await this.state.nextSessionsEvent()
          ?? await this.state.nextMorningReport()
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
    this.morningReport.check()
    // An index that cannot open must not stop the chat. The log names the failure, and a change of the setting tries again.
    await this.sessionIndex?.apply(this.values).catch(error => logFailure('log.sessions', error))
    this.sessionNotes.apply(notesOn(this.values))
    // A stored answer of a pass gets its writes, and a due pass waits for the idle time after the start.
    this.reflection?.resume()
  }

  /**
   * True when the automatic update can stop the daemon at the time [now] (see the capability `update`): no turn runs, no
   * input and no morning report waits, each child run is in a terminal state, no permission request and no stop request
   * is open, and the time is right (see `updateTime`). The check only reads the state.
   */
  async updateReady(now = this.workdayClock.now()) {
    if (this.pendingUserInputs > 0 || this.stopper.view().requests.length > 0) return false
    const snapshot = await this.state.snapshot()
    if (snapshot.current || snapshot.morningReport?.pending || snapshot.morningReport?.running) return false
    if (Object.values(snapshot.runs).some(run => !terminalStates.has(run.status))) return false
    if (Object.values(snapshot.permissions).some(permission => permissionOpen(snapshot, permission))) return false
    const inbox = await this.harness.snapshot(InboxDoc, this.root.id, context)
    const live = await this.harness.snapshot(LiveDoc, this.root.id, context)
    if ((inbox?.items?.length ?? 0) > 0 || live?.run !== undefined) return false
    return updateTime(this.settings.values(), now, this.userIdleSince)
  }

  /**
   * True while the conversation sleeps: with `workday.enabled` on, outside the working hours, after the idle time of the
   * last turn of the user, as the keep-alive decides it. The child results and the notes about the waiting sessions use it.
   */
  sleeping() {
    const workday = workdaySettings(this.values)
    return workday !== undefined && isSleeping(workday, this.workdayClock.now(), this.userIdleSince)
  }

  /**
   * True when the child results of [snapshot] wait: with `workday.enabled` on, while the conversation sleeps outside the
   * working hours, as the keep-alive decides it. Only a turn of the user ends the idle time, so a chain of results waits.
   * A turn of the user, or the start of the working hours, ends the wait. A result that was ready at the end of the last
   * turn of the user goes out right after that turn, also when `workday.idleMinutes` is 0 and the conversation sleeps
   * again at once. A permission request of a child does not wait, because it is no turn.
   */
  resultsWait(snapshot) {
    return this.sleeping() && !Object.values(snapshot.runs).some(run => terminalStates.has(run.status) && !run.reported
      && (run.reportAfter ?? 0) <= Date.now() && run.finishedAt <= this.userIdleSince)
  }

  /**
   * Looks at the waiting results again at the next start of a working day. The timer waits at most 15 minutes, so a
   * computer that slept looks at the clock again soon. The time comes from the settings and the clock, so a restart
   * keeps the wait.
   */
  watchWaitingResults(observe) {
    if (this.waitTimer !== undefined || this.lifetime.signal.aborted) return
    const now = this.workdayClock.now()
    const next = nextWorkdayStart(workdaySettings(this.values), now) ?? Infinity
    this.waitTimer = this.workdayClock.setTimeout(() => {
      this.waitTimer = undefined
      this.waitCheck = this.state.snapshot().then(observe).catch(() => {})
    }, Math.min(REPORT_RECHECK_MS, next - now))
  }

  /** Withdraws the prompt suggestion at its `expiresAt`. One timer watches the live suggestion. */
  watchPromptSuggestion(snapshot) {
    const suggestion = snapshot.initiative?.promptSuggestion
    if (suggestion?.id === this.expiry?.id) return
    clearTimeout(this.expiry?.timer)
    this.expiry = undefined
    if (!suggestion || this.lifetime.signal.aborted) return
    const timer = setTimeout(() => this.state.withdrawPromptSuggestion(suggestion.id).catch(() => {}),
      Math.max(0, Date.parse(suggestion.expiresAt) - Date.now()))
    timer.unref()
    this.expiry = { id: suggestion.id, timer }
  }

  /**
   * Withdraws the stored prompt suggestion when the mode is not `ghost`, so that no view shows it. This occurs at the
   * start of the daemon and at a change of the setting. During a turn the change applies before the end of the turn, so
   * no view shows the suggestion of that turn.
   */
  async dropPromptSuggestion() {
    if (this.suggestions === 'ghost') return
    const suggestion = (await this.state.snapshot()).initiative.promptSuggestion
    if (suggestion) await this.state.withdrawPromptSuggestion(suggestion.id)
  }

  /** Withdraws the prompt suggestion [id] at a cancel of the user while no turn runs. Tells whether it was live. */
  async withdrawPromptSuggestion(id) {
    return this.state.withdrawPromptSuggestion(id)
  }

  async submit(requestId, text) {
    // A message of the user stops the timer of the reflection, and a turn starts. A request that runs does not stop.
    this.reflection?.turnStarted()
    this.pendingUserInputs++
    let started = false
    try {
      const interrupted = await this.state.interruptAutomaticTurn()
      if (interrupted) {
        await this.root.abort(context)
        await waitForState(this.state, state => !state.current ? true : undefined,
          { signal: this.lifetime.signal, timeoutMs: 60000 })
      }
      const receipt = await this.state.submit(requestId, text)
      if (receipt.status === 'running') this.follow(receipt)
      started = receipt.status === 'running'
      return receipt
    }
    finally {
      this.pendingUserInputs--
      // A message that starts no turn, such as a text above the limit or a message during a turn, gives no end of a
      // turn. So the reflection looks at the state again, and a due pass gets its timer back.
      if (!started) this.reflection?.check()
    }
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
    let failure
    let inputEntry
    try {
      const submission = await this.harness.submission(receipt.continuationId ?? receipt.submissionId, context)
      const settled = await submission.wait(context)
      status = settled.status === 'done' ? 'completed' : 'interrupted'
      if (settled.status !== 'done') reason = settled.reason
      inputEntry = settled.entry
    }
    catch (error) { this.lifetime.signal.throwIfAborted(); status = 'interrupted'; failure = error }
    if (status === 'interrupted') await this.logFailedTurn(receipt.mainRunId, reason, failure)
    // The turn had the warning about the spend in its rules. A turn that gave reply text showed the warning, also when
    // the user stopped it or the model failed after the first text. A turn that failed before any reply text keeps the
    // warning for the next turn. A warning of an earlier day changes no record of today, and the new settings drop it.
    if (this.notice && (status === 'completed' || await this.replyTextAfter(inputEntry))) {
      this.spend.shown(this.notice.day)
      this.settingsPending = true
    }
    // The turn had the notice of the reflection in its section memory. A failed turn keeps it for the next turn.
    const reflectionNotice = this.memoryShown?.turn === receipt.mainRunId ? this.memoryShown.notice : undefined
    if (reflectionNotice && status === 'completed') await this.state.reflectionNoticeShown(reflectionNotice).catch(error => logFailure('log.reflection.failed', error))
    // The turn still holds the state, so the next turn starts with the new settings.
    if (this.settingsPending) await this.applySettings().catch(error => logFailure('log.settings.failed', error))
    await this.state.settleInput(receipt.mainRunId, status, reason, await this.stoppedReply(receipt.mainRunId))
    this.search?.catchUp().catch(() => {
      if (!this.lifetime.signal.aborted) process.stderr.write(`${message('error.search')}\n`)
    })
  }

  /**
   * Tells whether the model wrote reply text after the input entry [entryId]. A turn holds the state until its end, so
   * these entries belong to the turn. A stopped reply and a reply that failed in the middle keep their partial text as
   * an entry, and the chat showed that text.
   */
  async replyTextAfter(entryId) {
    if (!Number.isSafeInteger(entryId)) return false
    try {
      const page = await this.root.entries({ order: 'descending', minEntryId: entryId + 1 }, 50, undefined, context)
      return page.items.some(entry => (entry.model ?? []).some(model => model.role === 'assistant' && Array.isArray(model.content)
        && model.content.some(block => block.type === 'text' && block.text.trim() !== '')))
    }
    catch { return false }
  }

  /**
   * Writes a log line for a turn that ended without an answer: a reply to the user or an automatic turn, with its kind
   * and the reason code of Pi Durable. The line never holds the error text of the provider, because that text can hold
   * a credential. A stop, by a cancel of the user or by a message that interrupts an automatic turn, is no failure.
   */
  async logFailedTurn(mainRunId, reason, failure) {
    if (reason === 'aborted' || reason === 'reset') return
    const current = await this.state.snapshot().then(snapshot => snapshot.current, () => undefined)
    if (current?.id === mainRunId && current.cancelling) return
    const kind = current?.id === mainRunId ? current.kind : 'unknown'
    const code = typeof reason === 'string' && /^[\w.:-]{1,64}$/.test(reason) ? reason : 'unknown'
    if (failure === undefined) logEvent('log.turn', mainRunId, kind, code)
    else logFailure('log.turn.failed', failure, mainRunId, kind)
  }

  /**
   * The text that the model gets for the turn [mainRunId] when the user stopped it, or undefined. The text holds the
   * partial reply and the marker, so the next turn does not continue the stopped request (see `stoppedReplyText`).
   */
  async stoppedReply(mainRunId) {
    const current = (await this.state.snapshot()).current
    if (current?.id !== mainRunId || !current.cancelling) return undefined
    const page = await this.root.entries({ order: 'descending' }, 20, undefined, context)
    return stoppedReplyText(page.items, message('reply.stopped'))
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
      // The entry of a stopped turn repeats the partial reply for the model, so the history gives that reply one time.
      if (entry.kind === 'air.megachat.event' || entry.kind === STOPPED_KIND || entry.head !== undefined) continue
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
    this.stopper.stop()
    await this.morningReport?.close()
    await this.sessionNotes?.close()
    await this.reflection?.close()
    if (this.waitTimer !== undefined) this.workdayClock.clearTimeout(this.waitTimer)
    clearTimeout(this.reportTimer)
    clearTimeout(this.expiry?.timer)
    await this.keepAlive?.close()
    await Promise.allSettled(this.retired)
    await this.eventWatch?.stop()
    await this.eventPump.catch(() => {})
    await this.sessionIndex?.close()
    await this.search?.close()
    await this.harness.close(context)
    await Promise.allSettled([...this.waiters.values()])
    await this.sessions.close()
    // The last count of the spend goes to its file before the daemon ends.
    await this.spend.queue
  }
}

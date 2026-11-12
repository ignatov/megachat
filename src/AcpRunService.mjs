import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { StringDecoder } from 'node:string_decoder'
import { fileURLToPath } from 'node:url'
import { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { resolveSettings as resolveClaudeSettings } from '@anthropic-ai/claude-agent-sdk'
import { waitForState } from './waitForState.mjs'
import { ChildPool } from './ChildPool.mjs'
import { fileMaskEnvironment } from './fileMask.mjs'
import { VERSION } from './MegachatBuild.mjs'
import { logChildText, logFailure, MegachatError, message, minutesOf, requireCondition } from './messages.mjs'
import { terminalStates } from './MegachatState.mjs'
import { claudeChildRules } from './PiChild.mjs'
import { answerText, ERROR_OUTPUT_KEPT, ERROR_OUTPUT_LOGGED, errorOutputText, plainText, REASON_PART_LIMIT, reasonLine,
  redactSecrets, textEnd, textStart } from './SessionText.mjs'
import { CLAUDE_PERMISSION_MODES, modelRef } from './Settings.mjs'

/**
 * Refuses a Claude child in [cwd] when its project settings set `ANTHROPIC_BASE_URL` in `env`. Claude Code applies the
 * `env` of the project settings after the environment of the child, so the requests of the child, with the key of
 * Megachat, would go to the gateway of the project. `resolveSettings` of the SDK reads the files as Claude Code does:
 * only `.claude/settings.json` of [cwd], and no file that is not valid. This is a guard against an accident, not against
 * a hostile project: a project hook runs in the environment of the child and can read the key. The message names the
 * file and the variable, and never the value. When the read fails, the run goes on, and the log
 * of the daemon tells that the guard did not run. The log line has no content of the settings.
 */
async function refuseProjectBaseUrl(cwd, resolveSettings) {
  const resolved = await resolveSettings({ cwd, settingSources: ['project'] }).catch(error => {
    logFailure('log.projectSettings', error)
    return undefined
  })
  const source = resolved?.sources.find(entry => entry.source === 'project'
    && Object.hasOwn(entry.settings?.env ?? {}, 'ANTHROPIC_BASE_URL'))
  if (source) throw new MegachatError('projectBaseUrl', source.path ?? join(cwd, '.claude', 'settings.json'))
}

/**
 * Removes each option of a permission request that switches the child to the mode `bypassPermissions`, before the state
 * keeps the request and the user sees it. A child of Megachat must never get that mode. The Claude option
 * `allowDangerouslySkipPermissions: false` already tells the adapter of Claude Code to offer no such option. This filter
 * is the second guard: it does not depend on that Claude option. The adapter names such an option `exit-plan-bypass` or
 * `exit-plan-clear-bypass`. The state then refuses an answer that names a removed option.
 */
const withoutBypass = request => Array.isArray(request?.options)
  ? { ...request, options: request.options.filter(option => !/bypass/i.test(String(option?.optionId))) } : request

/** The extension request of the Claude and Codex adapters that adds a message to the turn that runs. */
const STEER_METHOD = '_session/steering'
/** The limit of the error output of a child agent, in MB. Above it, Megachat stops the run. */
const MAX_STDERR_MB = 1
/** The ACP code of an agent that asks for a login. */
const AUTH_REQUIRED = RequestError.authRequired().code
/** The characters of the message and of the data of an error answer that go to the log. */
const ANSWER_MESSAGE_LIMIT = 1000
const ANSWER_DATA_LIMIT = 2000

/** The error answer of an agent in [error]: an error with an integer JSON-RPC code, or the cause of a refusal. */
const answerOf = error => Number.isInteger(error?.code) ? error : Number.isInteger(error?.cause?.code) ? error.cause : undefined

/**
 * Keeps [part] of the error output in [output], at most `ERROR_OUTPUT_KEPT` characters. The filter runs only at the
 * read, on the whole kept text, so a secret in two chunks goes as a whole.
 */
function keepErrorOutput(output, part) {
  if (!part) return
  output.text += part
  if (output.text.length > ERROR_OUTPUT_KEPT) {
    output.text = textEnd(output.text, ERROR_OUTPUT_KEPT)
    output.cut = true
  }
}
/** The updates that show work of the model, with the part of a step that each one streams. */
const workParts = new Map([['agent_message_chunk', 'message'], ['agent_thought_chunk', 'thought'], ['tool_call', 'tool'],
  ['tool_call_update', 'tool'], ['plan', 'plan']])

/**
 * Counts the starts of the parts of model work in the order of the stream, and keeps the count at the answer to a
 * steering request. A handler sees a message later, and the next message can already be in its count.
 * A start after the answer shows that the turn went on after the message of the user. A part starts with an update of
 * another part than the update before it, and each `tool_call` starts a part: the model gets the message in its
 * request after the tool. A chunk of the same part does not count. The Codex adapter sends its answer without a wait
 * for its queue of updates, so the rest of the reply that streamed at the answer can come after the answer, and the
 * turn can then end without a read of the message. A message without a start after it gets a follow-up, which says
 * that the message can be a repeat. Only a queue that holds the start of a new part gives a wrong count.
 */
function countWork(stream, work) {
  return { writable: stream.writable, readable: stream.readable.pipeThrough(new TransformStream({ transform(item, controller) {
    const part = item.method === 'session/update' ? workParts.get(item.params?.update?.sessionUpdate) : undefined
    if (part) {
      if (part !== work.part || item.params.update.sessionUpdate === 'tool_call') work.updates++
      work.part = part
    }
    else if (item.method === undefined && typeof item.result?.outcome === 'string') work.answered = work.updates
    controller.enqueue(item)
  } })) }
}

/**
 * Tells whether a permission request of the run waits for the user. The status of the run is not enough: the answer
 * to one of two requests makes the run `running`.
 */
const waitsForUser = (snapshot, runId) =>
  Object.values(snapshot.permissions).some(permission => permission.runId === runId && permission.status === 'pending')

/**
 * The prompt block of the messages that the user added to the task of a run. The block is the last one, after the task.
 * The pi run service gives the same block.
 */
export function steerBlock(items) {
  return [message('child.steer.added'), ...items.map((item, index) =>
    `${message(item.repeat ? 'child.steer.repeat' : 'child.steer.message', index + 1)}\n${item.text}`)].join('\n\n')
}

/**
 * Executes admitted runs. A recorded dispatch is never sent again after a process restart.
 * An automatic continuation waits until its `notBefore` time; later queued runs may start first.
 * [childRules] gives the rules paragraph of the user for the directory of the run at the time of each dispatch. The
 * prompt gets it as a block of its own before the task, and the state keeps only the task, so a report quotes the task
 * alone.
 * Only this process has the connection to the agent. So the tool `agents_steer` records a message in the state, and
 * this service sends it, as it does for a cancel. [steerTimeoutMs] limits the wait for the answer of the agent.
 * [pool] holds the places for the children, and this service shares it with the pi run service. A pi run is not for
 * this service. Each run has its own agent process, deadline, permission requests and messages of the user.
 * [settings] gives the effective settings for the directory of the run at the time of each dispatch, with the project
 * values of that directory. [resolveSettings] reads the project settings of Claude Code. A test replaces it.
 */
export class AcpRunService {
  constructor(state, configuration, {
    command, args, deadlineMs = 1800000, historyServer, childRules, steerTimeoutMs = 20000, pool = new ChildPool(),
    settings = () => ({}), resolveSettings = resolveClaudeSettings, transcripts, errorOutputWaitMs = 2000,
  } = {}) {
    this.state = state
    this.configuration = configuration
    this.launch = { command, args, deadlineMs }
    this.steerTimeoutMs = steerTimeoutMs
    this.historyServer = historyServer
    this.childRules = childRules
    this.pool = pool
    this.settings = settings
    this.resolveSettings = resolveSettings
    // The transcripts of the runs (`ChildTranscripts`). A test without it writes none.
    this.transcripts = transcripts
    // The longest wait for the end of the error output of a failed run. A test makes it short.
    this.errorOutputWaitMs = errorOutputWaitMs
    this.active = new Map()
    this.stopping = false
    this.closing = false
  }

  async start() {
    this.watch = await this.state.watch()
    this.unsubscribe = this.pool.subscribe(() => { if (!this.stopping) this.observe(this.watch.value) })
    this.observe(this.watch.value)
    this.watch.start(call => { if (call.kind === 'value') this.observe(call.value) })
  }

  observe(snapshot) {
    const now = Date.now()
    for (const run of Object.values(snapshot.runs)) {
      if (run.agent === 'pi') continue
      if (run.status === 'admitted' && (run.notBefore ?? 0) > now) {
        if (!this.stopping) this.wakeAt(run.notBefore)
        continue
      }
      if (run.status === 'admitted' && !this.stopping && this.pool.take(snapshot, run, now)) {
        const work = { cancel: null, cancellationSent: false, promise: null, lifetime: new AbortController(),
          updates: 0, steered: new Map(), deliver: null, delivering: null, ended: false }
        this.active.set(run.id, work)
        work.promise = this.execute(run, work).finally(() => {
          this.active.delete(run.id)
          this.pool.release(run.id)
          this.observe(this.watch.value)
        })
        work.promise.catch(error => {
          // The state did not take the end of the run. A new run can then start a second agent on the same work.
          if (!this.closing) logFailure('log.children', error)
          this.stopping = true
        })
      }
      const work = this.active.get(run.id)
      if (work?.cancel && run.cancelRequested && !work.cancellationSent) {
        work.cancellationSent = true
        work.cancel()
      }
      if (work?.deliver && (run.steers?.some(item => item.delivery === 'pending' && !work.steered.has(item.id))
        || work.restartWaiting && !waitsForUser(snapshot, run.id))) work.deliver()
    }
  }

  wakeAt(time) {
    if (this.wake && this.wake.time <= time) return
    clearTimeout(this.wake?.timer)
    const timer = setTimeout(() => {
      this.wake = null
      if (!this.stopping) this.observe(this.watch.value)
    }, Math.max(0, time - Date.now()) + 1)
    this.wake = { time, timer }
  }

  async execute(run, work) {
    const generation = randomUUID()
    let child
    let timer
    let escalation
    let connection
    let updates = Promise.resolve()
    let dispatched = false
    // The request that the run waits for, so the log and the error of a failed run name it.
    let request = methods.agent.initialize
    // The end of the error output of the agent, for the log and the error of a failed run (see `keepErrorOutput`).
    const errorOutput = { text: '', cut: false }
    // Resolves when the agent process ended and its error output closed.
    let closed
    // The text of the first limit that the run reached, or null.
    let limited = null
    let waitingPermissions = 0
    const limit = text => { limited ??= text; this.kill(child) }
    const timeLimit = () => limit(message('error.limit', minutesOf(this.launch.deadlineMs)))
    try {
      // The time of the start shows which children ran at the same time.
      if (!await this.state.transition(run.id, ['admitted'], { status: 'launching', generation, startedAt: Date.now() })) return
      work.transcript = this.transcripts?.begin(run)
      const agent = run.agent ?? 'claude'
      if (agent === 'claude') await refuseProjectBaseUrl(run.cwd, this.resolveSettings)
      // The settings of the dispatch in the directory of the run. A change during the run applies to the next child.
      const values = this.settings(run.cwd)
      const choice = values['children.permissionMode'] ?? 'inherit'
      const mode = agent === 'claude' ? CLAUDE_PERMISSION_MODES[choice] : undefined
      // The model setting of the agent. `inherit` gives no model, so the configuration of the agent decides.
      const modelKey = agent === 'claude' ? 'children.claudeModel' : agent === 'codex' ? 'children.codexModel' : undefined
      const model = modelKey && (values[modelKey] ?? 'inherit') !== 'inherit' ? values[modelKey] : undefined
      const configured = await this.configuration.childLaunch(agent)
      const launch = { ...configured, ...Object.fromEntries(Object.entries(this.launch).filter(([, value]) => value !== undefined)) }
      if (work.lifetime.signal.aborted) throw work.lifetime.signal.reason
      child = spawn(process.execPath, [fileURLToPath(new URL('./child-supervisor.mjs', import.meta.url)),
        launch.command ?? process.execPath, ...launch.args], {
        cwd: launch.cwd ?? run.cwd, env: { ...launch.env, ...fileMaskEnvironment() }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      })
      closed = Promise.all([new Promise(resolve => { child.once('exit', resolve); child.once('error', resolve) }),
        new Promise(resolve => child.stderr.once('close', resolve))])
      child.once('error', () => { child.stdout.destroy(); child.stdin.destroy() })
      child.once('exit', () => connection?.close())
      work.lifetime.signal.addEventListener('abort', () => this.kill(child), { once: true })
      work.cancel = () => this.kill(child)
      let stderrBytes = 0
      const decoder = new StringDecoder('utf8')
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length
        if (stderrBytes > MAX_STDERR_MB * 1024 * 1024) limit(message('error.outputLimit', MAX_STDERR_MB))
        keepErrorOutput(errorOutput, decoder.write(chunk))
      })
      child.stderr.once('end', () => keepErrorOutput(errorOutput, decoder.end()))
      await this.state.transition(run.id, ['launching'], { pid: child.pid })
      timer = setTimeout(timeLimit, this.launch.deadlineMs)
      connection = client({ name: 'air-megachat' })
        .onNotification(methods.client.session.update, ({ params }) => {
          if (!dispatched && params.update.sessionUpdate !== 'config_option_update') return
          if (dispatched) work.transcript?.update(params.update)
          updates = updates.then(() => this.state.appendUpdate(run.id, generation, params.update))
          updates.catch(() => this.kill(child))
          return updates
        })
        .onRequest(methods.client.session.requestPermission, async ({ params }) => {
          waitingPermissions++
          clearTimeout(timer)
          work.transcript?.permission(params.toolCall?.title ?? '')
          try {
            const id = await this.state.requestPermission(run.id, generation, withoutBypass(params))
            const permission = await waitForState(this.state, snapshot => {
              const value = snapshot.permissions[id]
              if (value.status !== 'pending' || snapshot.runs[run.id].cancelRequested) return value
            }, { signal: work.lifetime.signal, timeoutMs: null })
            return permission?.status === 'answered'
              ? { outcome: { outcome: 'selected', optionId: permission.decision } }
              : { outcome: { outcome: 'cancelled' } }
          }
          finally {
            // An agent can ask for more than one permission at a time. The deadline starts again only when no
            // request waits, and only while the run is alive: after its end, nothing clears a new timer.
            if (--waitingPermissions === 0 && !work.lifetime.signal.aborted) timer = setTimeout(timeLimit, this.launch.deadlineMs)
          }
        })
        .connect(countWork(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)), work))
      const ctx = connection.agent
      const initialized = await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'air-megachat', version: VERSION }, clientCapabilities: {},
      })
      // These two faults do not go away on a new start of the agent. So they are errors that no continuation repeats.
      requireCondition(!this.historyServer || initialized.agentCapabilities?.mcpCapabilities?.http, 'agentHttp')
      // The steering extension is not in the standard ACP. The adapters give it in the top-level `_meta`.
      const steering = initialized._meta?.steering?.supported === true
      const params = {
        cwd: run.cwd, mcpServers: this.historyServer ? [this.historyServer] : [],
        // A Claude child loads the project settings, as Claude Code does in the project: `CLAUDE.md` with its imports,
        // the permissions, the hooks, the MCP servers and the skills. It loads no local settings and no file of the user.
        // The options hold no session settings: the SDK puts them in the command line of Claude, and the base URL of
        // Central holds the key. `refuseProjectBaseUrl` guards the base URL. `allowDangerouslySkipPermissions: false`
        // removes the mode `bypassPermissions` from the modes of the session and from the options of the approval of a plan.
        ...(agent === 'claude' ? { _meta: { claudeCode: { options: { model: model ? modelRef(model).modelId : launch.model, settingSources: ['project'],
          promptSuggestions: false, maxTurns: 30, allowDangerouslySkipPermissions: false } } } } : {}),
      }
      let sessionId
      if (run.providerSessionId) {
        requireCondition(initialized.agentCapabilities?.loadSession, 'agentLoad')
        request = methods.agent.session.load
        await ctx.request(methods.agent.session.load, { ...params, sessionId: run.providerSessionId })
        sessionId = run.providerSessionId
      }
      else {
        request = methods.agent.session.new
        const session = await ctx.request(methods.agent.session.new, params)
        sessionId = session.sessionId
      }
      // A refusal of the adapter is an error answer with a JSON-RPC code. The run then fails and sends no prompt. A closed
      // connection is another error, and the run then gets a continuation as after a crash.
      // The refusal keeps the answer as its cause, so the log gets the answer, and the run keeps the fixed text.
      const refused = (code, value) => error => {
        throw Number.isInteger(error?.code) ? Object.assign(new MegachatError(code, value), { cause: error }) : error
      }
      if (model) {
        // The adapter switches a session to `model` of the settings of Claude Code, also of `~/.claude/settings.json`,
        // after the start with the model of the options, and a load continues with the model of the transcript. With
        // `inherit`, that stays so. An explicit model of the setting goes in its own request. It comes before the mode,
        // because a change of the model can change the mode `auto`. The Codex adapter takes the same request. It refuses
        // a model that is not in the model list of Codex, and the next turn uses the model that it took.
        request = methods.agent.session.setConfigOption
        await ctx.request(methods.agent.session.setConfigOption, { sessionId, configId: 'model', value: modelRef(model).modelId })
          .catch(refused(agent === 'codex' ? 'childCodexModel' : 'childModel', model))
      }
      // The adapter takes the start mode from `permissions.defaultMode` of each settings file of Claude Code, also of the
      // files of the user, whatever `settingSources` says, and a load continues in the mode of the transcript. It ignores
      // `permissionMode` in the options. So a mode of the setting goes in its own request before the prompt.
      if (mode) {
        request = methods.agent.session.setMode
        await ctx.request(methods.agent.session.setMode, { sessionId, modeId: mode }).catch(refused('childMode', choice))
      }
      await this.state.transition(run.id, ['launching'], { providerSessionId: sessionId, status: 'ready' })
      work.cancel = () => {
        ctx.notify(methods.agent.session.cancel, { sessionId }).catch(() => this.kill(child))
        escalation = setTimeout(() => this.kill(child), 5000)
      }
      const current = (await this.state.snapshot()).runs[run.id]
      if (current.cancelRequested) {
        await this.state.transition(run.id, ['ready'], { status: 'cancelled' })
        return
      }
      if (!await this.state.transition(run.id, ['ready'], { status: 'dispatched' })) return
      dispatched = true
      // The replay of a loaded session is no part of the new turn.
      work.part = undefined
      // A message of the user from before the dispatch goes in the prompt. A later one goes through the steering request.
      const added = ((await this.state.snapshot()).runs[run.id].steers ?? []).filter(item => item.delivery === 'fallback')
      const rules = this.childRules?.(run.cwd)
      // Claude Code never reads `AGENTS.md`. Without a `CLAUDE.md`, the prompt holds it, as the instructions of a pi child do.
      const repository = agent === 'claude' ? await claudeChildRules(run.cwd).catch(() => undefined) : undefined
      const task = run.task === undefined ? run.prompt : `${run.prompt}\n\n${message('child.task')}\n${run.task}`
      work.transcript?.prompt(task, added)
      request = methods.agent.session.prompt
      const prompting = ctx.request(methods.agent.session.prompt, {
        sessionId, prompt: [
          ...(this.historyServer ? [{ type: 'text', text: message('history.instructions') }] : []),
          ...(rules ? [{ type: 'text', text: rules }] : []),
          ...(repository ? [{ type: 'text', text: repository }] : []),
          // A continuation quotes its task in the same block as its prompt. The first prompt can be lost.
          { type: 'text', text: task },
          ...(added.length ? [{ type: 'text', text: steerBlock(added) }] : []),
        ],
      })
      // The prompt goes out first, so a steering request finds the turn.
      work.deliver = () => this.deliverSteers(run.id, generation, work, { ctx, sessionId, steering })
      work.deliver()
      const result = await prompting
      work.ended = true
      await work.delivering
      await updates
      // A Codex turn can end after the agent took a message and before the model read it. The adapter then drops the
      // message. So a message without the start of a part of model work after it (see `countWork`) waits again, and
      // the end of the run sends it again.
      for (const [id, entry] of work.steered) {
        if (entry.updates === work.updates) await this.state.updateSteer(run.id, generation, id, { delivery: 'pending' })
      }
      const ended = (await this.state.snapshot()).runs[run.id]
      await this.state.transition(run.id, ['dispatched', 'running', 'approval'], {
        status: ended.cancelRequested ? 'cancelled'
          // A stop for a message of the user is an interruption. Its continuation holds the message.
          : ended.steerRestart && result.stopReason !== 'end_turn' ? 'interrupted'
            : result.stopReason === 'cancelled' ? 'cancelled' : result.stopReason === 'end_turn' ? 'completed' : 'failed',
        stopReason: result.stopReason,
      })
    }
    catch (error) {
      work.ended = true
      await work.delivering
      const current = (await this.state.snapshot()).runs[run.id]
      const failed = !this.closing && !limited && !current.cancelRequested && !current.steerRestart
      // The log keeps where the run failed. A failure of the agent adds its answer and the end of its error output.
      if (failed) logFailure('log.child', error, run.id)
      const answer = answerOf(error)
      const reason = failed && child && (answer || !(error instanceof MegachatError))
        ? await this.childFailure(run.id, child, closed, { answer, request, dispatched, errorOutput }) : undefined
      await this.state.transition(run.id, ['launching', 'ready', 'dispatched', 'running', 'approval'], {
        status: current.cancelRequested ? 'cancelled' : 'interrupted',
        error: current.cancelRequested ? null : error instanceof MegachatError ? error.message
          : limited ?? reason ?? message('error.interrupted'),
        // A login does not come back by itself, so a run that asks for one gets no continuation.
        autoResume: !limited && !(error instanceof MegachatError) && answer?.code !== AUTH_REQUIRED,
        ...(this.closing ? { plannedStop: true } : {}),
      })
    }
    finally {
      work.lifetime.abort()
      clearTimeout(timer)
      clearTimeout(escalation)
      connection?.close()
      this.kill(child)
    }
  }

  /**
   * Waits for the end of the error output of a failed run, writes the answer of the agent and the end of its error
   * output to the log, and gives the text of the error of the run, or undefined when the agent neither answered with an
   * error nor ended by itself. An adapter can write its error just after its answer, so the wait gives the agent
   * [errorOutputWaitMs] to end. Then the agent stops, and its error output gets a quarter of that time more. Only a
   * failure calls this wait: a cancel, a limit, a stop for a message of the user and a stop of the daemon do not.
   */
  async childFailure(runId, child, closed, { answer, request, dispatched, errorOutput }) {
    const { byItself, ended } = await this.errorOutputEnd(child, closed)
    const exit = !answer && byItself ? child.signalCode ? message('error.child.signal', child.signalCode)
      : message('error.child.exitCode', child.exitCode) : undefined
    if (!answer && !exit) return undefined
    const known = this.state.secrets
    const output = errorOutputText(errorOutput.text, { cutStart: errorOutput.cut, open: !ended, known })
    let replied = ''
    if (answer) {
      const text = answerText({ message: answer.message }, known)
      const data = answer.data === undefined ? 'none' : redactSecrets(plainText(JSON.stringify(answer.data)), known)
      logChildText('log.child.answer', [request, runId, answer.code, JSON.stringify(textStart(text, ANSWER_MESSAGE_LIMIT)),
        textStart(data, ANSWER_DATA_LIMIT)])
      replied = answerText(answer, known)
    }
    if (output.trim()) logChildText('log.child.output', [runId, ERROR_OUTPUT_LOGGED], output)
    else logChildText('log.child.noOutput', [runId])
    const [first = '', ...rest] = replied.split('\n')
    const reply = textStart(first.trim(), REASON_PART_LIMIT)
    const line = reasonLine([...rest, output].join('\n'), reply)
    return [
      answer?.code === AUTH_REQUIRED ? message('error.child.login') : '',
      answer ? message(dispatched ? 'error.child.answer.after' : 'error.child.answer.before', request, answer.code)
        : message(dispatched ? 'error.child.exit.after' : 'error.child.exit.before', exit),
      reply ? message('error.child.reply', reply) : '',
      line ? message('error.child.line', line) : '',
      replied || output.trim() ? message('error.child.log') : '',
    ].filter(Boolean).join(' ')
  }

  /**
   * Waits at most [errorOutputWaitMs] for the end of [child] and of its error output ([closed]), then stops the agent
   * and waits at most a quarter of that time more. `byItself` tells that the agent ended in the first wait and that
   * Megachat did not stop it. `ended` tells that the error output ended.
   */
  async errorOutputEnd(child, closed) {
    const wait = ms => new Promise(resolve => {
      const timer = setTimeout(resolve, ms, false)
      closed.then(() => { clearTimeout(timer); resolve(true) })
    })
    const byItself = await wait(this.errorOutputWaitMs) && !child.stoppedByMegachat
    this.kill(child)
    return { byItself, ended: byItself || await wait(this.errorOutputWaitMs / 4) }
  }

  /**
   * Sends the waiting messages of the user, one at a time. A call during a send makes the send look again at its end.
   * The last look at `again` and the clear of `delivering` are one synchronous step, so a later call starts a new send.
   */
  deliverSteers(runId, generation, work, agent) {
    if (work.delivering) {
      work.again = true
      return work.delivering
    }
    work.delivering = (async () => {
      try {
        do {
          work.again = false
          await this.sendSteers(runId, generation, work, agent)
        } while (work.again && !work.ended)
      }
      finally { work.delivering = null }
    })().catch(error => {
      if (!this.closing) logFailure('log.child', error, runId)
    })
    return work.delivering
  }

  /**
   * Gives each waiting message of the user to the turn that runs. With the steering extension and the mode `queue`, the
   * message goes into the turn, and `idleBehavior: promptRequired` keeps each turn in the hands of Megachat: an adapter
   * then starts no turn of its own. When the turn ended first, the message waits for the end of the prompt, and the run
   * gets a follow-up. A fallback after the end of the prompt is a follow-up too. Each other case is the fallback: a cancel of the turn, then a continuation with the message.
   * A cancel also ends a permission request that waits for the user, so the fallback waits until the user answered each
   * request of the run.
   */
  async sendSteers(runId, generation, work, { ctx, sessionId, steering }) {
    for (;;) {
      const snapshot = await this.state.snapshot()
      const run = snapshot.runs[runId]
      if (work.ended || run.generation !== generation || run.steerRestart || run.cancelRequested || terminalStates.has(run.status)) return
      const item = run.steers?.find(value => value.delivery === 'pending' && !work.steered.has(value.id))
      // After one message failed over, the stop takes each other message. A request would only delay the stop.
      const stopping = [...work.steered.values()].some(entry => entry.state === 'fallback')
      if (item && steering && item.mode === 'queue' && !stopping) {
        work.steered.set(item.id, { state: 'sent' })
        await this.state.updateSteer(runId, generation, item.id, { sentAt: Date.now() })
        const outcome = await this.requestSteer(ctx, sessionId, item.text)
        // The answer can come at the end of the turn. The count of the stream then tells whether the turn did its work.
        if (outcome === 'injected') {
          work.steered.set(item.id, { state: 'delivered', updates: work.answered ?? work.updates })
          work.transcript?.steer(item.text)
          await this.state.updateSteer(runId, generation, item.id, { delivery: 'delivered', outcome: 'injected' })
        }
        else work.steered.set(item.id, { state: outcome === 'promptRequired' || outcome === 'startedNewTurn' ? 'ended' : 'fallback' })
        continue
      }
      if (item) work.steered.set(item.id, { state: 'fallback' })
      if (![...work.steered.values()].some(entry => entry.state === 'fallback')) return
      work.restartWaiting = waitsForUser(snapshot, runId)
      if (work.restartWaiting) return
      if (await this.state.restartForSteer(runId, generation)) work.cancel()
      return
    }
  }

  /** Gives the outcome of one steering request: `injected`, `promptRequired`, or `failed` for an error or no answer in time. */
  async requestSteer(ctx, sessionId, text) {
    let timer
    try {
      const answer = await Promise.race([
        ctx.request(STEER_METHOD, { sessionId, prompt: [{ type: 'text', text: `${message('child.steer')}\n\n${text}` }],
          _meta: { steering: { idleBehavior: 'promptRequired' } } }),
        new Promise(resolve => { timer = setTimeout(resolve, this.steerTimeoutMs, { outcome: 'failed' }) }),
      ])
      return typeof answer?.outcome === 'string' ? answer.outcome : 'failed'
    }
    catch { return 'failed' }
    finally { clearTimeout(timer) }
  }

  kill(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    // An agent that Megachat stopped did not end by itself, so the error of its run names no exit code.
    child.stoppedByMegachat = true
    try { child.stdio[3]?.destroy(); child.kill('SIGTERM') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }

  async close() {
    this.closing = true
    this.stopping = true
    clearTimeout(this.wake?.timer)
    this.unsubscribe?.()
    await this.watch?.stop()
    for (const work of this.active.values()) work.lifetime.abort()
    await Promise.allSettled([...this.active.values()].map(work => work.promise))
  }
}

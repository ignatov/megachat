import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { waitForState } from './waitForState.mjs'
import { fileMaskEnvironment } from './fileMask.mjs'
import { VERSION } from './MegachatBuild.mjs'
import { logFailure, MegachatError, message, requireCondition } from './messages.mjs'
import { terminalStates } from './MegachatState.mjs'

/** The extension request of the Claude and Codex adapters that adds a message to the turn that runs. */
const STEER_METHOD = '_session/steering'
/** The updates that show work of the model. One of them after a message of the user shows that the turn went on. */
const workUpdates = new Set(['agent_message_chunk', 'agent_thought_chunk', 'tool_call', 'tool_call_update', 'plan'])

/**
 * Counts the updates of model work in the order of the stream, and keeps the count at the answer to a steering
 * request. A handler sees a message later, and the next message can already be in its count.
 */
function countWork(stream, work) {
  return { writable: stream.writable, readable: stream.readable.pipeThrough(new TransformStream({ transform(item, controller) {
    if (item.method === 'session/update' && workUpdates.has(item.params?.update?.sessionUpdate)) work.updates++
    else if (item.method === undefined && typeof item.result?.outcome === 'string') work.answered = work.updates
    controller.enqueue(item)
  } })) }
}

/**
 * The prompt block of the messages that the user added to the task of a run. The block is the last one, after the task.
 */
function steerBlock(items) {
  return [message('child.steer.added'), ...items.map((item, index) =>
    `${message(item.repeat ? 'child.steer.repeat' : 'child.steer.message', index + 1)}\n${item.text}`)].join('\n\n')
}

/**
 * Executes admitted runs. A recorded dispatch is never sent again after a process restart.
 * An automatic continuation waits until its `notBefore` time; later queued runs may start first.
 * [childRules] gives the rules paragraph of the user at the time of each dispatch. The prompt gets it as a block of its
 * own before the task, and the state keeps only the task, so a report quotes the task alone.
 * Only this process has the connection to the agent. So the tool `agents_steer` records a message in the state, and
 * this service sends it, as it does for a cancel. [steerTimeoutMs] limits the wait for the answer of the agent.
 */
export class AcpRunService {
  constructor(state, configuration, {
    command, args, model, deadlineMs = 1800000, historyServer, childRules, steerTimeoutMs = 20000,
  } = {}) {
    this.state = state
    this.configuration = configuration
    this.launch = { command, args, model, deadlineMs }
    this.steerTimeoutMs = steerTimeoutMs
    this.historyServer = historyServer
    this.childRules = childRules
    this.active = new Map()
    this.stopping = false
    this.closing = false
  }

  async start() {
    this.watch = await this.state.watch()
    this.observe(this.watch.value)
    this.watch.start(call => { if (call.kind === 'value') this.observe(call.value) })
  }

  observe(snapshot) {
    const now = Date.now()
    for (const run of Object.values(snapshot.runs)) {
      if (run.status === 'admitted' && (run.notBefore ?? 0) > now) {
        if (!this.stopping) this.wakeAt(run.notBefore)
        continue
      }
      if (run.status === 'admitted' && this.active.size === 0 && !this.stopping) {
        const work = { cancel: null, cancellationSent: false, promise: null, lifetime: new AbortController(),
          updates: 0, steered: new Map(), deliver: null, delivering: null, ended: false }
        this.active.set(run.id, work)
        work.promise = this.execute(run, work).finally(() => {
          this.active.delete(run.id)
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
        || work.restartWaiting && run.status !== 'approval')) work.deliver()
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
    let limited = false
    let waitingPermissions = 0
    const limit = () => { limited = true; this.kill(child) }
    try {
      if (!await this.state.transition(run.id, ['admitted'], { status: 'launching', generation })) return
      const agent = run.agent ?? 'claude'
      const configured = await this.configuration.childLaunch(agent)
      const launch = { ...configured, ...Object.fromEntries(Object.entries(this.launch).filter(([, value]) => value !== undefined)) }
      if (work.lifetime.signal.aborted) throw work.lifetime.signal.reason
      child = spawn(process.execPath, [fileURLToPath(new URL('./child-supervisor.mjs', import.meta.url)),
        launch.command ?? process.execPath, ...launch.args], {
        cwd: launch.cwd ?? run.cwd, env: { ...launch.env, ...fileMaskEnvironment() }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      })
      child.once('error', () => { child.stdout.destroy(); child.stdin.destroy() })
      child.once('exit', () => connection?.close())
      work.lifetime.signal.addEventListener('abort', () => this.kill(child), { once: true })
      work.cancel = () => this.kill(child)
      let stderrBytes = 0
      child.stderr.on('data', chunk => {
        stderrBytes += chunk.length
        if (stderrBytes > 1024 * 1024) limit()
      })
      await this.state.transition(run.id, ['launching'], { pid: child.pid })
      timer = setTimeout(limit, this.launch.deadlineMs)
      connection = client({ name: 'air-megachat' })
        .onNotification(methods.client.session.update, ({ params }) => {
          if (!dispatched && params.update.sessionUpdate !== 'config_option_update') return
          updates = updates.then(() => this.state.appendUpdate(run.id, generation, params.update))
          updates.catch(() => this.kill(child))
          return updates
        })
        .onRequest(methods.client.session.requestPermission, async ({ params }) => {
          waitingPermissions++
          clearTimeout(timer)
          try {
            const id = await this.state.requestPermission(run.id, generation, params)
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
            if (--waitingPermissions === 0 && !work.lifetime.signal.aborted) timer = setTimeout(limit, this.launch.deadlineMs)
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
        ...(agent === 'claude' ? { _meta: { claudeCode: { options: { model: launch.model, settingSources: [],
          promptSuggestions: false, maxTurns: 30 } } } } : {}),
      }
      let sessionId
      if (run.providerSessionId) {
        requireCondition(initialized.agentCapabilities?.loadSession, 'agentLoad')
        await ctx.request(methods.agent.session.load, { ...params, sessionId: run.providerSessionId })
        sessionId = run.providerSessionId
      }
      else {
        const session = await ctx.request(methods.agent.session.new, params)
        sessionId = session.sessionId
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
      // A message of the user from before the dispatch goes in the prompt. A later one goes through the steering request.
      const added = ((await this.state.snapshot()).runs[run.id].steers ?? []).filter(item => item.delivery === 'fallback')
      const rules = this.childRules?.()
      const prompting = ctx.request(methods.agent.session.prompt, {
        sessionId, prompt: [
          ...(this.historyServer ? [{ type: 'text', text: message('history.instructions') }] : []),
          ...(rules ? [{ type: 'text', text: rules }] : []),
          // A continuation quotes its task in the same block as its prompt. The first prompt can be lost.
          { type: 'text', text: run.task === undefined ? run.prompt : `${run.prompt}\n\n${message('child.task')}\n${run.task}` },
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
      // message. So a message without work of the model after it waits again, and the end of the run sends it again.
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
      // The state keeps a fixed text for the user. The log keeps where the run failed.
      if (!this.closing && !limited && !current.cancelRequested && !current.steerRestart) logFailure('log.child', error, run.id)
      await this.state.transition(run.id, ['launching', 'ready', 'dispatched', 'running', 'approval'], {
        status: current.cancelRequested ? 'cancelled' : 'interrupted',
        error: current.cancelRequested ? null : error instanceof MegachatError ? error.message
          : message(limited ? 'error.limit' : 'error.interrupted'),
        autoResume: !limited && !(error instanceof MegachatError),
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

  /** Sends the waiting messages of the user, one at a time. A call during a send makes the send look again at its end. */
  deliverSteers(runId, generation, work, agent) {
    if (work.delivering) {
      work.again = true
      return work.delivering
    }
    work.delivering = (async () => {
      do {
        work.again = false
        await this.sendSteers(runId, generation, work, agent)
      } while (work.again && !work.ended)
    })().catch(error => {
      if (!this.closing) logFailure('log.child', error, runId)
    }).finally(() => { work.delivering = null })
    return work.delivering
  }

  /**
   * Gives each waiting message of the user to the turn that runs. With the steering extension and the mode `queue`, the
   * message goes into the turn, and `idleBehavior: promptRequired` keeps each turn in the hands of Megachat: an adapter
   * then starts no turn of its own. When the turn ended first, the message waits for the end of the prompt, and the run
   * gets a follow-up. A fallback after the end of the prompt is a follow-up too. Each other case is the fallback: a cancel of the turn, then a continuation with the message.
   * A cancel also ends a permission request that waits for the user, so the fallback waits for the answer.
   */
  async sendSteers(runId, generation, work, { ctx, sessionId, steering }) {
    for (;;) {
      const run = (await this.state.snapshot()).runs[runId]
      if (work.ended || run.generation !== generation || run.steerRestart || run.cancelRequested || terminalStates.has(run.status)) return
      const item = run.steers?.find(value => value.delivery === 'pending' && !work.steered.has(value.id))
      if (item && steering && item.mode === 'queue') {
        work.steered.set(item.id, { state: 'sent' })
        await this.state.updateSteer(runId, generation, item.id, { sentAt: Date.now() })
        const outcome = await this.requestSteer(ctx, sessionId, item.text)
        // The answer can come at the end of the turn. The count of the stream then tells whether the turn did its work.
        if (outcome === 'injected') {
          work.steered.set(item.id, { state: 'delivered', updates: work.answered ?? work.updates })
          await this.state.updateSteer(runId, generation, item.id, { delivery: 'delivered', outcome: 'injected' })
        }
        else work.steered.set(item.id, { state: outcome === 'promptRequired' || outcome === 'startedNewTurn' ? 'ended' : 'fallback' })
        continue
      }
      if (item) work.steered.set(item.id, { state: 'fallback' })
      if (![...work.steered.values()].some(entry => entry.state === 'fallback')) return
      work.restartWaiting = run.status === 'approval'
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
    try { child.stdio[3]?.destroy(); child.kill('SIGTERM') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }

  async close() {
    this.closing = true
    this.stopping = true
    clearTimeout(this.wake?.timer)
    await this.watch?.stop()
    for (const work of this.active.values()) work.lifetime.abort()
    await Promise.allSettled([...this.active.values()].map(work => work.promise))
  }
}

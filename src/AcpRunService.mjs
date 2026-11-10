import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { client, methods, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import { waitForState } from './waitForState.mjs'
import { VERSION } from './MegachatBuild.mjs'
import { MegachatError, message } from './messages.mjs'

/**
 * Executes admitted runs. A recorded dispatch is never sent again after a process restart.
 * An automatic continuation waits until its `notBefore` time; later queued runs may start first.
 */
export class AcpRunService {
  constructor(state, configuration, {
    command, args, model, deadlineMs = 1800000, historyServer,
  } = {}) {
    this.state = state
    this.configuration = configuration
    this.launch = { command, args, model, deadlineMs }
    this.historyServer = historyServer
    this.active = new Map()
    this.stopping = false
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
        const work = { cancel: null, cancellationSent: false, promise: null, lifetime: new AbortController() }
        this.active.set(run.id, work)
        work.promise = this.execute(run, work).finally(() => {
          this.active.delete(run.id)
          this.observe(this.watch.value)
        })
        work.promise.catch(() => { this.stopping = true })
      }
      const work = this.active.get(run.id)
      if (work?.cancel && run.cancelRequested && !work.cancellationSent) {
        work.cancellationSent = true
        work.cancel()
      }
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
    const limit = () => { limited = true; this.kill(child) }
    try {
      if (!await this.state.transition(run.id, ['admitted'], { status: 'launching', generation })) return
      const agent = run.agent ?? 'claude'
      const configured = await this.configuration.childLaunch(agent)
      const launch = { ...configured, ...Object.fromEntries(Object.entries(this.launch).filter(([, value]) => value !== undefined)) }
      if (work.lifetime.signal.aborted) throw work.lifetime.signal.reason
      child = spawn(process.execPath, [fileURLToPath(new URL('./child-supervisor.mjs', import.meta.url)),
        launch.command ?? process.execPath, ...launch.args], {
        cwd: launch.cwd ?? run.cwd, env: launch.env, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
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
          finally { timer = setTimeout(limit, this.launch.deadlineMs) }
        })
        .connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
      const ctx = connection.agent
      const initialized = await ctx.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'air-megachat', version: VERSION }, clientCapabilities: {},
      })
      if (this.historyServer && !initialized.agentCapabilities?.mcpCapabilities?.http) throw new Error('HTTP MCP is unavailable')
      const params = {
        cwd: run.cwd, mcpServers: this.historyServer ? [this.historyServer] : [],
        ...(agent === 'claude' ? { _meta: { claudeCode: { options: { model: launch.model, settingSources: [],
          promptSuggestions: false, maxTurns: 30 } } } } : {}),
      }
      let sessionId
      if (run.providerSessionId) {
        if (!initialized.agentCapabilities?.loadSession) throw new Error('Session load is unavailable')
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
      const result = await ctx.request(methods.agent.session.prompt, {
        sessionId, prompt: [
          ...(this.historyServer ? [{ type: 'text', text: message('history.instructions') }] : []),
          { type: 'text', text: run.prompt },
        ],
      })
      await updates
      const cancelled = (await this.state.snapshot()).runs[run.id].cancelRequested
      await this.state.transition(run.id, ['dispatched', 'running', 'approval'], {
        status: cancelled || result.stopReason === 'cancelled' ? 'cancelled'
          : result.stopReason === 'end_turn' ? 'completed' : 'failed', stopReason: result.stopReason,
      })
    }
    catch (error) {
      const current = (await this.state.snapshot()).runs[run.id]
      await this.state.transition(run.id, ['launching', 'ready', 'dispatched', 'running', 'approval'], {
        status: current.cancelRequested ? 'cancelled' : 'interrupted',
        error: current.cancelRequested ? null : error instanceof MegachatError ? error.message
          : message(limited ? 'error.limit' : 'error.interrupted'),
        autoResume: !limited && !(error instanceof MegachatError),
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

  kill(child) {
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return
    try { child.stdio[3]?.destroy(); child.kill('SIGTERM') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  }

  async close() {
    this.stopping = true
    clearTimeout(this.wake?.timer)
    await this.watch?.stop()
    for (const work of this.active.values()) work.lifetime.abort()
    await Promise.allSettled([...this.active.values()].map(work => work.promise))
  }
}

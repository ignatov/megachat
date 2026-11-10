import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { agent, methods } from '@agentclientprotocol/sdk/unstable'
import { VERSION } from './MegachatBuild.mjs'
import { message, requireCondition } from './messages.mjs'
import { serviceSessionsOf, terminalStates } from './MegachatState.mjs'

/** A short row title: the first prompt line without Markdown markers. */
export function taskTitle(prompt) {
  const line = String(prompt ?? '').split('\n').map(text => text.replace(/^[\s#>*`-]+|[*`]+/g, '').trim()).find(Boolean) ?? ''
  return line.length <= 60 ? line || message('title') : `${line.slice(0, 59).trimEnd()}…`
}

/** Routes ACP views to one daemon conversation. Each view owns its transcript projection. */
export class AcpBridge {
  constructor(daemon) { this.daemon = daemon; this.views = new Map() }

  app() {
    return agent({ name: 'air-megachat' })
      .onConnect(connection => { this.connection = connection; connection.signal.addEventListener('abort', () => this.close(), { once: true }) })
      .onRequest(methods.agent.initialize, async ctx => {
        const air = ctx.params.clientCapabilities?._meta?.jetbrains?.air
        const capabilities = air?.version >= 1 && Array.isArray(air.capabilities) ? air.capabilities : []
        this.nativeTurns = capabilities.includes('asyncTasks')
        this.serviceSessions = capabilities.includes('serviceSessions')
        this.workspaces = capabilities.includes('workspaces')
        return {
          protocolVersion: 1, agentInfo: { name: 'air-megachat', title: message('title'), version: VERSION },
          agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, authMethods: [],
          _meta: { jetbrains: { air: { version: 1, capabilities: ['persistentSession',
            ...(this.nativeTurns ? ['asyncTasks'] : [])] } } },
        }
      })
      .onRequest(methods.agent.session.new, ctx => this.attach(ctx, false))
      .onRequest(methods.agent.session.load, ctx => this.attach(ctx, true))
      .onRequest(methods.agent.session.prompt, ctx => this.view(ctx.params.sessionId).prompt(ctx))
      .onNotification(methods.agent.session.cancel, async ctx => {
        this.view(ctx.params.sessionId)
        await this.daemon.json('/cancel', {})
      })
      .onRequest(methods.agent.session.close, async ctx => {
        this.view(ctx.params.sessionId).close()
        this.views.delete(ctx.params.sessionId)
        return {}
      })
  }

  view(id) {
    const view = this.views.get(id)
    requireCondition(view, 'missing')
    return view
  }

  async attach(ctx, loading) {
    const id = loading ? ctx.params.sessionId : `megachat-${randomUUID()}`
    requireCondition(id === 'megachat' || /^megachat-[a-f0-9-]{36}$/.test(id), 'missing')
    this.views.get(id)?.close()
    requireCondition(this.views.has(id) || this.views.size < 32, 'limit')
    const view = new AcpBridgeSession(this.daemon, this.connection, id, this)
    this.views.set(id, view)
    try { return await view.attach(ctx, loading) }
    catch (error) { view.close(); this.views.delete(id); throw error }
  }

  close() {
    for (const view of this.views.values()) view.close()
    this.views.clear()
  }
}

class AcpBridgeSession {
  constructor(daemon, connection, sessionId, capabilities) {
    this.daemon = daemon
    this.connection = connection
    this.sessionId = sessionId
    this.nativeTurns = capabilities.nativeTurns
    this.serviceSessions = capabilities.serviceSessions
    this.workspaces = capabilities.workspaces
    this.recordedChildren = new Set()
    this.replayIndex = 0
    this.abort = new AbortController()
    this.entries = new Set()
    this.permissions = new Set()
    this.serial = Promise.resolve()
    this.promptInFlight = false
    this.childTasks = new Map()
  }

  async prompt(ctx) {
    requireCondition(ctx.params.sessionId === this.sessionId)
    requireCondition(ctx.params.prompt.every(block => block.type === 'text'))
    requireCondition(!this.promptInFlight, 'busy')
    this.promptInFlight = true
    try {
      const receipt = await this.daemon.json('/input', {
        requestId: ctx.params._meta?.jetbrains?.air?.clientMessageId ?? randomUUID(), text: ctx.params.prompt.map(block => block.text).join('\n'),
      })
      const settled = await this.daemon.json(`/wait?submission=${receipt.submissionId}`, undefined, this.abort.signal)
      const view = await this.daemon.json('/conversation')
      const state = await this.daemon.json('/state')
      await this.enqueue(async () => { await this.conversation(view, false); await this.tasks(state) })
      if (settled.status === 'interrupted') {
        await this.notify({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: message('error.interrupted') } })
      }
      return { stopReason: settled.status === 'completed' ? 'end_turn' : 'cancelled' }
    }
    finally { this.promptInFlight = false }
  }

  async attach(ctx, loading) {
    if (loading) requireCondition(ctx.params.sessionId === this.sessionId, 'missing')
    await this.daemon.json('/workspace', { cwd: ctx.params.cwd })
    await this.refreshWorkspaces()
    this.workspaceTimer = setInterval(() => this.refreshWorkspaces().catch(() => {}), 15_000)
    this.workspaceTimer.unref()
    this.abort.abort()
    this.abort = new AbortController()
    const abort = this.abort
    await this.serial.catch(() => {})
    this.serial = Promise.resolve()
    this.entries.clear()
    this.permissions.clear()
    this.childTasks.clear()
    this.replayIndex = 0
    let resolveReady
    let rejectReady
    const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject })
    const received = new Set()
    this.daemon.watch(event => this.enqueue(async () => {
      if (abort.signal.aborted) return
      if (event.type === 'conversation') {
        if (!received.has('conversation') && event.value.before) {
          let after = 0
          while (after < event.value.before) {
            const page = await this.daemon.json(`/history?before=${event.value.before}&after=${after}`)
            if (page.items.length === 0) break
            await this.conversation({ entries: page.items }, true)
            after = page.items.at(-1).id
          }
        }
        await this.conversation(event.value, !received.has('conversation'), true)
      }
      if (event.type === 'tasks') await this.tasks(event.value)
      received.add(event.type)
      if (received.has('conversation') && received.has('tasks')) resolveReady()
    }), abort.signal).then(() => { if (!abort.signal.aborted) throw new Error('Daemon stream ended') }).catch(error => {
      rejectReady(error)
      if (!abort.signal.aborted) {
        const code = String(error.cause?.code ?? error.code ?? error.name)
        process.stderr.write(`${message('error.connection', /^[a-zA-Z0-9_-]{1,64}$/.test(code) ? code : 'unknown')}\n`)
        this.connection.close(error)
      }
    })
    await ready
    await this.notify({ sessionUpdate: 'session_info_update', title: message('title') })
    return loading ? {} : { sessionId: this.sessionId }
  }

  async refreshWorkspaces() {
    if (!this.workspaces || this.refreshingWorkspaces) return
    this.refreshingWorkspaces = true
    try {
      const result = await this.connection.client.request('_workspaces/list', {})
      for (const cwd of result.directories ?? []) await this.daemon.json('/workspace', { cwd })
    }
    finally { this.refreshingWorkspaces = false }
  }

  enqueue(operation) {
    this.serial = this.serial.then(operation)
    return this.serial
  }

  async notify(update, meta) {
    await this.connection.client.notify(methods.client.session.update, { sessionId: this.sessionId, update, _meta: meta })
  }

  async conversation(view, replayUsers, endReplay = false) {
    const updates = []
    for (const entry of view.entries) {
      if (this.entries.has(entry.id)) continue
      this.entries.add(entry.id)
      for (const model of entry.model ?? []) {
        if (model.role === 'user' && replayUsers && entry.kind !== 'air.megachat.event') {
          const text = typeof model.content === 'string' ? model.content
            : model.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
        }
        if (model.role === 'assistant') {
          for (const block of model.content) {
            if (block.type === 'text') updates.push({ sessionUpdate: 'agent_message_chunk', content: block })
          }
        }
      }
    }
    for (const [index, update] of updates.entries()) {
      const meta = replayUsers ? { loadSessionReplayIndex: this.replayIndex++ } : undefined
      if (meta && endReplay && index === updates.length - 1) {
        meta.loadSessionReplaySize = meta.loadSessionReplayIndex
        meta.loadSessionEndOfRecordedHistory = true
      }
      await this.notify(update, meta)
    }
  }

  /** Marks each delegated session in the state as a service session, also the session of a dropped run. */
  async tasks(state) {
    if (this.serviceSessions) {
      for (const [address, session] of Object.entries(state.serviceSessions ?? serviceSessionsOf(state.runs))) {
        if (this.recordedChildren.has(address)) continue
        await this.connection.client.request('_session/service/record', {
          agentId: session.agent, sessionId: session.providerSessionId, cwd: session.cwd,
        })
        this.recordedChildren.add(address)
      }
    }
    for (const permission of Object.values(state.permissions)) {
      if (permission.status !== 'pending' || this.permissions.has(permission.id)) continue
      this.permissions.add(permission.id)
      this.connection.client.request(methods.client.session.requestPermission, {
        ...permission.request, sessionId: this.sessionId,
        toolCall: { ...permission.request.toolCall, toolCallId: permission.id,
          title: message('permission.title', state.runs[permission.runId]?.agent === 'codex' ? 'Codex' : 'Claude', permission.request.toolCall?.title ?? '') },
      }).then(async result => {
        if (result.outcome.outcome === 'selected') {
          await this.daemon.json('/permission', { id: permission.id, decision: result.outcome.optionId })
        }
      }).catch(() => {})
    }
    if (this.nativeTurns) await this.childRows(state)
  }

  /** Lists unfinished child runs as background tasks; the coordinator's own tool calls never reach the chat. */
  async childRows(state) {
    const rows = new Map()
    for (const run of Object.values(state.runs)) {
      if (terminalStates.has(run.status)) continue
      let first = run
      while (first.resumeOf && state.runs[first.resumeOf]) first = state.runs[first.resumeOf]
      const phase = run.status === 'admitted' ? run.resumeOf ? 'resuming' : 'queued' : run.status === 'approval' ? 'approval' : 'running'
      rows.set(`${run.id}:${phase}`, { name: run.title ?? first.title ?? taskTitle(first.prompt), description: message(`child.${phase}`,
        run.agent === 'codex' ? 'Codex' : 'Claude', basename(run.cwd)) })
    }
    for (const [id, runId] of this.childTasks) {
      if (rows.has(id)) continue
      const status = state.runs[runId]?.status
      await this.notify({ sessionUpdate: 'async_task_state_update', asyncTaskId: id,
        state: status === 'completed' || !terminalStates.has(status) ? 'completed' : status === 'cancelled' ? 'stopped' : 'failed' })
      this.childTasks.delete(id)
    }
    for (const [id, row] of rows) {
      if (this.childTasks.has(id)) continue
      this.childTasks.set(id, id.slice(0, id.lastIndexOf(':')))
      await this.notify({ sessionUpdate: 'async_task_spawned', asyncTaskId: id, ...row,
        taskType: 'agent', canStop: false, showInTranscript: false })
    }
  }

  close() {
    clearInterval(this.workspaceTimer)
    this.abort.abort()
  }
}

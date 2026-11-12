import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { agent, methods } from '@agentclientprotocol/sdk/unstable'
import { VERSION } from './MegachatBuild.mjs'
import { MegachatError, message, requireCondition } from './messages.mjs'
import { serviceSessionsOf, terminalStates } from './MegachatState.mjs'
import { transcriptPath } from './ChildTranscript.mjs'
import { replyText } from './ReplyStream.mjs'
import { livePromptSuggestion, promptSuggestionUpdate } from './Suggestions.mjs'

/** A short row title: the first prompt line without Markdown markers. */
export function taskTitle(prompt) {
  const line = String(prompt ?? '').split('\n').map(text => text.replace(/^[\s#>*`-]+|[*`]+/g, '').trim()).find(Boolean) ?? ''
  return line.length <= 60 ? line || message('title') : `${line.slice(0, 59).trimEnd()}…`
}

/** The name of the agent of a run for the chat. A run without the field is from before the choice of the agent. */
const agentName = agent => agent === 'codex' ? 'Codex' : agent === 'pi' ? 'Pi' : 'Claude'

/** The title of the task of [run]: its own title, else the title or the first prompt line of the first run of the task. */
function runTitle(state, run) {
  let first = run
  while (first.resumeOf && state.runs[first.resumeOf]) first = state.runs[first.resumeOf]
  return run.title ?? first.title ?? taskTitle(first.prompt)
}

/** The name of an agent of `agents_running` for the stop dialog. */
const sessionAgentName = agent => ({ claude: 'Claude Code', codex: 'Codex', pi: 'pi', opencode: 'OpenCode' })[agent] ?? String(agent ?? '?')

/** The presentation of Air for a permission request or an option (`_meta.jetbrains.air.permission`, version 1). */
const permissionMeta = fields => ({ jetbrains: { air: { permission: { version: 1, ...fields } } } })

/**
 * The parameters of `session/request_permission` for a stop request of the main agent, without the session ID. Air
 * shows the title on one line and the description below it, each at most 240 characters. Air shows `rawInput.command`
 * in a code viewer that scrolls, so the list of the processes is there, one line for each process.
 */
export function stopPermission(request) {
  const count = request.targets.length
  const title = message(count === 1 ? 'stop.dialog.title.one' : 'stop.dialog.title.many', request.signal, count)
  const lines = request.targets.map(target => target.cwd ? message('stop.dialog.line', target.pid, sessionAgentName(target.agent), basename(target.cwd))
    : message('stop.dialog.line.noProject', target.pid, sessionAgentName(target.agent)))
  return {
    toolCall: { toolCallId: stopToolCallId(request.id), title, kind: 'execute', status: 'pending', rawInput: { command: lines.join('\n') } },
    options: [
      { optionId: 'stop', kind: 'allow_once', name: message(`stop.option.stop.${request.signal}`),
        _meta: permissionMeta({ description: message('stop.option.stop.description', request.signal) }) },
      { optionId: 'keep', kind: 'reject_once', name: message('stop.option.keep'), _meta: permissionMeta({ description: message('stop.option.keep.description') }) },
    ],
    _meta: permissionMeta({ title, description: message(`stop.dialog.description.${request.signal}`, Math.max(1, Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 60000))) }),
  }
}

const stopToolCallId = id => `megachat-stop-${id}`

/** The phases of a child run in the ID of its row. */
const phases = ['queued', 'resuming', 'approval', 'running']

/**
 * The background tasks of the chat for [state], by task ID: each unfinished child run, and a pass of the import of the
 * past sessions. Each run has a row with its own phase, so the list shows each of the children that run at the same time.
 * The row of a child run has the Stop action of Air. The row of the import has none.
 */
export function taskRows(state) {
  const rows = new Map()
  for (const run of Object.values(state.runs)) {
    if (terminalStates.has(run.status)) continue
    const phase = run.status === 'admitted' ? run.resumeOf ? 'resuming' : 'queued' : run.status === 'approval' ? 'approval' : 'running'
    rows.set(`${run.id}:${phase}`, { name: runTitle(state, run), description: message(`child.${phase}`,
      agentName(run.agent), basename(run.cwd)), canStop: true })
  }
  // The import of the past sessions is a task too. Its ID changes at each tenth of the files, as a phase of a run does.
  const imported = state.sessionIndex?.task
  if (imported) rows.set(imported.id, { name: message('sessions.task'), description: message('sessions.task.progress', imported.done, imported.total), canStop: false })
  return rows
}

/** The run ID of the row [asyncTaskId] of a child run, or `null` for each other ID. */
export function rowRunId(asyncTaskId) {
  if (typeof asyncTaskId !== 'string' || asyncTaskId.length > 300) return null
  const index = asyncTaskId.lastIndexOf(':')
  return index > 0 && phases.includes(asyncTaskId.slice(index + 1)) ? asyncTaskId.slice(0, index) : null
}

/**
 * The text of a prompt for the main agent, one line for each block in the order of the blocks. ACP says that each agent
 * must accept the blocks `text` and `resource_link`. A link becomes a Markdown link with its name and its URI, so the
 * main agent can give it to a child. Each other block type is refused. The daemon refuses a text that is too long.
 */
function promptText(prompt) {
  requireCondition(prompt.every(block => block.type === 'text'
    || (block.type === 'resource_link' && typeof block.name === 'string' && typeof block.uri === 'string')))
  return prompt.map(block => block.type === 'text' ? block.text : `[${block.name}](${block.uri})`).join('\n')
}

/**
 * Routes ACP views to one daemon conversation. Each view owns its transcript projection. [transcripts] is the directory
 * of the transcripts of the child runs in the state directory of the daemon. Without it, a row names no file.
 */
export class AcpBridge {
  constructor(daemon, { transcripts } = {}) { this.daemon = daemon; this.transcripts = transcripts; this.views = new Map() }

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
      .onNotification(methods.agent.session.cancel, ctx => this.view(ctx.params.sessionId).cancel())
      // The Stop action of a row in the chat. Air shows it only for a row with `canStop: true`, and it accepts the stop
      // only for the answer `stopped: true`. The row then ends with its terminal update.
      .onRequest('_session/async_task/stop', params => params, ctx => this.views.get(ctx.params?.sessionId)?.stopTask(ctx.params.asyncTaskId)
        ?? { stopped: false })
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
    catch (error) {
      view.close()
      // A later attach of the same ID can have replaced this view. Then the entry belongs to the later view.
      if (this.views.get(id) === view) this.views.delete(id)
      throw error
    }
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
    this.transcripts = capabilities.transcripts
    // The prompt suggestion that this view sent last, and the last state of the daemon. The view sends a suggestion
    // only after its attach, so a suggestion never is a part of the replay.
    this.shownSuggestion = null
    this.lastState = null
    this.ready = false
    this.recordedChildren = new Set()
    this.replayIndex = 0
    this.abort = new AbortController()
    this.entries = new Set()
    this.permissions = new Set()
    // The stop requests of the main agent that this view showed.
    this.stops = new Set()
    this.serial = Promise.resolve()
    this.promptInFlight = false
    this.promptRunId = null
    this.currentRunId = null
    this.cancelPending = false
    this.childTasks = new Map()
    this.reply = null
    this.lastReplyTask = 0
    this.closed = false
  }

  /**
   * Stops the turn that this view shows: the turn of its own prompt, else the turn that the last state named. The
   * daemon gets the ID of that turn. So a stop that arrives after the end of the turn cannot cancel the next turn,
   * such as an automatic result report or the turn of another view.
   */
  async cancel() {
    if (this.promptInFlight && !this.promptRunId) { this.cancelPending = true; return }
    const mainRunId = this.promptRunId ?? this.currentRunId
    if (mainRunId) await this.daemon.json('/cancel', { mainRunId })
    // A cancel while no turn runs removes the shown prompt suggestion. A daemon of an earlier build has no route for it.
    else if (this.shownSuggestion) {
      await this.daemon.json('/prompt-suggestion/withdraw', { id: this.shownSuggestion.id })
        .catch(error => { if (!(error instanceof MegachatError)) throw error })
    }
  }

  /**
   * Stops the child run of the row [asyncTaskId], and no other work: not the turn, and not another child. The daemon
   * refuses an unknown run and a finished run. A row of another kind, such as the row of the import, has no stop. A
   * daemon of an earlier build has no route for the stop, so it refuses the stop too. A client without `asyncTasks`
   * got no row, so its stop is refused.
   */
  async stopTask(asyncTaskId) {
    const runId = this.nativeTurns ? rowRunId(asyncTaskId) : null
    if (!runId) return { stopped: false }
    try { return { stopped: (await this.daemon.json('/child/stop', { runId })).stopped === true } }
    catch (error) {
      if (error instanceof MegachatError) return { stopped: false }
      throw error
    }
  }

  async prompt(ctx) {
    requireCondition(ctx.params.sessionId === this.sessionId)
    const text = promptText(ctx.params.prompt)
    requireCondition(!this.promptInFlight, 'busy')
    const air = ctx.params._meta?.jetbrains?.air
    this.promptInFlight = true
    try {
      const receipt = await this.daemon.json('/input', {
        requestId: air?.clientMessageId ?? randomUUID(), text,
      })
      this.promptRunId = receipt.mainRunId
      // A stop can arrive before the daemon admits the input. Then the turn had no ID yet.
      if (this.cancelPending) await this.cancel()
      const settled = await this.daemon.json(`/wait?submission=${receipt.submissionId}`, undefined, this.abort.signal)
      const view = await this.daemon.json('/conversation')
      const state = await this.daemon.json('/state')
      await this.enqueue(async () => { await this.conversation(view, false); await this.tasks(state) })
      if (settled.status === 'interrupted') {
        // A daemon from before the reason field gives no reason. Then the text of a stopped process stays.
        // The notice is a message of its own. It does not continue the partial reply that the chat shows.
        const text = message(settled.reason === 'model_error' ? 'error.model' : 'error.interrupted')
        await this.notify({ sessionUpdate: 'agent_message_chunk', messageId: `megachat-notice-${receipt.mainRunId}`, content: { type: 'text', text } })
      }
      return { stopReason: settled.status === 'completed' ? 'end_turn' : 'cancelled' }
    }
    finally { this.promptInFlight = false; this.promptRunId = null; this.cancelPending = false }
  }

  async attach(ctx, loading) {
    if (loading) requireCondition(ctx.params.sessionId === this.sessionId, 'missing')
    // A later attach of the same ID, or the end of the connection, can close this view during the attach. Then the
    // attach ends at its next step, so the closed view starts no watch and no timer.
    const open = () => requireCondition(!this.closed, 'missing')
    // The daemon refuses a directory that it cannot read, such as a deleted project. The view attaches without it.
    try { await this.daemon.json('/workspace', { cwd: ctx.params.cwd }) }
    catch (error) { if (!(error instanceof MegachatError)) throw error }
    open()
    await this.refreshWorkspaces()
    open()
    this.workspaceTimer = setInterval(() => this.refreshWorkspaces().catch(() => {}), 15_000)
    this.workspaceTimer.unref()
    this.abort.abort()
    this.abort = new AbortController()
    const abort = this.abort
    await this.serial.catch(() => {})
    open()
    this.serial = Promise.resolve()
    this.entries.clear()
    this.permissions.clear()
    this.stops.clear()
    this.childTasks.clear()
    this.reply = null
    this.lastReplyTask = 0
    this.replayIndex = 0
    this.shownSuggestion = null
    this.ready = false
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
      if (event.type === 'stream') await this.stream(event.value)
      if (event.type === 'stops') await this.stopRequests(event.value)
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
    open()
    await this.notify({ sessionUpdate: 'session_info_update', title: message('title') })
    // A live prompt suggestion goes out again after the replay. An old one does not.
    this.ready = true
    await this.enqueue(() => abort.signal.aborted ? undefined : this.suggest(this.lastState))
    return loading ? {} : { sessionId: this.sessionId }
  }

  async refreshWorkspaces() {
    if (!this.workspaces || this.refreshingWorkspaces) return
    this.refreshingWorkspaces = true
    try {
      const result = await this.connection.client.request('_workspaces/list', {})
      for (const cwd of result.directories ?? []) {
        // The daemon refuses a directory that it cannot read, such as a deleted project or a volume that is not
        // mounted. That directory must not stop the registration of the others, or the attach of the view.
        try { await this.daemon.json('/workspace', { cwd }) }
        catch (error) { if (!(error instanceof MegachatError)) throw error }
      }
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

  /**
   * Shows the partial reply of the main agent. The chunks of one model request have one message ID, so Air appends
   * them to one message. Air cannot replace or remove a sent chunk. So a partial reply without an entry stays in the
   * open chat as it is, and a replay does not show it.
   */
  async stream(event) {
    // The entry of this request, or of a later one, is in the chat already. Then the event is late.
    if (event.taskId <= this.lastReplyTask) return
    if (this.reply?.taskId !== event.taskId || this.reply.attempt !== event.attempt) {
      this.reply = { taskId: event.taskId, attempt: event.attempt, messageId: `megachat-reply-${event.taskId}-${event.attempt}`, sent: '' }
    }
    const text = event.text.slice(this.reply.sent.length - event.offset)
    if (event.offset > this.reply.sent.length || !text) return
    this.reply.sent += text
    await this.notify({ sessionUpdate: 'agent_message_chunk', messageId: this.reply.messageId, content: { type: 'text', text } })
  }

  /**
   * The chunks of the entry of an assistant message. The entry of a reply that the chat got as a stream gives only
   * the text that the stream did not send, with the message ID of the stream. Each other entry is a message of its own.
   */
  replyChunks(entry, model) {
    const chunk = (messageId, text) => ({ sessionUpdate: 'agent_message_chunk', messageId, content: { type: 'text', text } })
    const reply = this.reply
    // The main agent has one model request at a time. So an entry without a task is the entry of the open stream.
    const streamed = reply && (entry.byTaskId === undefined || entry.byTaskId === reply.taskId)
    this.lastReplyTask = Math.max(this.lastReplyTask, entry.byTaskId ?? 0, streamed ? reply.taskId : 0)
    if (reply && reply.taskId <= this.lastReplyTask) this.reply = null
    const blocks = model.content.filter(block => block.type === 'text' && block.text)
    if (!streamed || !reply.sent) return blocks.map(block => chunk(`megachat-entry-${entry.id}`, block.text))
    const text = replyText(model)
    if (text.startsWith(reply.sent)) return text.length > reply.sent.length ? [chunk(reply.messageId, text.slice(reply.sent.length))] : []
    // The provider changed the text at its end. Air cannot replace the sent text, so the entry is a second message.
    return text ? [chunk(`megachat-entry-${entry.id}`, text)] : []
  }

  async conversation(view, replayUsers, endReplay = false) {
    const updates = []
    for (const entry of view.entries) {
      if (this.entries.has(entry.id)) continue
      this.entries.add(entry.id)
      // A summary of older entries is a user message for the model only. The chat does not show it.
      if (entry.head !== undefined) continue
      for (const model of entry.model ?? []) {
        if (model.role === 'user' && replayUsers && entry.kind !== 'air.megachat.event') {
          const text = typeof model.content === 'string' ? model.content
            : model.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
        }
        if (model.role === 'assistant') updates.push(...this.replyChunks(entry, model))
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
    this.currentRunId = state.current?.id ?? null
    this.lastState = state
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
      // Several children can ask at the same time, so the title names the agent and the task of the run.
      const run = state.runs[permission.runId]
      this.connection.client.request(methods.client.session.requestPermission, {
        ...permission.request, sessionId: this.sessionId,
        toolCall: { ...permission.request.toolCall, toolCallId: permission.id,
          title: message('permission.title', agentName(run?.agent), run ? runTitle(state, run) : message('title'), permission.request.toolCall?.title ?? '') },
      }).then(async result => {
        if (result.outcome.outcome === 'selected') {
          await this.daemon.json('/permission', { id: permission.id, decision: result.outcome.optionId })
        }
      }).catch(() => {})
    }
    if (this.nativeTurns) await this.childRows(state)
    if (this.ready) await this.suggest(state)
  }

  /**
   * Shows each open stop request of the main agent through `session/request_permission`, and gives a selected answer to
   * the daemon. Only the first answer counts: the daemon refuses each later one. When a request that this view showed
   * closes, the view ends its tool call with a final status. Air then removes the dialog, if it still shows it, for
   * example after an answer in another view. A cancel of Air sends nothing to the daemon.
   */
  async stopRequests(view) {
    const open = new Set(view.requests.map(request => request.id))
    for (const request of view.requests) {
      if (this.stops.has(request.id)) continue
      this.stops.add(request.id)
      this.connection.client.request(methods.client.session.requestPermission, { ...stopPermission(request), sessionId: this.sessionId })
        .then(async result => {
          if (result.outcome.outcome === 'selected') await this.daemon.json('/stop/answer', { id: request.id, optionId: result.outcome.optionId })
        }).catch(() => {})
    }
    const closed = new Map(view.closed.map(item => [item.id, item.status]))
    for (const id of this.stops) {
      if (open.has(id)) continue
      this.stops.delete(id)
      await this.notify({ sessionUpdate: 'tool_call_update', toolCallId: stopToolCallId(id), status: closed.get(id) === 'allowed' ? 'completed' : 'failed' })
    }
  }

  /**
   * Sends the prompt suggestion of the daemon state to the client. A client that does not know the key ignores it.
   * The update follows the last reply chunk of its turn: the view first sends each reply entry that it did not send.
   * A suggestion that stops being live, at the next turn, at a cancel or at its `expiresAt`, gets a withdrawal.
   */
  async suggest(state) {
    if (!state) return
    const live = livePromptSuggestion(state)
    if (this.shownSuggestion && this.shownSuggestion.id !== live?.id) {
      const withdrawn = this.shownSuggestion
      this.shownSuggestion = null
      await this.notify(promptSuggestionUpdate(withdrawn, true))
    }
    if (!live || this.shownSuggestion) return
    await this.conversation(await this.daemon.json('/conversation'), false)
    this.shownSuggestion = live
    await this.notify(promptSuggestionUpdate(live))
  }

  /** Lists unfinished child runs as background tasks; the coordinator's own tool calls never reach the chat. */
  async childRows(state) {
    const rows = taskRows(state)
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
      // Air opens the file of `outputFilePath` from the row. The daemon writes the transcript from the start of the run,
      // so a queued row names no file.
      const runId = rowRunId(id)
      const output = this.transcripts && runId && !/:(queued|resuming)$/.test(id) ? { outputFilePath: transcriptPath(this.transcripts, runId) } : {}
      await this.notify({ sessionUpdate: 'async_task_spawned', asyncTaskId: id, ...row, ...output,
        taskType: 'agent', showInTranscript: false })
    }
  }

  close() {
    this.closed = true
    clearInterval(this.workspaceTimer)
    this.abort.abort()
  }
}

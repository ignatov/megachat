import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { agent, methods } from '@agentclientprotocol/sdk/unstable'
import { megachatVersion } from './MegachatBuild.mjs'
import { CENTRAL_CAUSES, MegachatError, message, requireCondition } from './messages.mjs'
import { permissionOpen, serviceSessionsOf, terminalStates } from './MegachatState.mjs'
import { transcriptPath } from './ChildTranscript.mjs'
import { NOTE_KIND } from './SessionNotes.mjs'
import { replyText, STOPPED_KIND } from './ReplyStream.mjs'
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
  if (request.kind === 'archive') return archivePermission(request)
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

/**
 * The dialog of an archive: one line for each session with its agent, project, age, action and warnings, and the options
 * `archive` and `keep`. It uses the same method and the same answer route as the stop dialog.
 */
function archivePermission(request) {
  const count = request.rows.length
  const title = message(count === 1 ? 'archive.dialog.title.one' : 'archive.dialog.title.many', count)
  const lines = request.rows.map(row => {
    const age = row.lastActivityAt ? message('archive.dialog.age', row.lastActivityAt.replace('T', ' ').slice(0, 16)) : message('archive.dialog.age.unknown')
    const action = message(`archive.dialog.action.${row.action}`, row.owner ?? '')
    const line = row.cwd ? message('archive.dialog.line', sessionAgentName(row.agent), basename(row.cwd), age, action)
      : message('archive.dialog.line.noProject', sessionAgentName(row.agent), age, action)
    return row.warnings.length ? `${line}. ${message('archive.dialog.warnings', row.warnings.join(' '))}` : line
  })
  return {
    toolCall: { toolCallId: stopToolCallId(request.id), title, kind: 'execute', status: 'pending', rawInput: { command: lines.join('\n') } },
    options: [
      { optionId: 'archive', kind: 'allow_once', name: message('archive.option.archive'), _meta: permissionMeta({ description: message('archive.option.archive.description') }) },
      { optionId: 'keep', kind: 'reject_once', name: message('archive.option.keep'), _meta: permissionMeta({ description: message('archive.option.keep.description') }) },
    ],
    _meta: permissionMeta({ title, description: message('archive.dialog.description', Math.max(1, Math.ceil((Date.parse(request.expiresAt) - Date.now()) / 60000))) }),
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

/** The limit of the open views of one ACP connection. */
const MAX_VIEWS = 32
/** The interval of the check of `/health` while the bridge has no open view, and the time limit of one check. */
export const HEALTH_INTERVAL_MS = 60000
const HEALTH_TIMEOUT_MS = 2000
/** The wait between the line about the end and the end of the connection. */
const END_DELAY_MS = 100
/** The interval of the check for the end of another turn, while a prompt waits for it. */
const IDLE_CHECK_MS = 2000
/**
 * The wait before a view shows a permission request again after the answer `cancelled` of Air, and the limit of that
 * wait. Air ends its turn after the prompt response, and it refuses a new request until the end is complete.
 */
export const RESHOW_MS = 2000
const RESHOW_MAX_MS = 60000

/**
 * Routes ACP views to one daemon conversation. Each view owns its transcript projection. [transcripts] is the directory
 * of the transcripts of the child runs in the state directory of the daemon. Without it, a row names no file.
 */
export class AcpBridge {
  /**
   * [daemon] is the client of the daemon of the start of the bridge. The bridge never starts another daemon: when its
   * daemon is gone, it ends the ACP connection, so the next start of the agent goes through the entry again (see the
   * capability `daemon`). [healthIntervalMs] replaces the interval of the check of `/health`, and [reshowMs] replaces
   * [RESHOW_MS], for a test.
   */
  constructor(daemon, { transcripts, healthIntervalMs = HEALTH_INTERVAL_MS, reshowMs = RESHOW_MS } = {}) {
    this.daemon = daemon
    this.transcripts = transcripts
    this.healthIntervalMs = healthIntervalMs
    this.reshowMs = reshowMs
    this.views = new Map()
    daemon.onGone = () => this.end('log.daemonGone')
  }

  /**
   * Writes the line [key] one time to the error output, and ends the ACP connection. The process then exits. The end
   * waits [END_DELAY_MS], so a request that found no daemon first gets its error answer.
   */
  end(key, ...args) {
    if (this.ended) return
    this.ended = true
    process.stderr.write(`${message(key, ...args)}\n`)
    setTimeout(() => this.connection?.close(), END_DELAY_MS)
  }

  /**
   * While the bridge has no open view, no event stream tells it that its daemon stopped. So it asks `/health`. Two
   * failures in a row, or another process, end the connection. A port without a daemon ends it at once (see `onGone`).
   */
  watchHealth() {
    let failures = 0
    this.healthTimer = setInterval(async () => {
      if (this.views.size > 0 || this.healthBusy || this.ended) return
      this.healthBusy = true
      try {
        const health = await this.daemon.json('/health', undefined, AbortSignal.timeout(HEALTH_TIMEOUT_MS))
        failures = this.daemon.health?.pid === undefined || health.pid === this.daemon.health.pid ? 0 : 2
      }
      catch { failures++ }
      finally { this.healthBusy = false }
      if (failures >= 2) this.end('log.daemonGone')
    }, this.healthIntervalMs)
    this.healthTimer.unref?.()
  }

  app() {
    return agent({ name: 'air-megachat' })
      .onConnect(connection => {
        this.connection = connection
        connection.signal.addEventListener('abort', () => this.close(), { once: true })
        this.watchHealth()
      })
      .onRequest(methods.agent.initialize, async ctx => {
        const air = ctx.params.clientCapabilities?._meta?.jetbrains?.air
        const capabilities = air?.version >= 1 && Array.isArray(air.capabilities) ? air.capabilities : []
        // The IDE keeps the error output of an agent in its log, so a bug report shows a client without the Air support.
        if (!(air?.version >= 1) && !this.noAirReported) {
          this.noAirReported = true
          process.stderr.write(`${message('log.noAir')}\n`)
        }
        this.nativeTurns = capabilities.includes('asyncTasks')
        this.serviceSessions = capabilities.includes('serviceSessions')
        this.workspaces = capabilities.includes('workspaces')
        // The client draws the `air-html` fence: Air names the capability `htmlFence`, or until then any Air with version 1.
        this.airSupport = air?.version >= 1
        return {
          protocolVersion: 1, agentInfo: { name: 'air-megachat', title: message('title'), version: megachatVersion() },
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
    requireCondition(this.views.has(id) || this.views.size < MAX_VIEWS, 'viewLimit', MAX_VIEWS)
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
    clearInterval(this.healthTimer)
    for (const view of this.views.values()) view.close()
    this.views.clear()
  }
}

class AcpBridgeSession {
  constructor(daemon, connection, sessionId, capabilities) {
    this.daemon = daemon
    this.connection = connection
    this.sessionId = sessionId
    // The bridge of the view, which ends the connection for an update.
    this.bridge = capabilities
    this.nativeTurns = capabilities.nativeTurns
    this.serviceSessions = capabilities.serviceSessions
    this.workspaces = capabilities.workspaces
    this.airSupport = capabilities.airSupport === true
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
    // The permission requests of the children that this view showed, by ID: the run ID while the request is open, and
    // `null` after the view ended its tool call. So a closed request never shows again.
    this.permissions = new Map()
    // The option that the user selected in this view, by the ID of the request.
    this.answers = new Map()
    // The requests that Air answered with `cancelled` while they were open, by ID: the wait before the view shows the
    // request again, its timer, and `due` when the view can show it again.
    this.reshows = new Map()
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
    // The end of the wait of a prompt for another turn, while the prompt waits.
    this.idle = null
  }

  /**
   * Stops the turn that this view shows: the turn of its own prompt, else the turn that the last state named. The
   * daemon gets the ID of that turn. So a stop that arrives after the end of the turn cannot cancel the next turn,
   * such as an automatic result report or the turn of another view.
   */
  async cancel() {
    // A stop of a prompt that waits for another turn ends the wait, and it stops that turn: the chat shows that turn
    // as the turn of the prompt.
    if (this.idle) {
      this.idle('cancelled')
      if (this.currentRunId) await this.daemon.json('/cancel', { mainRunId: this.currentRunId })
      return
    }
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
    const requestId = air?.clientMessageId ?? randomUUID()
    this.promptInFlight = true
    let receipt
    try {
      // A user turn that this view did not start can run: the continuation of a turn after a restart of the daemon, or
      // the turn of another view. The daemon interrupts only an automatic turn for an input, so it refuses the input.
      // The prompt then waits for the end of that turn and starts its own turn.
      while (!(receipt = await this.admit(requestId, text))) {
        if (await this.untilIdle() === 'cancelled') return { stopReason: 'cancelled' }
      }
      this.promptRunId = receipt.mainRunId
      // A stop can arrive before the daemon admits the input. Then the turn had no ID yet.
      if (this.cancelPending) await this.cancel()
      const settled = await this.daemon.json(`/wait?submission=${receipt.submissionId}`, undefined, this.abort.signal)
      const view = await this.daemon.json('/conversation')
      const state = await this.daemon.json('/state')
      await this.enqueue(async () => { await this.conversation(view, false); await this.tasks(state) })
      if (settled.status === 'interrupted') {
        // A daemon from before the reason field gives no reason. Then the text of a stopped process stays. A failure of
        // Central gives the text of its cause, with the command for the next step. A daemon from before the cause field
        // gives no cause, and an unknown cause gets the text of the reason.
        // The notice is a message of its own. It does not continue the partial reply that the chat shows.
        const central = Object.hasOwn(CENTRAL_CAUSES, settled.cause ?? '') ? CENTRAL_CAUSES[settled.cause] : undefined
        const text = message(central ? `error.central.${central}` : settled.reason === 'model_error' ? 'error.model' : 'error.interrupted')
        await this.notify({ sessionUpdate: 'agent_message_chunk', messageId: `megachat-notice-${receipt.mainRunId}`, content: { type: 'text', text } })
      }
      return { stopReason: settled.status === 'completed' ? 'end_turn' : 'cancelled' }
    }
    catch (error) {
      if (error instanceof MegachatError || this.closed) throw error
      // The daemon stopped, for example for a restart. The daemon keeps an admitted turn and continues it after its
      // next start, so the prompt ends with a notice and not with the error of the connection.
      if (!receipt) throw new MegachatError('unavailable')
      await this.notify({ sessionUpdate: 'agent_message_chunk', messageId: `megachat-notice-${receipt.mainRunId}`,
        content: { type: 'text', text: message('error.daemonLost') } }).catch(() => {})
      return { stopReason: 'cancelled' }
    }
    finally { this.promptInFlight = false; this.promptRunId = null; this.cancelPending = false }
  }

  /** Admits the prompt in the daemon. Gives `null` while another turn runs. */
  async admit(requestId, text) {
    try { return await this.daemon.json('/input', { requestId, text }) }
    catch (error) {
      if (error instanceof MegachatError && error.code === 'busy') return null
      throw error
    }
  }

  /**
   * Waits until the daemon has no current turn, a stop of the user, or the close of the view. A state without a
   * current turn ends the wait. A check every [IDLE_CHECK_MS] ends it too, so a missed state cannot keep the prompt.
   */
  untilIdle() {
    return new Promise(resolve => {
      const done = result => {
        clearTimeout(timer)
        this.abort.signal.removeEventListener('abort', closed)
        this.idle = null
        resolve(result)
      }
      const closed = () => done('cancelled')
      const timer = setTimeout(() => done('idle'), IDLE_CHECK_MS)
      this.idle = done
      this.abort.signal.addEventListener('abort', closed, { once: true })
      if (this.closed) done('cancelled')
    })
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
    // The daemon builds the rules of the main agent for the next turn from the support of the view that attached last.
    // A daemon of an earlier build refuses the route. The view attaches without it.
    try { await this.daemon.json('/client', { airSupport: this.airSupport }) }
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
    this.answers.clear()
    this.clearReshows()
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
      // The daemon stops itself for an update. The bridge ends, so the next start goes through the entry and npx.
      if (event.type === 'update') {
        const version = value => typeof value === 'string' && /^[\w.+-]{1,64}$/.test(value) ? value : '?'
        this.bridge.end('log.update.bridge', version(event.value?.from), version(event.value?.to))
        return
      }
      received.add(event.type)
      if (received.has('conversation') && received.has('tasks')) resolveReady()
    }), abort.signal).then(() => { if (!abort.signal.aborted) throw new Error('Daemon stream ended') }).catch(error => {
      rejectReady(error)
      if (!abort.signal.aborted) {
        const code = String(error.cause?.code ?? error.code ?? error.name)
        process.stderr.write(`${message('error.connection', /^[a-zA-Z0-9_-]{1,64}$/.test(code) ? code : 'unknown')}\n`)
        // The wait lets a prompt that lost the same daemon send its answer first.
        setTimeout(() => this.connection.close(error), END_DELAY_MS)
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
      // A summary of older entries is a user message for the model only. The chat does not show it. The entry of a
      // stopped turn is for the model only too: the chat shows the partial reply from the entry of the stopped request.
      if (entry.head !== undefined || entry.kind === STOPPED_KIND) continue
      for (const model of entry.model ?? []) {
        if (model.role === 'user' && replayUsers && entry.kind !== 'air.megachat.event') {
          const text = typeof model.content === 'string' ? model.content
            : model.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
          updates.push({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } })
        }
        // A note about the waiting sessions is no reply of the main agent, so it never continues the message of a stream.
        if (model.role === 'assistant' && entry.kind === NOTE_KIND) {
          for (const block of model.content.filter(item => item.type === 'text' && item.text)) {
            updates.push({ sessionUpdate: 'agent_message_chunk', messageId: `megachat-entry-${entry.id}`, content: { type: 'text', text: block.text } })
          }
        }
        else if (model.role === 'assistant') updates.push(...this.replyChunks(entry, model))
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
    if (!state.current) this.idle?.('idle')
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
    await this.permissionRequests(state)
    if (this.nativeTurns) await this.childRows(state)
    if (this.ready) await this.suggest(state)
  }

  /**
   * Shows each open permission request of a child through `session/request_permission`, and gives a selected answer to
   * the daemon. The daemon judges each answer: it refuses an answer to a request that is no longer open. When a request
   * that this view showed is no longer open, the view ends its tool call one time with a final status: `completed`
   * after an answer that counts, else `failed`, for example when the run stopped or ended first. Air then removes the
   * dialog, if it still shows it, for example after an answer in another view or a stop of the child. A cancel of Air
   * sends nothing to the daemon, but the view shows the request again while it is open (see [showAgain]).
   */
  async permissionRequests(state) {
    for (const permission of Object.values(state.permissions)) {
      const shown = this.permissions.get(permission.id)
      const reshow = this.reshows.get(permission.id)
      if (!permissionOpen(state, permission) || shown === null || (shown !== undefined && !reshow?.due)) continue
      if (reshow) reshow.due = false
      this.permissions.set(permission.id, permission.runId)
      const abort = this.abort
      const shownAt = Date.now()
      // Several children can ask at the same time, so the title names the agent and the task of the run.
      const run = state.runs[permission.runId]
      this.connection.client.request(methods.client.session.requestPermission, {
        ...permission.request, sessionId: this.sessionId,
        toolCall: { ...permission.request.toolCall, toolCallId: permission.id,
          title: message('permission.title', agentName(run?.agent), run ? runTitle(state, run) : message('title'), permission.request.toolCall?.title ?? '') },
      }).then(async result => {
        if (result.outcome.outcome === 'selected') {
          this.answers.set(permission.id, result.outcome.optionId)
          await this.daemon.json('/permission', { id: permission.id, decision: result.outcome.optionId })
        }
        else if (result.outcome.outcome === 'cancelled' && !abort.signal.aborted) this.showAgain(permission.id, Date.now() - shownAt)
      }).catch(() => {})
    }
    for (const [id, runId] of this.permissions) {
      if (runId === null) continue
      const permission = state.permissions[id]
      // The reply of `/state` to a prompt can come after a later event, so a state can be older than a shown request.
      // Then the request is missing, and its run has not ended. The state drops a request only after the end of its run.
      const run = state.runs[runId]
      if (permission ? permissionOpen(state, permission) : run && !terminalStates.has(run.status)) continue
      this.permissions.set(id, null)
      // Air shows the status only in a view where the user answered. An answer that the daemon refused there, because
      // the request closed first or another view gave another answer first, shows as failed.
      const answer = this.answers.get(id)
      const counted = permission?.status === 'answered' && (answer === undefined || answer === permission.decision)
      await this.notify({ sessionUpdate: 'tool_call_update', toolCallId: id, status: counted ? 'completed' : 'failed' })
    }
  }

  /**
   * Air answers `cancelled` for each request of the prompt turn of the view at the end of that turn, and for each request
   * at a Stop of the user. The child still waits for an answer while the request is open. So the view shows the request
   * again [RESHOW_MS] after the answer, when no prompt of the view runs. The last state then tells if the request is
   * still open: a stop of the child or an answer in another view closes it, and the view does not show it again. After
   * the final tool call update of the view, Air answers `cancelled` too, and the view does not show the request again.
   * Air refuses a request at once while the end of its turn runs. So each later `cancelled` that comes sooner than
   * [RESHOW_MS] after the request doubles the wait for that request, up to [RESHOW_MAX_MS].
   */
  showAgain(id, shownFor) {
    if (this.closed || this.permissions.get(id) === null) return
    const base = this.bridge.reshowMs ?? RESHOW_MS
    const earlier = this.reshows.get(id)
    clearTimeout(earlier?.timer)
    const delay = earlier && shownFor < base ? Math.min(earlier.delay * 2, RESHOW_MAX_MS) : base
    const reshow = { delay, timer: null, due: false }
    const arm = () => {
      reshow.timer = setTimeout(() => {
        if (this.closed || this.reshows.get(id) !== reshow) return
        // A request that Air shows during a prompt of the view belongs to that prompt, and Air ends it again with it.
        if (this.promptInFlight) return arm()
        reshow.due = true
        // A failed send must not stop the queue of the view. The connection then ends anyway.
        this.enqueue(() => this.lastState && this.permissionRequests(this.lastState).catch(() => {}))
      }, delay)
      reshow.timer.unref?.()
    }
    this.reshows.set(id, reshow)
    arm()
  }

  clearReshows() {
    for (const { timer } of this.reshows.values()) clearTimeout(timer)
    this.reshows.clear()
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
    this.clearReshows()
    this.abort.abort()
  }
}

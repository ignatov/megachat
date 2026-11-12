import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpBridge, taskRows } from '../src/AcpBridge.mjs'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { CodexSessionHistoryService } from '../src/CodexSessionHistoryService.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonDirectory } from '../src/DaemonDirectory.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { MegachatError, message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { findSteer, terminalStates } from '../src/MegachatState.mjs'
import { waitForState } from '../src/waitForState.mjs'

async function finishChildren(service) {
  return waitForState(service.state, state => !state.current
    && Object.values(state.runs).every(run => terminalStates.has(run.status) && run.reported) ? state : undefined)
}

async function fixture(t, prompt = 'approval', agent = 'claude', { deadlineMs = 10000, env = {}, launchError, suggestions } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'megachat-integration-'))
  const fake = fauxProvider()
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt, agent }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
    fauxAssistantMessage('The child finished.'),
    fauxAssistantMessage('Next turn.'),
  ])
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const histories = { codex: new CodexSessionHistoryService({ command: process.execPath,
    args: [fileURLToPath(new URL('./fake-codex-app-server.mjs', import.meta.url)), await realpath(cwd)] }) }
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, histories,
    { reportRetryDelayMs: 20, suggestions })
  await service.state.addWorkspace(cwd)
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  const launchedAgents = []
  const children = new AcpRunService(service.state, { childLaunch: async agent => {
    launchedAgents.push(agent)
    if (launchError) throw launchError
    return { env: { ...process.env, ...env } }
  } }, {
    args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], deadlineMs,
    historyServer: server.historyConfiguration(),
  })
  await children.start()
  await service.resume()
  t.after(async () => { await server.close(); await children.close(); await service.close(); await rm(cwd, { force: true, recursive: true }) })
  return { cwd, fake, service, children, daemon, server, launchedAgents }
}

async function attach(daemon, cwd, { loading = false, approve = false, native = false, sessionId = 'megachat', serviceSessions = false, workspaces = [] } = {}) {
  const updates = []
  const registrations = []
  const bridge = new AcpBridge(daemon)
  const connection = native ? rawClient(bridge, updates, approve, registrations, workspaces) : client({ name: 'test-air' })
    .onNotification('*', ({ params }) => { updates.push(params) })
    .onRequest(methods.client.session.requestPermission, () => approve
      ? { outcome: { outcome: 'selected', optionId: 'yes' } }
      : new Promise(() => {}))
    .connect(bridge.app())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: native
    ? { _meta: { jetbrains: { air: { version: 1, capabilities: ['nativeSubagentSessions', 'asyncTasks', ...(serviceSessions ? ['serviceSessions'] : []), ...(workspaces.length ? ['workspaces'] : [])] } } } } : {} })
  const opened = await connection.agent.request(loading ? methods.agent.session.load : methods.agent.session.new, {
    cwd, mcpServers: [], ...(loading ? { sessionId } : {}),
  })
  return { connection, updates, registrations, sessionId: loading ? sessionId : opened.sessionId }
}

test('a Codex child requests permission and registers its service session', { timeout: 10000 }, async t => {
  const { daemon, cwd, service, launchedAgents } = await fixture(t, 'approval', 'codex')
  const viewer = await attach(daemon, cwd, { native: true, serviceSessions: true, approve: true })
  t.after(() => viewer.connection.close())
  await viewer.connection.agent.request(methods.agent.session.prompt, {
    sessionId: viewer.sessionId, prompt: [{ type: 'text', text: 'Use Codex' }],
  })
  const state = await finishChildren(service)
  assert.deepEqual(launchedAgents, ['codex'])
  const run = Object.values(state.runs)[0]
  assert.equal(run.agent, 'codex')
  assert.equal(run.status, 'completed')
  assert.equal(Object.values(state.permissions)[0].status, 'answered')
  assert.ok(viewer.registrations.some(item => item.agentId === 'codex' && item.sessionId === run.providerSessionId))
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'session-request.json'), 'utf8')), { operation: 'new', claudeOptions: false })
})

test('an explicit Codex resume preserves the user session and supports cancellation', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake, service, launchedAgents } = await fixture(t)
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_resume', { cwd, agent: 'codex', sessionId: 'active', prompt: 'wait' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Resumed in the background.'),
  ])
  const viewer = await attach(daemon, cwd, { native: true, serviceSessions: true })
  t.after(() => viewer.connection.close())
  await viewer.connection.agent.request(methods.agent.session.prompt, {
    sessionId: viewer.sessionId, prompt: [{ type: 'text', text: 'Continue the existing Codex session' }],
  })
  const run = await waitForState(service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  assert.equal((await service.state.snapshot()).current, null)
  assert.equal(run.serviceSession, false)
  assert.equal(run.providerSessionId, 'active')
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'session-request.json'), 'utf8')),
    { operation: 'load', sessionId: 'active', claudeOptions: false })
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_cancel', { runId: run.id }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Cancellation requested.'),
    fauxAssistantMessage('Cancelled.'),
  ])
  const receipt = await service.submit('cancel-codex', 'Cancel the background task')
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  const state = await finishChildren(service)
  assert.equal(state.runs[run.id].status, 'cancelled')
  assert.deepEqual(launchedAgents, ['codex'])
  assert.deepEqual(viewer.registrations, [])
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), 'wait\n')
})

// Air preserves draft subagent updates that the released JavaScript client schema rejects.
function rawClient(bridge, updates, approve, registrations, workspaces) {
  const inbound = new TransformStream()
  const writer = inbound.writable.getWriter()
  const pending = new Map()
  const listeners = new Set()
  let nextId = 0
  const peer = bridge.app().connect({ readable: inbound.readable, writable: new WritableStream({
    write(message) {
      if (message.method === 'session/update') {
        updates.push(message.params)
        for (const listener of listeners) listener(message.params)
      }
      else if (message.method === 'session/request_permission' && approve) {
        queueMicrotask(() => writer.write({ jsonrpc: '2.0', id: message.id, result: { outcome: { outcome: 'selected', optionId: 'yes' } } }))
      }
      else if (message.method === '_workspaces/list') {
        queueMicrotask(() => writer.write({ jsonrpc: '2.0', id: message.id, result: { directories: workspaces } }))
      }
      else if (message.method === '_session/service/record') {
        registrations.push(message.params)
        queueMicrotask(() => writer.write({ jsonrpc: '2.0', id: message.id, result: { recorded: true } }))
      }
      else if (pending.has(message.id)) {
        const result = pending.get(message.id)
        pending.delete(message.id)
        if (message.error) result.reject(message.error)
        else result.resolve(message.result)
      }
    },
  }) })
  return {
    nextUpdate: predicate => new Promise(resolve => {
      const listener = update => {
        if (predicate(update)) { listeners.delete(listener); resolve(update) }
      }
      listeners.add(listener)
    }),
    agent: { request: async (method, params) => {
      const id = ++nextId
      const result = Promise.withResolvers()
      pending.set(id, result)
      await writer.write({ jsonrpc: '2.0', id, method, params })
      return result.promise
    }, notify: (method, params) => writer.write({ jsonrpc: '2.0', method, params }) },
    close: () => peer.close(),
  }
}

test('a permission and its child survive a disconnected ACP viewer', { timeout: 15000 }, async t => {
  const { daemon, cwd, service } = await fixture(t)
  const first = await attach(daemon, cwd)
  const prompt = first.connection.agent.request(methods.agent.session.prompt, {
    sessionId: first.sessionId, prompt: [{ type: 'text', text: 'Work' }],
  }).catch(() => {})
  const pending = await waitForState(service.state, state => Object.values(state.permissions).find(p => p.status === 'pending'))
  first.connection.close()
  await prompt
  assert.equal((await service.state.snapshot()).permissions[pending.id].status, 'pending')
  assert.equal((await service.state.snapshot()).current, null, 'The conversation is free while the child needs permission')
  const second = await attach(daemon, cwd, { loading: true, approve: true, native: true, sessionId: first.sessionId })
  t.after(() => second.connection.close())
  await finishChildren(service)
  const state = await service.state.snapshot()
  assert.equal(Object.values(state.runs)[0].status, 'completed')
  assert.equal(Object.values(state.runs)[0].output, 'approval\n')
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), 'approval\n')
  await second.connection.agent.request(methods.agent.session.prompt, {
    sessionId: second.sessionId, prompt: [{ type: 'text', text: 'Follow up' }],
  })
  assert.ok(second.updates.some(event => event.update.content?.text === 'Next turn.'))
  assert.equal(second.updates.filter(event => event.update.content?.text === 'Next turn.').length, 1)
})

test('Stop cancels a restored main turn and its child without a turn row', { timeout: 15000 }, async t => {
  const { daemon, cwd, service, fake } = await fixture(t, 'wait')
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'wait' }), { stopReason: 'toolUse' }),
    async (_context, options) => {
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      return fauxAssistantMessage('Interrupted', { stopReason: 'aborted' })
    },
    fauxAssistantMessage('Cancelled.'),
  ])
  const receipt = await daemon.json('/input', { requestId: 'cancel', text: 'Work' })
  await waitForState(service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  const stops = []
  const request = daemon.json.bind(daemon)
  daemon.json = (path, body, signal) => { if (path === '/cancel') stops.push(body); return request(path, body, signal) }
  const viewer = await attach(daemon, cwd, { loading: true, native: true })
  t.after(() => viewer.connection.close())
  assert.ok(!viewer.updates.some(event => event.update.taskType === 'turn'))
  const row = viewer.updates.find(event => event.update.sessionUpdate === 'async_task_spawned')
  assert.equal(row.update.name, 'wait')
  const finished = viewer.connection.nextUpdate(event => event.update.sessionUpdate === 'async_task_state_update')
  await viewer.connection.agent.notify(methods.agent.session.cancel, { sessionId: viewer.sessionId })
  const settled = await daemon.json(`/wait?submission=${receipt.submissionId}`)
  assert.equal(settled.status, 'cancelled')
  assert.deepEqual(stops, [{ mainRunId: receipt.mainRunId }])
  assert.deepEqual((await finished).update, { sessionUpdate: 'async_task_state_update', asyncTaskId: row.update.asyncTaskId, state: 'stopped' })
  await waitForState(service.state, state => Object.values(state.runs)[0]?.status === 'cancelled' ? true : undefined)
  // The view now shows no turn. So a later stop must not reach the daemon, where it can cancel a turn that started since.
  await viewer.connection.agent.notify(methods.agent.session.cancel, { sessionId: viewer.sessionId })
  await viewer.connection.agent.request(methods.agent.session.close, { sessionId: viewer.sessionId })
  assert.equal(stops.length, 1)
})

test('a stop for an ended turn does not cancel the next turn', { timeout: 10000 }, async t => {
  const { daemon, fake } = await fixture(t)
  const answering = Promise.withResolvers()
  fake.setResponses([
    fauxAssistantMessage('The first reply.'),
    async (_context, options) => {
      answering.resolve()
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      return fauxAssistantMessage('Interrupted', { stopReason: 'aborted' })
    },
  ])
  const first = await daemon.json('/input', { requestId: 'first', text: 'Hello' })
  await daemon.json(`/wait?submission=${first.submissionId}`)
  const second = await daemon.json('/input', { requestId: 'second', text: 'Hello again' })
  await answering.promise
  assert.deepEqual(await daemon.json('/cancel', { mainRunId: first.mainRunId }), { cancelled: false })
  assert.equal((await daemon.json('/state')).current.id, second.mainRunId)
  assert.equal((await daemon.json('/state')).current.cancelling, false)
  assert.deepEqual(await daemon.json('/cancel', { mainRunId: second.mainRunId }), { cancelled: true })
  assert.equal((await daemon.json(`/wait?submission=${second.submissionId}`)).status, 'cancelled')
})

test('the chat lists running children instead of coordinator tool calls', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake, service } = await fixture(t)
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'approval', title: 'Fix the icon' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Started.'),
    fauxAssistantMessage('Done.'),
  ])
  const viewer = await attach(daemon, cwd, { native: true })
  t.after(() => viewer.connection.close())
  const project = basename(cwd)
  const rows = () => viewer.updates.filter(event => event.update.sessionUpdate?.startsWith('async_task')).map(event => event.update)
  const waitingRow = viewer.connection.nextUpdate(event => event.update.description === `Claude · ${project} · waiting for permission`)
  await viewer.connection.agent.request(methods.agent.session.prompt, {
    sessionId: viewer.sessionId, prompt: [{ type: 'text', text: 'Work' }],
  })
  const waiting = await waitingRow
  assert.equal(waiting.update.name, 'Fix the icon')
  const permission = await waitForState(service.state, state => Object.values(state.permissions).find(p => p.status === 'pending'))
  const done = viewer.connection.nextUpdate(event => event.update.content?.text === 'Done.')
  await daemon.json('/permission', { id: permission.id, decision: 'yes' })
  await done
  await finishChildren(service)
  const spawned = rows().filter(update => update.sessionUpdate === 'async_task_spawned')
  assert.ok(spawned.length >= 2)
  assert.ok(spawned.every(update => update.name === 'Fix the icon' && update.taskType === 'agent' && !update.canStop
    && update.description.startsWith(`Claude · ${project}`) && !update.description.includes('approval\n')))
  assert.ok(spawned.some(update => update.description === `Claude · ${project}`))
  const closed = new Set(rows().filter(update => update.sessionUpdate === 'async_task_state_update').map(update => update.asyncTaskId))
  assert.ok(spawned.every(update => closed.has(update.asyncTaskId)))
  assert.ok(!viewer.updates.some(event => ['tool_call', 'tool_call_update'].includes(event.update.sessionUpdate)))
  assert.ok(viewer.updates.some(event => event.update.content?.text === 'Started.'))
  const history = (await service.view()).entries.flatMap(entry => entry.model ?? [])
  assert.ok(history.some(model => model.role === 'assistant' && model.content.some(block => block.type === 'toolCall' && block.name === 'agents_spawn')))
})

test('an exited agent continues its session once without sending the dispatch again', { timeout: 15000 }, async t => {
  const { daemon, cwd, service } = await fixture(t, 'crash')
  service.state.resumeDelayMs = 0
  const first = await daemon.json('/input', { requestId: 'crash', text: 'Work' })
  await daemon.json(`/wait?submission=${first.submissionId}`)
  await finishChildren(service)
  const duplicate = await daemon.json('/input', { requestId: 'crash', text: 'Work' })
  assert.equal(duplicate.submissionId, first.submissionId)
  const [interrupted, continued] = Object.values((await service.state.snapshot()).runs)
  assert.equal(interrupted.status, 'resumed')
  assert.equal(interrupted.resumedBy, continued.id)
  assert.equal(continued.status, 'completed')
  assert.equal(continued.resumeOf, interrupted.id)
  assert.equal(continued.childSessionId, interrupted.childSessionId)
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'session-request.json'), 'utf8')),
    { operation: 'load', sessionId: 'fake-session', claudeOptions: true })
  assert.equal(continued.task, 'crash')
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), `crash\n${message('child.continue')}\n\n${message('child.task')}\ncrash\n`)
})

test('an agent without an HTTP MCP server ends its run with that reason and gets no continuation', { timeout: 10000 }, async t => {
  const { cwd, service } = await fixture(t, 'hello', 'claude', { env: { FAKE_ACP_HTTP: '0' } })
  service.state.resumeDelayMs = 0
  await service.submit('work', 'Work')
  const state = await finishChildren(service)
  const runs = Object.values(state.runs)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'interrupted')
  assert.equal(runs[0].error, message('error.agentHttp'))
  await assert.rejects(readFile(join(cwd, 'dispatches'), 'utf8'), { code: 'ENOENT' })
})

test('a stop of the daemon continues a running child without the count of an attempt, and the continuation quotes the task', { timeout: 15000 }, async t => {
  const { cwd, service, children, server } = await fixture(t, 'wait')
  service.state.resumeDelayMs = 0
  await service.submit('work', 'Work')
  await waitForState(service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  // The state names the dispatch before the agent gets the prompt. So wait until the agent recorded the prompt.
  while (await readFile(join(cwd, 'dispatches'), 'utf8').catch(() => '') !== 'wait\n') await new Promise(resolve => setTimeout(resolve, 10))
  await children.close()
  const [stopped, continued] = Object.values((await service.state.snapshot()).runs)
  assert.equal(stopped.status, 'resumed')
  assert.equal(stopped.plannedStop, true)
  assert.equal(continued.resumeAttempt, 0)
  assert.equal(continued.task, 'wait')
  // A new run service stands for the next daemon. It sends the continuation, and the fake agent ends that prompt.
  const next = new AcpRunService(service.state, { childLaunch: async () => ({ env: process.env }) }, {
    args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], historyServer: server.historyConfiguration(),
  })
  t.after(() => next.close())
  await next.start()
  const state = await finishChildren(service)
  assert.equal(state.runs[continued.id].status, 'completed')
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), `wait\n${message('child.continue')}\n\n${message('child.task')}\nwait\n`)
})

test('a failed Central configuration starts no child agent and gets no continuation', { timeout: 10000 }, async t => {
  const { cwd, service, launchedAgents } = await fixture(t, 'hello', 'claude', { launchError: new MegachatError('central') })
  service.state.resumeDelayMs = 0
  t.mock.method(process.stderr, 'write', () => true)
  await service.submit('work', 'Work')
  const state = await finishChildren(service)
  t.mock.restoreAll()
  const runs = Object.values(state.runs)
  assert.deepEqual(launchedAgents, ['claude'])
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'interrupted')
  assert.equal(runs[0].error, message('error.central'))
  assert.equal(runs[0].pid, null)
  // The fake agent writes these files at its start and at its prompt.
  await assert.rejects(readFile(join(cwd, 'session-request.json'), 'utf8'), { code: 'ENOENT' })
  await assert.rejects(readFile(join(cwd, 'dispatches'), 'utf8'), { code: 'ENOENT' })
})

test('a view replays a conversation of 250 entries in order, and a history request returns at most 100 entries', { timeout: 20000 }, async t => {
  const { daemon, cwd, service } = await fixture(t)
  for (let index = 0; index < 250; index++) {
    const submission = await service.root.submit({ type: 'write', entry: {
      kind: 'test.history', model: [{ role: 'user', content: `Message ${index}`, timestamp: 0 }],
    } }, BACKGROUND_CONTEXT)
    await submission.wait(BACKGROUND_CONTEXT)
  }
  const page = await daemon.json('/history?before=1000000&after=0')
  assert.equal(page.items.length, 100)
  const viewer = await attach(daemon, cwd, { loading: true, native: true })
  t.after(() => viewer.connection.close())
  const replay = viewer.updates.filter(event => event.update.sessionUpdate === 'user_message_chunk')
  assert.deepEqual(replay.map(event => event.update.content.text), Array.from({ length: 250 }, (_, index) => `Message ${index}`))
  assert.deepEqual(replay.map(event => event._meta.loadSessionReplayIndex), Array.from({ length: 250 }, (_, index) => index))
  assert.equal(replay.filter(event => event._meta.loadSessionEndOfRecordedHistory).length, 1)
  assert.equal(replay.at(-1)._meta.loadSessionEndOfRecordedHistory, true)
})

test('storage has one owner and rejects unauthenticated clients', { timeout: 10000 }, async t => {
  const { cwd, daemon } = await fixture(t)
  const owner = await DaemonDirectory.acquire(cwd)
  await assert.rejects(DaemonDirectory.acquire(cwd), { code: 'lock' })
  await owner.close()
  await (await DaemonDirectory.acquire(cwd)).close()
  const response = await fetch(`http://127.0.0.1:${daemon.descriptor.port}/state`)
  assert.equal(response.status, 401)
})

test('delegated output stays in durable storage and never enters the main transcript', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake, service } = await fixture(t, 'hello')
  const viewer = await attach(daemon, cwd, { native: true })
  t.after(() => viewer.connection.close())
  await viewer.connection.agent.request(methods.agent.session.prompt, {
    sessionId: viewer.sessionId, prompt: [{ type: 'text', text: 'Work' }],
    _meta: { jetbrains: { air: { clientMessageId: 'native-request' } } },
  })
  await finishChildren(service)
  assert.ok(viewer.updates.every(event => event.sessionId === viewer.sessionId))
  assert.ok(!viewer.updates.some(event => ['subagent_spawned', 'subagent_state_update', 'tool_call', 'tool_call_update'].includes(event.update.sessionUpdate)))
  assert.ok(!viewer.updates.some(event => event.update.content?.text === 'hello\n'))
  assert.ok((await daemon.json('/state')).inputs['native-request'])
  const first = Object.values((await daemon.json('/state')).runs)[0]
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_send', { cwd, childSessionId: first.childSessionId, prompt: 'follow-up' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Done.'),
    fauxAssistantMessage('The follow-up finished.'),
  ])
  const receipt = await daemon.json('/input', { requestId: 'follow-up', text: 'Continue' })
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  await finishChildren(service)
  const second = Object.values((await daemon.json('/state')).runs).at(-1)
  assert.equal(second.childSessionId, first.childSessionId)
  assert.equal(second.providerSessionId, first.providerSessionId)
  assert.equal(second.output, 'hello\nfollow-up\n')
  assert.notEqual(second.id, first.id)
})

test('pooled ACP views share history and close independently', { timeout: 10000 }, async t => {
  const { daemon, cwd, service } = await fixture(t, 'hello')
  const viewer = await attach(daemon, cwd, { native: true })
  t.after(() => viewer.connection.close())
  await viewer.connection.agent.request(methods.agent.session.prompt, {
    sessionId: viewer.sessionId, prompt: [{ type: 'text', text: 'Work' }],
  })
  await finishChildren(service)
  const second = await viewer.connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  assert.notEqual(second.sessionId, viewer.sessionId)
  const replay = viewer.updates.filter(event => event.sessionId === second.sessionId)
  assert.ok(replay.some(event => event.update.sessionUpdate === 'session_info_update' && event.update.title === 'Megachat'))
  assert.ok(replay.some(event => event.update.sessionUpdate === 'user_message_chunk' && event.update.content.text === 'Work'))
  assert.ok(replay.some(event => event.update.content?.text === 'The child finished.' && event._meta?.loadSessionEndOfRecordedHistory))
  assert.equal(replay.filter(event => event.update.sessionUpdate === 'user_message_chunk').length, 1)
  const children = viewer.updates.filter(event => event.update.sessionUpdate === 'subagent_spawned')
  assert.equal(children.length, 0)
  await viewer.connection.agent.request(methods.agent.session.close, { sessionId: viewer.sessionId })
  await viewer.connection.agent.request(methods.agent.session.prompt, {
    sessionId: second.sessionId, prompt: [{ type: 'text', text: 'Continue' }],
  })
  assert.ok(viewer.updates.some(event => event.sessionId === second.sessionId && event.update.content?.text === 'Next turn.'))
  assert.equal(Object.keys((await daemon.json('/state')).inputs).length, 3)
})


/**
 * A daemon for a bridge without a server. Call [index] of `/workspace` returns `workspaces[index]`, else at once. Watch
 * [index] sends the conversation and the tasks unless `quiet[index]`. `open` holds each watch until its signal aborts.
 */
function stubDaemon({ workspaces = [], quiet = [] } = {}) {
  let workspaceCalls = 0
  const daemon = { open: new Set(), watches: 0 }
  daemon.json = async path => {
    assert.equal(path, '/workspace')
    return workspaces[workspaceCalls++] ?? {}
  }
  daemon.watch = (consumer, signal) => new Promise((resolve, reject) => {
    const index = daemon.watches++
    const end = () => { daemon.open.delete(index); reject(new DOMException('The operation was aborted.', 'AbortError')) }
    if (signal.aborted) { end(); return }
    daemon.open.add(index)
    signal.addEventListener('abort', end, { once: true })
    if (quiet[index]) return
    consumer({ type: 'conversation', value: { entries: [] } })
      .then(() => consumer({ type: 'tasks', value: { current: null, runs: {}, permissions: {} } })).catch(reject)
  })
  return daemon
}

function stubBridge(daemon) {
  const bridge = new AcpBridge(daemon)
  bridge.connection = { client: { notify: async () => {}, request: async () => ({}) }, close: () => {} }
  return bridge
}

test('a second load of a session ID during the attach replaces the first view without a ghost watch', { timeout: 10000 }, async () => {
  const load = { params: { sessionId: 'megachat', cwd: '/project' } }
  // The first view closes while it waits for the daemon to register its directory.
  const workspace = Promise.withResolvers()
  let daemon = stubDaemon({ workspaces: [workspace.promise] })
  let bridge = stubBridge(daemon)
  let first = bridge.attach(load, true)
  first.catch(() => {})
  assert.deepEqual(await bridge.attach(load, true), {})
  const second = bridge.view('megachat')
  workspace.resolve({})
  await assert.rejects(first, { code: 'missing' })
  assert.equal(bridge.view('megachat'), second)
  assert.equal(daemon.watches, 1)
  bridge.close()
  assert.equal(daemon.open.size, 0)
  // The first view closes while it waits for the first events. Its failure must not remove the second view.
  daemon = stubDaemon({ quiet: [true] })
  bridge = stubBridge(daemon)
  first = bridge.attach(load, true)
  first.catch(() => {})
  while (daemon.watches === 0) await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await bridge.attach(load, true), {})
  await assert.rejects(first)
  assert.ok(bridge.view('megachat'))
  assert.equal(daemon.open.size, 1)
  bridge.close()
  assert.equal(daemon.open.size, 0)
})

test('a prompt gives each resource_link block to the main agent as a Markdown link, and refuses an image', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake } = await fixture(t)
  fake.setResponses([fauxAssistantMessage('Read.')])
  const viewer = await attach(daemon, cwd)
  t.after(() => viewer.connection.close())
  const prompt = blocks => viewer.connection.agent.request(methods.agent.session.prompt, { sessionId: viewer.sessionId, prompt: blocks })
  await assert.rejects(prompt([{ type: 'text', text: 'Look' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]))
  const { stopReason } = await prompt([{ type: 'text', text: 'Read this file:' },
    { type: 'resource_link', name: 'notes.md', uri: 'file:///project/notes.md', mimeType: 'text/markdown' },
    { type: 'text', text: 'and say what it holds.' }])
  assert.equal(stopReason, 'end_turn')
  const restored = await attach(daemon, cwd)
  t.after(() => restored.connection.close())
  assert.deepEqual(restored.updates.filter(event => event.update.sessionUpdate === 'user_message_chunk').map(event => event.update.content.text),
    ['Read this file:\n[notes.md](file:///project/notes.md)\nand say what it holds.'])
})

test('service session registration covers live and restored children only when supported', { timeout: 10000 }, async t => {
  const { daemon, cwd } = await fixture(t, 'hello')
  const viewer = await attach(daemon, cwd, { native: true, serviceSessions: true })
  t.after(() => viewer.connection.close())
  const completed = viewer.connection.nextUpdate(event => event.update.content?.text === 'The child finished.')
  await viewer.connection.agent.request(methods.agent.session.prompt, {
    sessionId: viewer.sessionId, prompt: [{ type: 'text', text: 'Work' }],
  })
  await completed
  const run = Object.values((await daemon.json('/state')).runs)[0]
  const address = { agentId: 'claude', sessionId: run.providerSessionId, cwd }
  assert.deepEqual(viewer.registrations, [address])
  const restored = await attach(daemon, cwd, { native: true, serviceSessions: true })
  t.after(() => restored.connection.close())
  assert.deepEqual(restored.registrations, [address])
  assert.ok(!restored.updates.some(event => ['subagent_spawned', 'subagent_state_update', 'tool_call'].includes(event.update.sessionUpdate)))
  const legacy = await attach(daemon, cwd, { native: true })
  t.after(() => legacy.connection.close())
  assert.deepEqual(legacy.registrations, [])
})

test('a delegated session stays a service session after its runs are dropped', { timeout: 15000 }, async t => {
  const { daemon, cwd, fake, service } = await fixture(t, 'hello')
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'hello' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
    fauxAssistantMessage('The child finished.'),
    fauxAssistantMessage(fauxToolCall('agents_resume', { cwd, agent: 'codex', sessionId: 'active', prompt: 'hello' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Resumed.'),
    fauxAssistantMessage('The resumed session finished.'),
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'hello', agent: 'codex' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated again.'),
    fauxAssistantMessage('The new child finished.'),
  ])
  const viewer = await attach(daemon, cwd, { native: true, serviceSessions: true })
  t.after(() => viewer.connection.close())
  const send = async (requestId, text) => {
    const receipt = await daemon.json('/input', { requestId, text })
    await daemon.json(`/wait?submission=${receipt.submissionId}`)
    return finishChildren(service)
  }
  const [delegated] = Object.values((await send('delegate', 'Work')).runs)
  const [, continued] = Object.values((await send('continue', 'Continue my Codex session')).runs)
  assert.equal(continued.serviceSession, false)
  // Older delegated runs without a provider session fill the state up to the prune count.
  await service.state.change(state => {
    for (let index = 0; index < 62; index++) {
      const id = `older-${index}`
      state.runs[id] = { ...delegated, id, childSessionId: id, requestId: id, providerSessionId: null, finishedAt: continued.finishedAt + index + 1 }
    }
  })
  await send('again', 'Delegate one more task')
  const state = await service.state.snapshot()
  assert.equal(state.runs[delegated.id], undefined)
  assert.equal(state.runs[continued.id], undefined)
  const restored = await attach(daemon, cwd, { native: true, serviceSessions: true })
  t.after(() => restored.connection.close())
  assert.deepEqual(restored.registrations, [
    { agentId: 'claude', sessionId: delegated.providerSessionId, cwd },
    { agentId: 'codex', sessionId: 'fake-session', cwd },
  ])
  // A daemon of an older build has no serviceSessions map. The view then marks the sessions of the retained runs.
  await service.state.change(state => { delete state.serviceSessions })
  const older = await attach(daemon, cwd, { native: true, serviceSessions: true })
  t.after(() => older.connection.close())
  assert.deepEqual(older.registrations, [{ agentId: 'codex', sessionId: 'fake-session', cwd }])
})

test('a project event delivers a proposal to an idle view and replay hides its internal prompt', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake, service } = await fixture(t, 'approval', 'claude', { suggestions: true })
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_suggest', { proposal: 'Review the code change?' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Review the code change?'),
  ])
  const viewer = await attach(daemon, cwd, { native: true })
  t.after(() => viewer.connection.close())
  const reply = viewer.connection.nextUpdate(event => event.update.content?.text === 'Review the code change?')
  const event = { cwd, revision: 'change-1', paths: ['src/main.kt'] }
  assert.equal((await daemon.json('/project-event', event)).notify, true)
  await reply
  await waitForState(service.state, state => state.current === null ? true : undefined)
  assert.equal((await daemon.json('/project-event', event)).accepted, false)
  assert.equal(Object.keys((await service.state.snapshot()).runs).length, 0)
  const restored = await attach(daemon, cwd, { native: true })
  t.after(() => restored.connection.close())
  assert.ok(restored.updates.some(event => event.update.content?.text === 'Review the code change?'))
  assert.equal(restored.updates.filter(event => event.update.sessionUpdate === 'user_message_chunk').length, 0)
})


test('an application view registers trusted projects supplied by its client', { timeout: 10000 }, async t => {
  const { daemon, cwd, service } = await fixture(t)
  const project = await mkdtemp(join(tmpdir(), 'megachat-other-project-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const viewer = await attach(daemon, cwd, { native: true, workspaces: [project] })
  t.after(() => viewer.connection.close())
  assert.ok((await service.state.snapshot()).workspaces.includes(await realpath(project)))
})

test('a project directory that does not exist does not stop the attach or the other projects', { timeout: 10000 }, async t => {
  const { daemon, cwd, service } = await fixture(t)
  const project = await mkdtemp(join(tmpdir(), 'megachat-other-project-'))
  t.after(() => rm(project, { recursive: true, force: true }))
  const viewer = await attach(daemon, cwd, { native: true, workspaces: [join(project, 'deleted'), project] })
  t.after(() => viewer.connection.close())
  const { workspaces } = await service.state.snapshot()
  assert.ok(workspaces.includes(await realpath(project)))
  assert.ok(!workspaces.some(directory => directory.endsWith('deleted')))
})

test('a working directory of the view that the daemon cannot read does not stop session/new or session/load', { timeout: 10000 }, async t => {
  const { daemon, cwd, service } = await fixture(t)
  const deleted = join(cwd, 'deleted')
  const opened = await attach(daemon, deleted, { native: true })
  t.after(() => opened.connection.close())
  assert.match(opened.sessionId, /^megachat-/)
  const loaded = await attach(daemon, deleted, { native: true, loading: true })
  t.after(() => loaded.connection.close())
  assert.ok(loaded.updates.some(event => event.update.sessionUpdate === 'session_info_update'))
  assert.ok(!(await service.state.snapshot()).workspaces.some(directory => directory.endsWith('deleted')))
})

test('the main chat accepts another message while a child waits for permission', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake, service } = await fixture(t)
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'approval' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Working in the background.'),
    fauxAssistantMessage('We can talk while it works.'),
    fauxAssistantMessage('The background task finished.'),
  ])
  const viewer = await attach(daemon, cwd, { native: true })
  t.after(() => viewer.connection.close())
  const send = text => viewer.connection.agent.request(methods.agent.session.prompt, {
    sessionId: viewer.sessionId, prompt: [{ type: 'text', text }],
  })
  assert.equal((await send('Work')).stopReason, 'end_turn')
  const permission = await waitForState(service.state, state => Object.values(state.permissions).find(p => p.status === 'pending'))
  assert.equal((await service.state.snapshot()).current, null)
  assert.equal((await send('Can we talk?')).stopReason, 'end_turn')
  assert.ok(viewer.updates.some(event => event.update.content?.text === 'We can talk while it works.'))
  assert.ok(!viewer.updates.some(event => event.update.taskType === 'turn'))
  assert.equal((await service.state.snapshot()).permissions[permission.id].status, 'pending')
  const reply = viewer.connection.nextUpdate(event => event.update.content?.text === 'The background task finished.')
  await daemon.json('/permission', { id: permission.id, decision: 'yes' })
  await reply
  await finishChildren(service)
  assert.equal(viewer.updates.filter(event => event.update.content?.text === 'The background task finished.').length, 1)
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), 'approval\n')
})

test('the deadline of a child waits while one of two permission requests is pending', { timeout: 10000 }, async t => {
  const { daemon, service, children } = await fixture(t, 'approvals')
  const pending = state => Object.values(state.permissions).filter(permission => permission.status === 'pending')
  await service.submit('work', 'Work')
  const [first, second] = await waitForState(service.state, state => pending(state).length === 2 ? pending(state) : undefined)
  // The two requests stopped the long deadline of the launch. Each new start of the deadline now uses a short time,
  // so a deadline that starts after the first answer ends the child during the wait below.
  children.launch.deadlineMs = 200
  await daemon.json('/permission', { id: first.id, decision: 'yes' })
  await new Promise(resolve => setTimeout(resolve, 800))
  const [run] = Object.values((await service.state.snapshot()).runs)
  assert.ok(!terminalStates.has(run.status), `The run is ${run.status}`)
  // The agent needs time for its work after the last answer, also on a machine with much load.
  children.launch.deadlineMs = 10000
  await daemon.json('/permission', { id: second.id, decision: 'yes' })
  const state = await finishChildren(service)
  assert.equal(Object.values(state.runs)[0].status, 'completed')
})

test('new tasks queue without keeping the main conversation busy', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake, service } = await fixture(t)
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'approval' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('First task admitted.'),
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'second' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Second task queued.'),
    fauxAssistantMessage('First result.'),
    fauxAssistantMessage('Second result.'),
  ])
  const first = await daemon.json('/input', { requestId: 'first', text: 'First task' })
  await daemon.json(`/wait?submission=${first.submissionId}`)
  const permission = await waitForState(service.state, state => Object.values(state.permissions).find(p => p.status === 'pending'))
  const second = await daemon.json('/input', { requestId: 'second', text: 'Second task' })
  await daemon.json(`/wait?submission=${second.submissionId}`)
  const state = await service.state.snapshot()
  assert.equal(state.current, null)
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ['approval', 'admitted'])
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), 'approval\n')
  await daemon.json('/permission', { id: permission.id, decision: 'yes' })
  const finished = await finishChildren(service)
  assert.deepEqual(Object.values(finished.runs).map(run => run.status), ['completed', 'completed'])
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), 'approval\nsecond\n')
})

test('a child searches retained history outside the main model context', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake, service, server } = await fixture(t)
  fake.setResponses([fauxAssistantMessage('Saved.')])
  const saved = await service.submit('memory', 'The project codename is Juniper-742.')
  await daemon.json(`/wait?submission=${saved.submissionId}`)
  await service.root.reset('Earlier details are outside this context.', BACKGROUND_CONTEXT)
  fake.setResponses([
    transcript => {
      assert.ok(!JSON.stringify(transcript).includes('Juniper-742'))
      return fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'history:codename' }), { stopReason: 'toolUse' })
    },
    fauxAssistantMessage('Searching in the background.'),
    transcript => {
      assert.ok(JSON.stringify(transcript).includes('Juniper-742'))
      return fauxAssistantMessage('The codename was Juniper-742.')
    },
  ])
  const receipt = await service.submit('recall', 'Find the earlier project decision.')
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  const finished = await finishChildren(service)
  const history = JSON.parse(Object.values(finished.runs)[0].output)
  assert.ok(history.entries.some(entry => entry.text.includes('Juniper-742')))
  const configuration = server.historyConfiguration()
  const response = await fetch(new URL('/state', configuration.url), {
    headers: Object.fromEntries(configuration.headers.map(header => [header.name, header.value])),
  })
  assert.equal(response.status, 401, 'The child history token cannot access daemon controls')
  assert.ok(!JSON.stringify(finished).includes(configuration.headers[0].value))
})

test('a user message interrupts a result report and the result is reported later', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake, service } = await fixture(t, 'hello')
  const started = Promise.withResolvers()
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'hello' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
    async (_context, options) => {
      started.resolve()
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      return fauxAssistantMessage('Interrupted', { stopReason: 'aborted' })
    },
    fauxAssistantMessage('User reply.'),
    fauxAssistantMessage('The completed task result.'),
  ])
  await service.submit('work', 'Work')
  await started.promise
  const receipt = await service.submit('priority', 'Answer me first')
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  await finishChildren(service)
  const history = await service.history()
  assert.equal(history.entries.filter(entry => entry.text === 'User reply.').length, 1)
  assert.equal(history.entries.filter(entry => entry.text === 'The completed task result.').length, 1)
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), 'hello\n')
})


const modelError = () => fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'The provider is overloaded.' })
const settledReports = count => state => {
  const reports = Object.values(state.inputs).filter(input => input.resultRunIds)
  return reports.length === count && reports.every(report => report.status !== 'running') ? state : undefined
}

test('a result report that fails on a model error is sent once more', { timeout: 10000 }, async t => {
  const { cwd, fake, service } = await fixture(t, 'hello')
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'hello' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
    modelError(),
    fauxAssistantMessage('The completed task result.'),
  ])
  await service.submit('work', 'Work')
  const state = await waitForState(service.state, settledReports(2))
  const reports = Object.values(state.inputs).filter(input => input.resultRunIds)
  assert.deepEqual(reports.map(report => [report.status, report.reason]), [['interrupted', 'model_error'], ['completed', undefined]])
  assert.deepEqual(reports[1].resultRunIds, reports[0].resultRunIds)
  assert.ok(!JSON.stringify(state.inputs).includes('overloaded'))
  assert.equal(Object.values(state.runs)[0].reported, true)
  const history = await service.history()
  assert.equal(history.entries.filter(entry => entry.text === 'The completed task result.').length, 1)
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), 'hello\n')
})

test('a second failure of a result report ends the reports and keeps the result', { timeout: 10000 }, async t => {
  const { cwd, fake, service } = await fixture(t, 'hello')
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'hello' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
    modelError(),
    modelError(),
    fauxAssistantMessage('A third report.'),
  ])
  await service.submit('work', 'Work')
  await waitForState(service.state, settledReports(2))
  // The delay of a repeat is 20 ms in this fixture. So a third report would start in this time.
  await new Promise(resolve => setTimeout(resolve, 200))
  const state = await service.state.snapshot()
  const reports = Object.values(state.inputs).filter(input => input.resultRunIds)
  assert.deepEqual(reports.map(report => [report.status, report.reason]), [['interrupted', 'model_error'], ['interrupted', 'model_error']])
  const [run] = Object.values(state.runs)
  assert.equal(run.reported, true)
  assert.equal(state.current, null)
  assert.equal((await service.state.readRun(run.id)).status, 'completed')
  const events = (await service.root.entries({ order: 'ascending' }, 100, undefined, BACKGROUND_CONTEXT)).items
    .filter(entry => entry.kind === 'air.megachat.event')
  assert.equal(events.length, 2)
  assert.equal(events[0].data.results[0].runId, run.id)
})

test('a reply that fails on a model error tells the user that the model did not answer', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake } = await fixture(t)
  fake.setResponses([modelError()])
  const viewer = await attach(daemon, cwd, { native: true })
  t.after(() => viewer.connection.close())
  const reply = await viewer.connection.agent.request(methods.agent.session.prompt, {
    sessionId: viewer.sessionId, prompt: [{ type: 'text', text: 'Hello' }],
  })
  assert.equal(reply.stopReason, 'cancelled')
  const texts = viewer.updates.map(event => event.update.content?.text)
  assert.ok(texts.includes(message('error.model')))
  assert.ok(!texts.includes(message('error.interrupted')))
})


test('a user message interrupts an automatic event turn', { timeout: 10000 }, async t => {
  const { daemon, cwd, fake, service } = await fixture(t)
  const started = Promise.withResolvers()
  fake.setResponses([
    async (_context, options) => {
      started.resolve()
      await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
      return fauxAssistantMessage('Interrupted', { stopReason: 'aborted' })
    },
    fauxAssistantMessage('User reply.'),
  ])
  await daemon.json('/project-event', { cwd, revision: 'interruptible-event', paths: ['src/main.kt'] })
  await started.promise
  const receipt = await daemon.json('/input', { requestId: 'user-priority', text: 'My task comes first' })
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  const state = await service.state.snapshot()
  assert.equal(state.inputs['user-priority'].status, 'completed')
  assert.equal(state.current, null)
  assert.ok((await service.view()).entries.some(entry => entry.model?.some(item =>
    item.role === 'assistant' && item.content.some(block => block.text === 'User reply.'))))
})

test('a child searches the whole retained history through the search index', { timeout: 10000 }, async t => {
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const directory = await mkdtemp(join(tmpdir(), 'megachat-search-integration-'))
  const fake = fauxProvider()
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id },
    undefined, { searchPath: join(directory, 'search.sqlite') })
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  t.after(async () => { await server.close(); await service.close(); await rm(directory, { force: true, recursive: true }) })
  for (let i = 0; i < 12; i++) {
    fake.setResponses([fauxAssistantMessage(i === 3 ? 'Готовлю иконку Gothic M.' : `Answer ${i}.`)])
    const receipt = await service.submit(`input-${i}`, i === 7 ? 'Запусти tokprofiler' : `Juniper note ${i}`)
    await daemon.json(`/wait?submission=${receipt.submissionId}`)
  }
  const configuration = server.historyConfiguration()
  const history = new Client({ name: 'search-test', version: '1' })
  await history.connect(new StreamableHTTPClientTransport(new URL(configuration.url), {
    requestInit: { headers: Object.fromEntries(configuration.headers.map(header => [header.name, header.value])) },
  }))
  t.after(() => history.close())
  const call = async args => JSON.parse((await history.callTool({ name: 'history', arguments: args })).content[0].text)

  const icon = await call({ query: 'иконк' })
  assert.deepEqual(icon.hits.map(hit => [hit.role, hit.snippet]), [['assistant', 'Готовлю иконку Gothic M.']])
  assert.equal(icon.nextCursor, null)
  assert.match(icon.hits[0].timestamp, /^\d{4}-/)
  assert.equal((await call({ query: 'TOKPROF' })).hits[0].snippet, 'Запусти tokprofiler')

  const first = await call({ query: 'juniper' })
  assert.equal(first.hits.length, 10)
  const second = await call({ query: 'juniper', cursor: first.nextCursor })
  assert.equal(second.nextCursor, null)
  assert.equal(new Set([...first.hits, ...second.hits].map(hit => hit.entryId)).size, 11)

  const read = await call({ beforeEntryId: icon.hits[0].entryId + 1 })
  assert.equal(read.entries[0].text, 'Готовлю иконку Gothic M.')
  const short = await call({ query: 'M.' })
  assert.ok(short.entries.some(entry => entry.text === 'Готовлю иконку Gothic M.'), 'A short query keeps the literal history scan')
  assert.equal(short.hits, undefined)
})

/** Waits until the fake agent got the prompt of the first run, so a steer reaches a turn that runs. */
async function dispatched(cwd, text) {
  while (!(await readFile(join(cwd, 'dispatches'), 'utf8').catch(() => '')).startsWith(text)) await new Promise(resolve => setTimeout(resolve, 10))
}

/** A turn of the user in which the main agent calls `agents_steer` once. Gives the tool result. */
async function steerTurn(service, daemon, fake, requestId, args) {
  const answer = Promise.withResolvers()
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_steer', args), { stopReason: 'toolUse' }),
    context => {
      const toolResult = context.messages.at(-1)
      answer.resolve({ isError: toolResult.isError, value: toolResult.content[0].text })
      return fauxAssistantMessage('Steered.')
    },
    fauxAssistantMessage('The child finished.'),
    fauxAssistantMessage('The child finished again.'),
  ])
  const receipt = await service.submit(requestId, 'Add this to the task')
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  const { isError, value } = await answer.promise
  return isError ? { error: value } : JSON.parse(value)
}

const reportsOf = state => Object.values(state.inputs).filter(input => input.resultRunIds).map(input => input.resultRunIds)
const steerings = async cwd => (await readFile(join(cwd, 'steerings'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(line => JSON.parse(line))

test('a steer gives a message to the turn that runs, and the run ends with one report', { timeout: 15000 }, async t => {
  const { cwd, daemon, fake, service } = await fixture(t, 'steer')
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'steer' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
  ])
  await daemon.json(`/wait?submission=${(await service.submit('work', 'Work')).submissionId}`)
  await dispatched(cwd, 'steer')
  const [run] = Object.values((await service.state.snapshot()).runs)
  const steered = await steerTurn(service, daemon, fake, 'link', { childSessionId: run.childSessionId, prompt: 'Use https://example.com/a' })
  assert.equal(steered.outcome, 'injected')
  assert.equal(steered.runId, run.id)
  const state = await finishChildren(service)
  assert.equal(Object.keys(state.runs).length, 1)
  assert.equal(state.runs[run.id].status, 'completed')
  assert.equal(state.runs[run.id].steers[0].delivery, 'delivered')
  assert.equal(state.runs[run.id].output, `steered: ${message('child.steer')}\n\nUse https://example.com/a\n`)
  assert.deepEqual(reportsOf(state), [[run.id]])
  const [request] = await steerings(cwd)
  assert.equal(request.sessionId, 'fake-session')
  assert.deepEqual(request._meta, { steering: { idleBehavior: 'promptRequired' } })
})

test('a steer that the state records at once after the dispatch reaches the turn without a later update of the run', { timeout: 15000 }, async t => {
  const { cwd, fake, service } = await fixture(t, 'steer')
  const steer = Promise.withResolvers()
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'steer' }), { stopReason: 'toolUse' }),
    // The turn of the user is current while the model answers, so the state accepts the steer.
    async () => {
      const watch = await service.state.watch()
      const run = await new Promise(resolve => watch.start(call => {
        const value = call.kind === 'value' && Object.values(call.value.runs).find(item => item.status === 'dispatched')
        if (value) resolve(value)
      }))
      steer.resolve(await service.state.steer('at-once', { childSessionId: run.childSessionId, prompt: 'Use the link', mode: 'queue' }))
      await watch.stop()
      return fauxAssistantMessage('Delegated.')
    },
  ])
  await service.submit('work', 'Work')
  const { id, runId } = await steer.promise
  // The fake turn waits for the message. Only the first send after the dispatch can give it.
  const delivery = await waitForState(service.state, state => state.runs[runId].steers[0].delivery === 'pending' ? undefined
    : state.runs[runId].steers[0].delivery, { timeoutMs: 5000 })
  assert.equal(delivery, 'delivered')
  assert.equal(findSteer(await service.state.snapshot(), id).item.outcome, 'injected')
})

test('a call for a send at the end of a send starts one more send', { timeout: 5000 }, async () => {
  const children = new AcpRunService(null, null)
  const work = { delivering: null, ended: false }
  let sends = 0
  children.sendSteers = () => {
    sends++
    // The second reaction runs after the loop of the send looked at `again` for the last time. A steer that the state
    // records then must get its own send.
    if (sends === 1) Promise.resolve().then(() => {}).then(() => children.deliverSteers('run', 'generation', work, {}))
    return Promise.resolve()
  }
  await children.deliverSteers('run', 'generation', work, {})
  await new Promise(resolve => setImmediate(resolve))
  await work.delivering
  assert.equal(sends, 2)
})

test('a steer after the end of the turn becomes a follow-up in the same session with one report', { timeout: 15000 }, async t => {
  const { cwd, daemon, fake, service } = await fixture(t, 'steer', 'claude', { env: { FAKE_ACP_STEERING: 'promptRequired' } })
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'steer' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
  ])
  await daemon.json(`/wait?submission=${(await service.submit('work', 'Work')).submissionId}`)
  await dispatched(cwd, 'steer')
  const [run] = Object.values((await service.state.snapshot()).runs)
  const steered = await steerTurn(service, daemon, fake, 'late', { childSessionId: run.childSessionId, prompt: 'One more file' })
  assert.equal(steered.outcome, 'followUp')
  const state = await finishChildren(service)
  const [first, next] = Object.values(state.runs)
  assert.equal(first.status, 'resumed')
  assert.equal(next.status, 'completed')
  assert.equal(next.resumeOf, first.id)
  assert.equal(next.providerSessionId, first.providerSessionId)
  assert.equal(next.prompt, message('child.steer.followUp'))
  assert.deepEqual(reportsOf(state), [[next.id]])
  const prompts = (await readFile(join(cwd, 'prompts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  // The steering request went out, so the agent can have the message: the follow-up marks it as a possible repeat.
  assert.equal(prompts[1].at(-1), `${message('child.steer.added')}\n\n${message('child.steer.repeat', 1)}\nOne more file`)
  assert.equal(JSON.parse(await readFile(join(cwd, 'session-request.json'), 'utf8')).operation, 'load')
})

for (const [mode, env, sent] of [['an agent without steering', 'off', 0], ['a failed steering', 'failed', 1],
  ['an error of the steering request', 'error', 1], ['mode interrupt', 'injected', 0]]) {
  test(`with ${mode}, a steer cancels the turn and continues the session with the message and one report`, { timeout: 15000 }, async t => {
    const { cwd, daemon, fake, service } = await fixture(t, 'steer', 'claude', { env: { FAKE_ACP_STEERING: env } })
    fake.setResponses([
      fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'steer' }), { stopReason: 'toolUse' }),
      fauxAssistantMessage('Delegated.'),
    ])
    await daemon.json(`/wait?submission=${(await service.submit('work', 'Work')).submissionId}`)
    await dispatched(cwd, 'steer')
    const [run] = Object.values((await service.state.snapshot()).runs)
    const steered = await steerTurn(service, daemon, fake, 'redirect', { childSessionId: run.childSessionId, prompt: 'Use the other branch',
      ...(mode === 'mode interrupt' ? { mode: 'interrupt' } : {}) })
    assert.equal(steered.outcome, 'restarted')
    const state = await finishChildren(service)
    const [first, next] = Object.values(state.runs)
    assert.equal(first.status, 'resumed')
    assert.equal(first.steerRestart, true)
    assert.equal(first.stopReason, 'cancelled')
    assert.equal(next.status, 'completed')
    assert.equal(next.resumeAttempt, 0)
    assert.equal(next.task, 'steer')
    assert.deepEqual(reportsOf(state), [[next.id]])
    assert.equal((await steerings(cwd)).length, sent)
    const prompts = (await readFile(join(cwd, 'prompts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    assert.equal(prompts.length, 2)
    assert.equal(prompts[1].at(-2), `${message('child.steer.restarted')}\n\n${message('child.task')}\nsteer`)
    assert.equal(prompts[1].at(-1), `${message('child.steer.added')}\n\n${message(sent ? 'child.steer.repeat' : 'child.steer.message', 1)}\nUse the other branch`)
  })
}

test('a message that the agent takes but does not answer before the end of its turn gets a follow-up', { timeout: 15000 }, async t => {
  const { cwd, daemon, fake, service } = await fixture(t, 'steer', 'claude', { env: { FAKE_ACP_STEERING: 'drop' } })
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'steer' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
  ])
  await daemon.json(`/wait?submission=${(await service.submit('work', 'Work')).submissionId}`)
  await dispatched(cwd, 'steer')
  const [run] = Object.values((await service.state.snapshot()).runs)
  assert.equal((await steerTurn(service, daemon, fake, 'dropped', { childSessionId: run.childSessionId, prompt: 'Also test it' })).outcome, 'injected')
  const state = await finishChildren(service)
  const [first, next] = Object.values(state.runs)
  assert.equal(first.status, 'resumed')
  assert.equal(next.status, 'completed')
  assert.equal(next.prompt, message('child.steer.followUp'))
  assert.equal(next.steers[0].repeat, true)
  assert.deepEqual(reportsOf(state), [[next.id]])
})

test('the rest of the reply that streamed at the answer is no work for the message, so the message gets a follow-up', { timeout: 15000 }, async t => {
  const { cwd, daemon, fake, service } = await fixture(t, 'steer', 'codex', { env: { FAKE_ACP_STEERING: 'trail' } })
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'steer', agent: 'codex' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
  ])
  await daemon.json(`/wait?submission=${(await service.submit('work', 'Work')).submissionId}`)
  await dispatched(cwd, 'steer')
  const [run] = Object.values((await service.state.snapshot()).runs)
  assert.equal((await steerTurn(service, daemon, fake, 'trail', { childSessionId: run.childSessionId, prompt: 'Also test it' })).outcome, 'injected')
  const state = await finishChildren(service)
  const [first, next] = Object.values(state.runs)
  assert.equal(first.output, 'The reply ends here.\n')
  assert.equal(first.status, 'resumed')
  assert.equal(next.status, 'completed')
  assert.equal(next.prompt, message('child.steer.followUp'))
  assert.deepEqual(next.steers.map(item => [item.text, item.repeat]), [['Also test it', true]])
  assert.deepEqual(reportsOf(state), [[next.id]])
})

test('a steer keeps a permission request pending, and a steer of a queued run changes its prompt and calls no agent', { timeout: 15000 }, async t => {
  const { cwd, daemon, fake, service } = await fixture(t)
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'approval' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'second' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
  ])
  await daemon.json(`/wait?submission=${(await service.submit('work', 'Work')).submissionId}`)
  const permission = await waitForState(service.state, state => Object.values(state.permissions).find(p => p.status === 'pending'))
  const [first, second] = Object.values((await service.state.snapshot()).runs)
  assert.equal(second.status, 'admitted')
  const rows = [...taskRows(await service.state.snapshot()).keys()]
  assert.equal((await steerTurn(service, daemon, fake, 'queued', { childSessionId: second.childSessionId, prompt: 'Name it B' })).outcome, 'queued')
  assert.deepEqual(await steerings(cwd), [])
  assert.equal((await steerTurn(service, daemon, fake, 'waiting', { childSessionId: first.childSessionId, prompt: 'Name it A' })).outcome, 'injected')
  let state = await service.state.snapshot()
  assert.equal(state.permissions[permission.id].status, 'pending')
  assert.equal(state.runs[first.id].status, 'approval')
  // The chat keeps each task with its ID and its phase.
  assert.deepEqual([...taskRows(state).keys()], rows)
  fake.setResponses([fauxAssistantMessage('The first finished.'), fauxAssistantMessage('The second finished.')])
  await daemon.json('/permission', { id: permission.id, decision: 'yes' })
  state = await finishChildren(service)
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ['completed', 'completed'])
  assert.equal((await steerings(cwd)).length, 1)
  const prompts = (await readFile(join(cwd, 'prompts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(prompts[1].slice(-2), ['second', `${message('child.steer.added')}\n\n${message('child.steer.message', 1)}\nName it B`])
  assert.equal(state.runs[second.id].prompt, 'second')
})

test('a turn of a project event or of a child result cannot steer, and a follow-up to a working child names agents_steer', { timeout: 15000 }, async t => {
  const { cwd, daemon, fake, service, server } = await fixture(t)
  const results = []
  const capture = context => {
    const toolResult = context.messages.at(-1)
    // Pi Durable gives the text of a refused call in a frame of its own.
    results.push({ isError: toolResult.isError, text: toolResult.content[0].text.replace(/^<harness>\n\[error\] |\n<\/harness>$/g, '') })
    return fauxAssistantMessage('Noted.')
  }
  // The call reads the child session at the time of the turn: the report of the first child starts the first such turn.
  const steer = async () => fauxAssistantMessage(fauxToolCall('agents_steer', {
    childSessionId: Object.values((await service.state.snapshot()).runs)[1].childSessionId, prompt: 'Text from a report' }), { stopReason: 'toolUse' })
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'hello' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'approval' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
    steer, capture, steer, capture,
  ])
  await daemon.json(`/wait?submission=${(await service.submit('work', 'Work')).submissionId}`)
  await waitForState(service.state, () => results.length === 1 ? true : undefined)
  await waitForState(service.state, state => state.current === null ? true : undefined)
  // A change in a directory with a running child starts no event turn. So the event comes from another project.
  const other = await mkdtemp(join(tmpdir(), 'megachat-other-project-'))
  t.after(() => rm(other, { recursive: true, force: true }))
  await service.state.addWorkspace(other)
  await daemon.json('/project-event', { cwd: other, revision: 'steer-event', paths: ['src/main.kt'] })
  await waitForState(service.state, () => results.length === 2 ? true : undefined)
  assert.deepEqual(results, [{ isError: true, text: message('error.steerEvent') }, { isError: true, text: message('error.steerEvent') }])
  const [, waiting] = Object.values((await service.state.snapshot()).runs)
  assert.equal(waiting.steers, undefined)
  await waitForState(service.state, state => state.current === null ? true : undefined)
  fake.setResponses([
    fauxAssistantMessage(fauxToolCall('agents_send', { cwd, childSessionId: waiting.childSessionId, prompt: 'More' }), { stopReason: 'toolUse' }),
    capture,
  ])
  await daemon.json(`/wait?submission=${(await service.submit('send', 'Send more')).submissionId}`)
  assert.deepEqual(results[2], { isError: true, text: message('error.childBusy') })
  assert.match(message('error.childBusy'), /agents_steer/)
  // The MCP server of the children has the read-only history tools only.
  const { Client } = await import('@modelcontextprotocol/sdk/client/index.js')
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const configuration = server.historyConfiguration()
  const history = new Client({ name: 'steer-test', version: '1' })
  await history.connect(new StreamableHTTPClientTransport(new URL(configuration.url), {
    requestInit: { headers: Object.fromEntries(configuration.headers.map(header => [header.name, header.value])) },
  }))
  t.after(() => history.close())
  assert.deepEqual((await history.listTools()).tools.map(item => item.name), ['history', 'sessions', 'session_history'])
})

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { message } from '../src/messages.mjs'
import { lastUserTurnEnd } from '../src/MegachatState.mjs'
import { PromptCacheKeepAlive } from '../src/PromptCacheKeepAlive.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { idleEnd, isSleeping } from '../src/Workday.mjs'
import { fakeClock } from './fake-clock.mjs'
import { at, daemonFixture, logLines, temporary } from './workday-daemon.mjs'

const MINUTE = 60000
const HOUR = 60 * MINUTE
const WORKDAY = { start: '09:00', end: '19:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], timezone: 'UTC', idleMinutes: 30 }
/** The working day in UTC, without the morning report. */
const NIGHT = { 'workday.enabled': true, 'report.morning': false }

/** Adds a finished child run of [cwd] whose result no turn reported yet, as the run service records it at [time]. */
function finish(service, id, cwd, time) {
  return service.state.change(state => {
    state.runs[id] = { id, childSessionId: `child-${id}`, mainRunId: 'main', agent: 'claude', requestId: `spawn-${id}`, digest: id, prompt: `Task ${id}`,
      title: `Task ${id}`, cwd, status: 'completed', output: `Result ${id}.`, truncated: false, reported: false, createdAt: at(time) - HOUR,
      finishedAt: at(time), closed: false, providerSessionId: null, serviceSession: false, generation: null, pid: null, cancelRequested: false }
  })
}

const reported = (service, id) => waitForState(service.state, state => state.runs[id].reported && !state.current ? state : undefined)
/** Lets the state watch and the event pump run. A turn that they start shows in the requests of the model. */
const settle = () => new Promise(resolve => setTimeout(resolve, 100))
/** A turn of child results. The prompt has the text of the mode of the suggestions, with or without a next step. */
const isResult = request => [message('event.children'), message('event.children.suggest')].some(text => request.prompt.startsWith(text))

test('the conversation sleeps outside the working hours after the idle time, and the keep-alive and the results share this decision', () => {
  assert.equal(isSleeping(WORKDAY, at('2026-11-11T23:00:00Z'), at('2026-11-11T22:00:00Z')), true)
  assert.equal(isSleeping(WORKDAY, at('2026-11-11T23:00:00Z'), at('2026-11-11T22:45:00Z')), false)
  assert.equal(isSleeping(WORKDAY, at('2026-11-11T12:00:00Z'), at('2026-11-10T12:00:00Z')), false)
  // Without a turn, no idle time is left.
  assert.equal(isSleeping(WORKDAY, at('2026-11-11T23:00:00Z'), undefined), true)
  assert.equal(idleEnd(WORKDAY, at('2026-11-11T22:45:00Z')), at('2026-11-11T23:15:00Z'))
})

test('a child result outside the working hours waits while the conversation sleeps, and goes out at the start of the next working day', { timeout: 20000 }, async t => {
  const { service, requests, advance, project } = await daemonFixture(t, { start: '2026-11-11T23:00:00Z', values: NIGHT })
  await service.resume()
  await finish(service, 'night', project, '2026-11-11T23:00:00Z')
  await settle()
  assert.deepEqual(requests, [])
  assert.equal((await service.state.snapshot()).runs.night.reported, false)
  await logLines(t, async () => {
    await advance(10 * HOUR - MINUTE)
    assert.deepEqual(requests, [])
    await advance(MINUTE)
    await reported(service, 'night')
  })
  assert.equal(requests.length, 1)
  assert.ok(isResult(requests[0]))
  assert.equal(requests[0].at, '2026-11-12T09:00:00.000Z')
})

test('a waiting result on a Friday night goes out on Monday at the start of the working day', { timeout: 20000 }, async t => {
  const { service, requests, advance, project } = await daemonFixture(t, { start: '2026-11-13T22:00:00Z', values: NIGHT })
  await service.resume()
  await finish(service, 'weekend', project, '2026-11-13T22:00:00Z')
  await logLines(t, async () => {
    await advance(59 * HOUR - MINUTE)
    assert.deepEqual(requests, [])
    await advance(MINUTE)
    await reported(service, 'weekend')
  })
  assert.equal(requests[0].at, '2026-11-16T09:00:00.000Z')
})

test('the next turn of the user takes the waiting results right after it', { timeout: 20000 }, async t => {
  const { service, daemon, requests, clock, project } = await daemonFixture(t, { start: '2026-11-11T23:00:00Z', values: NIGHT })
  await service.resume()
  await finish(service, 'night', project, '2026-11-11T23:00:00Z')
  await settle()
  assert.deepEqual(requests, [])
  clock.sleep(30 * MINUTE)
  const receipt = await daemon.json('/input', { requestId: 'user-night', text: 'Are you there?' })
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  await reported(service, 'night')
  assert.deepEqual(requests.map(request => [isResult(request), request.at]), [[false, '2026-11-11T23:30:00.000Z'], [true, '2026-11-11T23:30:00.000Z']])
})

/** A reply of the fake model that calls the tool [name] of the main agent. */
const call = (name, args = {}) => () => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
/** The last result of the tool [name] in the context of a model request, and the context as text. */
const seen = (context, name) => {
  const item = context.messages.findLast(model => model.role === 'toolResult' && model.toolName === name)
  return { output: JSON.parse(item.content[0].text), context: JSON.stringify(context) }
}

test('in the turn of the user before a waiting result, agents_list shows that the task ended and that its result follows', { timeout: 20000 }, async t => {
  const views = []
  const replies = [call('agents_list'), context => { views.push(seen(context, 'agents_list')); return fauxAssistantMessage('The task ended. Its result follows.') },
    'Result night.',
    call('agents_inspect', { runId: 'read' }), context => { views.push(seen(context, 'agents_inspect')); return fauxAssistantMessage('Result read.') }]
  const { service, daemon, requests, clock, project } = await daemonFixture(t, { start: '2026-11-11T23:00:00Z', values: NIGHT, replies })
  await service.resume()
  await finish(service, 'night', project, '2026-11-11T23:00:00Z')
  await settle()
  clock.sleep(30 * MINUTE)
  const say = async (requestId, text) => {
    const receipt = await daemon.json('/input', { requestId, text })
    await daemon.json(`/wait?submission=${receipt.submissionId}`)
  }
  await say('user-list', 'How is the task?')
  // The run ended, and its result waits for its own message after this turn. The rules tell the main agent so.
  const listed = views[0].output.runs.find(run => run.runId === 'night')
  assert.deepEqual([listed.status, listed.separateResult], ['completed', true])
  assert.match(views[0].context, /A listed task with separateResult true ended, and its result comes in its own message after this turn\./)
  await reported(service, 'night')
  assert.deepEqual(requests.map(isResult), [false, false, true])
  // After its result message, the list shows the run without the mark.
  const list = service.extension().tools.find(item => item.name === 'agents_list')
  assert.equal(JSON.parse((await list.execute({})).output[0].text).runs.find(run => run.runId === 'night').separateResult, undefined)
  // A read of the ended run in the turn of the user gives the result in that turn, so no result message repeats it.
  clock.sleep(40 * MINUTE)
  await finish(service, 'read', project, '2026-11-12T00:10:00Z')
  await settle()
  assert.equal(requests.length, 3)
  await say('user-read', 'What did the second task find?')
  assert.deepEqual([views[1].output.output, views[1].output.reported], ['Result read.', true])
  await settle()
  assert.deepEqual(requests.map(isResult), [false, false, true, false, false])
})

test('with workday.idleMinutes 0, a waiting result goes out right after the next turn of the user, and a later result waits', { timeout: 20000 }, async t => {
  const { service, daemon, requests, clock, project } = await daemonFixture(t, { start: '2026-11-11T23:00:00Z', values: { ...NIGHT, 'workday.idleMinutes': 0 } })
  await service.resume()
  await finish(service, 'night', project, '2026-11-11T23:00:00Z')
  await settle()
  assert.deepEqual(requests, [])
  clock.sleep(30 * MINUTE)
  const receipt = await daemon.json('/input', { requestId: 'user-night', text: 'Are you there?' })
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  await reported(service, 'night')
  assert.deepEqual(requests.map(request => [isResult(request), request.at]), [[false, '2026-11-11T23:30:00.000Z'], [true, '2026-11-11T23:30:00.000Z']])
  // The conversation sleeps again at once, so a result after the turn of the user waits for the next one.
  clock.sleep(5 * MINUTE)
  await finish(service, 'later', project, '2026-11-11T23:35:00Z')
  await settle()
  assert.equal(requests.length, 2)
  assert.equal((await service.state.snapshot()).runs.later.reported, false)
})

test('while the user is active at night, a result starts its turn at once',{ timeout: 20000 }, async t => {
  const { service, daemon, requests, clock, project } = await daemonFixture(t, { start: '2026-11-11T23:00:00Z', values: NIGHT })
  await service.resume()
  const receipt = await daemon.json('/input', { requestId: 'user-night', text: 'Start the build.' })
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  await waitForState(service.state, state => !state.current ? true : undefined)
  clock.sleep(10 * MINUTE)
  await finish(service, 'night', project, '2026-11-11T23:10:00Z')
  await reported(service, 'night')
  assert.deepEqual(requests.map(request => [isResult(request), request.at]), [[false, '2026-11-11T23:00:00.000Z'], [true, '2026-11-11T23:10:00.000Z']])
})

test('with workday.enabled off, a result at night starts its turn at once', { timeout: 20000 }, async t => {
  const { service, requests, project } = await daemonFixture(t, { start: '2026-11-11T23:00:00Z', values: { 'report.morning': false } })
  await service.resume()
  await finish(service, 'night', project, '2026-11-11T23:00:00Z')
  await reported(service, 'night')
  assert.equal(requests.length, 1)
  assert.ok(isResult(requests[0]))
})

test('the wait of a result survives a restart of the daemon', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const database = join(directory, 'conversation.sqlite')
  const first = await daemonFixture(t, { directory, start: '2026-11-11T23:00:00Z', values: NIGHT, storage: await openNodeSqliteStorage(database) })
  await first.service.resume()
  await finish(first.service, 'night', first.project, '2026-11-11T23:00:00Z')
  await settle()
  await first.close()
  const second = await daemonFixture(t, { directory, start: '2026-11-12T08:00:00Z', values: NIGHT, storage: await openNodeSqliteStorage(database) })
  await second.service.resume()
  await settle()
  assert.deepEqual([first.requests, second.requests], [[], []])
  await logLines(t, async () => {
    await second.advance(HOUR)
    await reported(second.service, 'night')
  })
  assert.equal(second.requests[0].at, '2026-11-12T09:00:00.000Z')
})

test('with the morning report, the waiting results come first, and the report marks them as reported in their own turn', { timeout: 20000 }, async t => {
  const { service, requests, advance, project } = await daemonFixture(t, { start: '2026-11-15T22:00:00Z', values: { 'workday.enabled': true } })
  await service.resume()
  await finish(service, 'sunday', project, '2026-11-15T22:00:00Z')
  await settle()
  assert.deepEqual(requests, [])
  await logLines(t, async () => {
    await advance(11 * HOUR)
    await waitForState(service.state, state => Object.keys(state.inputs).some(id => id.startsWith('morning:')) && !state.current
      && !state.morningReport.pending ? true : undefined)
  })
  assert.deepEqual(requests.map(request => isResult(request) ? 'result' : request.prompt.startsWith(message('event.morning')) ? 'report' : 'other'),
    ['result', 'report'])
  const data = JSON.parse(requests[1].prompt.slice(requests[1].prompt.indexOf('\n') + 1))
  assert.deepEqual(data.children.done, [{ title: 'Task sunday', project, agent: 'claude', status: 'completed', separateResult: true }])
  assert.match(requests[1].prompt, /separateResult true got its own result message just before this report/)
})

test('a permission request of a child shows at once while its result would wait', { timeout: 20000 }, async t => {
  const { service, daemon, requests, project } = await daemonFixture(t, { start: '2026-11-11T23:00:00Z', values: NIGHT })
  await service.resume()
  await finish(service, 'night', project, '2026-11-11T23:00:00Z')
  const asked = Promise.withResolvers()
  const connection = client({ name: 'test-air' }).onNotification('*', () => {})
    .onRequest(methods.client.session.requestPermission, ({ params }) => { asked.resolve(params); return new Promise(() => {}) })
    .connect(new AcpBridge(daemon).app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  await connection.agent.request(methods.agent.session.new, { cwd: project, mcpServers: [] })
  await service.state.change(state => {
    const { finishedAt, ...night } = state.runs.night
    state.runs.working = { ...night, id: 'working', childSessionId: 'child-working', requestId: 'spawn-working', status: 'running', generation: 'process' }
  })
  await service.state.requestPermission('working', 'process', {
    options: [{ optionId: 'yes', kind: 'allow_once', name: 'Allow' }, { optionId: 'no', kind: 'reject_once', name: 'Deny' }],
    toolCall: { title: 'Write a file' },
  })
  const params = await asked.promise
  assert.match(params.toolCall.title, /Write a file/)
  assert.deepEqual(requests, [])
  assert.equal((await service.state.snapshot()).runs.night.reported, false)
})

test('a chain of child results at night does not keep the conversation awake, because only a turn of the user ends the idle time', { timeout: 20000 }, async t => {
  const { service, daemon, requests, clock, advance, project } = await daemonFixture(t, { start: '2026-11-11T22:55:00Z', values: NIGHT })
  await service.resume()
  const receipt = await daemon.json('/input', { requestId: 'user-last', text: 'Run the three tasks. I go to sleep.' })
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  await waitForState(service.state, state => !state.current ? true : undefined)
  // The first result comes 15 minutes after the last turn of the user, so it starts its turn at once.
  clock.sleep(15 * MINUTE)
  await finish(service, 'first', project, '2026-11-11T23:10:00Z')
  await reported(service, 'first')
  // The turn of the first result does not end the idle time: the conversation sleeps from 23:25, and the next result waits.
  clock.sleep(25 * MINUTE)
  await finish(service, 'second', project, '2026-11-11T23:35:00Z')
  await settle()
  assert.deepEqual(requests.map(request => [isResult(request), request.at]), [[false, '2026-11-11T22:55:00.000Z'], [true, '2026-11-11T23:10:00.000Z']])
  assert.equal((await service.state.snapshot()).runs.second.reported, false)
  await logLines(t, async () => {
    await advance(9 * HOUR + 25 * MINUTE)
    await reported(service, 'second')
  })
  assert.equal(requests.at(-1).at, '2026-11-12T09:00:00.000Z')
})

test('after a restart, the end of the last turn of the user gives the idle time, not the last message of a result turn', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const database = join(directory, 'conversation.sqlite')
  const first = await daemonFixture(t, { directory, start: '2026-11-11T22:55:00Z', values: NIGHT, storage: await openNodeSqliteStorage(database) })
  await first.service.resume()
  const receipt = await first.daemon.json('/input', { requestId: 'user-last', text: 'Run the tasks. I go to sleep.' })
  await first.daemon.json(`/wait?submission=${receipt.submissionId}`)
  await waitForState(first.service.state, state => !state.current ? true : undefined)
  first.clock.sleep(15 * MINUTE)
  await finish(first.service, 'first', first.project, '2026-11-11T23:10:00Z')
  await reported(first.service, 'first')
  // The state takes the times of the real clock. The fake clock of the test gives them here.
  await first.service.state.change(state => { state.inputs['user-last'].settledAt = at('2026-11-11T22:55:00Z') })
  await first.close()
  const second = await daemonFixture(t, { directory, start: '2026-11-11T23:35:00Z', values: NIGHT, storage: await openNodeSqliteStorage(database) })
  await second.service.resume()
  await finish(second.service, 'second', second.project, '2026-11-11T23:35:00Z')
  await settle()
  assert.deepEqual(second.requests, [])
  assert.equal((await second.service.state.snapshot()).runs.second.reported, false)
})

test('the end of the last turn of the user comes from the inputs of the state', () => {
  const inputs = {
    'user-old': { status: 'completed', admittedAt: 100 },
    'user-new': { status: 'completed', admittedAt: 200, settledAt: 260 },
    'children:1': { status: 'completed', admittedAt: 300, settledAt: 320 },
    'sessions:1': { status: 'completed', admittedAt: 400, settledAt: 420 },
    'morning:1': { status: 'completed', admittedAt: 500, settledAt: 520 },
    'user-running': { status: 'running', admittedAt: 600 },
  }
  assert.equal(lastUserTurnEnd({ inputs }), 260)
  // An input of an earlier build has only its admission time.
  assert.equal(lastUserTurnEnd({ inputs: { 'user-old': inputs['user-old'] } }), 100)
  assert.equal(lastUserTurnEnd({ inputs: {} }), undefined)
})

test('the keep-alive takes the idle time of the working day from the turns of the user, and the window from each turn but the report', async t => {
  const pings = []
  const compacts = []
  const make = (start, size, workday) => {
    const clock = fakeClock(start)
    const keepAlive = new PromptCacheKeepAlive({ ttlMs: HOUR, windowMs: 6 * HOUR, compactTokens: 100000, minTokens: 1000, workday, clock, tokens: async () => size,
      ping: async () => { pings.push(new Date(clock.now()).toISOString().slice(11, 16)); return { input: 1, cacheRead: 1, cacheWrite: 0, output: 1 } },
      compact: async () => { compacts.push(new Date(clock.now()).toISOString().slice(11, 16)); return { compacted: true } } })
    return { clock, keepAlive, advance: ms => clock.advance(ms, () => keepAlive.running) }
  }
  // The user goes away at 22:55, and a result turn ends at 23:10. The idle time of 55 minutes ends at 23:50, not at 00:05.
  const night = make('2026-11-11T22:55:00Z', 150000, { ...WORKDAY, idleMinutes: 55 })
  await logLines(t, async () => {
    night.keepAlive.turnEnded()
    night.clock.sleep(15 * MINUTE)
    night.keepAlive.turnStarted()
    night.keepAlive.turnEnded(undefined, { kind: 'report' })
    await night.advance(3 * HOUR)
  })
  assert.deepEqual(compacts, ['00:00'])
  await night.keepAlive.close()
  // In the working hours, a turn of a child result starts the window of keep-alive requests again, as before.
  const day = make('2026-11-11T08:00:00Z', 50000, undefined)
  await logLines(t, async () => {
    day.keepAlive.turnEnded()
    day.clock.sleep(5 * HOUR)
    day.keepAlive.turnStarted()
    day.keepAlive.turnEnded(undefined, { kind: 'report' })
    await day.advance(12 * HOUR)
  })
  assert.equal(pings.at(-1), '18:50')
  await day.keepAlive.close()
})

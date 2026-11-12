import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { message } from '../src/messages.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { idleEnd, isSleeping } from '../src/Workday.mjs'
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
const isResult = request => request.prompt.startsWith(message('event.children'))

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

test('while the user is active at night, a result starts its turn at once', { timeout: 20000 }, async t => {
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
  assert.deepEqual(requests.map(request => request.prompt.startsWith(message('event.children')) ? 'result' : request.prompt.startsWith(message('event.morning')) ? 'report' : 'other'),
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

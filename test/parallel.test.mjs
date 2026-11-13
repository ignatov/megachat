import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { AcpBridge, taskRows } from '../src/AcpBridge.mjs'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { ChildPool, directoryKey, overlaps } from '../src/ChildPool.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { message, minutesOf } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { PiRunService } from '../src/PiRunService.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { call, fakeModels, MAIN } from './parallel-models.mjs'

const FAKE_ACP = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))
const PROJECTS = ['a', 'b', 'c', 'd']

/**
 * A service with the ACP run service of the fake agent and the pi run service on one pool, as the daemon makes them.
 * Each of the directories a, b, c and d is listed and has a README. [values] go to `settings.json`.
 */
async function open(t, { values = {}, piPlaces, main = [], child = [], server = false } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-parallel-')))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  const cwd = {}
  for (const name of PROJECTS) {
    cwd[name] = join(directory, name)
    await mkdir(cwd[name])
    await writeFile(join(cwd[name], 'README.md'), `The README of the project ${name}.`)
  }
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN, ...values } }), { mode: 0o600 })
  const { models, requests } = fakeModels(main, child)
  const service = await PiMegachatService.open(new MemoryStorage(), models, undefined, {}, { settingsPath: join(directory, 'settings.json'),
    spendPath: join(directory, 'spend.json'), keepAlive: { enabled: false }, environment: {}, resumeDelayMs: 0 })
  for (const path of Object.values(cwd)) await service.state.addWorkspace(path)
  const pool = new ChildPool({ limit: () => service.settings.entry('children.parallel').value, ...(piPlaces ? { piPlaces } : {}) })
  const pi = new PiRunService(service.state, service.harness, { agent: path => service.childAgent(path), pool })
  const children = new AcpRunService(service.state, { childLaunch: async () => ({ env: process.env }) }, { args: [FAKE_ACP], pool })
  const daemonServer = server ? new DaemonServer(service) : undefined
  const daemon = daemonServer ? new DaemonClient(await daemonServer.listen()) : undefined
  await pi.start()
  await children.start()
  await service.resume()
  t.after(async () => { await daemonServer?.close(); await children.close(); await pi.close(); await service.close() })
  return { directory, cwd, service, children, requests, main, child, daemon }
}

let turns = 0
/** Runs [operation] in a turn of the user of its own, as a tool call of the main agent does. */
async function userTurn(service, operation) {
  const id = `user-${++turns}`
  for (;;) {
    await waitForState(service.state, state => state.current ? undefined : true)
    if (await service.state.change(state => {
      if (state.current) return false
      state.current = { id, requestId: id, cancelling: false, kind: 'user' }
      return true
    })) break
  }
  try { return await operation(id) }
  finally { await service.state.change(state => { if (state.current?.id === id) state.current = null }) }
}

/** Admits [tasks] in one turn of the user, as `agents_spawn` does. Gives the runs in the order of the queue. */
const admit = (service, ...tasks) => userTurn(service, async id => {
  const runs = []
  for (const task of tasks) runs.push(await service.state.admitChild(`${id}:spawn-${runs.length}`, task))
  return runs
})

const pendingOf = (state, run) => Object.values(state.permissions).find(item => item.runId === run.id && item.status === 'pending')
const answer = async (service, run) => service.state.respondPermission(pendingOf(await service.state.snapshot(), run).id, 'yes')
const until = (service, ready) => waitForState(service.state, state => ready(state) ? state : undefined, { timeoutMs: 15000 })
const finished = service => until(service, state => !state.current && Object.values(state.runs).every(run => terminalStates.has(run.status) && run.reported))
const dispatches = async cwd => (await readFile(join(cwd, 'dispatches'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
const steerings = async cwd => (await readFile(join(cwd, 'steerings'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
/** The run IDs of each result turn, in the order of the turns. */
const reports = state => Object.values(state.inputs).filter(input => input.resultRunIds).map(input => input.resultRunIds)
/** Waits until the fake agent in [cwd] got the prompt [text], so the turn of the agent runs. */
async function prompted(cwd, text) {
  while (!(await dispatches(cwd)).includes(text)) await new Promise(resolve => setTimeout(resolve, 10))
}

test('the pool gives a place to the first runs that may start, skips a busy directory, and keeps the order of the queue', async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-pool-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  for (const name of PROJECTS) await mkdir(join(root, name))
  await symlink(join(root, 'a'), join(root, 'link'))
  assert.equal(directoryKey(join(root, 'link')), join(root, 'a'))
  const run = (id, name, fields = {}) => ({ id, cwd: join(root, name), status: 'admitted', agent: 'claude', ...fields })
  const snapshot = (...runs) => ({ runs: Object.fromEntries(runs.map(item => [item.id, item])) })
  let limit = 3
  const pool = new ChildPool({ limit: () => limit })

  // The second run of a is behind the first one, and the run through the link is in a too. They do not stop b, c and d.
  const queue = snapshot(run('a1', 'a'), run('a2', 'a'), run('l1', 'link'), run('b1', 'b'), run('c1', 'c'), run('d1', 'd'))
  assert.deepEqual(['a2', 'l1', 'd1', 'a1', 'c1', 'b1', 'd1'].map(id => pool.take(queue, queue.runs[id])),
    [false, false, false, true, true, true, false])
  pool.release('c1')
  const later = snapshot(...Object.values(queue.runs).filter(item => item.id !== 'c1'))
  assert.deepEqual(['a2', 'l1', 'd1'].map(id => pool.take(later, later.runs[id])), [false, false, true])

  // An active run of the state counts before its service took it, a run before its time waits, and an urgent run comes first.
  const other = new ChildPool({ limit: () => 1 })
  const active = snapshot(run('x', 'a', { status: 'dispatched' }), run('y', 'b'))
  assert.equal(other.take(active, active.runs.y), false)
  const urgent = snapshot(run('early', 'a', { notBefore: Date.now() + 60000 }), run('first', 'b'), run('steered', 'c', { urgent: true }))
  assert.deepEqual(['first', 'early', 'steered'].map(id => other.take(urgent, urgent.runs[id])), [false, false, true])

  // One pi child at a time. A pi run that waits for its place does not stop a run of another agent behind it.
  const pi = new ChildPool({ limit: () => 3 })
  const pis = snapshot(run('p1', 'a', { agent: 'pi', status: 'dispatched' }), run('p2', 'b', { agent: 'pi' }), run('c2', 'c'))
  assert.deepEqual(['p2', 'c2'].map(id => pi.take(pis, pis.runs[id])), [false, true])

  // A dispatched run that continues after a restart takes its place over the limit, and the next start waits.
  limit = 1
  const resumed = new ChildPool({ limit: () => limit })
  assert.deepEqual([resumed.resume(run('r1', 'a')), resumed.resume(run('r2', 'b')), resumed.resume(run('r1', 'a'))], [true, true, false])
  const waiting = snapshot(run('w', 'c'))
  assert.equal(resumed.take(waiting, waiting.runs.w), false)
  let told = 0
  resumed.subscribe(() => told++)
  resumed.release('r1')
  resumed.release('r1')
  assert.equal(told, 1)
  assert.equal(resumed.take(waiting, waiting.runs.w), false)
  resumed.release('r2')
  assert.equal(resumed.take(waiting, waiting.runs.w), true)
  // A value out of the range gives the default of the setting.
  assert.equal(new ChildPool({ limit: () => 0 }).take(waiting, waiting.runs.w), true)
})

test('a directory in another directory is one checkout with it, in each direction, and a sibling with a common prefix is not', async t => {
  assert.deepEqual([overlaps('/work/app', '/work/app'), overlaps('/work/app/server', '/work/app'), overlaps('/work/app', '/work/app/server'),
    overlaps('/work/app2', '/work/app'), overlaps('/work/app', '/work/app2'), overlaps('/work/app/../x', '/work/app'), overlaps('/', '/work')],
  [true, true, true, false, false, false, true])
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-pool-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  for (const name of ['app', 'app/server', 'app2', 'other']) await mkdir(join(root, name))
  await symlink(join(root, 'app', 'server'), join(root, 'server-link'))
  const run = (id, name, fields = {}) => ({ id, cwd: join(root, name), status: 'admitted', agent: 'claude', ...fields })
  const snapshot = (...runs) => ({ runs: Object.fromEntries(runs.map(item => [item.id, item])) })
  const pool = () => new ChildPool({ limit: () => 8 })

  // A run in the checkout waits for a run in its subdirectory, and a run in the subdirectory waits for a run in the
  // checkout. A link into the subdirectory is the subdirectory. The sibling app2 does not wait.
  const parent = snapshot(run('running', 'app', { status: 'dispatched' }), run('nested', 'app/server'), run('linked', 'server-link'), run('sibling', 'app2'))
  assert.deepEqual(['nested', 'linked', 'sibling'].map(id => pool().take(parent, parent.runs[id])), [false, false, true])
  const child = snapshot(run('running', 'server-link', { status: 'dispatched' }), run('outer', 'app'), run('sibling', 'app2'))
  assert.deepEqual(['outer', 'sibling'].map(id => pool().take(child, child.runs[id])), [false, true])

  // A queued run in the checkout keeps its turn: a later run in a subdirectory waits behind it, and a run in another
  // directory does not.
  const fair = snapshot(run('running', 'app/server', { status: 'dispatched' }), run('outer', 'app'), run('later', 'app/server'),
    run('again', 'server-link'), run('other', 'other'))
  assert.deepEqual(['outer', 'later', 'again', 'other'].map(id => pool().take(fair, fair.runs[id])), [false, false, false, true])
  const freed = snapshot(...Object.values(fair.runs).filter(item => item.id !== 'running'))
  assert.deepEqual(['later', 'outer'].map(id => pool().take(freed, freed.runs[id])), [false, true])
})

test('with children.parallel 3, three tasks in three directories run at the same time, and a fourth task waits for a place', { timeout: 30000 }, async t => {
  const { cwd, service } = await open(t)
  const [a, b, c, d] = await admit(service, { cwd: cwd.a, prompt: 'approval', title: 'Task a' }, { cwd: cwd.b, prompt: 'approval', title: 'Task b' },
    { cwd: cwd.c, prompt: 'approval', title: 'Task c' }, { cwd: cwd.d, prompt: 'hello', title: 'Task d' })
  let state = await until(service, value => [a, b, c].every(run => pendingOf(value, run)))
  assert.equal(state.runs[d.id].status, 'admitted')
  // The chat shows the true state of each task.
  assert.deepEqual([...taskRows(state).values()].map(row => [row.name, row.description]), [
    ['Task a', message('child.approval', 'Claude', 'a')], ['Task b', message('child.approval', 'Claude', 'b')],
    ['Task c', message('child.approval', 'Claude', 'c')], ['Task d', message('child.queued', 'Claude', 'd')]])
  // The answer to one permission request ends that run only, and the fourth task gets its place.
  await answer(service, b)
  state = await until(service, value => value.runs[d.id].status === 'completed')
  assert.deepEqual([a, b, c].map(run => state.runs[run.id].status), ['approval', 'completed', 'approval'])
  assert.ok(pendingOf(state, a) && pendingOf(state, c))
  assert.ok(state.runs[d.id].startedAt >= state.runs[b.id].finishedAt)
  assert.ok([a, c].every(run => state.runs[run.id].startedAt < state.runs[b.id].finishedAt))
  await answer(service, a)
  await answer(service, c)
  state = await finished(service)
  assert.ok([a, b, c, d].every(run => state.runs[run.id].status === 'completed'))
  // Each result goes to the main agent one time.
  assert.deepEqual(reports(state).flat().sort(), [a, b, c, d].map(run => run.id).sort())
  for (const name of PROJECTS) assert.equal((await dispatches(cwd[name])).length, 1, name)
})

test('two tasks in one directory run one after the other, also through a symbolic link, and a task in another directory does not wait', { timeout: 30000 }, async t => {
  const { directory, cwd, service } = await open(t)
  const link = join(directory, 'link-a')
  await symlink(cwd.a, link)
  await service.state.addWorkspace(link)
  const [first, second, other] = await admit(service, { cwd: cwd.a, prompt: 'approval' }, { cwd: link, prompt: 'hello' }, { cwd: cwd.b, prompt: 'hello' })
  let state = await until(service, value => pendingOf(value, first) && value.runs[other.id].status === 'completed')
  assert.equal(state.runs[second.id].status, 'admitted')
  assert.deepEqual(await dispatches(cwd.a), ['approval'])
  await answer(service, first)
  state = await finished(service)
  assert.deepEqual([first, second].map(run => state.runs[run.id].status), ['completed', 'completed'])
  assert.ok(state.runs[second.id].startedAt >= state.runs[first.id].finishedAt)
  assert.deepEqual(await dispatches(cwd.a), ['approval', 'hello'])
})

test('a task in a directory inside a running task waits for it, and a task in a sibling with a common prefix does not', { timeout: 30000 }, async t => {
  const { directory, cwd, service } = await open(t)
  const nested = join(cwd.a, 'server')
  const sibling = join(directory, 'a2')
  for (const path of [nested, sibling]) {
    await mkdir(path)
    await service.state.addWorkspace(path)
  }
  const [outer, inner, other] = await admit(service, { cwd: cwd.a, prompt: 'approval' }, { cwd: nested, prompt: 'hello' }, { cwd: sibling, prompt: 'hello' })
  let state = await until(service, value => pendingOf(value, outer) && value.runs[other.id].status === 'completed')
  assert.equal(state.runs[inner.id].status, 'admitted')
  await answer(service, outer)
  state = await finished(service)
  assert.equal(state.runs[inner.id].status, 'completed')
  assert.ok(state.runs[inner.id].startedAt >= state.runs[outer.id].finishedAt)
})

test('with children.parallel 1, a task in another directory waits for the running task, as before the setting', { timeout: 30000 }, async t => {
  const { cwd, service } = await open(t, { values: { 'children.parallel': 1 } })
  const [first, second] = await admit(service, { cwd: cwd.a, prompt: 'approval', title: 'First' }, { cwd: cwd.b, prompt: 'hello', title: 'Second' })
  const state = await until(service, value => pendingOf(value, first))
  assert.equal(state.runs[second.id].status, 'admitted')
  assert.deepEqual([...taskRows(state).values()].map(row => row.description),
    [message('child.approval', 'Claude', 'a'), message('child.queued', 'Claude', 'b')])
  assert.deepEqual(await dispatches(cwd.b), [])
  await answer(service, first)
  const done = await finished(service)
  assert.ok(done.runs[second.id].startedAt >= done.runs[first.id].finishedAt)
  assert.deepEqual(await dispatches(cwd.b), ['hello'])
})

test('a child that writes more than 1 MB of error output stops with the text of the output limit, without a continuation', { timeout: 30000 }, async t => {
  const { cwd, service } = await open(t)
  const [noisy] = await admit(service, { cwd: cwd.a, prompt: 'noisy' })
  const state = await until(service, value => terminalStates.has(value.runs[noisy.id].status))
  assert.deepEqual([state.runs[noisy.id].status, state.runs[noisy.id].error, state.runs[noisy.id].autoResume, state.runs[noisy.id].resumedBy],
    ['interrupted', message('error.outputLimit', 1), false, undefined])
  assert.match(state.runs[noisy.id].error, /^The child agent wrote more than 1 MB of error output/)
})

test('the deadline ends one run while another run waits for a permission, and the waiting run keeps its request', { timeout: 30000 }, async t => {
  const { cwd, service, children } = await open(t)
  const [waiting] = await admit(service, { cwd: cwd.a, prompt: 'approval' })
  await until(service, value => pendingOf(value, waiting))
  // The waiting run stopped its deadline. A new run gets a short deadline.
  children.launch.deadlineMs = 300
  const [limited] = await admit(service, { cwd: cwd.b, prompt: 'wait' })
  let state = await until(service, value => terminalStates.has(value.runs[limited.id].status))
  assert.deepEqual([state.runs[limited.id].status, state.runs[limited.id].error, state.runs[limited.id].autoResume], ['interrupted', message('error.limit', minutesOf(300)), false])
  // The text names the time limit and not the output limit.
  assert.match(state.runs[limited.id].error, /time limit of 0\.005 minutes/)
  await new Promise(resolve => setTimeout(resolve, 400))
  state = await service.state.snapshot()
  assert.equal(state.runs[waiting.id].status, 'approval')
  assert.ok(pendingOf(state, waiting))
  children.launch.deadlineMs = 10000
  await answer(service, waiting)
  state = await finished(service)
  assert.equal(state.runs[waiting.id].status, 'completed')
  assert.equal(Object.keys(state.runs).length, 2)
})

test('a permission request in the chat names the agent and the task, because several children can ask at the same time', { timeout: 30000 }, async t => {
  const { cwd, service, daemon } = await open(t, { server: true })
  const asked = []
  const both = Promise.withResolvers()
  const connection = client({ name: 'test-air' }).onNotification('*', () => {})
    .onRequest(methods.client.session.requestPermission, ({ params }) => {
      asked.push(params.toolCall.title)
      if (asked.length === 2) both.resolve()
      return new Promise(() => {})
    })
    .connect(new AcpBridge(daemon).app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  await connection.agent.request(methods.agent.session.new, { cwd: cwd.a, mcpServers: [] })
  const runs = await admit(service, { cwd: cwd.a, prompt: 'approval', title: 'Fix the icon' }, { cwd: cwd.b, prompt: 'approval', title: 'Update the docs' })
  await both.promise
  assert.deepEqual(asked.sort(), [message('permission.title', 'Claude', 'Fix the icon', 'Write a file'),
    message('permission.title', 'Claude', 'Update the docs', 'Write a file')])
  for (const run of runs) await answer(service, run)
  await finished(service)
})

test('a steer reaches the named run while another run works', { timeout: 30000 }, async t => {
  const { cwd, service } = await open(t)
  const [a, b] = await admit(service, { cwd: cwd.a, prompt: 'steer' }, { cwd: cwd.b, prompt: 'steer' })
  await prompted(cwd.a, 'steer')
  await prompted(cwd.b, 'steer')
  const steered = await userTurn(service, id => service.steer(`tool:${id}:steer`, { childSessionId: b.childSessionId, prompt: 'Use the link', mode: 'queue' }))
  assert.deepEqual([steered.outcome, steered.runId], ['injected', b.id])
  let state = await until(service, value => value.runs[b.id].status === 'completed')
  assert.equal(state.runs[b.id].output, `steered: ${message('child.steer')}\n\nUse the link\n`)
  assert.equal(state.runs[a.id].status, 'dispatched')
  assert.deepEqual([(await steerings(cwd.a)).length, (await steerings(cwd.b)).length], [0, 1])
  await userTurn(service, id => service.steer(`tool:${id}:steer`, { childSessionId: a.childSessionId, prompt: 'Use the branch', mode: 'queue' }))
  state = await finished(service)
  assert.equal(state.runs[a.id].output, `steered: ${message('child.steer')}\n\nUse the branch\n`)
  assert.equal(Object.keys(state.runs).length, 2)
})

test('a later message cancels one of two running tasks, and a stop of a main task cancels each child that it owns and no other child', { timeout: 30000 }, async t => {
  const hang = (_request, options) => new Promise(resolve => options.signal.addEventListener('abort',
    () => resolve(fauxAssistantMessage('Stopped.', { stopReason: 'aborted' })), { once: true }))
  const { cwd, service, main } = await open(t)
  const [a, b] = await admit(service, { cwd: cwd.a, prompt: 'wait' }, { cwd: cwd.b, prompt: 'wait' })
  await prompted(cwd.a, 'wait')
  await prompted(cwd.b, 'wait')
  await userTurn(service, id => service.state.cancel(id, a.id))
  let state = await until(service, value => value.runs[a.id].status === 'cancelled')
  assert.equal(state.runs[b.id].status, 'dispatched')

  // A turn of the user starts two tasks and stops in its next model request. The stop of the turn cancels both.
  await until(service, value => value.runs[a.id].reported && !value.current)
  main.push(call(['agents_spawn', { cwd: cwd.c, prompt: 'wait', agent: 'claude' }]), call(['agents_spawn', { cwd: cwd.d, prompt: 'wait', agent: 'claude' }]), hang)
  await service.submit('stop', 'Start two tasks')
  await prompted(cwd.c, 'wait')
  await prompted(cwd.d, 'wait')
  const owned = Object.values((await service.state.snapshot()).runs).filter(run => run.mainRunId !== a.mainRunId)
  assert.equal(owned.length, 2)
  assert.equal(await service.cancel(), true)
  state = await until(service, value => owned.every(run => value.runs[run.id].status === 'cancelled'))
  assert.equal(state.runs[b.id].status, 'dispatched')
  await userTurn(service, id => service.state.cancel(id, b.id))
  state = await finished(service)
  assert.ok(Object.values(state.runs).every(run => run.status === 'cancelled'))
  assert.equal(Object.keys(state.runs).length, 4)
})

test('a change of children.parallel applies to the next start and stops no running child', { timeout: 30000 }, async t => {
  const { cwd, service } = await open(t, { values: { 'children.parallel': 1 } })
  const [a, b] = await admit(service, { cwd: cwd.a, prompt: 'approval' }, { cwd: cwd.b, prompt: 'approval' })
  let state = await until(service, value => pendingOf(value, a))
  assert.equal(state.runs[b.id].status, 'admitted')
  // The end of the turn that changed the setting starts the waiting task.
  await userTurn(service, () => service.settings.set('children.parallel', 2))
  await until(service, value => pendingOf(value, a) && pendingOf(value, b))
  // A lower limit stops no child, and the next task waits until the count of the running children is below it.
  await userTurn(service, () => service.settings.set('children.parallel', 1))
  const [c] = await admit(service, { cwd: cwd.c, prompt: 'hello' })
  state = await service.state.snapshot()
  assert.deepEqual([a, b, c].map(run => state.runs[run.id].status), ['approval', 'approval', 'admitted'])
  await answer(service, a)
  state = await until(service, value => value.runs[a.id].reported)
  assert.deepEqual([b, c].map(run => state.runs[run.id].status), ['approval', 'admitted'])
  await answer(service, b)
  state = await finished(service)
  assert.equal(state.runs[c.id].status, 'completed')
  assert.ok(state.runs[c.id].startedAt >= state.runs[b.id].finishedAt)
})

test('the results of two children that end while a turn runs go into one result turn, each result one time', { timeout: 30000 }, async t => {
  const gate = Promise.withResolvers()
  const { cwd, service, main } = await open(t)
  const runs = await admit(service, { cwd: cwd.a, prompt: 'approval' }, { cwd: cwd.b, prompt: 'approval' })
  await until(service, value => runs.every(run => pendingOf(value, run)))
  main.push(async () => { await gate.promise; return fauxAssistantMessage('Hello.') })
  await service.submit('talk', 'Hello')
  await Promise.all(runs.map(run => answer(service, run)))
  await until(service, value => runs.every(run => value.runs[run.id].status === 'completed'))
  gate.resolve()
  const state = await finished(service)
  assert.deepEqual(reports(state).map(ids => ids.sort()), [runs.map(run => run.id).sort()])
})

// Two dispatched pi runs would stop each child of a daemon of v0.3.0 after a restart, so this test guards the state.
test('one pi child runs at a time inside the limit, and a Claude child in another directory runs beside it', { timeout: 30000 }, async t => {
  const release = Promise.withResolvers()
  const { cwd, service, requests } = await open(t, {
    child: [async () => { await release.promise; return fauxAssistantMessage('Answer a.') }, fauxAssistantMessage('Answer b.')] })
  const [first, second, claude] = await admit(service, { cwd: cwd.a, prompt: 'Read.', agent: 'pi' }, { cwd: cwd.b, prompt: 'Read.', agent: 'pi' },
    { cwd: cwd.c, prompt: 'hello', agent: 'claude' })
  let state = await until(service, value => value.runs[claude.id].status === 'completed')
  assert.deepEqual([first, second].map(run => state.runs[run.id].status), ['dispatched', 'admitted'])
  assert.equal(requests.filter(request => request.child).length, 1)
  release.resolve()
  state = await finished(service)
  assert.deepEqual([first, second].map(run => state.runs[run.id].output), ['Answer a.', 'Answer b.'])
  assert.ok(state.runs[second.id].startedAt >= state.runs[first.id].finishedAt)
})

test('Pi Durable runs two pi children at the same time in one harness, and each one reads only its own project', { timeout: 30000 }, async t => {
  // Each child waits in its first model request until the other child is in its own. Children one after the other
  // would never pass this point.
  const both = Promise.withResolvers()
  let waiting = 0
  const reply = async request => {
    if (request.text.includes('The README of the project')) {
      const project = /The README of the project (\w)\./.exec(request.text)[1]
      return fauxAssistantMessage(`The README names the project ${project}.`)
    }
    if (++waiting === 2) both.resolve()
    await Promise.race([both.promise, new Promise((_, reject) => setTimeout(reject, 10000, new Error('The children did not run at the same time')))])
    return call(['read', { path: 'README.md' }])
  }
  const { cwd, service, requests } = await open(t, { piPlaces: 2, child: [reply, reply, reply, reply] })
  const runs = await admit(service, { cwd: cwd.a, prompt: 'Read the README.', agent: 'pi' }, { cwd: cwd.b, prompt: 'Read the README.', agent: 'pi' })
  const state = await finished(service)
  assert.deepEqual(runs.map(run => [state.runs[run.id].status, state.runs[run.id].output]),
    [['completed', 'The README names the project a.'], ['completed', 'The README names the project b.']])
  assert.equal(requests.filter(request => request.child).length, 4)
  assert.ok(state.runs[runs[1].id].startedAt < state.runs[runs[0].id].finishedAt)
  assert.deepEqual(reports(state).flat().sort(), runs.map(run => run.id).sort())
})

test('a kill of the daemon with two runs in flight and one queued: each one recovers or resumes by its rule, and no run starts two times', { timeout: 60000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-parallel-kill-')))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  const run = mode => fork(new URL('./parallel-daemon.mjs', import.meta.url), [mode, directory], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const first = run('first')
  t.after(() => first.kill('SIGKILL'))
  const [started] = await once(first, 'message')
  const agent = Number(await readFile(join(directory, 'a', 'agent.pid'), 'utf8'))
  const exited = once(first, 'exit')
  first.kill('SIGKILL')
  await exited
  // The supervisor stops the agent of the ACP run after the kill of its daemon.
  for (;;) {
    try { process.kill(agent, 0) }
    catch (error) { if (error.code === 'ESRCH') break; throw error }
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  const second = run('second')
  t.after(() => second.kill('SIGKILL'))
  const [result] = await once(second, 'message')
  const runs = Object.fromEntries(result.runs.map(item => [item.id, item]))
  const acp = runs[started.acp]
  const continued = runs[acp.resumedBy]
  // The ACP run that a kill cut continues in its provider session. The queued run in its directory starts first.
  assert.deepEqual([acp.status, continued.status, continued.resumeAttempt, continued.providerSessionId], ['resumed', 'completed', 1, acp.providerSessionId])
  assert.equal(runs[started.queued].status, 'completed')
  assert.ok(continued.startedAt >= runs[started.queued].finishedAt)
  // Pi Durable ends the model request that the kill cut as interrupted. So the pi run continues in the same
  // conversation, and that conversation makes one more model request.
  const reader = runs[started.pi]
  const read = runs[reader.resumedBy]
  assert.deepEqual([reader.status, read.status, read.output, read.providerSessionId], ['resumed', 'completed', 'Done after the restart.', reader.providerSessionId])
  assert.equal(result.childRequests, 1)
  assert.equal(result.runs.length, 5)
  assert.deepEqual(result.dispatches, ['wait', 'hello', ...`${message('child.continue')}\n\n${message('child.task')}\nwait`.split('\n').filter(Boolean)])
  // Each run goes to the main agent one time.
  assert.deepEqual(result.reports.flat().sort(), result.runs.map(item => item.id).sort())
})

test('the rules of the main agent say that tasks in different directories run at the same time and tasks in one checkout one after the other', async () => {
  const rules = await readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')
  assert.match(rules, /Tasks in different directories run at the same time, at most children\.parallel of them\./)
  assert.match(rules, /Tasks in one directory or in a directory inside it run one after the other/)
})

test('each run takes the time limit of children.timeoutMinutes of its directory at its start, and 0 gives no limit', { timeout: 30000 }, async t => {
  const { cwd, service, children } = await open(t)
  children.settings = directory => ({ 'children.timeoutMinutes': directory === cwd.a ? 0.005 : 0 })
  const [limited] = await admit(service, { cwd: cwd.a, prompt: 'wait' })
  const [free] = await admit(service, { cwd: cwd.b, prompt: 'wait' })
  const state = await until(service, value => terminalStates.has(value.runs[limited.id].status))
  assert.deepEqual([state.runs[limited.id].status, state.runs[limited.id].error], ['interrupted', message('error.limit', minutesOf(300))])
  await new Promise(resolve => setTimeout(resolve, 600))
  assert.ok(!terminalStates.has((await service.state.snapshot()).runs[free.id].status))
})

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { ChildPool } from '../src/ChildPool.mjs'
import { MegachatState, terminalStates } from '../src/MegachatState.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { fakeModels, MAIN } from './parallel-models.mjs'

const FAKE_ACP = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))
const SECRET_PROMPT = 'PROMPT-TEXT-THAT-MUST-NOT-REACH-THE-LOG'

/** A state on a memory storage. [log] gives the text that the daemon writes to its log. */
async function openState(t) {
  const lines = []
  t.mock.method(process.stderr, 'write', text => { lines.push(String(text)); return true })
  const models = createModels()
  const faux = fauxProvider()
  faux.setResponses(Array.from({ length: 10 }, () => fauxAssistantMessage('Done')))
  models.setProvider(faux.provider)
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const model = faux.getModel()
  const root = await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id } } })
  const state = new MegachatState(harness, root)
  await state.initialize()
  await state.addWorkspace('/workspace')
  await state.submit('main', 'Work')
  return { state, log: () => lines.join('').split('\n').filter(line => / Child run /.test(line)).map(line => line.slice(line.indexOf('Child run '))) }
}

const field = (line, name) => new RegExp(`${name}=(\\S+)`).exec(line)?.[1]

test('a new task, a follow-up and a named provider session write one start line each, and a repeated request writes none', { timeout: 10000 }, async t => {
  const { state, log } = await openState(t)
  const run = await state.admitChild('spawn', { cwd: '/workspace', prompt: SECRET_PROMPT, title: 'Fix the "build"' })
  assert.deepEqual(log(), [`Child run ${run.id} started: kind=spawn resumeOf=- child=${run.childSessionId} provider=- agent=claude cwd="/workspace" title="Fix the \\"build\\""`])
  await state.admitChild('spawn', { cwd: '/workspace', prompt: SECRET_PROMPT, title: 'Fix the "build"' })
  assert.equal(log().length, 1)
  await state.transition(run.id, ['admitted'], { status: 'ready', generation: 'g', providerSessionId: 'provider-1' })
  await state.transition(run.id, ['ready'], { status: 'completed', stopReason: 'end_turn' })
  const follow = await state.admitChild('send', { cwd: '/workspace', childSessionId: run.childSessionId, prompt: SECRET_PROMPT })
  const resumed = await state.admitChild('named', { cwd: '/workspace', agent: 'codex', providerSessionId: 'named-session', prompt: SECRET_PROMPT })
  const starts = log().filter(line => line.includes(' started: '))
  assert.equal(starts.length, 3)
  assert.equal(field(starts[1], 'kind'), 'send')
  assert.equal(field(starts[1], 'provider'), 'provider-1')
  assert.equal(field(starts[1], 'child'), run.childSessionId)
  assert.equal(follow.childSessionId, run.childSessionId)
  assert.equal(field(starts[2], 'kind'), 'resume')
  assert.equal(field(starts[2], 'agent'), 'codex')
  assert.equal(field(starts[2], 'provider'), 'named-session')
  assert.equal(starts[2].includes(resumed.id), true)
  assert.ok(!log().join('\n').includes(SECRET_PROMPT))
})

test('the end line has the status, the duration, the stop reason and the continuation of a run', { timeout: 10000 }, async t => {
  const { state, log } = await openState(t)
  const run = await state.admitChild('end', { cwd: '/workspace', prompt: SECRET_PROMPT })
  await state.transition(run.id, ['admitted'], { status: 'launching', generation: 'g', startedAt: Date.now() - 5000 })
  await state.transition(run.id, ['launching'], { status: 'completed', stopReason: 'end_turn' })
  const end = log().find(line => line.includes(' ended: '))
  assert.match(end, new RegExp(`^Child run ${run.id} ended: status=completed durationMs=\\d+ stop=end_turn resumedBy=-$`))
  assert.ok(Number(field(end, 'durationMs')) >= 5000)
  assert.ok(!log().some(line => line.includes(' error: ')))
})

test('a stop for a message of the user writes the end line with its continuation and the start line of the steer restart', { timeout: 10000 }, async t => {
  const { state, log } = await openState(t)
  const run = await state.admitChild('steer-run', { cwd: '/workspace', prompt: SECRET_PROMPT, title: 'Task' })
  await state.transition(run.id, ['admitted'], { status: 'ready', generation: 'process', providerSessionId: 'provider' })
  await state.transition(run.id, ['ready'], { status: 'dispatched' })
  assert.equal(await state.restartForSteer(run.id, 'process'), true)
  await state.transition(run.id, ['dispatched'], { status: 'interrupted' })
  const next = Object.values((await state.snapshot()).runs).find(item => item.resumeOf === run.id)
  const lines = log()
  assert.equal(lines.length, 3)
  assert.match(lines[1], new RegExp(`^Child run ${run.id} ended: status=interrupted durationMs=\\d+ stop=- resumedBy=${next.id}$`))
  assert.equal(lines[2], `Child run ${next.id} started: kind=steer-restart resumeOf=${run.id} child=${run.childSessionId} provider=provider agent=claude cwd="/workspace" title="Task"`)
  // A restart is no error.
  assert.ok(!lines.some(line => line.includes(' error: ')))
})

test('a restart of the daemon writes the error, the end and the recovery start of a dispatched run', { timeout: 10000 }, async t => {
  const { state, log } = await openState(t)
  const run = await state.admitChild('recover-run', { cwd: '/workspace', prompt: SECRET_PROMPT })
  await state.transition(run.id, ['admitted'], { status: 'ready', generation: 'old', providerSessionId: 'provider' })
  await state.transition(run.id, ['ready'], { status: 'dispatched' })
  await state.recover()
  const next = Object.values((await state.snapshot()).runs).find(item => item.resumeOf === run.id)
  assert.deepEqual(log().slice(1).map(line => line.replace(/durationMs=\d+/, 'durationMs=N')), [
    `Child run ${run.id} error: class=daemonRestart message="The process stopped."`,
    `Child run ${run.id} ended: status=interrupted durationMs=N stop=- resumedBy=${next.id}`,
    `Child run ${next.id} started: kind=recovery resumeOf=${run.id} child=${run.childSessionId} provider=provider agent=claude cwd="/workspace" title=-`,
  ])
})

test('a cancel and a stop of a queued run write its end line', { timeout: 10000 }, async t => {
  const { state, log } = await openState(t)
  const first = await state.admitChild('first', { cwd: '/workspace', prompt: 'one' })
  await state.change(state => { state.current = { id: 'turn', requestId: 'turn', cancelling: false, kind: 'user' } })
  await state.cancel('turn', first.id)
  const second = await state.admitChild('second', { cwd: '/workspace', prompt: 'two' })
  assert.equal(await state.stopChild(second.id), true)
  const ends = log().filter(line => line.includes(' ended: '))
  assert.equal(ends.length, 2)
  assert.ok(ends[0].startsWith(`Child run ${first.id} ended: status=cancelled `))
  assert.ok(ends[1].startsWith(`Child run ${second.id} ended: status=cancelled `))
})

test('an error line keeps the class and only the first sentence of the error, and a time limit gives the status timeout', { timeout: 10000 }, async t => {
  const { state, log } = await openState(t)
  const login = await state.admitChild('login', { cwd: '/workspace', prompt: 'one' })
  await state.transition(login.id, ['admitted'], { status: 'launching', generation: 'g' })
  await state.transition(login.id, ['launching'], { status: 'interrupted', autoResume: false,
    error: 'The agent asks for a login. Its error output says: Error: token=sk-abcdef0123456789' }, { errorClass: 'login' })
  const slow = await state.admitChild('slow', { cwd: '/workspace', prompt: 'two' })
  await state.transition(slow.id, ['admitted'], { status: 'launching', generation: 'g' })
  await state.transition(slow.id, ['launching'], { status: 'interrupted', autoResume: false,
    error: 'The child run reached its time limit of 30 minutes, so Megachat stopped it. Send smaller tasks.' }, { errorClass: 'timeout' })
  const failed = await state.admitChild('failed', { cwd: '/workspace', prompt: 'three' })
  await state.transition(failed.id, ['admitted'], { status: 'launching', generation: 'g' })
  await state.transition(failed.id, ['launching'], { status: 'failed', stopReason: 'refusal' })
  const lines = log().filter(line => / (error|ended): /.test(line))
  assert.equal(lines[0], `Child run ${login.id} error: class=login message="The agent asks for a login."`)
  assert.match(lines[1], /status=interrupted /)
  assert.equal(lines[2], `Child run ${slow.id} error: class=timeout message="The child run reached its time limit of 30 minutes, so Megachat stopped it."`)
  assert.match(lines[3], /status=timeout /)
  assert.equal(lines[4], `Child run ${failed.id} error: class=stopReason message="The turn ended with the stop reason refusal."`)
  assert.match(lines[5], /status=failed durationMs=\d+ stop=refusal /)
  assert.ok(!log().join('\n').includes('sk-abcdef'))
})

/** A daemon state with the ACP run service of the fake agent. */
async function openService(t, env = {}, resumeDelayMs = 60000) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-run-log-')))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  const cwd = join(directory, 'project')
  await mkdir(cwd)
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN } }), { mode: 0o600 })
  const lines = []
  t.mock.method(process.stderr, 'write', text => { lines.push(String(text)); return true })
  const { models } = fakeModels([], [])
  const service = await PiMegachatService.open(new MemoryStorage(), models, undefined, {}, { settingsPath: join(directory, 'settings.json'),
    spendPath: join(directory, 'spend.json'), keepAlive: { enabled: false }, environment: {}, resumeDelayMs })
  await service.state.addWorkspace(cwd)
  const acp = new AcpRunService(service.state, { childLaunch: async () => ({ env: { ...process.env, ...env } }) },
    { args: [FAKE_ACP], pool: new ChildPool(), errorOutputWaitMs: 150 })
  await acp.start()
  await service.resume()
  t.after(async () => { await acp.close(); await service.close() })
  return { cwd, service, acp, log: () => lines.join('').split('\n').filter(line => / Child run /.test(line)).map(line => line.slice(line.indexOf('Child run '))) }
}

let turns = 0
async function admit(service, task) {
  const id = `user-${++turns}`
  await waitForState(service.state, state => state.current ? undefined : true)
  await service.state.change(state => { state.current = { id, requestId: id, cancelling: false, kind: 'user' } })
  try { return await service.state.admitChild(`${id}:spawn`, task) }
  finally { await service.state.change(state => { if (state.current?.id === id) state.current = null }) }
}
/** Waits for the log line of the end of [runId]. The state commits first, and the line follows the commit. */
async function lineEnd(log, runId) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (log().some(line => line.startsWith(`Child run ${runId} ended: `))) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(log().join('\n'))
}
const ended = (service, runId) => waitForState(service.state, state => terminalStates.has(state.runs[runId]?.status) ? state.runs[runId] : undefined, { timeoutMs: 15000 })

test('a completed child run writes its start and its end, and a follow-up of the child writes its own start and end', { timeout: 30000 }, async t => {
  const { cwd, service, log } = await openService(t)
  const run = await ended(service, (await admit(service, { cwd, prompt: SECRET_PROMPT, title: 'Hello' })).id)
  assert.equal(run.status, 'completed')
  await lineEnd(log, run.id)
  const follow = await ended(service, (await admit(service, { cwd, childSessionId: run.childSessionId, prompt: SECRET_PROMPT })).id)
  assert.equal(follow.status, 'completed')
  await lineEnd(log, follow.id)
  const lines = log().map(line => line.replace(/durationMs=\d+/, 'durationMs=N'))
  assert.deepEqual(lines.map(line => `${line.split(' ')[3]} ${field(line, 'kind') ?? field(line, 'status')}`), ['started: spawn', 'ended: completed', 'started: send', 'ended: completed'])
  assert.equal(field(lines[2], 'provider'), run.providerSessionId)
  assert.ok(!log().join('\n').includes(SECRET_PROMPT))
})

test('an agent that asks for a login writes the error class login, and a time limit writes the class timeout and the status timeout', { timeout: 30000 }, async t => {
  const login = await openService(t, { FAKE_ACP_NEW: 'auth' }, 0)
  const run = await ended(login.service, (await admit(login.service, { cwd: login.cwd, prompt: 'hello' })).id)
  assert.equal(run.status, 'interrupted')
  await lineEnd(login.log, run.id)
  const error = login.log().find(line => line.includes(' error: '))
  assert.ok(error.startsWith(`Child run ${run.id} error: class=login message="The agent asks for a login.`), error)
  assert.match(login.log().at(-1), /ended: status=interrupted /)
  const slow = await openService(t)
  slow.acp.launch.deadlineMs = 300
  const limited = await ended(slow.service, (await admit(slow.service, { cwd: slow.cwd, prompt: 'wait' })).id)
  assert.equal(limited.status, 'interrupted')
  await lineEnd(slow.log, limited.id)
  assert.ok(slow.log().some(line => line.startsWith(`Child run ${limited.id} error: class=timeout `)))
  assert.match(slow.log().at(-1), new RegExp(`^Child run ${limited.id} ended: status=timeout `))
})

test('an agent process that ends before the task writes the error class spawn', { timeout: 30000 }, async t => {
  const { cwd, service, log } = await openService(t, { FAKE_ACP_NEW: 'exit', FAKE_ACP_EXIT: '1' }, 60000)
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  await lineEnd(log, run.id)
  assert.ok(log().some(line => line.startsWith(`Child run ${run.id} error: class=spawn message="The agent process ended with the exit code 1 before Megachat sent the task`)), log().join('\n'))
})

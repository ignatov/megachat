// The continuation of a hot child session instead of a new one: the view `hotSessions` of `agents_list`, the child
// session in the report of a child result, the rules of the main agent and the descriptions of the tools.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { createRegistry, Harness, MemoryStorage } from '@earendil-works/pi-durable'
import { MegachatState } from '../src/MegachatState.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { fakeClock } from './fake-clock.mjs'

const NOW = '2026-11-19T12:00:00Z'
const HOUR = 60 * 60 * 1000
const at = text => Date.parse(text)

/**
 * A service with a fake model and a fake clock at [NOW]. The directory `app` is a known repository. The test leaves the
 * temporary directory in place.
 */
async function open(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-continue-')))
  const app = join(root, 'app')
  await mkdir(app)
  const fake = fauxProvider({ models: [{ id: 'fast' }] })
  fake.setResponses(Array(10).fill(() => fauxAssistantMessage('Answer.')))
  const models = createModels()
  models.setProvider(fake.provider)
  const clock = fakeClock(NOW)
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: 'faux', modelId: 'fast' }, {},
    { settingsPath: join(root, 'settings.json'), keepAlive: { enabled: false }, environment: {}, morningReport: { clock } })
  t.after(() => service.close())
  await service.state.change(state => { state.projects.push(app) })
  const list = async () => JSON.parse((await service.extension().tools.find(item => item.name === 'agents_list').execute({})).output[0].text)
  return { service, root, app, list }
}

/**
 * Records a child run of the session [childSessionId] in [cwd], as the run service records it. [finishedAt] is the end
 * time of an ended run. The result is already reported, so no turn of the main agent starts.
 */
function record(service, { id, childSessionId, cwd, agent = 'claude', title, prompt = title ?? 'Do the task.', status = 'completed', createdAt, finishedAt, closed = false }) {
  return service.state.change(state => {
    state.runs[id] = { id, childSessionId, mainRunId: 'main', agent, requestId: `spawn-${id}`, digest: id, prompt, ...(title ? { title } : {}),
      cwd, status, output: `Result ${id}.`, truncated: false, reported: true, createdAt, ...(finishedAt === undefined ? {} : { finishedAt }),
      closed, providerSessionId: null, serviceSession: false, generation: null, pid: null, cancelRequested: false }
  })
}

test('hotSessions has the sessions that work, then the idle sessions of the last 24 hours with each status, and no closed session', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  const now = at(NOW)
  await record(service, { id: 'a', childSessionId: 'child-a', cwd: app, title: 'Task a', createdAt: now - 3 * HOUR, finishedAt: now - 2 * HOUR })
  await record(service, { id: 'b', childSessionId: 'child-b', cwd: app, title: 'Task b', createdAt: now - 31 * HOUR, finishedAt: now - 30 * HOUR })
  await record(service, { id: 'c1', childSessionId: 'child-c', cwd: app, title: 'Task c', createdAt: now - 5 * HOUR, finishedAt: now - 4 * HOUR })
  await record(service, { id: 'c2', childSessionId: 'child-c', cwd: app, title: 'Fix c', status: 'failed', createdAt: now - 2 * HOUR, finishedAt: now - HOUR })
  await record(service, { id: 'd1', childSessionId: 'child-d', cwd: app, title: 'Task d', createdAt: now - 4 * HOUR, finishedAt: now - 3 * HOUR })
  await record(service, { id: 'd2', childSessionId: 'child-d', cwd: app, title: 'Next d', status: 'running', createdAt: now - HOUR })
  await record(service, { id: 'e', childSessionId: 'child-e', cwd: app, title: 'Task e', createdAt: now - 2 * HOUR, finishedAt: now - HOUR, closed: true })
  const answer = await list()
  assert.deepEqual(answer.hotSessions.map(item => [item.childSessionId, item.state, item.status]),
    [['child-d', 'working', 'running'], ['child-c', 'idle', 'failed'], ['child-a', 'idle', 'completed']])
  assert.equal(answer.idleSessions, undefined)
  // The field runs does not change: one row for each run of the five sessions.
  assert.deepEqual(answer.runs.map(run => run.runId).sort(), ['a', 'b', 'c1', 'c2', 'd1', 'd2', 'e'])
  assert.deepEqual(Object.keys(answer.runs[0]).sort(), ['agent', 'childSessionId', 'cwd', 'prompt', 'runId', 'status', 'title'])
})

test('a cancelled session is hot while its end is recent, and a session whose task waits in the queue works', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  const now = at(NOW)
  await record(service, { id: 'h', childSessionId: 'child-h', cwd: app, title: 'Task h', status: 'cancelled', createdAt: now - 4 * HOUR, finishedAt: now - 3 * HOUR })
  await record(service, { id: 'i', childSessionId: 'child-i', cwd: app, title: 'Task i', status: 'admitted', createdAt: now - 10 * HOUR })
  assert.deepEqual((await list()).hotSessions, [
    { childSessionId: 'child-i', agent: 'claude', cwd: app, title: 'Task i', state: 'working', status: 'admitted' },
    { childSessionId: 'child-h', agent: 'claude', cwd: app, title: 'Task h', state: 'idle', status: 'cancelled', endedAt: '2026-11-19T09:00:00.000Z' },
  ])
})

test('a run of an older state directory without an end time is not in hotSessions', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  await record(service, { id: 'old', childSessionId: 'child-old', cwd: app, title: 'Old task', createdAt: at(NOW) - HOUR })
  assert.deepEqual((await list()).hotSessions, [])
})

test('hotSessions is empty after the user removes the directory of the session from the list', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  await record(service, { id: 'a', childSessionId: 'child-a', cwd: app, title: 'Task a', createdAt: at(NOW) - 3 * HOUR, finishedAt: at(NOW) - 2 * HOUR })
  assert.deepEqual((await list()).hotSessions.map(item => item.childSessionId), ['child-a'])
  await service.state.removeProject(app)
  assert.deepEqual((await list()).hotSessions, [])
})

test('hotSessions has the 20 newest of 21 idle sessions, the newest first', { timeout: 20000 }, async t => {
  const { service, root, list } = await open(t)
  for (let index = 0; index < 21; index++) {
    const cwd = join(root, `project-${index}`)
    await mkdir(cwd)
    await service.state.change(state => { state.projects.push(cwd) })
    // The session 0 ended 21 hours ago, and the session 20 ended 1 hour ago.
    await record(service, { id: `run-${index}`, childSessionId: `child-${index}`, cwd, title: `Task ${index}`,
      createdAt: at(NOW) - (22 - index) * HOUR, finishedAt: at(NOW) - (21 - index) * HOUR })
  }
  const sessions = (await list()).hotSessions
  assert.deepEqual(sessions.map(item => item.childSessionId), Array.from({ length: 20 }, (_, index) => `child-${20 - index}`))
})

test('the entry of a session with a follow-up has the title of its first run, the title of its last run, the state and the end time', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  await record(service, { id: 'first', childSessionId: 'child-a', cwd: app, title: 'Fix the login test',
    createdAt: at('2026-11-19T08:00:00.000Z'), finishedAt: at('2026-11-19T08:30:00.000Z') })
  await record(service, { id: 'second', childSessionId: 'child-a', cwd: app, title: 'Add a test for the fix',
    createdAt: at('2026-11-19T09:30:00.000Z'), finishedAt: at('2026-11-19T10:00:00.000Z') })
  assert.deepEqual((await list()).hotSessions, [{ childSessionId: 'child-a', agent: 'claude', cwd: app, title: 'Fix the login test',
    lastTitle: 'Add a test for the fix', state: 'idle', status: 'completed', endedAt: '2026-11-19T10:00:00.000Z' }])
})

test('the entry of a Codex session of one run has no lastTitle, and a run without a title gives the start of its prompt', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  await record(service, { id: 'f', childSessionId: 'child-f', cwd: app, agent: 'codex', title: 'Update the README',
    createdAt: at(NOW) - 2 * HOUR, finishedAt: at(NOW) - HOUR })
  const prompt = 'Read the open issues of the tracker and write a short list of the issues that block the next release of the app.'
  await record(service, { id: 'g', childSessionId: 'child-g', cwd: app, prompt, createdAt: at(NOW) - 4 * HOUR, finishedAt: at(NOW) - 3 * HOUR })
  const [codex, untitled] = (await list()).hotSessions
  assert.deepEqual(codex, { childSessionId: 'child-f', agent: 'codex', cwd: app, title: 'Update the README', state: 'idle', status: 'completed',
    endedAt: '2026-11-19T11:00:00.000Z' })
  assert.equal(untitled.title, prompt.slice(0, 80))
  assert.equal(untitled.lastTitle, undefined)
})

test('the entry of a session that works has the state working, the status of its last run and no end time', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  const now = at(NOW)
  await record(service, { id: 'd1', childSessionId: 'child-d', cwd: app, title: 'Task d', createdAt: now - 4 * HOUR, finishedAt: now - 3 * HOUR })
  await record(service, { id: 'd2', childSessionId: 'child-d', cwd: app, title: 'Next d', status: 'running', createdAt: now - HOUR })
  assert.deepEqual((await list()).hotSessions, [{ childSessionId: 'child-d', agent: 'claude', cwd: app, title: 'Task d', lastTitle: 'Next d',
    state: 'working', status: 'running' }])
})

test('each result in the report of a child result has the child session of its run', { timeout: 20000 }, async t => {
  const models = createModels()
  const fake = fauxProvider()
  fake.setResponses(Array.from({ length: 4 }, () => fauxAssistantMessage('Done')))
  models.setProvider(fake.provider)
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT)
  t.after(() => harness.close(BACKGROUND_CONTEXT))
  const model = fake.getModel()
  const state = new MegachatState(harness, await harness.root(BACKGROUND_CONTEXT, { agent: { model: { provider: model.provider, modelId: model.id } } }))
  await state.initialize()
  await state.addWorkspace('/workspace')
  const main = await state.submit('main', 'Fix the login test')
  const run = await state.admitChild('spawn', { cwd: '/workspace', prompt: 'Fix the login test', title: 'Fix the login test' })
  await state.transition(run.id, ['admitted'], { status: 'completed' })
  await state.settleInput(main.mainRunId, 'completed')
  await state.nextChildResults()
  // The root writes the entry of the report when it takes the submission, after the end of the first turn.
  let event
  while (!event) {
    event = (await state.root.entries({ order: 'descending' }, 50, undefined, BACKGROUND_CONTEXT)).items
      .find(entry => entry.kind === 'air.megachat.event')
    if (!event) await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.deepEqual(event.data.results.map(result => [result.runId, result.childSessionId, result.title]), [[run.id, run.childSessionId, 'Fix the login test']])
  const content = event.model.find(item => item.role === 'user').content
  const text = typeof content === 'string' ? content : content.map(block => block.text ?? '').join('')
  assert.ok(text.includes(`"childSessionId":"${run.childSessionId}"`))
})

const rules = () => readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')

test('the rules of the main agent define a hot session and continue it with agents_send or agents_steer, without a lookup before each agents_spawn', async () => {
  const text = await rules()
  for (const line of [
    'A hot child session works now, or its last run ended less than 24 hours ago.',
    'such as a follow-up, a fix of its result or the next step of the same task, continue that session.',
    'Send the request to an idle session with agents_send.',
    'Give the request to a session that works now with agents_steer in the default mode',
  ]) assert.ok(text.includes(line), line)
  assert.ok(!text.includes('Before agents_spawn in a directory'))
  assert.ok(!text.includes('idleSessions'))
  assert.ok(!text.includes('Use agents_send for a follow-up in the same child session.'))
})

test('the rules of the main agent name the source of the child session and the cases of a new session', async () => {
  const text = await rules()
  for (const line of [
    'The childSessionId of a session is in the result of agents_spawn and agents_send and in its child result. When your context does not have it, read hotSessions of agents_list.',
    'Start a new session with agents_spawn for an unrelated task, for a task that needs another agent than the session has, or when the user asks for a new session.',
  ]) assert.ok(text.includes(line), line)
})

test('the rules of the main agent tell it to name the continued session, and keep agents_resume and the mode interrupt for a request of the user', async () => {
  const text = await rules()
  for (const line of [
    'When you continue a session, tell the user its title in one short phrase.',
    'When the user objects, start a new session.',
    'Do not continue a session that is not in hotSessions with agents_resume unless the user asks.',
    'Use agents_steer with mode="interrupt" only when the user asks to stop or to redirect the current step',
  ]) assert.ok(text.includes(line), line)
})

test('the descriptions of the tools and the error childBusy name the continuation of a hot session', { timeout: 20000 }, async t => {
  const { service } = await open(t)
  const description = name => service.extension().tools.find(item => item.name === name).description
  assert.match(description('agents_spawn'), /hot child session/)
  assert.match(description('agents_spawn'), /agents_send/)
  assert.match(description('agents_spawn'), /agents_steer/)
  assert.ok(description('agents_send').includes('a follow-up, a fix of its result or the next step of the same task'))
  assert.ok(description('agents_list').includes('less than 24 hours ago'))
  assert.match(description('agents_list'), /hotSessions/)
  assert.ok(description('agents_resume').includes('only when the user asks'))
  assert.ok(message('error.childBusy').includes('the next step of that task, use agents_steer'))
  // The scenario "The description of agents_steer" of the requirement "Tool agents_steer" of the capability steering.
  assert.ok(description('agents_steer').includes('Use it when the user adds information, a correction or the next step of that task.'))
  assert.ok(description('agents_steer').includes('The task keeps one result.'))
})

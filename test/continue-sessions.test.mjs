// The continuation of an idle child session before a new one: the view `idleSessions` of `agents_list`, the rules of the
// main agent and the descriptions of the tools.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
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

test('idleSessions has only the session whose last run completed less than 24 hours ago, is not closed, and whose directory is listed', { timeout: 20000 }, async t => {
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
  assert.deepEqual(answer.idleSessions.map(item => item.childSessionId), ['child-a'])
  // The field runs does not change: one row for each run of the five sessions.
  assert.deepEqual(answer.runs.map(run => run.runId).sort(), ['a', 'b', 'c1', 'c2', 'd1', 'd2', 'e'])
  assert.deepEqual(Object.keys(answer.runs[0]).sort(), ['agent', 'childSessionId', 'cwd', 'prompt', 'runId', 'status', 'title'])
})

test('a run of an older state directory without an end time is not in idleSessions', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  await record(service, { id: 'old', childSessionId: 'child-old', cwd: app, title: 'Old task', createdAt: at(NOW) - HOUR })
  assert.deepEqual((await list()).idleSessions, [])
})

test('idleSessions is empty after the user removes the directory of the session from the list', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  await record(service, { id: 'a', childSessionId: 'child-a', cwd: app, title: 'Task a', createdAt: at(NOW) - 3 * HOUR, finishedAt: at(NOW) - 2 * HOUR })
  assert.deepEqual((await list()).idleSessions.map(item => item.childSessionId), ['child-a'])
  await service.state.removeProject(app)
  assert.deepEqual((await list()).idleSessions, [])
})

test('idleSessions has the 20 newest of 21 idle sessions, the newest first', { timeout: 20000 }, async t => {
  const { service, root, list } = await open(t)
  for (let index = 0; index < 21; index++) {
    const cwd = join(root, `project-${index}`)
    await mkdir(cwd)
    await service.state.change(state => { state.projects.push(cwd) })
    // The session 0 ended 21 hours ago, and the session 20 ended 1 hour ago.
    await record(service, { id: `run-${index}`, childSessionId: `child-${index}`, cwd, title: `Task ${index}`,
      createdAt: at(NOW) - (22 - index) * HOUR, finishedAt: at(NOW) - (21 - index) * HOUR })
  }
  const sessions = (await list()).idleSessions
  assert.deepEqual(sessions.map(item => item.childSessionId), Array.from({ length: 20 }, (_, index) => `child-${20 - index}`))
})

test('the entry of a session with a follow-up has the title of its first run, the title of its last run and the end time', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  await record(service, { id: 'first', childSessionId: 'child-a', cwd: app, title: 'Fix the login test',
    createdAt: at('2026-11-19T08:00:00.000Z'), finishedAt: at('2026-11-19T08:30:00.000Z') })
  await record(service, { id: 'second', childSessionId: 'child-a', cwd: app, title: 'Add a test for the fix',
    createdAt: at('2026-11-19T09:30:00.000Z'), finishedAt: at('2026-11-19T10:00:00.000Z') })
  assert.deepEqual((await list()).idleSessions, [{ childSessionId: 'child-a', agent: 'claude', cwd: app, title: 'Fix the login test',
    lastTitle: 'Add a test for the fix', endedAt: '2026-11-19T10:00:00.000Z' }])
})

test('the entry of a Codex session of one run has no lastTitle, and a run without a title gives the start of its prompt', { timeout: 20000 }, async t => {
  const { service, app, list } = await open(t)
  await record(service, { id: 'f', childSessionId: 'child-f', cwd: app, agent: 'codex', title: 'Update the README',
    createdAt: at(NOW) - 2 * HOUR, finishedAt: at(NOW) - HOUR })
  const prompt = 'Read the open issues of the tracker and write a short list of the issues that block the next release of the app.'
  await record(service, { id: 'g', childSessionId: 'child-g', cwd: app, prompt, createdAt: at(NOW) - 4 * HOUR, finishedAt: at(NOW) - 3 * HOUR })
  const [codex, untitled] = (await list()).idleSessions
  assert.deepEqual(codex, { childSessionId: 'child-f', agent: 'codex', cwd: app, title: 'Update the README', endedAt: '2026-11-19T11:00:00.000Z' })
  assert.equal(untitled.title, prompt.slice(0, 80))
  assert.equal(untitled.lastTitle, undefined)
})

test('the rules of the main agent tell it to continue an idle child session of the same topic before agents_spawn', async () => {
  const rules = await readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')
  for (const text of [
    'Before agents_spawn in a directory, read idleSessions of agents_list for that directory, unless a call in this turn gave it.',
    'such as a follow-up, a fix of its result or the next step of the same task, send it to that session with agents_send.',
    'Start a new session with agents_spawn for an unrelated task, for a task that needs another agent than the session has, or when the user asks for a new session.',
  ]) assert.ok(rules.includes(text), text)
  assert.ok(!rules.includes('Use agents_send for a follow-up in the same child session.'))
})

test('the rules of the main agent tell it to name the continued session, and keep agents_steer and agents_resume for their cases', async () => {
  const rules = await readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')
  for (const text of [
    'When you continue a session, tell the user its title in one short phrase.',
    'When the user objects, start a new session.',
    'A child session that works now is not in idleSessions.',
    'Do not continue a session that is not in idleSessions with agents_resume unless the user asks.',
  ]) assert.ok(rules.includes(text), text)
})

test('the descriptions of agents_spawn, agents_send, agents_list and agents_resume name the continuation of a session', { timeout: 20000 }, async t => {
  const { service } = await open(t)
  const description = name => service.extension().tools.find(item => item.name === name).description
  assert.match(description('agents_spawn'), /idleSessions/)
  assert.match(description('agents_spawn'), /agents_send/)
  assert.ok(description('agents_send').includes('a follow-up, a fix of its result or the next step of the same task'))
  assert.ok(description('agents_list').includes('less than 24 hours ago'))
  assert.ok(description('agents_resume').includes('only when the user asks'))
})

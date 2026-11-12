import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { taskRows } from '../src/AcpBridge.mjs'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { ChildSlot } from '../src/ChildSlot.mjs'
import { serviceSessionsOf, terminalStates } from '../src/MegachatState.mjs'
import { message } from '../src/messages.mjs'
import { childEnvironment, readTool } from '../src/PiChild.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { PiRunService } from '../src/PiRunService.mjs'
import { ProjectReadEnv } from '../src/ProjectReadEnv.mjs'
import { waitForState } from '../src/waitForState.mjs'

const MAIN = 'faux/big'
const SMALL = 'faux/small'
const context = BACKGROUND_CONTEXT
const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
const README = 'Hello from the README of the project.'
const RULES = 'Name each file that you read.'

/**
 * The system prompt and the tools of a request. Pi Durable sends a changed section or tool set as a later system
 * message, so the replay of each system message in order gives them.
 */
function prompt(messages) {
  const shown = new Map()
  const tools = new Map()
  for (const item of messages) {
    if (item.role !== 'system') continue
    for (const [key, value] of Object.entries(item.sections ?? {})) value === null ? shown.delete(key) : shown.set(key, value)
    for (const tool of item.toolsAdded ?? []) tools.set(tool.name, tool)
    for (const tool of item.toolsRemoved ?? []) tools.delete(tool.name ?? tool)
  }
  return { shown, tools: [...tools.keys()] }
}

/**
 * A fake provider with a free model for the main agent and a priced model for a pi child. A request with the tool
 * `read` is a request of a child, and it gets the next reply of [child]. Each other request gets the next reply of
 * [main]. A reply can be a function of the request.
 */
function fakeModels(main, child) {
  const fake = fauxProvider({ models: [
    { id: 'big', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    { id: 'small', cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
  ] })
  const requests = []
  fake.setResponses(Array(300).fill((request, options, _state, model) => {
    const { shown, tools } = prompt(request.messages)
    const isChild = tools.includes('read')
    requests.push({ child: isChild, model: `${model.provider}/${model.id}`, tools, sectionKeys: [...shown.keys()],
      system: [...shown.values()].join('\n'), messages: JSON.stringify(request.messages) })
    const reply = (isChild ? child : main).shift() ?? fauxAssistantMessage(isChild ? 'Child answer.' : 'Answer.')
    return typeof reply === 'function' ? reply(request, options) : reply
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  return { models, requests }
}

/** A reply that waits until the request stops, as a model that does not answer in time. */
const hang = (_request, options) => new Promise(resolve => {
  options.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('Too late.')), { once: true })
})

async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-pi-')))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  const cwd = join(directory, 'project')
  await mkdir(cwd)
  await writeFile(join(cwd, 'README.md'), README)
  await writeFile(join(cwd, 'AGENTS.md'), RULES)
  await writeFile(join(directory, 'secret.txt'), 'TOP SECRET')
  return { directory, cwd }
}

/**
 * A service with a pi run service and, with [acp], an ACP run service with the fake agent. Both share one slot. The
 * main agent uses the free model, and [values] go to `settings.json`.
 */
async function open(t, { directory, cwd }, { values = {}, storage = new MemoryStorage(), main = [], child = [], deadlineMs, acp = false } = {}) {
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN, ...values } }), { mode: 0o600 })
  const { models, requests } = fakeModels(main, child)
  const service = await PiMegachatService.open(storage, models, undefined, {}, { settingsPath: join(directory, 'settings.json'),
    spendPath: join(directory, 'spend.json'), keepAlive: { enabled: false }, environment: {} })
  await service.state.addWorkspace(cwd)
  const slot = new ChildSlot()
  const pi = new PiRunService(service.state, service.harness, { agent: directory => service.childAgent(directory), slot, deadlineMs })
  await pi.start()
  const launched = []
  const children = acp ? new AcpRunService(service.state, { childLaunch: async agent => { launched.push(agent); return { env: process.env } } },
    { args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], slot }) : undefined
  await children?.start()
  await service.resume()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await children?.close()
    await pi.close()
    await service.close()
  }
  t.after(close)
  /** One turn of the user, then the wait for each child and for its report. */
  const turn = async (id, text = 'Work') => {
    await service.submit(id, text)
    return finished(service)
  }
  return { service, pi, requests, main, child, turn, close, launched }
}

/** Waits until [ready] gives true. A model request changes no state, so a wait for the state cannot see it. */
async function until(ready) {
  while (!await ready()) await new Promise(resolve => setTimeout(resolve, 10))
}

const finished = service => waitForState(service.state, state => !state.current && Object.keys(state.runs).length
  && Object.values(state.runs).every(run => terminalStates.has(run.status) && run.reported) ? state : undefined)

async function reports(service) {
  const { items } = await service.root.entries({ order: 'ascending' }, 500, undefined, context)
  return items.filter(entry => entry.kind === 'air.megachat.event' && entry.data?.type === 'children')
}

test('a pi child reads its project in the daemon process with only the tool read and no rule of the main agent, and the main agent gets one report', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  const { service, requests, turn } = await open(t, project, {
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi', title: 'README summary' }), fauxAssistantMessage('Started.'),
      fauxAssistantMessage('The README greets.')],
    child: [fauxAssistantMessage([fauxToolCall('read', { path: 'README.md' }), fauxToolCall('read', { path: '../secret.txt' })], { stopReason: 'toolUse' }),
      fauxAssistantMessage('The README says hello.')],
  })
  const state = await turn('spawn')
  const [run] = Object.values(state.runs)
  // No run service of an agent process exists here, so the run ran in the daemon process.
  assert.deepEqual([run.agent, run.status, run.pid, run.output, run.title], ['pi', 'completed', null, 'The README says hello.', 'README summary'])
  assert.match(run.providerSessionId, /^\d+$/)
  assert.equal((await reports(service)).length, 1)
  // A pi child has no session of Claude Code or Codex, so Air gets no session to hide.
  assert.deepEqual(state.serviceSessions, {})
  assert.deepEqual(serviceSessionsOf(state.runs), {})
  const childRequests = requests.filter(request => request.child)
  assert.equal(childRequests.length, 2)
  for (const request of childRequests) {
    // children.piModel names a model that the fake registry does not know, so the child uses the model of the main agent.
    assert.equal(request.model, MAIN)
    assert.deepEqual(request.tools, ['read'])
    assert.deepEqual(request.sectionKeys, ['instructions'])
    assert.ok(request.system.startsWith(`<instructions>\n${message('child.pi.instructions', cwd)}`))
    assert.match(request.system, /<repository_rules file="AGENTS.md">\nName each file that you read\.\n<\/repository_rules>/)
    assert.doesNotMatch(request.system, /You coordinate work|agents_|setup of Megachat/)
  }
  // The read in the project worked, and the read out of the project failed.
  assert.ok(childRequests[1].messages.includes(README))
  assert.ok(childRequests[1].messages.includes(message('error.pi.outside', join(project.directory, 'secret.txt'))))
  assert.ok(!childRequests[1].messages.includes('TOP SECRET'))
  const mainRequests = requests.filter(request => !request.child)
  assert.ok(mainRequests.every(request => request.model === MAIN && request.tools.includes('agents_spawn') && !request.tools.includes('read')))
  // Only the conversation of a child gets an environment.
  assert.equal(await childEnvironment({ conversationId: service.root.id, read: service.harness }, context), undefined)
  assert.ok(await childEnvironment({ conversationId: Number(run.providerSessionId), read: service.harness }, context) instanceof ProjectReadEnv)
})

test('agents_send continues the same pi conversation, a change of children.piModel reaches the next run, and the spend counts the child', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd, directory } = project
  const { service, requests, main, child, turn } = await open(t, project, {
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi' }), fauxAssistantMessage('Started.'), fauxAssistantMessage('Reported.')],
    child: [fauxAssistantMessage('First answer.')],
  })
  let state = await turn('first')
  const [first] = Object.values(state.runs)
  // The child used the free model of the main agent.
  assert.equal(service.spend.report(0).usd, 0)
  main.push(call('agents_settings', { action: 'set', key: 'children.piModel', value: SMALL }),
    call('agents_send', { childSessionId: first.childSessionId, cwd, prompt: 'And the license?' }), fauxAssistantMessage('Sent.'))
  child.push(fauxAssistantMessage('No license file.'))
  state = await turn('second')
  const second = Object.values(state.runs).find(run => run.id !== first.id)
  assert.deepEqual([second.agent, second.status, second.providerSessionId, second.output], ['pi', 'completed', first.providerSessionId, 'No license file.'])
  const childRequests = requests.filter(request => request.child)
  assert.deepEqual(childRequests.map(request => request.model), [MAIN, SMALL])
  // The follow-up request holds the first exchange, so it is the same conversation.
  assert.ok(childRequests[1].messages.includes('Summarize the README.') && childRequests[1].messages.includes('First answer.'))
  assert.ok(requests.filter(request => !request.child).every(request => request.model === MAIN))
  assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).values['children.piModel'], SMALL)
  // The priced model of the child is the only cost.
  assert.ok(service.spend.report(0).usd > 0)
  // agents_session_history reads the transcript of the child without the index of past sessions.
  const history = await service.sessions.read({ cwd, agent: 'pi', sessionId: first.providerSessionId })
  assert.deepEqual(history.entries.map(entry => [entry.role, entry.text]), [['user', 'Summarize the README.'], ['assistant', 'First answer.'],
    ['user', 'And the license?'], ['assistant', 'No license file.']])
  await assert.rejects(service.sessions.read({ cwd, agent: 'pi', sessionId: '99999' }), { code: 'sessionsIndexOff' })
})

test('agents_cancel stops a pi child, and the main conversation continues', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  const { service, requests, main, turn } = await open(t, project, {
    main: [call('agents_spawn', { cwd, prompt: 'Wait.', agent: 'pi' }), fauxAssistantMessage('Started.')],
    child: [hang],
  })
  await service.submit('spawn', 'Work')
  const run = await waitForState(service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  await until(() => requests.some(request => request.child))
  main.push(call('agents_cancel', { runId: run.id }), fauxAssistantMessage('Cancelling.'), fauxAssistantMessage('It stopped.'))
  let state = await turn('cancel')
  assert.equal(state.runs[run.id].status, 'cancelled')
  assert.equal(Object.keys(state.runs).length, 1)
  main.push(fauxAssistantMessage('Still here.'))
  state = await turn('hello', 'Hello')
  assert.equal(state.inputs.hello.status, 'completed')
})

test('the deadline stops a pi child without a continuation, and the main conversation continues', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  const { main, turn } = await open(t, project, { deadlineMs: 300,
    main: [call('agents_spawn', { cwd, prompt: 'Wait.', agent: 'pi' }), fauxAssistantMessage('Started.'), fauxAssistantMessage('It ran out of time.')],
    child: [hang],
  })
  let state = await turn('spawn')
  const [run] = Object.values(state.runs)
  assert.deepEqual([run.status, run.error, run.autoResume, run.resumedBy], ['interrupted', message('error.limit'), false, undefined])
  assert.equal(Object.keys(state.runs).length, 1)
  main.push(fauxAssistantMessage('Still here.'))
  state = await turn('hello', 'Hello')
  assert.equal(state.inputs.hello.status, 'completed')
})

test('a pi child ends after 20 tool rounds as failed with the reason code', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  const { requests, turn } = await open(t, project, {
    main: [call('agents_spawn', { cwd, prompt: 'Read forever.', agent: 'pi' }), fauxAssistantMessage('Started.')],
    child: Array(30).fill(call('read', { path: 'README.md' })),
  })
  const [run] = Object.values((await turn('spawn')).runs)
  assert.deepEqual([run.status, run.stopReason, run.error], ['failed', 'turn_limit', message('error.pi.stopped', 'turn_limit')])
  assert.equal(requests.filter(request => request.child).length, 20)
})

test('a daemon restart during a pi run continues the same run in the same conversation', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd, directory } = project
  const path = join(directory, 'conversation.sqlite')
  const first = await open(t, project, { storage: await openNodeSqliteStorage(path),
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi' }), fauxAssistantMessage('Started.')], child: [hang] })
  await first.service.submit('spawn', 'Work')
  const run = await waitForState(first.service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  await until(async () => !(await first.service.state.snapshot()).current && first.requests.some(request => request.child))
  await first.close()
  const second = await open(t, project, { storage: await openNodeSqliteStorage(path),
    main: [fauxAssistantMessage('The child finished after the restart.')], child: [fauxAssistantMessage('Done after the restart.')] })
  const state = await finished(second.service)
  assert.deepEqual(Object.keys(state.runs), [run.id])
  assert.deepEqual([state.runs[run.id].status, state.runs[run.id].output, state.runs[run.id].providerSessionId],
    ['completed', 'Done after the restart.', run.providerSessionId])
  // Pi Durable sent the stopped request again in the same conversation.
  const [again] = second.requests.filter(request => request.child)
  assert.ok(again.messages.includes('Summarize the README.'))
  assert.equal((await reports(second.service)).length, 1)
})

test('the daemon runs one child at a time: a pi run waits for an ACP run, and an ACP run waits for a pi run', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  const { service, requests, main, child, turn } = await open(t, project, { acp: true,
    main: [call('agents_spawn', { cwd, prompt: 'approval', agent: 'claude' }), call('agents_spawn', { cwd, prompt: 'Read.', agent: 'pi' }),
      fauxAssistantMessage('Started.')],
  })
  await service.submit('first', 'Work')
  const permission = await waitForState(service.state, state => Object.values(state.permissions).find(item => item.status === 'pending'))
  await waitForState(service.state, state => !state.current || undefined)
  const waiting = Object.values((await service.state.snapshot()).runs)
  assert.deepEqual(waiting.map(run => [run.agent, run.status]), [['claude', 'approval'], ['pi', 'admitted']])
  assert.ok(!requests.some(request => request.child))
  await service.state.respondPermission(permission.id, 'yes')
  let state = await finished(service)
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ['completed', 'completed'])

  // The reverse order: the ACP agent gets no prompt while the pi child works.
  let release
  child.push(() => new Promise(resolve => { release = () => resolve(fauxAssistantMessage('Released.')) }))
  main.push(call('agents_spawn', { cwd, prompt: 'Wait for me.', agent: 'pi' }), call('agents_spawn', { cwd, prompt: 'hello', agent: 'claude' }),
    fauxAssistantMessage('Started.'))
  await service.submit('second', 'Work')
  await until(async () => !(await service.state.snapshot()).current && release)
  const runs = Object.values((await service.state.snapshot()).runs).slice(2)
  assert.deepEqual(runs.map(run => [run.agent, run.status]), [['pi', 'dispatched'], ['claude', 'admitted']])
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), 'approval\n')
  release()
  state = await finished(service)
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ['completed', 'completed', 'completed', 'completed'])
  assert.equal(await readFile(join(cwd, 'dispatches'), 'utf8'), 'approval\nhello\n')
  void turn
})

test('the chat lists a pi child as a background task of the agent Pi', () => {
  const run = { id: 'run', status: 'dispatched', agent: 'pi', cwd: '/work/project', prompt: 'Read the README.', title: 'README' }
  assert.deepEqual([...taskRows({ runs: { run } }).values()], [{ name: 'README', description: message('child.running', 'Pi', 'project') }])
  assert.deepEqual([...taskRows({ runs: { run: { ...run, status: 'admitted' } } }).values()][0].description, message('child.queued', 'Pi', 'project'))
})

test('an automatic turn cannot start a pi child, and a session of the pi command-line agent cannot continue as one', { timeout: 20000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  const { service } = await open(t, project)
  for (const kind of ['event', 'report']) {
    await service.state.change(state => { state.current = { id: kind, requestId: kind, cancelling: false, kind } })
    await assert.rejects(service.state.admitChild(`${kind}:spawn`, { cwd, prompt: 'Read.', agent: 'pi' }), { code: 'proposalOnly' })
  }
  await service.state.change(state => { state.current = { id: 'user', requestId: 'user', cancelling: false, kind: 'user' } })
  await assert.rejects(service.state.admitChild('resume', { cwd, prompt: 'Read.', agent: 'pi', providerSessionId: 'cli-session' }), { code: 'invalid' })
  await service.state.change(state => { state.current = null })
})

test('the environment of a pi child reads the files of its project and refuses each path out of it and each change', async t => {
  const { directory, cwd } = await temporary(t)
  await mkdir(join(cwd, 'docs'))
  await writeFile(join(cwd, 'docs', 'notes.txt'), 'inside')
  await symlink(join(directory, 'secret.txt'), join(cwd, 'outside-link'))
  await symlink(join(cwd, 'docs', 'notes.txt'), join(cwd, 'inside-link'))
  await symlink(directory, join(cwd, 'parent-link'))
  const env = new ProjectReadEnv(cwd)
  const api = { env, agent: async () => ({}), models: { getModel: () => undefined } }
  const read = path => readTool.execute({ path }, api, context)
  assert.equal((await read('docs/notes.txt')).structuredOutput, 'inside')
  assert.equal((await read(join(cwd, 'docs', 'notes.txt'))).structuredOutput, 'inside')
  assert.equal((await read('inside-link')).structuredOutput, 'inside')
  assert.equal((await read('docs/../README.md')).structuredOutput, README)
  for (const path of ['../secret.txt', join(directory, 'secret.txt'), 'outside-link', 'parent-link/secret.txt', '/etc/hosts', '~/.ssh/id_rsa'])
    await assert.rejects(read(path), /outside the project directory|ENOENT|no such file/, path)
  assert.equal((await env.exists('../secret.txt', context)).value, false)
  assert.equal((await env.writeFile(join(cwd, 'new.txt'), 'x', context)).ok, false)
  assert.equal((await env.remove(join(cwd, 'README.md'), undefined, context)).ok, false)
  assert.equal((await env.exec('touch new.txt', undefined, context)).ok, false)
  assert.equal(await readFile(join(cwd, 'README.md'), 'utf8'), README)
})

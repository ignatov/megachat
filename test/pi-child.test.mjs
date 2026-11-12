import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
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
import { childEnvironment, readTool, repositoryRules } from '../src/PiChild.mjs'
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
async function open(t, { directory, cwd }, { values = {}, storage = new MemoryStorage(), main = [], child = [], deadlineMs, acp = false, startPi = true, resumeDelayMs, launch } = {}) {
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN, ...values } }), { mode: 0o600 })
  const { models, requests } = fakeModels(main, child)
  const service = await PiMegachatService.open(storage, models, undefined, {}, { settingsPath: join(directory, 'settings.json'),
    spendPath: join(directory, 'spend.json'), keepAlive: { enabled: false }, environment: {}, resumeDelayMs })
  await service.state.addWorkspace(cwd)
  const slot = new ChildSlot()
  const pi = new PiRunService(service.state, service.harness, { agent: launch ?? (directory => service.childAgent(directory)), slot, deadlineMs })
  if (startPi) await pi.start()
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

test('an AGENTS.md that is a FIFO does not hold the start of a pi child, and the child gets no repository rules', { timeout: 20000, skip: process.platform === 'win32' }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  await rm(join(cwd, 'AGENTS.md'))
  execFileSync('mkfifo', [join(cwd, 'AGENTS.md')])
  const { requests, turn } = await open(t, project, { deadlineMs: 5000,
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi' }), fauxAssistantMessage('Started.'), fauxAssistantMessage('Reported.')],
  })
  const [run] = Object.values((await turn('spawn')).runs)
  assert.deepEqual([run.status, run.output], ['completed', 'Child answer.'])
  const [request] = requests.filter(item => item.child)
  assert.doesNotMatch(request.system, /repository_rules/)
})

test('a cancel, the deadline and a daemon stop end a pi run whose start waits', { timeout: 30000 }, async t => {
  const waiting = () => new Promise(() => {})
  const start = async (options = {}) => {
    const project = await temporary(t)
    const opened = await open(t, project, { launch: waiting, ...options,
      main: [call('agents_spawn', { cwd: project.cwd, prompt: 'Read.', agent: 'pi' }), fauxAssistantMessage('Started.'), ...options.main ?? []] })
    await opened.service.submit('spawn', 'Work')
    const run = await waitForState(opened.service.state, state => state.current ? undefined
      : Object.values(state.runs).find(run => run.status === 'launching'))
    return { ...opened, run }
  }
  const cancelled = await start()
  cancelled.main.push(call('agents_cancel', { runId: cancelled.run.id }), fauxAssistantMessage('Cancelling.'), fauxAssistantMessage('It stopped.'))
  assert.equal((await cancelled.turn('cancel')).runs[cancelled.run.id].status, 'cancelled')

  const limited = await start({ deadlineMs: 300, main: [fauxAssistantMessage('It ran out of time.')] })
  const ended = (await finished(limited.service)).runs[limited.run.id]
  assert.deepEqual([ended.status, ended.error, ended.autoResume, ended.resumedBy], ['interrupted', message('error.limit'), false, undefined])

  const stopped = await start()
  await stopped.pi.close()
  const left = (await stopped.service.state.snapshot()).runs[stopped.run.id]
  assert.deepEqual([left.status, left.plannedStop], ['resumed', true])
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

/**
 * Makes the environment of [cwd] swap the directory [directory] for a symbolic link to [target] after the path check of
 * its first open, as another process with write access to the project can do.
 */
function swapAfterCheck(cwd, directory, target) {
  const env = new ProjectReadEnv(cwd)
  const openReader = env.inner.openBinaryReader.bind(env.inner)
  let swapped = false
  env.inner.openBinaryReader = async (...args) => {
    if (!swapped) {
      swapped = true
      await rename(directory, `${directory}-old`)
      await symlink(target, directory)
    }
    return openReader(...args)
  }
  return env
}

test('a directory that another process swaps after the path check does not lead the read of a pi child out of the project', async t => {
  const { directory, cwd } = await temporary(t)
  await mkdir(join(cwd, 'docs'))
  await writeFile(join(cwd, 'docs', 'notes.txt'), 'inside')
  await mkdir(join(directory, 'outside'))
  await writeFile(join(directory, 'outside', 'notes.txt'), 'TOP SECRET')
  await writeFile(join(directory, 'outside', 'AGENTS.md'), 'TOP SECRET')
  const env = swapAfterCheck(cwd, join(cwd, 'docs'), join(directory, 'outside'))
  const api = { env, agent: async () => ({}), models: { getModel: () => undefined } }
  await assert.rejects(readTool.execute({ path: 'docs/notes.txt' }, api, context), { message: message('error.pi.changed', join(cwd, 'docs', 'notes.txt')) })
  // The rules file reads through the same environment. Here the project directory itself is swapped.
  const rulesEnv = swapAfterCheck(cwd, cwd, join(directory, 'outside'))
  assert.equal(await repositoryRules(cwd, rulesEnv), undefined)
  // Without a swap, the rules file of the project counts.
  assert.deepEqual(await repositoryRules(`${cwd}-old`), { name: 'AGENTS.md', text: RULES, truncated: false })
})

const STEER = 'Also check the license.'
/** Makes a turn of [kind] current, or no turn with `null`, as the tool calls of a turn see it. */
const setCurrent = (service, kind) => service.state.change(state => { state.current = kind ? { id: kind, requestId: kind, cancelling: false, kind } : null })
const occurrences = (text, part) => text.split(part).length - 1

test('a steer during the turn of a pi child reaches its next model request one time, and the run ends with one report', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  let release
  const { service, requests } = await open(t, project, {
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi' }), fauxAssistantMessage('Started.'), fauxAssistantMessage('Reported.')],
    child: [() => new Promise(resolve => { release = () => resolve(call('read', { path: 'README.md' })) }), fauxAssistantMessage('Done with the license.')],
  })
  await service.submit('spawn', 'Work')
  const run = await waitForState(service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  await until(async () => release && !(await service.state.snapshot()).current)
  await setCurrent(service, 'user')
  const args = { childSessionId: run.childSessionId, prompt: STEER, mode: 'queue' }
  const first = await service.steer('tool:steer-1:steer', args)
  // A repeated tool call gives the first record and sends nothing.
  const again = await service.steer('tool:steer-1:steer', args)
  await setCurrent(service, null)
  assert.deepEqual([first.outcome, again.outcome, again.steerId], ['injected', 'injected', first.steerId])
  release()
  const state = await finished(service)
  assert.deepEqual(Object.values(state.runs).map(item => [item.status, item.output]), [['completed', 'Done with the license.']])
  const childRequests = requests.filter(request => request.child)
  assert.equal(childRequests.length, 2)
  assert.equal(occurrences(childRequests[1].messages, STEER), 1)
  assert.ok(childRequests[1].messages.includes(message('child.steer')))
  assert.equal((await reports(service)).length, 1)
})

/**
 * Starts a pi run whose first child request waits for `release`, and steers it with mode queue during that request.
 * [before] gives the replies of the child before that request, and [after] the replies after it.
 */
async function steerDuringRequest(t, { before = [], after = [], main = [], ...options } = {}) {
  const project = await temporary(t)
  const { cwd } = project
  const held = {}
  const opened = await open(t, project, { ...options,
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi' }), fauxAssistantMessage('Started.'), ...main],
    child: [...before, () => new Promise(resolve => { held.release = resolve }), ...after],
  })
  const { service } = opened
  await service.submit('spawn', 'Work')
  const run = await waitForState(service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  await until(async () => held.release && !(await service.state.snapshot()).current)
  await setCurrent(service, 'user')
  const steered = await service.steer('tool:steer-held:steer', { childSessionId: run.childSessionId, prompt: STEER, mode: 'queue' })
  await setCurrent(service, null)
  assert.equal(steered.outcome, 'injected')
  return { ...opened, run, release: reply => held.release(reply) }
}

test('a model error after a queued steer ends the pi run at once, and its continuation holds the message as a possible repeat', { timeout: 30000 }, async t => {
  const { service, run, release, requests } = await steerDuringRequest(t, { resumeDelayMs: 10, deadlineMs: 5000,
    after: [fauxAssistantMessage('Answered the message.')], main: [fauxAssistantMessage('Reported.')] })
  release(fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'Bad request.' }))
  const state = await finished(service)
  const stopped = state.runs[run.id]
  assert.deepEqual([stopped.status, stopped.stopReason, stopped.error], ['resumed', 'model_error', message('error.interrupted')])
  const continued = state.runs[stopped.resumedBy]
  assert.deepEqual([continued.status, continued.output], ['completed', 'Answered the message.'])
  assert.deepEqual(continued.steers.map(item => [item.delivery, item.repeat]), [['fallback', true]])
  const last = requests.filter(request => request.child).at(-1)
  assert.equal(occurrences(last.messages, STEER), 1)
  assert.ok(last.messages.includes(message('child.steer.repeat', 1)))
})

test('a turn limit after a queued steer ends the pi run at once, and its report says that the child did not get the message', { timeout: 30000 }, async t => {
  const { service, run, release } = await steerDuringRequest(t, { deadlineMs: 5000,
    before: Array(19).fill(call('read', { path: 'README.md' })), main: [fauxAssistantMessage('Reported.')] })
  release(call('read', { path: 'README.md' }))
  const state = await finished(service)
  const ended = state.runs[run.id]
  assert.deepEqual([ended.status, ended.stopReason, ended.resumedBy], ['failed', 'turn_limit', undefined])
  assert.equal(ended.error, `${message('error.pi.stopped', 'turn_limit')} ${message('error.pi.unhandledSteers', 1)}`)
  assert.equal(Object.keys(state.runs).length, 1)
  const [report] = await reports(service)
  assert.equal(report.data.results[0].error, ended.error)
})

test('a steer of a queued pi run goes in its prompt', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  let release
  const { service, requests } = await open(t, project, {
    main: [call('agents_spawn', { cwd, prompt: 'First task.', agent: 'pi' }), call('agents_spawn', { cwd, prompt: 'Second task.', agent: 'pi' }),
      fauxAssistantMessage('Started.')],
    child: [() => new Promise(resolve => { release = () => resolve(fauxAssistantMessage('First.')) }), fauxAssistantMessage('Second.')],
  })
  await service.submit('spawn', 'Work')
  await until(async () => release && !(await service.state.snapshot()).current)
  const [, queued] = Object.values((await service.state.snapshot()).runs)
  assert.equal(queued.status, 'admitted')
  await setCurrent(service, 'user')
  const steered = await service.steer('tool:steer-2:steer', { childSessionId: queued.childSessionId, prompt: STEER, mode: 'queue' })
  await setCurrent(service, null)
  assert.equal(steered.outcome, 'queued')
  release()
  await finished(service)
  const second = requests.filter(request => request.child)[1]
  assert.ok(second.messages.includes('Second task.') && second.messages.includes(message('child.steer.added')))
  assert.equal(occurrences(second.messages, STEER), 1)
})

test('a steer after the end of the turn of a pi child becomes a follow-up in the same conversation', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd, directory } = project
  const path = join(directory, 'conversation.sqlite')
  const first = await open(t, project, { storage: await openNodeSqliteStorage(path),
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi' }), fauxAssistantMessage('Started.')], child: [hang] })
  await first.service.submit('spawn', 'Work')
  const run = await waitForState(first.service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  await until(async () => !(await first.service.state.snapshot()).current && first.requests.some(request => request.child))
  await first.close()
  // The next daemon finishes the turn before its pi run service starts, so the run still works and the turn ended.
  const second = await open(t, project, { storage: await openNodeSqliteStorage(path), startPi: false,
    main: [fauxAssistantMessage('Reported.')], child: [fauxAssistantMessage('The README says hello.'), fauxAssistantMessage('No license file.')] })
  await (await second.service.harness.conversation(Number(run.providerSessionId), context)).waitForIdle(context)
  await setCurrent(second.service, 'user')
  const recorded = await second.service.state.steer('tool:steer-3:steer', { childSessionId: run.childSessionId, prompt: STEER, mode: 'queue' })
  await setCurrent(second.service, null)
  assert.equal(recorded.delivery, 'pending')
  await second.pi.start()
  const state = await finished(second.service)
  const [stopped, followUp] = Object.values(state.runs)
  assert.deepEqual([stopped.status, stopped.resumedBy, followUp.status, followUp.providerSessionId], ['resumed', followUp.id, 'completed', run.providerSessionId])
  assert.equal(followUp.output, 'The README says hello.\n\nNo license file.')
  assert.equal(stopped.steers[0].outcome, 'followUp')
  const childRequests = second.requests.filter(request => request.child)
  assert.ok(childRequests[1].messages.includes(message('child.steer.followUp')) && childRequests[1].messages.includes('The README says hello.'))
  assert.equal(occurrences(childRequests[1].messages, STEER), 1)
  assert.equal((await reports(second.service)).length, 1)
})

test('a steer with mode interrupt aborts the turn of a pi child, and a continuation in the same conversation holds the message', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  const { service, requests } = await open(t, project, {
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi' }), fauxAssistantMessage('Started.'), fauxAssistantMessage('Reported.')],
    child: [hang, fauxAssistantMessage('Redirected.')],
  })
  await service.submit('spawn', 'Work')
  const run = await waitForState(service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  await until(async () => !(await service.state.snapshot()).current && requests.some(request => request.child))
  await setCurrent(service, 'user')
  const steered = await service.steer('tool:steer-4:steer', { childSessionId: run.childSessionId, prompt: STEER, mode: 'interrupt' })
  await setCurrent(service, null)
  assert.equal(steered.outcome, 'restarted')
  const state = await finished(service)
  const [stopped, continued] = Object.values(state.runs)
  assert.deepEqual([stopped.status, continued.status, continued.providerSessionId, continued.output], ['resumed', 'completed', run.providerSessionId, 'Redirected.'])
  const second = requests.filter(request => request.child)[1]
  assert.ok(second.messages.includes(message('child.steer.restarted.pi')))
  assert.equal(occurrences(second.messages, STEER), 1)
  assert.equal((await reports(service)).length, 1)
})

test('the continuation for a message to a pi child starts before an older queued task', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  const { service, requests } = await open(t, project, {
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi' }), call('agents_spawn', { cwd, prompt: 'Second task.', agent: 'pi' }),
      fauxAssistantMessage('Started.')],
    child: [hang, fauxAssistantMessage('Redirected.'), fauxAssistantMessage('Second.')],
  })
  await service.submit('spawn', 'Work')
  await until(async () => !(await service.state.snapshot()).current && requests.some(request => request.child))
  const [run, queued] = Object.values((await service.state.snapshot()).runs)
  assert.deepEqual([run.status, queued.status], ['dispatched', 'admitted'])
  await setCurrent(service, 'user')
  assert.equal((await service.steer('tool:steer-6:steer', { childSessionId: run.childSessionId, prompt: STEER, mode: 'interrupt' })).outcome, 'restarted')
  await setCurrent(service, null)
  const state = await finished(service)
  const continued = state.runs[state.runs[run.id].resumedBy]
  assert.deepEqual([continued.urgent, continued.output, state.runs[queued.id].output], [true, 'Redirected.', 'Second.'])
  const [, second, third] = requests.filter(request => request.child)
  assert.ok(second.messages.includes(message('child.steer.restarted.pi')) && !second.messages.includes('Second task.'))
  assert.ok(third.messages.includes('Second task.'))
})

test('a call for a give at the end of a give of the pi run service starts one more give', { timeout: 5000 }, async () => {
  const pi = new PiRunService(null, null)
  const work = { delivering: null, ended: false }
  let gives = 0
  pi.sendSteers = () => {
    gives++
    // The second reaction runs after the loop of the give looked at `again` for the last time. A steer that the state
    // records then must get its own give.
    if (gives === 1) Promise.resolve().then(() => {}).then(() => pi.deliverSteers('run', 'generation', work, null))
    return Promise.resolve()
  }
  await pi.deliverSteers('run', 'generation', work, null)
  await new Promise(resolve => setImmediate(resolve))
  await work.delivering
  assert.equal(gives, 2)
})

test('a pending message of a pi run arrives after a daemon restart', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd, directory } = project
  const path = join(directory, 'conversation.sqlite')
  const first = await open(t, project, { storage: await openNodeSqliteStorage(path),
    main: [call('agents_spawn', { cwd, prompt: 'Summarize the README.', agent: 'pi' }), fauxAssistantMessage('Started.')], child: [hang] })
  await first.service.submit('spawn', 'Work')
  const run = await waitForState(first.service.state, state => Object.values(state.runs).find(run => run.status === 'dispatched'))
  await until(async () => !(await first.service.state.snapshot()).current && first.requests.some(request => request.child))
  // The run service stops first, so the message stays pending in the stored state.
  await first.pi.close()
  await setCurrent(first.service, 'user')
  assert.equal((await first.service.state.steer('tool:steer-5:steer', { childSessionId: run.childSessionId, prompt: STEER, mode: 'queue' })).delivery, 'pending')
  await setCurrent(first.service, null)
  await first.close()
  const second = await open(t, project, { storage: await openNodeSqliteStorage(path),
    main: [fauxAssistantMessage('Reported.')], child: [call('read', { path: 'README.md' }), fauxAssistantMessage('Done.'), fauxAssistantMessage('Done.')] })
  const state = await finished(second.service)
  assert.ok(Object.values(state.runs).every(item => item.status === 'completed' || item.status === 'resumed'))
  assert.ok(Object.values(state.runs).flatMap(item => item.steers ?? []).every(item => item.delivery !== 'pending'))
  const childRequests = second.requests.filter(request => request.child)
  assert.equal(occurrences(childRequests.at(-1).messages, STEER), 1)
  assert.equal((await reports(second.service)).length, 1)
})

test('a turn of a project event or of a child result cannot steer a pi child, and a pi continuation names no git status', { timeout: 30000 }, async t => {
  const project = await temporary(t)
  const { cwd } = project
  const { service } = await open(t, project, { startPi: false })
  await setCurrent(service, 'user')
  const run = await service.state.admitChild('spawn', { cwd, prompt: 'Read.', agent: 'pi' })
  for (const kind of ['event', 'report']) {
    await setCurrent(service, kind)
    await assert.rejects(service.steer(`tool:${kind}:steer`, { childSessionId: run.childSessionId, prompt: STEER, mode: 'queue' }), { code: 'steerEvent' })
  }
  await setCurrent(service, null)
  await service.state.transition(run.id, ['admitted'], { status: 'dispatched', providerSessionId: '5', generation: 'g' })
  await service.state.transition(run.id, ['dispatched'], { status: 'interrupted' })
  const continued = Object.values((await service.state.snapshot()).runs).find(item => item.resumeOf === run.id)
  assert.equal(continued.prompt, message('child.continue.pi'))
  assert.doesNotMatch(continued.prompt, /git/)
})

// A state directory of the release v0.2.0 opens with this code. `fixtures/v0.2.0/generate.mjs` made the fixture with
// the code of v0.2.0, and it tells how to make the fixture again.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpBridge, taskRows } from '../src/AcpBridge.mjs'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { ChildSlot } from '../src/ChildSlot.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { assertSupportedState } from '../src/MegachatHome.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { PiRunService } from '../src/PiRunService.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { EARLY_WORD, FILES, MODEL, replaceText, WORKSPACE } from './fixtures/v0.2.0/generate.mjs'

const ONBOARDING = /The setup of Megachat is pending\./
/** The keys of the log lines about a failure. A start of the new code on an old state must write none of them. */
const FAILURES = ['log.daemon', 'log.storage', 'log.report', 'log.child', 'log.children', 'log.request', 'log.event',
  'log.keepalive.failed', 'log.settings.unreadable', 'log.settings.failed', 'log.sessions', 'log.sessions.file',
  'log.central.main', 'log.central.claude', 'log.running', 'error.event', 'error.search']
const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
const call = (...calls) => fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: 'toolUse' })
const text = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const until = async (state, select) => {
  const value = await waitForState(state, select, { timeoutMs: 20000 })
  assert.notEqual(value, null, 'The state did not reach the expected value in 20 seconds')
  return value
}

/** The sections and the tools of a request. Pi Durable sends a change of them in a later system message. */
function prompt(messages) {
  const sections = new Map()
  const tools = new Map()
  for (const item of messages) {
    if (item.role !== 'system') continue
    for (const [key, value] of Object.entries(item.sections ?? {})) value === null ? sections.delete(key) : sections.set(key, value)
    // A message that changes a tool removes the old definition and adds the new one, so the removal comes first.
    for (const tool of item.toolsRemoved ?? []) tools.delete(tool.name ?? tool)
    for (const tool of item.toolsAdded ?? []) tools.set(tool.name, tool)
  }
  return { sections, tools: [...tools.keys()] }
}

/** The tool results at the end of a request, by the name of the tool. */
function results(request) {
  const found = {}
  for (let index = request.messages.length - 1; request.messages[index]?.role === 'toolResult'; index--) {
    const item = request.messages[index]
    found[item.toolName] = item.isError ? { error: text(item.content) } : JSON.parse(text(item.content))
  }
  return found
}

/**
 * The model of the fixture. A request with the tool `read` is a request of a pi child, and it gets the next reply of
 * `child`. Another request gets the next reply of `turns` for the last message of the user in the request, so an
 * automatic turn cannot take the replies of a turn of the user. A reply can be a function of the request.
 */
function fakeModels() {
  const fake = fauxProvider({ models: [{ id: MODEL.modelId, cost: zero }] })
  const requests = []
  const turns = new Map()
  const child = []
  fake.setResponses(Array(400).fill(request => {
    const { sections, tools } = prompt(request.messages)
    const isChild = tools.includes('read')
    const user = text(request.messages.findLast(item => item.role === 'user')?.content ?? '')
    requests.push({ child: isChild, tools, sections, user })
    const reply = (isChild ? child : turns.get(user) ?? []).shift() ?? fauxAssistantMessage(isChild ? 'Child answer.' : 'Answer.')
    return typeof reply === 'function' ? reply(request) : reply
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  return { models, requests, turns, child }
}

/** Copies the fixture [variant] to a new directory, and gives it a new workspace in the place of WORKSPACE. */
async function copyFixture(t, variant) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-upgrade-')))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 5 }))
  const directories = { state: join(root, 'state'), workspace: join(root, 'workspace'), home: join(root, 'home') }
  for (const directory of Object.values(directories)) await mkdir(directory, { mode: 0o700 })
  for (const name of FILES) {
    const packed = await readFile(new URL(`./fixtures/v0.2.0/${variant}/${name}.gz`, import.meta.url))
    await writeFile(join(directories.state, name), gunzipSync(packed), { mode: 0o600 })
  }
  replaceText(join(directories.state, 'conversation.sqlite'), WORKSPACE, directories.workspace)
  await writeFile(join(directories.workspace, 'README.md'), 'Hello from the README of the workspace.\n')
  await writeFile(join(directories.workspace, 'notes.md'), '# Notes\n\nThe parser reads one line at a time.\n')
  return directories
}

/** Opens the state as the daemon opens it, with the fake model and the fake agent. Gives the parts and a stop. */
async function open(directories) {
  const { state: directory, home } = directories
  assertSupportedState(join(directory, 'conversation.sqlite'))
  const fake = fakeModels()
  const service = await PiMegachatService.open(await openNodeSqliteStorage(join(directory, 'conversation.sqlite')), fake.models, MODEL, {}, {
    searchPath: join(directory, 'search.sqlite'), sessionsPath: join(directory, 'sessions.sqlite'),
    userInstructionsPath: join(directory, 'instructions.md'), settingsPath: join(directory, 'settings.json'),
    workspacePath: join(directory, 'workspace'), stateDirectory: directory, spendPath: join(directory, 'spend.json'), home,
    environment: {}, keepAlive: { enabled: false }, resumeDelayMs: 20, reportRetryDelayMs: 20,
  })
  const start = async () => {
    const server = new DaemonServer(service)
    const daemon = new DaemonClient(await server.listen())
    const slot = new ChildSlot()
    const pi = new PiRunService(service.state, service.harness, { agent: cwd => service.childAgent(cwd), slot })
    await pi.start()
    const children = new AcpRunService(service.state, { childLaunch: async () => ({ env: process.env }) }, {
      args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], historyServer: server.historyConfiguration(),
      childRules: () => service.childRules(), slot,
    })
    await children.start()
    await service.resume()
    let stopping
    const stop = () => stopping ??= (async () => { await server.close(); await children.close(); await pi.close(); await service.close() })()
    return { daemon, stop }
  }
  return { ...fake, service, start }
}

/** A turn of the user. Gives the record of its input after the end of the turn. */
async function say(service, turns, requestId, content, replies = []) {
  turns.set(content, replies)
  await service.submit(requestId, content)
  return until(service.state, state => state.inputs[requestId]?.status !== 'running' && !state.current ? state.inputs[requestId] : undefined)
}

const finished = state => !state.current && Object.values(state.runs).every(run => terminalStates.has(run.status) && run.reported)
  ? state : undefined
const reportsOf = (state, runId) => Object.values(state.inputs).filter(input => input.resultRunIds?.includes(runId))

/** Records the standard error, where the daemon writes its log. */
function recordLog(t) {
  const lines = []
  const write = process.stderr.write
  process.stderr.write = function (chunk, ...rest) {
    lines.push(String(chunk))
    return write.call(this, chunk, ...rest)
  }
  t.after(() => { process.stderr.write = write })
  return () => {
    const log = lines.join('')
    return FAILURES.filter(key => log.includes(message(key).split('{')[0].trim()))
  }
}

/** Opens [variant] of the fixture with the new code and uses each part that the new code added to the state. */
async function upgrade(t, variant) {
  const failures = recordLog(t)
  const directories = await copyFixture(t, variant)
  const { workspace, home } = directories
  const searchMeta = () => {
    const database = new DatabaseSync(join(directories.state, 'search.sqlite'), { readOnly: true })
    try { return database.prepare('SELECT version, last_entry_id FROM meta').get() }
    finally { database.close() }
  }
  const indexed = searchMeta()
  assert.ok(indexed.last_entry_id > 0)

  const first = await open(directories)
  const { service } = first
  const recovered = await service.state.snapshot()
  const runs = Object.values(recovered.runs)
  const task = title => runs.find(run => run.title === title && !run.resumeOf)
  const continuation = run => recovered.runs[run.resumedBy]

  // The fields that the new code added get their defaults, and the old records stay.
  assert.equal(recovered.schema, 1)
  assert.deepEqual(recovered.workspaces, [workspace])
  assert.deepEqual(recovered.projects, [])
  assert.deepEqual(recovered.projectCreations, {})
  assert.deepEqual(recovered.sessionIndex, { task: null, summary: null })
  assert.equal(recovered.megachatWorkspace, await realpath(join(directories.state, 'workspace')))
  assert.equal(recovered.initiative.suggestion, 'Add a test for the parser.')
  assert.ok(recovered.initiative.projects[workspace])
  assert.ok(Object.values(recovered.serviceSessions).some(session => session.providerSessionId === 'fake-session' && session.cwd === workspace))
  assert.ok(runs.every(run => !('updates' in run) && !('updateBytes' in run)))
  const summary = task('Notes summary')
  assert.deepEqual([summary.status, summary.reported, summary.providerSessionId, summary.output], ['completed', true, 'fake-session', 'Summarize notes.md\n'])
  const count = task('Word count')
  assert.deepEqual([count.status, count.reported, count.reportRepeated], ['completed', false, true])
  assert.ok(count.reportAfter < Date.now())
  // The run that waited for a permission continues in its provider session, and the permission cannot be answered.
  const changelog = task('Changelog')
  assert.equal(changelog.status, 'resumed')
  assert.deepEqual([continuation(changelog).status, continuation(changelog).prompt, continuation(changelog).providerSessionId],
    ['admitted', message('child.continue'), 'fake-session'])
  assert.deepEqual(Object.values(recovered.permissions).map(item => [item.runId, item.status]), [[changelog.id, 'stale']])
  const steered = task('Steer test')
  assert.equal(steered.status, 'admitted')
  const links = task('Link check')
  if (variant === 'kill') {
    // The new code made the continuations, so they quote the task. A dispatched run continues in its provider session.
    assert.equal(continuation(changelog).task, 'approval')
    assert.equal(links.status, 'resumed')
    assert.deepEqual([continuation(links).prompt, continuation(links).task, continuation(links).providerSessionId],
      [message('child.continue'), 'Check the links in notes.md', 'link-session'])
    assert.equal(recovered.current, null)
  }
  else {
    // The stop of v0.2.0 made the continuation, and its report turn ran at the stop.
    assert.equal(continuation(changelog).task, undefined)
    assert.equal(links.status, 'admitted')
    assert.equal(recovered.current.kind, 'report')
  }
  assert.ok(taskRows(recovered).size >= 2)
  // Pi Durable of v0.2.0 replaced the older turns with a summary.
  const { items } = await service.root.entries({ order: 'ascending' }, 500, undefined, BACKGROUND_CONTEXT)
  assert.equal(items.filter(entry => entry.head !== undefined).length, 1)
  // The open does not make the search index again.
  assert.equal(await service.search.lastEntryId(), indexed.last_entry_id)

  const started = await first.start()
  t.after(() => started.stop())
  // The chat of the IDE loads the old conversation.
  const updates = []
  const connection = client({ name: 'test-air' }).onNotification('*', ({ params }) => { updates.push(params) })
    .onRequest(methods.client.session.requestPermission, () => new Promise(() => {})).connect(new AcpBridge(started.daemon).app())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  await connection.agent.request(methods.agent.session.load, { cwd: workspace, mcpServers: [], sessionId: 'megachat' })
  assert.ok(JSON.stringify(updates).includes('I started two tasks.'))
  connection.close()

  // The report that waited goes out, and the queued task starts.
  await until(service.state, state => state.runs[count.id].reported && !state.current ? state : undefined)
  await until(service.state, state => state.runs[steered.id].status === 'dispatched' ? state : undefined)
  while (!(await readFile(join(workspace, 'dispatches'), 'utf8').catch(() => '')).split('\n').includes('steer'))
    await new Promise(resolve => setTimeout(resolve, 10))

  // A turn of the user gets the new tools and the section `settings` with the offer of the setup, and it uses the
  // fields that the old state did not have.
  const tools = {}
  const work = 'Add a name to the steer test, and make a project demo.'
  await say(service, first.turns, 'upgrade-1', work, [
    call(['agents_steer', { childSessionId: steered.childSessionId, prompt: 'Name the test upgrade.' }],
      ['agents_settings', { action: 'get' }], ['agents_projects', { action: 'create', name: 'demo' }]),
    request => {
      Object.assign(tools, results(request))
      return call(['agents_settings', { action: 'set', key: 'reply.length', value: 'detailed' }])
    },
    request => {
      tools.set = results(request).agents_settings
      return fauxAssistantMessage('Done.')
    },
  ])
  const request = first.requests.find(item => item.user === work)
  for (const name of ['agents_settings', 'agents_projects', 'agents_steer', 'agents_spawn', 'agents_running', 'agents_accounts', 'agents_history'])
    assert.ok(request.tools.includes(name), `${name} ${request.tools}`)
  assert.match(request.sections.get('settings'), ONBOARDING)
  assert.equal(tools.agents_steer.outcome, 'injected')
  assert.equal(tools.agents_settings.onboarding, 'pending')
  assert.ok(tools.agents_settings.settings.some(entry => entry.key === 'reply.length'))
  assert.equal(tools.set.value, 'detailed')
  assert.equal(tools.agents_projects.created, join(home, 'src', 'demo'))
  let state = await service.state.snapshot()
  assert.deepEqual(state.projects, [join(home, 'src', 'demo')])
  assert.equal(Object.values(state.projectCreations)[0].cwd, join(home, 'src', 'demo'))
  assert.deepEqual(state.runs[steered.id].steers.map(item => [item.text, item.delivery]), [['Name the test upgrade.', 'delivered']])

  // Each old task ends with a report.
  state = await until(service.state, finished)
  assert.equal(state.runs[steered.id].status, 'completed')
  assert.match(state.runs[steered.id].output, /steered: /)
  for (const run of [changelog, links]) {
    let last = state.runs[run.id]
    while (last.resumedBy) last = state.runs[last.resumedBy]
    assert.equal(last.status, 'completed', run.title)
  }
  // v0.2.0 kept the report that failed on the model error. The repeat is one more report, and the last one.
  assert.deepEqual(reportsOf(recovered, count.id).map(input => [input.status, input.reason]), [['interrupted', 'model_error']])
  assert.deepEqual(reportsOf(state, count.id).map(input => input.status), ['interrupted', 'completed'])
  assert.equal(reportsOf(state, summary.id).length, 1)

  // A pi child reads the workspace to its end. The old root conversation gets no tool of a pi child, and the child gets
  // no tool of the main agent.
  first.child.push(call(['read', { path: 'README.md' }]), fauxAssistantMessage('The README greets.'))
  await say(service, first.turns, 'upgrade-2', 'Read the README with pi.', [
    call(['agents_spawn', { cwd: workspace, agent: 'pi', prompt: 'Summarize the README.', title: 'README summary' }]),
    fauxAssistantMessage('Started.'),
  ])
  state = await until(service.state, finished)
  const reader = Object.values(state.runs).find(run => run.agent === 'pi')
  assert.deepEqual([reader.status, reader.output], ['completed', 'The README greets.'])
  const childRequests = first.requests.filter(item => item.child)
  assert.ok(childRequests.length >= 2)
  assert.ok(childRequests.every(item => !item.tools.some(name => name.startsWith('agents_'))))
  assert.ok(first.requests.filter(item => !item.child).every(item => !item.tools.includes('read')))

  // The summary of the first pass of the session index starts its event turn.
  await service.state.sessionsIndexed({ passId: 'pass-1', sessions: 2, projects: 1, entries: 12, agents: { claude: 1, codex: 1, pi: 0 }, unfinished: [] })
  state = await until(service.state, value => !value.current && Object.entries(value.inputs)
    .some(([key, input]) => key.startsWith('sessions:') && input.status === 'completed') ? value : undefined)
  assert.equal(state.sessionIndex.summary, null)

  // The old search index finds a turn that the summary of v0.2.0 replaced in the model context.
  const found = await service.history({ query: EARLY_WORD })
  assert.ok(found.hits.some(hit => hit.role === 'user' && hit.snippet.includes(EARLY_WORD)))
  assert.ok(found.indexedThroughEntryId > indexed.last_entry_id)
  const page = await service.history({})
  assert.ok(page.entries.length > 0)
  assert.equal((await service.state.readRun(summary.id)).output, 'Summarize notes.md\n')
  await started.stop()

  // A second start of the new code opens the state that it wrote.
  const second = await open(directories)
  const reopened = await second.service.state.snapshot()
  assert.deepEqual(Object.keys(reopened.runs).sort(), Object.keys(state.runs).sort())
  assert.deepEqual(reopened.projects, [join(home, 'src', 'demo')])
  const again = await second.start()
  t.after(() => again.stop())
  const hello = await say(second.service, second.turns, 'upgrade-3', 'Hello again.', [fauxAssistantMessage('Hello.')])
  assert.equal(hello.status, 'completed')
  const last = second.requests.find(item => item.user === 'Hello again.')
  assert.ok(last.sections.get('settings').includes(message('instructions.length.detailed')))
  state = await second.service.state.snapshot()
  assert.equal(Object.values(state.inputs).filter(input => input.resultRunIds).length,
    Object.values(reopened.inputs).filter(input => input.resultRunIds).length)
  assert.deepEqual(failures(), [])
}

test('a state that v0.2.0 left at a stop opens with this code, and each old record and each new part works', { timeout: 60000 }, async t => {
  await upgrade(t, 'close')
})

test('a state that v0.2.0 left at a kill opens with this code, and the dispatched runs and the pending permission recover', { timeout: 60000 }, async t => {
  await upgrade(t, 'kill')
})

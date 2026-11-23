import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { defaultStateDirectory, PROJECT_VARIABLE, projectStateDirectory, readProjectRecord, resolveProject } from '../src/MegachatHome.mjs'
import { startOnboardingNote } from '../src/MegachatOnboarding.mjs'
import { MegachatError } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { SETTINGS } from '../src/Settings.mjs'
import { NOTE_KIND } from '../src/SessionNotes.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { stopDaemon } from './stop-daemon.mjs'

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url))
const mode = async path => (await stat(path)).mode & 0o777

// The timers of the daemon are unref'd. Node.js 22 fails a test that waits for them while nothing else holds the event
// loop, so this file holds the loop until its last test ends.
const hold = setInterval(() => {}, 1000)
after(() => clearInterval(hold))

/**
 * A temporary tree: a home directory, the state directory of the machine scope, and the directories `app` and `other`
 * out of the home directory. `after` runs before the removal, for the stop of a daemon.
 */
async function tree(t, name = 'app') {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-scope-')))
  const home = join(root, 'home')
  const state = join(root, 'state')
  const app = join(root, 'work', name)
  const other = join(root, 'work', 'other')
  for (const directory of [home, state, app, other]) await mkdir(directory, { recursive: true })
  const stops = []
  t.after(async () => {
    try { for (const directory of stops) await stopDaemon(directory) }
    finally { await rm(root, { force: true, recursive: true }) }
  })
  return { root, home, state, app, other, stops }
}

/** Runs a command of `src/main.mjs` with [env] over the environment of the test, and gives its exit code and output. */
function run(args, env) {
  const child = spawn(process.execPath, [main, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return once(child, 'exit').then(([code]) => ({ code, stdout, stderr }))
}

/** The client of the daemon of the state directory [directory], with its `/health`. */
async function daemonOf(directory) {
  const client = await DaemonClient.connect(directory)
  client.health = await client.json('/health')
  return client
}

/** Sends `initialize` to a new `acp` process with [env], and gives the capabilities of Megachat in the answer. */
async function capabilities(t, args, env) {
  const bridge = spawn(process.execPath, [main, 'acp', ...args], { env: { ...process.env, ...env } })
  t.after(() => bridge.kill())
  let output = ''
  let errors = ''
  bridge.stdout.on('data', chunk => { output += chunk })
  bridge.stderr.on('data', chunk => { errors += chunk })
  const exited = once(bridge, 'exit')
  bridge.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } } } })}\n`)
  const [code] = await exited
  assert.equal(code, 0, errors)
  return JSON.parse(output).result._meta.jetbrains.air.capabilities
}

/** The text of each system section and of the instructions that a model request holds. */
const requestText = context => JSON.stringify(context)

/**
 * A service in this process. With [project], it has the project scope of that directory, and its state directory is
 * the directory of that project in `directories.state`. `tool` calls a tool of the main agent, and `requests` holds
 * each model request as text.
 */
async function open(t, directories, { project, storage = new MemoryStorage(), options = {} } = {}) {
  const fake = fauxProvider()
  const requests = []
  fake.setResponses(Array(50).fill(async context => { requests.push(requestText(context)); return fauxAssistantMessage('Answer.') }))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const stateDirectory = project ? projectStateDirectory(directories.state, project) : directories.state
  await mkdir(stateDirectory, { recursive: true })
  const service = await PiMegachatService.open(storage, models, { provider: model.provider, modelId: model.id }, {}, {
    workspacePath: join(stateDirectory, 'workspace'), stateDirectory, settingsPath: join(stateDirectory, 'settings.json'), home: directories.home,
    projectRoots: [], keepAlive: { enabled: false }, environment: {}, project, ...options,
  })
  await service.resume()
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  let closed
  const close = () => closed ??= server.close().then(() => service.close())
  t.after(close)
  const tool = async (name, args = {}, api = { taskId: 'task' }) =>
    JSON.parse((await service.extension().tools.find(item => item.name === `agents_${name}`).execute(args, api)).output[0].text)
  const say = async (id, content) => {
    const receipt = await service.submit(id, content)
    await daemon.json(`/wait?submission=${receipt.submissionId}`)
    await waitForState(service.state, state => state.current === null ? true : undefined)
  }
  // The rules of the section `settings` that the next request gets.
  const settingsRules = async () => (await service.root.agent(BACKGROUND_CONTEXT)).sections.find(section => section.key === 'settings').render()
  return { service, daemon, stateDirectory, requests, tool, say, settingsRules, close }
}

const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgsign=false', ...args],
  { cwd, stdio: ['ignore', 'pipe', 'pipe'] })

/** Makes [directory] a git repository with one commit, and a linked worktree of it at [worktree]. */
function repositoryWithWorktree(directory, worktree) {
  git(directory, 'init', '--quiet')
  git(directory, 'commit', '--quiet', '--allow-empty', '-m', 'Start')
  git(directory, 'worktree', 'add', '--quiet', '--detach', worktree)
}

test('the state directory of a project scope has the name and a digest of the project directory', () => {
  assert.equal(projectStateDirectory('/tmp/x', '/work/My App', 'linux'), '/tmp/x/projects/My_App-ed3ef1005942')
  assert.equal(projectStateDirectory('/tmp/x', '/work/app', 'linux'), '/tmp/x/projects/app-70467eff2e0a')
  const second = projectStateDirectory('/tmp/x', '/other/app', 'linux')
  assert.match(second, /^\/tmp\/x\/projects\/app-[0-9a-f]{12}$/)
  assert.notEqual(second, '/tmp/x/projects/app-70467eff2e0a')
  // The name has at most 40 characters.
  assert.match(projectStateDirectory('/tmp/x', `/work/${'n'.repeat(60)}`, 'linux'), /^\/tmp\/x\/projects\/n{40}-[0-9a-f]{12}$/)
})

test('without the variable the scope is the machine scope, and the variable gives the real path of the project', async t => {
  assert.equal(defaultStateDirectory({ platform: 'linux', env: { MEGACHAT_HOME: '/tmp/x' }, homedir: () => '/home/me' }), '/tmp/x')
  assert.equal(defaultStateDirectory({ platform: 'linux', env: { MEGACHAT_HOME: '/tmp/x', MEGACHAT_PROJECT: '' }, homedir: () => '/home/me' }), '/tmp/x')
  const directories = await tree(t)
  await symlink(directories.app, join(directories.root, 'link'))
  assert.equal(await resolveProject(join(directories.root, 'link'), { home: directories.home, stateDirectory: directories.state }), directories.app)
  // The test guard keeps the scope of the shell out of each test.
  assert.equal(process.env[PROJECT_VARIABLE], undefined)
})

test('a value that names no project directory ends start with the code 1, and nothing starts', { timeout: 30000 }, async t => {
  const directories = await tree(t)
  directories.stops.push(directories.state)
  const file = join(directories.root, 'file')
  await writeFile(file, 'x')
  const env = { MEGACHAT_HOME: directories.state, HOME: directories.home }
  for (const value of ['src/app', file, join(directories.root, 'missing'), directories.home, directories.state]) {
    const result = await run(['start'], { ...env, MEGACHAT_PROJECT: value })
    assert.equal(result.code, 1, value)
    assert.ok(result.stderr.includes(value), result.stderr)
    assert.match(result.stderr, /^MEGACHAT_PROJECT names no project directory: /)
    assert.equal(result.stderr.trimEnd().split('\n').length, 1, result.stderr)
  }
  assert.equal(existsSync(join(directories.state, 'projects')), false)
  assert.equal(existsSync(join(directories.state, 'daemon')), false)
  // The other commands that open the state refuse the value too.
  for (const command of ['status', 'stop', 'compact', 'daemon', 'acp']) {
    const result = await run([command], { ...env, MEGACHAT_PROJECT: 'src/app' })
    assert.equal(result.code, 1, command)
    assert.match(result.stderr, /^MEGACHAT_PROJECT names no project directory: src\/app\./, command)
  }
  for (const value of ['src/app', file, directories.home, directories.state]) {
    await assert.rejects(resolveProject(value, { home: directories.home, stateDirectory: directories.state }), { code: 'project' })
  }
})

test('the machine scope and a project scope have two daemons, two state directories and two conversations', { timeout: 60000 }, async t => {
  const directories = await tree(t)
  const projectState = projectStateDirectory(directories.state, directories.app)
  directories.stops.push(directories.state, projectState)
  await writeFile(join(directories.state, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', defaults: 2, values: {} }), { mode: 0o600 })
  await writeFile(join(directories.state, 'memory.md'), '- The user likes short answers.\n', { mode: 0o600 })
  const env = { MEGACHAT_HOME: directories.state, HOME: directories.home }
  // An empty value is no value: the daemon has the machine scope.
  assert.equal((await run(['start'], { ...env, MEGACHAT_PROJECT: '' })).code, 0)
  assert.equal(existsSync(join(directories.state, 'project.json')), false)
  assert.equal(existsSync(join(directories.state, 'projects')), false)
  const machine = await daemonOf(directories.state)
  assert.equal((await machine.json('/state')).projectDirectory, null)

  const started = await run(['start'], { ...env, MEGACHAT_PROJECT: directories.app })
  assert.equal(started.code, 0, started.stderr)
  const project = await daemonOf(projectState)
  assert.notEqual(project.health.pid, machine.health.pid)
  // The record names the project, and the directories are private.
  assert.equal(await readFile(join(projectState, 'project.json'), 'utf8'), `${JSON.stringify({ schema: 1, directory: directories.app })}\n`)
  if (process.platform !== 'win32') {
    assert.equal(await mode(join(projectState, 'project.json')), 0o600)
    assert.equal(await mode(join(directories.state, 'projects')), 0o700)
    assert.equal(await mode(projectState), 0o700)
  }
  // The state of the project scope comes only from its own directory.
  assert.equal(existsSync(join(projectState, 'settings.json')), false)
  assert.equal(existsSync(join(projectState, 'memory.md')), false)
  const projectDocument = await waitForOffer(project)
  assert.equal(projectDocument.projectDirectory, directories.app)
  assert.equal(projectDocument.megachatWorkspace, null)
  assert.match(JSON.stringify(await project.json('/conversation')), /Welcome to Megachat for the project app\./)
  // The machine scope has the onboarding `done`, so it gets no setup note, and it does not see the note of the project.
  assert.equal((await machine.json('/state')).onboardingOffer, null)
  assert.doesNotMatch(JSON.stringify(await machine.json('/conversation')), /Welcome to Megachat/)
  // `status` and `stop` with the variable reach the daemon of the project.
  const status = await run(['status'], { ...env, MEGACHAT_PROJECT: directories.app })
  assert.equal(status.code, 0, status.stderr)
  assert.equal(JSON.parse(status.stdout).running, true)

  // A client can tell the scope from the capabilities of `initialize`.
  const projectCapabilities = await capabilities(t, [], { ...env, MEGACHAT_PROJECT: directories.app })
  assert.ok(projectCapabilities.includes('projectScope'), projectCapabilities.join())
  assert.ok(projectCapabilities.includes('agentStop'))
  const machineCapabilities = await capabilities(t, [], env)
  assert.equal(machineCapabilities.includes('projectScope'), false)
  assert.ok(machineCapabilities.includes('agentStop'))
  assert.equal((await daemonOf(directories.state)).health.pid, machine.health.pid)
  assert.equal((await daemonOf(projectState)).health.pid, project.health.pid)
})

/** Waits until the daemon of [client] wrote its setup note, and gives its state. */
async function waitForOffer(client) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const state = await client.json('/state')
    if (state.onboardingOffer === 'offered') return state
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  assert.fail('The daemon wrote no setup note')
}

test('the command argument gives the state directory, and project.json keeps the scope of that directory', { timeout: 60000 }, async t => {
  const directories = await tree(t)
  const explicit = join(directories.root, 'explicit')
  directories.stops.push(explicit)
  const env = { MEGACHAT_HOME: directories.state, HOME: directories.home }
  const started = await run(['start', explicit], { ...env, MEGACHAT_PROJECT: directories.app })
  assert.equal(started.code, 0, started.stderr)
  assert.equal(await readProjectRecord(explicit), directories.app)
  assert.equal(existsSync(join(directories.state, 'projects')), false)
  assert.equal((await (await daemonOf(explicit)).json('/state')).projectDirectory, directories.app)
  // The state directory of one project does not open for another project.
  const record = await readFile(join(explicit, 'project.json'), 'utf8')
  const refused = await run(['start', explicit], { ...env, MEGACHAT_PROJECT: directories.other })
  assert.equal(refused.code, 1)
  assert.match(refused.stderr, /belongs to another project/)
  assert.ok(refused.stderr.includes(directories.app), refused.stderr)
  assert.equal(await readFile(join(explicit, 'project.json'), 'utf8'), record)
  // Without the variable, a new daemon takes the scope of the file.
  await stopDaemon(explicit)
  const again = await run(['start', explicit], { ...env, MEGACHAT_PROJECT: '' })
  assert.equal(again.code, 0, again.stderr)
  assert.equal((await (await daemonOf(explicit)).json('/state')).projectDirectory, directories.app)
})

test('a project scope lists only its project, the directories in it and its linked worktrees', { timeout: 30000 }, async t => {
  const directories = await tree(t)
  const worktree = join(directories.root, 'work', 'app-wt')
  const otherWorktree = join(directories.root, 'work', 'other-wt')
  repositoryWithWorktree(directories.app, worktree)
  repositoryWithWorktree(directories.other, otherWorktree)
  await mkdir(join(directories.app, 'server'))
  const { service, daemon, stateDirectory, tool } = await open(t, directories, { project: directories.app })
  // The start: one directory with the origin `project`, and no workspace of Megachat.
  assert.deepEqual((await tool('list')).workspaces, [{ cwd: directories.app, origin: 'project', defaultAgent: 'claude' }])
  assert.equal((await service.state.snapshot()).megachatWorkspace, null)
  // A client registers directories, as the bridge does for `session/new` and `_workspaces/list`.
  for (const cwd of [directories.app, join(directories.app, 'server'), worktree]) assert.deepEqual(await daemon.json('/workspace', { cwd }), { cwd })
  for (const cwd of [directories.other, otherWorktree, directories.home]) await assert.rejects(daemon.json('/workspace', { cwd }), MegachatError)
  await assert.rejects(service.state.addWorkspace(directories.other), { code: 'workspace' })
  const listed = (await tool('list')).workspaces
  assert.deepEqual(listed.map(item => [item.cwd, item.origin]),
    [[directories.app, 'project'], [worktree, 'ide'], [join(directories.app, 'server'), 'ide']])
  assert.equal(listed[1].worktreeOf, directories.app)
  assert.deepEqual(listed[0].worktrees, [worktree])
  // A task, a session search and a task in the workspace of this state directory are out of the scope.
  await assert.rejects(tool('spawn', { cwd: directories.other, prompt: 'Work' }), { code: 'workspace' })
  await assert.rejects(tool('spawn', { cwd: join(stateDirectory, 'workspace'), prompt: 'Work' }), { code: 'workspace' })
  await assert.rejects(tool('sessions', { cwd: directories.other }), { code: 'workspace' })
  assert.deepEqual((await service.state.snapshot()).runs, {})
})

test('a project scope does not change the list of the directories', { timeout: 30000 }, async t => {
  const directories = await tree(t)
  const repository = join(directories.home, 'src', 'repository')
  await mkdir(join(repository, '.git'), { recursive: true })
  const { service, tool } = await open(t, directories, { project: directories.app })
  await assert.rejects(tool('projects', { action: 'add', cwd: repository }), { code: 'projectScope' })
  await assert.rejects(tool('projects', { action: 'add', cwds: [repository] }), { code: 'projectScope' })
  await assert.rejects(tool('projects', { action: 'remove', cwd: directories.app }), { code: 'projectScope' })
  await assert.rejects(tool('projects', { action: 'discover' }), { code: 'projectScope' })
  await assert.rejects(tool('projects', { action: 'create', name: 'new-project' }), { code: 'projectScope' })
  assert.equal(existsSync(join(directories.home, 'src', 'new-project')), false)
  assert.deepEqual((await tool('projects', { action: 'list' })).workspaces.map(item => item.cwd), [directories.app])
  assert.deepEqual((await service.state.snapshot()).projects, [])
  // The machine scope still changes the list.
  const machine = await open(t, directories)
  assert.equal((await machine.tool('projects', { action: 'add', cwd: repository })).added, repository)
})

test('a state of the machine scope that opens with a project scope keeps no directory out of the scope', { timeout: 30000 }, async t => {
  const directories = await tree(t)
  await mkdir(join(directories.home, 'src'))
  const database = join(directories.root, 'conversation.sqlite')
  const machine = await open(t, directories, { storage: await openNodeSqliteStorage(database) })
  await machine.service.state.addWorkspace(directories.other)
  await machine.service.state.addWorkspace(directories.app)
  await machine.service.state.addProject(join(directories.home, 'src'))
  await machine.close()
  const { service, tool } = await open(t, directories, { project: directories.app, storage: await openNodeSqliteStorage(database) })
  assert.deepEqual((await service.state.snapshot()).projects, [])
  assert.deepEqual((await tool('list')).workspaces.map(item => [item.cwd, item.origin]), [[directories.app, 'project']])
})

test('the rules of a project scope follow the bundled rules and hold no path', { timeout: 30000 }, async t => {
  const directories = await tree(t)
  const project = await open(t, directories, { project: directories.app })
  await project.say('first', 'Hello')
  assert.equal(project.requests.length, 1)
  assert.ok(project.requests[0].includes('This Megachat belongs to one project.'))
  assert.ok(project.requests[0].includes('Spawn Megachat'))
  assert.equal(project.requests[0].includes(directories.app), false)
  // The rules of the project scope come after the bundled rules.
  const bundled = (await readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')).trimEnd()
  const rules = (await readFile(new URL('../resources/instructions-project.md', import.meta.url), 'utf8')).trimEnd()
  assert.ok(project.service.agent.instructions.startsWith(`${bundled}\n\n${rules}`))
  assert.doesNotMatch(rules, /\//)
  const machine = await open(t, directories)
  await machine.say('first', 'Hello')
  assert.equal(machine.requests[0].includes('This Megachat belongs to one project.'), false)
})

test('the setup of a project scope asks two questions, and the pending onboarding holds its rules', { timeout: 30000 }, async t => {
  const rules = await readFile(new URL('../resources/instructions-onboarding-project.md', import.meta.url), 'utf8')
  const keys = new Set(SETTINGS.map(setting => setting.key))
  const named = new Set(rules.match(/\b[a-z][A-Za-z]*\.[a-z][A-Za-z]+\b/g).filter(word => keys.has(word)))
  assert.deepEqual([...named].sort(), ['children.agent', 'children.codexModel', 'coordinator.model', 'sessions.index'])
  assert.match(rules, /The setup asks the user two questions/)
  assert.doesNotMatch(rules, /agents_projects|projects\.newRoot|four/)
  assert.match(rules, /ask question 1 in full in the same reply/)
  assert.match(rules, /Do not change coordinator\.model/)
  assert.match(rules, /tell the user that each setting can change later in the chat/)
  assert.match(rules, /^2\. The index of past sessions\.[^\n]*sessions in this project/m)
  // Each rule but the questions 3 and 4 and the count is the rule of the machine scope.
  const machineRules = (await readFile(new URL('../resources/instructions-onboarding.md', import.meta.url), 'utf8')).split('\n')
  const projectRules = rules.split('\n')
  assert.equal(projectRules.length, machineRules.length - 2)
  assert.deepEqual(projectRules.filter(line => !machineRules.includes(line)).map(line => line.slice(0, 20)),
    ['The setup of Megacha', 'In that reply, first', '2. The index of past'])

  const directories = await tree(t)
  const project = await open(t, directories, { project: directories.app })
  assert.equal(existsSync(join(project.stateDirectory, 'settings.json')), false)
  assert.equal((await project.tool('settings', { action: 'get' })).onboarding, 'pending')
  assert.match(await project.settingsRules(), /The setup asks the user two questions/)
  assert.doesNotMatch(await project.settingsRules(), /projects\.newRoot/)
  // A new setup gets the same rules in the result of the tool.
  await project.tool('settings', { action: 'onboarding', status: 'skipped' })
  assert.doesNotMatch(await project.settingsRules(), /The setup asks the user/)
  const again = await project.tool('settings', { action: 'onboarding', status: 'pending' })
  assert.match(again.rules, /The setup asks the user two questions/)
  const machine = await open(t, directories)
  assert.match(await machine.settingsRules(), /The setup asks the user four questions/)
})

test('the setup note of a project scope names the project and offers two questions', { timeout: 30000 }, async t => {
  const directories = await tree(t, 'My App')
  const { service } = await open(t, directories, { project: directories.app })
  const note = startOnboardingNote(service.state, () => service.settings.onboarding === 'pending')
  t.after(() => note.close())
  await note.done
  const notes = (await service.root.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)).items.filter(entry => entry.kind === NOTE_KIND)
  assert.equal(notes.length, 1)
  const text = notes[0].model[0].content[0].text
  assert.ok(text.startsWith('Welcome to Megachat for the project My App. This Megachat works only in that project'), text)
  assert.match(text, /two short questions/)
})

test('a project scope keeps the cloud sessions off', { timeout: 30000 }, async t => {
  const directories = await tree(t)
  const { service, tool } = await open(t, directories, { project: directories.app, options: { cloud: { locate: async () => '/bin/airc', list: async () => [] } } })
  await assert.rejects(tool('settings', { action: 'set', key: 'cloud.sessions', value: 'on' }), { code: 'projectScope' })
  assert.equal(service.settings.values()['cloud.sessions'], 'off')
  assert.equal(service.extension().tools.some(item => item.name === 'agents_cloud'), false)
  // A value of the file has no effect either.
  await writeFile(join(projectStateDirectory(directories.state, directories.app), 'settings.json'),
    JSON.stringify({ schema: 1, onboarding: 'done', defaults: 2, values: { 'cloud.sessions': 'on' } }), { mode: 0o600 })
  const second = await open(t, directories, { project: directories.app, options: { cloud: { locate: async () => '/bin/airc', list: async () => [] } } })
  assert.equal(second.service.settings.values()['cloud.sessions'], 'off')
  assert.equal(second.service.extension().tools.some(item => item.name === 'agents_cloud'), false)
  // The machine scope turns them on.
  const machine = await open(t, directories, { options: { cloud: { locate: async () => '/bin/airc', list: async () => [] } } })
  assert.equal((await machine.tool('settings', { action: 'set', key: 'cloud.sessions', value: 'on' })).value, 'on')
})

// The sessions of the machine in a project scope. The logs are in the temporary home, and the process table is a fake.
const USER = 501
const DAEMON = 900
const LAUNCHER = 800
const HOUR = 3600000
const proc = (pid, ppid, command, { name = command.split(' ', 1)[0].split('/').pop().slice(0, 16) } = {}) =>
  ({ pid, ppid, uid: USER, startedAt: Date.now() - 2 * HOUR + pid * 1000, cpu: 0, name, command })

/** A fake process table: Claude Code in a terminal (10), and two orphans of Claude Code (70 and 71). [cwds] gives the directory of each PID. */
function fakeTable(cwds) {
  const processes = [
    proc(1, 0, '/sbin/launchd'),
    proc(LAUNCHER, 1, '/opt/homebrew/bin/node /Users/user/src/megachat/bin/megachat.mjs', { name: 'node' }),
    proc(DAEMON, LAUNCHER, '/opt/homebrew/bin/node /Users/user/src/megachat/src/main.mjs daemon', { name: 'node' }),
    proc(2, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', { name: 'Terminal' }),
    proc(3, 2, '-zsh', { name: 'zsh' }),
    proc(10, 3, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
    proc(70, 1, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
    proc(71, 1, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
  ]
  return { platform: 'darwin', supported: true, current: processes, async processes() { return processes },
    async resolve(pids) { return new Map(pids.map(pid => [pid, { cwd: cwds[pid] ?? null, files: [] }])) } }
}

const logLines = records => records.map((value, index) => `${JSON.stringify({ timestamp: new Date(Date.now() - HOUR + index * 1000).toISOString(), ...value })}\n`).join('')
/** Writes a Claude Code log of the session [id] in [cwd], with one finished turn. */
async function claudeLog(home, cwd, id) {
  const path = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`)
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, logLines([
    { type: 'user', uuid: `${id}-1`, cwd, sessionId: id, message: { role: 'user', content: `Request of ${id}` } },
    { type: 'assistant', uuid: `${id}-2`, cwd, sessionId: id, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: `Reply of ${id}` }] } },
  ]))
  return path
}
/** Writes a Codex log of the session [id] in [cwd]. With [compressed], the file is the compressed form that the live table does not read. */
async function codexLog(home, cwd, id, { compressed = false } = {}) {
  const path = join(home, '.codex', 'sessions', '2026', '11', '11', `rollout-2026-11-11T11-00-00-${id}.jsonl${compressed ? '.zst' : ''}`)
  await mkdir(join(path, '..'), { recursive: true })
  const text = logLines([
    { type: 'session_meta', payload: { id, cwd, timestamp: new Date(Date.now() - HOUR).toISOString() } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Request of ${id}` }] } },
    { type: 'event_msg', payload: { type: 'task_complete' } },
  ])
  await writeFile(path, compressed ? zstdCompressSync(Buffer.from(text)) : text)
  return path
}

/** A service of the project `app` with the live table of the logs of the temporary home, and the fake process table. */
async function withSessions(t, directories, { machine = false } = {}) {
  const project = machine ? undefined : directories.app
  const signals = []
  const table = fakeTable({ 10: join(directories.app, 'server'), 70: directories.other, 71: directories.app })
  const stateDirectory = project ? projectStateDirectory(directories.state, project) : directories.state
  const opened = await open(t, directories, { project, options: {
    sessionsPath: join(stateDirectory, 'sessions.sqlite'), processTable: table,
    stop: { kill: (pid, signal) => signals.push([pid, signal]), daemonPid: DAEMON, daemonParentPid: LAUNCHER, uid: USER },
  } })
  await opened.service.sessionIndex.idle()
  return { ...opened, signals, table }
}

test('a project scope gives only the running sessions of its directories, and it stops no other session', { timeout: 30000 }, async t => {
  const directories = await tree(t)
  await mkdir(join(directories.app, 'server'))
  const { service, tool, signals, table } = await withSessions(t, directories)
  const running = await tool('running')
  assert.deepEqual(running.sessions.map(row => [row.pid, row.cwd]).sort(), [[10, join(directories.app, 'server')], [71, directories.app]])
  // The notes about the waiting sessions read the same view.
  assert.deepEqual((await service.running.view()).rows.map(row => row.pid).sort(), [10, 71])
  // A stop of the orphan in the other directory is refused as a PID that agents_running does not give, and no signal goes out.
  await service.state.change(state => { state.current = { id: 'turn', requestId: 'turn', cancelling: false, kind: 'user' } })
  const stopped = await service.stopper.call({ pids: [70] })
  assert.equal(stopped.outcome, 'none')
  assert.deepEqual(stopped.refused, [{ pid: 70, reason: 'The PID 70 is no agent session of agents_running now.' }])
  assert.deepEqual(signals, [])
  // The orphan in the project is a target.
  const state = await service.state.snapshot()
  const { targets, refused } = await service.stopper.targets([71, 70], 'SIGTERM', await table.processes(), state)
  assert.deepEqual(targets.map(target => [target.pid, target.cwd]), [[71, directories.app]])
  assert.deepEqual(refused.map(item => item.pid), [70])
  await service.state.change(value => { value.current = null })

  // The machine scope gives each session of the machine.
  const machine = await withSessions(t, directories, { machine: true })
  assert.deepEqual((await machine.tool('running')).sessions.map(row => row.pid).sort(), [10, 70, 71])
})

test('the live table of a project scope holds only the session files of its directories', { timeout: 30000 }, async t => {
  const directories = await tree(t)
  const server = join(directories.app, 'server')
  await mkdir(server)
  const home = directories.home
  const appClaude = await claudeLog(home, directories.app, 'app-claude')
  const serverCodex = await codexLog(home, server, 'server-codex')
  const otherClaude = await claudeLog(home, directories.other, 'other-claude')
  const otherCodex = await codexLog(home, directories.other, 'other-codex')
  const { service, daemon, tool } = await withSessions(t, directories)
  const logs = service.sessionIndex.logs
  assert.deepEqual([...logs.records.keys()].sort(), [appClaude, serverCodex].sort())
  assert.equal(logs.session('claude', 'other-claude'), undefined)
  assert.equal(logs.session('codex', 'other-codex'), undefined)
  // The stored table has no row of the other directory either.
  assert.deepEqual((await service.sessionIndex.store.logs()).map(row => row.path).sort(), [appClaude, serverCodex].sort())
  // A read from the end of a log of the project works, and a session of the other directory does not exist.
  const page = await tool('session_history', { agent: 'claude', sessionId: 'app-claude', order: 'newest' })
  assert.match(JSON.stringify(page), /Reply of app-claude/)
  await assert.rejects(tool('session_history', { agent: 'claude', sessionId: 'other-claude', order: 'newest' }), { code: 'missing' })
  await assert.rejects(tool('session_history', { agent: 'codex', sessionId: 'other-codex', order: 'newest' }), { code: 'missing' })
  // A change of a file of the other directory brings no record.
  logs.changed(otherClaude)
  logs.changed(otherCodex)
  await service.sessionIndex.idle()
  assert.deepEqual([...logs.records.keys()].sort(), [appClaude, serverCodex].sort())
  // An archive of a session of the other directory is refused, also of a compressed Codex file, and the chat shows no dialog.
  await codexLog(home, directories.other, 'other-packed', { compressed: true })
  await service.state.change(state => { state.current = { id: 'turn', requestId: 'turn', cancelling: false, kind: 'user' } })
  const archived = await tool('archive', { action: 'archive', sessions: [{ agent: 'claude', sessionId: 'other-claude' },
    { agent: 'codex', sessionId: 'other-codex' }, { agent: 'codex', sessionId: 'other-packed' }] })
  assert.equal(archived.outcome, 'none')
  assert.deepEqual(archived.refused.map(item => item.sessionId), ['other-claude', 'other-codex', 'other-packed'])
  for (const item of archived.refused) assert.match(item.reason, /is not in the index of the session logs/)
  assert.equal(service.stopper.requests.size, 0)
  await service.state.change(state => { state.current = null })
  // A linked worktree of the project that a client registers comes into the scope with its sessions.
  const worktree = join(directories.root, 'work', 'app-wt')
  repositoryWithWorktree(directories.app, worktree)
  const worktreeClaude = await claudeLog(home, worktree, 'worktree-claude')
  await daemon.json('/workspace', { cwd: worktree })
  await service.sessionIndex.idle()
  await logs.passing
  await service.sessionIndex.idle()
  assert.deepEqual([...logs.records.keys()].sort(), [appClaude, serverCodex, worktreeClaude].sort())

  // The machine scope has each session file of the machine.
  const machine = await withSessions(t, directories, { machine: true })
  assert.equal(machine.service.sessionIndex.logs.session('claude', 'other-claude')?.path, otherClaude)
  assert.equal(machine.service.sessionIndex.logs.session('codex', 'other-codex')?.path, otherCodex)
})

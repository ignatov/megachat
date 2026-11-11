import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { message } from '../src/messages.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { resolveRepository } from '../src/ProjectDirectories.mjs'
import { SessionHistoryService } from '../src/SessionHistoryService.mjs'
import { waitForState } from '../src/waitForState.mjs'

/** A temporary tree: a home directory with one repository, a state directory, and a directory out of the home. */
async function tree(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-projects-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const home = join(root, 'home')
  const repository = join(home, 'src', 'repository')
  const outside = join(root, 'outside')
  const stateDirectory = join(home, '.jetbrains', 'air', 'megachat')
  for (const directory of [repository, outside, stateDirectory]) await mkdir(directory, { recursive: true })
  return { root, home, repository, outside, stateDirectory }
}

async function open(t, directories, storage = new MemoryStorage()) {
  const fake = fauxProvider()
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(storage, models, { provider: model.provider, modelId: model.id }, {}, {
    workspacePath: join(directories.stateDirectory, 'workspace'), stateDirectory: directories.stateDirectory,
    home: directories.home, projectRoots: [], keepAlive: { enabled: false },
  })
  await service.resume()
  let closed
  const close = () => closed ??= service.close()
  t.after(close)
  return { fake, service, close }
}

function toolResults(value, found = []) {
  if (Array.isArray(value)) for (const item of value) toolResults(item, found)
  else if (value && typeof value === 'object') {
    if (value.role === 'toolResult') {
      const text = value.content.filter(block => block.type === 'text').map(block => block.text).join('')
      try { found.push(JSON.parse(text)) }
      catch { found.push(text) }
    }
    else for (const item of Object.values(value)) toolResults(item, found)
  }
  return found
}

/** Runs one turn of the user in which the main agent makes the tool calls. Gives the results of the tools. */
async function turn({ fake, service }, id, ...calls) {
  let results
  fake.setResponses([
    ...calls.map(([name, args]) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })),
    transcript => { results = toolResults(transcript).slice(-calls.length); return fauxAssistantMessage('Done.') },
  ])
  await service.submit(id, 'Work')
  await waitForState(service.state, state => !state.current ? true : undefined)
  return results
}

test('the daemon makes the workspace of Megachat with the mode 0700 and lists it', { timeout: 10000 }, async t => {
  const directories = await tree(t)
  const opened = await open(t, directories)
  const workspace = join(directories.stateDirectory, 'workspace')
  const status = await stat(workspace)
  assert.ok(status.isDirectory())
  if (process.platform !== 'win32') assert.equal(status.mode & 0o777, 0o700)
  const [list] = await turn(opened, 'list', ['agents_list', {}])
  assert.deepEqual(list.workspaces, [{ cwd: workspace, origin: 'megachat', name: 'Megachat workspace' }])
  assert.deepEqual((await opened.service.state.snapshot()).projects, [])
})

test('a child works in a known repository that no IDE has opened', { timeout: 20000 }, async t => {
  const directories = await tree(t)
  const opened = await open(t, directories)
  const children = new AcpRunService(opened.service.state, { childLaunch: async () => ({ env: process.env }) },
    { args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], deadlineMs: 10000 })
  await children.start()
  t.after(() => children.close())
  const [added, spawned] = await turn(opened, 'known',
    ['agents_projects', { action: 'add', cwd: '~/src/repository' }],
    ['agents_spawn', { cwd: '~/src/repository', prompt: 'hello' }])
  assert.equal(added.added, directories.repository)
  assert.equal(spawned.cwd, directories.repository)
  const state = await waitForState(opened.service.state, state =>
    Object.values(state.runs).every(run => terminalStates.has(run.status)) ? state : undefined)
  const [run] = Object.values(state.runs)
  assert.equal(run.status, 'completed')
  assert.equal(run.cwd, directories.repository)
  assert.ok(!state.workspaces.includes(directories.repository))
  // The fake agent writes this file into its working directory.
  assert.equal(await readFile(join(directories.repository, 'dispatches'), 'utf8'), 'hello\n')
})

test('a task in the workspace of Megachat and a refusal of a directory that is not listed', { timeout: 10000 }, async t => {
  const directories = await tree(t)
  const opened = await open(t, directories)
  const [unknown, absent] = await turn(opened, 'unknown',
    ['agents_spawn', { cwd: directories.repository, prompt: 'hello' }],
    ['agents_spawn', { cwd: join(directories.home, 'absent'), prompt: 'hello' }])
  assert.ok(String(unknown).includes(message('error.workspace')))
  assert.ok(String(absent).includes(message('error.workspace')))
  assert.deepEqual((await opened.service.state.snapshot()).runs, {})
  const workspace = join(directories.stateDirectory, 'workspace')
  const [spawned] = await turn(opened, 'scratch', ['agents_spawn', { cwd: workspace, prompt: 'hello' }])
  assert.equal(spawned.cwd, workspace)
  // A removed repository is not listed again.
  const [, removed, refused] = await turn(opened, 'remove',
    ['agents_projects', { action: 'add', cwd: directories.repository }],
    ['agents_projects', { action: 'remove', cwd: '~/src/repository' }],
    ['agents_spawn', { cwd: directories.repository, prompt: 'hello' }])
  assert.equal(removed.removed, directories.repository)
  assert.ok(!removed.workspaces.some(directory => directory.cwd === directories.repository))
  assert.ok(String(refused).includes(message('error.workspace')))
})

test('a known repository is an existing directory in the home directory or in an allowed root', async t => {
  const { home, repository, outside, stateDirectory } = await tree(t)
  const options = { home, roots: [], stateDirectory }
  assert.equal(await resolveRepository(repository, options), repository)
  assert.equal(await resolveRepository('~/src/repository', options), repository)
  await symlink(repository, join(home, 'inner-link'))
  assert.equal(await resolveRepository('~/inner-link', options), repository)
  await symlink(outside, join(home, 'escape'))
  await writeFile(join(home, 'src', 'file.txt'), 'text')
  await mkdir(join(home, 'Library', 'Application Support'), { recursive: true })
  await mkdir(join(home, '.ssh'))
  await mkdir(join(stateDirectory, 'workspace'))
  const refused = ['~/escape', join(home, 'absent'), join(home, 'src', 'file.txt'), outside, '/', '/etc', 'src/repository', '', '~', home,
    '~/Library/Application Support', '~/.ssh', stateDirectory, join(stateDirectory, 'workspace'), join(repository, '..', '..', '..', 'outside')]
  for (const path of refused) await assert.rejects(resolveRepository(path, options), { code: 'directory' }, path)
  await assert.rejects(resolveRepository(42, options), { code: 'directory' })
  // An allowed root admits a directory out of the home directory, and a link from the home directory into the root.
  assert.equal(await resolveRepository(outside, { ...options, roots: [outside] }), outside)
  assert.equal(await resolveRepository('~/escape', { ...options, roots: [outside] }), outside)
})

test('the known list survives a restart, and an automatic turn cannot add a repository', { timeout: 20000 }, async t => {
  const directories = await tree(t)
  const database = join(directories.root, 'conversation.sqlite')
  let opened = await open(t, directories, await openNodeSqliteStorage(database))
  assert.deepEqual(await opened.service.state.addProject('~/src/repository'), { cwd: directories.repository })
  await opened.service.state.addProject(directories.repository)
  await assert.rejects(opened.service.state.addProject(directories.outside), { code: 'directory' })
  await opened.close()
  opened = await open(t, directories, await openNodeSqliteStorage(database))
  const state = opened.service.state
  assert.deepEqual((await state.snapshot()).projects, [directories.repository])
  assert.equal(await state.directory('~/src/repository'), directories.repository)
  await state.addWorkspace(directories.outside)
  await state.projectChanged({ cwd: directories.outside, revision: 'change', paths: ['src/main.kt'] })
  assert.ok(await state.nextProjectEvent())
  await mkdir(join(directories.home, 'other'))
  await assert.rejects(state.addProject('~/other'), { code: 'proposalOnly' })
})

test('a session search accepts a known repository and the workspace, and refuses another directory', { timeout: 10000 }, async t => {
  const { home, repository, outside, stateDirectory } = await tree(t)
  const seen = []
  const provider = { async list(cwd) { seen.push(cwd); return { sessions: [], nextCursor: null } }, close() {} }
  const snapshot = { workspaces: [], projects: [repository], megachatWorkspace: stateDirectory }
  const service = new SessionHistoryService({ home, snapshot: async () => snapshot }, { claude: provider })
  assert.equal((await service.search({ cwd: repository })).pages[0].complete, true)
  await service.search({ cwd: '~/src/repository' })
  await service.search({ cwd: stateDirectory })
  assert.deepEqual(seen, [repository, repository, stateDirectory])
  await assert.rejects(service.search({ cwd: outside }), { code: 'workspace' })
  await assert.rejects(service.read({ cwd: outside, agent: 'claude', sessionId: 'session' }), { code: 'workspace' })
})

test('the list of the directories gives each directory one time with its origin', { timeout: 10000 }, async t => {
  const directories = await tree(t)
  const opened = await open(t, directories)
  await opened.service.state.addWorkspace(directories.outside)
  await opened.service.state.addWorkspace(directories.repository)
  await mkdir(join(directories.home, 'second'))
  const [, , list, projects] = await turn(opened, 'origins',
    ['agents_projects', { action: 'add', cwd: directories.repository }],
    ['agents_projects', { action: 'add', cwd: '~/second' }],
    ['agents_list', {}],
    ['agents_projects', { action: 'list' }])
  const expected = [
    { cwd: join(directories.stateDirectory, 'workspace'), origin: 'megachat', name: 'Megachat workspace' },
    { cwd: directories.outside, origin: 'ide' },
    { cwd: directories.repository, origin: 'ide' },
    { cwd: join(directories.home, 'second'), origin: 'known' },
  ]
  assert.deepEqual(list.workspaces, expected)
  assert.deepEqual(projects.workspaces, expected)
})

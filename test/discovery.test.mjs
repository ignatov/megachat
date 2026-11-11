import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { discoverRepositories } from '../src/ProjectDirectories.mjs'

/** Makes a repository at [path] with a `.git` directory, or a `.git` file as a worktree has, changed at [seconds]. */
async function repository(path, seconds, file = false) {
  await mkdir(path, { recursive: true })
  if (file) await writeFile(join(path, '.git'), 'gitdir: /elsewhere\n')
  else await mkdir(join(path, '.git'))
  await utimes(join(path, '.git'), seconds, seconds)
}

/** A temporary home with repositories at each depth, a hidden directory, a symbolic link, and a root out of the home. */
async function tree(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-discovery-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const home = join(root, 'home')
  const outside = join(root, 'outside')
  const stateDirectory = join(home, '.jetbrains', 'air', 'megachat')
  await mkdir(stateDirectory, { recursive: true })
  await repository(join(home, 'src', 'old'), 1000)
  await repository(join(home, 'src', 'old', 'nested'), 9000)
  await repository(join(home, 'src', 'org', 'worktree'), 5000, true)
  await repository(join(home, 'src', 'org', 'group', 'deep'), 9000)
  await mkdir(join(home, 'src', 'org', 'plain'))
  await repository(join(home, 'src', '.hidden', 'secret'), 9000)
  await repository(join(home, 'IdeaProjects', 'idea'), 3000)
  await repository(join(outside, 'linked'), 9000)
  await symlink(join(outside, 'linked'), join(home, 'src', 'link'))
  await repository(join(outside, 'roots', 'extra'), 4000)
  return { home, outside, stateDirectory, roots: [join(outside, 'roots')] }
}

async function open(t, directories) {
  const fake = fauxProvider()
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {}, {
    workspacePath: join(directories.stateDirectory, 'workspace'), stateDirectory: directories.stateDirectory,
    settingsPath: join(directories.stateDirectory, 'settings.json'),
    home: directories.home, projectRoots: directories.roots, keepAlive: { enabled: false },
  })
  t.after(() => service.close())
  // Each call is a tool task of its own, unless the test gives the task of a call again, as a replay after a restart does.
  const tool = async (name, args, taskId = randomUUID()) => JSON.parse((await service.extension().tools.find(item => item.name === `agents_${name}`)
    .execute(args, { taskId })).output[0].text)
  return { service, tool }
}

test('discover gives the repositories of two levels, the newest first, without the listed ones, links and hidden directories', { timeout: 10000 }, async t => {
  const directories = await tree(t)
  const { home } = directories
  const { tool } = await open(t, directories)
  const found = await tool('projects', { action: 'discover' })
  assert.deepEqual(found.repositories.map(item => item.cwd), [join(home, 'src', 'org', 'worktree'), join(directories.roots[0], 'extra'),
    join(home, 'IdeaProjects', 'idea'), join(home, 'src', 'old')])
  assert.equal(found.repositories[0].changedAt, new Date(5000 * 1000).toISOString())
  assert.equal(found.truncated, false)
  assert.deepEqual(found.roots, [join(home, 'src'), join(home, 'IdeaProjects'), directories.roots[0]])
  // A listed repository is not offered again.
  await tool('projects', { action: 'add', cwd: '~/src/old' })
  const again = await tool('projects', { action: 'discover' })
  assert.ok(!again.repositories.some(item => item.cwd === join(home, 'src', 'old')))
  const limited = await discoverRepositories({ home, roots: [], limit: 1 })
  assert.deepEqual([limited.repositories.map(item => item.cwd), limited.truncated], [[join(home, 'src', 'org', 'worktree')], true])
  // A home without the directories gives an empty result.
  assert.deepEqual(await discoverRepositories({ home: directories.outside, roots: [] }), { repositories: [], truncated: false, roots: [] })
})

test('create makes a new project in projects.newRoot with a number when the name is taken, and refuses a bad name or root', { timeout: 10000 }, async t => {
  const directories = await tree(t)
  const { home, outside } = directories
  const { service, tool } = await open(t, directories)
  const first = await tool('projects', { action: 'create', name: 'app' })
  assert.equal(first.created, join(home, 'src', 'app'))
  assert.ok((await stat(first.created)).isDirectory())
  assert.ok(first.workspaces.some(item => item.cwd === first.created && item.origin === 'known'))
  assert.equal((await tool('projects', { action: 'create', name: 'app' })).created, join(home, 'src', 'app-2'))
  assert.equal((await tool('projects', { action: 'create', name: 'old' })).created, join(home, 'src', 'old-2'))
  for (const name of ['../escape', '.hidden', 'a/b', '', '-flag', 'x'.repeat(101), undefined])
    await assert.rejects(tool('projects', { action: 'create', ...(name === undefined ? {} : { name }) }), { code: 'projectName' }, name)
  // A root that does not exist yet is made.
  await tool('settings', { action: 'set', key: 'projects.newRoot', value: '~/work/new/' })
  assert.equal((await tool('projects', { action: 'create', name: 'tool' })).created, join(home, 'work', 'new', 'tool'))
  // A nested hidden directory in the home directory or in a root is no place for a new project.
  for (const root of [outside, '~/.config/projects', join(directories.stateDirectory, 'projects'), '~/src/.hidden/projects',
    '~/src/.new', join(directories.roots[0], '.cache', 'new')]) {
    await tool('settings', { action: 'set', key: 'projects.newRoot', value: root })
    await assert.rejects(tool('projects', { action: 'create', name: 'refused' }), { code: 'newRoot' }, root)
  }
  assert.deepEqual(await readdir(outside), ['linked', 'roots'])
  assert.deepEqual(await readdir(directories.roots[0]), ['extra'])
  assert.deepEqual(await readdir(join(home, 'src', '.hidden')), ['secret'])
  // A repository that the user names can be in a nested hidden directory.
  assert.ok((await tool('projects', { action: 'add', cwd: '~/src/.hidden/secret' })).workspaces
    .some(item => item.cwd === join(home, 'src', '.hidden', 'secret')))
  await assert.rejects(tool('settings', { action: 'set', key: 'projects.newRoot', value: 'relative/path' }), { code: 'settingValue' })
  // An automatic turn cannot make a project.
  await service.state.change(state => { state.current = { id: 'event', requestId: 'event', cancelling: false, kind: 'event' } })
  await assert.rejects(tool('projects', { action: 'create', name: 'automatic' }), { code: 'proposalOnly' })
  await service.state.change(state => { state.current = null })
  assert.ok(!(await readdir(join(home, 'src'))).includes('automatic'))
})

test('create is idempotent for one tool call: a replay gives the same project, also after a stop between the mkdir and the commit', { timeout: 10000 }, async t => {
  const directories = await tree(t)
  const { home } = directories
  const { service, tool } = await open(t, directories)
  const projects = async () => (await service.state.snapshot()).projects
  const first = await tool('projects', { action: 'create', name: 'app' }, 'call-1')
  assert.equal(first.created, join(home, 'src', 'app'))
  // pi-durable runs the cut-off call again with the same task.
  assert.equal((await tool('projects', { action: 'create', name: 'app' }, 'call-1')).created, join(home, 'src', 'app'))
  assert.deepEqual(await projects(), [join(home, 'src', 'app')])
  assert.ok(!(await readdir(join(home, 'src'))).includes('app-2'))
  // A stop after the mkdir and before the commit leaves an empty directory and its recorded path.
  const web = join(home, 'src', 'web')
  await mkdir(web)
  await service.state.change(state => { state.projectCreations['tool:call-2:create'] = { path: web, createdAt: Date.now() } })
  assert.equal((await tool('projects', { action: 'create', name: 'web' }, 'call-2')).created, web)
  // A stop after the record and before the mkdir leaves only the recorded path.
  const api = join(home, 'src', 'api')
  await service.state.change(state => { state.projectCreations['tool:call-3:create'] = { path: api, createdAt: Date.now() } })
  assert.equal((await tool('projects', { action: 'create', name: 'api' }, 'call-3')).created, api)
  // A recorded directory that is not empty is not the directory of the call, so the call makes another one.
  await writeFile(join(home, 'src', 'old', 'file.txt'), 'data')
  await service.state.change(state => { state.projectCreations['tool:call-4:create'] = { path: join(home, 'src', 'old'), createdAt: Date.now() } })
  assert.equal((await tool('projects', { action: 'create', name: 'old' }, 'call-4')).created, join(home, 'src', 'old-2'))
  assert.deepEqual(await projects(), [join(home, 'src', 'app'), web, api, join(home, 'src', 'old-2')])
  assert.deepEqual((await readdir(join(home, 'src'))).sort(), ['.hidden', 'api', 'app', 'link', 'old', 'old-2', 'org', 'web'])
  // The records of the creations stay bounded.
  await service.state.change(state => {
    for (let index = 0; index < 300; index++) state.projectCreations[`tool:old-${index}:create`] = { path: '/x', cwd: '/x', createdAt: index }
  })
  await tool('projects', { action: 'create', name: 'last' })
  assert.ok(Object.keys((await service.state.snapshot()).projectCreations).length <= 101)
})

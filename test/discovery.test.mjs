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
import { discoverRepositories, mainRepositoryOf } from '../src/ProjectDirectories.mjs'

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

test('discover with a named folder scans only that folder, and add with cwds adds its repositories in one call', { timeout: 10000 }, async t => {
  const directories = await tree(t)
  const { home, outside } = directories
  const dev = join(home, 'dev')
  await repository(join(dev, 'app'), 6000)
  await repository(join(dev, 'group', 'api'), 7000, true)
  await mkdir(join(dev, 'notes'))
  await repository(join(dev, '.hidden', 'secret'), 9000)
  await symlink(join(outside, 'linked'), join(dev, 'link'))
  const { service, tool } = await open(t, directories)
  const found = await tool('projects', { action: 'discover', cwd: '~/dev' })
  assert.deepEqual(found.folder, { cwd: dev, repository: false, listed: false })
  assert.deepEqual(found.repositories.map(item => item.cwd), [join(dev, 'group', 'api'), join(dev, 'app')])
  assert.deepEqual([found.roots, found.truncated], [[dev], false])
  // A folder that is a repository itself gives no scan into it.
  assert.deepEqual(await tool('projects', { action: 'discover', cwd: '~/dev/app' }),
    { folder: { cwd: join(dev, 'app'), repository: true, listed: false }, repositories: [], truncated: false, roots: [] })
  // A directory out of the home directory is a folder too.
  assert.deepEqual((await tool('projects', { action: 'discover', cwd: outside })).repositories.map(item => item.cwd),
    [join(outside, 'linked'), join(directories.roots[0], 'extra')])
  for (const cwd of ['~', home, '/', 'dev', '~/absent', join(home, '.ssh-absent'), directories.stateDirectory])
    await assert.rejects(tool('projects', { action: 'discover', cwd }), { code: 'directory' }, cwd)
  // The repositories and a folder that is no repository go to the list in one call. A refused path does not stop the others.
  const added = await tool('projects', { action: 'add', cwds: [join(dev, 'app'), join(dev, 'group', 'api'), '~/dev/notes', '/', '~/absent', '~/dev/app'] })
  assert.deepEqual(added.added, [join(dev, 'app'), join(dev, 'group', 'api'), join(dev, 'notes')])
  assert.deepEqual(added.refused.map(item => [item.cwd, item.code]), [['/', 'directory'], ['~/absent', 'directory']])
  assert.ok(added.workspaces.some(item => item.cwd === join(dev, 'notes') && item.origin === 'known'))
  assert.deepEqual((await tool('projects', { action: 'discover', cwd: '~/dev' })).repositories, [])
  assert.deepEqual((await tool('projects', { action: 'add', cwds: ['~/dev/app'] })).added, [])
  // MEGACHAT_PROJECT_ROOTS still applies to a discover without a folder.
  assert.ok((await tool('projects', { action: 'discover' })).repositories.some(item => item.cwd === join(directories.roots[0], 'extra')))
  // The list limit refuses the whole call, and an automatic turn cannot add.
  await service.state.change(state => { state.projects.push(...Array.from({ length: 96 }, (_, index) => join(home, 'src', `known-${index}`))) })
  await assert.rejects(tool('projects', { action: 'add', cwds: [join(outside, 'linked'), join(home, 'src', 'old')] }), { code: 'projectLimit' })
  assert.equal((await service.state.snapshot()).projects.length, 99)
  await service.state.change(state => { state.current = { id: 'event', requestId: 'event', cancelling: false, kind: 'event' } })
  await assert.rejects(tool('projects', { action: 'add', cwds: [join(outside, 'linked')] }), { code: 'proposalOnly' })
  await assert.rejects(tool('projects', { action: 'add', cwds: [] }), { code: 'directory' })
})

/** Makes a linked worktree of [main] at [path], with the files that `git worktree add` writes. [main] needs a `.git` directory. */
async function worktree(main, path, name, seconds) {
  const gitdir = join(main, '.git', 'worktrees', name)
  await mkdir(gitdir, { recursive: true })
  await writeFile(join(gitdir, 'commondir'), '../..\n')
  await writeFile(join(gitdir, 'gitdir'), `${join(path, '.git')}\n`)
  await mkdir(path, { recursive: true })
  await writeFile(join(path, '.git'), `gitdir: ${gitdir}\n`)
  await utimes(join(path, '.git'), seconds, seconds)
}

test('mainRepositoryOf finds the main repository of a linked worktree and nothing else', async t => {
  const { home, outside } = await tree(t)
  const main = join(home, 'src', 'main')
  await repository(main, 100)
  await worktree(main, join(home, 'src', 'main-wt'), 'main-wt', 200)
  assert.equal(mainRepositoryOf(join(home, 'src', 'main-wt')), main)
  // A symbolic link to the worktree gives the real main repository.
  await symlink(join(home, 'src', 'main-wt'), join(home, 'wt-link'))
  assert.equal(mainRepositoryOf(join(home, 'wt-link')), main)
  // A main repository, a plain directory, a missing directory, a submodule, a forged file and a copied file are no worktree.
  await mkdir(join(home, 'src', 'plain'))
  await mkdir(join(main, '.git', 'modules', 'sub'), { recursive: true })
  await mkdir(join(home, 'src', 'sub'), { recursive: true })
  await writeFile(join(home, 'src', 'sub', '.git'), `gitdir: ${join(main, '.git', 'modules', 'sub')}\n`)
  await mkdir(join(home, 'src', 'forged'))
  await writeFile(join(home, 'src', 'forged', '.git'), `gitdir: ${join(main, '.git', 'worktrees', 'main-wt')}\n`)
  await mkdir(join(home, 'src', 'bare.git', 'worktrees', 'x'), { recursive: true })
  await writeFile(join(home, 'src', 'bare.git', 'worktrees', 'x', 'commondir'), '../..\n')
  await mkdir(join(home, 'src', 'bare-wt'))
  await writeFile(join(home, 'src', 'bare-wt', '.git'), `gitdir: ${join(home, 'src', 'bare.git', 'worktrees', 'x')}\n`)
  for (const path of [main, join(home, 'src', 'plain'), join(home, 'src', 'absent'), join(home, 'src', 'sub'), join(home, 'src', 'forged'),
    join(home, 'src', 'bare-wt'), join(outside, 'linked')]) assert.equal(mainRepositoryOf(path), undefined, path)
  // A `.git` that is a symbolic link is no worktree.
  await symlink(join(home, 'src', 'main-wt', '.git'), join(home, 'src', 'plain', '.git'))
  assert.equal(mainRepositoryOf(join(home, 'src', 'plain')), undefined)
})

test('discover glues the worktrees to the main repository, and add with cwds skips them but add with one cwd takes it', { timeout: 10000 }, async t => {
  const directories = await tree(t)
  const { home } = directories
  const src = join(home, 'src')
  // `erlang` is in the scan, `ultimate` is not (out of the scan, in a deep directory), and `known` is listed.
  await repository(join(src, 'erlang'), 8000)
  await worktree(join(src, 'erlang'), join(src, 'ie-wt-1'), 'ie-wt-1', 9000)
  await worktree(join(src, 'erlang'), join(src, 'ie-wt-2'), 'ie-wt-2', 8500)
  await repository(join(home, 'elsewhere', 'deep', 'ultimate'), 100)
  await worktree(join(home, 'elsewhere', 'deep', 'ultimate'), join(src, 'ultimate-2'), 'ultimate-2', 7000)
  await repository(join(src, 'known'), 100)
  await worktree(join(src, 'known'), join(src, 'known-wt'), 'known-wt', 6500)
  const { service, tool } = await open(t, directories)
  await tool('projects', { action: 'add', cwd: '~/src/known' })
  const found = await tool('projects', { action: 'discover' })
  const cwds = found.repositories.map(item => item.cwd)
  // No worktree is a repository to add. The main repositories come instead, also the one that the scan did not find.
  for (const name of ['ie-wt-1', 'ie-wt-2', 'ultimate-2', 'known-wt']) assert.ok(!cwds.includes(join(src, name)), name)
  assert.deepEqual(found.repositories.find(item => item.cwd === join(src, 'erlang')).worktrees, [join(src, 'ie-wt-1'), join(src, 'ie-wt-2')])
  assert.deepEqual(found.repositories.find(item => item.cwd === join(home, 'elsewhere', 'deep', 'ultimate')).worktrees, [join(src, 'ultimate-2')])
  assert.deepEqual(found.worktrees.map(item => [item.cwd, item.worktreeOf]), [[join(src, 'ie-wt-1'), join(src, 'erlang')],
    [join(src, 'ie-wt-2'), join(src, 'erlang')], [join(src, 'ultimate-2'), join(home, 'elsewhere', 'deep', 'ultimate')],
    [join(src, 'known-wt'), join(src, 'known')]])
  // A listed main repository is not offered again. Its worktree is only reported, with worktreeOf.
  assert.ok(!cwds.includes(join(src, 'known')))
  // A named folder that is a worktree tells its main repository.
  assert.deepEqual((await tool('projects', { action: 'discover', cwd: '~/src/ie-wt-1' })).folder,
    { cwd: join(src, 'ie-wt-1'), repository: true, listed: false, worktreeOf: join(src, 'erlang') })
  // A list of paths adds the main repositories and skips the worktrees with the reason.
  const added = await tool('projects', { action: 'add', cwds: [join(src, 'erlang'), join(src, 'ie-wt-1'), join(src, 'ie-wt-2')] })
  assert.deepEqual(added.added, [join(src, 'erlang')])
  assert.deepEqual(added.skipped, [
    { cwd: join(src, 'ie-wt-1'), worktreeOf: join(src, 'erlang'), reason: `worktree of ${join(src, 'erlang')}` },
    { cwd: join(src, 'ie-wt-2'), worktreeOf: join(src, 'erlang'), reason: `worktree of ${join(src, 'erlang')}` }])
  assert.ok(!added.refused)
  assert.equal((await service.state.snapshot()).projects.length, 2)
  // The cwd of the same call as the first of a list is also a part of the list.
  assert.deepEqual((await tool('projects', { action: 'add', cwd: join(src, 'ie-wt-1'), cwds: [join(src, 'ie-wt-2')] })).added, [])
  // One worktree that the user names exactly goes to the list, and a child can work in it.
  const single = await tool('projects', { action: 'add', cwd: '~/src/ie-wt-1' })
  assert.equal(single.added, join(src, 'ie-wt-1'))
  // The list shows the worktree under its main repository, and the worktree stays a listed directory.
  assert.deepEqual(single.workspaces.filter(item => item.origin !== 'megachat').map(item => [item.cwd, item.worktreeOf, item.worktrees]), [
    [join(src, 'known'), undefined, undefined],
    [join(src, 'erlang'), undefined, [join(src, 'ie-wt-1')]],
    [join(src, 'ie-wt-1'), join(src, 'erlang'), undefined]])
  assert.equal(await service.state.directory(join(src, 'ie-wt-1')), join(src, 'ie-wt-1'))
})

test('the list glues a worktree of an IDE and a known worktree that has no listed main repository', async t => {
  const directories = await tree(t)
  const { home } = directories
  const src = join(home, 'src')
  await repository(join(src, 'main'), 100)
  await worktree(join(src, 'main'), join(src, 'main-ide'), 'main-ide', 200)
  await worktree(join(src, 'main'), join(src, 'main-known'), 'main-known', 200)
  const { service, tool } = await open(t, directories)
  await service.state.change(state => { state.workspaces.push(join(src, 'main-ide'), join(src, 'old')) })
  await tool('projects', { action: 'add', cwd: '~/src/main-known' })
  const list = (await tool('projects', { action: 'list' })).workspaces
  assert.deepEqual(list.filter(item => item.origin !== 'megachat').map(item => [item.cwd, item.worktreeOf]), [
    [join(src, 'main-ide'), join(src, 'main')], [join(src, 'old'), undefined], [join(src, 'main-known'), join(src, 'main')]])
  // The main repository comes into the list: the worktrees follow it and it names them.
  await tool('projects', { action: 'add', cwd: '~/src/main' })
  const glued = (await tool('projects', { action: 'list' })).workspaces.filter(item => item.origin !== 'megachat')
  assert.deepEqual(glued.map(item => item.cwd), [join(src, 'old'), join(src, 'main'), join(src, 'main-ide'), join(src, 'main-known')])
  assert.deepEqual(glued[1].worktrees, [join(src, 'main-ide'), join(src, 'main-known')])
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

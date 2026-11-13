// `npm run test:package` runs this file. The first test packs Megachat with `npm pack`, installs the tarball into a
// temporary prefix with a temporary npm cache, and tests the installed copy. The second test runs the entry of
// `acp.json` through npx from a temporary git repository with release tags. Each test takes about 1 GB and about a
// minute, so `npm test` does not run this file. The tests send no prompt, so they call no model.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import manifest from '../package.json' with { type: 'json' }
import { RELEASE_ENTRY, RELEASE_SPEC } from '../src/MegachatInstall.mjs'
import { npxCopy } from '../src/MegachatUpdate.mjs'
import { IDE_NPM_VARIABLES, npmPathEntry } from '../src/npmEnvironment.mjs'
import { commandOnPath, processEnvironment } from './process-environment.mjs'
import { stopDaemon } from './stop-daemon.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }

/**
 * Starts [command], sends one ACP `initialize`, and returns its response. Then it closes the input and waits for the
 * exit. [lines] gets each line of the standard output.
 */
async function initialized(command, args, options, { timeoutMs = 60000, lines = [] } = {}) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.write(`${JSON.stringify(initialize)}\n`)
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer from ${command}: ${stderr}`)), timeoutMs)
      let buffer = ''
      child.stdout.on('data', chunk => {
        buffer += chunk
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
          lines.push(line)
          if (JSON.parse(line).id === 1) { clearTimeout(timer); resolve(JSON.parse(line)) }
        }
      })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`${command} exited with ${code}: ${stderr}`)) })
    })
  }
  finally {
    // An agent stops at the end of its input. The Codex shim stops when its agent stops.
    child.stdin.end()
    if (await Promise.race([exited.then(() => true), delay(15000, false)]) === false) {
      child.kill('SIGKILL')
      await exited
    }
  }
}

/** The processes whose command line names [directory]. */
async function processesIn(directory) {
  const { stdout } = await execute('ps', ['-axo', 'pid=,command='], { maxBuffer: 16 * 1024 * 1024 })
  return stdout.split('\n').filter(line => line.includes(directory))
}

test('the packed copy starts its daemon and both agents, and install writes the npx entry of the last release', { timeout: 900000 }, async t => {
  // The shims compare real paths, and the temporary directory of macOS is a symbolic link.
  const scratch = await realpath(await mkdtemp(join(tmpdir(), 'megachat-package-')))
  const state = join(scratch, 'state')
  const home = join(scratch, 'home')
  t.after(async () => {
    try { await stopDaemon(state) }
    finally { await rm(scratch, { recursive: true, force: true }) }
  })
  await mkdir(home)
  await mkdir(join(scratch, 'codex-home'))
  const npm = { ...process.env, npm_config_cache: join(scratch, 'npm-cache'), npm_config_audit: 'false', npm_config_fund: 'false',
    npm_config_update_notifier: 'false' }

  const [packed] = JSON.parse((await execute('npm', ['pack', '--json', '--pack-destination', scratch], { cwd: root, env: npm })).stdout)
  const files = packed.files.map(file => file.path)
  for (const file of ['package.json', 'README.md', 'LICENSE', 'bin/megachat.mjs', 'bin/codex', 'bin/pi', 'src/main.mjs', 'resources/Megachat.properties']) {
    assert.ok(files.includes(file), file)
  }
  assert.deepEqual(files.filter(file => !/^(bin|src|resources)\//.test(file) && !['package.json', 'README.md', 'LICENSE'].includes(file)), [])

  const prefix = join(scratch, 'prefix')
  await mkdir(prefix)
  const started = Date.now()
  await execute('npm', ['install', '--prefix', prefix, join(scratch, packed.filename)], { env: npm, maxBuffer: 16 * 1024 * 1024 })
  t.diagnostic(`npm install took ${Math.round((Date.now() - started) / 1000)} s`)
  const copy = join(prefix, 'node_modules', 'megachat')
  const launcher = join(copy, 'bin', 'megachat.mjs')
  assert.ok(existsSync(launcher))
  assert.ok(!existsSync(join(copy, '.git')))
  assert.ok(!existsSync(join(copy, 'test')))
  assert.ok(!existsSync(join(copy, 'node_modules', '@agentclientprotocol')), 'npm puts the dependencies next to the copy')

  // The daemon of the copy publishes the build id of the copy, not `dev`.
  const daemonEnvironment = { ...process.env, MEGACHAT_LEGACY_DIRS: '' }
  const start = await execute(process.execPath, [launcher, 'start', state], { env: daemonEnvironment })
  assert.match(start.stdout, /The Megachat daemon is running\./)
  const answer = await initialized(process.execPath, [launcher, 'acp', state], { env: daemonEnvironment })
  assert.equal(answer.error, undefined, JSON.stringify(answer.error))
  assert.equal(answer.result.agentInfo.version, manifest.version)
  const { sourceBuildId } = await import(pathToFileURL(join(copy, 'src', 'sourceBuildId.mjs')).href)
  const build = sourceBuildId(copy)
  assert.match(build, new RegExp(`^${manifest.version.replaceAll('.', '\\.')}-[0-9a-f]{16}$`))
  const descriptor = JSON.parse(await readFile(join(state, 'daemon', 'connection.json'), 'utf8'))
  assert.ok(descriptor.build.startsWith(`${build}+`), descriptor.build)

  // Without the variables of the IDE, the default agent commands of the copy resolve into the node_modules of npm.
  const { CentralConfigurationService } = await import(pathToFileURL(join(copy, 'src', 'CentralConfigurationService.mjs')).href)
  const configuration = new CentralConfigurationService({ environment: { HOME: home, PATH: [join(prefix, 'node_modules', '.bin'), '/usr/bin', '/bin'].join(delimiter) } })
  // The real child environment holds the Central key. These agents get no prompt, so they do not need it.
  configuration.childEnvironment = async () => configuration.baseEnvironment()
  const claude = await configuration.childLaunch('claude')
  assert.equal(claude.args[0], join(prefix, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js'))
  const claudeAnswer = await initialized(claude.command, claude.args, { env: claude.env, cwd: scratch })
  assert.equal(typeof claudeAnswer.result?.protocolVersion, 'number', JSON.stringify(claudeAnswer))

  // `central run codex` puts `bin` of the copy first on PATH and starts `codex`. This test starts that shim directly,
  // with the Codex of the install for the app-server and a temporary Codex home.
  const codex = await configuration.childLaunch('codex')
  assert.equal(codex.env.PATH.split(delimiter)[0].replace(/\/$/, ''), join(copy, 'bin'))
  const codexAnswer = await initialized(join(copy, 'bin', 'codex'), [], { env: { ...codex.env, CODEX_HOME: join(scratch, 'codex-home') }, cwd: scratch })
  assert.equal(codexAnswer.result?.agentInfo?.name, '@agentclientprotocol/codex-acp', JSON.stringify(codexAnswer))

  // A copy without .git gets the npx entry of the last release. The checks depend on the machine, so only the entry
  // counts. The second test runs that entry.
  const acpConfig = join(scratch, 'acp.json')
  const install = await execute(process.execPath, [launcher, 'install', state], { env: { ...daemonEnvironment, MEGACHAT_ACP_CONFIG: acpConfig } })
    .catch(error => error)
  t.diagnostic(`install exited with ${install.code ?? 0}:\n${install.stdout}`)
  assert.deepEqual(JSON.parse(await readFile(acpConfig, 'utf8')).agent_servers.Megachat, RELEASE_ENTRY)
  assert.deepEqual(RELEASE_ENTRY.env, { GIT_HTTP_LOW_SPEED_LIMIT: '1000', GIT_HTTP_LOW_SPEED_TIME: '20' })

  await stopDaemon(state)
  for (let attempt = 0; attempt < 100 && (await processesIn(scratch)).length > 0; attempt++) await delay(100)
  assert.deepEqual(await processesIn(scratch), [])
})

/** The process ID in the connection file of the daemon of [state]. */
async function daemonPid(state) {
  return JSON.parse(await readFile(join(state, 'daemon', 'connection.json'), 'utf8')).pid
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

test('the npx entry starts the highest release tag, its daemon gets no environment of npm, and a higher tag replaces the daemon',
  { timeout: 900000 }, async t => {
    const scratch = await realpath(await mkdtemp(join(tmpdir(), 'megachat-npx-')))
    const state = join(scratch, 'state')
    t.after(async () => {
      try { await stopDaemon(state) }
      finally { await rm(scratch, { recursive: true, force: true }) }
    })
    // The environment that the IDE gives an npx entry: no variable of npm, the npm variables of Air with a temporary
    // cache, a home without Central, and a user with codex and claude on the PATH. The test sends no prompt, so these
    // commands only show what the daemon finds. git must not read the configuration of the user. The IDE adds the env
    // of the entry, with the time limits of git.
    const user = join(scratch, 'user', 'bin')
    for (const directory of [user, join(scratch, 'home'), join(scratch, 'project')]) await mkdir(directory, { recursive: true })
    for (const command of ['codex', 'claude']) await writeFile(join(user, command), '#!/bin/sh\n', { mode: 0o755 })
    const ide = Object.fromEntries(Object.entries(process.env).filter(([name]) => !/^npm_/i.test(name) && !['INIT_CWD', 'NODE', 'COLOR'].includes(name)))
    Object.assign(ide, {
      HOME: join(scratch, 'home'), PATH: [user, dirname(process.execPath), '/usr/bin', '/bin'].join(delimiter),
      MEGACHAT_LEGACY_DIRS: '', MEGACHAT_ACP_CONFIG: join(scratch, 'acp.json'), GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
      NPM_CONFIG_CACHE: join(scratch, 'npm-cache'), NPM_CONFIG_MIN_RELEASE_AGE: '0', NPM_CONFIG_GLOBAL: 'false', NPM_CONFIG_DRY_RUN: 'false',
      NPM_CONFIG_INCLUDE: 'optional', NPM_CONFIG_ENGINE_STRICT: 'false', NPM_CONFIG_STRICT_PEER_DEPS: 'false', NODE_USE_SYSTEM_CA: '1',
      ...RELEASE_ENTRY.env,
    })
    assert.deepEqual(Object.keys(RELEASE_ENTRY.env), ['GIT_HTTP_LOW_SPEED_LIMIT', 'GIT_HTTP_LOW_SPEED_TIME'])

    // A repository with the files of this checkout, as GitHub has them, and the release tag of the version.
    const repository = join(scratch, 'repository')
    const gitEnvironment = { ...ide, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
    const git = (...args) => execute('git', args, { cwd: repository, env: gitEnvironment })
    const files = (await execute('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: root })).stdout.split('\0').filter(Boolean)
    for (const file of files.filter(file => existsSync(join(root, file)))) {
      await mkdir(dirname(join(repository, file)), { recursive: true })
      await copyFile(join(root, file), join(repository, file))
      await chmod(join(repository, file), (await stat(join(root, file))).mode & 0o777)
    }
    await git('init', '--quiet', '--initial-branch=main')
    await git('add', '--all')
    await git('commit', '--quiet', '--message', 'The release')
    await git('tag', `v${manifest.version}`)

    const npx = join(dirname(process.execPath), 'npx')
    const args = RELEASE_ENTRY.args.map(arg => arg === RELEASE_SPEC ? `git+file://${repository}#semver:x` : arg)
    const start = async (version, timeoutMs = 600000) => {
      const lines = []
      const started = Date.now()
      const answer = await initialized(npx, [...args, state], { env: ide, cwd: join(scratch, 'project') }, { timeoutMs, lines })
      assert.equal(answer.result?.agentInfo?.version, version, JSON.stringify(answer))
      // The IDE reads the standard output as ACP, so npm must not write to it.
      assert.deepEqual(lines.filter(line => JSON.parse(line).jsonrpc !== '2.0'), [])
      return Math.round((Date.now() - started) / 100) / 10
    }
    const daemon = async () => {
      const pid = await daemonPid(state)
      const environment = await processEnvironment(pid)
      assert.deepEqual(environment.names.filter(name => /^npm_/.test(name) || [...IDE_NPM_VARIABLES, 'INIT_CWD', 'NODE', 'COLOR',
        ...Object.keys(RELEASE_ENTRY.env)].includes(name)), [])
      assert.ok(environment.names.includes('NODE_USE_SYSTEM_CA'))
      assert.deepEqual(environment.path.split(delimiter).filter(entry => npmPathEntry(entry)), [])
      // npx puts the node_modules/.bin directory of the copy first on its PATH, and that directory holds the codex of
      // a dependency. The daemon finds the commands of the user.
      assert.equal(await commandOnPath('codex', environment.path), join(user, 'codex'))
      assert.equal(await commandOnPath('claude', environment.path), join(user, 'claude'))
      return pid
    }

    t.diagnostic(`the first start took ${await start(manifest.version)} s`)
    const first = await daemon()
    // The copy of npx is the copy that the automatic update stops (see the capability `update`).
    const copies = (await readdir(join(ide.NPM_CONFIG_CACHE, '_npx'))).map(hash => join(ide.NPM_CONFIG_CACHE, '_npx', hash, 'node_modules', 'megachat'))
      .filter(copy => existsSync(join(copy, 'package.json')))
    assert.equal(copies.length, 1)
    assert.equal(npxCopy(copies[0]), true)
    const install = await execute(npx, ['-y', args[1], 'install', state], { env: ide, cwd: join(scratch, 'project') }).catch(error => error)
    assert.match(install.stdout, /The IDE starts Megachat with npx and with its own Node\.js/)
    const entry = await readFile(ide.MEGACHAT_ACP_CONFIG, 'utf8')
    assert.deepEqual(JSON.parse(entry), { agent_servers: { Megachat: RELEASE_ENTRY } })
    t.diagnostic(`a later start of the same release took ${await start(manifest.version)} s`)
    assert.equal(await daemonPid(state), first)

    // A higher tag is a new release. The next start installs it and replaces the daemon of the earlier release.
    const [major, minor, patch] = manifest.version.split('.').map(Number)
    const next = `${major}.${minor}.${patch + 1}`
    await writeFile(join(repository, 'package.json'), `${JSON.stringify({ ...JSON.parse(await readFile(join(repository, 'package.json'), 'utf8')), version: next }, null, 2)}\n`)
    await git('commit', '--quiet', '--all', '--message', 'The next release')
    await git('tag', `v${next}`)
    t.diagnostic(`the start of the new release took ${await start(next)} s`)
    const second = await daemon()
    assert.notEqual(second, first)
    for (let attempt = 0; attempt < 100 && alive(first); attempt++) await delay(100)
    assert.equal(alive(first), false)
    assert.equal(await readFile(ide.MEGACHAT_ACP_CONFIG, 'utf8'), entry)

    await stopDaemon(state)
    for (let attempt = 0; attempt < 100 && (await processesIn(scratch)).length > 0; attempt++) await delay(100)
    assert.deepEqual(await processesIn(scratch), [])
  })

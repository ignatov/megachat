// `npm run test:package` runs this file. It packs Megachat with `npm pack`, installs the tarball into a temporary prefix
// with a temporary npm cache, and tests the installed copy. The install takes about 870 MB and about a minute, so
// `npm test` does not run this file. The test sends no prompt, so it calls no model.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import manifest from '../package.json' with { type: 'json' }
import { stopDaemon } from './stop-daemon.mjs'

const execute = promisify(execFile)
const root = fileURLToPath(new URL('..', import.meta.url))
const initialize = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } }

/** Starts [command], sends one ACP `initialize`, and returns its response. Then it closes the input and waits for the exit. */
async function initialized(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'] })
  const exited = once(child, 'exit')
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.write(`${JSON.stringify(initialize)}\n`)
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No answer from ${command}: ${stderr}`)), 60000)
      let buffer = ''
      child.stdout.on('data', chunk => {
        buffer += chunk
        for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
          const line = buffer.slice(0, end)
          buffer = buffer.slice(end + 1)
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

test('the packed copy starts its daemon and both agents, and install writes an entry that starts it', { timeout: 900000 }, async t => {
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
  for (const file of ['package.json', 'README.md', 'bin/megachat.mjs', 'bin/codex', 'bin/pi', 'src/main.mjs', 'resources/Megachat.properties']) {
    assert.ok(files.includes(file), file)
  }
  assert.deepEqual(files.filter(file => !/^(bin|src|resources)\//.test(file) && !['package.json', 'README.md'].includes(file)), [])

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

  // `install` writes an entry that starts the same copy. The checks depend on the machine, so only the entry counts.
  const acpConfig = join(scratch, 'acp.json')
  const install = await execute(process.execPath, [launcher, 'install', state], { env: { ...daemonEnvironment, MEGACHAT_ACP_CONFIG: acpConfig } })
    .catch(error => error)
  t.diagnostic(`install exited with ${install.code ?? 0}:\n${install.stdout}`)
  const { Megachat: entry } = JSON.parse(await readFile(acpConfig, 'utf8')).agent_servers
  assert.deepEqual(entry.args, [launcher, 'acp'])
  assert.equal(await realpath(entry.command), await realpath(process.execPath))
  const entryAnswer = await initialized(entry.command, [...entry.args, state], { env: daemonEnvironment })
  assert.equal(entryAnswer.result.agentInfo.version, manifest.version)
  // The same build keeps the daemon: the entry started the same copy.
  assert.deepEqual(JSON.parse(await readFile(join(state, 'daemon', 'connection.json'), 'utf8')), descriptor)

  await stopDaemon(state)
  for (let attempt = 0; attempt < 100 && (await processesIn(scratch)).length > 0; attempt++) await delay(100)
  assert.deepEqual(await processesIn(scratch), [])
})

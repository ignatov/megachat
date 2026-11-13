import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { chmod, cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { inspect } from 'node:util'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import manifest from '../package.json' with { type: 'json' }
import { agentCommand, CentralConfigurationService, CLAUDE_ACP_VARIABLE, CODEX_ACP_VARIABLE } from '../src/CentralConfigurationService.mjs'
import { daemonBuild, megachatVersion, needsReplacement } from '../src/MegachatBuild.mjs'
import { message } from '../src/messages.mjs'
import { redactSecrets } from '../src/SessionText.mjs'
import { buildVersion, sourceBuildId } from '../src/sourceBuildId.mjs'
import { stopDaemon } from './stop-daemon.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))

test('an agent command is a JSON array, a JSON object or one path', () => {
  assert.equal(agentCommand(undefined), undefined)
  assert.equal(agentCommand('  '), undefined)
  assert.deepEqual(agentCommand('/opt/air/claude-agent-acp'), { command: '/opt/air/claude-agent-acp', args: [], env: {} })
  assert.deepEqual(agentCommand('["/air/npx","--no","--","@agentclientprotocol/codex-acp"]'),
    { command: '/air/npx', args: ['--no', '--', '@agentclientprotocol/codex-acp'], env: {} })
  assert.deepEqual(agentCommand('{"command":"/air/npx","args":["--no"],"env":{"A":"1"},"cwd":"/air/codex"}'),
    { command: '/air/npx', args: ['--no'], env: { A: '1' }, cwd: '/air/codex' })
  assert.throws(() => agentCommand('[]'), { code: 'agentCommand' })
  assert.throws(() => agentCommand('{"command":"x","args":[1]}'), { code: 'agentCommand' })
})

test('Codex runs through Central with the passed command and the node of Megachat on PATH', async () => {
  const passed = '["/air/npx","--no","--","@agentclientprotocol/codex-acp"]'
  const configuration = new CentralConfigurationService({ central: '/central', environment: { PATH: '/usr/bin', [CODEX_ACP_VARIABLE]: passed } })
  const launch = await configuration.childLaunch('codex')
  assert.equal(launch.command, '/central')
  assert.equal(launch.env[CODEX_ACP_VARIABLE], passed)
  const path = launch.env.PATH.split(delimiter)
  assert.match(path[0], /bin\/?$/)
  assert.equal(path[1], dirname(process.execPath))
  assert.equal(path.at(-1), '/usr/bin')
})

test('Claude runs the passed command and keeps its cwd and environment under the Central environment', async () => {
  const configuration = new CentralConfigurationService({ environment: {
    PATH: '/usr/bin', [CLAUDE_ACP_VARIABLE]: '{"command":"/air/claude-agent-acp","env":{"AGENT":"1","ANTHROPIC_API_KEY":"agent"}}',
  } })
  configuration.childEnvironment = async () => ({ ...configuration.baseEnvironment(), ANTHROPIC_API_KEY: 'central' })
  const launch = await configuration.childLaunch('claude')
  assert.equal(launch.command, '/air/claude-agent-acp')
  assert.deepEqual(launch.args, [])
  assert.equal(launch.env.AGENT, '1')
  assert.equal(launch.env.ANTHROPIC_API_KEY, 'central')
})

test('without a passed command Claude runs the development install', async () => {
  const configuration = new CentralConfigurationService({ environment: { PATH: '/usr/bin' } })
  configuration.childEnvironment = async () => configuration.baseEnvironment()
  const launch = await configuration.childLaunch('claude')
  assert.equal(launch.command, process.execPath)
  assert.match(launch.args[0], /node_modules\/@agentclientprotocol\/claude-agent-acp\/dist\/index\.js$/)
  assert.ok(existsSync(launch.args[0]), launch.args[0])
})

/** A copy of the files that an install of the package holds, without `.git`. */
async function packageCopy(t) {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-copy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  for (const name of ['package.json', 'bin', 'src', 'resources']) await cp(join(root, name), join(directory, name), { recursive: true })
  return directory
}

test('a git checkout has the build id dev, so a pull keeps its daemon', async t => {
  const directory = await packageCopy(t)
  await mkdir(join(directory, '.git'))
  assert.equal(sourceBuildId(directory), 'dev')
  await rm(join(directory, '.git'), { recursive: true })
  // A worktree of git has a `.git` file.
  await writeFile(join(directory, '.git'), 'gitdir: /elsewhere\n')
  assert.equal(sourceBuildId(directory), 'dev')
})

test('a copy without .git has a stable build id, and a changed file changes it', async t => {
  const directory = await packageCopy(t)
  const id = sourceBuildId(directory)
  assert.match(id, new RegExp(`^${manifest.version.replaceAll('.', '\\.')}-[0-9a-f]{16}$`))
  assert.equal(sourceBuildId(directory), id)
  assert.equal(sourceBuildId(await packageCopy(t)), id)
  await writeFile(join(directory, 'src', 'main.mjs'), '// A change.\n', { flag: 'a' })
  const changed = sourceBuildId(directory)
  assert.notEqual(changed, id)
  await writeFile(join(directory, 'resources', 'instructions.md'), 'A change.\n', { flag: 'a' })
  assert.notEqual(sourceBuildId(directory), changed)
})

/** Runs git in [directory] without the configuration of the user, and returns its output without the line end. */
function git(directory, ...args) {
  return execFileSync('git', ['-C', directory, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
}

/** A temporary git repository with the version 0.3.0 in `package.json`, one commit and no tag. */
async function versionRepository(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-version-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'megachat', version: '0.3.0' })}\n`)
  git(directory, 'init', '-q')
  git(directory, 'add', 'package.json')
  git(directory, 'commit', '-q', '-m', 'The first commit')
  return directory
}

/** A stand-in `git` in a new directory. It writes a file `started` next to it, then runs [body]. */
async function fakeGit(t, body) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-git-')))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'git'), `#!/bin/sh\nPATH=/usr/bin:/bin\ntouch "${join(directory, 'started')}"\n${body}\n`, { mode: 0o755 })
  return { path: directory, started: () => existsSync(join(directory, 'started')) }
}

test('a git checkout adds the commits after the release tag to the version as SemVer build metadata', async t => {
  const directory = await versionRepository(t)
  git(directory, 'tag', 'v0.3.0')
  assert.equal(buildVersion(directory), '0.3.0')
  for (const text of ['First', 'Second']) {
    await writeFile(join(directory, 'notes.txt'), `${text}\n`)
    git(directory, 'add', 'notes.txt')
    git(directory, 'commit', '-q', '-m', text)
  }
  const commit = git(directory, 'rev-parse', '--short=7', 'HEAD')
  assert.match(commit, /^[0-9a-f]{7}$/)
  assert.equal(buildVersion(directory), `0.3.0+2.g${commit}`)
  // The variables of an outer git command do not select another repository.
  const other = await versionRepository(t)
  assert.equal(buildVersion(directory, { environment: { ...process.env, GIT_DIR: join(other, '.git'), GIT_WORK_TREE: other } }), `0.3.0+2.g${commit}`)

  await writeFile(join(directory, 'notes.txt'), 'A change.\n')
  assert.equal(buildVersion(directory), `0.3.0+2.g${commit}.dirty`)
  git(directory, 'checkout', '-q', '--', 'notes.txt')

  // The commit that sets the next version, before its release tag.
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'megachat', version: '0.4.0' })}\n`)
  git(directory, 'commit', '-q', '-a', '-m', 'Megachat has the version 0.4.0')
  assert.equal(buildVersion(directory), `0.4.0+g${git(directory, 'rev-parse', '--short=7', 'HEAD')}`)
})

test('a copy without .git gives the version of package.json and starts no git command', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-version-copy-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'megachat', version: '0.3.0' })}\n`)
  const fake = await fakeGit(t, 'exit 1')
  assert.equal(buildVersion(directory, { environment: { PATH: fake.path } }), '0.3.0')
  assert.equal(fake.started(), false)
  // The same stand-in runs for a root with `.git`.
  await mkdir(join(directory, '.git'))
  assert.equal(buildVersion(directory, { environment: { PATH: fake.path } }), '0.3.0+dev')
  assert.equal(fake.started(), true)
})

test('a git checkout gives the version with +dev when git fails or gives no answer in 2 seconds', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-version-dev-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  await writeFile(join(directory, 'package.json'), `${JSON.stringify({ name: 'megachat', version: '0.3.0' })}\n`)
  await writeFile(join(directory, '.git'), 'gitdir: /elsewhere\n')
  assert.equal(buildVersion(directory), '0.3.0+dev')

  const fake = await fakeGit(t, 'exec sleep 10')
  const started = Date.now()
  assert.equal(buildVersion(directory, { environment: { PATH: fake.path } }), '0.3.0+dev')
  const elapsed = Date.now() - started
  assert.ok(fake.started())
  assert.ok(elapsed >= 1900 && elapsed < 8000, `${elapsed} ms`)
})

test('status gives the version of the running daemon after the key running', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-status-'))
  t.after(async () => {
    try { await stopDaemon(directory) }
    finally { await rm(directory, { force: true, recursive: true }) }
  })
  const main = (...args) => {
    const child = spawn(process.execPath, [join(root, 'src', 'main.mjs'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += chunk })
    child.stderr.on('data', chunk => { stderr += chunk })
    return once(child, 'exit').then(([code]) => ({ code, stdout, stderr }))
  }
  const started = await main('start', directory)
  assert.equal(started.code, 0, started.stderr)
  const status = await main('status', directory)
  assert.equal(status.code, 0, status.stderr)
  const line = JSON.parse(status.stdout)
  assert.deepEqual(Object.keys(line), ['running', 'version', 'current', 'children'])
  assert.equal(line.version, megachatVersion())

  // A daemon of an earlier build gives no version in /health.
  const earlier = await mkdtemp(join(tmpdir(), 'megachat-status-earlier-'))
  t.after(() => rm(earlier, { force: true, recursive: true }))
  const server = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url === '/health' ? { version: 1, pid: process.pid } : { current: null, runs: {} }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => server.close())
  await mkdir(join(earlier, 'daemon'))
  await writeFile(join(earlier, 'daemon', 'connection.json'), JSON.stringify({ version: 1, pid: process.pid, port: server.address().port, token: 'a'.repeat(64) }))
  const old = await main('status', earlier)
  assert.equal(old.code, 0, old.stderr)
  assert.equal(old.stdout, '{"running":true,"current":null,"children":[]}\n')

  // A daemon with the notice of a new release.
  const notified = await mkdtemp(join(tmpdir(), 'megachat-status-update-'))
  t.after(() => rm(notified, { force: true, recursive: true }))
  const update = { available: '0.5.0', notice: 'A new release is available: 0.4.0 → 0.5.0' }
  const newer = createServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(request.url === '/health' ? { version: 1, pid: process.pid, megachatVersion: '0.4.0', update } : { current: null, runs: {} }))
  })
  newer.listen(0, '127.0.0.1')
  await once(newer, 'listening')
  t.after(() => newer.close())
  await mkdir(join(notified, 'daemon'))
  await writeFile(join(notified, 'daemon', 'connection.json'), JSON.stringify({ version: 1, pid: process.pid, port: newer.address().port, token: 'a'.repeat(64) }))
  const current = await main('status', notified)
  assert.equal(current.code, 0, current.stderr)
  assert.equal(current.stdout, '{"running":true,"version":"0.4.0","update":"A new release is available: 0.4.0 → 0.5.0","current":null,"children":[]}\n')
})

test('a client replaces a daemon of another build or other agent commands', () => {
  const commands = { [CLAUDE_ACP_VARIABLE]: '/a' }
  const build = daemonBuild(commands)
  assert.match(build, /^dev\+[0-9a-f]{12}$/)
  assert.notEqual(daemonBuild({ [CLAUDE_ACP_VARIABLE]: '/b' }), build)
  assert.equal(needsReplacement(build, build, commands), false)
  assert.equal(needsReplacement('0.1.0-abc+123', build, commands), true)
  assert.equal(needsReplacement(daemonBuild({ [CLAUDE_ACP_VARIABLE]: '/b' }), build, commands), true)
  assert.equal(needsReplacement(daemonBuild({ [CODEX_ACP_VARIABLE]: '/b' }), build, commands), true)
  // A source checkout keeps the daemon of an earlier prototype, a bundle replaces it.
  assert.equal(needsReplacement(undefined, build, commands), false)
  assert.equal(needsReplacement(undefined, '0.1.0-abc+123', commands), true)
})

test('a client that passes no agent command keeps a daemon of its own build', () => {
  const own = daemonBuild({})
  const daemon = daemonBuild({ [CLAUDE_ACP_VARIABLE]: '/a' })
  assert.notEqual(daemon, own)
  assert.equal(needsReplacement(daemon, own, {}), false)
  // The other direction replaces: the client has agents that the daemon does not start.
  assert.equal(needsReplacement(own, daemon, { [CLAUDE_ACP_VARIABLE]: '/a' }), true)
  // A daemon of another build goes also without commands. The digest of the commands follows the last plus sign.
  assert.equal(needsReplacement('0.1.0-abc+123456789abc', own, {}), true)
  assert.equal(needsReplacement('0.1.0+build-abc+123456789abc', '0.1.0+build-abc+000000000000', {}), false)
})

test('the environment of a Claude child has the Central configuration and no background tasks', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-settings-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  // The test has its own settings file and Central command. It must not read the settings of the user, run the key
  // command of the user, or start the Central of the user.
  const settings = join(directory, 'settings.json')
  const central = join(directory, 'missing-central')
  await writeFile(settings, JSON.stringify({ apiKeyHelper: 'echo test-key', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/wire/test' } }))
  // An executable Claude Code of the user goes to the agent in CLAUDE_CODE_EXECUTABLE.
  const claude = join(directory, 'claude')
  await writeFile(claude, '#!/bin/sh\n', { mode: 0o755 })
  const configuration = new CentralConfigurationService({ settings, central, claude, environment: { PATH: '/usr/bin', HOME: directory, SECRET: 'x' } })
  const environment = await configuration.childEnvironment()
  assert.equal(environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
  assert.equal(environment.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false')
  assert.equal(environment.ANTHROPIC_API_KEY, 'test-key')
  assert.equal(environment.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9/wire/test')
  assert.equal(environment.CLAUDE_CODE_EXECUTABLE, claude)
  assert.equal(environment.PATH.split(delimiter)[0], dirname(process.execPath))
  // Without Claude Code of the user, no CLAUDE_CODE_EXECUTABLE: the Claude agent starts the claude binary of its SDK.
  const bundled = new CentralConfigurationService({ settings, central, claude: join(directory, 'missing'), environment: { PATH: '/usr/bin', HOME: directory } })
  assert.equal('CLAUDE_CODE_EXECUTABLE' in await bundled.childEnvironment(), false)
  // A variable that is not in the list of the base environment does not reach the child.
  assert.equal(environment.SECRET, undefined)
})

test('a Claude child takes the Central entry of Claude Code first, else the configuration of the main agent, and fails without both', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-claude-key-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const settings = join(directory, 'settings.json')
  const central = join(directory, 'central')
  const ran = join(directory, 'central-ran')
  // The Central command of the test notes each run in a file and prints a configuration of the main agent.
  const centralScript = (body) => writeFile(central, `#!/bin/sh\ntouch '${ran}'\n${body}\n`, { mode: 0o755 })
  await centralScript(`printf '%s' '${JSON.stringify({ anthropic: { apiKey: 'pi-key', baseUrl: 'http://127.0.0.1:9/wire/pi/' } })}'`)
  const configuration = new CentralConfigurationService({ settings, central, claude: join(directory, 'missing'), environment: { PATH: '/usr/bin', HOME: directory } })
  const log = []
  t.mock.method(process.stderr, 'write', text => { log.push(String(text)); return true })

  // The Central entry of the settings of Claude Code: the Central command does not run.
  await writeFile(settings, JSON.stringify({ apiKeyHelper: 'echo test-key', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/wire/test' } }))
  let environment = await configuration.childEnvironment()
  assert.equal(environment.ANTHROPIC_API_KEY, 'test-key')
  assert.equal(environment.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9/wire/test')
  assert.equal(existsSync(ran), false)
  assert.equal((await configuration.claudeConfiguration()).source, 'settings')

  // No settings of Claude Code: the configuration of the main agent, with one log line.
  await rm(settings)
  log.length = 0
  environment = await configuration.childEnvironment()
  assert.equal(environment.ANTHROPIC_API_KEY, 'pi-key')
  assert.equal(environment.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9/wire/pi/')
  const fallback = log.filter(line => line.includes('The settings of Claude Code give no Central entry'))
  assert.equal(fallback.length, 1, log.join(''))
  assert.equal((await configuration.claudeConfiguration()).source, 'pi')

  // A base URL of the settings that is not the local proxy.
  await writeFile(settings, JSON.stringify({ apiKeyHelper: 'echo test-key', env: { ANTHROPIC_BASE_URL: 'https://example.com/wire/test' } }))
  assert.equal((await configuration.childEnvironment()).ANTHROPIC_API_KEY, 'pi-key')

  // No configuration at all: the launch fails, and no log line holds the output of the command.
  await rm(settings)
  await centralScript("echo 'apiKey sk-secret-value'\nexit 7")
  log.length = 0
  await assert.rejects(configuration.childEnvironment(), { code: 'central' })
  assert.ok(!log.join('').includes('sk-secret-value'), log.join(''))
})

test('the app-server of the Codex history starts through Central with the PATH of a Codex child', () => {
  const configuration = new CentralConfigurationService({ central: '/central', environment: { PATH: '/usr/bin' } })
  const launch = configuration.codexAppServerLaunch()
  assert.equal(launch.command, '/central')
  assert.deepEqual(launch.args, ['run', 'codex', '--', 'app-server', '--listen', 'stdio://'])
  const path = launch.env.PATH.split(delimiter)
  assert.match(path[0], /bin\/?$/)
  assert.equal(path[1], dirname(process.execPath))
  assert.equal(path.at(-1), '/usr/bin')
  // bin/codex then starts Codex directly, not the Codex ACP.
  assert.equal(launch.env.MEGACHAT_CODEX_ARGS, '[]')
})

test('bin/codex starts the Codex of the user, else the Codex that npm installed with the Codex agent', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-codex-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const user = join(directory, 'user')
  await mkdir(user)
  await writeFile(join(user, 'codex'), '#!/bin/sh\necho user codex\n', { mode: 0o755 })
  const shim = fileURLToPath(new URL('../bin/codex', import.meta.url))
  const codex = path => execFileSync(process.execPath, [shim, '--version'], { encoding: 'utf8', timeout: 20000,
    env: { HOME: directory, CODEX_HOME: directory, PATH: path, MEGACHAT_CODEX_ARGS: '[]' } }).trim()
  assert.equal(codex([user, '/usr/bin', '/bin'].join(delimiter)), 'user codex')
  assert.match(codex(['/usr/bin', '/bin'].join(delimiter)), /^codex-cli /)
  // The arguments of Central are options of codex, so they come before the subcommand that the Codex ACP gives.
  await writeFile(join(user, 'codex'), '#!/bin/sh\necho "$@"\n', { mode: 0o755 })
  const ordered = execFileSync(process.execPath, [shim, 'app-server', '--listen', 'stdio://'], { encoding: 'utf8', timeout: 20000,
    env: { HOME: directory, PATH: [user, '/usr/bin', '/bin'].join(delimiter), MEGACHAT_CODEX_ARGS: '["--profile","jetbrains-central","-c","model_provider=jetbrains-central"]' } }).trim()
  // Codex refuses --profile for app-server, so the profile goes, and the route of Central in -c stays.
  assert.equal(ordered, '-c model_provider=jetbrains-central app-server --listen stdio://')
  const exec = execFileSync(process.execPath, [shim, 'exec', 'hello'], { encoding: 'utf8', timeout: 20000,
    env: { HOME: directory, PATH: [user, '/usr/bin', '/bin'].join(delimiter), MEGACHAT_CODEX_ARGS: '["--profile","jetbrains-central"]' } }).trim()
  assert.equal(exec, '--profile jetbrains-central exec hello')
})

test('the Central configuration gives the secret filter its exact key and base URL, also after a refresh, and keeps them in the memory only', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-secrets-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  // Invented values. The key file changes, as a refreshed configuration does.
  const keys = ['Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue', 'Pk3Wq8Zr1Xn6Cm9Vt4Bs7Lh2Jd5Fg0Ka8Ty']
  const keyFile = join(directory, 'key')
  const settings = join(directory, 'settings.json')
  const central = join(directory, 'central')
  await writeFile(settings, JSON.stringify({ apiKeyHelper: `cat '${keyFile}'`, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:9/wire/${keys[0]}` } }))
  await writeFile(keyFile, `${keys[0]}\n`)
  await writeFile(central, `#!/bin/sh\nprintf '%s' '${JSON.stringify({ anthropic: { apiKey: 'Zx5Cv8Bn2Mq7Wl4Rt9Ys1Hd6Gf3Kj0Pa', baseUrl: `http://127.0.0.1:9/wire/${keys[1]}/` } })}'\n`, { mode: 0o755 })
  const configuration = new CentralConfigurationService({ settings, central, claude: '/air/claude', environment: { PATH: '/usr/bin', HOME: directory } })
  const marker = message('sessions.secret')
  const shown = text => redactSecrets(text, configuration.secrets)
  // Before a read, the filter knows no value. A key without a known prefix then stays when no pattern finds it.
  assert.equal(shown(`key ${keys[0]}`), `key ${keys[0]}`)
  await configuration.childEnvironment()
  assert.equal(shown(`key ${keys[0]}, base http://127.0.0.1:9/wire/${keys[0]}, path /wire/${keys[0]}/v1`), `key ${marker}, base ${marker}, path /wire/${marker}/v1`)
  await writeFile(keyFile, `${keys[1]}\n`)
  await writeFile(settings, JSON.stringify({ apiKeyHelper: `cat '${keyFile}'`, env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:9/wire/${keys[1]}` } }))
  await configuration.childEnvironment()
  // The configuration of the main agent adds its values too.
  await configuration.pi()
  assert.equal(shown(`${keys[0]} ${keys[1]} Zx5Cv8Bn2Mq7Wl4Rt9Ys1Hd6Gf3Kj0Pa http://127.0.0.1:9/wire/${keys[1]}/`), `${marker} ${marker} ${marker} ${marker}`)
  assert.ok(!inspect(configuration, { showHidden: true, depth: 10 }).includes(keys[1]))
  assert.ok(!JSON.stringify(configuration).includes(keys[1]))
})

test('a child agent gets the file mask of the user, the daemon keeps the mask 077 for its own files, and its log gets the mode 0600', { timeout: 60000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-mask-'))
  const agents = await realpath(await mkdtemp(join(tmpdir(), 'megachat-mask-agents-')))
  t.after(async () => {
    try { await stopDaemon(directory) }
    finally {
      await rm(directory, { force: true, recursive: true })
      await rm(agents, { force: true, recursive: true })
    }
  })
  for (const name of ['claude', 'codex', 'workspace']) await mkdir(join(agents, name))
  // A log of an earlier start with a wider mode. The open of a file that exists keeps its mode.
  await mkdir(join(directory, 'daemon'), { mode: 0o700 })
  await writeFile(join(directory, 'daemon', 'daemon.log'), '', { mode: 0o644 })
  await chmod(join(directory, 'daemon', 'daemon.log'), 0o644)
  // The mask 027 differs from the usual 022 of the test runner and from the 077 of Megachat. `start` sets 077 before it
  // starts the daemon, so only the mask that `start` got can reach the agent.
  const starting = spawn('/bin/sh', ['-c', 'umask 027; exec "$0" "$@"', process.execPath, join(root, 'src', 'main.mjs'), 'start', directory], {
    stdio: ['ignore', 'ignore', 'pipe'],
    env: { ...process.env, NODE_OPTIONS: `--import "${join(root, 'test', 'mask-daemon.mjs')}"`, MEGACHAT_TEST_MASK_AGENTS: agents },
  })
  let errors = ''
  starting.stderr.on('data', chunk => { errors += chunk })
  const [code] = await once(starting, 'exit')
  assert.equal(code, 0, errors)
  const { accounts } = JSON.parse(await readFile(join(agents, 'accounts.json'), 'utf8'))
  assert.deepEqual(accounts.map(account => account.status), ['started', 'started'])
  for (const agent of ['claude', 'codex']) {
    assert.equal((await stat(join(agents, agent, 'session-request.json'))).mode & 0o777, 0o640, agent)
  }
  assert.equal((await stat(join(directory, 'conversation.sqlite'))).mode & 0o777, 0o600)
  assert.equal((await stat(join(directory, 'daemon', 'daemon.log'))).mode & 0o777, 0o600)
})

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import manifest from '../package.json' with { type: 'json' }
import { agentCommand, CentralConfigurationService, CLAUDE_ACP_VARIABLE, CODEX_ACP_VARIABLE } from '../src/CentralConfigurationService.mjs'
import { daemonBuild, needsReplacement } from '../src/MegachatBuild.mjs'
import { sourceBuildId } from '../src/sourceBuildId.mjs'
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
  // The test has its own settings file. It must not read the settings of the user or run the key command of the user.
  const settings = join(directory, 'settings.json')
  await writeFile(settings, JSON.stringify({ apiKeyHelper: 'echo test-key', env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/wire/test' } }))
  const configuration = new CentralConfigurationService({ settings, claude: '/air/claude', environment: { PATH: '/usr/bin', HOME: directory, SECRET: 'x' } })
  const environment = await configuration.childEnvironment()
  assert.equal(environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
  assert.equal(environment.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION, 'false')
  assert.equal(environment.ANTHROPIC_API_KEY, 'test-key')
  assert.equal(environment.ANTHROPIC_BASE_URL, 'http://127.0.0.1:9/wire/test')
  assert.equal(environment.CLAUDE_CODE_EXECUTABLE, '/air/claude')
  assert.equal(environment.PATH.split(delimiter)[0], dirname(process.execPath))
  // A variable that is not in the list of the base environment does not reach the child.
  assert.equal(environment.SECRET, undefined)
  // A base URL that is not the local Central proxy gives no environment.
  await writeFile(settings, JSON.stringify({ apiKeyHelper: 'echo test-key', env: { ANTHROPIC_BASE_URL: 'https://example.com/wire/test' } }))
  t.mock.method(process.stderr, 'write', () => true)
  await assert.rejects(configuration.childEnvironment(), { code: 'central' })
})

test('a child agent gets the file mask of the user, and the daemon keeps the mask 077 for its own files', { timeout: 60000 }, async t => {
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
})

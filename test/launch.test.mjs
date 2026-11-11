import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import manifest from '../package.json' with { type: 'json' }
import { agentCommand, CentralConfigurationService, CLAUDE_ACP_VARIABLE, CODEX_ACP_VARIABLE } from '../src/CentralConfigurationService.mjs'
import { daemonBuild, needsReplacement } from '../src/MegachatBuild.mjs'
import { sourceBuildId } from '../src/sourceBuildId.mjs'

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
  const build = daemonBuild({ [CLAUDE_ACP_VARIABLE]: '/a' })
  assert.match(build, /^dev\+[0-9a-f]{12}$/)
  assert.notEqual(daemonBuild({ [CLAUDE_ACP_VARIABLE]: '/b' }), build)
  assert.equal(needsReplacement(build, build), false)
  assert.equal(needsReplacement('0.1.0-abc+123', build), true)
  // A source checkout keeps the daemon of an earlier prototype, a bundle replaces it.
  assert.equal(needsReplacement(undefined, build), false)
  assert.equal(needsReplacement(undefined, '0.1.0-abc+123'), true)
})

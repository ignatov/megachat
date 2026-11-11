import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import manifest from '../package.json' with { type: 'json' }
import { ACP_CONFIG_VARIABLE, acpConfigPath, stableNodePath, writeEntry } from '../src/MegachatInstall.mjs'

const launcher = fileURLToPath(new URL('../bin/megachat.mjs', import.meta.url))
const entry = { command: '/usr/local/bin/node', args: ['/opt/megachat/bin/megachat.mjs', 'acp'] }
const mode = async path => (await stat(path)).mode & 0o777
const temporary = async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-install-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return directory
}

function run(args, env, nodeOptions = []) {
  const child = spawn(process.execPath, [...nodeOptions, launcher, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return once(child, 'exit').then(([code]) => ({ code, stdout, stderr }))
}

test('the state guard points the acp.json path of each test to a temporary file', () => {
  assert.ok(process.env[ACP_CONFIG_VARIABLE])
  assert.equal(acpConfigPath(), process.env[ACP_CONFIG_VARIABLE])
  assert.notEqual(acpConfigPath(), join(homedir(), '.jetbrains', 'acp.json'))
  assert.equal(acpConfigPath({}), join(homedir(), '.jetbrains', 'acp.json'))
})

test('the launcher refuses a Node.js older than the engines range with one line', async t => {
  assert.equal(manifest.engines.node, '>=22.19')
  const old = `data:text/javascript,${encodeURIComponent("Object.defineProperty(process, 'versions', { value: { ...process.versions, node: '22.18.3' } })")}`
  const result = await run(['status', join(await temporary(t), 'state')], {}, [`--import=${old}`])
  assert.equal(result.code, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'Megachat needs Node.js 22.19 or later. This Node.js is 22.18.3.\n')
})

test('the stable node path is the first node on PATH that is the running node', async t => {
  const directory = await temporary(t)
  const execPath = join(directory, 'Cellar', 'node', '26.7.0', 'bin', 'node')
  await mkdir(dirname(execPath), { recursive: true })
  await writeFile(execPath, '')
  for (const name of ['other', 'stable', 'second']) await mkdir(join(directory, name))
  await writeFile(join(directory, 'other', 'node'), '')
  await symlink(execPath, join(directory, 'stable', 'node'))
  await symlink(execPath, join(directory, 'second', 'node'))
  const path = ['relative', join(directory, 'missing'), join(directory, 'other'), join(directory, 'stable'), join(directory, 'second')].join(delimiter)
  assert.equal(await stableNodePath({ execPath, path }), join(directory, 'stable', 'node'))
  assert.equal(await stableNodePath({ execPath, path: join(directory, 'other') }), execPath)
})

test('a missing acp.json gets a private file with the one entry', async t => {
  const path = join(await temporary(t), 'jetbrains', 'acp.json')
  assert.deepEqual(await writeEntry(path, entry), { status: 'created' })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { agent_servers: { Megachat: entry } })
  assert.equal(await mode(path), 0o600)
})

test('an acp.json without the entry keeps each key, the key order and the mode, and gets a backup', async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  const original = '{"default_mcp_settings":{"a":1},"agent_servers":{"Other":{"command":"/bin/other"}},"z":true}'
  await writeFile(path, original, { mode: 0o640 })
  await chmod(path, 0o640)
  const result = await writeEntry(path, entry, new Date('2026-11-11T09:08:07.654Z'))
  assert.deepEqual(result, { status: 'added', backup: join(directory, 'acp.json.before-megachat-20261111T090807Z') })
  assert.equal(await readFile(result.backup, 'utf8'), original)
  assert.equal(await mode(result.backup), 0o640)
  const written = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(Object.keys(written), ['default_mcp_settings', 'agent_servers', 'z'])
  assert.deepEqual(Object.keys(written.agent_servers), ['Other', 'Megachat'])
  assert.deepEqual(written, { ...JSON.parse(original), agent_servers: { Other: { command: '/bin/other' }, Megachat: entry } })
  assert.equal(await mode(path), 0o640)

  await writeFile(path, '{"z":1}')
  const second = await writeEntry(path, entry, new Date('2026-11-11T09:08:08Z'))
  assert.equal(second.status, 'added')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { z: 1, agent_servers: { Megachat: entry } })
})

test('an equal entry, a different entry and an unreadable file stay unchanged', async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  const cases = [
    [JSON.stringify({ agent_servers: { Megachat: entry } }), { status: 'same' }],
    [JSON.stringify({ agent_servers: { Megachat: { ...entry, application_session: true } } }),
      { status: 'different', existing: { ...entry, application_session: true } }],
    ['{"agent_servers": {', { status: 'unreadable' }],
    ['[]', { status: 'unreadable' }],
    ['{"agent_servers": []}', { status: 'unreadable' }],
  ]
  for (const [text, expected] of cases) {
    await writeFile(path, text)
    assert.deepEqual(await writeEntry(path, entry), expected, text)
    assert.equal(await readFile(path, 'utf8'), text)
  }
  assert.deepEqual(await readdir(directory), ['acp.json'])
})

/** A home with fake Central, Claude Code and Codex commands, so that the checks pass without the real tools. */
async function fakeMachine(directory) {
  const home = join(directory, 'home')
  const tools = join(directory, 'tools')
  const nodes = join(directory, 'nodes')
  for (const path of [join(home, '.local', 'bin'), join(home, '.claude'), tools, nodes]) await mkdir(path, { recursive: true })
  const configuration = { apiKey: 'test-key', baseUrl: 'http://127.0.0.1:9/wire/test' }
  await writeFile(join(home, '.local', 'bin', 'central'), `#!/bin/sh\nprintf '%s' '${JSON.stringify({ anthropic: configuration })}'\n`, { mode: 0o755 })
  await writeFile(join(home, '.local', 'bin', 'claude'), '#!/bin/sh\n', { mode: 0o755 })
  await writeFile(join(home, '.claude', 'settings.json'), JSON.stringify({ apiKeyHelper: 'echo test-key', env: { ANTHROPIC_BASE_URL: configuration.baseUrl } }))
  await writeFile(join(tools, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
  await symlink(process.execPath, join(nodes, 'node'))
  return { home, tools, nodes }
}

test('install writes the entry of this copy once, and reports each check', { timeout: 60000 }, async t => {
  const directory = await temporary(t)
  const { home, tools, nodes } = await fakeMachine(directory)
  const path = join(directory, 'acp.json')
  const env = { HOME: home, PATH: [nodes, tools, '/usr/bin', '/bin'].join(delimiter), [ACP_CONFIG_VARIABLE]: path }
  const first = await run(['install', join(directory, 'state')], env)
  const macOS = process.platform === 'darwin'
  assert.equal(first.code, macOS ? 0 : 1, first.stdout + first.stderr)
  assert.doesNotMatch(first.stdout, /test-key/)
  for (const line of [macOS ? 'The platform is macOS.' : `Nobody tested Megachat on ${process.platform}.`,
    'Central gives a valid configuration.', `Claude Code is at ${join(home, '.local', 'bin', 'claude')}, and it uses Central.`,
    `Codex is at ${join(tools, 'codex')}.`, `Megachat created ${path} with the entry Megachat.`,
    `Megachat ${manifest.version} runs from ${dirname(dirname(launcher))}.`]) {
    assert.ok(first.stdout.includes(line), `${line}\n${first.stdout}`)
  }
  const expected = { agent_servers: { Megachat: { command: join(nodes, 'node'), args: [launcher, 'acp'] } } }
  const text = await readFile(path, 'utf8')
  assert.deepEqual(JSON.parse(text), expected)
  assert.equal(await mode(path), 0o600)

  const second = await run(['install', join(directory, 'state')], env)
  assert.equal(second.code, first.code, second.stdout + second.stderr)
  assert.ok(second.stdout.includes(`Megachat is installed already: ${path} holds the same entry Megachat.`), second.stdout)
  assert.equal(await readFile(path, 'utf8'), text)
})

test('install names each missing tool, writes the entry and exits with 1', { timeout: 60000 }, async t => {
  const directory = await temporary(t)
  const home = join(directory, 'home')
  await mkdir(home)
  const path = join(directory, 'acp.json')
  // A node_modules/.bin directory of npx or npm does not count, because the IDE does not start Megachat with it.
  const npx = join(directory, '_npx', 'node_modules', '.bin')
  await mkdir(npx, { recursive: true })
  await writeFile(join(npx, 'codex'), '#!/bin/sh\n', { mode: 0o755 })
  const result = await run(['install', join(directory, 'state')], { HOME: home, PATH: [npx, '/usr/bin', '/bin'].join(delimiter), [ACP_CONFIG_VARIABLE]: path })
  assert.equal(result.code, 1, result.stdout + result.stderr)
  for (const line of [`Central is not at ${join(home, '.local', 'bin', 'central')}.`,
    `Claude Code is not at ${join(home, '.local', 'bin', 'claude')}.`, 'The command codex is not on the PATH.']) {
    assert.ok(result.stdout.includes(line), `${line}\n${result.stdout}`)
  }
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')).agent_servers.Megachat.args, [launcher, 'acp'])
})

test('install keeps a different entry and prints both entries', { timeout: 60000 }, async t => {
  const directory = await temporary(t)
  const { home, tools, nodes } = await fakeMachine(directory)
  const path = join(directory, 'acp.json')
  const other = { command: '/opt/homebrew/bin/node', args: ['/Users/me/src/megachat/src/main.mjs', 'acp'], application_session: true }
  const text = JSON.stringify({ agent_servers: { Megachat: other } })
  await writeFile(path, text)
  const result = await run(['install', join(directory, 'state')], { HOME: home, PATH: [nodes, tools, '/usr/bin', '/bin'].join(delimiter), [ACP_CONFIG_VARIABLE]: path })
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.ok(result.stdout.includes(`"Megachat": ${JSON.stringify(other)}`), result.stdout)
  assert.ok(result.stdout.includes(`"Megachat": ${JSON.stringify({ command: join(nodes, 'node'), args: [launcher, 'acp'] })}`), result.stdout)
  assert.match(result.stdout, /remove the entry Megachat/)
  assert.equal(await readFile(path, 'utf8'), text)

  await writeFile(path, '{ "agent_servers": ')
  const unreadable = await run(['install', join(directory, 'state')], { HOME: home, PATH: [nodes, tools, '/usr/bin', '/bin'].join(delimiter), [ACP_CONFIG_VARIABLE]: path })
  assert.equal(unreadable.code, 1)
  assert.ok(unreadable.stdout.includes(`"Megachat": ${JSON.stringify({ command: join(nodes, 'node'), args: [launcher, 'acp'] })}`), unreadable.stdout)
  assert.equal(await readFile(path, 'utf8'), '{ "agent_servers": ')
})

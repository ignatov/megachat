import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import manifest from '../package.json' with { type: 'json' }
import { ACP_CONFIG_VARIABLE, acpConfigPath, earlierEntry, RELEASE_ENTRY, stableNodePath, writeEntry } from '../src/MegachatInstall.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const launcher = fileURLToPath(new URL('../bin/megachat.mjs', import.meta.url))
/** The entry that `install` 0.2.0 wrote. */
const earlier = { command: '/opt/homebrew/bin/node', args: ['/Users/me/.npm/_npx/ad3589aca26e8aac/node_modules/megachat/bin/megachat.mjs', 'acp'] }
const entry = { command: '/usr/local/bin/node', args: ['/opt/megachat/bin/megachat.mjs', 'acp'] }
const mode = async path => (await stat(path)).mode & 0o777
const temporary = async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-install-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return directory
}

function run(args, env, nodeOptions = [], command = launcher) {
  const child = spawn(process.execPath, [...nodeOptions, command, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
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

test('the earlier entry is an entry of install 0.2.0 that starts a copy in an _npx directory with Node.js', () => {
  assert.equal(earlierEntry(earlier), true)
  assert.equal(earlierEntry({ command: '/usr/local/bin/node', args: ['/cache/_npx/0123/node_modules/megachat/bin/megachat.mjs', 'acp'] }), true)
  assert.equal(earlierEntry(entry), false)
  assert.equal(earlierEntry(RELEASE_ENTRY), false)
  assert.equal(earlierEntry({ ...earlier, application_session: true }), false)
  assert.equal(earlierEntry({ ...earlier, args: [...earlier.args, '/tmp/state'] }), false)
  assert.equal(earlierEntry({ command: earlier.command, args: ['/Users/me/src/megachat/bin/megachat.mjs', 'acp'] }), false)
  assert.equal(earlierEntry({ command: earlier.command, args: ['/cache/_npx/0123/node_modules/other/bin/megachat.mjs', 'acp'] }), false)
  assert.equal(earlierEntry({ command: '/usr/bin/env', args: earlier.args }), false)
})

test('a replaceable entry gets the new entry in its place, and the file gets a backup', async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  const original = JSON.stringify({ agent_servers: { First: { command: '/bin/first' }, Megachat: earlier, Last: { command: '/bin/last' } } })
  await writeFile(path, original, { mode: 0o640 })
  await chmod(path, 0o640)
  const result = await writeEntry(path, RELEASE_ENTRY, new Date('2026-11-11T09:08:07Z'), earlierEntry)
  assert.deepEqual(result, { status: 'replaced', backup: join(directory, 'acp.json.before-megachat-20261111T090807Z'), existing: earlier })
  assert.equal(await readFile(result.backup, 'utf8'), original)
  const written = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(Object.keys(written.agent_servers), ['First', 'Megachat', 'Last'])
  assert.deepEqual(written.agent_servers.Megachat, RELEASE_ENTRY)
  assert.equal(await mode(path), 0o640)
  // Without the rule, the same entry is a different entry.
  await writeFile(path, original)
  assert.deepEqual(await writeEntry(path, RELEASE_ENTRY), { status: 'different', existing: earlier })
  assert.equal(await readFile(path, 'utf8'), original)
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

test('install in a git checkout writes the entry that starts the checkout once, and reports each check', { timeout: 60000 }, async t => {
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

/** A copy of the files of the package without `.git`, as npx installs it. It uses the dependencies of this checkout. */
async function releaseCopy(directory) {
  const copy = join(directory, 'copy')
  for (const name of ['package.json', 'bin', 'src', 'resources']) await cp(join(root, name), join(copy, name), { recursive: true })
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  return copy
}

test('install in a copy without .git writes the npx entry of the last release, and replaces the earlier entry', { timeout: 60000 }, async t => {
  const directory = await temporary(t)
  const { home, tools, nodes } = await fakeMachine(directory)
  const copy = await releaseCopy(directory)
  const path = join(directory, 'acp.json')
  const env = { HOME: home, PATH: [nodes, tools, '/usr/bin', '/bin'].join(delimiter), [ACP_CONFIG_VARIABLE]: path }
  const install = () => run(['install', join(directory, 'state')], env, [], join(copy, 'bin', 'megachat.mjs'))
  const ide = 'The IDE starts Megachat with npx and with its own Node.js, not with the Node.js of this terminal.'
  const last = `This install ran Megachat ${manifest.version} from ${copy}. The IDE uses a copy of its own in its npm cache.`
  const macOS = process.platform === 'darwin'

  const first = await install()
  assert.equal(first.code, macOS ? 0 : 1, first.stdout + first.stderr)
  assert.deepEqual(RELEASE_ENTRY, { command: 'npx', args: ['-y', 'github:ignatov/megachat#semver:x', 'acp'] })
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { agent_servers: { Megachat: RELEASE_ENTRY } })
  for (const line of [`Megachat created ${path} with the entry Megachat.`, ide]) assert.ok(first.stdout.includes(line), `${line}\n${first.stdout}`)
  assert.equal(first.stdout.trimEnd().split('\n').at(-1), last)

  const second = await install()
  assert.ok(second.stdout.includes(`Megachat is installed already: ${path} holds the same entry Megachat.`), second.stdout)

  await writeFile(path, JSON.stringify({ agent_servers: { Megachat: earlier } }))
  const replaced = await install()
  assert.equal(replaced.code, first.code, replaced.stdout + replaced.stderr)
  const backup = (await readdir(directory)).find(name => name.startsWith('acp.json.before-megachat-'))
  assert.ok(replaced.stdout.includes(`Megachat replaced the earlier entry Megachat in ${path}. That entry started an installed copy with Node.js. The earlier file is in ${join(directory, backup)}.`), replaced.stdout)
  assert.ok(replaced.stdout.includes(`"Megachat": ${JSON.stringify(earlier)}`), replaced.stdout)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { agent_servers: { Megachat: RELEASE_ENTRY } })
  assert.deepEqual(JSON.parse(await readFile(join(directory, backup), 'utf8')), { agent_servers: { Megachat: earlier } })

  // The entry of a checkout is a different entry: a developer uses it on purpose.
  const checkout = JSON.stringify({ agent_servers: { Megachat: { command: '/opt/homebrew/bin/node', args: ['/Users/me/src/megachat/bin/megachat.mjs', 'acp'] } } })
  await writeFile(path, checkout)
  const different = await install()
  assert.equal(different.code, 1)
  assert.ok(different.stdout.includes(`"Megachat": ${JSON.stringify(RELEASE_ENTRY)}`), different.stdout)
  assert.ok(!different.stdout.includes(ide), different.stdout)
  assert.equal(different.stdout.trimEnd().split('\n').at(-1), last)
  assert.equal(await readFile(path, 'utf8'), checkout)
})

import assert from 'node:assert/strict'
import { execFileSync, fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import manifest from '../package.json' with { type: 'json' }
import { DaemonClient, processEnded } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { megachatVersion } from '../src/MegachatBuild.mjs'
import { ACP_CONFIG_VARIABLE, checkoutEntry, overlayEntry, OVERLAY_VARIABLE, ownEntry, RELEASE_ENTRY, removeEntry, uninstall } from '../src/MegachatInstall.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { stopDaemon } from './stop-daemon.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
const launcher = fileURLToPath(new URL('../bin/megachat.mjs', import.meta.url))
const fakeDaemonScript = fileURLToPath(new URL('./uninstall-daemon.mjs', import.meta.url))
/** The entry that `install` 0.2.0 wrote. */
const earlier = { command: '/opt/homebrew/bin/node', args: ['/Users/me/.npm/_npx/ad3589aca26e8aac/node_modules/megachat/bin/megachat.mjs', 'acp'] }
/** The entry that `install` 0.3.0 and 0.4.0 wrote. */
const withoutTimeLimits = { command: 'npx', args: ['-y', 'github:ignatov/megachat#semver:x', 'acp'] }
/** The entry that `install` writes in a checkout of another directory. */
const checkout = { command: '/usr/local/bin/node', args: ['/opt/megachat/bin/megachat.mjs', 'acp'] }
const switchLine = message('uninstall.switch')
const failedLine = message('uninstall.failed')
const mode = async path => (await stat(path)).mode & 0o777
/**
 * A temporary directory of the test. The `t.after` hook stops a daemon of its directory `state` before the removal,
 * also after a timeout or a failed assertion.
 */
const temporary = async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-uninstall-')))
  t.after(async () => {
    try { await stopDaemon(join(directory, 'state')) }
    finally { await rm(directory, { force: true, recursive: true }) }
  })
  return directory
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

function run(args, env, command = launcher) {
  const child = spawn(process.execPath, [command, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.on('data', chunk => { stderr += chunk })
  return once(child, 'exit').then(([code]) => ({ code, stdout, stderr, lines: stdout.trimEnd().split('\n') }))
}

/** Runs `uninstall` in this process. The lines go to `lines`. */
async function uninstallHere(path, state, options = {}) {
  const lines = []
  const code = await uninstall({ environment: { [ACP_CONFIG_VARIABLE]: path }, directory: state, print: line => lines.push(line), ...options })
  return { code, lines, text: lines.join('\n') }
}

/**
 * Starts the fake daemon of `uninstall-daemon.mjs` on [state]. `work` sends the value of `/state`. A `t.after` hook
 * kills the process when it still runs.
 */
async function fakeDaemon(t, state, daemonMode = 'end') {
  const child = fork(fakeDaemonScript, [state, daemonMode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL') })
  const [ready] = await once(child, 'message')
  assert.equal(ready, 'ready')
  const health = async () => {
    const client = await DaemonClient.connect(state)
    return client.json('/health', undefined, AbortSignal.timeout(2000))
  }
  const work = async value => { child.send(value); await once(child, 'message') }
  return { child, pid: child.pid, health, work, exited: once(child, 'exit') }
}

const file = (servers, extra = {}) => JSON.stringify({ agent_servers: servers, ...extra })

test('uninstall removes each entry of install and keeps the other entries in their order', async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  for (const [index, entry] of [RELEASE_ENTRY, withoutTimeLimits, earlier, checkout].entries()) {
    await writeFile(path, file({ First: { command: '/bin/first' }, Megachat: entry, Last: { command: '/bin/last' } }))
    const result = await removeEntry(path, new Date(Date.UTC(2026, 10, 19, 9, 8, index)))
    assert.equal(result.status, 'removed', JSON.stringify(entry))
    assert.deepEqual(result.existing, entry)
    assert.deepEqual(Object.keys(JSON.parse(await readFile(path, 'utf8')).agent_servers), ['First', 'Last'])
  }
})

test('the entry of a checkout has only a node command and the arguments bin/megachat.mjs and acp', () => {
  assert.equal(checkoutEntry(checkout), true)
  assert.equal(checkoutEntry({ command: 'C:\\node\\node.exe', args: ['C:\\src\\megachat\\bin\\megachat.mjs', 'acp'] }), true)
  assert.equal(checkoutEntry(earlier), true)
  assert.equal(checkoutEntry({ ...checkout, application_session: true }), false)
  assert.equal(checkoutEntry({ ...checkout, env: { HTTPS_PROXY: 'http://proxy.example.com:3128' } }), false)
  assert.equal(checkoutEntry({ command: checkout.command, args: ['/Users/me/src/megachat/src/main.mjs', 'acp'] }), false)
  assert.equal(checkoutEntry({ command: checkout.command, args: [...checkout.args, '/tmp/state'] }), false)
  assert.equal(checkoutEntry({ command: '/usr/bin/env', args: checkout.args }), false)
  assert.equal(checkoutEntry({ command: checkout.command, args: ['/opt/megachat/bin/other.mjs', 'acp'] }), false)
  for (const entry of [RELEASE_ENTRY, withoutTimeLimits, earlier, checkout]) assert.equal(ownEntry(entry), true)
  assert.equal(ownEntry({ ...withoutTimeLimits, env: { HTTPS_PROXY: 'http://proxy.example.com:3128' } }), false)
  assert.equal(ownEntry({ ...RELEASE_ENTRY, env: { ...RELEASE_ENTRY.env, HTTPS_PROXY: 'http://proxy.example.com:3128' } }), false)
})

test('the removal copies the file first, and keeps each other key, the key order, the mode and the file', async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  const original = JSON.stringify({ default_mcp_settings: { a: 1 }, agent_servers: { Other: { command: '/bin/other' }, Megachat: RELEASE_ENTRY }, z: true })
  await writeFile(path, original, { mode: 0o640 })
  await chmod(path, 0o640)
  const result = await removeEntry(path, new Date('2026-11-19T09:08:07.654Z'))
  assert.deepEqual(result, { status: 'removed', backup: join(directory, 'acp.json.before-megachat-20261119T090807Z'), existing: RELEASE_ENTRY })
  assert.equal(await readFile(result.backup, 'utf8'), original)
  assert.equal(await mode(result.backup), 0o640)
  const text = await readFile(path, 'utf8')
  assert.equal(text, `${JSON.stringify({ default_mcp_settings: { a: 1 }, agent_servers: { Other: { command: '/bin/other' } }, z: true }, null, 2)}\n`)
  assert.deepEqual(Object.keys(JSON.parse(text)), ['default_mcp_settings', 'agent_servers', 'z'])
  assert.equal(await mode(path), 0o640)

  // The only entry leaves an empty agent_servers, and the file stays.
  await writeFile(path, file({ Megachat: RELEASE_ENTRY }))
  assert.equal((await removeEntry(path, new Date('2026-11-19T09:08:08Z'))).status, 'removed')
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { agent_servers: {} })
})

test('uninstall keeps another entry and a file that is not JSON, prints the entry, and stops no daemon', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  const state = join(directory, 'state')
  const daemon = await fakeDaemon(t, state)
  const other = { ...checkout, application_session: true }
  const proxy = { ...withoutTimeLimits, env: { HTTPS_PROXY: 'http://proxy.example.com:3128' } }
  for (const text of [file({ Megachat: other }), file({ Megachat: proxy }), '{ "agent_servers": ']) {
    await writeFile(path, text)
    const result = await uninstallHere(path, state)
    assert.equal(result.code, 1, result.text)
    assert.equal(await readFile(path, 'utf8'), text)
    if (text.includes('application_session')) {
      assert.ok(result.lines.includes(`"Megachat": ${JSON.stringify(other)}`), result.text)
      assert.match(result.text, /Remove the entry Megachat by hand/)
    }
    // The line before the switch line names the reason of the exit code 1.
    assert.equal(result.lines.at(-3), failedLine)
    assert.equal(result.lines.at(-2), switchLine)
    assert.equal((await daemon.health()).pid, daemon.pid)
  }
  assert.deepEqual((await readdir(directory)).sort(), ['acp.json', 'state'])
})

test('uninstall refuses while a child run or a turn runs, and removes the entry after its end', { timeout: 60000 }, async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  const state = join(directory, 'state')
  const text = file({ Megachat: RELEASE_ENTRY })
  await writeFile(path, text)
  const daemon = await fakeDaemon(t, state)
  const run1 = { id: 'run-1', agent: 'claude', status: 'running', title: 'Fix the build' }
  const done = { id: 'run-0', agent: 'codex', status: 'completed', title: 'Earlier task' }
  await daemon.work({ current: null, runs: { [done.id]: done, [run1.id]: run1 } })
  const busy = await run(['uninstall', state], { [ACP_CONFIG_VARIABLE]: path })
  assert.equal(busy.code, 1, busy.stdout + busy.stderr)
  assert.ok(busy.stdout.includes(`Megachat did not change ${path}, because work runs.`), busy.stdout)
  assert.ok(busy.lines.includes('- The child run run-1 of claude is running: Fix the build'), busy.stdout)
  assert.ok(!busy.stdout.includes('run-0'), busy.stdout)
  assert.equal(await readFile(path, 'utf8'), text)
  assert.equal((await daemon.health()).pid, daemon.pid)

  await daemon.work({ current: { id: 'turn', requestId: 'turn', cancelling: false, kind: 'user' }, runs: { [done.id]: done } })
  const turn = await uninstallHere(path, state)
  assert.equal(turn.code, 1, turn.text)
  assert.ok(turn.lines.includes('- A turn of the main agent runs.'), turn.text)
  assert.equal(await readFile(path, 'utf8'), text)

  await daemon.work({ current: null, runs: { [done.id]: done, [run1.id]: { ...run1, status: 'completed' } } })
  const removed = await run(['uninstall', state], { [ACP_CONFIG_VARIABLE]: path })
  assert.equal(removed.code, 0, removed.stdout + removed.stderr)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { agent_servers: {} })
  assert.ok(removed.stdout.includes(`Megachat stopped its daemon (process ${daemon.pid}).`), removed.stdout)
  await daemon.exited
  assert.equal(alive(daemon.pid), false)
})

test('uninstall without an entry stops the daemon of the state directory', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  const state = join(directory, 'state')
  const text = file({ Other: { command: '/bin/other' } })
  await writeFile(path, text)
  const daemon = await fakeDaemon(t, state)
  const result = await run(['uninstall', state], { [ACP_CONFIG_VARIABLE]: path })
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.ok(result.lines.includes(`${path} has no entry Megachat.`), result.stdout)
  assert.ok(result.lines.includes(`Megachat stopped its daemon (process ${daemon.pid}).`), result.stdout)
  await daemon.exited
  assert.equal(alive(daemon.pid), false)
  assert.equal(await readFile(path, 'utf8'), text)
})

test('uninstall exits with 1 when the daemon does not end in the time limit', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  const state = join(directory, 'state')
  await writeFile(path, file({ Megachat: RELEASE_ENTRY }))
  const daemon = await fakeDaemon(t, state, 'stay')
  const result = await uninstallHere(path, state, { stopTimeoutMs: 1000 })
  assert.equal(result.code, 1, result.text)
  assert.ok(result.lines.includes(`The Megachat daemon did not stop in 1 seconds (process ${daemon.pid}). Run the command stop, then run the uninstall again.`),
    result.text)
  assert.equal(result.lines.at(-3), failedLine)
  assert.equal(alive(daemon.pid), true)
  daemon.child.kill('SIGKILL')
  await daemon.exited
})

test('the wait for the end of a daemon gives false after its time limit, and true after the end', async () => {
  const started = Date.now()
  assert.equal(await processEnded(process.pid, 300), false)
  assert.ok(Date.now() - started >= 300)
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  await once(child, 'exit')
  assert.equal(await processEnded(child.pid, 300), true)
})

test('a second uninstall says that Megachat is not installed, and a missing acp.json stays missing', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  const state = join(directory, 'state')
  await writeFile(path, file({ Megachat: RELEASE_ENTRY }))
  const first = await run(['uninstall', state], { [ACP_CONFIG_VARIABLE]: path })
  assert.equal(first.code, 0, first.stdout + first.stderr)
  const text = await readFile(path, 'utf8')
  const second = await run(['uninstall', state], { [ACP_CONFIG_VARIABLE]: path })
  assert.equal(second.code, 0, second.stdout + second.stderr)
  assert.ok(second.stdout.includes(`Megachat is not installed: ${path} has no entry Megachat, and no daemon runs.`), second.stdout)
  assert.equal(await readFile(path, 'utf8'), text)
  // Each output has the line about the switch of Air directly before the last line.
  for (const result of [first, second]) {
    assert.ok(result.lines.at(-2).includes('the Agents page of the Air settings'), result.stdout)
    assert.ok(result.lines.at(-2).includes('the daemon continues to run'), result.stdout)
    assert.equal(result.lines.at(-1), `This uninstall ran Megachat ${megachatVersion()} from ${root.replace(/\/$/, '')}.`)
  }
  // Without a daemon, the command does not open the state, so the state directory does not come into existence.
  assert.equal(existsSync(state), false)

  const missing = join(directory, 'jetbrains', 'acp.json')
  const none = await run(['uninstall', state], { [ACP_CONFIG_VARIABLE]: missing })
  assert.equal(none.code, 0, none.stdout + none.stderr)
  assert.ok(none.stdout.includes(`Megachat is not installed: ${missing}`), none.stdout)
  assert.equal(existsSync(join(directory, 'jetbrains')), false)
  assert.equal(existsSync(state), false)
})

test('uninstall from this checkout removes the entry of another checkout', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const path = join(directory, 'acp.json')
  await writeFile(path, file({ Megachat: checkout }))
  const result = await run(['uninstall', join(directory, 'state')], { [ACP_CONFIG_VARIABLE]: path })
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const backup = (await readdir(directory)).find(name => name.startsWith('acp.json.before-megachat-'))
  assert.ok(result.lines.includes(`Megachat removed the entry Megachat from ${path}. The earlier file is in ${join(directory, backup)}.`), result.stdout)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { agent_servers: {} })
})

test('uninstall removes the overlay entry of a checkout and keeps an overlay entry of the user and a file with comments', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const overlay = join(directory, 'overlay.json')
  const claude = { agent: { distribution: { local: { command: 'node', args: ['/x.js'] } } } }
  await writeFile(overlay, JSON.stringify({ agents: { 'acp.registry.claude-acp': claude, 'acp.registry.megachat-acp': overlayEntry(checkout) } }))
  const env = { [ACP_CONFIG_VARIABLE]: join(directory, 'acp.json'), [OVERLAY_VARIABLE]: overlay }
  const result = await run(['uninstall', join(directory, 'state')], env)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  const backup = (await readdir(directory)).find(name => name.startsWith('overlay.json.before-megachat-'))
  assert.ok(result.lines.includes(`Megachat removed the overlay entry of the registry agent Megachat from ${overlay}. The earlier file is in ${join(directory, backup)}.`), result.stdout)
  assert.deepEqual(JSON.parse(await readFile(overlay, 'utf8')), { agents: { 'acp.registry.claude-acp': claude } })
  // acp.json has no entry, but the overlay entry was a part of Megachat, so the line is not "not installed".
  assert.ok(result.lines.includes(`${join(directory, 'acp.json')} has no entry Megachat.`), result.stdout)

  const user = JSON.stringify({ agents: { 'acp.registry.megachat-acp': { agent: { distribution: { local: { ...checkout, env: { A: '1' } } } } } } })
  await writeFile(overlay, user)
  const kept = await run(['uninstall', join(directory, 'state')], env)
  assert.equal(kept.code, 0, kept.stdout + kept.stderr)
  assert.equal(await readFile(overlay, 'utf8'), user)

  // A file with comments stays, because a write of the JSON loses them.
  const commented = `// The checkout of Megachat.\n${JSON.stringify({ agents: { 'acp.registry.megachat-acp': overlayEntry(checkout) } })}\n`
  await writeFile(overlay, commented)
  const refused = await run(['uninstall', join(directory, 'state')], env)
  assert.equal(refused.code, 0, refused.stdout + refused.stderr)
  assert.equal(await readFile(overlay, 'utf8'), commented)
})

test('an unexpected error of uninstall prints its message and the steps by hand', { skip: process.getuid?.() === 0, timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const folder = join(directory, 'jetbrains')
  await mkdir(folder)
  const path = join(folder, 'acp.json')
  const text = file({ Megachat: RELEASE_ENTRY })
  await writeFile(path, text)
  await chmod(folder, 0o500)
  let result
  // The removal of the directory of the test needs the write permission again.
  try { result = await run(['uninstall', join(directory, 'state')], { [ACP_CONFIG_VARIABLE]: path }) }
  finally { await chmod(folder, 0o700) }
  assert.equal(result.code, 1, result.stdout + result.stderr)
  assert.match(result.stderr, /^The uninstall stopped with an error: .*EACCES.* Remove the entry Megachat from acp\.json by hand, then run the command stop\.\n$/)
  assert.equal(await readFile(path, 'utf8'), text)
})

/** A home with fake Central, Claude Code and Codex commands, so that the checks of `install` pass without the real tools. */
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
  return { HOME: home, PATH: [nodes, tools, '/usr/bin', '/bin'].join(delimiter) }
}

/** A copy of the files of the package without `.git`, as npx installs it. It uses the dependencies of this checkout. */
async function releaseCopy(directory) {
  const copy = join(directory, 'copy')
  for (const name of ['package.json', 'bin', 'src', 'resources']) await cp(join(root, name), join(copy, name), { recursive: true })
  await symlink(join(root, 'node_modules'), join(copy, 'node_modules'))
  return copy
}

test('uninstall after install in a copy without .git removes the npx entry and stops the daemon, and starts none', { timeout: 120000 }, async t => {
  const directory = await temporary(t)
  const state = join(directory, 'state')
  const copy = await releaseCopy(directory)
  const copyLauncher = join(copy, 'bin', 'megachat.mjs')
  const path = join(directory, 'acp.json')
  const env = { ...await fakeMachine(directory), [ACP_CONFIG_VARIABLE]: path, MEGACHAT_LEGACY_DIRS: '' }
  await run(['install', state], env, copyLauncher)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { agent_servers: { Megachat: RELEASE_ENTRY } })
  const started = await run(['start', state], env, copyLauncher)
  assert.equal(started.code, 0, started.stdout + started.stderr)
  const { pid } = JSON.parse(await readFile(join(state, 'daemon', 'connection.json'), 'utf8'))

  const result = await run(['uninstall', state], env, copyLauncher)
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { agent_servers: {} })
  assert.equal(alive(pid), false)
  assert.ok(result.lines.includes(`Megachat stopped its daemon (process ${pid}).`), result.stdout)
  assert.ok(result.stdout.includes(`The state directory ${state} stays`), result.stdout)
  assert.ok(result.stdout.includes('npx -y "github:ignatov/megachat#semver:x" install'), result.stdout)
  assert.equal(result.lines.at(-1), `This uninstall ran Megachat ${manifest.version} from ${copy}.`)
  // No new daemon starts.
  await delay(500)
  assert.equal(existsSync(join(state, 'daemon', 'connection.json')), false)
})

test('uninstall keeps the state, and install and start bring back the same conversation', { timeout: 120000 }, async t => {
  const directory = await temporary(t)
  const state = join(directory, 'state')
  await mkdir(state, { mode: 0o700 })
  await writeFile(join(state, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'memory.reflection': false } }), { mode: 0o600 })
  await writeFile(join(state, 'memory.md'), '# Memory\n\n- The user likes kiwi.\n', { mode: 0o600 })
  // The conversation of an earlier daemon, with a faux model.
  {
    const fake = fauxProvider()
    fake.setResponses([fauxAssistantMessage('I remember it.')])
    const models = createModels()
    models.setProvider(fake.provider)
    const model = fake.getModel()
    const service = await PiMegachatService.open(await openNodeSqliteStorage(join(state, 'conversation.sqlite')), models,
      { provider: model.provider, modelId: model.id }, {}, { settingsPath: join(state, 'settings.json'), keepAlive: { enabled: false }, environment: {} })
    await service.resume()
    const server = new DaemonServer(service)
    const client = new DaemonClient(await server.listen())
    const receipt = await service.submit('kiwi', 'Remember the word kiwi')
    await client.json(`/wait?submission=${receipt.submissionId}`)
    await waitForState(service.state, value => value.current === null ? true : undefined)
    await server.close()
    await service.close()
  }
  const path = join(directory, 'acp.json')
  const env = { ...await fakeMachine(directory), [ACP_CONFIG_VARIABLE]: path, MEGACHAT_LEGACY_DIRS: '' }
  const history = async () => {
    const client = await DaemonClient.connect(state)
    return JSON.stringify(await client.json('/history?before=1000000'))
  }
  await run(['install', state], env)
  assert.equal((await run(['start', state], env)).code, 0)
  assert.ok((await history()).includes('Remember the word kiwi'))
  const memory = await readFile(join(state, 'memory.md'), 'utf8')
  const settings = await readFile(join(state, 'settings.json'), 'utf8')

  const removed = await run(['uninstall', state], env)
  assert.equal(removed.code, 0, removed.stdout + removed.stderr)
  assert.equal(existsSync(join(state, 'conversation.sqlite')), true)
  // The install below can run in the same second, and its copy must not find the copy of the uninstall.
  for (const name of (await readdir(directory)).filter(item => item.startsWith('acp.json.before-megachat-'))) await rm(join(directory, name))

  const installed = await run(['install', state], env)
  assert.ok(installed.stdout.includes(`Megachat added the entry Megachat to ${path}.`), installed.stdout)
  assert.equal((await run(['start', state], env)).code, 0)
  assert.ok((await history()).includes('Remember the word kiwi'))
  assert.equal(await readFile(join(state, 'memory.md'), 'utf8'), memory)
  assert.equal(await readFile(join(state, 'settings.json'), 'utf8'), settings)
})

test('uninstall in a checkout after the release tag gives the version with the count of commits and the commit', { timeout: 60000 }, async t => {
  const directory = await temporary(t)
  const copy = await releaseCopy(directory)
  const git = (...args) => execFileSync('git', ['-C', copy, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', '-c', 'commit.gpgSign=false',
    '-c', 'tag.gpgSign=false', '-c', 'core.hooksPath=/dev/null', ...args], { encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } }).trim()
  await writeFile(join(copy, 'package.json'), `${JSON.stringify({ ...manifest, version: '0.3.0' }, null, 2)}\n`)
  git('init', '-q')
  git('add', 'package.json', 'bin', 'src', 'resources')
  git('commit', '-q', '-m', 'Megachat has the version 0.3.0')
  git('tag', 'v0.3.0')
  for (const text of ['First', 'Second']) {
    await writeFile(join(copy, 'notes.txt'), `${text}\n`)
    git('add', 'notes.txt')
    git('commit', '-q', '-m', text)
  }
  const commit = git('rev-parse', '--short=7', 'HEAD')
  assert.match(commit, /^[0-9a-f]{7}$/)
  const path = join(directory, 'acp.json')
  await writeFile(path, file({ Megachat: { command: process.execPath, args: [join(copy, 'bin', 'megachat.mjs'), 'acp'] } }))
  const result = await run(['uninstall', join(directory, 'state')], { [ACP_CONFIG_VARIABLE]: path }, join(copy, 'bin', 'megachat.mjs'))
  assert.equal(result.code, 0, result.stdout + result.stderr)
  assert.equal(result.lines.at(-1), `This uninstall ran Megachat 0.3.0+2.g${commit} from ${copy}.`)
})

test('the rules of the main agent give the line of uninstall and tell about the switch of Air', async t => {
  const fake = fauxProvider()
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { keepAlive: { enabled: false }, environment: {} })
  t.after(() => service.close())
  const rule = message('instructions.uninstall')
  assert.ok(rule.includes('npx -y "github:ignatov/megachat#semver:x" uninstall'), rule)
  assert.ok(rule.includes('Agents page'), rule)
  assert.match(rule, /remove yourself/)
  assert.match(rule, /no child task/)
  assert.ok((await service.root.agent(BACKGROUND_CONTEXT)).sections.find(item => item.key === 'settings').render().includes(rule))
})

import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test, { after } from 'node:test'
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { DaemonClient, processAlive } from '../src/DaemonClient.mjs'
import { message } from '../src/messages.mjs'

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url))
const daemonScript = fileURLToPath(new URL('./agent-stop-daemon.mjs', import.meta.url))
const fakeDaemonScript = fileURLToPath(new URL('./uninstall-daemon.mjs', import.meta.url))

// The timers of the bridge and of the daemon are unref'd. Node.js 22 fails a test that waits for them while nothing else
// holds the event loop, so this file holds the loop until its last test ends.
const hold = setInterval(() => {}, 1000)
after(() => clearInterval(hold))

async function poll(select, attempts = 300) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    const result = await select()
    if (result) return result
    await delay(20)
  }
  assert.fail('The process did not reach the expected state')
}

/** A temporary state directory. The hook ends each process of the test before the removal. */
async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-agent-stop-')))
  const processes = []
  t.after(async () => {
    for (const child of processes) {
      if (child.exitCode !== null || child.signalCode !== null) continue
      const exited = once(child, 'exit')
      child.kill('SIGKILL')
      await exited
    }
    await rm(directory, { force: true, recursive: true })
  })
  return { directory, processes }
}

/** Starts the daemon of `agent-stop-daemon.mjs` on the state directory, and waits until it published its connection. */
async function startDaemon({ directory, processes }, mode = 'idle') {
  const child = fork(daemonScript, [directory, mode], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  processes.push(child)
  const exited = once(child, 'exit')
  const [ready] = await once(child, 'message')
  assert.equal(ready, 'ready')
  return { child, pid: child.pid, exited, client: await DaemonClient.connect(directory) }
}

/** Starts `acp` on the state directory, and gives an ACP connection with `initialize` done. `updates` holds each update. */
async function startBridge({ directory, processes }) {
  const bridge = spawn(process.execPath, [main, 'acp', directory], { stdio: ['pipe', 'pipe', 'pipe'] })
  processes.push(bridge)
  let errors = ''
  bridge.stderr.on('data', chunk => { errors += chunk })
  const updates = []
  const connection = client({ name: 'test-ide' })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update) })
    .onRequest(methods.client.session.requestPermission, () => new Promise(() => {}))
    .connect(ndJsonStream(Writable.toWeb(bridge.stdin), Readable.toWeb(bridge.stdout)))
  const exited = once(bridge, 'exit')
  const initialized = await connection.agent.request(methods.agent.initialize, { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } } })
  const view = async () => (await connection.agent.request(methods.agent.session.new, { cwd: directory, mcpServers: [] })).sessionId
  const prompt = (sessionId, text) => connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })
  return { bridge, connection, updates, exited, initialized, view, prompt, errors: () => errors }
}

/** The texts of the user messages of the replay of a view. */
const userTexts = updates => updates.filter(update => update.sessionUpdate === 'user_message_chunk').map(update => update.content.text)

test('the answer to initialize holds the capability agentStop for each client', async t => {
  const connection = client({ name: 'test-air' }).connect(new AcpBridge({}).app())
  t.after(() => connection.close())
  const air = await connection.agent.request(methods.agent.initialize, { protocolVersion: 1,
    clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities: [] } } } } })
  assert.deepEqual(air._meta.jetbrains.air.capabilities, ['persistentSession', 'agentStop'])
  const plain = await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  assert.deepEqual(plain._meta.jetbrains.air.capabilities, ['persistentSession', 'agentStop'])
})

test('_agent/stop stops a daemon without work, keeps the state, and the next start opens the same conversation', { timeout: 60000 }, async t => {
  const fixture = await temporary(t)
  const { directory } = fixture
  const settings = JSON.stringify({ schema: 1, onboarding: 'done', defaults: 2, values: { 'reply.length': 'detailed' } })
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'settings.json'), settings, { mode: 0o600 })
  await writeFile(join(directory, 'memory.md'), '- The user likes short answers.\n', { mode: 0o600 })
  const daemon = await startDaemon(fixture)
  const first = await startBridge(fixture)
  const second = await startBridge(fixture)
  const sessionId = await first.view()
  await second.view()
  await first.prompt(sessionId, 'Work')
  assert.deepEqual(await first.connection.agent.request('_agent/stop', {}), { stopped: true })
  // The daemon ended before the answer, and its connection file is gone.
  assert.equal(processAlive(daemon.pid), false)
  assert.deepEqual(await daemon.exited, [0, null])
  assert.equal(existsSync(join(directory, 'daemon', 'connection.json')), false)
  assert.deepEqual(await first.exited, [0, null])
  assert.ok(first.errors().includes(message('log.agentStopped')), first.errors())
  assert.equal(first.errors().includes(message('log.daemonGone')), false)
  // The second client of the daemon ends too, and it starts no daemon.
  await second.exited
  assert.match(second.errors(), /Megachat lost its local event connection|The Megachat daemon is gone/)
  assert.equal(existsSync(join(directory, 'daemon', 'connection.json')), false)
  // The state stays: the files are unchanged, and a new start shows the same conversation.
  assert.equal(await readFile(join(directory, 'settings.json'), 'utf8'), settings)
  assert.equal(await readFile(join(directory, 'memory.md'), 'utf8'), '- The user likes short answers.\n')
  await startDaemon(fixture)
  const again = await startBridge(fixture)
  await again.view()
  assert.deepEqual(userTexts(again.updates), ['Work'])
})

test('_agent/stop refuses while a child run waits, and nothing changes', { timeout: 60000 }, async t => {
  const fixture = await temporary(t)
  const daemon = await startDaemon(fixture, 'child')
  const view = await startBridge(fixture)
  const sessionId = await view.view()
  view.prompt(sessionId, 'Work').catch(() => {})
  const permission = await poll(async () => Object.values((await daemon.client.json('/state')).permissions)[0])
  assert.equal(permission.status, 'pending')
  await poll(async () => (await daemon.client.json('/state')).current === null)
  assert.deepEqual(await view.connection.agent.request('_agent/stop', {}), { stopped: false,
    reason: 'Megachat has work that runs: 1 child task. Stop the work or wait for its end, then remove Megachat again.' })
  assert.equal(processAlive(daemon.pid), true)
  assert.equal(Object.values((await daemon.client.json('/state')).permissions)[0].status, 'pending')
  // The connection stays, so a second request gets the same answer.
  assert.equal((await view.connection.agent.request('_agent/stop', {})).stopped, false)
  assert.equal(view.bridge.exitCode, null)
})

test('_agent/stop refuses while a turn runs, and the turn continues', { timeout: 60000 }, async t => {
  const fixture = await temporary(t)
  const daemon = await startDaemon(fixture, 'turn')
  const view = await startBridge(fixture)
  const sessionId = await view.view()
  const prompting = view.prompt(sessionId, 'Work')
  await poll(async () => (await daemon.client.json('/state')).current !== null)
  const answer = await view.connection.agent.request('_agent/stop', {})
  assert.deepEqual(answer, { stopped: false,
    reason: 'Megachat has work that runs: a turn. Stop the work or wait for its end, then remove Megachat again.' })
  assert.equal(processAlive(daemon.pid), true)
  daemon.child.send('release')
  assert.equal((await prompting).stopReason, 'end_turn')
})

test('_agent/stop answers false and keeps the connection when the daemon does not end', { timeout: 30000 }, async t => {
  const fixture = await temporary(t)
  const child = fork(fakeDaemonScript, [fixture.directory, 'stay'], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  fixture.processes.push(child)
  assert.equal((await once(child, 'message'))[0], 'ready')
  const bridge = new AcpBridge(await DaemonClient.connect(fixture.directory), { stopTimeoutMs: 200 })
  const connection = client({ name: 'test-air' }).connect(bridge.app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  const answer = await connection.agent.request('_agent/stop', {})
  assert.equal(answer.stopped, false)
  assert.ok(answer.reason.includes(String(child.pid)), answer.reason)
  assert.equal(processAlive(child.pid), true)
  // The connection stays open: the bridge answers a new request.
  assert.equal((await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })).agentInfo.title, 'Megachat')
  assert.equal(bridge.ended, undefined)
})

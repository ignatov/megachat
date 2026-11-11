import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { client, methods, ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import manifest from '../package.json' with { type: 'json' }
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonDirectory } from '../src/DaemonDirectory.mjs'
import { message as continuationPrompt } from '../src/messages.mjs'
import { stopDaemon } from './stop-daemon.mjs'

async function poll(select) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await select()
    if (result) return result
    await delay(20)
  }
  assert.fail('The process did not reach the expected state')
}

test('concurrent ACP opens start one daemon without a separate start command', { timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-start-'))
  t.after(async () => {
    try { await stopDaemon(directory) }
    finally { await rm(directory, { force: true, recursive: true }) }
  })
  const initialize = async () => {
    const bridge = spawn(process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'acp', directory])
    t.after(() => bridge.kill())
    let output = ''
    let errors = ''
    bridge.stdout.on('data', chunk => { output += chunk })
    bridge.stderr.on('data', chunk => { errors += chunk })
    const exited = once(bridge, 'exit')
    bridge.stdin.end(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {
      protocolVersion: 1, clientCapabilities: {},
    } })}\n`)
    const [code] = await exited
    assert.equal(code, 0, errors)
    const { agentInfo } = JSON.parse(output).result
    assert.equal(agentInfo.title, 'Megachat')
    assert.equal(agentInfo.version, manifest.version)
  }
  await Promise.all([initialize(), initialize()])
  const daemon = await DaemonClient.connect(directory)
  assert.equal((await daemon.json('/state')).current, null)
})

for (const [stop, code] of [['signal', 0], ['storage', 1]]) {
  test(`a daemon that gets a ${stop} stop during its start exits, and leaves no lock and no connection file`, { timeout: 20000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'megachat-stop-start-'))
    const daemon = spawn(process.execPath, ['--import', fileURLToPath(new URL('./stop-during-start.mjs', import.meta.url)),
      fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'daemon', directory],
    { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, MEGACHAT_TEST_STOP: stop } })
    let errors = ''
    daemon.stderr.on('data', chunk => { errors += chunk })
    const exited = once(daemon, 'exit')
    t.after(async () => {
      if (daemon.exitCode === null && daemon.signalCode === null) {
        daemon.kill('SIGKILL')
        await exited
      }
      await rm(directory, { force: true, recursive: true })
    })
    // After a storage error, a timer of the daemon ends a stop that does not return after 10 seconds. The wait is shorter.
    const result = await Promise.race([exited, delay(8000, 'running', { ref: false })])
    assert.notEqual(result, 'running', 'The daemon did not exit after the stop in its start')
    assert.deepEqual(result, [code, null], errors)
    await assert.rejects(readFile(join(directory, 'daemon', 'connection.json')), { code: 'ENOENT' })
    // A new daemon gets the lock.
    await (await DaemonDirectory.acquire(directory)).close()
  })
}

test('bridge exit preserves work and SIGKILL continues the child session without repeating a dispatch', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-recovery-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  let process
  const start = async () => {
    process = fork(new URL('./fake-daemon.mjs', import.meta.url), [directory], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
    const message = once(process, 'message')
    await message
    return DaemonClient.connect(directory)
  }
  t.after(async () => {
    if (process?.exitCode === null && process?.signalCode === null) {
      const exited = once(process, 'exit')
      process.kill('SIGTERM')
      await exited
    }
  })
  let daemon = await start()
  const bridge = spawn(globalThis.process.execPath, [fileURLToPath(new URL('../src/main.mjs', import.meta.url)), 'acp', directory],
    { stdio: ['pipe', 'pipe', 'inherit'] })
  const connection = client({ name: 'test-ide' })
    .onNotification(methods.client.session.update, () => {})
    .onRequest(methods.client.session.requestPermission, () => new Promise(() => {}))
    .connect(ndJsonStream(Writable.toWeb(bridge.stdin), Readable.toWeb(bridge.stdout)))
  t.after(() => { connection.close(); bridge.kill() })
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd: directory, mcpServers: [] })
  const prompting = connection.agent.request(methods.agent.session.prompt, {
    sessionId, prompt: [{ type: 'text', text: 'Work' }],
    _meta: { jetbrains: { air: { clientMessageId: 'original' } } },
  }).catch(() => {})
  const permission = await poll(async () => Object.values((await daemon.json('/state')).permissions)[0])
  assert.equal(permission.status, 'pending')
  const childPid = Number(await readFile(join(directory, 'agent.pid'), 'utf8'))
  const bridgeExited = once(bridge, 'exit')
  bridge.kill('SIGKILL')
  connection.close()
  await bridgeExited
  await prompting
  const stateWithoutIde = await daemon.json('/state')
  const receipt = stateWithoutIde.inputs.original
  assert.equal(stateWithoutIde.permissions[permission.id].status, 'pending')
  globalThis.process.kill(childPid, 0)
  const exited = once(process, 'exit')
  process.kill('SIGKILL')
  await exited
  await poll(() => {
    try { globalThis.process.kill(childPid, 0); return false }
    catch (error) { if (error.code === 'ESRCH') return true; throw error }
  })
  daemon = await start()
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  const state = await poll(async () => {
    const value = await daemon.json('/state')
    return Object.values(value.runs).at(-1).status === 'completed' ? value : null
  })
  const [interrupted, continued] = Object.values(state.runs)
  assert.equal(interrupted.status, 'resumed')
  assert.equal(interrupted.resumedBy, continued.id)
  assert.equal(continued.providerSessionId, interrupted.providerSessionId)
  assert.equal(state.permissions[permission.id].status, 'stale')
  assert.equal((await daemon.json('/input', { requestId: 'original', text: 'Work' })).submissionId, receipt.submissionId)
  assert.equal(await readFile(join(directory, 'dispatches'), 'utf8'), `approval\n${continuationPrompt('child.continue')}\n\n${continuationPrompt('child.task')}\napproval\n`)
})

test('a result report that SIGKILL of the daemon cuts is sent once more after the restart', { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-report-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const run = mode => fork(new URL('./report-daemon.mjs', import.meta.url), [mode, join(directory, 'conversation.sqlite')],
    { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] })
  const first = run('first')
  t.after(() => first.kill('SIGKILL'))
  await once(first, 'message')
  const exited = once(first, 'exit')
  first.kill('SIGKILL')
  await exited
  const second = run('second')
  t.after(() => second.kill('SIGKILL'))
  const [result] = await once(second, 'message')
  assert.deepEqual(result, { reports: [['interrupted', 'interrupted'], ['completed', null]], reported: [true] })
})

test('the supervisor stops a child that writes after the daemon closed the output', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-supervisor-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const pidFile = join(directory, 'child.pid')
  // The child ignores a closed output and writes again. So only the supervisor can stop it.
  const script = `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid))
    process.stdout.on('error', () => {})
    setInterval(() => process.stdout.write('x'.repeat(1024)), 1)`
  const supervisor = spawn(globalThis.process.execPath, [fileURLToPath(new URL('../src/child-supervisor.mjs', import.meta.url)),
    globalThis.process.execPath, '-e', script], { stdio: ['pipe', 'pipe', 'ignore', 'pipe'] })
  let childPid
  t.after(() => {
    supervisor.kill('SIGKILL')
    try { if (childPid) globalThis.process.kill(-childPid, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  })
  await once(supervisor.stdout, 'data')
  childPid = Number(await readFile(pidFile, 'utf8'))
  // The lifetime pipe stays open. So the closed output is the only sign that the daemon went away.
  supervisor.stdout.destroy()
  await poll(() => {
    try { globalThis.process.kill(childPid, 0); return false }
    catch (error) { if (error.code === 'ESRCH') return true; throw error }
  })
})

test('the supervisor stops the process group of an agent that ends by itself', { timeout: 10000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-supervisor-group-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const pidFile = join(directory, 'helper.pid')
  // The agent starts a helper in its process group, such as an MCP server, and ends at once.
  const supervisor = spawn(globalThis.process.execPath, [fileURLToPath(new URL('../src/child-supervisor.mjs', import.meta.url)),
    '/bin/sh', '-c', `sleep 47 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit 0`], { stdio: ['pipe', 'pipe', 'ignore', 'pipe'] })
  let helperPid
  t.after(() => {
    supervisor.kill('SIGKILL')
    try { if (helperPid) globalThis.process.kill(helperPid, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') throw error }
  })
  const [code] = await once(supervisor, 'exit')
  assert.equal(code, 0)
  helperPid = Number(await readFile(pidFile, 'utf8'))
  assert.ok(helperPid > 0)
  await poll(() => {
    try { globalThis.process.kill(helperPid, 0); return false }
    catch (error) { if (error.code === 'ESRCH') return true; throw error }
  })
})

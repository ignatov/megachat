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
  assert.equal(await readFile(join(directory, 'dispatches'), 'utf8'), `approval\n${continuationPrompt('child.continue')}\n`)
})

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { methods } from '@agentclientprotocol/sdk/unstable'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { ChildPool } from '../src/ChildPool.mjs'
import { ChildTranscripts, transcriptPath } from '../src/ChildTranscript.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { PiRunService } from '../src/PiRunService.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { call, fakeModels, MAIN } from './parallel-models.mjs'

const FAKE_ACP = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))

/**
 * A service with the ACP run service of the fake agent, the pi run service, and the transcripts in the private
 * directory `state/transcripts`. [child] gives the replies of a pi child. [limit] is the limit of a transcript.
 */
async function open(t, { child = [], limit, server = false, transcripts: directoryOf } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-transcript-')))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  const cwd = join(directory, 'project')
  await mkdir(cwd)
  await writeFile(join(cwd, 'README.md'), 'Hello from the README.')
  await mkdir(join(directory, 'state'), { mode: 0o700 })
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN } }), { mode: 0o600 })
  const { models } = fakeModels([], child)
  const service = await PiMegachatService.open(new MemoryStorage(), models, undefined, {}, { settingsPath: join(directory, 'settings.json'),
    spendPath: join(directory, 'spend.json'), keepAlive: { enabled: false }, environment: {}, resumeDelayMs: 0 })
  await service.state.addWorkspace(cwd)
  const path = directoryOf?.(directory) ?? join(directory, 'state', 'transcripts')
  const transcripts = new ChildTranscripts(path, { limit })
  await transcripts.start(service.state)
  const pool = new ChildPool()
  const pi = new PiRunService(service.state, service.harness, { agent: project => service.childAgent(project), pool, transcripts })
  const acp = new AcpRunService(service.state, { childLaunch: async () => ({ env: process.env }) }, { args: [FAKE_ACP], pool, transcripts })
  const daemonServer = server ? new DaemonServer(service) : undefined
  const daemon = daemonServer ? new DaemonClient(await daemonServer.listen()) : undefined
  await pi.start()
  await acp.start()
  await service.resume()
  t.after(async () => { await daemonServer?.close(); await acp.close(); await pi.close(); await transcripts.close(); await service.close() })
  return { directory, cwd, service, transcripts, path, daemon }
}

let turns = 0
/** Runs [operation] in a turn of the user of its own, as a tool call of the main agent does. */
async function userTurn(service, operation) {
  const id = `user-${++turns}`
  await waitForState(service.state, state => state.current ? undefined : true)
  await service.state.change(state => { state.current = { id, requestId: id, cancelling: false, kind: 'user' } })
  try { return await operation(id) }
  finally { await service.state.change(state => { if (state.current?.id === id) state.current = null }) }
}

const admit = (service, task) => userTurn(service, id => service.state.admitChild(`${id}:spawn`, task))
const ended = (service, runId) => waitForState(service.state, state => terminalStates.has(state.runs[runId]?.status) ? state : undefined, { timeoutMs: 15000 })
/** The fixed part of the line of the end of a run. */
const ENDED = message('transcript.ended', '', '').slice(3, -1)
/** The text of the transcript of [runId] after the end of its run, when the service wrote the end. */
async function transcriptOf(opened, runId) {
  await ended(opened.service, runId)
  const path = transcriptPath(opened.path, runId)
  for (;;) {
    const text = await readFile(path, 'utf8').catch(() => '')
    if (text.includes(ENDED)) return text
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}
/** The lines of [text] without the time of each event. */
const untimed = text => text.replace(/\[\d\d:\d\d:\d\d\]/g, '[time]')

test('the transcript of a Claude child holds the task, the tool calls, the messages without secrets, and the end, in a private file', { timeout: 15000 }, async t => {
  const opened = await open(t)
  const run = await admit(opened.service, { cwd: opened.cwd, prompt: 'tools', title: 'Read the README' })
  const text = untimed(await transcriptOf(opened, run.id))
  assert.ok(text.startsWith(`${message('transcript.title', 'Read the README')}\n${message('transcript.agent', 'Claude')}\n${message('transcript.project', opened.cwd)}\n`))
  for (const part of [`${message('transcript.task')}\ntools`, message('transcript.tool', 'time', 'Read', 'Read'),
    message('transcript.tool', 'time', 'Read', 'Read README.md'), message('transcript.tool', 'time', 'execute', 'npm test'),
    message('transcript.tool.failed', 'time', 'execute', 'npm test'), 'The README says hello.',
    `The key is ${message('sessions.secret')} in the file.`, message('transcript.ended', 'time', 'completed')]) {
    assert.ok(text.includes(part), part)
  }
  assert.ok(!text.includes('abcdefghijklmnopqrstuvwxyz'))
  assert.ok(text.indexOf('Read README.md') < text.indexOf('npm test') && text.indexOf('npm test') < text.indexOf('says hello'))
  assert.equal((await stat(transcriptPath(opened.path, run.id))).mode & 0o777, 0o600)
  assert.equal((await stat(opened.path)).mode & 0o777, 0o700)
})

test('the transcript of a Codex child shows the message that a steer added to its turn', { timeout: 15000 }, async t => {
  const opened = await open(t)
  const { service, cwd } = opened
  const run = await admit(service, { cwd, prompt: 'steer', agent: 'codex' })
  await waitForState(service.state, state => state.runs[run.id].status === 'dispatched' ? true : undefined)
  // The fake agent records the prompt when its turn runs.
  while (!(await readFile(join(cwd, 'dispatches'), 'utf8').catch(() => '')).includes('steer')) await new Promise(resolve => setTimeout(resolve, 10))
  const steered = await userTurn(service, () => service.steer('tool:steer:1', { childSessionId: run.childSessionId, prompt: 'Use the second file too.', mode: 'queue' }))
  assert.equal(steered.outcome, 'injected')
  const text = untimed(await transcriptOf(opened, run.id))
  assert.ok(text.includes(message('transcript.agent', 'Codex')))
  assert.ok(text.includes(`${message('transcript.steer', 'time')}\nUse the second file too.`))
  assert.ok(text.indexOf('Use the second file too.') < text.indexOf('steered: '))
  assert.ok(text.includes(message('transcript.ended', 'time', 'completed')))
})

test('the transcript of a pi child shows its tool calls, a steered message and its answer', { timeout: 30000 }, async t => {
  let release
  const opened = await open(t, { child: [() => new Promise(resolve => { release = () => resolve(call(['read', { path: 'README.md' }])) }),
    fauxAssistantMessage('The README says hello.')] })
  const { service, cwd } = opened
  const run = await admit(service, { cwd, prompt: 'Summarize the README.', agent: 'pi' })
  await waitForState(service.state, state => state.runs[run.id].status === 'dispatched' ? true : undefined)
  while (!release) await new Promise(resolve => setTimeout(resolve, 10))
  const steered = await userTurn(service, () => service.steer('tool:steer:pi', { childSessionId: run.childSessionId, prompt: 'Also check the license.', mode: 'queue' }))
  assert.equal(steered.outcome, 'injected')
  release()
  const text = untimed(await transcriptOf(opened, run.id))
  assert.ok(text.includes(message('transcript.agent', 'Pi')))
  assert.ok(text.includes(`${message('transcript.task')}\nSummarize the README.`))
  assert.ok(text.includes(message('transcript.tool', 'time', 'read', 'README.md')))
  assert.ok(text.includes(`${message('transcript.steer', 'time')}\nAlso check the license.`))
  assert.ok(text.includes('The README says hello.'))
  assert.ok(text.includes(message('transcript.ended', 'time', 'completed')))
})

test('the transcript names each permission request of the child', { timeout: 15000 }, async t => {
  const opened = await open(t)
  const { service, cwd } = opened
  const run = await admit(service, { cwd, prompt: 'approval' })
  const permission = await waitForState(service.state, state => Object.values(state.permissions).find(item => item.status === 'pending'))
  await service.state.respondPermission(permission.id, 'yes')
  const text = untimed(await transcriptOf(opened, run.id))
  assert.ok(text.includes(message('transcript.permission', 'time', 'Write a file')))
  assert.ok(text.indexOf('Write a file') < text.indexOf(ENDED))
})

test('a transcript stops at its limit with a note', { timeout: 15000 }, async t => {
  const opened = await open(t, { limit: 400 })
  const run = await admit(opened.service, { cwd: opened.cwd, prompt: 'tools' })
  await ended(opened.service, run.id)
  const path = transcriptPath(opened.path, run.id)
  const note = message('transcript.limit', 'time', 400)
  let text = ''
  while (!text.includes(note)) {
    await new Promise(resolve => setTimeout(resolve, 10))
    text = untimed(await readFile(path, 'utf8').catch(() => ''))
  }
  assert.ok((await stat(path)).size <= 400)
  assert.ok(text.trimEnd().endsWith(note))
  assert.ok(!text.includes(ENDED))
})

test('the transcript of a run goes away with the run, and the start removes the file of an unknown run', { timeout: 15000 }, async t => {
  const opened = await open(t, { transcripts: directory => join(directory, 'state', 'transcripts') })
  const { service, path } = opened
  const run = await admit(service, { cwd: opened.cwd, prompt: 'tools' })
  await transcriptOf(opened, run.id)
  await service.state.change(state => { delete state.runs[run.id] })
  for (;;) {
    if (await stat(transcriptPath(path, run.id)).then(() => false, () => true)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  // A file that a dropped run left, for example while the daemon was down, goes at the next start.
  const stale = transcriptPath(path, '00000000-0000-4000-8000-000000000000')
  await writeFile(stale, 'old', { mode: 0o600 })
  const again = new ChildTranscripts(path)
  await again.start(service.state)
  t.after(() => again.close())
  for (;;) {
    if (await stat(stale).then(() => false, () => true)) break
    await new Promise(resolve => setTimeout(resolve, 10))
  }
})

test('a transcript that cannot be written goes to the log one time, without content, and the run goes on', { timeout: 15000 }, async t => {
  // A file in the place of the directory makes each write fail.
  const opened = await open(t, { transcripts: directory => join(directory, 'state', 'blocked', 'transcripts') })
  await writeFile(join(opened.directory, 'state', 'blocked'), 'a file')
  const lines = []
  const write = process.stderr.write
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return write.call(process.stderr, chunk, ...rest) }
  t.after(() => { process.stderr.write = write })
  const run = await admit(opened.service, { cwd: opened.cwd, prompt: 'tools' })
  const state = await ended(opened.service, run.id)
  assert.equal(state.runs[run.id].status, 'completed')
  assert.ok(state.runs[run.id].output.includes('says hello'))
  await opened.transcripts.close()
  const logged = lines.filter(line => line.includes(message('log.transcript', run.id)))
  assert.equal(logged.length, 1)
  assert.ok(!logged[0].includes('README') && !logged[0].includes('tools'))
})

/** A client of the bridge that keeps each update, as Air keeps the updates that the released client schema rejects. */
function rawClient(bridge) {
  const inbound = new TransformStream()
  const writer = inbound.writable.getWriter()
  const pending = new Map()
  const updates = []
  let nextId = 0
  const peer = bridge.app().connect({ readable: inbound.readable, writable: new WritableStream({
    write(item) {
      if (item.method === 'session/update') updates.push(item.params.update)
      else if (pending.has(item.id)) {
        pending.get(item.id)(item.result ?? item.error)
        pending.delete(item.id)
      }
    },
  }) })
  const request = async (method, params) => {
    const id = ++nextId
    const result = new Promise(resolve => pending.set(id, resolve))
    await writer.write({ jsonrpc: '2.0', id, method, params })
    return result
  }
  return { request, updates, close: () => peer.close() }
}

async function view(daemon, cwd, options, capabilities = ['asyncTasks']) {
  const client = rawClient(new AcpBridge(daemon, options))
  await client.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: { _meta: { jetbrains: { air: { version: 1, capabilities } } } } })
  await client.request(methods.agent.session.new, { cwd, mcpServers: [] })
  return client
}

test('the row of a child that runs names its transcript for Air, a queued row and a client without asyncTasks get none', { timeout: 15000 }, async t => {
  const opened = await open(t, { server: true })
  const { service, cwd, daemon, path } = opened
  const air = await view(daemon, cwd, { transcripts: path })
  const plain = await view(daemon, cwd, {})
  const other = await view(daemon, cwd, { transcripts: path }, [])
  t.after(() => { air.close(); plain.close(); other.close() })
  const first = await admit(service, { cwd, prompt: 'wait', title: 'First' })
  const second = await admit(service, { cwd, prompt: 'tools', title: 'Second' })
  const spawned = client => client.updates.filter(update => update.sessionUpdate === 'async_task_spawned')
  await waitForState(service.state, state => state.runs[first.id].status === 'dispatched' ? true : undefined)
  while (!spawned(air).some(update => update.asyncTaskId === `${first.id}:running`)) await new Promise(resolve => setTimeout(resolve, 10))
  const running = spawned(air).find(update => update.asyncTaskId === `${first.id}:running`)
  assert.deepEqual(running, { sessionUpdate: 'async_task_spawned', asyncTaskId: `${first.id}:running`, name: 'First',
    description: message('child.running', 'Claude', 'project'), canStop: true, outputFilePath: transcriptPath(path, first.id),
    taskType: 'agent', showInTranscript: false })
  assert.equal(spawned(air).find(update => update.asyncTaskId === `${second.id}:queued`).outputFilePath, undefined)
  assert.ok((await readFile(running.outputFilePath, 'utf8')).includes(message('transcript.title', 'First')))
  while (!spawned(plain).some(update => update.asyncTaskId === `${first.id}:running`)) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(spawned(plain).every(update => update.outputFilePath === undefined))
  assert.deepEqual(other.updates.filter(update => update.sessionUpdate?.startsWith('async_task')), [])
  await service.state.stopChild(first.id)
  await ended(service, second.id)
})

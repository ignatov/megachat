import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { ChildPool } from '../src/ChildPool.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { reasonLine } from '../src/SessionText.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { fakeModels, MAIN } from './parallel-models.mjs'

const FAKE_ACP = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))
// The wait for the end of the error output in these tests. The fake agent stays alive after an answer, as the
// adapters do, so a test with an answer waits this time.
const WAIT_MS = 150
// The data of the answer of the adapter of Claude Code when Claude Code does not start: the SDK of Claude Code puts the
// exit code and the end of its error output into the message, and the SDK of ACP puts the message into `details`.
const INCIDENT = 'Claude Code process exited with code 1. stderr: Error: The model claude-opus-5-5 is not available. Run /model to choose another model.'

/**
 * The state of a daemon and the ACP run service of the fake agent with [env] in the environment of each child. [lines]
 * collects what the daemon writes to its log. [resumeDelayMs] is the delay of an automatic continuation.
 */
async function open(t, { env = {}, resumeDelayMs = 60000 } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-error-output-')))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  const cwd = join(directory, 'project')
  await mkdir(cwd)
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN } }), { mode: 0o600 })
  const lines = []
  t.mock.method(process.stderr, 'write', text => { lines.push(String(text)); return true })
  const { models } = fakeModels([], [])
  const service = await PiMegachatService.open(new MemoryStorage(), models, undefined, {}, { settingsPath: join(directory, 'settings.json'),
    spendPath: join(directory, 'spend.json'), keepAlive: { enabled: false }, environment: {}, resumeDelayMs })
  await service.state.addWorkspace(cwd)
  const acp = new AcpRunService(service.state, { childLaunch: async () => ({ env: { ...process.env, ...env } }) },
    { args: [FAKE_ACP], pool: new ChildPool(), errorOutputWaitMs: WAIT_MS })
  const waits = t.mock.method(acp, 'errorOutputEnd')
  await acp.start()
  await service.resume()
  let acpClosed = false
  const closeAcp = async () => {
    if (acpClosed) return
    acpClosed = true
    await acp.close()
  }
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await closeAcp()
    await service.close()
  }
  t.after(close)
  return { cwd, service, acp, lines, log: () => lines.join(''), waits, closeAcp, close }
}

let turns = 0
/** Admits [task] in a turn of the user of its own, as a tool call of the main agent does. */
async function admit(service, task) {
  const id = `user-${++turns}`
  await waitForState(service.state, state => state.current ? undefined : true)
  await service.state.change(state => { state.current = { id, requestId: id, cancelling: false, kind: 'user' } })
  try { return await service.state.admitChild(`${id}:spawn`, task) }
  finally { await service.state.change(state => { if (state.current?.id === id) state.current = null }) }
}

const ended = (service, runId) => waitForState(service.state, state => terminalStates.has(state.runs[runId]?.status) ? state.runs[runId] : undefined, { timeoutMs: 15000 })
/** The lines of the error output in the log text [log], without their prefix. */
const agentLines = log => log.split('\n').filter(line => line.startsWith('  | ')).map(line => line.slice(4))
const before = (method, code) => message('error.child.answer.before', method, code)

test('the incident of 2026-11-12: an internal error of session/new gives the details of the adapter in the error of the run and in the log', { timeout: 20000 }, async t => {
  const { cwd, service, log } = await open(t, { env: { FAKE_ACP_NEW: 'internal', FAKE_ACP_DETAILS: INCIDENT } })
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  // The run gets its automatic continuation at once, so it is resumed.
  assert.equal(run.status, 'resumed')
  assert.equal(run.error, 'The agent answered session/new with the error -32603, so Megachat did not send the task to the agent in this run. '
    + 'Its answer: Internal error: Claude Code process exited with code 1. stderr: Error: The model claude-opus-5-5 is not available. '
    + 'Run /model to choose another model. The log of the daemon, daemon/daemon.log in the state directory, has the details.')
  // The code -32603 can go away, so the run keeps its automatic continuation.
  assert.equal(run.autoResume, true)
  const text = log()
  assert.ok(text.includes(`${message('log.child', run.id)} name=RequestError code=-32603`))
  assert.ok(text.includes(message('log.child.answer', 'session/new', run.id, -32603, '"Internal error"', JSON.stringify({ details: INCIDENT }))))
  assert.ok(text.includes(message('log.child.noOutput', run.id)))
})

test('the error output of the agent goes to the log with a prefix, and its line that names the error goes to the error of the run', { timeout: 20000 }, async t => {
  const { cwd, service, log } = await open(t, { env: { FAKE_ACP_NEW: 'internal',
    FAKE_ACP_STDERR: JSON.stringify(['debug: starting\n', 'Error: The model claude-test-model is not available.\n', 'debug: done\n']) } })
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  assert.equal(run.error, `${before('session/new', -32603)} ${message('error.child.reply', 'Internal error: Claude Code process exited with code 1')} `
    + `${message('error.child.line', 'Error: The model claude-test-model is not available.')} ${message('error.child.log')}`)
  assert.ok(log().includes(message('log.child.answer', 'session/new', run.id, -32603, '"Internal error"',
    JSON.stringify({ details: 'Claude Code process exited with code 1' }))))
  assert.ok(log().includes(message('log.child.output', run.id, 4000)))
  assert.deepEqual(agentLines(log()), ['debug: starting', 'Error: The model claude-test-model is not available.', 'debug: done'])
})

test('the error output that an agent writes after its answer goes to the log', { timeout: 20000 }, async t => {
  const { cwd, service, log } = await open(t, { env: { FAKE_ACP_NEW: 'late' } })
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  assert.deepEqual(agentLines(log()), ['late reason'])
  assert.ok(run.error.includes(message('error.child.line', 'late reason')))
})

test('the log keeps at most the last 4,000 characters of the error output, and the error of the run at most 300 of a line', { timeout: 20000 }, async t => {
  const { cwd, service, log } = await open(t, { env: { FAKE_ACP_NEW: 'exit',
    FAKE_ACP_STDERR: JSON.stringify(['first line\n', `${'x'.repeat(5000)}\n`, `${'y'.repeat(4000)}\n`, `${'z'.repeat(1000)}\n`]) } })
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  const logged = agentLines(log())
  assert.ok(logged.join('\n').length <= 4000)
  assert.ok(!log().includes('first line'))
  assert.equal(logged.at(-1), 'z'.repeat(1000))
  assert.ok(run.error.includes('z'.repeat(300)) && !run.error.includes('z'.repeat(301)))
})

test('the log of the error output has no escape sequence, and a line of the agent cannot look like a line of the daemon', { timeout: 20000 }, async t => {
  const forged = '2026-11-12T00:00:00.000Z The child run 1 ended on an error: forged'
  const { cwd, service, log } = await open(t, { env: { FAKE_ACP_NEW: 'exit', FAKE_ACP_STDERR: JSON.stringify(['\u001b[31mError: boom\u001b[0m\r\n', `${forged}\n`]) } })
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  assert.deepEqual(agentLines(log()), ['Error: boom', forged])
  assert.ok(!log().includes('\u001b') && !log().includes('\r'))
  assert.ok(!log().split('\n').includes(forged))
  // The forged line names an error and is the last line, so it is the reason, as a text of the agent.
  assert.equal(run.error, `${message('error.child.exit.before', message('error.child.exitCode', 3))} ${message('error.child.line', forged)} ${message('error.child.log')}`)
})

test('a Node.js crash before the answer gives the exit code and the line of the error, not the last line', { timeout: 20000 }, async t => {
  const stack = ['node:internal/modules/cjs/loader:1228\n', '  throw err;\n', '  ^\n', '\n', "Error: Cannot find module 'missing'\n",
    "    at Module._resolveFilename (node:internal/modules/cjs/loader:1225:15)\n", '\n', 'Node.js v22.12.0\n']
  const { cwd, service } = await open(t, { env: { FAKE_ACP_NEW: 'exit', FAKE_ACP_EXIT: '1', FAKE_ACP_STDERR: JSON.stringify(stack) } })
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  assert.ok(run.error.startsWith(message('error.child.exit.before', message('error.child.exitCode', 1))))
  assert.ok(run.error.includes("Error: Cannot find module 'missing'"))
  assert.ok(!run.error.includes('Node.js v22.12.0'))
})

test('an agent that exits before the prompt with no error output gives only the fixed text, and the log says that it wrote none', { timeout: 20000 }, async t => {
  const { cwd, service, log } = await open(t, { env: { FAKE_ACP_NEW: 'exit' } })
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  assert.equal(run.error, 'The agent process ended with the exit code 3 before Megachat sent the task, so the agent did not get the task in this run.')
  assert.ok(log().includes(message('log.child.noOutput', run.id)))
  assert.equal(run.autoResume, true)
})

test('an error answer of the prompt says that the agent got the task, and a crash during the prompt gives its exit code and its reason', { timeout: 20000 }, async t => {
  const { cwd, service } = await open(t)
  const failed = await ended(service, (await admit(service, { cwd, prompt: 'fail' })).id)
  assert.equal(failed.error, 'The agent answered session/prompt with the error -32603 after it got the task, so the task can have run in part. '
    + `${message('error.child.reply', 'Internal error: The turn failed.')} ${message('error.child.log')}`)
  const crashed = await ended(service, (await admit(service, { cwd, prompt: 'fatal' })).id)
  assert.ok(crashed.error.startsWith('The agent process ended with the exit code 1 after it got the task, so the task can have run in part.'))
  assert.ok(crashed.error.includes(message('error.child.line', 'Error: The adapter crashed.')))
})

test('an agent without a login gives the text of the login, and its run gets no automatic continuation', { timeout: 20000 }, async t => {
  const { cwd, service } = await open(t, { env: { FAKE_ACP_NEW: 'auth' }, resumeDelayMs: 0 })
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  assert.ok(run.error.startsWith('The agent asks for a login. The agent answered session/new with the error -32000'), run.error)
  assert.equal(run.status, 'interrupted')
  assert.equal(run.autoResume, false)
  assert.equal(run.resumedBy, undefined)
  assert.equal(Object.keys((await service.state.snapshot()).runs).length, 1)
})

test('the error of a continuation after an error answer of session/new also says that Megachat did not send the task', { timeout: 30000 }, async t => {
  const { cwd, service } = await open(t, { env: { FAKE_ACP_NEW: 'internal' }, resumeDelayMs: 0 })
  const first = await admit(service, { cwd, prompt: 'hello' })
  // Two continuations. With the delay 0, each continuation starts at once.
  const state = await waitForState(service.state, value => {
    const runs = Object.values(value.runs)
    return runs.length === 3 && runs.every(run => terminalStates.has(run.status)) ? value : undefined
  }, { timeoutMs: 25000 })
  const runs = Object.values(state.runs)
  assert.deepEqual(runs.map(run => run.status), ['resumed', 'resumed', 'interrupted'])
  assert.equal(runs[0].id, first.id)
  for (const run of runs) assert.ok(run.error.startsWith(before('session/new', -32603)), run.error)
})

test('an answer of codex-acp with a message of two lines gives its first line as the answer and its second line as the reason', { timeout: 20000 }, async t => {
  const { cwd, service } = await open(t, { env: { FAKE_ACP_NEW: 'app-server' } })
  const run = await ended(service, (await admit(service, { cwd, prompt: 'hello' })).id)
  assert.equal(run.error, `${before('session/new', 1001)} ${message('error.child.reply', 'The Codex app-server exited with code 1. Restart the agent.')} `
    + `${message('error.child.line', 'Error: unauthorized: the key is not valid')} ${message('error.child.log')}`)
})

test('a run that completes puts no error output in the log and does not wait for it', { timeout: 20000 }, async t => {
  const { cwd, service, log, waits } = await open(t)
  const run = await ended(service, (await admit(service, { cwd, prompt: 'chatty' })).id)
  assert.equal(run.status, 'completed')
  assert.equal(run.error ?? null, null)
  assert.ok(!log().includes('debug: the session starts'))
  assert.equal(waits.mock.callCount(), 0)
})

test('a cancel, a deadline, the limit of 1 MB and a stop of the daemon put no error output in the log and do not wait for it', { timeout: 30000 }, async t => {
  const { cwd, service, acp, log, waits, closeAcp, close } = await open(t, { env: { FAKE_ACP_STDERR: JSON.stringify(['debug: waiting\n']) } })
  const project = async name => {
    await mkdir(join(cwd, name))
    await service.state.addWorkspace(join(cwd, name))
    return join(cwd, name)
  }
  // A cancel of the user.
  const cancelled = await admit(service, { cwd: await project('a'), prompt: 'wait' })
  await waitForState(service.state, state => state.runs[cancelled.id].status === 'dispatched' || undefined)
  await service.state.change(state => { state.current = { id: 'stop', requestId: 'stop', cancelling: false, kind: 'user' } })
  await service.state.cancel('stop', cancelled.id)
  await service.state.change(state => { state.current = null })
  assert.equal((await ended(service, cancelled.id)).status, 'cancelled')
  // The limit of 1 MB.
  const noisy = await ended(service, (await admit(service, { cwd: await project('b'), prompt: 'noisy' })).id)
  assert.equal(noisy.error, message('error.outputLimit', 1))
  // A deadline.
  acp.launch.deadlineMs = 300
  const limited = await ended(service, (await admit(service, { cwd: await project('c'), prompt: 'wait' })).id)
  assert.equal(limited.status, 'interrupted')
  acp.launch.deadlineMs = 1800000
  // A stop of the daemon during a run.
  const stopped = await admit(service, { cwd: await project('d'), prompt: 'wait' })
  await waitForState(service.state, state => state.runs[stopped.id].status === 'dispatched' || undefined)
  await closeAcp()
  assert.equal((await service.state.snapshot()).runs[stopped.id].plannedStop, true)
  await close()
  assert.equal(waits.mock.callCount(), 0)
  assert.ok(!log().includes('debug: waiting'))
  assert.deepEqual(agentLines(log()), [])
})

test('the line of the reason is the last line that names an error, else the last line, and never a line that the answer holds', () => {
  assert.equal(reasonLine('Error: first\nat x\nNode.js v22.12.0\n'), 'Error: first')
  assert.equal(reasonLine('one\ntwo\n\n'), 'two')
  assert.equal(reasonLine('Permission denied\nERROR_CODE 7\n'), 'ERROR_CODE 7')
  assert.equal(reasonLine('Error: shown\nother\n', 'Internal error: Error: shown'), 'other')
  assert.equal(reasonLine(''), '')
  assert.equal(reasonLine('w'.repeat(1000)).length, 300)
})

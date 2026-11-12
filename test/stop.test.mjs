import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpBridge, stopPermission } from '../src/AcpBridge.mjs'
import { AgentStop, STOP_REQUEST_MS } from '../src/AgentStop.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { processTable } from '../src/ProcessTable.mjs'
import { RunningAgents } from '../src/RunningAgents.mjs'

// Each command line of the fake table holds this marker, so a test can prove that no argument reaches the output.
const SECRET = 'sk-marker-0123456789'
const USER = 501
const OTHER_USER = 502
const DAEMON = 900
const LAUNCHER = 800
const START = Date.UTC(2026, 10, 12, 9, 0, 0)
const baseName = command => command.split(' ', 1)[0].split('/').pop()

// No test sends a real signal: each one gets a fake signal function. This guard catches a call of process.kill that
// a test did not expect, and it never sends the signal.
const realKill = process.kill
const unexpected = []
before(() => { process.kill = (pid, signal) => { unexpected.push([pid, signal]); return true } })
after(() => {
  process.kill = realKill
  assert.deepEqual(unexpected, [])
})

const proc = (pid, ppid, command, { uid = USER, startedAt = START + pid * 1000, name = baseName(command).slice(0, 16) } = {}) =>
  ({ pid, ppid, uid, startedAt, cpu: 0, name, command: `${command} --token ${SECRET}` })

/**
 * A machine with an orphan and a session of each other kind of owner:
 * 70, 71: orphans with the parent PID 1; 72: an orphan of another user; 20: Claude Code in an IDE; 51: pi in a
 * detached tmux; 10: Claude Code in an IDE from sources; 12: Claude Code below a java process that is no IDE for
 * certain; 81: a child of a Megachat run. The daemon 900 runs below its launcher 800 in the IDE 5.
 */
function machine() {
  const jbr = '/Users/user/Library/Java/JavaVirtualMachines/jbr-25/Contents/Home/bin/java'
  const adapter = '/Users/user/Library/Caches/JetBrains/IntelliJIdea2026.3/acp-agents/claude-acp/0.106.0/claude-agent-acp'
  return [
    proc(1, 0, '/sbin/launchd', { uid: 0 }),
    proc(5, 1, '/Applications/IntelliJ IDEA 2026.3 EAP.app/Contents/MacOS/idea', { name: 'idea' }),
    proc(LAUNCHER, 5, '/opt/homebrew/bin/node /Users/user/src/megachat/bin/megachat.mjs', { name: 'node' }),
    proc(DAEMON, LAUNCHER, '/opt/homebrew/bin/node /Users/user/src/megachat/src/main.mjs daemon', { name: 'node' }),
    proc(80, DAEMON, '/opt/homebrew/bin/node /Users/user/src/megachat/src/child-supervisor.mjs /opt/homebrew/bin/node', { name: 'node' }),
    proc(81, 80, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
    proc(6, 5, adapter, { name: 'claude-agent-acp' }),
    proc(20, 6, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
    proc(50, 1, 'tmux new-session -d', { name: 'tmux' }),
    proc(52, 50, '-zsh'),
    proc(51, 52, 'node /opt/homebrew/bin/pi', { name: 'node' }),
    proc(70, 1, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
    proc(71, 1, '/opt/homebrew/bin/codex', { name: 'codex' }),
    proc(72, 1, '/Users/other/.local/bin/claude', { name: '2.1.322', uid: OTHER_USER }),
    proc(100, 1, `${jbr} -Didea.platform.prefix=idea @/private/var/folders/xy/T/idea_arg_file1 com.intellij.idea.Main`, { name: 'java' }),
    proc(101, 100, adapter, { name: 'claude-agent-acp' }),
    proc(10, 101, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
    proc(120, 1, `${jbr} -Didea.platform.prefix=idea @/private/var/folders/xy/T/idea_arg_file2`, { name: 'java' }),
    proc(121, 120, adapter, { name: 'claude-agent-acp' }),
    proc(12, 121, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
  ]
}

const directories = { 10: '/work/sources', 12: '/work/unknown', 20: '/work/ide', 51: '/work/pi', 70: '/work/lost', 71: '/work/codex', 72: '/work/other' }

function fakeTable(processes) {
  const table = {
    platform: 'darwin', supported: true, reads: 0,
    async processes() { table.reads++; return table.current },
    async resolve(pids) { return new Map(pids.map(pid => [pid, { cwd: directories[pid] ?? null, files: [] }])) },
  }
  table.current = processes()
  return table
}

/** The state of Megachat: the runs, and the current turn. [turn] starts a new turn of [kind]. */
function fakeState(runs = [{ id: 'done', pid: 80, status: 'completed', providerSessionId: 'claude-session-2', title: 'Old task', cwd: '/work/old-task', prompt: SECRET }]) {
  let count = 0
  const state = {
    runs, current: null,
    snapshot: async () => ({ runs: Object.fromEntries(state.runs.map(run => [run.id, run])), current: state.current }),
    turn(kind = 'user') { state.current = { id: `turn-${++count}`, kind, cancelling: false }; return state.current },
  }
  return state
}

const fakeClock = (time = START + 3600000) => ({ time, now() { return this.time } })

/** A timer that runs only when the test fires it. */
function fakeTimer() {
  const timers = []
  const timer = (run, ms) => {
    const item = { run, ms, cancelled: false }
    timers.push(item)
    return () => { item.cancelled = true }
  }
  timer.fire = () => { for (const item of timers.splice(0)) if (!item.cancelled) item.run() }
  timer.timers = timers
  return timer
}

function setup({ table = fakeTable(machine), state = fakeState(), clock = fakeClock(), kill } = {}) {
  const signals = []
  const timer = fakeTimer()
  const running = new RunningAgents(state, { table, clock, daemonPid: DAEMON })
  const stopper = new AgentStop(state, { table, running, clock, timer, daemonPid: DAEMON, daemonParentPid: LAUNCHER, uid: USER,
    kill: kill ?? ((pid, signal) => { signals.push([pid, signal]) }) })
  const views = []
  stopper.watch(view => views.push(view))
  state.turn()
  return { table, state, clock, timer, stopper, signals, views }
}

/** Starts a call and waits until its request is open. Gives the pending call and the request of the view. */
async function asked(context, args, options) {
  const count = context.views.length
  const call = context.stopper.call(args, options)
  call.catch(() => {})
  await waitFor(() => context.views.length > count && context.views.at(-1).requests.length ? true : undefined, call)
  return { call, request: context.views.at(-1).requests[0] }
}

/** Waits for [check], but ends early when [call] ends first, so a refused call does not wait for ever. */
async function waitFor(check, call) {
  let ended = false
  call.then(() => { ended = true }, () => { ended = true })
  for (let index = 0; index < 200; index++) {
    if (check()) return
    if (ended) return
    await new Promise(resolve => setImmediate(resolve))
  }
  throw new Error('No stop request')
}

test('a call sends no signal, shows the PIDs in a stop request, and only the answer stop of the user sends SIGTERM one time', async () => {
  const context = setup()
  const { call, request } = await asked(context, { pids: [70, 71, 20, 51, 10, 12, 4242] })
  assert.deepEqual(context.signals, [])
  assert.equal(request.signal, 'SIGTERM')
  assert.equal(request.expiresAt, new Date(context.clock.time + STOP_REQUEST_MS).toISOString())
  assert.deepEqual(request.targets, [{ pid: 70, agent: 'claude', cwd: '/work/lost' }, { pid: 71, agent: 'codex', cwd: '/work/codex' }])
  assert.equal(context.timer.timers[0].ms, STOP_REQUEST_MS)
  assert.ok(!JSON.stringify(context.views).includes(SECRET))
  const lines = []
  const write = process.stderr.write
  process.stderr.write = text => { lines.push(String(text)); return true }
  let answer
  try {
    assert.deepEqual(context.stopper.answer(request.id, 'stop'), { accepted: true })
    answer = await call
  }
  finally { process.stderr.write = write }
  assert.deepEqual(context.signals, [[70, 'SIGTERM'], [71, 'SIGTERM']])
  assert.equal(answer.outcome, 'stopped')
  assert.deepEqual(answer.stopped, [{ pid: 70, outcome: 'sent' }, { pid: 71, outcome: 'sent' }])
  assert.deepEqual(answer.targets.map(target => [target.pid, target.agent, target.program, target.cwd, target.startedAt]), [
    [70, 'claude', 'claude', '/work/lost', new Date(START + 70000).toISOString()],
    [71, 'codex', 'codex', '/work/codex', new Date(START + 71000).toISOString()],
  ])
  assert.deepEqual(answer.refused, [
    { pid: 20, reason: message('stop.refused.owned', 20, 'ide', 'IntelliJ IDEA 2026.3 EAP', 5) },
    { pid: 51, reason: message('stop.refused.owned', 51, 'multiplexer', 'tmux', 50) },
    { pid: 10, reason: message('stop.refused.owned', 10, 'ide', 'java', 100) },
    { pid: 12, reason: message('stop.refused.unknown', 12, 'java', 120) },
    { pid: 4242, reason: message('stop.refused.notSession', 4242) },
  ])
  assert.equal(answer.note, message('stop.result.term'))
  assert.ok(!JSON.stringify(answer).includes(SECRET) && !JSON.stringify(answer).includes('idea_arg_file'))
  assert.equal(lines.length, 1)
  assert.ok(lines[0].endsWith(`${message('log.stop', 'SIGTERM', '70:sent,71:sent')}\n`))
  // The request closed with the answer. A second answer, also from another view, is refused, and it sends no signal.
  assert.deepEqual(context.views.at(-1), { requests: [], closed: [{ id: request.id, status: 'allowed' }] })
  assert.throws(() => context.stopper.answer(request.id, 'stop'), { code: 'stopClosed' })
  assert.throws(() => context.stopper.answer(request.id, 'keep'), { code: 'stopClosed' })
  assert.equal(context.signals.length, 2)
})

test('a list without an orphan shows no request, and the answer keep sends no signal', async () => {
  const context = setup()
  const none = await context.stopper.call({ pids: [20, 51] })
  assert.deepEqual([none.outcome, none.targets, none.refused.map(item => item.pid), none.note], ['none', [], [20, 51], message('stop.result.none')])
  assert.deepEqual(context.views, [])
  const { call, request } = await asked(context, { pids: [70] })
  context.stopper.answer(request.id, 'keep')
  const answer = await call
  assert.deepEqual([answer.outcome, answer.stopped, answer.note], ['declined', [], message('stop.result.declined')])
  assert.throws(() => context.stopper.answer(request.id, 'stop'), { code: 'stopClosed' })
  assert.deepEqual(context.signals, [])
})

test('no argument of a call sends a signal, and an unknown request, an unknown option and a late answer are refused', async () => {
  const context = setup()
  // The confirmation of the earlier build is no argument of the tool any more.
  await assert.rejects(context.stopper.call({ pids: [70], confirmation: 'a'.repeat(32) }), { code: 'invalid' })
  await assert.rejects(context.stopper.call({ pids: [70], approved: true }), { code: 'invalid' })
  // An ID of a request that the daemon does not know, as after a restart of the daemon.
  assert.throws(() => context.stopper.answer('00000000-0000-4000-8000-000000000000', 'stop'), { code: 'stopClosed' })
  const { call, request } = await asked(context, { pids: [70] })
  assert.throws(() => context.stopper.answer(request.id, 'allow_always'), { code: 'invalid' })
  assert.throws(() => context.stopper.answer(42, 'stop'), { code: 'invalid' })
  // The expiry: the timer closes the request. The client had no stream, so the note asks for the chat.
  context.timer.fire()
  const expired = await call
  assert.deepEqual([expired.outcome, expired.note], ['expired', message('stop.result.unseen', 5)])
  assert.throws(() => context.stopper.answer(request.id, 'stop'), { code: 'stopClosed' })
  // A request that a client got, and an answer after the lifetime before the timer ran.
  const second = await asked(context, { pids: [70] })
  context.stopper.delivered(context.views.at(-1))
  context.clock.time += STOP_REQUEST_MS
  assert.throws(() => context.stopper.answer(second.request.id, 'stop'), { code: 'stopClosed' })
  assert.deepEqual([(await second.call).outcome, (await second.call).note], ['expired', message('stop.result.expired', 5)])
  assert.deepEqual(context.signals, [])
  assert.ok(message('stop.result.expired', STOP_REQUEST_MS / 60000).includes('5 minutes'))
})

test('a new call replaces the open request, and the answer to the old dialog sends no signal', async () => {
  const context = setup()
  const first = await asked(context, { pids: [70] })
  const second = await asked(context, { pids: [71] })
  assert.notEqual(first.request.id, second.request.id)
  const replaced = await first.call
  assert.deepEqual([replaced.outcome, replaced.note], ['replaced', message('stop.result.replaced')])
  assert.deepEqual(context.views.at(-1).requests.map(request => request.id), [second.request.id])
  assert.throws(() => context.stopper.answer(first.request.id, 'stop'), { code: 'stopClosed' })
  assert.deepEqual(context.signals, [])
  context.stopper.answer(second.request.id, 'stop')
  assert.equal((await second.call).outcome, 'stopped')
  assert.deepEqual(context.signals, [[71, 'SIGTERM']])
})

test('a stop of the turn closes the request, and a turn that ended before the signal sends none', async () => {
  const context = setup()
  const abort = new AbortController()
  const { call, request } = await asked(context, { pids: [70] }, { abortSignal: abort.signal })
  abort.abort(new Error('turn stopped'))
  await assert.rejects(call, /turn stopped/)
  assert.deepEqual(context.views.at(-1).closed, [{ id: request.id, status: 'cancelled' }])
  assert.throws(() => context.stopper.answer(request.id, 'stop'), { code: 'stopClosed' })
  // The state gives another turn when the signal would go out.
  const other = await asked(context, { pids: [70] })
  context.state.turn()
  context.stopper.answer(other.request.id, 'stop')
  await assert.rejects(other.call, { code: 'stopEvent' })
  // The stop of the daemon closes an open request too.
  const last = await asked(context, { pids: [70] })
  context.stopper.stop()
  assert.equal((await last.call).outcome, 'cancelled')
  assert.deepEqual(context.signals, [])
  assert.deepEqual(context.timer.timers.filter(item => !item.cancelled), [])
})

test('no signal goes out when a process has another start time or command, ended, or is no orphan any more', async () => {
  const replace = (context, pid, change) => {
    context.table.current = context.table.current.flatMap(item => item.pid !== pid ? [item] : change(item))
  }
  const cases = [
    [70, item => [{ ...item, startedAt: item.startedAt + 60000 }], 'stop.refused.changed'],
    [70, item => [{ ...item, command: '/Users/user/.local/bin/claude --resume other' }], 'stop.refused.changed'],
    [70, () => [], 'stop.refused.gone'],
    // A process that a live program owns now is no orphan.
    [70, item => [proc(130, 1, '/usr/bin/python3 /work/run.py', { name: 'Python' }), { ...item, ppid: 130 }], 'stop.refused.unknown'],
  ]
  for (const [pid, change, key] of cases) {
    const context = setup()
    const { call, request } = await asked(context, { pids: [pid, 71] })
    replace(context, pid, change)
    context.stopper.answer(request.id, 'stop')
    const answer = await call
    // Each process or none: process 71 did not change, and it gets no signal either.
    assert.deepEqual(context.signals, [])
    assert.deepEqual([answer.outcome, answer.stopped], ['changed', []])
    assert.deepEqual(answer.refused, [{ pid, reason: key === 'stop.refused.unknown' ? message(key, pid, 'python3', 130) : message(key, pid) }])
    assert.equal(answer.note, message('stop.result.refused'))
  }
  // A Megachat child of an ended run is an orphan. A continuation of the run owns it again.
  const context = setup()
  const { call, request } = await asked(context, { pids: [81] })
  context.state.runs = [...context.state.runs, { id: 'next', pid: 80, status: 'running', cwd: '/work/old-task', prompt: SECRET }]
  context.stopper.answer(request.id, 'stop')
  assert.deepEqual((await call).refused, [{ pid: 81, reason: message('stop.refused.owned', 81, 'megachat', 'Megachat', DAEMON) }])
  assert.deepEqual(context.signals, [])
})

test('the answer reads the process table again directly before the signal', async () => {
  const context = setup()
  const { call, request } = await asked(context, { pids: [70] })
  const reads = context.table.reads
  context.stopper.answer(request.id, 'stop')
  await call
  assert.equal(context.table.reads, reads + 1)
  assert.deepEqual(context.signals, [[70, 'SIGTERM']])
})

test('an automatic turn, a turn that stops and a call without a turn are refused, and show no request', async () => {
  const context = setup()
  for (const kind of ['report', 'event', 'morning']) {
    context.state.turn(kind)
    await assert.rejects(context.stopper.call({ pids: [70] }), { code: 'stopEvent' })
  }
  context.state.turn().cancelling = true
  await assert.rejects(context.stopper.call({ pids: [70] }), { code: 'stopEvent' })
  context.state.current = null
  await assert.rejects(context.stopper.call({ pids: [70] }), { code: 'stopEvent' })
  assert.deepEqual([context.views, context.signals], [[], []])
})

test('SIGKILL goes out only after SIGTERM of this tool and a second answer of the user, to the same process', async () => {
  const context = setup()
  // No SIGKILL before SIGTERM.
  const early = await context.stopper.call({ pids: [70], signal: 'SIGKILL' })
  assert.deepEqual([early.outcome, early.refused], ['none', [{ pid: 70, reason: message('stop.refused.noTerm', 70) }]])
  const term = await asked(context, { pids: [70, 71] })
  context.stopper.answer(term.request.id, 'stop')
  await term.call
  assert.deepEqual(context.signals, [[70, 'SIGTERM'], [71, 'SIGTERM']])
  // Process 70 still runs, and process 71 ended. Another process took the PID 71.
  context.table.current = context.table.current.map(item => item.pid === 71 ? { ...item, startedAt: item.startedAt + 3600000 } : item)
  context.state.turn()
  const kill = await asked(context, { pids: [70, 71], signal: 'SIGKILL' })
  assert.deepEqual([kill.request.signal, kill.request.targets.map(target => target.pid)], ['SIGKILL', [70]])
  assert.equal(context.signals.length, 2)
  context.stopper.answer(kill.request.id, 'stop')
  const answer = await kill.call
  assert.deepEqual(answer.stopped, [{ pid: 70, outcome: 'sent' }])
  assert.deepEqual(answer.refused, [{ pid: 71, reason: message('stop.refused.noTerm', 71) }])
  assert.equal(answer.note, message('stop.result.kill'))
  assert.deepEqual(context.signals, [[70, 'SIGTERM'], [71, 'SIGTERM'], [70, 'SIGKILL']])
  // A SIGTERM of this tool to a process with the same PID and another start time does not count.
  context.state.turn()
  const again = await asked(context, { pids: [71] })
  context.stopper.answer(again.request.id, 'stop')
  await again.call
  context.table.current = context.table.current.map(item => item.pid === 71 ? { ...item, startedAt: item.startedAt + 1000 } : item)
  context.state.turn()
  assert.deepEqual((await context.stopper.call({ pids: [71], signal: 'SIGKILL' })).refused, [{ pid: 71, reason: message('stop.refused.noTerm', 71) }])
})

test('PID 1 and below, the daemon, the processes above it and a process of another user are refused before each other check', async () => {
  const context = setup()
  for (const pid of [1, 0, -5, DAEMON, LAUNCHER, 5])
    await assert.rejects(context.stopper.call({ pids: [70, pid] }), { code: 'stopProtected', message: message('error.stopProtected', pid) })
  await assert.rejects(context.stopper.call({ pids: [72] }), { code: 'stopOtherUser', message: message('error.stopOtherUser', 72) })
  // These checks come before the check of the turn and of the platform.
  context.state.turn('report')
  await assert.rejects(context.stopper.call({ pids: [DAEMON] }), { code: 'stopProtected' })
  await assert.rejects(context.stopper.call({ pids: [72] }), { code: 'stopOtherUser' })
  const other = setup({ table: processTable('linux') })
  await assert.rejects(other.stopper.call({ pids: [1] }), { code: 'stopProtected' })
  // A daemon that cannot tell its own user stops nothing.
  const unknownUser = setup()
  unknownUser.stopper.uid = undefined
  await assert.rejects(unknownUser.stopper.call({ pids: [70] }), { code: 'stopOtherUser' })
  // The other input checks.
  for (const args of [{ pids: [] }, { pids: [70, 70] }, { pids: [70.5] }, { pids: [70], signal: 'SIGHUP' }, { pids: Array.from({ length: 21 }, (_, index) => 2000 + index) }])
    await assert.rejects(context.stopper.call(args), { code: 'invalid' })
  assert.deepEqual([context.signals, other.signals, unknownUser.signals, context.views], [[], [], [], []])
})

test('a platform where agents_running gives no row refuses the tool', async () => {
  const context = setup({ table: processTable('linux') })
  await assert.rejects(context.stopper.call({ pids: [70] }), { code: 'stopPlatform', message: message('error.stopPlatform', 'linux') })
  assert.deepEqual(context.signals, [])
})

test('the result gives the outcome of a failed signal, and the default signal function is process.kill', async () => {
  const errors = { 70: 'ESRCH', 71: 'EPERM' }
  const context = setup({ kill: pid => { throw Object.assign(new Error('fake'), { code: errors[pid] }) } })
  const { call, request } = await asked(context, { pids: [70, 71] })
  context.stopper.answer(request.id, 'stop')
  assert.deepEqual((await call).stopped, [{ pid: 70, outcome: 'ended' }, { pid: 71, outcome: 'denied' }])
  // The guard of this file replaces process.kill, so this call sends no real signal.
  const table = fakeTable(machine)
  const state = fakeState()
  const stopper = new AgentStop(state, { table, running: new RunningAgents(state, { table, daemonPid: DAEMON }), daemonPid: DAEMON,
    daemonParentPid: LAUNCHER, uid: USER, timer: fakeTimer() })
  const views = []
  stopper.watch(view => views.push(view))
  state.turn()
  const pending = stopper.call({ pids: [70] })
  await waitFor(() => views.length ? true : undefined, pending)
  stopper.answer(views[0].requests[0].id, 'stop')
  await pending
  assert.deepEqual(unexpected.splice(0), [[70, 'SIGTERM']])
})

test('the dialog names each PID with its agent and project, and offers a stop one time and a refusal, with no option for always', () => {
  const targets = Array.from({ length: 20 }, (_, index) => ({ pid: 40000 + index, agent: ['claude', 'codex', 'pi', 'opencode'][index % 4],
    cwd: index === 3 ? null : `/work/project-${index}` }))
  const expiresAt = new Date(Date.now() + STOP_REQUEST_MS).toISOString()
  const params = stopPermission({ id: 'request-1', signal: 'SIGTERM', expiresAt, targets })
  const presentation = params._meta.jetbrains.air.permission
  assert.equal(presentation.version, 1)
  assert.equal(presentation.title, message('stop.dialog.title.many', 'SIGTERM', 20))
  // Air shows at most 240 characters of the title, on one line, and of the description.
  assert.ok([...presentation.title].length <= 240 && !presentation.title.includes('\n'))
  assert.equal(presentation.description, message('stop.dialog.description.SIGTERM', 5))
  assert.ok([...presentation.description].length <= 240)
  assert.ok([...message('stop.dialog.description.SIGKILL', 5)].length <= 240)
  assert.deepEqual(params.toolCall, { toolCallId: 'megachat-stop-request-1', title: presentation.title, kind: 'execute', status: 'pending',
    rawInput: { command: params.toolCall.rawInput.command } })
  const lines = params.toolCall.rawInput.command.split('\n')
  assert.equal(lines.length, 20)
  assert.equal(lines[0], message('stop.dialog.line', 40000, 'Claude Code', 'project-0'))
  assert.equal(lines[1], message('stop.dialog.line', 40001, 'Codex', 'project-1'))
  assert.equal(lines[3], message('stop.dialog.line.noProject', 40003, 'OpenCode'))
  assert.deepEqual(params.options.map(option => [option.optionId, option.kind, option.name]), [
    ['stop', 'allow_once', message('stop.option.stop.SIGTERM')], ['keep', 'reject_once', message('stop.option.keep')]])
  assert.equal(params.options[0]._meta.jetbrains.air.permission.description, message('stop.option.stop.description', 'SIGTERM'))
  const one = stopPermission({ id: 'request-2', signal: 'SIGKILL', expiresAt, targets: targets.slice(0, 1) })
  assert.equal(one._meta.jetbrains.air.permission.title, message('stop.dialog.title.one', 'SIGKILL', 1))
  assert.equal(one.options[0].name, message('stop.option.stop.SIGKILL'))
})

/**
 * A daemon with a fake model that calls agents_stop with [args] in each turn of the user, with a fake process table, a
 * fake signal function and a fake timer. [results] gets each tool result that the model gets.
 */
async function stopDaemon(t, args) {
  const fake = fauxProvider()
  const results = []
  fake.setResponses(Array(20).fill(context => {
    const last = context.messages.at(-1)
    if (last?.role !== 'toolResult') return fauxAssistantMessage(fauxToolCall('agents_stop', args), { stopReason: 'toolUse' })
    results.push(JSON.parse(last.content[0].text))
    return fauxAssistantMessage('Done.')
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const signals = []
  const timer = fakeTimer()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { keepAlive: { enabled: false }, processTable: fakeTable(machine),
      stop: { kill: (pid, signal) => signals.push([pid, signal]), daemonPid: DAEMON, daemonParentPid: LAUNCHER, uid: USER, timer } })
  await service.resume()
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  t.after(async () => { await server.close(); await service.close() })
  return { service, daemon, signals, timer, results }
}

/** A view of Air in a connection of its own, as a second window. [answer] answers each permission request. */
async function view(t, daemon, answer) {
  const asked = []
  const updates = []
  const connection = client({ name: 'test-air' })
    .onNotification(methods.client.session.update, ({ params }) => { updates.push(params.update) })
    .onRequest(methods.client.session.requestPermission, ({ params }) => { asked.push(params); return answer(params, asked.length) })
    .connect(new AcpBridge(daemon).app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })
  return { connection, sessionId, asked, updates }
}

const until = (check, what) => new Promise((resolve, reject) => {
  const started = Date.now()
  const poll = () => {
    const value = check()
    if (value) resolve(value)
    else if (Date.now() - started > 8000) reject(new Error(`No ${what}`))
    else setTimeout(poll, 10)
  }
  poll()
})

test('the main agent waits in its turn for the dialog, the first answer of two views wins, and the other dialog closes and sends no signal', { timeout: 20000 }, async t => {
  const { service, daemon, signals, results } = await stopDaemon(t, { pids: [70, 71] })
  const answer = Promise.withResolvers()
  const second = Promise.withResolvers()
  const first = await view(t, daemon, () => answer.promise)
  const other = await view(t, daemon, () => second.promise)
  const receipt = await daemon.json('/input', { requestId: 'stop-turn', text: 'Stop the orphan sessions.' })
  await until(() => first.asked.length && other.asked.length, 'dialog')
  const params = first.asked[0]
  assert.equal(params.sessionId, first.sessionId)
  assert.equal(params.toolCall.toolCallId, other.asked[0].toolCall.toolCallId)
  assert.equal(params.toolCall.rawInput.command, [message('stop.dialog.line', 70, 'Claude Code', 'lost'), message('stop.dialog.line', 71, 'Codex', 'codex')].join('\n'))
  assert.deepEqual(params.options.map(option => option.optionId), ['stop', 'keep'])
  // The turn stays open while the dialog shows, and no signal went out.
  assert.equal((await service.state.snapshot()).current.requestId, 'stop-turn')
  assert.deepEqual(signals, [])
  const id = params.toolCall.toolCallId.slice('megachat-stop-'.length)
  // The answer of the first view wins. The bridge of the other view then ends its tool call, so Air removes its dialog.
  answer.resolve({ outcome: { outcome: 'selected', optionId: 'stop' } })
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  assert.deepEqual(signals, [[70, 'SIGTERM'], [71, 'SIGTERM']])
  await until(() => other.updates.find(update => update.sessionUpdate === 'tool_call_update' && update.toolCallId === params.toolCall.toolCallId), 'final update')
  assert.equal(other.updates.find(update => update.toolCallId === params.toolCall.toolCallId).status, 'completed')
  // A late answer in the other dialog is refused, and it sends no signal.
  second.resolve({ outcome: { outcome: 'selected', optionId: 'stop' } })
  await assert.rejects(daemon.json('/stop/answer', { id, optionId: 'stop' }), { code: 'stopClosed' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(signals.length, 2)
  assert.deepEqual(results.map(result => [result.outcome, result.stopped]), [['stopped', [{ pid: 70, outcome: 'sent' }, { pid: 71, outcome: 'sent' }]]])
  // The rules of the main agent: one call, a dialog that the agent cannot answer, and the outcome for the user.
  const tool = service.extension().tools.find(item => item.name === 'agents_stop')
  assert.deepEqual([tool.description, tool.replay, Object.keys(tool.parameters.properties)], [message('tool.stop'), 'unsafe', ['pids', 'signal']])
  const history = await readFile(new URL('../src/MegachatHistoryServer.mjs', import.meta.url), 'utf8')
  assert.ok(!history.includes('agents_stop') && !history.includes('stopper'))
  const rules = await readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')
  for (const text of ['call agents_stop with their PIDs one time', 'only the answer of the user there sends the signal', 'You cannot answer it'])
    assert.ok(rules.includes(text), text)
  assert.ok(!rules.includes('confirmation'))
})

test('without a chat the request waits and expires, a chat that opens in that time gets the dialog, and a cancel of Air sends nothing', { timeout: 20000 }, async t => {
  const { service, daemon, signals, timer, results } = await stopDaemon(t, { pids: [70] })
  const receipt = await daemon.json('/input', { requestId: 'stop-alone', text: 'Stop PID 70.' })
  await until(() => service.stopper.requests.size, 'request')
  // A view that opens later gets the open request. Its answer cancelled, as at a close of the dialog by Air, changes nothing.
  const late = await view(t, daemon, () => ({ outcome: { outcome: 'cancelled' } }))
  await until(() => late.asked.length, 'dialog')
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.equal(service.stopper.requests.size, 1)
  timer.fire()
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  assert.deepEqual(results.map(result => [result.outcome, result.note]), [['expired', message('stop.result.expired', 5)]])
  await until(() => late.updates.find(update => update.sessionUpdate === 'tool_call_update'), 'final update')
  assert.equal(late.updates.find(update => update.sessionUpdate === 'tool_call_update').status, 'failed')
  // A turn without any chat: the note tells the agent to ask the user to open the chat.
  await late.connection.close()
  await until(() => !service.stopper.listeners.size, 'end of the stream')
  const alone = await daemon.json('/input', { requestId: 'stop-unseen', text: 'Stop PID 70.' })
  await until(() => service.stopper.requests.size, 'request')
  timer.fire()
  await daemon.json(`/wait?submission=${alone.submissionId}`)
  assert.deepEqual(results.map(result => [result.outcome, result.note]).at(-1), ['expired', message('stop.result.unseen', 5)])
  assert.deepEqual(signals, [])
})

test('a stop of the turn while the dialog shows ends the turn, closes the dialog, and a later answer sends no signal', { timeout: 20000 }, async t => {
  const { service, daemon, signals, results } = await stopDaemon(t, { pids: [70] })
  const answer = Promise.withResolvers()
  const shown = await view(t, daemon, () => answer.promise)
  const receipt = await daemon.json('/input', { requestId: 'stop-cancel', text: 'Stop PID 70.' })
  await until(() => shown.asked.length, 'dialog')
  const id = shown.asked[0].toolCall.toolCallId.slice('megachat-stop-'.length)
  assert.deepEqual(await daemon.json('/cancel', { mainRunId: receipt.mainRunId }), { cancelled: true })
  assert.equal((await daemon.json(`/wait?submission=${receipt.submissionId}`)).status, 'cancelled')
  assert.deepEqual(service.stopper.view().closed, [{ id, status: 'cancelled' }])
  await until(() => shown.updates.find(update => update.sessionUpdate === 'tool_call_update'), 'final update')
  assert.equal(shown.updates.find(update => update.sessionUpdate === 'tool_call_update').status, 'failed')
  answer.resolve({ outcome: { outcome: 'selected', optionId: 'stop' } })
  await assert.rejects(daemon.json('/stop/answer', { id, optionId: 'stop' }), { code: 'stopClosed' })
  await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual([signals, results], [[], []])
})

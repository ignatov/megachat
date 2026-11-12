import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { after, before, test } from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AgentStop, STOP_CONFIRMATION_MS } from '../src/AgentStop.mjs'
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
    turn(kind = 'user') { state.current = { id: `turn-${++count}`, kind }; return state.current },
  }
  return state
}

const fakeClock = (time = START + 3600000) => ({ time, now() { return this.time } })

function setup({ table = fakeTable(machine), state = fakeState(), clock = fakeClock(), kill } = {}) {
  const signals = []
  const running = new RunningAgents(state, { table, clock, daemonPid: DAEMON })
  const stopper = new AgentStop(state, { table, running, clock, daemonPid: DAEMON, daemonParentPid: LAUNCHER, uid: USER,
    kill: kill ?? ((pid, signal) => { signals.push([pid, signal]) }) })
  state.turn()
  return { table, state, clock, stopper, signals }
}

/** A confirmation for [pids] in the current turn, then a new turn of the user, as after the answer of the user. */
async function confirmed(context, pids, signal) {
  const preview = await context.stopper.call({ pids, ...(signal ? { signal } : {}) })
  assert.ok(preview.confirmation)
  context.state.turn()
  return preview.confirmation
}

test('the first call sends no signal and gives the processes, the refused PIDs and a confirmation', async () => {
  const context = setup()
  const preview = await context.stopper.call({ pids: [70, 71, 20, 51, 10, 12, 4242] })
  assert.deepEqual(context.signals, [])
  assert.equal(preview.signal, 'SIGTERM')
  assert.match(preview.confirmation, /^[0-9a-f]{32}$/)
  assert.equal(preview.expiresAt, new Date(context.clock.time + STOP_CONFIRMATION_MS).toISOString())
  assert.deepEqual(preview.targets, [
    { pid: 70, agent: 'claude', program: 'claude', cwd: '/work/lost', parent: { kind: 'unknown', name: 'launchd', pid: 1 },
      sessions: [{ sessionId: '', title: '' }], startedAt: new Date(START + 70000).toISOString() },
    { pid: 71, agent: 'codex', program: 'codex', cwd: '/work/codex', parent: { kind: 'unknown', name: 'launchd', pid: 1 },
      sessions: [{ sessionId: '', title: '' }], startedAt: new Date(START + 71000).toISOString() },
  ])
  assert.deepEqual(preview.refused, [
    { pid: 20, reason: message('stop.refused.owned', 20, 'ide', 'IntelliJ IDEA 2026.3 EAP', 5) },
    { pid: 51, reason: message('stop.refused.owned', 51, 'multiplexer', 'tmux', 50) },
    { pid: 10, reason: message('stop.refused.owned', 10, 'ide', 'java', 100) },
    { pid: 12, reason: message('stop.refused.unknown', 12, 'java', 120) },
    { pid: 4242, reason: message('stop.refused.notSession', 4242) },
  ])
  assert.equal(preview.note, message('stop.preview.note', '70, 71'))
  assert.ok(!JSON.stringify(preview).includes(SECRET))
  assert.ok(!JSON.stringify(preview).includes('idea_arg_file'))
  // A list without an orphan gives no confirmation.
  const none = await context.stopper.call({ pids: [20, 51] })
  assert.deepEqual([none.confirmation, none.targets, none.refused.map(item => item.pid)], [null, [], [20, 51]])
  assert.deepEqual(context.signals, [])
})

test('a confirmation in a later turn of the user sends SIGTERM one time to each process, and the result and the log hold only the PIDs and the outcome', async () => {
  const context = setup()
  const token = await confirmed(context, [70, 71])
  const lines = []
  const write = process.stderr.write
  process.stderr.write = text => { lines.push(String(text)); return true }
  let answer
  try { answer = await context.stopper.call({ pids: [71, 70], confirmation: token }) }
  finally { process.stderr.write = write }
  assert.deepEqual(context.signals, [[70, 'SIGTERM'], [71, 'SIGTERM']])
  assert.deepEqual(answer, { signal: 'SIGTERM', stopped: [{ pid: 70, outcome: 'sent' }, { pid: 71, outcome: 'sent' }], refused: [],
    note: message('stop.result.term') })
  assert.equal(lines.length, 1)
  assert.ok(lines[0].endsWith(`${message('log.stop', 'SIGTERM', '70:sent,71:sent')}\n`))
  assert.ok(!/work|claude|codex|token/.test(lines[0].replace(message('log.stop', '', ''), '')))
  // The confirmation is valid one time.
  context.state.turn()
  await assert.rejects(context.stopper.call({ pids: [70, 71], confirmation: token }), { code: 'stopUsed' })
  assert.equal(context.signals.length, 2)
})

test('no signal goes out with a confirmation of the same turn, of other PIDs or another signal, an old one, a used one or an unknown one', async () => {
  const context = setup()
  // The same turn: the model cannot confirm for the user. The check uses the confirmation.
  const preview = await context.stopper.call({ pids: [70] })
  await assert.rejects(context.stopper.call({ pids: [70], confirmation: preview.confirmation }), { code: 'stopSameTurn' })
  context.state.turn()
  await assert.rejects(context.stopper.call({ pids: [70], confirmation: preview.confirmation }), { code: 'stopUsed' })
  // Other PIDs: a subset, a superset, and the confirmation of another list.
  for (const pids of [[70], [70, 71, 20], [71]]) {
    const token = await confirmed(context, pids[0] === 71 ? [70] : [70, 71])
    await assert.rejects(context.stopper.call({ pids, confirmation: token }), { code: 'stopOther' })
    await assert.rejects(context.stopper.call({ pids: pids[0] === 71 ? [70] : [70, 71], confirmation: token }), { code: 'stopUsed' })
  }
  // Another signal.
  const term = await confirmed(context, [70])
  await assert.rejects(context.stopper.call({ pids: [70], signal: 'SIGKILL', confirmation: term }), { code: 'stopOther' })
  // An old confirmation.
  const old = await confirmed(context, [70])
  context.clock.time += STOP_CONFIRMATION_MS
  await assert.rejects(context.stopper.call({ pids: [70], confirmation: old }), { code: 'stopExpired' })
  // An unknown confirmation, as after a restart of the daemon, and a confirmation of a bad form.
  await assert.rejects(context.stopper.call({ pids: [70], confirmation: 'a'.repeat(32) }), { code: 'stopUnknown' })
  await assert.rejects(context.stopper.call({ pids: [70], confirmation: 'not a token' }), { code: 'invalid' })
  assert.deepEqual(context.signals, [])
  assert.equal(message('error.stopExpired', STOP_CONFIRMATION_MS / 60000).includes('5 minutes'), true)
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
    const token = await confirmed(context, [pid, 71])
    replace(context, pid, change)
    const answer = await context.stopper.call({ pids: [pid, 71], confirmation: token })
    // Each process or none: process 71 did not change, and it gets no signal either.
    assert.deepEqual(context.signals, [])
    assert.deepEqual(answer.stopped, [])
    assert.equal(answer.refused.length, 1)
    assert.equal(answer.refused[0].pid, pid)
    assert.equal(answer.refused[0].reason, key === 'stop.refused.unknown' ? message(key, pid, 'python3', 130) : message(key, pid))
    assert.equal(answer.note, message('stop.result.refused'))
  }
  // A Megachat child of an ended run is an orphan. A continuation of the run owns it again.
  const context = setup()
  const token = await confirmed(context, [81])
  context.state.runs = [...context.state.runs, { id: 'next', pid: 80, status: 'running', cwd: '/work/old-task', prompt: SECRET }]
  const answer = await context.stopper.call({ pids: [81], confirmation: token })
  assert.deepEqual(answer.refused, [{ pid: 81, reason: message('stop.refused.owned', 81, 'megachat', 'Megachat', DAEMON) }])
  assert.deepEqual(context.signals, [])
})

test('the second step reads the process table again directly before the signal', async () => {
  const context = setup()
  const token = await confirmed(context, [70])
  const reads = context.table.reads
  await context.stopper.call({ pids: [70], confirmation: token })
  assert.equal(context.table.reads, reads + 1)
  assert.deepEqual(context.signals, [[70, 'SIGTERM']])
})

test('an automatic turn refuses both steps, and so does a call without a turn', async () => {
  const context = setup()
  for (const kind of ['report', 'event', 'morning']) {
    context.state.turn(kind)
    await assert.rejects(context.stopper.call({ pids: [70] }), { code: 'stopEvent' })
  }
  context.state.turn()
  const preview = await context.stopper.call({ pids: [70] })
  for (const kind of ['report', 'event', 'morning']) {
    context.state.turn(kind)
    await assert.rejects(context.stopper.call({ pids: [70], confirmation: preview.confirmation }), { code: 'stopEvent' })
  }
  context.state.current = null
  await assert.rejects(context.stopper.call({ pids: [70], confirmation: preview.confirmation }), { code: 'stopEvent' })
  assert.deepEqual(context.signals, [])
})

test('SIGKILL goes out only after SIGTERM of this tool and a second confirmation, to the same process', async () => {
  const context = setup()
  // No SIGKILL before SIGTERM.
  const early = await context.stopper.call({ pids: [70], signal: 'SIGKILL' })
  assert.deepEqual([early.confirmation, early.refused], [null, [{ pid: 70, reason: message('stop.refused.noTerm', 70) }]])
  await context.stopper.call({ pids: [70, 71], confirmation: await confirmed(context, [70, 71]) })
  assert.deepEqual(context.signals, [[70, 'SIGTERM'], [71, 'SIGTERM']])
  // Process 70 still runs, and process 71 ended. Another process took the PID 71.
  context.table.current = context.table.current.map(item => item.pid === 71 ? { ...item, startedAt: item.startedAt + 3600000 } : item)
  context.state.turn()
  const kill = await context.stopper.call({ pids: [70, 71], signal: 'SIGKILL' })
  assert.deepEqual(kill.targets.map(target => target.pid), [70])
  assert.deepEqual(kill.refused, [{ pid: 71, reason: message('stop.refused.noTerm', 71) }])
  // The confirmation of SIGKILL also needs a later turn of the user.
  await assert.rejects(context.stopper.call({ pids: [70], signal: 'SIGKILL', confirmation: kill.confirmation }), { code: 'stopSameTurn' })
  assert.equal(context.signals.length, 2)
  const answer = await context.stopper.call({ pids: [70], signal: 'SIGKILL', confirmation: await confirmed(context, [70], 'SIGKILL') })
  assert.deepEqual(answer.stopped, [{ pid: 70, outcome: 'sent' }])
  assert.equal(answer.note, message('stop.result.kill'))
  assert.deepEqual(context.signals, [[70, 'SIGTERM'], [71, 'SIGTERM'], [70, 'SIGKILL']])
  // A SIGTERM of this tool to a process with the same PID and another start time does not count.
  context.state.turn()
  await context.stopper.call({ pids: [71], confirmation: await confirmed(context, [71]) })
  context.table.current = context.table.current.map(item => item.pid === 71 ? { ...item, startedAt: item.startedAt + 1000 } : item)
  context.state.turn()
  assert.deepEqual((await context.stopper.call({ pids: [71], signal: 'SIGKILL' })).refused, [{ pid: 71, reason: message('stop.refused.noTerm', 71) }])
})

test('PID 1 and below, the daemon, the processes above it and a process of another user are refused before each other check', async () => {
  const context = setup()
  for (const pid of [1, 0, -5, DAEMON, LAUNCHER, 5]) {
    await assert.rejects(context.stopper.call({ pids: [70, pid] }), { code: 'stopProtected', message: message('error.stopProtected', pid) })
    await assert.rejects(context.stopper.call({ pids: [pid], confirmation: 'a'.repeat(32) }), { code: 'stopProtected' })
  }
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
  assert.deepEqual([context.signals, other.signals, unknownUser.signals], [[], [], []])
})

test('a platform where agents_running gives no row refuses the tool', async () => {
  const context = setup({ table: processTable('linux') })
  await assert.rejects(context.stopper.call({ pids: [70] }), { code: 'stopPlatform', message: message('error.stopPlatform', 'linux') })
  assert.deepEqual(context.signals, [])
})

test('the result gives the outcome of a failed signal, and the default signal function is process.kill', async () => {
  const errors = { 70: 'ESRCH', 71: 'EPERM' }
  const context = setup({ kill: pid => { throw Object.assign(new Error('fake'), { code: errors[pid] }) } })
  const answer = await context.stopper.call({ pids: [70, 71], confirmation: await confirmed(context, [70, 71]) })
  assert.deepEqual(answer.stopped, [{ pid: 70, outcome: 'ended' }, { pid: 71, outcome: 'denied' }])
  // The guard of this file replaces process.kill, so this call sends no real signal.
  const table = fakeTable(machine)
  const state = fakeState()
  const stopper = new AgentStop(state, { table, running: new RunningAgents(state, { table, daemonPid: DAEMON }), daemonPid: DAEMON,
    daemonParentPid: LAUNCHER, uid: USER })
  state.turn()
  const token = (await stopper.call({ pids: [70] })).confirmation
  state.turn()
  await stopper.call({ pids: [70], confirmation: token })
  assert.deepEqual(unexpected.splice(0), [[70, 'SIGTERM']])
})

test('the main agent has the tool agents_stop, it does not run again after a restart, and the children do not get it', { timeout: 10000 }, async t => {
  const fake = fauxProvider()
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const signals = []
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { keepAlive: { enabled: false }, processTable: fakeTable(machine),
      stop: { kill: (pid, signal) => signals.push([pid, signal]), daemonPid: DAEMON, daemonParentPid: LAUNCHER, uid: USER } })
  t.after(() => service.close())
  const tool = service.extension().tools.find(item => item.name === 'agents_stop')
  assert.equal(tool.description, message('tool.stop'))
  assert.equal(tool.replay, 'unsafe')
  // No turn runs, so the tool refuses.
  await assert.rejects(tool.execute({ pids: [70] }), { code: 'stopEvent' })
  const turn = async (id, kind) => service.state.change(state => { state.current = { id, requestId: id, cancelling: false, kind } })
  await turn('first', 'user')
  const preview = JSON.parse((await tool.execute({ pids: [70] })).output[0].text)
  assert.deepEqual(preview.targets.map(target => target.pid), [70])
  await turn('report', 'report')
  await assert.rejects(tool.execute({ pids: [70], confirmation: preview.confirmation }), { code: 'stopEvent' })
  await turn('second', 'user')
  const answer = JSON.parse((await tool.execute({ pids: [70], confirmation: preview.confirmation })).output[0].text)
  assert.deepEqual(answer.stopped, [{ pid: 70, outcome: 'sent' }])
  assert.deepEqual(signals, [[70, 'SIGTERM']])
  await service.state.change(state => { state.current = null })
  const history = await readFile(new URL('../src/MegachatHistoryServer.mjs', import.meta.url), 'utf8')
  assert.ok(!history.includes('agents_stop') && !history.includes('stopper'))
  // The rules of the main agent: show the list, ask, and never confirm for the user.
  const rules = await readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')
  for (const text of ['call agents_stop with their PIDs and without confirmation', 'Ask the user to confirm exactly these PIDs, then end the turn',
    'Never confirm for the user', 'A general permission from an earlier message'])
    assert.ok(rules.includes(text), text)
})

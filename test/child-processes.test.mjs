import assert from 'node:assert/strict'
import { execFileSync, fork, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
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
import { CHECK, newRecord, parseTable, protectedPids, refusal, RunProcesses, selectRun, updateRecord } from '../src/RunProcesses.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { fakeModels, MAIN } from './parallel-models.mjs'

const FIXTURE = fileURLToPath(new URL('./fake-process-tree.mjs', import.meta.url))
const SUPERVISOR = fileURLToPath(new URL('../src/child-supervisor.mjs', import.meta.url))
const UID = 501
/** The start time [seconds] after 10:00:00 on 2026-11-12, as `ps` writes `lstart` in the locale C. */
const AT = (seconds = 0) => {
  const time = new Date(2026, 10, 12, 10, 0, seconds)
  const two = value => String(value).padStart(2, '0')
  return `Thu Nov 12 ${two(time.getHours())}:${two(time.getMinutes())}:${two(time.getSeconds())} 2026`
}

/** A process table from rows `[pid, ppid, pgid, seconds after 10:00:00, uid]`, through the parse of the `ps` text. */
const tableOf = rows => parseTable(rows.map(([pid, ppid, pgid, seconds = 0, uid = UID]) => `${pid} ${ppid} ${pgid} ${uid} ${AT(seconds)}`).join('\n'))
// The daemon 20, the supervisor 25 below it, and the agent 30 in a session of its own below the supervisor.
const BASE = [[1, 0, 1], [20, 1, 20], [25, 20, 20], [30, 25, 30]]
const options = table => ({ agentPid: 30, uid: UID, guarded: protectedPids(table, [25, 20]) })
/** The record after a read of each table of [tables], one after the other. */
function recordOf(...tables) {
  const record = newRecord()
  for (const table of tables) updateRecord(record, selectRun(table, record, options(table)), 30)
  return record
}
const guards = (table, record) => ({ table, record, guarded: protectedPids(table, [25, 20]), uid: UID })

test('the parse of the process table takes the locale C form, and a cut line gives no process', () => {
  const table = parseTable([' 41    40    41   501 Thu Nov 12 10:00:00 2026', ' 46     1    46   501 Thu Nov 12 10:0', 'garbage',
    '  7     1     7     0 Mon Nov  2 09:05:01 2026'].join('\n'))
  assert.deepEqual([...table.keys()], [41, 7])
  assert.deepEqual(table.get(41), { pid: 41, ppid: 40, pgid: 41, uid: 501, start: '2026 Nov 12 10:00:00',
    startedAt: new Date(2026, 10, 12, 10, 0, 0).getTime() / 1000 })
  assert.equal(table.get(7).start, '2026 Nov 2 09:05:01')
})

test('a shell whose parent ended first stays a process of the run through the record', () => {
  const first = tableOf([...BASE, [40, 30, 30], [41, 40, 41]])
  const record = recordOf(first)
  assert.deepEqual([...record.live.keys()].sort(), [30, 40, 41])
  const second = tableOf([...BASE, [41, 1, 41]])
  assert.deepEqual([...selectRun(second, record, options(second)).keys()].sort(), [30, 41])
})

test('a process in the group of a shell of the run is a process of the run, and a server that ran before is not', () => {
  const record = recordOf(tableOf([...BASE, [40, 30, 30], [41, 40, 41]]))
  // The server 50 started before the run. The agent sends requests to it, and that makes no process link.
  const table = tableOf([...BASE, [41, 1, 41], [42, 1, 41, 5], [50, 1, 50, -60]])
  const members = selectRun(table, record, options(table))
  assert.ok(members.has(42))
  assert.ok(!members.has(50))
  updateRecord(record, members, 30)
  assert.equal(refusal(50, guards(table, record)), CHECK.UNRECORDED)
  assert.equal(refusal(42, guards(table, record)), 0)
})

test('a group that no process of the run made gives no process, also with a process of the run in it', () => {
  // The process 60 of the run is in the group 70 of a process that is no process of the run.
  const table = tableOf([...BASE, [60, 30, 70], [70, 1, 70], [71, 1, 70]])
  const record = recordOf(table)
  assert.ok(record.live.has(60))
  assert.ok(!record.live.has(70) && !record.live.has(71))
  assert.equal(refusal(60, guards(table, record)), CHECK.GROUP)
})

test('the guards refuse a PID of another process, an older process, a group that the run did not make, and a protected process', () => {
  const table = tableOf([...BASE, [40, 30, 30], [41, 40, 41]])
  const record = recordOf(table)
  // The record has the PID 41 with the start time 10:00:00, and now another process has the PID 41.
  assert.equal(refusal(41, guards(tableOf([...BASE, [41, 1, 41, 300]]), record)), CHECK.UNRECORDED)
  // A defect puts the process 44, one second older than the agent, and the process 45 in the group 30 into the record.
  const later = tableOf([[1, 0, 1], [20, 1, 20], [25, 20, 20], [30, 25, 30, 10], [44, 1, 44, 9], [45, 1, 33, 11]])
  const defect = newRecord()
  updateRecord(defect, new Map([30, 44, 45].map(pid => [pid, later.get(pid)])), 30)
  assert.equal(refusal(44, guards(later, defect)), CHECK.OLDER)
  assert.equal(refusal(45, guards(later, defect)), CHECK.GROUP)
  // A process in the same second as the agent passes the check of the age.
  assert.equal(refusal(30, guards(later, defect)), 0)
  for (const pid of [0, 1, -30, 20, 25]) assert.equal(refusal(pid, guards(table, record)), CHECK.PROTECTED)
  // A process that ended, or whose line was cut, gets no signal.
  assert.equal(refusal(41, guards(tableOf(BASE), record)), CHECK.GONE)
})

test('the daemon, a process above it and a process of another user are never processes of the run', () => {
  // The IDE 10 is above the daemon 20. The process 43 of the run belongs to another user.
  const table = tableOf([[1, 0, 1], [10, 1, 10], [20, 10, 20], [25, 20, 20], [30, 25, 30], [43, 30, 30, 0, 502]])
  const record = recordOf(table)
  assert.deepEqual([...record.live.keys()], [30])
  assert.deepEqual([...protectedPids(table, [25, 20])].sort((a, b) => a - b), [10, 20, 25])
  for (const pid of [10, 20, 25]) assert.equal(refusal(pid, guards(table, record)), CHECK.PROTECTED)
  record.live.set(43, { start: table.get(43).start, uid: UID, pgid: 30, startedAt: table.get(43).startedAt })
  assert.equal(refusal(43, guards(table, record)), CHECK.UNRECORDED)
})

/** A fake world for `RunProcesses`: a table that changes after each signal, and a list of the signals. */
function world({ tables, ends = () => true, platform = 'darwin', read } = {}) {
  const signals = []
  const reports = []
  let index = 0
  const alive = new Set([-30, 30, 40, 41])
  let clock = 0
  const processes = new RunProcesses({ agentPid: 30, platform, self: 25, daemon: 20, uid: UID, interval: 1000,
    // A read gives no line for a process of the fake world that ended.
    read: read ?? (async () => {
      const table = tables[Math.min(index++, tables.length - 1)]
      return new Map([...table].filter(([pid]) => ![30, 40, 41].includes(pid) || alive.has(pid)))
    }),
    kill: (pid, signal) => {
      if (signal === 0) { if (!alive.has(pid)) throw Object.assign(new Error('gone'), { code: 'ESRCH' }); return }
      signals.push([pid, signal])
      if (ends(pid, signal)) alive.delete(pid)
    },
    report: (pid, check) => reports.push([pid, check]), now: () => clock, wait: async ms => { clock += ms } })
  return { processes, signals, reports, alive, reads: () => processes.reads }
}

test('the end clean sends SIGTERM to the group and to each process of the run, then SIGKILL after 1 second', async () => {
  const table = tableOf([...BASE, [40, 30, 30], [41, 40, 41]])
  // The shell 41 ignores SIGTERM.
  const { processes, signals } = world({ tables: [table], ends: (pid, signal) => signal === 'SIGKILL' || pid !== 41 })
  await processes.refresh()
  await processes.end('clean')
  assert.deepEqual(signals, [[-30, 'SIGTERM'], [40, 'SIGTERM'], [41, 'SIGTERM'], [-30, 'SIGKILL'], [41, 'SIGKILL']])
})

test('the end clean of a record without a process outside the group of the agent makes no read', async () => {
  const table = tableOf([...BASE, [40, 30, 30]])
  const { processes, signals, reads } = world({ tables: [table] })
  await processes.refresh()
  await processes.end('clean')
  assert.equal(reads(), 1)
  assert.deepEqual(signals, [[-30, 'SIGTERM']])
})

test('a read that fails before the signal gives the signals to the group of the agent only', async () => {
  let fail = false
  const table = tableOf([...BASE, [41, 30, 41]])
  const { processes, signals } = world({ read: async () => { if (fail) throw new Error('ps failed'); return table },
    ends: (pid, signal) => signal === 'SIGKILL' })
  await processes.refresh()
  fail = true
  await processes.end('clean')
  assert.deepEqual(signals, [[-30, 'SIGTERM'], [-30, 'SIGKILL']])
})

test('a refusal sends no signal and reports the PID and the check', async () => {
  const { processes, signals, reports } = world({ tables: [tableOf([...BASE, [41, 30, 41]])] })
  await processes.refresh()
  // The read before the signal gives another process with the PID 41.
  assert.equal(processes.send(41, 'SIGTERM', tableOf([...BASE, [41, 1, 41, 300]])), false)
  assert.equal(processes.send(20, 'SIGTERM', tableOf(BASE)), false)
  assert.deepEqual(signals, [])
  assert.deepEqual(reports, [[41, CHECK.UNRECORDED], [20, CHECK.PROTECTED]])
})

test('the log line of a refusal holds numbers only', () => {
  const line = message('log.child.refused', 41, CHECK.UNRECORDED, 25)
  assert.deepEqual(line.match(/\d+/g).slice(0, 3), ['25', '41', '3'])
  assert.ok(!/\{\d\}/.test(line))
})

test('the end keep and an end on linux send SIGKILL to the group of the agent only, and linux makes no read', async () => {
  const table = tableOf([...BASE, [41, 30, 41]])
  const keep = world({ tables: [table] })
  await keep.processes.refresh()
  await keep.processes.end('keep')
  assert.deepEqual(keep.signals, [[-30, 'SIGKILL']])
  assert.equal(keep.reads(), 1)
  const linux = world({ tables: [table], platform: 'linux' })
  linux.processes.start()
  await linux.processes.end('clean')
  assert.deepEqual(linux.signals, [[-30, 'SIGKILL']])
  assert.equal(linux.reads(), 0)
})

// The tests below start real stand-in processes. Each one selects a process only by a PID that a stand-in wrote at its
// start, reads its start time before each signal, and ends each such process that still runs, also after a failed
// assertion or a timeout.

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
// The time for a read of the record after the start of a shell. A read takes up to about 1 second under a high load.
const settle = () => delay(2500)
const startOf = pid => {
  try { return execFileSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8', env: { LC_ALL: 'C' } }).trim() || null }
  catch { return null }
}
const skip = process.platform !== 'darwin'

/**
 * The stand-ins of one test in a new temporary directory. `pid(name)` waits for the PID file of a stand-in and records
 * the PID with its start time. `signal` sends a signal to a recorded PID only while it runs with that start time. The
 * hook of the test ends each recorded PID that still runs, asserts that none remains, and removes the directory.
 */
async function standIns(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-processes-')))
  const recorded = new Map()
  const record = pid => {
    const start = startOf(pid)
    if (start) recorded.set(pid, start)
    return pid
  }
  const running = pid => recorded.has(pid) && startOf(pid) === recorded.get(pid)
  const signal = (pid, name) => {
    if (!running(pid)) return false
    try { process.kill(pid, name); return true }
    catch (error) { if (error.code !== 'ESRCH') throw error; return false }
  }
  const file = name => readFile(join(directory, name), 'utf8').catch(() => '')
  const pid = async (name, timeoutMs = 10000) => {
    for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(20)) {
      const value = Number((await file(name)).trim())
      if (value > 1) return record(value)
    }
    throw new Error(`No PID in ${name}`)
  }
  t.after(async () => {
    try {
      for (const line of (await file('agents')).split('\n').filter(Boolean)) record(Number(line.split(' ')[0]))
      for (const name of ['shell.pid', 'sleep.pid']) { const value = Number((await file(name)).trim()); if (value > 1 && !recorded.has(value)) record(value) }
      for (const each of recorded.keys()) signal(each, 'SIGKILL')
      let left = [...recorded.keys()]
      for (let attempt = 0; attempt < 250 && left.length; attempt++) {
        await delay(20)
        left = left.filter(running)
      }
      assert.deepEqual(left, [], 'A stand-in process of the test did not end')
    }
    finally { await rm(directory, { force: true, recursive: true, maxRetries: 5 }) }
  })
  return { directory, pid, record, running, signal, file, exists: async name => !!await stat(join(directory, name)).catch(() => null) }
}

const until = async (condition, timeoutMs = 10000) => {
  for (const end = Date.now() + timeoutMs; Date.now() < end; await delay(20)) if (await condition()) return true
  return false
}

/** Starts the stand-in daemon with the supervisor, the adapter, the stand-in of Claude Code and its shell. */
async function tree(t, env = {}) {
  const stands = await standIns(t)
  const daemon = fork(FIXTURE, ['daemon'], { env: { ...process.env, FAKE_TREE_DIR: stands.directory, FAKE_TREE_SUPERVISOR: SUPERVISOR, ...env },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  const exited = new Promise(resolve => daemon.on('message', value => resolve(value.exitedAfterMs)))
  daemon.on('error', () => {})
  const pids = { daemon: stands.record(daemon.pid) }
  for (const name of ['supervisor', 'adapter', 'claude', 'shell', 'sleep']) pids[name] = await stands.pid(`${name}.pid`)
  // A read of the record sees the shell.
  await settle()
  return { ...stands, daemon, pids, exited }
}

test('the word clean ends the shell in a session of its own and its sleep 61, and the supervisor exits', { skip, timeout: 30000 }, async t => {
  const { daemon, pids, running, exited } = await tree(t)
  daemon.send('clean')
  const ms = await exited
  assert.ok(await until(() => !running(pids.shell) && !running(pids.sleep) && !running(pids.claude)))
  t.diagnostic(`the end with a shell took ${ms} ms after the word clean`)
})

test('a loss of the daemon keeps the shell and its sleep 61, and the agent ends', { skip, timeout: 30000 }, async t => {
  const { pids, running, signal } = await tree(t)
  assert.ok(signal(pids.daemon, 'SIGKILL'))
  assert.ok(await until(() => !running(pids.supervisor) && !running(pids.adapter) && !running(pids.claude)))
  await delay(300)
  assert.ok(running(pids.shell) && running(pids.sleep))
})

test('a crash of Claude Code while the daemon runs ends the shell with the parent PID 1 and its sleep 61', { skip, timeout: 30000 }, async t => {
  const { pids, running, signal } = await tree(t, { FAKE_TREE_ADAPTER_EXIT: '1' })
  assert.ok(signal(pids.claude, 'SIGKILL'))
  assert.ok(await until(() => !running(pids.shell) && !running(pids.sleep) && !running(pids.supervisor)))
})

test('the word clean keeps a sleep that the test started before the run', { skip, timeout: 30000 }, async t => {
  const stands = await standIns(t)
  const server = spawn('/bin/sleep', ['61'], { stdio: 'ignore' })
  const serverPid = stands.record(server.pid)
  t.after(() => stands.signal(serverPid, 'SIGKILL'))
  const daemon = fork(FIXTURE, ['daemon'], { env: { ...process.env, FAKE_TREE_DIR: stands.directory, FAKE_TREE_SUPERVISOR: SUPERVISOR,
    FAKE_TREE_SERVER: String(serverPid) }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  stands.record(daemon.pid)
  const shell = await stands.pid('shell.pid')
  for (const name of ['supervisor', 'adapter', 'claude', 'sleep']) await stands.pid(`${name}.pid`)
  await settle()
  daemon.send('clean')
  assert.ok(await until(() => !stands.running(shell)))
  assert.ok(stands.running(serverPid))
})

test('a shell that handles SIGTERM gets SIGTERM first, and a shell that ignores it ends in less than 5 seconds', { skip, timeout: 30000 }, async t => {
  await t.test('term', async t => {
    const { daemon, pids, running, exists, exited } = await tree(t, { FAKE_TREE_SHELL: 'term' })
    daemon.send('clean')
    await exited
    assert.ok(await until(() => exists('term')))
    assert.ok(await until(() => !running(pids.shell) && !running(pids.sleep)))
  })
  await t.test('ignore', async t => {
    const { daemon, pids, running, exited } = await tree(t, { FAKE_TREE_SHELL: 'ignore' })
    daemon.send('clean')
    const ms = await exited
    assert.ok(ms >= 1000 && ms < 5000, `${ms} ms`)
    assert.ok(await until(() => !running(pids.shell) && !running(pids.sleep)))
    t.diagnostic(`the end with a shell that ignores SIGTERM took ${ms} ms`)
  })
})

test('the end of a run without a shell outside the group of the agent takes about as long as before', { skip, timeout: 30000 }, async t => {
  const stands = await standIns(t)
  // The agent is a shell in the process group of the agent with no child, so the record has no process outside it.
  const supervisor = spawn(process.execPath, [SUPERVISOR, '/bin/sh', '-c', `echo $$ > ${join(stands.directory, 'agent.pid')}; exec sleep 61`],
    { stdio: ['pipe', 'pipe', 'ignore', 'pipe'] })
  stands.record(supervisor.pid)
  await stands.pid('agent.pid')
  await settle()
  const exit = new Promise(resolve => supervisor.once('exit', resolve))
  const started = Date.now()
  supervisor.stdio[3].end('clean\n')
  await exit
  t.diagnostic(`the end with no shell took ${Date.now() - started} ms after the word clean`)
})

// The run service with the stand-in ACP agent.

async function open(t, { env = {}, errorOutputWaitMs = 150 } = {}) {
  const stands = await standIns(t)
  const cwd = join(stands.directory, 'project')
  await mkdir(cwd)
  await writeFile(join(stands.directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN } }), { mode: 0o600 })
  const lines = []
  t.mock.method(process.stderr, 'write', text => { lines.push(String(text)); return true })
  const { models } = fakeModels([], [])
  const service = await PiMegachatService.open(new MemoryStorage(), models, undefined, {}, { settingsPath: join(stands.directory, 'settings.json'),
    spendPath: join(stands.directory, 'spend.json'), keepAlive: { enabled: false }, environment: {}, resumeDelayMs: 60000 })
  await service.state.addWorkspace(cwd)
  const acp = new AcpRunService(service.state, { childLaunch: async () => ({ env: { ...process.env, FAKE_TREE_DIR: stands.directory, ...env } }) },
    { args: [FIXTURE, 'acp'], pool: new ChildPool(), errorOutputWaitMs })
  await acp.start()
  await service.resume()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await acp.close()
    await service.close()
  }
  t.after(close)
  return { ...stands, cwd, service, acp, close, log: () => lines.join('') }
}

let turns = 0
async function admit(service, task) {
  const id = `user-${++turns}`
  await waitForState(service.state, state => state.current ? undefined : true)
  await service.state.change(state => { state.current = { id, requestId: id, cancelling: false, kind: 'user' } })
  try { return await service.state.admitChild(`${id}:spawn`, task) }
  finally { await service.state.change(state => { if (state.current?.id === id) state.current = null }) }
}
const ended = (service, runId) => waitForState(service.state, state => terminalStates.has(state.runs[runId]?.status) ? state.runs[runId] : undefined, { timeoutMs: 15000 })
async function cancel(service, runId) {
  await service.state.change(state => { state.current = { id: 'stop', requestId: 'stop', cancelling: false, kind: 'user' } })
  await service.state.cancel('stop', runId)
  await service.state.change(state => { state.current = null })
}

test('a cancel ends the shell of the run and its sleep 61', { skip, timeout: 30000 }, async t => {
  const { cwd, service, pid, running } = await open(t)
  const run = await admit(service, { cwd, prompt: 'shell' })
  const shell = await pid('shell.pid')
  const sleep = await pid('sleep.pid')
  await settle()
  await cancel(service, run.id)
  assert.equal((await ended(service, run.id)).status, 'cancelled')
  assert.ok(await until(() => !running(shell) && !running(sleep)))
})

test('a completed run keeps the sleep 61 of its shell in a session of its own', { skip, timeout: 30000 }, async t => {
  const { cwd, service, pid, running, file } = await open(t)
  const run = await admit(service, { cwd, prompt: 'shell-done' })
  const sleep = await pid('sleep.pid')
  assert.equal((await ended(service, run.id)).status, 'completed')
  const agent = Number((await file('agents')).split(' ')[0])
  assert.ok(await until(() => { try { process.kill(agent, 0); return false } catch { return true } }))
  await delay(300)
  assert.ok(running(sleep))
})

test('a stop of the daemon keeps a shell of the run that stops the daemon, and the shell writes its marker', { skip, timeout: 30000 }, async t => {
  const { cwd, service, acp, pid, running, exists } = await open(t)
  await admit(service, { cwd, prompt: 'shell-stop' })
  const shell = await pid('shell.pid')
  assert.ok(await until(() => exists('stop')))
  await acp.close()
  assert.ok(await until(() => exists('marker')), 'The shell did not write its marker')
  assert.ok(!await exists('term'), 'The shell got SIGTERM')
  assert.ok(await until(() => !running(shell)))
})

test('a failed run with an error answer and a live shell that ignores SIGTERM gets its complete reason, and the shell ends', { skip, timeout: 30000 }, async t => {
  const { cwd, service, pid, running } = await open(t)
  const run = await admit(service, { cwd, prompt: 'shell-fail' })
  const shell = await pid('shell.pid')
  const sleep = await pid('sleep.pid')
  const result = await ended(service, run.id)
  assert.ok(result.error.includes(message('error.child.line', 'Error: The stand-in agent failed')), result.error)
  assert.ok(result.error.startsWith(message('error.child.answer.after', 'session/prompt', -32603)), result.error)
  assert.ok(await until(() => !running(shell) && !running(sleep)))
})

test('a crashed run with a live shell that ignores SIGTERM gets its complete reason, and the shell ends', { skip, timeout: 30000 }, async t => {
  const { cwd, service, pid, running } = await open(t)
  const run = await admit(service, { cwd, prompt: 'shell-crash' })
  const shell = await pid('shell.pid')
  const sleep = await pid('sleep.pid')
  const result = await ended(service, run.id)
  assert.ok(['interrupted', 'resumed'].includes(result.status))
  assert.equal(result.error, [message('error.child.exit.after', message('error.child.exitCode', 1)),
    message('error.child.line', 'Error: The stand-in agent crashed.'), message('error.child.log')].join(' '))
  assert.ok(await until(() => !running(shell) && !running(sleep)))
})

test('the next task in the directory starts after the shell of a cancelled run ended', { skip, timeout: 30000 }, async t => {
  const { cwd, service, pid, file, directory } = await open(t, { env: { FAKE_TREE_SHELL: 'slow' } })
  const first = await admit(service, { cwd, prompt: 'shell' })
  await pid('shell.pid')
  await settle()
  const second = await admit(service, { cwd, prompt: 'hello' })
  await cancel(service, first.id)
  assert.equal((await ended(service, second.id)).status, 'completed')
  const starts = (await file('agents')).split('\n').filter(Boolean).map(line => Number(line.split(' ')[1]))
  assert.equal(starts.length, 2)
  const shellEnded = (await stat(join(directory, 'ended'))).mtimeMs
  assert.ok(shellEnded <= starts[1], `the shell ended at ${shellEnded}, the second agent started at ${starts[1]}`)
})

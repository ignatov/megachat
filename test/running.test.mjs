import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { readFile, realpath } from 'node:fs/promises'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { parseOpenFiles, parseProcesses, processTable } from '../src/ProcessTable.mjs'
import { ACTIVE_CPU_PERCENT, RunningAgents, SNAPSHOT_TTL_MS } from '../src/RunningAgents.mjs'

// Each command line of the fake table holds this marker, so a test can prove that no argument reaches the output.
const SECRET = 'sk-marker-0123456789'
const DAEMON = 900
const START = Date.UTC(2026, 10, 11, 12, 0, 0)
const baseName = command => command.split(' ', 1)[0].split('/').pop()

/** One process of the fake table. The name is the executable name that the kernel keeps, at most 16 bytes. */
const proc = (pid, ppid, command, { cpu = 0, startedAt = START + pid * 1000, name = baseName(command).slice(0, 16) } = {}) =>
  ({ pid, ppid, startedAt, cpu, name, command: `${command} --token ${SECRET}` })

/** A fake process table: it counts the calls, and it gives a working directory for each PID in [directories]. */
function fakeTable(processes, directories = {}) {
  const table = {
    platform: 'darwin', supported: true, calls: { processes: 0, resolve: [] },
    async processes() { table.calls.processes++; return typeof processes === 'function' ? processes() : processes },
    async resolve(pids) {
      table.calls.resolve.push(pids)
      return new Map(pids.map(pid => [pid, { cwd: directories[pid] ?? null }]))
    },
  }
  return table
}

const fakeState = (runs = []) => ({ snapshot: async () => ({ runs: Object.fromEntries(runs.map(run => [run.id, run])) }) })
const fakeClock = (time = START) => ({ time, now() { return this.time } })

/**
 * A machine with a session of each agent and each kind of owner. A test can look up a row by its PID:
 * 10: Claude Code in Terminal; 20, 21: two Claude sessions of one adapter of an IDE; 30: Codex below codex-acp of an IDE;
 * 41: a Megachat child below its supervisor 40; 51: pi in a detached tmux; 61: OpenCode in Ghostty; 70: Claude Code
 * with the parent PID 1; 81: a child of a finished Megachat run; 90: codex-acp with no agent below it.
 */
function machine() {
  return [
    proc(1, 0, '/sbin/launchd'),
    proc(2, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', { name: 'Terminal' }),
    proc(3, 2, 'login -pf user'),
    proc(4, 3, '-zsh'),
    proc(10, 4, 'claude', { name: '2.1.322', cpu: 0.4 }),
    // The helpers of a session: a shell with a tool, an MCP server, and an agent process of the same agent.
    proc(11, 10, '/bin/zsh -c npm test', { cpu: 6 }),
    proc(12, 11, 'node /work/app/node_modules/.bin/tsc', { cpu: 30, name: 'node' }),
    proc(13, 10, 'node /Users/user/.npm/_npx/1/node_modules/.bin/mcp-server-github', { name: 'node' }),
    proc(14, 10, '/Users/user/.local/bin/claude --print', { name: '2.1.322' }),
    proc(5, 1, '/Applications/IntelliJ IDEA 2026.3 EAP.app/Contents/MacOS/idea', { name: 'idea', cpu: 25 }),
    proc(6, 5, '/Users/user/Library/Caches/JetBrains/IntelliJIdea2026.3/acp-agents/claude-acp/0.106.0/claude-agent-acp', { name: 'claude-agent-acp' }),
    proc(20, 6, '/Users/user/Library/Caches/JetBrains/IntelliJIdea2026.3/acp-agents/claude-acp/0.106.0/claude', { name: 'claude' }),
    proc(21, 6, '/Users/user/Library/Caches/JetBrains/IntelliJIdea2026.3/acp-agents/claude-acp/0.106.0/claude', { name: 'claude', cpu: 12 }),
    proc(7, 5, '/opt/homebrew/bin/node /Users/user/Library/Caches/JetBrains/IntelliJIdea2026.3/acp-agents/codex/node_modules/@agentclientprotocol/codex-acp/dist/index.js', { name: 'node' }),
    proc(30, 7, '/opt/homebrew/Caskroom/codex/0.167.0/bin/codex app-server', { name: 'codex' }),
    proc(DAEMON, 5, '/opt/homebrew/bin/node /Users/user/src/megachat/src/main.mjs daemon', { name: 'node' }),
    proc(40, DAEMON, '/opt/homebrew/bin/node /Users/user/src/megachat/src/child-supervisor.mjs /opt/homebrew/bin/node', { name: 'node' }),
    proc(42, 40, '/opt/homebrew/bin/node /Users/user/src/megachat/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js', { name: 'node' }),
    proc(41, 42, '/Users/user/.local/bin/claude', { name: '2.1.322', cpu: 3 }),
    // The history reader and the account check of Megachat are helpers of the daemon, not sessions.
    proc(43, DAEMON, '/Users/user/.local/bin/central run codex -- app-server --listen stdio://', { name: 'central' }),
    proc(44, 43, '/opt/homebrew/bin/codex app-server --listen stdio://', { name: 'codex' }),
    proc(50, 1, 'tmux new-session -d', { name: 'tmux' }),
    proc(52, 50, '-zsh'),
    proc(51, 52, 'node /opt/homebrew/bin/pi', { name: 'node' }),
    proc(60, 1, '/Applications/Ghostty.app/Contents/MacOS/ghostty', { name: 'ghostty' }),
    proc(62, 60, '/bin/zsh -l'),
    proc(61, 62, '/Users/user/.bun/bin/opencode', { name: 'opencode.exe' }),
    proc(70, 1, '/Users/user/.local/bin/claude', { name: '2.1.322', cpu: 50 }),
    proc(80, DAEMON, '/opt/homebrew/bin/node /Users/user/src/megachat/src/child-supervisor.mjs /opt/homebrew/bin/node', { name: 'node' }),
    proc(81, 80, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
    proc(90, 5, '/Users/user/Library/Caches/JetBrains/IntelliJIdea2026.3/acp-agents/codex-acp/1.0.0/codex-acp', { name: 'codex-acp' }),
    // The background service of Claude Code and its helpers are no sessions.
    proc(95, 1, '/Users/user/.local/bin/claude daemon run', { name: '2.1.322' }),
    proc(96, 95, 'claude bg-pty-host', { name: '2.1.322' }),
    proc(97, 96, 'claude bg-spare', { name: '2.1.322' }),
  ]
}

const directories = { 10: '/work/app', 20: '/work/ide', 21: '/work/ide/module', 30: '/work/codex', 51: '/work/pi', 61: '/work/opencode', 70: '/work/lost', 90: '/work/acp' }
const runs = [
  { id: 'live', pid: 40, status: 'dispatched', providerSessionId: 'claude-session-1', title: 'Fix the build', cwd: '/work/megachat-task', prompt: SECRET },
  { id: 'done', pid: 80, status: 'completed', providerSessionId: 'claude-session-2', title: 'Old task', cwd: '/work/old-task', prompt: SECRET },
]

async function view(table, options = {}) {
  const running = new RunningAgents(fakeState(options.runs ?? runs), { table, clock: options.clock ?? fakeClock(), daemonPid: DAEMON })
  return { running, answer: await running.query(options.query ?? { limit: 200 }) }
}

test('the process table gives each agent with its working directory, its parent and its state, and one row for each session', async () => {
  const { answer } = await view(fakeTable(machine(), directories))
  const rows = Object.fromEntries(answer.sessions.map(row => [row.pid, row]))
  assert.deepEqual(Object.keys(rows).map(Number).sort((left, right) => left - right), [10, 20, 21, 30, 41, 51, 61, 70, 81, 90])
  const summary = pid => [rows[pid].agent, rows[pid].cwd, rows[pid].parent.kind, rows[pid].parent.name, rows[pid].parent.pid, rows[pid].state]
  assert.deepEqual(summary(10), ['claude', '/work/app', 'terminal', 'Terminal', 2, 'active'])
  assert.deepEqual(summary(20), ['claude', '/work/ide', 'ide', 'IntelliJ IDEA 2026.3 EAP', 5, 'idle'])
  assert.deepEqual(summary(21), ['claude', '/work/ide/module', 'ide', 'IntelliJ IDEA 2026.3 EAP', 5, 'active'])
  assert.deepEqual(summary(30), ['codex', '/work/codex', 'ide', 'IntelliJ IDEA 2026.3 EAP', 5, 'idle'])
  assert.deepEqual(summary(41), ['claude', '/work/megachat-task', 'megachat', 'Megachat', DAEMON, 'idle'])
  assert.deepEqual(summary(51), ['pi', '/work/pi', 'terminal', 'tmux', 50, 'idle'])
  assert.deepEqual(summary(61), ['opencode', '/work/opencode', 'terminal', 'Ghostty', 60, 'idle'])
  assert.deepEqual(summary(70), ['claude', '/work/lost', 'unknown', 'launchd', 1, 'orphan'])
  assert.deepEqual(summary(81), ['claude', '/work/old-task', 'megachat', 'Megachat', DAEMON, 'orphan'])
  assert.deepEqual(summary(90), ['codex', '/work/acp', 'ide', 'IntelliJ IDEA 2026.3 EAP', 5, 'idle'])
  // The state gives the session ID and the title of a Megachat child. A session outside Megachat has none yet.
  assert.deepEqual([rows[41].sessionId, rows[41].title, rows[81].sessionId, rows[10].sessionId, rows[10].title], ['claude-session-1', 'Fix the build', 'claude-session-2', '', ''])
  assert.ok(answer.sessions.every(row => row.status === null && row.lastActivityAt === null))
  assert.equal(rows[10].startedAt, new Date(START + 10000).toISOString())
  // The orphans come first, then the active and the idle sessions, the newest start first in each group.
  assert.deepEqual(answer.sessions.map(row => row.pid), [81, 70, 21, 10, 90, 61, 51, 41, 30, 20])
  assert.deepEqual(answer.incomplete, [message('running.incomplete.logs'), message('running.incomplete.opencode')])
  assert.equal(answer.nextCursor, null)
  assert.equal(answer.truncated, false)
})

test('the state of a session comes from the CPU load of its process and its helpers', async () => {
  const table = (agent, helper) => fakeTable([proc(1, 0, '/sbin/launchd'), proc(50, 1, 'tmux', { name: 'tmux' }),
    proc(10, 50, 'claude', { cpu: agent }), proc(11, 10, '/bin/zsh -c make', { cpu: helper })], { 10: '/work' })
  const state = async (agent, helper) => (await view(table(agent, helper))).answer.sessions[0].state
  assert.equal(await state(0.3, 0), 'idle')
  assert.equal(await state(ACTIVE_CPU_PERCENT - 0.1, 0), 'idle')
  assert.equal(await state(ACTIVE_CPU_PERCENT, 0), 'active')
  assert.equal(await state(0.1, ACTIVE_CPU_PERCENT + 20), 'active')
})

test('an adapter with its agent gives one row, and an agent below another agent gives a row of its own', async () => {
  const processes = [
    proc(1, 0, '/sbin/launchd'),
    proc(5, 1, '/Applications/Zed.app/Contents/MacOS/zed', { name: 'zed' }),
    proc(6, 5, '/usr/local/bin/node /usr/local/lib/node_modules/@zed-industries/claude-code-acp/dist/index.js', { name: 'node' }),
    proc(7, 6, '/usr/local/lib/node_modules/@zed-industries/claude-code-acp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude', { name: 'claude' }),
    // An agent that a shell of another agent starts is a session of its own.
    proc(8, 7, '/bin/zsh -c codex exec'),
    proc(9, 8, 'node /usr/local/bin/codex exec', { name: 'node' }),
    proc(10, 9, '/usr/local/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/codex/codex exec', { name: 'codex' }),
  ]
  const { answer } = await view(fakeTable(processes, { 7: '/work', 9: '/work' }))
  assert.deepEqual(answer.sessions.map(row => [row.pid, row.agent, row.parent.kind, row.parent.name]).sort(),
    [[7, 'claude', 'ide', 'Zed'], [9, 'codex', 'ide', 'Zed']])
})

test('a process with the parent PID 1 and no Megachat run is an orphan, and a Megachat child with a live run is not', async () => {
  const processes = [
    proc(1, 0, '/sbin/launchd'),
    proc(DAEMON, 1, 'node /Users/user/src/megachat/src/main.mjs daemon', { name: 'node' }),
    proc(40, DAEMON, 'node /Users/user/src/megachat/src/child-supervisor.mjs node', { name: 'node' }),
    proc(41, 40, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
    proc(42, 1, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
    // A shell that stays after its terminal ended does not own the session.
    proc(43, 1, '/bin/zsh'),
    proc(44, 43, 'codex', { name: 'codex' }),
  ]
  const states = async runList => Object.fromEntries((await view(fakeTable(processes, { 42: '/work', 44: '/work' }), { runs: runList }))
    .answer.sessions.map(row => [row.pid, row.state]))
  assert.deepEqual(await states([{ id: 'run', pid: 40, status: 'dispatched', cwd: '/work' }]), { 41: 'idle', 42: 'orphan', 44: 'orphan' })
  assert.deepEqual(await states([{ id: 'run', pid: 40, status: 'interrupted', cwd: '/work' }]), { 41: 'orphan', 42: 'orphan', 44: 'orphan' })
  // A process of the daemon without a run is a helper of Megachat, such as the account check.
  assert.deepEqual(await states([]), { 42: 'orphan', 44: 'orphan' })
})

test('the list is bounded: limit, nextCursor and truncated page through 500 sessions', async () => {
  const processes = [proc(1, 0, '/sbin/launchd'), proc(2, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2', { name: 'iTerm2' })]
  for (let index = 0; index < 500; index++) processes.push(proc(1000 + index, 2, 'claude', { cpu: index % 50 === 0 ? 40 : 0, startedAt: START + (index % 7) * 1000 }))
  const running = new RunningAgents(fakeState(), { table: fakeTable(processes), clock: fakeClock(), daemonPid: DAEMON })
  const first = await running.query()
  assert.equal(first.sessions.length, 50)
  assert.equal(first.truncated, true)
  assert.ok(first.nextCursor)
  const seen = [...first.sessions]
  for (let cursor = first.nextCursor; cursor;) {
    const page = await running.query({ limit: 200, cursor })
    assert.ok(page.sessions.length <= 200)
    assert.equal(page.truncated, page.nextCursor !== null)
    seen.push(...page.sessions)
    cursor = page.nextCursor
  }
  assert.equal(seen.length, 500)
  assert.equal(new Set(seen.map(row => row.pid)).size, 500)
  assert.deepEqual(seen.slice(0, 10).map(row => row.state), Array(10).fill('active'))
  for (let index = 1; index < seen.length; index++) {
    const [previous, row] = [seen[index - 1], seen[index]]
    if (previous.state === row.state) assert.ok(previous.startedAt >= row.startedAt)
  }
  await assert.rejects(running.query({ limit: 201 }), { code: 'invalid' })
  await assert.rejects(running.query({ cursor: 'not a cursor' }), { code: 'invalid' })
  await assert.rejects(running.query({ agent: 'junie' }), { code: 'invalid' })
  await assert.rejects(running.query({ state: 'stuck' }), { code: 'invalid' })
})

test('two calls in 5 seconds make one ps call, and a later call makes a new one', async () => {
  const clock = fakeClock()
  const table = fakeTable(machine(), directories)
  const running = new RunningAgents(fakeState(runs), { table, clock, daemonPid: DAEMON })
  const [first, second] = await Promise.all([running.query(), running.query({ agent: 'codex' })])
  clock.time += SNAPSHOT_TTL_MS - 1
  const third = await running.query({ state: 'orphan' })
  assert.equal(table.calls.processes, 1)
  assert.deepEqual([first.scannedAt, second.scannedAt, third.scannedAt], Array(3).fill(new Date(START).toISOString()))
  assert.deepEqual(second.sessions.map(row => row.pid), [90, 30])
  assert.deepEqual(third.sessions.map(row => row.pid), [81, 70])
  clock.time += 1
  assert.equal((await running.query()).scannedAt, new Date(START + SNAPSHOT_TTL_MS).toISOString())
  assert.equal(table.calls.processes, 2)
})

test('the working directory comes once for each process, and again for a reused PID with another start time', async () => {
  const clock = fakeClock()
  let processes = [proc(1, 0, '/sbin/launchd'), proc(50, 1, 'tmux', { name: 'tmux' }), proc(10, 50, 'claude'), proc(11, 50, 'codex')]
  const table = fakeTable(() => processes, { 10: '/work/a', 11: '/work/b' })
  const running = new RunningAgents(fakeState(), { table, clock, daemonPid: DAEMON })
  await running.query()
  clock.time += SNAPSHOT_TTL_MS
  await running.query()
  assert.deepEqual(table.calls.resolve, [[10, 11]])
  processes = [...processes.slice(0, 3), proc(11, 50, 'codex', { startedAt: START + 60000 }), proc(12, 50, 'pi')]
  clock.time += SNAPSHOT_TTL_MS
  const answer = await running.query()
  assert.deepEqual(table.calls.resolve, [[10, 11], [11, 12]])
  assert.deepEqual(answer.sessions.map(row => [row.pid, row.cwd]).sort(), [[10, '/work/a'], [11, '/work/b'], [12, null]])
})

test('an unreadable working directory gives a row and an entry in incomplete, not an error', async () => {
  const processes = [proc(1, 0, '/sbin/launchd'), proc(50, 1, 'tmux', { name: 'tmux' }), proc(10, 50, 'claude'), proc(11, 50, 'codex')]
  const { answer } = await view(fakeTable(processes, { 10: '/work' }))
  assert.deepEqual(answer.sessions.map(row => [row.pid, row.cwd]).sort(), [[10, '/work'], [11, null]])
  assert.deepEqual(answer.incomplete, [message('running.incomplete.cwd', 1), message('running.incomplete.logs')])
  // A failed resolver and a failed ps call give an incomplete view too.
  const broken = fakeTable(processes)
  broken.resolve = async () => { throw new Error(SECRET) }
  assert.deepEqual((await view(broken)).answer.incomplete, [message('running.incomplete.cwd', 2), message('running.incomplete.logs')])
  broken.processes = async () => { throw new Error(SECRET) }
  const failed = (await view(broken)).answer
  assert.deepEqual([failed.sessions, failed.incomplete], [[], [message('running.incomplete.processes'), message('running.incomplete.logs')]])
})

test('the output holds no command-line argument, no prompt of a run and no environment', async () => {
  const { answer } = await view(fakeTable(machine(), directories))
  const text = JSON.stringify(answer)
  assert.ok(!text.includes(SECRET))
  assert.ok(!text.includes('--token'))
  assert.ok(!text.includes('app-server'))
  for (const row of answer.sessions) {
    assert.deepEqual(Object.keys(row), ['agent', 'sessionId', 'title', 'cwd', 'state', 'status', 'startedAt', 'lastActivityAt', 'pid', 'parent'])
    assert.deepEqual(Object.keys(row.parent), ['kind', 'name', 'pid'])
  }
})

test('the project selects the sessions in a directory and below it', async () => {
  const { answer } = await view(fakeTable(machine(), directories), { query: { project: '/work/ide/' } })
  assert.deepEqual(answer.sessions.map(row => row.pid), [21, 20])
  const prefix = await view(fakeTable(machine(), { ...directories, 30: '/work/ide-other' }), { query: { project: '/work/ide' } })
  assert.deepEqual(prefix.answer.sessions.map(row => row.pid), [21, 20])
  await assert.rejects(prefix.running.query({ project: 'work/ide' }), { code: 'invalid' })
})

test('another platform gives no session and names the platform in incomplete', async () => {
  const table = processTable('linux')
  assert.equal(table.supported, false)
  const { answer } = await view(table)
  assert.deepEqual(answer.sessions, [])
  assert.deepEqual(answer.incomplete, [message('running.incomplete.platform', 'linux'), message('running.incomplete.logs')])
})

test('the parsers read synthetic ps and lsof output with spaces, short days, long names, UTF-8 and broken lines', () => {
  const pad = (text, width) => text + ' '.repeat(Math.max(0, width - Buffer.byteLength(text)))
  const line = (pid, ppid, start, cpu, name, args) => `${String(pid).padStart(5)} ${String(ppid).padStart(5)} ${start} ${cpu.padStart(6)} ${pad(name, 16)} ${args}`
  const output = Buffer.from([
    line(1, 0, 'Mon Nov  2 22:59:31 2026', '1.0', 'launchd', '/sbin/launchd'),
    line(20404, 1, 'Wed Nov 11 09:05:00 2026', '30,7', 'idea', '/Applications/IntelliJ IDEA 2026.3 EAP.app/Contents/MacOS/idea -Dx=1'),
    line(1448, 1288, 'Wed Nov 11 09:06:00 2026', '0.0', 'Codex (Renderer)', '/Applications/ChatGPT.app/Contents/Frameworks/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer'),
    line(77, 1, 'Thu Jan  1 00:00:01 2026', '0.0', 'привет', '/Users/user/bin/привет arg'),
    // The shape of the character type UTF-8: `ucomm` has 16 bytes, and `args` keeps the bytes outside ASCII.
    line(80, 1, 'Thu Nov 12 00:13:22 2026', '0.0', 'Café', '/Applications/Café.app/Contents/MacOS/Café --flag'),
    `${line(78, 1, 'Thu Jan  1 00:00:01 2026', '0.0', 'zombie', '').trimEnd()}`,
    '  PID  PPID STARTED                       %CPU UCOMM            ARGS',
    'garbage line',
    line(79, 1, 'Thu Foo  1 00:00:01 2026', '0.0', 'odd', 'odd'),
    '',
  ].join('\n'))
  const processes = parseProcesses(output)
  assert.deepEqual(processes.map(item => [item.pid, item.ppid, item.cpu, item.name, item.command]), [
    [1, 0, 1, 'launchd', '/sbin/launchd'],
    [20404, 1, 30.7, 'idea', '/Applications/IntelliJ IDEA 2026.3 EAP.app/Contents/MacOS/idea -Dx=1'],
    [1448, 1288, 0, 'Codex (Renderer)', '/Applications/ChatGPT.app/Contents/Frameworks/Codex (Renderer).app/Contents/MacOS/Codex (Renderer) --type=renderer'],
    [77, 1, 0, 'привет', '/Users/user/bin/привет arg'],
    [80, 1, 0, 'Café', '/Applications/Café.app/Contents/MacOS/Café --flag'],
    [78, 1, 0, 'zombie', ''],
  ])
  assert.equal(processes[0].startedAt, new Date(2026, 10, 2, 22, 59, 31).getTime())
  assert.equal(processes[3].startedAt, new Date(2026, 0, 1, 0, 0, 1).getTime())
  const found = parseOpenFiles([
    'p10', 'fcwd', 'n/Users/user/src/my project', 'ftxt', 'n/Users/user/bin/a.jsonl', 'f3', 'n/Users/user/.codex/sessions/rollout-a.jsonl',
    'p11', 'fcwd', 'n/private/tmp/\\xd1\\x82\\xd0\\xb5\\xd1\\x81\\xd1\\x82 dir', 'f4', 'n/Users/user/\\xd1\\x82.jsonl', 'f5', 'n/Users/user/log.txt',
    'p12', 'fcwd',
    'pabc', 'n/not/a/pid',
    'p13', 'fcwd', 'n/first', 'n/second', 'f7', 'n/x.jsonl', 'f8', 'n/x.jsonl', '',
  ].join('\n'))
  assert.deepEqual([...found], [[10, { cwd: '/Users/user/src/my project', files: ['/Users/user/.codex/sessions/rollout-a.jsonl'] }],
    [11, { cwd: '/private/tmp/тест dir', files: ['/Users/user/т.jsonl'] }], [12, { cwd: null, files: [] }], [13, { cwd: '/first', files: ['/x.jsonl'] }]])
})

test('the real process table of macOS gives this test process and its working directory', { skip: process.platform !== 'darwin' }, async () => {
  const table = processTable()
  const processes = await table.processes()
  const self = processes.find(item => item.pid === process.pid)
  assert.equal(self?.ppid, process.ppid)
  assert.ok(Math.abs(self.startedAt - (Date.now() - process.uptime() * 1000)) < 5000)
  const found = await table.resolve([process.pid])
  assert.equal(found.get(process.pid).cwd, await realpath(process.cwd()))
})

test('the real process table of macOS gives a command line outside ASCII in UTF-8 and the start time of the process', { skip: process.platform !== 'darwin' }, async t => {
  const marker = `Café-日本-${process.pid}`
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', marker], { stdio: 'ignore' })
  t.after(() => child.kill())
  await new Promise(resolve => child.once('spawn', resolve))
  const started = Date.now()
  const item = (await processTable().processes()).find(entry => entry.pid === child.pid)
  assert.ok(item?.command.endsWith(` ${marker}`), item?.command)
  assert.equal(item.ppid, process.pid)
  assert.ok(Math.abs(item.startedAt - started) < 5000)
})

test('the main agent has the tool agents_running, and the children do not get it', { timeout: 10000 }, async t => {
  const fake = fauxProvider()
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { keepAlive: { enabled: false }, processTable: fakeTable(machine(), directories) })
  t.after(() => service.close())
  const tool = service.extension().tools.find(item => item.name === 'agents_running')
  assert.equal(tool.description, message('tool.running'))
  const answer = JSON.parse((await tool.execute({ agent: 'pi' })).output[0].text)
  assert.deepEqual(answer.sessions.map(row => [row.pid, row.cwd, row.parent.kind]), [[51, '/work/pi', 'terminal']])
  assert.ok(!(await readFile(new URL('../src/MegachatHistoryServer.mjs', import.meta.url), 'utf8')).includes('running'))
})

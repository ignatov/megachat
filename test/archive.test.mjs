import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { stopPermission } from '../src/AcpBridge.mjs'
import { AgentStop } from '../src/AgentStop.mjs'
import { ClaudeSessionSource } from '../src/ClaudeSessionSource.mjs'
import { message } from '../src/messages.mjs'
import { PiSessionSource } from '../src/PiSessionSource.mjs'
import { ARCHIVED_TITLE_PREFIX, archivedTitle, SessionArchive } from '../src/SessionArchive.mjs'
import { CodexSessionSource } from '../src/CodexSessionSource.mjs'

// The tests work on copies of logs in a temporary directory. No test reads `~/.claude`, `~/.codex` or `~/.pi`, sends a
// real signal, or runs `codex` or `git`: each test passes its own signal function, codex runner and git function.
const USER = 501
const DAEMON = 900
const LAUNCHER = 800
const START = Date.UTC(2026, 10, 12, 9, 0, 0)
const NOW = START + 48 * 3600000
const KEY = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCD'
const IDS = { one: '11111111-1111-4111-8111-111111111111', two: '22222222-2222-4222-8222-222222222222', three: '33333333-3333-4333-8333-333333333333',
  ide: '44444444-4444-4444-8444-444444444444', pi: '55555555-5555-4555-8555-555555555555', codex: '66666666-6666-4666-8666-666666666666' }

const proc = (pid, ppid, command, { name = command.split(' ', 1)[0].split('/').pop().slice(0, 16) } = {}) =>
  ({ pid, ppid, uid: USER, startedAt: START + pid * 1000, cpu: 0, name, command })
const BASE = () => [
  proc(1, 0, '/sbin/launchd'),
  proc(LAUNCHER, 1, '/opt/homebrew/bin/node /Users/user/src/megachat/bin/megachat.mjs', { name: 'node' }),
  proc(DAEMON, LAUNCHER, '/opt/homebrew/bin/node /Users/user/src/megachat/src/main.mjs daemon', { name: 'node' }),
  proc(30, 1, '/System/Applications/Utilities/Terminal.app/Contents/MacOS/Terminal', { name: 'Terminal' }),
  proc(31, 30, '-zsh', { name: 'zsh' }),
  proc(32, 31, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
  proc(33, 31, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
  proc(5, 1, '/Applications/IntelliJ IDEA 2026.3 EAP.app/Contents/MacOS/idea', { name: 'idea' }),
  proc(6, 5, '/Users/user/Library/Caches/JetBrains/IntelliJIdea2026.3/acp-agents/claude-acp/0.106.0/claude-agent-acp', { name: 'claude-agent-acp' }),
  proc(20, 6, '/Users/user/.local/bin/claude', { name: '2.1.322' }),
]

const line = value => `${JSON.stringify(value)}\n`
const claudeLog = (id, { prompt = 'Fix IJAI-6285', title, reply = 'Done, committed.' } = {}) => [
  line({ type: 'user', uuid: `${id}-u1`, timestamp: '2026-11-10T10:00:00.000Z', cwd: '/work/json', message: { role: 'user', content: prompt } }),
  line({ type: 'assistant', uuid: `${id}-a1`, timestamp: '2026-11-10T10:00:05.000Z', message: { role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't1', name: 'Edit', input: { file_path: '/work/json/src/a.mjs', old_string: 'a', new_string: 'b' } }] } }),
  line({ type: 'user', uuid: `${id}-u2`, timestamp: '2026-11-10T10:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }),
  line({ type: 'assistant', uuid: `${id}-a2`, timestamp: '2026-11-10T10:00:07.000Z', message: { role: 'assistant', stop_reason: 'tool_use',
    content: [{ type: 'tool_use', id: 't2', name: 'Bash', input: { command: 'git commit -m x' } }] } }),
  line({ type: 'user', uuid: `${id}-u3`, timestamp: '2026-11-10T10:00:08.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: '[main 1a2b3c4] Fix it\n 1 file changed' }] } }),
  line({ type: 'assistant', uuid: `${id}-a3`, timestamp: '2026-11-10T10:00:09.000Z', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: reply }] } }),
  ...(title ? [line({ type: 'custom-title', customTitle: title, sessionId: id }), line({ type: 'agent-name', agentName: title, sessionId: id })] : []),
].join('')

/**
 * The rig: logs in a temporary home, a fake process table, a fake state with a turn, a fake live view, and the real
 * stopper and archive. [signals] lists each signal. A signal ends the process, unless the PID is in `stubborn`.
 */
async function rig({ processes = BASE(), sessions = {}, git = async () => '', codex } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'megachat-archive-'))
  const directory = join(home, 'state')
  await mkdir(directory)
  const claude = new ClaudeSessionSource({ home, environment: {} })
  const pi = new PiSessionSource({ home, environment: {} })
  const sources = { claude, pi, codex: new CodexSessionSource({ home, environment: {} }) }
  const records = new Map()
  const context = { home, directory, signals: [], stubborn: new Set(), commands: [], table: undefined, turn: undefined }
  const add = async (agent, id, { text, cwd = '/work/json', title, step = 'end', age = 48 * 3600000, path } = {}) => {
    const file = path ?? (agent === 'pi' ? join(home, '.pi', 'agent', 'sessions', '--work-json--', `2026-11-10T10-00-00-000Z_${id}.jsonl`) : claude.pathOf(cwd, id))
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, text)
    records.set(`${agent}:${id}`, { path: file, agent, sessionId: id, nameId: id, cwd, title, step, startedAt: START, mtimeMs: NOW - age })
    return file
  }
  const catalog = { session: (agent, id) => records.get(`${agent}:${id}`), ensure: async path => [...records.values()].find(record => record.path === path),
    source: agent => sources[agent] }
  context.add = add
  context.records = records
  context.table = { platform: 'darwin', supported: true, current: processes, async processes() { return context.table.current }, async resolve() { return new Map() } }
  const state = { runs: [], current: null, snapshot: async () => ({ runs: Object.fromEntries(state.runs.map(run => [run.id, run])), current: state.current }) }
  let turns = 0
  context.state = state
  context.turn = (kind = 'user') => { state.current = { id: `turn-${++turns}`, kind, cancelling: false } }
  context.turn()
  const clock = { now: () => NOW }
  const timers = []
  const stopper = new AgentStop(state, { table: context.table, running: undefined, clock, timer: (run, ms) => { timers.push({ run, ms }); return () => {} },
    daemonPid: DAEMON, daemonParentPid: LAUNCHER, uid: USER, kill: (pid, signal) => {
      context.signals.push([pid, signal])
      if (!context.stubborn.has(pid)) context.table.current = context.table.current.filter(item => item.pid !== pid)
    } })
  context.sessions = sessions
  const running = {
    table: context.table,
    async view() {
      const owners = stopper.sessions(context.table.current, await state.snapshot())
      const rows = context.table.current.filter(item => context.sessions[item.pid]).map(item => ({ pid: item.pid, slot: 0, agent: context.sessions[item.pid].agent,
        startedAt: item.startedAt, parent: owners.get(item.pid)?.parent, cwd: context.sessions[item.pid].cwd ?? '/work/json', sessionId: context.sessions[item.pid].sessionId,
        status: context.sessions[item.pid].status ?? 'waiting_for_user', state: 'idle' }))
      return { scannedAt: NOW, rows, incomplete: [] }
    },
  }
  stopper.running = running
  const archive = new SessionArchive({ state, running, stopper, catalog: () => catalog, directory, codexArchive: join(home, '.codex', 'archived_sessions'), fs,
    clock, sleep: async () => { context.slept = (context.slept ?? 0) + 1; clock.now = () => NOW + 11000 * context.slept }, git,
    codex: codex ?? (async args => { context.commands.push(args) }), exitWaitMs: 10000 })
  Object.assign(context, { stopper, archive, views: [], timers })
  stopper.watch(view => context.views.push(view))
  return context
}

/** Starts a call and answers its dialog with [option] when the dialog shows. Gives the result and the request. */
async function answered(context, args, option = 'archive') {
  const call = context.archive.call(args)
  call.catch(() => {})
  let request
  for (let index = 0; index < 400 && !request; index++) {
    request = context.views.at(-1)?.requests[0]
    if (!request) await new Promise(resolve => setImmediate(resolve))
  }
  assert.ok(request, 'no dialog')
  context.stopper.answer(request.id, option)
  return { result: await call, request }
}
const ends = async file => (await readFile(file, 'utf8')).trimEnd().split('\n')
const item = (agent, sessionId) => ({ agent, sessionId })

test('a batch of three gives one dialog with three lines, and nothing changes before the answer', async () => {
  const context = await rig()
  const files = []
  for (const id of [IDS.one, IDS.two, IDS.three]) files.push(await context.add('claude', id, { text: claudeLog(id), title: `Task ${id.slice(0, 2)}` }))
  const sizes = await Promise.all(files.map(async file => (await stat(file)).size))
  const call = context.archive.call({ action: 'archive', sessions: [IDS.one, IDS.two, IDS.three].map(id => item('claude', id)) })
  call.catch(() => {})
  for (let index = 0; index < 400 && !context.views.at(-1)?.requests.length; index++) await new Promise(resolve => setImmediate(resolve))
  const request = context.views.at(-1).requests[0]
  assert.equal(request.kind, 'archive')
  assert.equal(request.rows.length, 3)
  assert.deepEqual(await Promise.all(files.map(async file => (await stat(file)).size)), sizes)
  assert.deepEqual(context.signals, [])
  const permission = stopPermission(request)
  assert.deepEqual(permission.options.map(option => option.optionId), ['archive', 'keep'])
  assert.equal(permission.toolCall.rawInput.command.split('\n').length, 3)
  assert.equal(permission.toolCall.title, message('archive.dialog.title.many', 3))
  context.stopper.answer(request.id, 'archive')
  const result = await call
  assert.equal(result.outcome, 'archived')
  assert.deepEqual(result.archived.map(row => row.hidden), ['title', 'title', 'title'])
  assert.equal(result.archived[0].resume, `claude --resume ${IDS.one}`)
})

test('the answer keep changes nothing, and an automatic turn cannot ask', async () => {
  const context = await rig()
  const file = await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'Fix the build' })
  const before = await readFile(file, 'utf8')
  const { result } = await answered(context, { action: 'archive', sessions: [item('claude', IDS.one)] }, 'keep')
  assert.deepEqual([result.outcome, result.archived, result.note], ['declined', [], message('archive.result.declined')])
  assert.equal(await readFile(file, 'utf8'), before)
  assert.deepEqual(await context.archive.cards.all(), [])
  context.turn('morning')
  await assert.rejects(context.archive.call({ action: 'archive', sessions: [item('claude', IDS.one)] }), { code: 'archiveEvent' })
  context.turn()
  // The stop dialog and the archive dialog take only their own options.
  context.stopper.open('SIGTERM', context.state.current.id, [])
  const stop = context.views.at(-1).requests[0]
  assert.throws(() => context.stopper.answer(stop.id, 'archive'), { code: 'invalid' })
})

test('the log gets the two records of Air, in its order and with its title', async () => {
  const context = await rig()
  const file = await context.add('claude', IDS.one, { text: claudeLog(IDS.one, { title: 'Fix the  build' }), title: 'Fix the  build' })
  const sidecar = join(file, '..', IDS.one, 'custom-title.json')
  const before = (await readFile(file, 'utf8')).split('\n').length
  const { result } = await answered(context, { action: 'archive', sessions: [item('claude', IDS.one)] })
  assert.equal(result.archived[0].hidden, 'title')
  const lines = await ends(file)
  assert.equal(lines.length, before + 1)
  assert.deepEqual(lines.slice(-2), [
    `{"type":"custom-title","customTitle":"[archived] Fix the build","sessionId":"${IDS.one}"}`,
    `{"type":"agent-name","agentName":"[archived] Fix the build","sessionId":"${IDS.one}"}`,
  ])
  // A session without a sidecar keeps none.
  await assert.rejects(stat(sidecar))
  assert.equal(archivedTitle('x'.repeat(300), IDS.one).length, 200)
  assert.equal(archivedTitle('  ', IDS.one), `${ARCHIVED_TITLE_PREFIX}Session 11111111`)
})

test('archive twice writes nothing, and an existing sidecar is replaced with the title', async () => {
  const context = await rig()
  const file = await context.add('claude', IDS.one, { text: claudeLog(IDS.one, { title: 'Fix the build' }), title: 'Fix the build' })
  const sidecar = join(file, '..', IDS.one, 'custom-title.json')
  await mkdir(join(file, '..', IDS.one), { recursive: true })
  await writeFile(sidecar, '{"customTitle":"Fix the build"}', { mode: 0o600 })
  await answered(context, { action: 'archive', sessions: [item('claude', IDS.one)] })
  assert.deepEqual(JSON.parse(await readFile(sidecar, 'utf8')), { customTitle: '[archived] Fix the build' })
  assert.equal((await stat(sidecar)).mode & 0o777, 0o600)
  const size = (await stat(file)).size
  const again = await context.archive.call({ action: 'archive', sessions: [item('claude', IDS.one)] })
  assert.deepEqual([again.outcome, again.skipped.map(row => row.reason)], ['none', [message('archive.skipped.already')]])
  assert.equal((await stat(file)).size, size)
  assert.equal(context.views.at(-1).requests.length, 0)
})

test('a session that Air archived counts as archived, and restore gives its title back', async () => {
  const context = await rig()
  const file = await context.add('claude', IDS.one, { text: claudeLog(IDS.one, { title: '[archived] Fix the build' }), title: '[archived] Fix the build' })
  const result = await context.archive.call({ action: 'restore', sessions: [item('claude', IDS.one)] })
  assert.equal(result.restored[0].resume, `claude --resume ${IDS.one}`)
  assert.deepEqual((await ends(file)).slice(-2), [
    `{"type":"custom-title","customTitle":"Fix the build","sessionId":"${IDS.one}"}`,
    `{"type":"agent-name","agentName":"Fix the build","sessionId":"${IDS.one}"}`,
  ])
  assert.deepEqual(context.signals, [])
  // A session that is not archived is refused, and the log keeps its size.
  const size = (await stat(file)).size
  const again = await context.archive.call({ action: 'restore', sessions: [item('claude', IDS.one)] })
  assert.deepEqual(again.refused.map(row => row.reason), [message('archive.skipped.notArchived')])
  assert.equal((await stat(file)).size, size)
})

test('restore of a session that Megachat archived keeps the card with restoredAt and starts no process', async () => {
  const context = await rig()
  const file = await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'Fix the build' })
  await answered(context, { action: 'archive', sessions: [item('claude', IDS.one)] })
  assert.match((await ends(file)).at(-1), /^\{"type":"agent-name","agentName":"\[archived\] Fix the build"/)
  const before = context.table.current.length
  const result = await context.archive.call({ action: 'restore', sessions: [item('claude', IDS.one)] })
  assert.equal(result.restored.length, 1)
  assert.match((await ends(file)).at(-1), /^\{"type":"agent-name","agentName":"Fix the build"/)
  const [card] = await context.archive.cards.all()
  assert.equal(card.restoredAt, result.restored[0].restoredAt)
  assert.equal(card.hidden, 'title')
  assert.equal(context.table.current.length, before)
})

test('the card has the ticket, the commit, the file, the title and the command, and its file has mode 0600', async () => {
  const context = await rig({ git: async args => args[0] === 'status' ? ' M a\n M b\n?? c\n' : args[0] === 'rev-list' ? '2\n' : 'main\n' })
  await context.add('claude', IDS.one, { text: claudeLog(IDS.one, { prompt: 'Fix IJAI-6285 and see https://github.com/ignatov/megachat/issues/12, not UTF-8' }), title: 'Fix the build' })
  await answered(context, { action: 'archive', sessions: [item('claude', IDS.one)] })
  const [card] = await context.archive.cards.all()
  assert.deepEqual([card.agent, card.sessionId, card.title, card.cwd, card.branch], ['claude', IDS.one, 'Fix the build', '/work/json', 'main'])
  assert.deepEqual(card.tickets, ['IJAI-6285', 'https://github.com/ignatov/megachat/issues/12'])
  assert.deepEqual([card.commits, card.files], [['1a2b3c4'], ['/work/json/src/a.mjs']])
  assert.deepEqual([card.firstPrompt.startsWith('Fix IJAI-6285'), card.lastReply, card.resume.command], [true, 'Done, committed.', `claude --resume ${IDS.one}`])
  assert.deepEqual(card.resume.arguments, { agent: 'claude', sessionId: IDS.one, cwd: '/work/json' })
  assert.equal((await stat(join(context.directory, 'session-archive.jsonl'))).mode & 0o777, 0o600)
  // The warnings: 3 files, 2 commits not pushed, an old log, and no other session in the directory.
  assert.deepEqual(card.warnings, [message('archive.warning.uncommitted', 3), message('archive.warning.ahead', 2)])
})

test('a key in the last prompt is masked in the card and in the file', async () => {
  const context = await rig()
  await context.add('claude', IDS.one, { text: claudeLog(IDS.one, { prompt: `Use ${KEY} for the call` }), title: 'Fix the build' })
  await answered(context, { action: 'archive', sessions: [item('claude', IDS.one)] })
  const text = await readFile(join(context.directory, 'session-archive.jsonl'), 'utf8')
  assert.ok(!text.includes(KEY))
  assert.ok(text.includes('[secret removed]'))
})

test('a terminal session gets SIGTERM and the hide, and an IDE session gets a card and no signal', async () => {
  const context = await rig({ sessions: { 32: { agent: 'claude', sessionId: IDS.one }, 20: { agent: 'claude', sessionId: IDS.ide } } })
  const terminal = await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'Fix the build' })
  const ide = await context.add('claude', IDS.ide, { text: claudeLog(IDS.ide), title: 'In the IDE' })
  const ideSize = (await stat(ide)).size
  const { result, request } = await answered(context, { action: 'archive', sessions: [item('claude', IDS.one), item('claude', IDS.ide)] })
  assert.deepEqual(request.rows.map(row => [row.action, row.owner]), [['stop', 'terminal'], ['card', 'ide']])
  assert.deepEqual(context.signals, [[32, 'SIGTERM']])
  assert.equal(result.archived[0].hidden, 'title')
  assert.match((await ends(terminal)).at(-1), /agentName":"\[archived\] Fix the build"/)
  assert.deepEqual([result.archived[1].hidden, result.archived[1].note.includes('IntelliJ IDEA 2026.3 EAP')], ['pending', true])
  assert.equal((await stat(ide)).size, ideSize)
  assert.deepEqual((await context.archive.cards.all()).map(card => [card.sessionId, card.hidden]).sort(), [[IDS.one, 'title'], [IDS.ide, 'pending']])
})

test('an idle session in a multiplexer gets SIGTERM and the hide, as the user answered archive', async () => {
  const processes = [...BASE(), proc(50, 1, 'tmux new-session -d', { name: 'tmux' }), proc(52, 50, '-zsh', { name: 'zsh' }), proc(51, 52, '/Users/user/.local/bin/claude', { name: '2.1.322' })]
  const context = await rig({ processes, sessions: { 51: { agent: 'claude', sessionId: IDS.one } } })
  await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'In tmux' })
  const { request, result } = await answered(context, { action: 'archive', sessions: [item('claude', IDS.one)] })
  assert.deepEqual(request.rows.map(row => [row.action, row.owner]), [['stop', 'multiplexer']])
  assert.deepEqual([context.signals, result.archived[0].hidden], [[[51, 'SIGTERM']], 'title'])
  // The stop tool still refuses the same session: it stops only an orphan.
  context.table.current = processes
  context.sessions[51] = { agent: 'claude', sessionId: IDS.one }
  await assert.rejects(context.stopper.call({ pids: [51], signal: 'SIGKILL' }), () => true).catch(() => {})
  const refused = await context.stopper.call({ pids: [51] })
  assert.deepEqual([refused.outcome, refused.refused[0].reason], ['none', message('stop.refused.owned', 51, 'multiplexer', 'tmux', 50)])
})

test('a process that does not end gets SIGKILL, and the card says pending and the log keeps its size', async () => {
  const context = await rig({ sessions: { 32: { agent: 'claude', sessionId: IDS.one } } })
  context.stubborn.add(32)
  const file = await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'Fix the build' })
  const size = (await stat(file)).size
  const { result } = await answered(context, { action: 'archive', sessions: [item('claude', IDS.one)] })
  assert.deepEqual(context.signals, [[32, 'SIGTERM'], [32, 'SIGKILL']])
  assert.deepEqual([result.archived[0].hidden, result.archived[0].error], ['pending', message('archive.error.alive')])
  assert.equal((await stat(file)).size, size)
  assert.equal((await context.archive.cards.all())[0].hidden, 'pending')
})

test('a busy session, a tool below the process, a Megachat run, a recent Codex log and an unknown session are refused before the dialog', async () => {
  const processes = [...BASE(), proc(34, 32, 'node /work/build.js')]
  const context = await rig({ processes, sessions: { 32: { agent: 'claude', sessionId: IDS.one }, 33: { agent: 'claude', sessionId: IDS.two, status: 'working' } } })
  await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'Has a tool' })
  await context.add('claude', IDS.two, { text: claudeLog(IDS.two), title: 'Works' })
  await context.add('claude', IDS.three, { text: claudeLog(IDS.three), title: 'Has a run' })
  await context.add('codex', IDS.codex, { text: '', title: 'Fresh', age: 60000 })
  context.state.runs.push({ id: 'run', agent: 'claude', providerSessionId: IDS.three, status: 'running' })
  const result = await context.archive.call({ action: 'archive', sessions: [item('claude', IDS.one), item('claude', IDS.two), item('claude', IDS.three), item('codex', IDS.codex), item('pi', IDS.pi)] })
  assert.equal(result.outcome, 'none')
  assert.deepEqual(result.refused.map(row => row.reason), [message('archive.refused.tool', 32), message('archive.refused.busy', 'working'), message('archive.refused.run'),
    message('archive.refused.codex'), message('archive.refused.unknown', 'pi', IDS.pi)])
  assert.deepEqual(context.views, [])
  // A batch with one idle session shows a dialog with one line only.
  await context.add('claude', IDS.ide, { text: claudeLog(IDS.ide), title: 'Idle' })
  const { request, result: mixed } = await answered(context, { action: 'archive', sessions: [item('claude', IDS.two), item('claude', IDS.ide)] })
  assert.equal(request.rows.length, 1)
  assert.deepEqual(mixed.refused.map(row => row.sessionId), [IDS.two])
})

test('a shared checkout gives both warnings, and a recent log gives a third, and none of them refuses', async () => {
  const context = await rig({ sessions: { 32: { agent: 'claude', sessionId: IDS.one }, 33: { agent: 'claude', sessionId: IDS.two } },
    git: async args => args[0] === 'status' ? ' M a\n M b\n M c\n' : args[0] === 'rev-list' ? '0\n' : 'main\n' })
  await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'One', age: 30 * 60000 })
  const { request } = await answered(context, { action: 'archive', sessions: [item('claude', IDS.one)] })
  assert.deepEqual(request.rows[0].warnings, [message('archive.warning.uncommitted', 3), message('archive.warning.shared'), message('archive.warning.recent', 30)])
  const [card] = await context.archive.cards.all()
  assert.deepEqual(card.warnings, request.rows[0].warnings)
})

test('a pi session gets a session_info line with the prefix, a new ID and the last entry as parent', async () => {
  const context = await rig()
  const log = [line({ type: 'session', version: 3, id: IDS.pi, timestamp: '2026-11-10T10:00:00.000Z', cwd: '/work/json' }),
    line({ type: 'message', id: 'aaaa1111', parentId: null, timestamp: '2026-11-10T10:00:01.000Z', message: { role: 'user', content: 'Hello' } }),
    line({ type: 'session_info', id: 'bbbb2222', parentId: 'aaaa1111', timestamp: '2026-11-10T10:00:02.000Z', name: 'Pi task' })].join('')
  const file = await context.add('pi', IDS.pi, { text: log, title: 'Pi task' })
  const { result } = await answered(context, { action: 'archive', sessions: [item('pi', IDS.pi)] })
  assert.equal(result.archived[0].hidden, 'title')
  const last = JSON.parse((await ends(file)).at(-1))
  assert.deepEqual([last.type, last.name, last.parentId, last.timestamp, /^[0-9a-f]{8}$/.test(last.id)], ['session_info', '[archived] Pi task', 'bbbb2222', new Date(NOW).toISOString(), true])
  const restored = await context.archive.call({ action: 'restore', sessions: [item('pi', IDS.pi)] })
  assert.equal(restored.restored.length, 1)
  assert.equal(JSON.parse((await ends(file)).at(-1)).name, 'Pi task')
})

test('a Codex session runs codex archive, and restore runs codex unarchive for a log in the archive folder', async () => {
  const context = await rig()
  await context.add('codex', IDS.codex, { text: '', title: 'Codex task', age: 3600000 * 5 })
  const { result } = await answered(context, { action: 'archive', sessions: [item('codex', IDS.codex)] })
  assert.deepEqual([result.archived[0].hidden, context.commands], ['codex', [['archive', IDS.codex]]])
  const none = await context.archive.call({ action: 'restore', sessions: [item('codex', IDS.codex)] })
  assert.deepEqual(none.refused.map(row => row.reason), [message('archive.skipped.notArchived')])
  const folder = join(context.home, '.codex', 'archived_sessions')
  await mkdir(folder, { recursive: true })
  await writeFile(join(folder, `rollout-2026-11-10T10-00-00-${IDS.codex}.jsonl`), '')
  context.records.delete(`codex:${IDS.codex}`)
  const restored = await context.archive.call({ action: 'restore', sessions: [item('codex', IDS.codex)] })
  assert.deepEqual([restored.restored[0].resume, context.commands.at(-1)], [`codex resume ${IDS.codex}`, ['unarchive', IDS.codex]])
  const again = await context.archive.call({ action: 'archive', sessions: [item('codex', IDS.codex)] })
  assert.equal(again.outcome, 'none')
})

test('search finds a card by its ticket only, and list pages the cards newest first', async () => {
  const context = await rig()
  await context.add('claude', IDS.one, { text: claudeLog(IDS.one, { prompt: 'Look at ORDER-389' }), title: 'Order work' })
  await context.add('claude', IDS.two, { text: claudeLog(IDS.two, { prompt: 'Look at IJAI-1' }), title: 'Other work' })
  await answered(context, { action: 'archive', sessions: [item('claude', IDS.one), item('claude', IDS.two)] })
  const found = await context.archive.call({ action: 'search', query: 'ORDER-389' })
  assert.deepEqual(found.cards.map(card => card.sessionId), [IDS.one])
  const page = await context.archive.cards.page({ limit: 1 })
  assert.equal(page.cards.length, 1)
  assert.equal(page.nextCursor, '1')
  assert.equal((await context.archive.call({ action: 'list', cursor: page.nextCursor })).cards.length, 1)
  await assert.rejects(context.archive.call({ action: 'search' }), { code: 'invalid' })
})

test('the arguments are checked, the consent is needed, and a batch has at most 50 sessions', async () => {
  const context = await rig()
  await assert.rejects(context.archive.call({ action: 'archive', sessions: [] }), { code: 'invalid' })
  await assert.rejects(context.archive.call({ action: 'archive', sessions: Array.from({ length: 51 }, (_, index) => item('claude', `s${index}`)) }), { code: 'invalid' })
  await assert.rejects(context.archive.call({ action: 'archive', sessions: [item('claude', '../x')] }), { code: 'invalid' })
  await assert.rejects(context.archive.call({ action: 'delete' }), { code: 'invalid' })
  const off = new SessionArchive({ ...context.archive, catalog: () => undefined, directory: context.directory })
  await assert.rejects(off.call({ action: 'archive', sessions: [item('claude', IDS.one)] }), { code: 'archiveConsent' })
})

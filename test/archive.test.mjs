import assert from 'node:assert/strict'
import { appendFile, mkdir, mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { zstdCompressSync } from 'node:zlib'
import { stopPermission } from '../src/AcpBridge.mjs'
import { AgentStop } from '../src/AgentStop.mjs'
import { ClaudeSessionSource } from '../src/ClaudeSessionSource.mjs'
import { JunieSessionSource } from '../src/JunieSessionSource.mjs'
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
async function rig({ processes = BASE(), sessions = {}, git = async () => '', codex, airCaches } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'megachat-archive-'))
  const directory = join(home, 'state')
  await mkdir(directory)
  const claude = new ClaudeSessionSource({ home, environment: {} })
  const pi = new PiSessionSource({ home, environment: {} })
  const sources = { claude, pi, codex: new CodexSessionSource({ home, environment: {} }), junie: new JunieSessionSource({ home }) }
  const records = new Map()
  const context = { home, directory, signals: [], stubborn: new Set(), commands: [], table: undefined, turn: undefined }
  const add = async (agent, id, { text, cwd = '/work/json', title, step = 'end', age = 48 * 3600000, path } = {}) => {
    const file = path ?? (agent === 'pi' ? join(home, '.pi', 'agent', 'sessions', '--work-json--', `2026-11-10T10-00-00-000Z_${id}.jsonl`)
      : agent === 'junie' ? join(home, '.junie', 'sessions', id, 'events.jsonl') : claude.pathOf(cwd, id))
    await mkdir(join(file, '..'), { recursive: true })
    await writeFile(file, text)
    // The folder of a Junie session holds the project directory and the task name next to the event log.
    if (agent === 'junie') await writeFile(join(file, '..', 'summary.json'), JSON.stringify({ sessionId: id, createdAt: START, updatedAt: START + 60000, projectDir: cwd, taskName: title }))
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
    clock, airCaches: airCaches === null ? undefined : join(home, 'caches'), sleep: async () => { context.slept = (context.slept ?? 0) + 1; clock.now = () => NOW + 11000 * context.slept }, git,
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

test('a Codex session with a compressed log only, which the live table lacks, runs codex archive', async () => {
  const context = await rig()
  const folder = join(context.home, '.codex', 'sessions', '2026', '10', '17')
  await mkdir(folder, { recursive: true })
  const file = join(folder, `rollout-2026-10-17T17-00-32-${IDS.codex}.jsonl.zst`)
  await writeFile(file, zstdCompressSync(JSON.stringify({ type: 'session_meta', payload: { id: IDS.codex, cwd: '/work/json' } }) + '\n'))
  await utimes(file, (NOW - 3600000 * 5) / 1000, (NOW - 3600000 * 5) / 1000)
  const other = join(folder, 'rollout-2026-10-17T17-00-33-77777777-7777-4777-8777-777777777777.jsonl.zst')
  await writeFile(other, zstdCompressSync(JSON.stringify({ type: 'session_meta', payload: { id: '77777777-7777-4777-8777-777777777777', cwd: '/work/json' } }) + '\n'))
  const { result } = await answered(context, { action: 'archive', sessions: [item('codex', IDS.codex)] })
  assert.deepEqual([result.archived[0].hidden, context.commands], ['codex', [['archive', IDS.codex]]])
  const unknown = await context.archive.call({ action: 'archive', sessions: [item('codex', '88888888-8888-4888-8888-888888888888')] })
  assert.deepEqual(unknown.refused.map(row => row.reason), [message('archive.refused.unknown', 'codex', '88888888-8888-4888-8888-888888888888')])
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

// The Air fixtures: `<caches>/<IDE>/acp/projects/<hash>/store.json` and `threads/<id>/summary.json` and `events.jsonl`.
async function airThread(context, { hash = 'aaaa1111', project = '/work/json', sessionId, summary = {}, events, ide = 'IntelliJIdea2027.1' }) {
  const root = join(context.home, 'caches', ide, 'acp', 'projects', hash)
  const directory = join(root, 'threads', `local%3A${hash}-${sessionId.slice(0, 4)}`)
  await mkdir(directory, { recursive: true })
  await writeFile(join(root, 'store.json'), JSON.stringify({ schemaVersion: 1, projectDirectory: project }))
  await writeFile(join(directory, 'summary.json'), JSON.stringify({ schemaVersion: 12, threadId: 'local:x', association: { namespaceId: 'claude', agentSessionId: sessionId }, ...summary }))
  if (events) await writeFile(join(directory, 'events.jsonl'), events.map((type, index) => line({ id: `x#${index}`, threadId: 'local:x', seq: index, timestamp: 1, source: 'Ide', type, payload: type === 'ThreadArchiveStateChanged' ? { archived: true } : {}, version: 1 })).join(''))
  return directory
}
const archiveOne = async (context, id) => (await answered(context, { action: 'archive', sessions: [item('claude', id)] })).result.archived[0]
const snapshot = async directory => (await Promise.all(['summary.json', 'events.jsonl'].map(name => readFile(join(directory, name), 'utf8').catch(() => null)))).join('|')

test('the result names a session by its title and short ID, with the full ID and the command', async () => {
  const context = await rig()
  await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'Fix the build' })
  await context.add('claude', IDS.two, { text: claudeLog(IDS.two), title: 'Fix the build' })
  const { result } = await answered(context, { action: 'archive', sessions: [item('claude', IDS.one), item('claude', IDS.two), item('claude', 'nope')] })
  assert.deepEqual(result.archived.map(row => row.label), ['Fix the build (11111111)', 'Fix the build (22222222)'])
  assert.equal(result.archived[0].sessionId, IDS.one)
  assert.equal(result.archived[0].resume, `claude --resume ${IDS.one}`)
  assert.equal(result.refused[0].label, 'Session nope (nope)')
  assert.equal(result.refused[0].resume, 'claude --resume nope')
  const listed = await context.archive.call({ action: 'list' })
  assert.deepEqual(listed.cards.map(card => card.label).sort(), ['Fix the build (11111111)', 'Fix the build (22222222)'])
  assert.equal(listed.cards[0].resume.command.startsWith('claude --resume '), true)
  assert.match(message('tool.archive'), /label/)
})

test('a session without a thread of Air says no Air thread, and a store of another project is not matched', async () => {
  const context = await rig()
  await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'Old' })
  await airThread(context, { hash: 'bbbb2222', project: '/work/other', sessionId: IDS.one, summary: { archived: false } })
  const row = await archiveOne(context, IDS.one)
  assert.equal(row.hidden, 'title')
  assert.equal(row.air, 'no Air thread')
  assert.match(row.airHint, /Refresh/)
})

test('a thread of Air gives hidden or still shown from its summary, its events, then the log, and Megachat never writes the store', async () => {
  const context = await rig()
  const cases = [
    [IDS.one, { summary: { archived: true } }, 'hidden'],
    [IDS.two, { summary: { archived: false } }, 'still shown'],
    [IDS.three, { events: ['ThreadCreated', 'ThreadArchived', 'ThreadUnarchived'] }, 'still shown'],
    [IDS.ide, { events: ['ThreadCreated', 'ThreadArchiveStateChanged'] }, 'hidden'],
    [IDS.pi, {}, 'hidden'],
  ]
  const directories = []
  for (const [id, air, expected] of cases) {
    await context.add('claude', id, { text: claudeLog(id), title: `T ${id.slice(0, 2)}` })
    directories.push([await airThread(context, { sessionId: id, ...air }), expected])
  }
  const before = await Promise.all(directories.map(([directory]) => snapshot(directory)))
  const rows = []
  for (const [id] of cases) rows.push(await archiveOne(context, id))
  assert.deepEqual(rows.map(row => row.air), cases.map(([, , expected]) => expected))
  assert.match(rows[1].airHint, /press Done in Air/)
  assert.match(rows[4].airHint, /Refresh/)
  assert.equal(context.slept, 2, 'a session that is still shown gets one short second check')
  assert.deepEqual(await Promise.all(directories.map(([directory]) => snapshot(directory))), before)
  const listed = await context.archive.call({ action: 'list' })
  assert.deepEqual(listed.cards.map(card => [card.sessionId, card.air]).sort(), cases.map(([id, , expected]) => [id, expected]).sort())
})

test('the state of Air is unknown without a store of Air', async () => {
  const context = await rig({ airCaches: null })
  await context.add('claude', IDS.one, { text: claudeLog(IDS.one), title: 'Old' })
  const row = await archiveOne(context, IDS.one)
  assert.equal(row.air, 'unknown')
})

const JUNIE_ID = 'session-260101-120000-abcd'
const junieLine = (value, index) => line({ ...value, timestampMs: START + index * 1000 })
const junieBlock = (state, kind, fields) => ({ kind: 'SessionA2uxEvent', event: { state, agentEvent: { kind, ...fields } } })
/** The event log of a Junie session with one turn: a prompt, a command with a commit, and the result. */
const junieLog = ({ prompt = 'Fix the parser for DEMO-7', waits = false } = {}) => [
  { kind: 'UserPromptEvent', requestId: 'request-1', prompt, presentablePrompt: prompt },
  junieBlock('IN_PROGRESS', 'TerminalBlockUpdatedEvent', { stepId: 'step-1', status: 'COMPLETED', command: 'git commit -m x', output: '[main 1a2b3c4] Fix the parser\n 1 file changed' }),
  ...(waits ? [junieBlock('INPUT_REQUIRED', 'TerminalBlockUpdatedEvent', { stepId: 'step-2', status: 'IN_PROGRESS', command: 'git push', approvalRequest: { id: 'approval-1' } })]
    : [junieBlock('COMPLETED', 'ResultBlockUpdatedEvent', { stepId: 'step-3', title: 'The parser', result: 'The parser works.' }), { kind: 'TaskState', state: 'COMPLETED' }]),
].map(junieLine).join('')
const junieArchiveFile = context => join(context.home, '.junie', 'sessions', 'agent-workbench-archive-state.jsonl')
const JUNIE_BINARY = '/Users/user/.local/share/junie/versions/3579.7/Applications/junie.app/Contents/MacOS/junie'

test('the archive of a Junie session saves a card with the command of Junie, adds one line to the archive state file of Air and sets archived in the metadata of Junie', async () => {
  const context = await rig({ airCaches: null })
  const file = await context.add('junie', JUNIE_ID, { text: junieLog(), cwd: '/work/demo-app', title: 'Fix the parser' })
  const metadata = join(file, '..', 'session_metadata.json')
  // The file of Air holds one line of another session.
  const other = '{"sessionId":"session-251201-090000-wxyz","updatedAt":1790000000000,"projectDir":"/work/other","archived":true}'
  await writeFile(junieArchiveFile(context), `${other}\n`)
  const before = await Promise.all([file, join(file, '..', 'summary.json')].map(async path => { const { size, mtimeMs } = await stat(path); return [size, mtimeMs] }))
  const { result, request } = await answered(context, { action: 'archive', sessions: [item('junie', JUNIE_ID)] })
  assert.deepEqual([request.rows.length, request.rows[0].agent, request.rows[0].action], [1, 'junie', 'hide'])
  assert.match(stopPermission(request).toolCall.rawInput.command, /^Junie, project demo-app/)
  // The line of a hide: the format of Air, with the time of the archive, and the line of the other session stays.
  assert.deepEqual(await ends(junieArchiveFile(context)), [other,
    `{"sessionId":"session-260101-120000-abcd","updatedAt":${NOW},"projectDir":"/work/demo-app","archived":true}`])
  assert.deepEqual([result.outcome, result.archived[0].hidden, result.archived[0].resume], ['archived', 'junie', 'junie --resume --session-id=session-260101-120000-abcd'])
  // The metadata of Junie: the folder had no `session_metadata.json`, so the new file holds only `archived`.
  assert.equal(await readFile(metadata, 'utf8'), '{"archived":true}')
  assert.equal((await stat(metadata)).mode & 0o777, 0o600)
  // The line of a hide at the time 1795000000000. A later `updatedAt` of the session wins over the time of the archive, as in Air.
  const source = new JunieSessionSource({ home: context.home })
  assert.equal(source.archiveLine({ sessionId: JUNIE_ID, cwd: '/work/demo-app/', archived: true, now: 1795000000000, updatedAt: 1794000000000 }),
    '{"sessionId":"session-260101-120000-abcd","updatedAt":1795000000000,"projectDir":"/work/demo-app","archived":true}\n')
  assert.equal(JSON.parse(source.archiveLine({ sessionId: JUNIE_ID, cwd: '/work/demo-app', archived: false, now: 1795000000000, updatedAt: 1795000009999 })).updatedAt, 1795000009999)
  // The card of a Junie session.
  const [card] = await context.archive.cards.all()
  assert.deepEqual([card.agent, card.sessionId, card.title, card.cwd, card.hidden], ['junie', JUNIE_ID, 'Fix the parser', '/work/demo-app', 'junie'])
  assert.deepEqual([card.resume.command, card.resume.arguments], ['junie --resume --session-id=session-260101-120000-abcd',
    { agent: 'junie', sessionId: JUNIE_ID, cwd: '/work/demo-app' }])
  assert.deepEqual([card.firstPrompt, card.lastReply, card.tickets, card.commits], ['Fix the parser for DEMO-7', 'The parser\nThe parser works.', ['DEMO-7'], ['1a2b3c4']])
  // No other file of Junie changed, and no process got a signal.
  const after = await Promise.all([file, join(file, '..', 'summary.json')].map(async path => { const { size, mtimeMs } = await stat(path); return [size, mtimeMs] }))
  assert.deepEqual(after, before)
  assert.deepEqual(await fs.readdir(join(context.home, '.junie', 'sessions')), ['agent-workbench-archive-state.jsonl', JUNIE_ID])
  assert.deepEqual((await fs.readdir(join(file, '..'))).sort(), ['events.jsonl', 'session_metadata.json', 'summary.json'])
  assert.deepEqual(context.signals, [])
  // Archive twice: both stores tell `archived` true, so no file changes.
  const sizes = async () => Promise.all([junieArchiveFile(context), metadata].map(async path => { const { size, mtimeMs } = await stat(path); return [size, mtimeMs] }))
  const size = await sizes()
  const again = await context.archive.call({ action: 'archive', sessions: [item('junie', JUNIE_ID)] })
  assert.deepEqual([again.outcome, again.skipped.map(row => row.reason)], ['none', [message('archive.skipped.already')]])
  assert.equal(message('archive.skipped.already'), 'The session is archived already, in Megachat or in Air. Nothing changed.')
  assert.deepEqual(await sizes(), size)
  // Restore of a Junie session: one more line with `archived` false, `archived` false in the metadata, the card gets its
  // time, and no process starts.
  const processes = context.table.current.length
  const restored = await context.archive.call({ action: 'restore', sessions: [item('junie', JUNIE_ID)] })
  assert.deepEqual([restored.outcome, restored.restored.length, restored.restored[0].resume], ['restored', 1, 'junie --resume --session-id=session-260101-120000-abcd'])
  assert.equal((await ends(junieArchiveFile(context))).at(-1), `{"sessionId":"session-260101-120000-abcd","updatedAt":${NOW},"projectDir":"/work/demo-app","archived":false}`)
  assert.equal((await ends(junieArchiveFile(context))).length, 3)
  assert.equal(await readFile(metadata, 'utf8'), '{"archived":false}')
  assert.equal((await context.archive.cards.all())[0].restoredAt, restored.restored[0].restoredAt)
  assert.equal(context.table.current.length, processes)
  // A session that is not archived is refused by a restore, and no file changes.
  const restoredSizes = await sizes()
  const second = await context.archive.call({ action: 'restore', sessions: [item('junie', JUNIE_ID)] })
  assert.deepEqual(second.refused.map(row => row.reason), [message('archive.skipped.notArchived')])
  assert.deepEqual(await sizes(), restoredSizes)
})

test('the archive of a Junie session writes only the store that does not tell the state, keeps the other fields of the metadata, and keeps a metadata file that it cannot read', async () => {
  const context = await rig({ airCaches: null })
  // "Done" of Air through Junie: `session_metadata.json` has `archived` true and a title, and the file of Air has no line.
  const file = await context.add('junie', JUNIE_ID, { text: junieLog(), cwd: '/work/demo-app', title: 'Fix the parser' })
  const metadata = join(file, '..', 'session_metadata.json')
  await writeFile(metadata, '{"archived":true,"explicitTitle":"The parser","forkedFrom":"session-251231-100000-root"}')
  const first = await stat(metadata)
  const { result } = await answered(context, { action: 'archive', sessions: [item('junie', JUNIE_ID)] })
  assert.equal(result.archived[0].hidden, 'junie')
  assert.deepEqual(await ends(junieArchiveFile(context)), [`{"sessionId":"session-260101-120000-abcd","updatedAt":${NOW},"projectDir":"/work/demo-app","archived":true}`])
  assert.deepEqual([(await stat(metadata)).mtimeMs, (await stat(metadata)).size], [first.mtimeMs, first.size])
  // A restore sets `archived` false and keeps the other fields.
  await context.archive.call({ action: 'restore', sessions: [item('junie', JUNIE_ID)] })
  assert.deepEqual(JSON.parse(await readFile(metadata, 'utf8')), { archived: false, explicitTitle: 'The parser', forkedFrom: 'session-251231-100000-root' })
  // "Done" of Air from `index.jsonl`: the file of Air has `archived` true, and the folder has no metadata file. The
  // archive writes only the metadata, and the file of Air keeps its size.
  const done = await context.add('junie', 'session-260101-140000-done', { text: junieLog(), cwd: '/work/demo-app', title: 'Done in Air' })
  await appendFile(junieArchiveFile(context), '{"sessionId":"session-260101-140000-done","updatedAt":2,"projectDir":"/work/demo-app","archived":true}\n')
  const size = (await stat(junieArchiveFile(context))).size
  const { result: second } = await answered(context, { action: 'archive', sessions: [item('junie', 'session-260101-140000-done')] })
  assert.equal(second.archived[0].hidden, 'junie')
  assert.equal((await stat(junieArchiveFile(context))).size, size)
  assert.equal(await readFile(join(done, '..', 'session_metadata.json'), 'utf8'), '{"archived":true}')
  // A metadata file that is not a JSON object stays as it is, and the result names the error.
  const broken = await context.add('junie', 'session-260101-160000-bad0', { text: junieLog(), cwd: '/work/demo-app', title: 'A broken file' })
  await writeFile(join(broken, '..', 'session_metadata.json'), '[true]')
  const { result: third } = await answered(context, { action: 'archive', sessions: [item('junie', 'session-260101-160000-bad0')] })
  assert.deepEqual([third.archived[0].step, third.archived[0].error], ['error', message('archive.error.step', 'junieMetadata')])
  assert.equal(await readFile(join(broken, '..', 'session_metadata.json'), 'utf8'), '[true]')
  assert.deepEqual((await fs.readdir(join(broken, '..'))).sort(), ['events.jsonl', 'session_metadata.json', 'summary.json'])
})

test('a Junie session that waits for a permission, or with a run of Megachat, is refused, and a session that Air archived counts as archived', async () => {
  const processes = [...BASE(), proc(40, 31, JUNIE_BINARY, { name: 'junie' })]
  const context = await rig({ processes, sessions: { 40: { agent: 'junie', sessionId: JUNIE_ID, status: 'waiting_for_permission', cwd: '/work/demo-app' } }, airCaches: null })
  // A process of the session lives, and its log ends with an approval request.
  const file = await context.add('junie', JUNIE_ID, { text: junieLog({ waits: true }), cwd: '/work/demo-app', title: 'Fix the parser', step: 'permission' })
  const run = await context.add('junie', 'session-260101-130000-run0', { text: junieLog(), cwd: '/work/demo-app', title: 'A task of Megachat' })
  context.state.runs.push({ id: 'run', agent: 'junie', providerSessionId: 'session-260101-130000-run0', status: 'running' })
  const sizes = async () => Promise.all([file, run].map(async path => (await stat(path)).size))
  const before = await sizes()
  const result = await context.archive.call({ action: 'archive', sessions: [item('junie', JUNIE_ID), item('junie', 'session-260101-130000-run0'), item('junie', 'session-260101-999999-none')] })
  assert.equal(result.outcome, 'none')
  assert.deepEqual(result.refused.map(row => row.reason), [message('archive.refused.busy', 'waiting_for_permission'), message('archive.refused.run'),
    message('archive.refused.unknown', 'junie', 'session-260101-999999-none')])
  // No file changed: the logs keep their size, and Megachat made no archive state file.
  assert.deepEqual(await sizes(), before)
  await assert.rejects(stat(junieArchiveFile(context)), { code: 'ENOENT' })
  assert.deepEqual(context.views, [])
  // "Done" of Air added a line for another session of the directory, and Junie has `archived` true in its metadata: it
  // counts as archived. A line of another directory does not change the state.
  const done = await context.add('junie', 'session-260101-140000-done', { text: junieLog(), cwd: '/work/demo-app', title: 'Done in Air' })
  await writeFile(join(done, '..', 'session_metadata.json'), '{"archived":true}')
  await writeFile(junieArchiveFile(context), ['{"sessionId":"session-260101-140000-done","updatedAt":1,"projectDir":"/work/demo-app","archived":false}',
    '{"sessionId":"session-260101-140000-done","updatedAt":2,"projectDir":"/work/demo-app/","archived":true}',
    '{"sessionId":"session-260101-140000-done","updatedAt":3,"projectDir":"/work/elsewhere","archived":false}', 'not a JSON line', ''].join('\n'))
  const size = (await stat(junieArchiveFile(context))).size
  const again = await context.archive.call({ action: 'archive', sessions: [item('junie', 'session-260101-140000-done')] })
  assert.deepEqual(again.skipped.map(row => row.reason), [message('archive.skipped.already')])
  assert.equal((await stat(junieArchiveFile(context))).size, size)
  // A session with a live process is not restored either.
  context.sessions[40] = { agent: 'junie', sessionId: 'session-260101-140000-done', status: 'idle', cwd: '/work/demo-app' }
  const restored = await context.archive.call({ action: 'restore', sessions: [item('junie', 'session-260101-140000-done')] })
  assert.deepEqual(restored.refused.map(row => row.reason), [message('archive.refused.live')])
  assert.equal((await stat(junieArchiveFile(context))).size, size)
  void done
})

test('an idle Junie session in a terminal gets SIGTERM and then its line, and a session without a project directory keeps its card and writes no line', async () => {
  const processes = [...BASE(), proc(40, 31, JUNIE_BINARY, { name: 'junie' })]
  const context = await rig({ processes, sessions: { 40: { agent: 'junie', sessionId: JUNIE_ID, status: 'waiting_for_user', cwd: '/work/demo-app' } }, airCaches: null })
  await context.add('junie', JUNIE_ID, { text: junieLog(), cwd: '/work/demo-app', title: 'Fix the parser' })
  const { result, request } = await answered(context, { action: 'archive', sessions: [item('junie', JUNIE_ID)] })
  assert.deepEqual([request.rows[0].action, request.rows[0].owner], ['stop', 'terminal'])
  assert.deepEqual(context.signals, [[40, 'SIGTERM']])
  assert.equal(result.archived[0].hidden, 'junie')
  assert.equal((await ends(junieArchiveFile(context))).length, 1)
  // A session whose folder names no project directory: Air does not list it, and Megachat writes no line for it.
  const lost = await context.add('junie', 'session-260101-150000-lost', { text: junieLog(), cwd: undefined, title: 'A lost task' })
  await fs.rm(join(lost, '..', 'summary.json'))
  context.records.get('junie:session-260101-150000-lost').cwd = undefined
  const { result: second } = await answered(context, { action: 'archive', sessions: [item('junie', 'session-260101-150000-lost')] })
  assert.deepEqual([second.archived[0].step, second.archived[0].error], ['error', message('archive.error.step', 'archiveNoDirectory')])
  assert.equal((await ends(junieArchiveFile(context))).length, 1)
  assert.equal((await context.archive.cards.all()).find(card => card.sessionId === 'session-260101-150000-lost').hidden, 'pending')
})

import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, utimes, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { RunningAgents, SNAPSHOT_TTL_MS } from '../src/RunningAgents.mjs'
import { SessionCatalog, TAIL_BYTES } from '../src/SessionCatalog.mjs'
import { SessionHistoryService } from '../src/SessionHistoryService.mjs'
import { SessionIndex } from '../src/SessionIndex.mjs'
import { SMALL_FILE_FLAGS } from '../src/SessionLog.mjs'
import { newestPage, PAGE_SCAN_BYTES } from '../src/SessionTail.mjs'
import { sessionSources } from '../src/SessionSources.mjs'
import { IDLE_MS, sessionStatus, STUCK_MS } from '../src/SessionStatus.mjs'

const MINUTE = 60000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-11-11T12:00:00Z')
// Each message text of a fixture holds this marker, so a test can prove that no message text reaches agents_running.
const MARKER = 'textmarker'
const iso = time => new Date(time).toISOString()
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** The start time in the form of `ps -o lstart` in UTC, as the process file of Claude Code has it. */
const lstart = time => {
  const date = new Date(time)
  const two = value => String(value).padStart(2, '0')
  return `${DAYS[date.getUTCDay()]} ${MONTHS[date.getUTCMonth()]} ${String(date.getUTCDate()).padStart(2)} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} ${date.getUTCFullYear()}`
}

async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-session-logs-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  await mkdir(join(directory, 'state'))
  return directory
}

const fakeClock = (time = NOW) => ({ time, now() { return this.time } })
/** Timers that run the size poll only when a test calls `tick`. */
function fakeTimers() {
  const timers = { callback: undefined, setInterval(callback) { timers.callback = callback; return 1 }, clearInterval() { timers.callback = undefined },
    tick() { timers.callback?.() } }
  return timers
}

/** A file system that records each call with its flags and counts the bytes that each read gave. */
function countingFs() {
  const record = { calls: [], bytes: 0 }
  const wrap = name => (...args) => { record.calls.push([name, String(args[0])]); return fsp[name](...args) }
  return Object.assign(record, {
    readdir: wrap('readdir'), stat: wrap('stat'),
    async open(path, flags) {
      record.calls.push(['open', String(path), flags])
      const handle = await fsp.open(path, flags)
      return {
        async read(...args) { const result = await handle.read(...args); record.bytes += result.bytesRead; return result },
        stat: () => handle.stat(), close: () => handle.close(),
      }
    },
  })
}
const opened = fs => [...new Set(fs.calls.filter(([name, path]) => name === 'open' && path.endsWith('.jsonl')).map(([, path]) => path))]

/** The records of a Claude Code log. Each one gets the `cwd`, an entry ID and a time. */
const claude = {
  prompt: (text = `Please fix the build ${MARKER}`) => ({ type: 'user', message: { role: 'user', content: text } }),
  call: (name = 'Bash') => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name, input: { command: `make ${MARKER}` } }] } }),
  result: (text = `ok ${MARKER}`) => ({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: text }] } }),
  step: () => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'tool_use', content: [{ type: 'text', text: `I run the tests ${MARKER}` }] } }),
  reply: (text = `The build works ${MARKER}`) => ({ type: 'assistant', message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text }] } }),
  end: () => ({ type: 'system', subtype: 'turn_duration' }),
  interrupt: () => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] } }),
  command: () => ({ type: 'user', message: { role: 'user', content: '<local-command-stdout>Compacted</local-command-stdout>' } }),
  // A shell line of the bash mode (`!`), its output, and a note of the memory mode (`#`). They start no turn of the model.
  bash: () => ({ type: 'user', message: { role: 'user', content: `<bash-input>ls ${MARKER}</bash-input>` } }),
  bashOutput: () => ({ type: 'user', message: { role: 'user', content: `<bash-stdout>${MARKER}</bash-stdout><bash-stderr></bash-stderr>` } }),
  bashError: () => ({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: `<bash-stderr>${MARKER}</bash-stderr>` }] } }),
  memory: () => ({ type: 'user', message: { role: 'user', content: `<user-memory-input>${MARKER}</user-memory-input>` } }),
  compact: () => ({ type: 'user', isCompactSummary: true, message: { role: 'user', content: `Summary ${MARKER}` } }),
  side: () => ({ type: 'assistant', isSidechain: true, message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: 'side' }] } }),
  title: (title = 'Fix the build') => ({ type: 'ai-title', aiTitle: title }),
}
const codex = {
  started: () => ({ type: 'event_msg', payload: { type: 'task_started' } }),
  prompt: () => ({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: `Add a test ${MARKER}` }] } }),
  commentary: () => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'commentary', content: [{ type: 'output_text', text: `I look ${MARKER}` }] } }),
  reasoning: () => ({ type: 'response_item', payload: { type: 'reasoning', summary: [] } }),
  call: () => ({ type: 'response_item', payload: { type: 'function_call', call_id: 'c1', name: 'shell', arguments: `{"cmd":"ls ${MARKER}"}` } }),
  tool: () => ({ type: 'response_item', payload: { type: 'custom_tool_call', call_id: 'c2', name: 'apply_patch', input: MARKER } }),
  result: () => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: MARKER } }),
  reply: () => ({ type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: `Done ${MARKER}` }] } }),
  complete: () => ({ type: 'event_msg', payload: { type: 'task_complete' } }),
  aborted: () => ({ type: 'event_msg', payload: { type: 'turn_aborted' } }),
  title: (name = 'Add a test') => ({ type: 'event_msg', payload: { type: 'thread_name_updated', thread_name: name } }),
}
const pi = {
  prompt: () => ({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: `Read the notes ${MARKER}` }] } }),
  call: () => ({ type: 'message', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'toolCall', id: 'k', name: 'read', arguments: { path: MARKER } }] } }),
  result: () => ({ type: 'message', message: { role: 'toolResult', toolCallId: 'k', content: [{ type: 'text', text: MARKER }] } }),
  reply: (stopReason = 'stop') => ({ type: 'message', message: { role: 'assistant', stopReason, content: [{ type: 'text', text: `Notes read ${MARKER}` }] } }),
  title: (name = 'Read the notes') => ({ type: 'session_info', name }),
}

let counter = 0
/** Writes the lines of a log. Each line gets a time after [start], one second apart. */
async function writeLog(path, records, { mtime, start = NOW - HOUR } = {}) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, records.map((value, index) => `${JSON.stringify({ timestamp: iso(start + index * 1000), ...value })}\n`).join(''))
  if (mtime !== undefined) await utimes(path, new Date(mtime), new Date(mtime))
  return path
}

function claudeLog(home, cwd, id, records, options) {
  const lines = records.map(value => ({ uuid: `${id}-${counter++}`, cwd, sessionId: id, ...value }))
  return writeLog(join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${id}.jsonl`), lines, options)
}
function codexLog(home, cwd, id, records, options = {}) {
  const start = options.start ?? NOW - HOUR
  const meta = { type: 'session_meta', payload: { id, cwd, timestamp: iso(start), base_instructions: { text: 'x'.repeat(300) } } }
  return writeLog(join(home, '.codex', 'sessions', '2026', '11', '11', `rollout-2026-11-11T11-00-00-${id}.jsonl`), [meta, ...records], options)
}
function piLog(home, cwd, id, records, options = {}) {
  const start = options.start ?? NOW - HOUR
  const lines = [{ type: 'session', version: 3, id, cwd, timestamp: iso(start) }, ...records.map((value, index) => ({ id: `e${index}`, parentId: null, ...value }))]
  return writeLog(join(home, '.pi', 'agent', 'sessions', `--${cwd.slice(1).replace(/\//g, '-')}--`, `2026-11-11T11-00-00-000Z_${id}.jsonl`), lines, options)
}

/** A live table of the session files of [home] on its own `sessions.sqlite`. */
async function catalogOf(t, home, { fs = fsp, clock = fakeClock(), timers = fakeTimers(), start = true, sources = sessionSources({ home, environment: {} }) } = {}) {
  const index = await SessionIndex.open(join(home, 'state', 'sessions.sqlite'))
  const catalog = new SessionCatalog({ index, sources, fs, clock, timers })
  let closed = false
  catalog.shut = async () => { if (closed) return; closed = true; await catalog.close(); await index.close() }
  t.after(() => catalog.shut())
  if (start) {
    await catalog.start()
    await catalog.idle()
  }
  return { catalog, index, timers, clock }
}

const proc = (pid, ppid, command, { cpu = 0, startedAt = NOW - 2 * HOUR + pid * 1000, name = command.split(' ', 1)[0].split('/').pop().slice(0, 16) } = {}) =>
  ({ pid, ppid, startedAt, cpu, name, command: `${command} --token secret-argument` })
/** A fake process table: a terminal owns each process with the parent PID 2. */
function fakeTable(processes, resolved = {}) {
  const table = {
    platform: 'darwin', supported: true, calls: { resolve: [] },
    async processes() { return [proc(1, 0, '/sbin/launchd'), proc(2, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2', { name: 'iTerm2' }), ...processes] },
    async resolve(pids) {
      table.calls.resolve.push(pids)
      return new Map(pids.map(pid => [pid, { cwd: resolved[pid]?.cwd ?? null, files: resolved[pid]?.files ?? [] }]))
    },
  }
  return table
}
const fakeState = () => ({ snapshot: async () => ({ runs: {} }) })
const running = (catalog, table, clock = fakeClock()) => new RunningAgents(fakeState(), { table, clock, daemonPid: 900, logs: () => catalog })
const byPid = answer => Object.fromEntries(answer.sessions.map(row => [`${row.pid}${row.sessionId ? `:${row.sessionId}` : ''}`, row]))

test('the status of each agent comes from the tail of its log, and the log alone gives no waiting_for_permission', async t => {
  const home = await temporary(t)
  const cases = [
    [claudeLog, 'c-call', [claude.prompt(), claude.call()], MINUTE, 'working'],
    [claudeLog, 'c-prompt', [claude.prompt(), claude.reply(), claude.end(), claude.prompt()], MINUTE / 2, 'working'],
    [claudeLog, 'c-result', [claude.prompt(), claude.call(), claude.result()], MINUTE, 'working'],
    [claudeLog, 'c-step', [claude.prompt(), claude.step()], MINUTE, 'working'],
    [claudeLog, 'c-side', [claude.prompt(), claude.call('Task'), claude.side()], MINUTE, 'working'],
    [claudeLog, 'c-quiet', [claude.prompt(), claude.call()], 5 * MINUTE, 'working'],
    [claudeLog, 'c-reply', [claude.prompt(), claude.reply(), claude.end(), claude.title()], 5 * MINUTE, 'waiting_for_user'],
    [claudeLog, 'c-interrupt', [claude.prompt(), claude.call(), claude.interrupt()], MINUTE, 'waiting_for_user'],
    [claudeLog, 'c-compact', [claude.prompt(), claude.reply(), claude.command(), claude.compact()], MINUTE, 'waiting_for_user'],
    [claudeLog, 'c-bash', [claude.prompt(), claude.reply(), claude.end(), claude.bash(), claude.bashOutput()], MINUTE, 'waiting_for_user'],
    [claudeLog, 'c-bash-quiet', [claude.prompt(), claude.reply(), claude.end(), claude.bash(), claude.bashError()], STUCK_MS, 'waiting_for_user'],
    [claudeLog, 'c-memory', [claude.prompt(), claude.reply(), claude.end(), claude.memory()], MINUTE, 'waiting_for_user'],
    [claudeLog, 'c-stuck', [claude.prompt(), claude.call()], STUCK_MS, 'stuck'],
    [claudeLog, 'c-idle', [claude.prompt(), claude.reply(), claude.end()], IDLE_MS, 'idle'],
    [codexLog, 'x-call', [codex.started(), codex.prompt(), codex.reasoning(), codex.call()], MINUTE, 'working'],
    [codexLog, 'x-commentary', [codex.started(), codex.prompt(), codex.commentary()], MINUTE, 'working'],
    [codexLog, 'x-result', [codex.started(), codex.prompt(), codex.call(), codex.result()], MINUTE, 'working'],
    [codexLog, 'x-done', [codex.started(), codex.prompt(), codex.reply(), codex.complete(), codex.title()], MINUTE, 'waiting_for_user'],
    [codexLog, 'x-aborted', [codex.started(), codex.prompt(), codex.tool(), codex.aborted()], MINUTE, 'waiting_for_user'],
    [codexLog, 'x-new', [], MINUTE, 'waiting_for_user'],
    [codexLog, 'x-stuck', [codex.started(), codex.prompt(), codex.tool()], 15 * MINUTE, 'stuck'],
    [codexLog, 'x-idle', [codex.started(), codex.prompt(), codex.reply(), codex.complete()], 40 * MINUTE, 'idle'],
    [piLog, 'p-call', [pi.prompt(), pi.call()], MINUTE, 'working'],
    [piLog, 'p-prompt', [pi.prompt()], MINUTE, 'working'],
    [piLog, 'p-result', [pi.prompt(), pi.call(), pi.result()], MINUTE, 'working'],
    [piLog, 'p-done', [pi.prompt(), pi.call(), pi.result(), pi.reply(), pi.title()], MINUTE, 'waiting_for_user'],
    [piLog, 'p-error', [pi.prompt(), pi.reply('error')], MINUTE, 'waiting_for_user'],
    [piLog, 'p-stuck', [pi.prompt(), pi.call()], 12 * MINUTE, 'stuck'],
    [piLog, 'p-idle', [pi.prompt(), pi.reply()], 45 * MINUTE, 'idle'],
  ]
  const paths = {}
  for (const [write, id, records, age] of cases) paths[id] = await write(home, `/work/${id}`, id, records, { mtime: NOW - age })
  const { catalog } = await catalogOf(t, home)
  for (const [, id, , , expected] of cases) assert.equal(sessionStatus(catalog.get(paths[id]), NOW), expected, id)
  assert.deepEqual([catalog.get(paths['c-reply']).title, catalog.get(paths['x-done']).title, catalog.get(paths['p-done']).title],
    ['Fix the build', 'Add a test', 'Read the notes'])
  assert.deepEqual([catalog.get(paths['x-done']).sessionId, catalog.get(paths['x-done']).cwd, catalog.get(paths['p-call']).sessionId], ['x-done', '/work/x-done', 'p-call'])
  // A tool result of one large line: the tail reads the last line, and the read stays far below the size of the file.
  const fs = countingFs()
  const big = await claudeLog(home, '/work/big', 'c-big', [...Array.from({ length: 2000 }, () => claude.reply('y'.repeat(1000))), claude.prompt(), claude.call(),
    claude.result('z'.repeat(200 * 1024))], { mtime: NOW - MINUTE })
  const { catalog: other } = await catalogOf(t, await temporary(t), { fs, sources: catalog.sources, start: false })
  await other.read(big)
  assert.equal(sessionStatus(other.get(big), NOW), 'working')
  assert.ok(fs.bytes < 512 * 1024 && (await stat(big)).size > 2 * 1024 * 1024, `${fs.bytes} bytes`)
})

test('the live table reads only the appended lines, and reads a file again after a truncation or another inode', async t => {
  const home = await temporary(t)
  const path = await claudeLog(home, '/work/a', 'one', [claude.title('First'), claude.prompt(), claude.call()])
  const fs = countingFs()
  const { catalog } = await catalogOf(t, home, { fs })
  assert.equal(catalog.get(path).step, 'call')
  assert.equal(catalog.get(path).offset, (await stat(path)).size)
  const line = value => `${JSON.stringify({ uuid: `u${counter++}`, cwd: '/work/a', sessionId: 'one', timestamp: iso(NOW), ...value })}\n`
  const appended = line(claude.result()) + line(claude.reply()) + line(claude.title('Second'))
  await appendFile(path, appended)
  // A writer has not completed the last line yet.
  await appendFile(path, line(claude.prompt()).trimEnd())
  let before = fs.bytes
  catalog.changed(path)
  await catalog.idle()
  assert.equal(catalog.get(path).step, 'reply')
  assert.equal(catalog.get(path).title, 'Second')
  assert.equal(fs.bytes - before, Buffer.byteLength(appended) + Buffer.byteLength(line(claude.prompt()).trimEnd()), 'The read took only the appended bytes')
  assert.equal(catalog.get(path).offset, (await stat(path)).size - Buffer.byteLength(line(claude.prompt()).trimEnd()))
  await appendFile(path, '\n')
  catalog.changed(path)
  await catalog.idle()
  assert.equal(catalog.get(path).step, 'prompt')

  // A truncation: the file is shorter than the read part.
  await writeFile(path, line(claude.reply()))
  catalog.changed(path)
  await catalog.idle()
  assert.deepEqual([catalog.get(path).step, catalog.get(path).offset, catalog.get(path).title], ['reply', (await stat(path)).size, undefined])

  // Another inode of the same size: only the inode tells the change.
  const size = (await stat(path)).size
  const fixed = pad => `${JSON.stringify({ uuid: 'fixed', cwd: '/work/a', sessionId: 'one', timestamp: iso(NOW), ...claude.prompt('x'), pad })}\n`
  const replaced = fixed('p'.repeat(size - Buffer.byteLength(fixed(''))))
  await writeFile(`${path}.new`, replaced)
  const old = await stat(path)
  await rename(`${path}.new`, path)
  assert.equal((await stat(path)).size, old.size)
  assert.notEqual((await stat(path)).ino, old.ino)
  catalog.changed(path)
  await catalog.idle()
  assert.equal(catalog.get(path).step, 'prompt')
  before = fs.bytes
  catalog.changed(path)
  await catalog.idle()
  assert.equal(fs.bytes, before, 'An unchanged file is not read')
})

test('the size poll finds a write to an open Codex file every 2 seconds, and polls only the files with a write in the last hour', async t => {
  const home = await temporary(t)
  const path = await codexLog(home, '/work/x', 'open', [codex.started(), codex.prompt(), codex.call()], { mtime: NOW - 10 * MINUTE })
  const old = await codexLog(home, '/work/y', 'old', [codex.started(), codex.prompt(), codex.reply(), codex.complete()], { mtime: NOW - 2 * HOUR })
  const fs = countingFs()
  const timers = fakeTimers()
  // The real time of a write is after the time of the fake clock, so a written file is in the window of the poll.
  const { catalog } = await catalogOf(t, home, { fs, timers })
  assert.equal(catalog.get(path).step, 'call')
  const handle = await open(path, 'a')
  t.after(() => handle.close())
  await handle.write(`${JSON.stringify({ timestamp: iso(NOW), ...codex.result() })}\n`)
  await handle.write(`${JSON.stringify({ timestamp: iso(NOW), ...codex.reply() })}\n${JSON.stringify({ timestamp: iso(NOW), ...codex.complete() })}\n`)
  assert.equal(catalog.get(path).step, 'call', 'No watch event came')
  fs.calls.length = 0
  timers.tick()
  await catalog.idle()
  assert.equal(catalog.get(path).step, 'end')
  assert.ok(!fs.calls.some(([, file]) => file === old), 'The poll did not stat a file without a write in the last hour')
  fs.calls.length = 0
  timers.tick()
  await catalog.idle()
  assert.deepEqual(fs.calls.filter(([name]) => name === 'open'), [], 'An unchanged size gives no read')
})

test('a Codex log that a process keeps open is read at a scan after a write, also when its last write was more than an hour ago', async t => {
  const home = await temporary(t)
  const path = await codexLog(home, '/work/quiet', 'quiet', [codex.started(), codex.prompt(), codex.reply(), codex.complete()], { mtime: NOW - 2 * HOUR })
  const fs = countingFs()
  const timers = fakeTimers()
  const { catalog } = await catalogOf(t, home, { fs, timers })
  const size = catalog.get(path).size
  const handle = await open(path, 'a')
  t.after(() => handle.close())
  await handle.write(`${JSON.stringify({ timestamp: iso(NOW), ...codex.started() })}\n${JSON.stringify({ timestamp: iso(NOW), ...codex.call() })}\n`)
  for (let poll = 0; poll < 5; poll++) { timers.tick(); await catalog.idle() }
  assert.deepEqual([catalog.get(path).size, catalog.get(path).step], [size, 'end'], 'The size poll takes only the files with a write in the last hour')
  const table = fakeTable([proc(30, 2, '/opt/homebrew/bin/codex', { name: 'codex' })], { 30: { cwd: '/work/quiet', files: [path] } })
  const [row] = (await running(catalog, table).query()).sessions
  assert.deepEqual([row.sessionId, row.status, catalog.get(path).step, catalog.get(path).size], ['quiet', 'working', 'call', (await stat(path)).size])
  // An unchanged open log costs one stat at a scan, and no read.
  fs.calls.length = 0
  await running(catalog, table).query()
  assert.deepEqual(fs.calls.filter(([, file]) => file === path).map(([name]) => name), ['stat'])
})

test('the first pass reads the files with a change in the last 24 hours first, the newest first, and the other files after them', async t => {
  const home = await temporary(t)
  const expected = [
    await piLog(home, '/work/p', 'ten-minutes', [pi.prompt()], { mtime: NOW - 10 * MINUTE }),
    await claudeLog(home, '/work/c', 'one-hour', [claude.prompt()], { mtime: NOW - HOUR }),
    await codexLog(home, '/work/x', 'day', [codex.prompt()], { mtime: NOW - 23 * HOUR }),
    await claudeLog(home, '/work/d', 'older', [claude.prompt()], { mtime: NOW - 30 * HOUR }),
    await piLog(home, '/work/q', 'oldest', [pi.prompt()], { mtime: NOW - 5 * 24 * HOUR }),
  ]
  const fs = countingFs()
  const recent = []
  const { catalog } = await catalogOf(t, home, { fs, start: false })
  const open = fs.open
  fs.open = async (path, flags) => { recent.push([path, catalog.progress.recent]); return open(path, flags) }
  assert.equal(catalog.session('pi', 'oldest'), undefined)
  await catalog.start()
  await catalog.idle()
  assert.deepEqual(opened(fs), expected)
  const flags = Object.fromEntries(recent.map(([path, value]) => [path, value]))
  assert.deepEqual(expected.map(path => flags[path]), [false, false, false, true, true], 'The live list is ready before the older files')
  assert.deepEqual([catalog.progress.done, catalog.progress.total, catalog.progress.complete], [5, 5, true])
})

test('the table stays across a restart: a new table on the same sessions.sqlite answers before it reads a file again', async t => {
  const home = await temporary(t)
  const path = await piLog(home, '/work/pi', 'kept', [pi.prompt(), pi.reply(), pi.title('Kept title')], { mtime: NOW - 5 * MINUTE, start: NOW - 2 * HOUR + 51000 })
  const first = await catalogOf(t, home)
  assert.equal(first.catalog.get(path).title, 'Kept title')
  await first.catalog.shut()

  let release
  const gate = new Promise(resolve => { release = resolve })
  const fs = countingFs()
  const open = fs.open
  fs.open = async (...args) => { await gate; return open(...args) }
  const second = await catalogOf(t, home, { fs, start: false })
  await second.catalog.start()
  const record = second.catalog.session('pi', 'kept')
  assert.deepEqual([record.title, record.step, record.cwd, record.read], ['Kept title', 'reply', '/work/pi', true])
  const answer = await running(second.catalog, fakeTable([proc(51, 2, 'node /opt/homebrew/bin/pi', { name: 'node' })], { 51: { cwd: '/work/pi' } })).query()
  assert.deepEqual([answer.sessions[0].sessionId, answer.sessions[0].title, answer.sessions[0].status], ['kept', 'Kept title', 'waiting_for_user'])
  assert.deepEqual(fs.calls.filter(([name]) => name === 'open'), [], 'The answer came from sessions.sqlite')
  release()
  await second.catalog.idle()
  assert.deepEqual(opened(fs), [], 'An unchanged file is not read again')
})

test('the read from the end of a log gives the last messages and a cursor, and a log of 600 MB costs only the bytes of its last lines', async t => {
  const home = await temporary(t)
  const cwd = '/outside/of/each/listed/directory'
  const path = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'), 'large.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ type: 'user', uuid: 'head', cwd, sessionId: 'large', timestamp: iso(NOW - HOUR), message: { role: 'user', content: 'head' } })}\n`)
  // A sparse file: 600 MB of zeros cost no disk space and no read, unless the reader reads them.
  const handle = await open(path, 'r+')
  await handle.truncate(600 * 1024 * 1024)
  await handle.close()
  const lines = Array.from({ length: 30 }, (_, index) => JSON.stringify({ type: index % 2 ? 'assistant' : 'user', uuid: `m${index}`, cwd, sessionId: 'large',
    timestamp: iso(NOW - MINUTE + index), message: { role: index % 2 ? 'assistant' : 'user', stop_reason: 'end_turn',
      content: index === 28 ? `secret sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345 ${'w'.repeat(5000)}` : `message ${index} ${index % 3 ? 'pine' : 'oak'}` } }))
  await appendFile(path, `\n${lines.join('\n')}\n`)
  const fs = countingFs()
  const { catalog } = await catalogOf(t, home, { fs })
  const sessions = new SessionHistoryService(fakeState(), {}, { logs: catalog })
  fs.bytes = 0
  const page = await sessions.readNewest({ agent: 'claude', sessionId: 'large' })
  assert.ok(fs.bytes <= TAIL_BYTES, `${fs.bytes} bytes`)
  assert.deepEqual(page.entries.map(entry => entry.id), Array.from({ length: 20 }, (_, index) => `m${index + 10}`))
  assert.deepEqual([page.source, page.order, page.session.cwd, page.session.sessionId], ['log', 'newest', cwd, 'large'])
  const secret = page.entries.find(entry => entry.id === 'm28')
  assert.ok(!secret.text.includes('abcdefghijklmnopqrstuvwxyz012345') && secret.text.includes(message('sessions.secret')))
  assert.equal(secret.truncated, true)
  assert.ok(secret.text.length <= 2000)
  fs.bytes = 0
  const older = await sessions.readNewest({ agent: 'claude', sessionId: 'large', cursor: page.nextCursor, limit: 10 })
  assert.deepEqual(older.entries.map(entry => entry.id), Array.from({ length: 10 }, (_, index) => `m${index}`))
  assert.ok(fs.bytes <= TAIL_BYTES, `${fs.bytes} bytes`)
  assert.ok(older.nextCursor)
  // The zeros are one line without a newline. A page stops after about 8 MB and gives a cursor further back.
  fs.bytes = 0
  const zeros = await sessions.readNewest({ agent: 'claude', sessionId: 'large', cursor: older.nextCursor })
  assert.deepEqual(zeros.entries, [])
  assert.ok(fs.bytes <= PAGE_SCAN_BYTES + TAIL_BYTES, `${fs.bytes} bytes`)
  assert.ok(zeros.nextCursor && zeros.nextCursor !== older.nextCursor)
  const found = await sessions.readNewest({ agent: 'claude', sessionId: 'large', query: 'oak', limit: 3 })
  assert.deepEqual(found.entries.map(entry => entry.id), ['m21', 'm24', 'm27'])
  await assert.rejects(sessions.readNewest({ agent: 'claude', sessionId: 'large', cursor: found.nextCursor }), { code: 'invalid' }, 'A cursor keeps its query')
  await assert.rejects(sessions.readNewest({ agent: 'claude', sessionId: 'missing' }), { code: 'missing' })
  // Without the consent there is no live table, and the read fails with a normal text.
  await assert.rejects(new SessionHistoryService(fakeState(), {}, { logs: undefined }).readNewest({ agent: 'claude', sessionId: 'large' }),
    { message: message('error.sessionsLogsOff') })
  // The read of the children keeps the limit to the listed directories, also with `order`.
  await assert.rejects(sessions.read({ cwd, agent: 'claude', sessionId: 'large', order: 'newest' }))
  assert.ok(!(await readFile(new URL('../src/MegachatHistoryServer.mjs', import.meta.url), 'utf8')).includes('readNewest'))
})

test('the pages of a read from the end give each entry exactly one time, also a line across the 8 MB limit of a page', async t => {
  const home = await temporary(t)
  const cwd = '/work/long'
  // 300 messages of about 100 KB each make a log of about 30 MB, so most pages stop at their limit of bytes.
  await claudeLog(home, cwd, 'long', Array.from({ length: 300 }, (_, index) => ({ uuid: `n${index}`, ...claude.prompt(`n${index} ${'v'.repeat(100 * 1024)}`) })))
  const { catalog } = await catalogOf(t, home)
  const sessions = new SessionHistoryService(fakeState(), {}, { logs: catalog })
  const seen = []
  let pages = 0
  for (let cursor; ;) {
    const page = await sessions.readNewest({ agent: 'claude', sessionId: 'long', limit: 100, cursor })
    seen.unshift(...page.entries.map(entry => entry.id))
    pages++
    if (!page.nextCursor) break
    cursor = page.nextCursor
  }
  assert.ok(pages >= 4, `${pages} pages`)
  assert.deepEqual(seen, Array.from({ length: 300 }, (_, index) => `n${index}`))
})

test('a cursor past the end of a log that became shorter gives the invalid-cursor error, not the same cursor again', async t => {
  const home = await temporary(t)
  const records = Array.from({ length: 40 }, (_, index) => ({ uuid: `s${index}`, ...claude.prompt(`s${index} ${'v'.repeat(50 * 1024)}`) }))
  const path = await claudeLog(home, '/work/cut', 'cut', records)
  const { catalog } = await catalogOf(t, home)
  const sessions = new SessionHistoryService(fakeState(), {}, { logs: catalog })
  const page = await sessions.readNewest({ agent: 'claude', sessionId: 'cut', limit: 5 })
  assert.ok(page.nextCursor)
  // The log is cut in place: the inode stays, and the cursor is past the new end.
  const { ino } = await stat(path)
  const lines = (await readFile(path, 'utf8')).split('\n')
  await writeFile(path, `${lines.slice(0, 3).join('\n')}\n`)
  assert.equal((await stat(path)).ino, ino)
  await assert.rejects(sessions.readNewest({ agent: 'claude', sessionId: 'cut', cursor: page.nextCursor }), { code: 'invalid' })
  // A read that gives no line, such as of a file that became shorter during the read, gives no cursor.
  const empty = await newestPage(fsp, catalog.source('claude'), path, { before: 2000000, limit: 5 })
  assert.deepEqual(empty, { entries: [], before: null })
})

test('Megachat writes to no provider file: each file keeps its size and mtime, and the code opens it read-only', async t => {
  const home = await temporary(t)
  const paths = [
    await claudeLog(home, '/work/c', 'c1', [claude.prompt(), claude.call()], { mtime: NOW - MINUTE }),
    await codexLog(home, '/work/x', 'x1', [codex.started(), codex.call()], { mtime: NOW - MINUTE, start: NOW - 2 * HOUR + 30000 }),
    await piLog(home, '/work/p', 'p1', [pi.prompt(), pi.reply()], { mtime: NOW - MINUTE, start: NOW - 2 * HOUR + 51000 }),
  ]
  const pidFile = join(home, '.claude', 'sessions', '10.json')
  await mkdir(dirname(pidFile), { recursive: true })
  await writeFile(pidFile, JSON.stringify({ pid: 10, sessionId: 'c1', cwd: '/work/c', procStart: lstart(NOW - 2 * HOUR + 10000) }))
  const before = await Promise.all([...paths, pidFile].map(async path => { const { size, mtimeMs } = await stat(path); return { size, mtimeMs } }))
  const fs = countingFs()
  const timers = fakeTimers()
  const { catalog } = await catalogOf(t, home, { fs, timers })
  const table = fakeTable([proc(10, 2, 'claude'), proc(30, 2, '/opt/homebrew/bin/codex', { name: 'codex' }), proc(51, 2, 'node /opt/homebrew/bin/pi', { name: 'node' })],
    { 10: { cwd: '/work/c' }, 30: { cwd: '/work/x', files: [paths[1]] }, 51: { cwd: '/work/p' } })
  const answer = await running(catalog, table).query()
  assert.equal(answer.sessions.filter(row => row.status).length, 3)
  timers.tick()
  catalog.changed(paths[0])
  await catalog.idle()
  await new SessionHistoryService(fakeState(), {}, { logs: catalog }).readNewest({ agent: 'codex', sessionId: 'x1' })
  const after = await Promise.all([...paths, pidFile].map(async path => { const { size, mtimeMs } = await stat(path); return { size, mtimeMs } }))
  assert.deepEqual(after, before)
  const opens = fs.calls.filter(([name]) => name === 'open')
  assert.ok(opens.length >= 4)
  assert.ok(opens.every(([, path, flags]) => flags === (path === pidFile ? SMALL_FILE_FLAGS : 'r')), 'Each provider file opens read-only')
  // The process file opens read-only, and not through a symbolic link.
  assert.deepEqual([SMALL_FILE_FLAGS & (constants.O_WRONLY | constants.O_RDWR | constants.O_CREAT | constants.O_TRUNC | constants.O_APPEND), SMALL_FILE_FLAGS & constants.O_NOFOLLOW],
    [0, constants.O_NOFOLLOW])
  assert.ok(opens.some(([, path]) => path === pidFile))
})

test('the open files map a process to its log, and a codex app-server with two open logs gives two rows', async t => {
  const home = await temporary(t)
  const one = await codexLog(home, '/work/desk', 'thread-one', [codex.title('First thread'), codex.started(), codex.call()], { mtime: NOW - 30000 })
  const two = await codexLog(home, '/work/other', 'thread-two', [codex.title('Second thread'), codex.started(), codex.reply(), codex.complete()], { mtime: NOW - 20 * MINUTE })
  const tui = await codexLog(home, '/work/tui', 'tui', [codex.started(), codex.prompt(), codex.reply(), codex.complete()], { mtime: NOW - 3 * HOUR })
  const { catalog } = await catalogOf(t, home)
  const files = { 30: { cwd: '/', files: [one, two, '/elsewhere/notes.jsonl'] }, 31: { cwd: '/work/tui', files: [tui] } }
  const table = fakeTable([proc(30, 2, '/Applications/ChatGPT.app/Contents/Resources/codex app-server', { name: 'codex' }),
    proc(31, 2, '/opt/homebrew/bin/codex', { name: 'codex' })], files)
  const clock = fakeClock()
  const view = running(catalog, table, clock)
  const answer = await view.query()
  const rows = byPid(answer)
  assert.deepEqual(Object.keys(rows).sort(), ['30:thread-one', '30:thread-two', '31:tui'])
  assert.deepEqual([rows['30:thread-one'].title, rows['30:thread-one'].status, rows['30:thread-one'].state], ['First thread', 'working', 'active'])
  assert.deepEqual([rows['30:thread-two'].title, rows['30:thread-two'].status, rows['30:thread-two'].state], ['Second thread', 'waiting_for_user', 'idle'])
  assert.deepEqual([rows['31:tui'].status, rows['31:tui'].lastActivityAt], ['idle', iso(NOW - 3 * HOUR)])
  assert.deepEqual(answer.incomplete, [])
  // A row of each session pages with the cursor, also for the sessions of one process.
  const first = await view.query({ limit: 1 })
  const second = await view.query({ limit: 1, cursor: first.nextCursor })
  const third = await view.query({ limit: 1, cursor: second.nextCursor })
  assert.deepEqual([first, second, third].map(page => page.sessions[0].sessionId), ['thread-one', 'thread-two', 'tui'])
  assert.equal(third.nextCursor, null)
  // The process closes the log of an idle session and keeps the row. A write to a log of no row asks for the open files again.
  files[31].files = []
  const three = await codexLog(home, '/work/desk', 'thread-three', [codex.title('Third thread'), codex.started(), codex.prompt()])
  catalog.changed(three)
  await catalog.idle()
  files[30].files = [three]
  clock.time += SNAPSHOT_TTL_MS
  const later = byPid(await view.query())
  assert.deepEqual(table.calls.resolve, [[30, 31], [30, 31]])
  assert.deepEqual(Object.keys(later).sort(), ['30:thread-three', '31:tui'])
})

test('a process file of Claude Code maps a process to its log, and a file of a reused PID does not', async t => {
  const home = await temporary(t)
  await claudeLog(home, '/work/app', 'claude-one', [claude.title(), claude.prompt(), claude.reply(), claude.end()], { mtime: NOW - 5 * MINUTE })
  await claudeLog(home, '/work/app', 'claude-two', [claude.title('Other title'), claude.prompt(), claude.call()], { mtime: NOW - MINUTE })
  const processes = join(home, '.claude', 'sessions')
  await mkdir(processes, { recursive: true })
  const started = pid => NOW - 2 * HOUR + pid * 1000
  await writeFile(join(processes, '10.json'), JSON.stringify({ pid: 10, sessionId: 'claude-one', cwd: '/work/app', procStart: lstart(started(10)), status: 'idle' }))
  // The process with this PID ended, and another process got the PID later.
  await writeFile(join(processes, '11.json'), JSON.stringify({ pid: 11, sessionId: 'claude-two', cwd: '/work/app', procStart: lstart(started(11) - HOUR) }))
  // A process file without `procStart` compares its `startedAt`.
  await writeFile(join(processes, '12.json'), JSON.stringify({ pid: 12, sessionId: 'claude-three', cwd: '/work/new', startedAt: started(12) + 1500 }))
  const { catalog } = await catalogOf(t, home)
  const table = fakeTable([proc(10, 2, 'claude'), proc(11, 2, 'claude'), proc(12, 2, 'claude')], { 10: { cwd: '/work/app' }, 11: { cwd: '/work/app' }, 12: { cwd: '/work/new' } })
  const answer = await running(catalog, table).query()
  const rows = Object.fromEntries(answer.sessions.map(row => [row.pid, row]))
  assert.deepEqual([rows[10].sessionId, rows[10].title, rows[10].status], ['claude-one', 'Fix the build', 'waiting_for_user'])
  assert.deepEqual([rows[11].sessionId, rows[11].title, rows[11].status], ['', '', null])
  // The session of a new process has no log before its first message: the ID is certain, and the log is not there yet.
  assert.deepEqual([rows[12].sessionId, rows[12].title, rows[12].status, rows[12].lastActivityAt], ['claude-three', '', null, null])
  assert.deepEqual(answer.incomplete, [message('running.incomplete.unlinked', 2)])
})

test('the process file of Claude Code gives waiting_for_permission or waiting_for_user only for its own process, and a stale, broken, large or linked file gives the status of the log', async t => {
  const home = await temporary(t)
  const processes = join(home, '.claude', 'sessions')
  await mkdir(processes, { recursive: true })
  const started = pid => NOW - 2 * HOUR + pid * 1000
  // Each log began 1 second after the start of its process, so a row without a process file links to it too.
  const log = (pid, age, records = [claude.prompt(), claude.call()]) =>
    claudeLog(home, `/work/${pid}`, `s${pid}`, records, { start: started(pid) + 1000, mtime: NOW - age })
  const fields = (pid, since, extra = {}) => ({ pid, sessionId: `s${pid}`, cwd: `/work/${pid}`, procStart: lstart(started(pid)), kind: 'interactive',
    status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: since, updatedAt: since, ...extra })
  const processFile = (pid, since, extra) => writeFile(join(processes, `${pid}.json`), JSON.stringify(fields(pid, since, extra)))
  const QUIET = 20 * MINUTE
  // 10: a wait for a permission for 20 minutes. Without the process file, the silent log gives stuck.
  await log(10, QUIET)
  await processFile(10, NOW - QUIET)
  // 11 and 12: the other kinds of a permission request; 13: a CPU load just after the start of the wait.
  await log(11, MINUTE)
  await processFile(11, NOW - MINUTE, { waitingFor: 'sandbox request' })
  await log(12, MINUTE, [claude.prompt(), claude.reply(), claude.end()])
  await processFile(12, NOW - MINUTE + 5000, { waitingFor: 'worker request' })
  await log(13, 30000)
  await processFile(13, NOW - 30000)
  // 20: a question for 20 minutes gives waiting_for_user; 21: a busy session; 22: an open dialog.
  await log(20, QUIET)
  await processFile(20, NOW - QUIET, { waitingFor: 'input needed' })
  await log(22, QUIET)
  await processFile(22, NOW - QUIET, { waitingFor: 'dialog open' })
  // 23 to 26: a question with the guards of a permission wait: another start time, a later log write, a CPU load
  // after 2 minutes, a time in the future.
  await log(23, QUIET)
  await processFile(23, NOW - QUIET, { waitingFor: 'input needed', procStart: lstart(started(23) - HOUR) })
  await log(24, MINUTE)
  await processFile(24, NOW - 3 * MINUTE, { waitingFor: 'input needed' })
  await log(25, 5 * MINUTE)
  await processFile(25, NOW - 5 * MINUTE, { waitingFor: 'input needed' })
  await log(26, MINUTE)
  await processFile(26, NOW + HOUR, { waitingFor: 'input needed' })
  await log(21, MINUTE)
  await processFile(21, NOW - MINUTE, { status: 'busy', waitingFor: undefined })
  // 30: the file names another PID; 31: the process with this PID started at another time.
  await log(30, QUIET)
  await processFile(30, NOW - QUIET, { pid: 99 })
  await log(31, QUIET)
  await processFile(31, NOW - QUIET, { procStart: lstart(started(31) - HOUR) })
  // 32: the log got a write after the start of the wait; 33: a CPU load 5 minutes after the start of the wait.
  await log(32, MINUTE)
  await processFile(32, NOW - 3 * MINUTE)
  await log(33, 5 * MINUTE)
  await processFile(33, NOW - 5 * MINUTE)
  // 34: a time in the future.
  await log(34, MINUTE)
  await processFile(34, NOW + HOUR)
  // 40: no valid JSON; 41: a file above 16 KB; 42: a symbolic link to a file out of the directory; 43: a directory.
  await log(40, QUIET)
  await writeFile(join(processes, '40.json'), JSON.stringify(fields(40, NOW - QUIET)).slice(0, -1))
  await log(41, QUIET)
  await processFile(41, NOW - QUIET, { pad: 'p'.repeat(20 * 1024) })
  await log(42, QUIET)
  await writeFile(join(home, 'outside.json'), JSON.stringify(fields(42, NOW - QUIET)))
  await symlink(join(home, 'outside.json'), join(processes, '42.json'))
  await log(43, QUIET)
  await mkdir(join(processes, '43.json'))
  // 50: no process file.
  await log(50, QUIET)
  const { catalog } = await catalogOf(t, home)
  const pids = [10, 11, 12, 13, 20, 21, 22, 23, 24, 25, 26, 30, 31, 32, 33, 34, 40, 41, 42, 43, 50]
  const busy = new Set([13, 25, 33])
  const table = fakeTable(pids.map(pid => proc(pid, 2, 'claude', { cpu: busy.has(pid) ? 40 : 0 })), Object.fromEntries(pids.map(pid => [pid, { cwd: `/work/${pid}` }])))
  const answer = await running(catalog, table).query({ limit: 50 })
  const rows = Object.fromEntries(answer.sessions.map(row => [row.pid, row.status]))
  assert.deepEqual(rows, {
    10: 'waiting_for_permission', 11: 'waiting_for_permission', 12: 'waiting_for_permission', 13: 'waiting_for_permission',
    20: 'waiting_for_user', 21: 'working', 22: 'stuck', 23: 'stuck', 24: 'working', 25: 'working', 26: 'working', 30: 'stuck', 31: 'stuck', 32: 'working', 33: 'working', 34: 'working',
    40: 'stuck', 41: 'stuck', 42: 'stuck', 43: 'stuck', 50: 'stuck',
  })
  // The view gives the start of the status to the notes: the start of the wait in the process file, or the last write
  // of the log of a stuck session. The output of the tool does not have it.
  const since = Object.fromEntries((await running(catalog, table).view()).rows.map(row => [row.pid, row.statusSince]))
  assert.deepEqual([since[10], since[11], since[22], since[50], since[20], since[21]], [NOW - QUIET, NOW - MINUTE, NOW - QUIET, NOW - QUIET, NOW - QUIET, null])
  assert.ok(answer.sessions.every(row => !('statusSince' in row)))
  // The wait ends: Claude Code writes the status busy, and the log gets the result of the tool.
  await processFile(10, NOW, { status: 'busy', waitingFor: undefined })
  const clock = fakeClock(NOW + SNAPSHOT_TTL_MS)
  assert.equal(byPid(await running(catalog, table, clock).query({ limit: 50 }))['10:s10'].status, 'stuck')
})

test('a child of Megachat with a pending permission request of its run gets waiting_for_permission, whatever its log says', async t => {
  const home = await temporary(t)
  const DAEMON = 900
  const started = pid => NOW - 2 * HOUR + pid * 1000
  // 902: a Claude child with a finished turn in its log; 912: a Codex child with a call 20 minutes ago; 922: a pi child
  // without a log; 932: a Claude child whose run has an answered request; 942: a request of an older generation of the run.
  await claudeLog(home, '/work/claude', 'child-claude', [claude.prompt(), claude.reply(), claude.end()], { mtime: NOW - MINUTE })
  const codexPath = await codexLog(home, '/work/codex', 'child-codex', [codex.started(), codex.prompt(), codex.call()], { mtime: NOW - 20 * MINUTE })
  await claudeLog(home, '/work/answered', 'child-answered', [claude.prompt(), claude.call()], { mtime: NOW - MINUTE })
  await claudeLog(home, '/work/old', 'child-old', [claude.prompt(), claude.call()], { mtime: NOW - 20 * MINUTE })
  // 950: a Claude Code session in a terminal, no child of Megachat, with the same project as a waiting child.
  await claudeLog(home, '/work/claude', 'terminal', [claude.prompt(), claude.call()], { start: started(950) + 1000, mtime: NOW - MINUTE })
  const run = (id, pid, agent, cwd, extra = {}) => ({ id, pid, agent, status: 'running', generation: 1, providerSessionId: `child-${id}`, title: `Task ${id}`, cwd, ...extra })
  const runs = [run('claude', 901, 'claude', '/work/claude'), run('codex', 911, 'codex', '/work/codex'), run('pi', 921, 'pi', '/work/pi'),
    run('answered', 931, 'claude', '/work/answered'), run('old', 941, 'claude', '/work/old', { generation: 2 })]
  const permission = (id, runId, extra = {}) => ({ id, runId, generation: 1, status: 'pending', request: {}, decision: null, createdAt: NOW - MINUTE, ...extra })
  const permissions = [permission('p1', 'claude'), permission('p2', 'codex'), permission('p3', 'pi'), permission('p4', 'answered', { status: 'answered' }),
    permission('p5', 'old')]
  const state = { snapshot: async () => ({ runs: Object.fromEntries(runs.map(item => [item.id, item])), permissions: Object.fromEntries(permissions.map(item => [item.id, item])) }) }
  const supervisor = pid => proc(pid, DAEMON, 'node /opt/megachat/src/child-supervisor.mjs node', { name: 'node' })
  const table = fakeTable([proc(DAEMON, 2, 'node /opt/megachat/src/main.mjs', { name: 'node' }),
    supervisor(901), proc(902, 901, 'claude'), supervisor(911), proc(912, 911, '/opt/homebrew/bin/codex', { name: 'codex' }),
    supervisor(921), proc(922, 921, 'node /opt/homebrew/bin/pi', { name: 'node' }), supervisor(931), proc(932, 931, 'claude'),
    supervisor(941), proc(942, 941, 'claude'), proc(950, 2, 'claude')],
  { 912: { cwd: '/work/codex', files: [codexPath] }, 950: { cwd: '/work/claude' } })
  const { catalog } = await catalogOf(t, home)
  const rows = async logs => Object.fromEntries((await new RunningAgents(state, { table, clock: fakeClock(), daemonPid: DAEMON, logs: () => logs }).query())
    .sessions.map(row => [row.pid, [row.sessionId, row.status]]))
  assert.deepEqual(await rows(catalog), {
    902: ['child-claude', 'waiting_for_permission'], 912: ['child-codex', 'waiting_for_permission'], 922: ['child-pi', 'waiting_for_permission'],
    932: ['child-answered', 'working'], 942: ['child-old', 'stuck'], 950: ['terminal', 'working'],
  })
  // Without the consent, each status is null, as for each other session.
  assert.deepEqual(Object.values(await rows(undefined)).map(([, status]) => status), [null, null, null, null, null, null])
})

test('an open .jsonl file of a Claude Code process does not replace its process file, also when it was a log of its session', async t => {
  const home = await temporary(t)
  await claudeLog(home, '/work/notes', 'notes-one', [claude.title('Notes'), claude.prompt(), claude.reply(), claude.end()], { mtime: NOW - 5 * MINUTE })
  const first = await claudeLog(home, '/work/pin', 'pin-one', [claude.title('First session'), claude.prompt(), claude.reply(), claude.end()], { mtime: NOW - 5 * MINUTE })
  await claudeLog(home, '/work/pin', 'pin-two', [claude.title('Second session'), claude.prompt(), claude.call()], { mtime: NOW - MINUTE })
  const processes = join(home, '.claude', 'sessions')
  await mkdir(processes, { recursive: true })
  const started = pid => NOW - 2 * HOUR + pid * 1000
  const processFile = (pid, sessionId, cwd) => writeFile(join(processes, `${pid}.json`), JSON.stringify({ pid, sessionId, cwd, procStart: lstart(started(pid)) }))
  await processFile(20, 'notes-one', '/work/notes')
  await processFile(21, 'pin-one', '/work/pin')
  const { catalog } = await catalogOf(t, home)
  // Process 20 has a .jsonl file open that is no session log. lsof saw the log of process 21 open one time.
  const table = fakeTable([proc(20, 2, 'claude'), proc(21, 2, 'claude')],
    { 20: { cwd: '/work/notes', files: [join(home, 'data', 'items.jsonl')] }, 21: { cwd: '/work/pin', files: [first] } })
  const clock = fakeClock()
  const view = running(catalog, table, clock)
  const rows = async () => Object.fromEntries((await view.query()).sessions.map(row => [row.pid, [row.sessionId, row.title, row.status]]))
  assert.deepEqual(await rows(), { 20: ['notes-one', 'Notes', 'waiting_for_user'], 21: ['pin-one', 'First session', 'waiting_for_user'] })
  // The process moves to another session. Its process file tells it.
  await processFile(21, 'pin-two', '/work/pin')
  clock.time += SNAPSHOT_TTL_MS
  assert.deepEqual((await rows())[21], ['pin-two', 'Second session', 'working'])
})

test('two processes of one agent in one directory do not get the title of the other', async t => {
  const home = await temporary(t)
  const started = pid => NOW - 2 * HOUR + pid * 1000
  // Two pi processes start 5 seconds apart, and each one begins a log 1 second after its start.
  await piLog(home, '/work/shared', 'near-a', [pi.title('Title A'), pi.prompt()], { start: started(50) + 1000, mtime: NOW - MINUTE })
  await piLog(home, '/work/shared', 'near-b', [pi.title('Title B'), pi.prompt()], { start: started(55) + 1000, mtime: NOW - MINUTE })
  // Two processes 10 minutes apart can each have their own log.
  await piLog(home, '/work/apart', 'apart-a', [pi.title('Title C'), pi.reply()], { start: started(60) + 1000, mtime: NOW - MINUTE })
  await piLog(home, '/work/apart', 'apart-b', [pi.title('Title D'), pi.reply()], { start: started(660) + 1000, mtime: NOW - MINUTE })
  // A log that begins long after the start of its process can be the log of another process, so it gives no link.
  await piLog(home, '/work/late', 'late', [pi.title('Title E'), pi.prompt()], { start: started(70) + 10 * MINUTE, mtime: NOW - MINUTE })
  const { catalog } = await catalogOf(t, home)
  const piProcess = pid => proc(pid, 2, 'node /opt/homebrew/bin/pi', { name: 'node' })
  const table = fakeTable([piProcess(50), piProcess(55), piProcess(60), piProcess(660), piProcess(70)],
    { 50: { cwd: '/work/shared' }, 55: { cwd: '/work/shared' }, 60: { cwd: '/work/apart' }, 660: { cwd: '/work/apart' }, 70: { cwd: '/work/late' } })
  const answer = await running(catalog, table).query()
  const rows = Object.fromEntries(answer.sessions.map(row => [row.pid, [row.sessionId, row.title]]))
  assert.deepEqual(rows, { 50: ['', ''], 55: ['', ''], 60: ['apart-a', 'Title C'], 660: ['apart-b', 'Title D'], 70: ['', ''] })
  assert.deepEqual(answer.incomplete, [message('running.incomplete.unlinked', 3)])
})

test('a pi process that moves to another log of its directory with /new or /resume does not keep the title of its first log', async t => {
  const home = await temporary(t)
  const started = pid => NOW - 2 * HOUR + pid * 1000
  // Process 80 began a log, and after /new it writes to a second log that began 20 minutes later.
  await piLog(home, '/work/new', 'new-one', [pi.title('First'), pi.prompt(), pi.reply()], { start: started(80) + 1000, mtime: NOW - 30 * MINUTE })
  await piLog(home, '/work/new', 'new-two', [pi.title('Second'), pi.prompt(), pi.call()], { start: started(80) + 20 * MINUTE, mtime: NOW - MINUTE })
  // Process 81 began a log, and after /resume it writes to a log of yesterday.
  await piLog(home, '/work/resume', 'resume-one', [pi.title('First'), pi.prompt(), pi.reply()], { start: started(81) + 1000, mtime: NOW - 30 * MINUTE })
  await piLog(home, '/work/resume', 'resume-old', [pi.title('Yesterday'), pi.prompt(), pi.call()], { start: NOW - 24 * HOUR, mtime: NOW - MINUTE })
  // An older log of the directory without a later write does not change the link.
  await piLog(home, '/work/kept', 'kept-one', [pi.title('Kept'), pi.prompt(), pi.reply()], { start: started(82) + 1000, mtime: NOW - MINUTE })
  await piLog(home, '/work/kept', 'kept-old', [pi.title('Old'), pi.prompt(), pi.reply()], { start: NOW - 24 * HOUR, mtime: NOW - 20 * HOUR })
  // A later write to a log that another process of the directory began does not change the link.
  await piLog(home, '/work/later', 'later-a', [pi.title('Title A'), pi.reply()], { start: started(83) + 1000, mtime: NOW - 30 * MINUTE })
  await piLog(home, '/work/later', 'later-b', [pi.title('Title B'), pi.reply()], { start: started(683) + 1000, mtime: NOW - MINUTE })
  const { catalog } = await catalogOf(t, home)
  const piProcess = pid => proc(pid, 2, 'node /opt/homebrew/bin/pi', { name: 'node' })
  const table = fakeTable([piProcess(80), piProcess(81), piProcess(82), piProcess(83), piProcess(683)],
    { 80: { cwd: '/work/new' }, 81: { cwd: '/work/resume' }, 82: { cwd: '/work/kept' }, 83: { cwd: '/work/later' }, 683: { cwd: '/work/later' } })
  const answer = await running(catalog, table).query()
  const rows = Object.fromEntries(answer.sessions.map(row => [row.pid, [row.sessionId, row.title]]))
  assert.deepEqual(rows, { 80: ['', ''], 81: ['', ''], 82: ['kept-one', 'Kept'], 83: ['later-a', 'Title A'], 683: ['later-b', 'Title B'] })
  assert.deepEqual(answer.incomplete, [message('running.incomplete.unlinked', 2)])
})

test('the order is orphan, active and idle, the newest activity first, and a row without a log sorts by its start time', async t => {
  const home = await temporary(t)
  const started = pid => NOW - 2 * HOUR + pid * 1000
  const log = (pid, age, records = [pi.prompt(), pi.reply()]) => piLog(home, `/work/${pid}`, `s${pid}`, records, { start: started(pid) + 1000, mtime: NOW - age })
  await log(10, 3 * HOUR)
  await log(20, 30000)
  await log(21, 90000)
  await log(30, 3 * MINUTE)
  await log(31, 50 * MINUTE)
  const { catalog } = await catalogOf(t, home)
  const piProcess = (pid, ppid = 2, cpu = 0) => proc(pid, ppid, 'node /opt/homebrew/bin/pi', { name: 'node', cpu })
  // 10: an orphan; 20 and 21: a log write in the last 2 minutes; 22: a CPU load and no log; 30 and 31: idle with a log;
  // 40: idle without a log, so its start time sorts it.
  const table = fakeTable([piProcess(10, 1), piProcess(20), piProcess(21), piProcess(22, 2, 40), piProcess(30), piProcess(31), piProcess(40)],
    Object.fromEntries([10, 20, 21, 22, 30, 31, 40].map(pid => [pid, { cwd: `/work/${pid}` }])))
  const clock = fakeClock()
  const view = running(catalog, table, clock)
  const answer = await view.query()
  assert.deepEqual(answer.sessions.map(row => [row.pid, row.state]),
    [[10, 'orphan'], [20, 'active'], [21, 'active'], [22, 'active'], [30, 'idle'], [31, 'idle'], [40, 'idle']])
  // A CPU load counts for 2 minutes after the scan that saw it.
  table.processes = async () => [proc(1, 0, '/sbin/launchd'), proc(2, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2', { name: 'iTerm2' }), piProcess(22)]
  clock.time += 90000
  assert.equal((await view.query()).sessions[0].state, 'active')
  clock.time += 60000
  assert.equal((await view.query()).sessions[0].state, 'idle')
})

test('with the consent off, agents_running reads no file and names the logs in incomplete; with it on, the rows get their logs', { timeout: 20000 }, async t => {
  const home = await temporary(t)
  const path = await claudeLog(home, '/work/app', 'claude-one', [claude.title(), claude.prompt(), claude.call()], { mtime: Date.now() })
  await mkdir(join(home, '.claude', 'sessions'), { recursive: true })
  const startedAt = NOW - HOUR
  // The process file says that the session waits for a permission. Without the consent, Megachat does not read it.
  await writeFile(join(home, '.claude', 'sessions', '10.json'), JSON.stringify({ pid: 10, sessionId: 'claude-one', cwd: '/work/app', procStart: lstart(startedAt),
    status: 'waiting', waitingFor: 'permission prompt', statusUpdatedAt: Date.now() }))
  const fs = countingFs()
  const fake = fauxProvider()
  fake.setResponses(Array(20).fill(fauxAssistantMessage('Summary told.')))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const table = fakeTable([proc(10, 2, 'claude', { startedAt })], { 10: { cwd: '/work/app' } })
  const clock = { now: () => Date.now() }
  const watchers = []
  // The default is on, so the user stored off.
  const settingsPath = join(home, 'state', 'settings.json')
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(settingsPath, JSON.stringify({ schema: 1, onboarding: 'done', defaults: 2, values: { 'sessions.index': 'off' } }), { mode: 0o600 })
  const main = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {}, {
    keepAlive: { enabled: false }, sessionsPath: join(home, 'state', 'sessions.sqlite'), settingsPath, home, environment: {}, processTable: table, clock,
    sessionIndex: { fs, clock, debounceMs: 10, watch: () => { const watcher = { close() {}, on() {} }; watchers.push(watcher); return watcher },
      catalog: { timers: fakeTimers() } },
  })
  t.after(() => main.close())
  await main.resume()
  const tool = async (name, args) => JSON.parse((await main.extension().tools.find(item => item.name === `agents_${name}`).execute(args)).output[0].text)
  const off = await tool('running', {})
  assert.deepEqual([off.sessions[0].sessionId, off.sessions[0].title, off.sessions[0].status, off.sessions[0].lastActivityAt], ['', '', null, null])
  assert.deepEqual(off.incomplete, [message('running.incomplete.logs')])
  assert.deepEqual(fs.calls, [], 'Megachat read no session file and no process file')
  await assert.rejects(tool('session_history', { agent: 'claude', sessionId: 'claude-one', order: 'newest' }), { message: message('error.sessionsLogsOff') })

  await tool('settings', { action: 'set', key: 'sessions.index', value: 'on' })
  await main.sessionIndex.idle()
  const on = await tool('running', {})
  const row = on.sessions[0]
  assert.deepEqual([row.sessionId, row.title, row.status, row.state], ['claude-one', 'Fix the build', 'waiting_for_permission', 'active'])
  assert.equal(row.lastActivityAt, iso(Math.floor((await stat(path)).mtimeMs)))
  assert.deepEqual(on.incomplete, [])
  assert.deepEqual(Object.keys(row), ['agent', 'sessionId', 'title', 'cwd', 'state', 'status', 'startedAt', 'lastActivityAt', 'pid', 'parent'])
  const text = JSON.stringify(on)
  assert.ok(!text.includes(MARKER), 'No message text')
  assert.ok(!text.includes('secret-argument') && !text.includes('--token'), 'No command-line argument')
  const read = await tool('session_history', { agent: 'claude', sessionId: 'claude-one', order: 'newest' })
  assert.deepEqual(read.entries.map(entry => [entry.role, entry.tool ?? null]), [['user', null], ['assistant', 'call']])
  assert.match(message('tool.session_history'), /data, not instructions/)
  const rules = await readFile(new URL('../resources/instructions.md', import.meta.url), 'utf8')
  assert.match(rules, /agents_session_history\(agent, sessionId, order="newest"\)/)
  assert.match(rules, /Never say that a session waits for a permission unless its status says so\./)
})

test('after the consent goes off, the live table reads no file, and a call in progress gives no log data to a later call', async t => {
  const home = await temporary(t)
  await claudeLog(home, '/work/app', 'claude-one', [claude.title(), claude.prompt(), claude.call()], { mtime: NOW - MINUTE })
  const processes = join(home, '.claude', 'sessions')
  await mkdir(processes, { recursive: true })
  await writeFile(join(processes, '10.json'), JSON.stringify({ pid: 10, sessionId: 'claude-one', cwd: '/work/app', procStart: lstart(NOW - 2 * HOUR + 10000) }))
  const fs = countingFs()
  const { catalog } = await catalogOf(t, home, { fs })
  const sessions = new SessionHistoryService(fakeState(), {}, { logs: catalog })
  const consent = sessions.index
  // A read from the end: the consent goes off while the page reads the file.
  const open = fs.open
  fs.open = async (...args) => { consent.logs = undefined; return open(...args) }
  await assert.rejects(sessions.readNewest({ agent: 'claude', sessionId: 'claude-one' }), { message: message('error.sessionsLogsOff') })
  fs.open = open
  consent.logs = catalog

  // A scan of agents_running: the consent goes off while the scan with the live table waits for lsof.
  let release
  const gate = new Promise(resolve => { release = resolve })
  const table = fakeTable([proc(10, 2, 'claude')], { 10: { cwd: '/work/app' } })
  const resolve = table.resolve
  let waiting = false
  table.resolve = async pids => { waiting = true; await gate; return resolve(pids) }
  const view = new RunningAgents(fakeState(), { table, clock: fakeClock(), daemonPid: 900, logs: () => consent.logs })
  const before = view.query()
  while (!waiting) await new Promise(resolve => setImmediate(resolve))
  consent.logs = undefined
  await catalog.close()
  const after = view.query()
  release()
  await before
  const later = await after
  assert.deepEqual([later.sessions[0].sessionId, later.sessions[0].title, later.sessions[0].status], ['', '', null])
  assert.deepEqual(later.incomplete, [message('running.incomplete.logs')])

  // The closed table reads no file and gives nothing.
  const added = await claudeLog(home, '/work/new', 'claude-new', [claude.prompt()], { mtime: NOW })
  fs.calls.length = 0
  assert.deepEqual([await catalog.ensure(added), await catalog.read(added), await catalog.processSession('claude', 10, NOW - 2 * HOUR + 10000)],
    [undefined, undefined, undefined])
  assert.deepEqual(fs.calls, [])
})

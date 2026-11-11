import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, utimes, writeFile, appendFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { taskRows } from '../src/AcpBridge.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { RANK_WINDOW } from '../src/SessionIndex.mjs'
import { sessionSources } from '../src/SessionSources.mjs'
import { redactSecrets } from '../src/SessionText.mjs'
import { entryText } from '../src/MegachatSearchIndex.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { SessionHistoryService } from '../src/SessionHistoryService.mjs'
import { SessionIndexService } from '../src/SessionIndexService.mjs'
import { waitForState } from '../src/waitForState.mjs'

const DAY = 86400000
const NOW = Date.parse('2026-11-11T12:00:00Z')
const ON = { 'sessions.index': 'on', 'sessions.days': 180 }

async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-sessions-index-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return directory
}

/** A home directory with fixture sessions, and the listed project directories in it. */
async function fixture(t) {
  const home = await temporary(t)
  const project = join(home, 'src', 'alpha')
  const other = join(home, 'src', 'beta')
  // The encoded name of this directory starts with the encoded name of `alpha`, so only its `cwd` tells the project.
  const sibling = join(home, 'src', 'alpha-two')
  for (const directory of [project, other, sibling]) await mkdir(directory, { recursive: true })
  return { home, project, other, sibling, path: join(home, 'state', 'sessions.sqlite') }
}

const iso = time => new Date(time).toISOString()
const claudeLine = (uuid, type, content, cwd, time = NOW - DAY) =>
  `${JSON.stringify({ type, uuid, cwd, sessionId: 's', timestamp: iso(time), message: { role: type, content } })}\n`

/** Writes a Claude Code session of [cwd] and gives its path. */
async function claudeSession(home, cwd, id, lines, mtime) {
  const directory = join(home, '.claude', 'projects', cwd.replace(/[^a-zA-Z0-9]/g, '-'))
  await mkdir(directory, { recursive: true })
  const path = join(directory, `${id}.jsonl`)
  await writeFile(path, lines.join(''))
  if (mtime !== undefined) await utimes(path, new Date(mtime), new Date(mtime))
  return path
}

async function codexSession(home, cwd, id, texts, mtime) {
  const directory = join(home, '.codex', 'sessions', '2026', '11', '10')
  await mkdir(directory, { recursive: true })
  const path = join(directory, `rollout-2026-11-10T10-00-00-${id}.jsonl`)
  const lines = [{ timestamp: iso(NOW - DAY), type: 'session_meta', payload: { id, cwd, timestamp: iso(NOW - DAY), base_instructions: { text: 'x'.repeat(500) } } },
    { timestamp: iso(NOW - DAY), type: 'response_item', payload: { type: 'message', role: 'user', id: `${id}-env`, content: [{ type: 'input_text', text: '<environment_context>cwd</environment_context>' }] } },
    ...texts.map((text, index) => ({ timestamp: iso(NOW - DAY + index), type: 'response_item',
      payload: { type: 'message', role: index % 2 ? 'assistant' : 'user', id: `${id}-${index}`, content: [{ type: index % 2 ? 'output_text' : 'input_text', text }] } })),
    { timestamp: iso(NOW - DAY), type: 'response_item', payload: { type: 'function_call', id: `${id}-call`, call_id: 'c1', name: 'shell', arguments: '{"cmd":"ls juniper"}' } },
    { timestamp: iso(NOW - DAY), type: 'response_item', payload: { type: 'function_call_output', call_id: 'c1', output: 'juniper.txt' } }]
  await writeFile(path, lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  if (mtime !== undefined) await utimes(path, new Date(mtime), new Date(mtime))
  return path
}

async function piSession(home, cwd, id, texts) {
  const directory = join(home, '.pi', 'agent', 'sessions', `--${cwd.slice(1).replace(/\//g, '-')}--`)
  await mkdir(directory, { recursive: true })
  const path = join(directory, `2026-11-10T10-00-00-000Z_${id}.jsonl`)
  const lines = [{ type: 'session', version: 3, id, timestamp: iso(NOW - DAY), cwd },
    ...texts.map((text, index) => ({ type: 'message', id: `e${index}`, parentId: null, timestamp: iso(NOW - DAY + index),
      message: index % 2 ? { role: 'assistant', content: [{ type: 'text', text }, { type: 'toolCall', id: 't', name: 'read', arguments: { path: 'notes.md' } }], timestamp: NOW - DAY + index }
        : { role: 'user', content: [{ type: 'text', text }], timestamp: NOW - DAY + index } })),
    { type: 'message', id: 'r1', parentId: null, timestamp: iso(NOW - DAY + 99), message: { role: 'toolResult', toolCallId: 't', toolName: 'read', content: [{ type: 'text', text: 'pine result' }], isError: false, timestamp: NOW - DAY + 99 } }]
  await writeFile(path, lines.map(line => `${JSON.stringify(line)}\n`).join(''))
  return path
}

/** A state with the listed directories that the test changes, and the task and summary records of the service. */
function fakeState({ workspaces = [], projects = [] } = {}) {
  let value = { megachatWorkspace: null, workspaces, projects }
  const listeners = new Set()
  const record = { tasks: [], summaries: [], offs: 0 }
  return Object.assign(record, {
    snapshot: async () => value,
    watch: async () => {
      let listener
      return { value, start(callback) { listener = callback; listeners.add(callback) }, stop: async () => { listeners.delete(listener) } }
    },
    set(next) { value = { ...value, ...next }; for (const listener of listeners) listener({ kind: 'value', value }) },
    sessionsTask: async task => { record.tasks.push(task) },
    sessionsIndexed: async summary => { record.summaries.push(summary) },
    sessionsOff: async () => { record.offs++ },
  })
}

/** A file system that counts each call, so a test proves which session files the import touched. */
function countingFs() {
  const calls = []
  const wrap = name => (...args) => { calls.push([name, String(args[0])]); return fsp[name](...args) }
  return { calls, readdir: wrap('readdir'), stat: wrap('stat'), open: wrap('open') }
}

/** A file system that fails to open each path in [blocked], as for a file with the mode 000. */
function blockingFs(blocked = new Set()) {
  const open = (path, ...args) => blocked.has(String(path))
    ? Promise.reject(Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: 'EACCES' })) : fsp.open(path, ...args)
  const opened = []
  return { blocked, opened, readdir: fsp.readdir, stat: fsp.stat, open: (path, ...args) => { opened.push(String(path)); return open(path, ...args) } }
}

/** A watch that records the roots and lets a test send a change. */
function fakeWatch() {
  const watchers = []
  const watch = (root, options, listener) => {
    const watcher = { root, listener, closed: false, close() { watcher.closed = true }, on() {} }
    watchers.push(watcher)
    return watcher
  }
  return { watch, watchers, change: (root, file) => watchers.filter(item => item.root === root && !item.closed).forEach(item => item.listener('change', file)) }
}

const clock = (now = NOW) => ({ value: now, now() { return this.value } })
/** Timers that never fire, so the size poll of the live table does not run in a test of the index. */
const stillTimers = { setInterval: () => undefined, clearInterval() {} }

/**
 * An index service of the fixture. The live table of the session logs reads each session file of the machine, so it
 * gets its own file system: a test that counts the reads of the import does not count its reads.
 */
async function service(t, { home, path }, state, options = {}) {
  const watch = fakeWatch()
  const index = new SessionIndexService({ path, state, home, environment: {}, watch: watch.watch, clock: options.clock ?? clock(), debounceMs: 10,
    catalog: { fs: fsp, timers: stillTimers }, ...options })
  await mkdir(join(home, 'state'), { recursive: true })
  t.after(() => index.close())
  return { index, watch }
}

const hits = async (index, agent, cwd, query) => (await index.store.search(agent, cwd, query.split(' '))).hits

test('the import reads only complete appended lines, and imports a file again after a truncation or a rotation', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  const state = fakeState({ workspaces: [project] })
  const path = await claudeSession(home, project, 'one', [
    claudeLine('u1', 'user', 'Find the alpha juniper note', project),
    claudeLine('a1', 'assistant', [{ type: 'text', text: 'The alpha note is here.' }], project),
    // A writer has not completed this line yet.
    claudeLine('u2', 'user', 'gamma question', project).trimEnd(),
  ])
  const { index, watch } = await service(t, directories, state)
  await index.apply(ON)
  await index.idle()
  assert.equal((await hits(index, 'claude', project, 'juniper')).length, 1)
  assert.equal((await hits(index, 'claude', project, 'gamma')).length, 0, 'A line without a newline stays unread')
  assert.equal((await index.store.counts()).entries, 2)

  await appendFile(path, `\n${claudeLine('a2', 'assistant', 'delta answer', project)}`)
  watch.change(join(home, '.claude', 'projects'), `${project.replace(/[^a-zA-Z0-9]/g, '-')}/one.jsonl`)
  await index.idle()
  assert.equal((await hits(index, 'claude', project, 'gamma')).length, 1)
  assert.equal((await hits(index, 'claude', project, 'delta')).length, 1)
  assert.equal((await index.store.counts()).entries, 4, 'The import read only the appended lines')

  // A truncation: the file is shorter than the imported part.
  await writeFile(path, claudeLine('u9', 'user', 'zeta restart', project))
  await index.catchUp(project)
  assert.equal((await hits(index, 'claude', project, 'juniper')).length, 0)
  assert.equal((await hits(index, 'claude', project, 'zeta')).length, 1)
  assert.equal((await index.store.counts()).entries, 1)

  // A rotation: another file of the same size takes the path, so only its inode tells the change.
  const before = await stat(path)
  const rotated = `${path}.new`
  await writeFile(rotated, claudeLine('u8', 'user', 'iota restart', project))
  await rename(rotated, path)
  const after = await stat(path)
  assert.equal(after.size, before.size)
  assert.notEqual(after.ino, before.ino)
  await index.catchUp(project)
  assert.equal((await hits(index, 'claude', project, 'zeta')).length, 0)
  assert.equal((await hits(index, 'claude', project, 'iota')).length, 1)
})

test('a fork with copied entries keeps each entry one time', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  const shared = [claudeLine('u1', 'user', 'The shared juniper plan', project), claudeLine('a1', 'assistant', 'Plan accepted.', project)]
  await claudeSession(home, project, 'original', shared, NOW - 2 * DAY)
  await claudeSession(home, project, 'fork', [...shared, claudeLine('u2', 'user', 'Only in the fork', project)], NOW - DAY)
  const { index } = await service(t, directories, fakeState({ workspaces: [project] }))
  await index.apply(ON)
  await index.idle()
  assert.equal((await index.store.counts()).entries, 3)
  assert.equal((await hits(index, 'claude', project, 'juniper')).length, 1)
  assert.equal((await hits(index, 'claude', project, 'fork')).length, 1)
})

test('only the sessions of the listed directories enter the index, and a new listed directory brings its old sessions', async t => {
  const directories = await fixture(t)
  const { home, project, other, sibling } = directories
  await claudeSession(home, project, 'inside', [claudeLine('u1', 'user', 'juniper inside', project)])
  const outsideClaude = await claudeSession(home, other, 'outside', [claudeLine('u1b', 'user', 'juniper outside', other)])
  await claudeSession(home, sibling, 'sibling', [claudeLine('u1c', 'user', 'juniper sibling', sibling)])
  await claudeSession(home, join(project, 'sub'), 'below', [claudeLine('u1d', 'user', 'juniper below', join(project, 'sub'))])
  await codexSession(home, other, 'codex-outside', ['juniper codex question', 'answer'])
  const fs = countingFs()
  const state = fakeState({ workspaces: [project] })
  const { index } = await service(t, directories, state, { fs })
  await index.apply(ON)
  await index.idle()
  assert.deepEqual((await hits(index, 'claude', project, 'juniper')).map(hit => hit.session.sessionId).sort(), ['below', 'inside'])
  assert.equal(await index.store.hasSessions('claude', other), false)
  assert.equal(await index.store.hasSessions('claude', sibling), false)
  assert.equal(await index.store.hasSessions('codex', other), false)
  assert.ok(!fs.calls.some(([, file]) => file === outsideClaude), 'The import did not open a Claude file of another project')

  state.set({ projects: [other] })
  await index.idle()
  assert.equal((await hits(index, 'claude', other, 'juniper')).length, 1)
  assert.equal((await hits(index, 'codex', other, 'juniper')).length, 1)
  assert.equal(await index.store.hasSessions('claude', sibling), false)

  state.set({ projects: [] })
  await index.idle()
  assert.equal(await index.store.hasSessions('claude', other), false, 'A removed directory takes its sessions out')
})

test('with the consent off, Megachat reads no session file, watches nothing and keeps no index file', async t => {
  const directories = await fixture(t)
  const { home, project, path } = directories
  await claudeSession(home, project, 'one', [claudeLine('u1', 'user', 'juniper', project)])
  await piSession(home, project, 'pi-one', ['pine question', 'pine answer'])
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(path, 'an index from an earlier consent')
  const fs = countingFs()
  const watch = fakeWatch()
  const fake = fauxProvider()
  fake.setResponses(Array(20).fill(fauxAssistantMessage('Summary told.')))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const providers = { claude: { list: async () => ({ sessions: [], nextCursor: null }), read: async () => { throw new Error('none') }, close() {} } }
  const main = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, providers, {
    sessionsPath: path, home, environment: {}, sessionIndex: { fs, watch: watch.watch, clock: clock(), debounceMs: 10 } })
  await main.state.addWorkspace(project)
  const tasks = []
  const watcher = await main.state.watch()
  watcher.start(call => { if (call.kind === 'value' && call.value.sessionIndex?.task) tasks.push(call.value.sessionIndex.task) })
  t.after(async () => { await watcher.stop(); await main.close() })
  await main.resume()
  const tool = async (name, args) => {
    const item = main.extension().tools.find(entry => entry.name === `agents_${name}`)
    return JSON.parse((await item.execute(args)).output[0].text)
  }
  await assert.rejects(stat(path), { code: 'ENOENT' }, 'Megachat deletes the index file without the consent')
  assert.match(await readFile(new URL('../resources/instructions-onboarding.md', import.meta.url), 'utf8'),
    /"Index past Claude, Codex and pi sessions in your projects, and read the logs of the agent sessions that run on this machine to show their status\? Megachat reads the content of a session only when you ask\. Everything stays local\."/)
  await assert.rejects(tool('sessions', { cwd: project, agent: 'pi', query: 'pine' }), { message: message('error.sessionsIndexOff') })
  assert.deepEqual((await tool('sessions', { cwd: project, query: 'juniper' })).pages.map(page => page.agent), ['claude'])
  assert.deepEqual((await tool('settings', { action: 'get' })).sessionIndex, { state: 'off' })
  assert.deepEqual(fs.calls, [])
  assert.deepEqual(watch.watchers, [])

  await tool('settings', { action: 'set', key: 'sessions.index', value: 'on' })
  await main.sessionIndex.idle()
  assert.ok(fs.calls.length > 0)
  assert.equal(watch.watchers.length, 3)
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const found = await tool('sessions', { cwd: project, agent: 'pi', query: 'pine' })
  assert.equal(found.pages[0].source, 'index')
  assert.equal(found.pages[0].matches[0].sessionId, 'pi-one')
  assert.equal(found.index.state, 'ready')
  assert.equal((await tool('settings', { action: 'get' })).sessionIndex.sessions, 2)

  // The first pass shows a background task with its progress, then the summary becomes one event turn.
  assert.ok(tasks.length >= 1)
  assert.deepEqual(tasks[0], { id: tasks[0].id, done: 0, total: 2 })
  assert.match(tasks[0].id, /^sessions:[a-z0-9-]+:0$/)
  const rows = taskRows({ runs: {}, sessionIndex: { task: tasks[0] } })
  assert.deepEqual([...rows.values()], [{ name: message('sessions.task'), description: message('sessions.task.progress', 0, 2) }])
  const settled = await waitForState(main.state, value => {
    const events = Object.keys(value.inputs).filter(id => id.startsWith('sessions:'))
    return events.length && !value.current ? { value, events } : undefined
  })
  assert.equal(settled.events.length, 1)
  assert.equal(settled.value.sessionIndex.task, null)
  assert.equal(settled.value.sessionIndex.summary, null)
  const event = (await main.root.entries({ order: 'descending' }, 50, undefined, BACKGROUND_CONTEXT)).items.find(entry => entry.kind === 'air.megachat.event')
  assert.equal(event.data.type, 'sessions')
  assert.equal(event.data.sessions, 2)
  assert.equal(event.data.projects, 1)
  assert.deepEqual(event.data.agents, { claude: 1, codex: 0, pi: 1 })
  // The pi session ends with a tool result, so it is unfinished. The Claude session ends with a prompt.
  assert.deepEqual(event.data.unfinished.map(session => session.sessionId).sort(), ['one', 'pi-one'])
  assert.match(entryText(event).text, /^Past sessions indexed: 2 sessions in 1 projects\n/, 'The history search finds the summary')

  await tool('settings', { action: 'set', key: 'sessions.index', value: 'off' })
  await assert.rejects(stat(path), { code: 'ENOENT' })
  assert.ok(watch.watchers.every(item => item.closed))
  await assert.rejects(tool('sessions', { cwd: project, agent: 'pi', query: 'pine' }), { message: message('error.sessionsIndexOff') })
})

test('the first pass imports the projects of an IDE first and the newest files first, and shows its progress', async t => {
  const directories = await fixture(t)
  const { home, project, other } = directories
  const order = [
    await claudeSession(home, project, 'ide-new', [claudeLine('u1', 'user', 'one', project)], NOW - 2 * DAY),
    await claudeSession(home, project, 'ide-old', [claudeLine('u2', 'user', 'two', project)], NOW - 5 * DAY),
    await claudeSession(home, other, 'known-newest', [claudeLine('u3', 'user', 'three', other)], NOW - DAY),
  ]
  const fs = countingFs()
  const state = fakeState({ workspaces: [project], projects: [other] })
  const { index } = await service(t, directories, state, { fs })
  await index.apply(ON)
  await index.idle()
  const opened = [...new Set(fs.calls.filter(([name, file]) => name === 'open' && file.endsWith('.jsonl')).map(([, file]) => file))]
  assert.deepEqual(opened, order)
  assert.deepEqual(state.tasks.map(task => task && [task.done, task.total]), [[0, 3], [1, 3], [2, 3], null])
  assert.equal(new Set(state.tasks.filter(Boolean).map(task => task.id)).size, 3, 'Each step is a task of its own')
  assert.equal(state.summaries.length, 1)
  assert.deepEqual([state.summaries[0].sessions, state.summaries[0].projects], [3, 2])
})

test('a file that the import cannot read does not stop the pass, and the import reads it again after its next change', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  await claudeSession(home, project, 'new', [claudeLine('u1', 'user', 'juniper new', project)], NOW - DAY)
  const bad = await claudeSession(home, project, 'bad', [claudeLine('u2', 'user', 'juniper bad', project)], NOW - 2 * DAY)
  await claudeSession(home, project, 'old', [claudeLine('u3', 'user', 'juniper old', project)], NOW - 3 * DAY)
  const fs = blockingFs(new Set([bad]))
  const state = fakeState({ workspaces: [project] })
  const { index, watch } = await service(t, directories, state, { fs })
  await index.apply(ON)
  await index.idle()
  assert.equal(state.tasks.at(-1), null, 'The task of the pass ends')
  assert.equal((await index.status()).state, 'ready')
  assert.equal(state.summaries.length, 1)
  assert.deepEqual((await hits(index, 'claude', project, 'juniper')).map(hit => hit.session.sessionId).sort(), ['new', 'old'])
  assert.equal(await index.catchUp(project), true, 'A search is complete without the unreadable file')
  fs.opened.length = 0
  await index.catchUp(project)
  assert.ok(!fs.opened.includes(bad), 'The import does not read the unreadable file again before it changes')

  // A change of the unreadable file, and of a file that becomes unreadable after the first pass.
  const root = join(home, '.claude', 'projects')
  const name = file => `${project.replace(/[^a-zA-Z0-9]/g, '-')}/${file}.jsonl`
  const newPath = join(root, name('new'))
  await appendFile(newPath, claudeLine('u4', 'user', 'juniper newer', project))
  fs.blocked.add(newPath)
  watch.change(root, name('new'))
  await index.idle()
  fs.blocked.clear()
  await appendFile(bad, claudeLine('u5', 'user', 'juniper later', project))
  watch.change(root, name('bad'))
  await index.idle()
  assert.deepEqual((await hits(index, 'claude', project, 'juniper')).map(hit => hit.session.sessionId).sort(), ['bad', 'new', 'old'])
  await appendFile(newPath, claudeLine('u6', 'user', 'juniper newest', project))
  watch.change(root, name('new'))
  await index.idle()
  assert.equal((await hits(index, 'claude', project, 'newer')).length, 1, 'The import reads the lines that it could not read before')
})

test('a pass that failed runs again on the next change of a session file', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  await claudeSession(home, project, 'one', [claudeLine('u1', 'user', 'juniper', project)])
  const state = fakeState({ workspaces: [project] })
  const snapshot = state.snapshot
  let failures = 1
  state.snapshot = async () => { if (failures-- > 0) throw new Error('A state that cannot be read'); return snapshot() }
  const { index, watch } = await service(t, directories, state)
  await index.apply(ON)
  await index.idle()
  assert.equal((await index.status()).state, 'importing')
  watch.change(join(home, '.claude', 'projects'), `${project.replace(/[^a-zA-Z0-9]/g, '-')}/one.jsonl`)
  await index.idle()
  assert.equal((await index.status()).state, 'ready')
  assert.equal(state.summaries.length, 1)
})

test('the age limit skips old sessions, and a session that gets too old leaves the index at the next start', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  const old = await claudeSession(home, project, 'old', [claudeLine('u1', 'user', 'ancient juniper', project)], NOW - 40 * DAY)
  await claudeSession(home, project, 'recent', [claudeLine('u2', 'user', 'recent juniper', project)], NOW - 20 * DAY)
  const fs = countingFs()
  const state = fakeState({ workspaces: [project] })
  const time = clock()
  const first = await service(t, directories, state, { fs, clock: time })
  await first.index.apply({ 'sessions.index': 'on', 'sessions.days': 30 })
  await first.index.idle()
  assert.deepEqual((await hits(first.index, 'claude', project, 'juniper')).map(hit => hit.session.sessionId), ['recent'])
  assert.ok(!fs.calls.some(([name, file]) => name === 'open' && file === old), 'The import did not read the old file')
  await first.index.close()

  time.value = NOW + 15 * DAY
  const second = await service(t, directories, state, { clock: time })
  await second.index.apply({ 'sessions.index': 'on', 'sessions.days': 30 })
  await second.index.idle()
  assert.equal(await second.index.store.hasSessions('claude', project), false)
  await second.index.apply({ 'sessions.index': 'on', 'sessions.days': 0 })
  await second.index.idle()
  assert.equal((await hits(second.index, 'claude', project, 'juniper')).length, 2, 'The value 0 takes each session')
  assert.equal(state.summaries.length, 1, 'Only the first pass of the index file gives a summary')
})

test('the index keeps about 2 KB of an entry and replaces what looks like a secret', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  const secrets = ['sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345', 'ghp_abcdefghijklmnopqrstuvwxyz0123456789',
    'github_pat_11ABCDEFGHIJKLMNOPQRSTUV_wxyz', 'xoxb-1234567890-abcdefghij', 'AKIAIOSFODNN7EXAMPLE',
    'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
    'password=hunter2hunter2', '"api_key": "Zq9vX2mL7pR4tY8w"', 'TOKEN: abcd1234efgh5678']
  const key = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ\n-----END OPENSSH PRIVATE KEY-----'
  const output = `${secrets.join('\n')}\n${key}\ntotal_tokens: 123456789\n${'x'.repeat(5000)} tailmarker`
  await claudeSession(home, project, 'secret', [
    claudeLine('a1', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'cat .env' } }], project),
    claudeLine('u1', 'user', [{ type: 'tool_result', tool_use_id: 't1', content: output }], project),
  ])
  const { index } = await service(t, directories, fakeState({ workspaces: [project] }))
  await index.apply(ON)
  await index.idle()
  const session = await index.store.session('claude', project, 'secret')
  const { entries } = await index.store.entries(session.id)
  assert.deepEqual(entries.map(entry => [entry.role, entry.tool]), [['assistant', 'call'], ['tool', 'result']])
  const stored = entries[1]
  assert.ok(stored.text.length <= 2000)
  assert.equal(stored.clipped, true)
  for (const secret of ['abcdefghijklmnopqrstuvwxyz012345', 'ghp_abcdef', 'github_pat_', 'xoxb-', 'AKIAIOSFODNN7EXAMPLE', 'eyJhbGci',
    'hunter2', 'Zq9vX2mL7pR4tY8w', 'abcd1234efgh5678', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ'])
    assert.ok(!stored.text.includes(secret), secret)
  assert.ok(stored.text.includes(message('sessions.secret')))
  assert.ok(stored.text.includes('password='), 'The name of an assignment stays')
  assert.ok(stored.text.includes('123456789'), 'A number stays')
  assert.equal((await hits(index, 'claude', project, 'hunter2')).length, 0)
  assert.equal((await hits(index, 'claude', project, 'tailmarker')).length, 0)
  assert.equal((await hits(index, 'claude', project, 'xxxx')).length, 1)
})

test('the secret filter finds an assignment in a JSON text with escaped quotes, as in a tool call', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  await claudeSession(home, project, 'write', [claudeLine('a1', 'assistant', [{ type: 'tool_use', id: 't1', name: 'Write',
    input: { file_path: 'config.json', content: '{"password": "hunter2hunter2", "api_key": "Zq9vX2mL7pR4tY8w"}' } }], project)])
  const codex = await codexSession(home, project, 'curl', ['juniper question', 'answer'])
  await appendFile(codex, `${JSON.stringify({ timestamp: iso(NOW - DAY), type: 'response_item', payload: { type: 'function_call', id: 'curl-call',
    call_id: 'c2', name: 'shell', arguments: JSON.stringify({ cmd: `curl -d '{"password":"s3cr3tvalue9"}' https://x` }) } })}\n`)
  const { index } = await service(t, directories, fakeState({ workspaces: [project] }))
  await index.apply(ON)
  await index.idle()
  const texts = []
  for (const [agent, id] of [['claude', 'write'], ['codex', 'curl']]) {
    const session = await index.store.session(agent, project, id)
    texts.push(...(await index.store.entries(session.id)).entries.map(entry => entry.text))
  }
  const all = texts.join('\n')
  for (const secret of ['hunter2hunter2', 'Zq9vX2mL7pR4tY8w', 's3cr3tvalue9']) assert.ok(!all.includes(secret), secret)
  assert.ok(all.includes(`\\"password\\": \\"${message('sessions.secret')}`), 'The name of the field stays')
  assert.ok(all.includes('config.json'))
  const marker = message('sessions.secret')
  assert.equal(redactSecrets('DB_PASSWORD=s3cr3tvalue'), `DB_PASSWORD=${marker}`)
  assert.equal(redactSecrets('https://x/?access_token=abcd1234efgh5678&x=1'), `https://x/?access_token=${marker}&x=1`)
  assert.equal(redactSecrets('SPRING_DATASOURCE_HIKARI_CONNECTION_POOL_PASSWORD=s3cr3tvalue'), `SPRING_DATASOURCE_HIKARI_CONNECTION_POOL_PASSWORD=${marker}`)
  assert.equal(redactSecrets('total_tokens: 123456789'), 'total_tokens: 123456789')
  // A long line of hex with dashes took about 17 ms with an unbounded name before the bound of the name.
  const line = 'a1f-'.repeat(1000)
  const start = performance.now()
  redactSecrets(line)
  assert.ok(performance.now() - start < 50)
})

test('a title of a session goes through the secret filter and the limit of a title', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  const key = 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345'
  const custom = `Deploy with ${key} ${'y'.repeat(5000)}`
  await claudeSession(home, project, 'titled', [
    `${JSON.stringify({ type: 'custom-title', customTitle: custom, sessionId: 'titled' })}\n`,
    claudeLine('u1', 'user', 'juniper prompt', project),
  ])
  const state = fakeState({ workspaces: [project] })
  const { index } = await service(t, directories, state)
  await index.apply(ON)
  await index.idle()
  const [hit] = await hits(index, 'claude', project, 'Deploy')
  assert.ok(hit.session.title.startsWith(`Deploy with ${message('sessions.secret')}`), hit.session.title.slice(0, 80))
  assert.ok(hit.session.title.length <= 200)
  assert.ok(hit.entry.text.length <= 200)
  assert.equal((await hits(index, 'claude', project, 'abcdefghijklmnop')).length, 0)
  assert.ok(!JSON.stringify(state.summaries).includes('abcdefghijklmnop'), 'The summary has no secret')
  assert.ok(state.summaries[0].unfinished[0].title.length <= 200)
})

test('a version change makes the index again from the session files without a second summary', async t => {
  const directories = await fixture(t)
  const { home, project, path } = directories
  await claudeSession(home, project, 'one', [claudeLine('u1', 'user', 'juniper', project)])
  const state = fakeState({ workspaces: [project] })
  const first = await service(t, directories, state)
  await first.index.apply(ON)
  await first.index.idle()
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  await first.index.close()
  const raw = new DatabaseSync(path)
  raw.exec("UPDATE meta SET version = 0; DELETE FROM entries; INSERT INTO entries (session, agent, key, role, clipped) VALUES (1, 'claude', 'stale', 'user', 0)")
  raw.close()
  const second = await service(t, directories, state)
  await second.index.apply(ON)
  await second.index.idle()
  assert.equal((await hits(second.index, 'claude', project, 'juniper')).length, 1)
  assert.equal((await second.index.store.counts()).entries, 1)
  assert.equal(state.summaries.length, 1)
})

/** A live source of Claude Code that records its calls. */
function liveSource(cwd) {
  const calls = []
  return { calls, list: async () => { calls.push('list'); return { sessions: [{ sessionId: 'live', title: 'A live juniper session', cwd }], nextCursor: null } },
    read: async () => { calls.push('read'); return { session: { sessionId: 'live', cwd }, entries: [{ id: '1', role: 'user', text: 'juniper live' }], nextCursor: null } },
    close() {} }
}

test('the tools answer from the index, page through it, and fall back to the live source', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  await claudeSession(home, project, 'indexed', Array.from({ length: 25 }, (_, index) =>
    claudeLine(`m${index}`, index % 2 ? 'assistant' : 'user', `message ${index} about juniper`, project, NOW - DAY + index)))
  await piSession(home, project, 'pi-one', ['pine question', 'pine answer'])
  const state = fakeState({ workspaces: [project] })
  const { index } = await service(t, directories, state)
  const claude = liveSource(project)
  const codex = liveSource(project)
  const sessions = new SessionHistoryService(state, { claude, codex }, index)
  await assert.rejects(sessions.search({ cwd: project, agent: 'pi' }), { code: 'sessionsIndexOff' })
  await index.apply(ON)
  await index.idle()

  const found = await sessions.search({ cwd: project, query: 'juniper' })
  assert.deepEqual(found.pages.map(page => [page.agent, page.source]), [['claude', 'index'], ['codex', undefined], ['pi', 'index']])
  assert.equal(found.pages[0].matches.length, 1, 'One match for each session')
  assert.equal(found.pages[0].matches[0].sessionId, 'indexed')
  assert.match(found.pages[0].matches[0].text, /juniper/)
  assert.equal(found.pages[0].complete, true)
  assert.deepEqual(claude.calls, [])
  assert.deepEqual(codex.calls, ['list'], 'The index has no Codex session here, so the live source answers')
  assert.equal(found.index.state, 'ready')

  const listed = await sessions.search({ cwd: project, agent: 'claude' })
  assert.equal(listed.pages[0].matches[0].title, 'message 0 about juniper')
  const short = await sessions.search({ cwd: project, agent: 'claude', query: 'ju' })
  assert.equal(short.pages[0].source, undefined, 'A short query goes to the live source')

  const first = await sessions.read({ cwd: project, agent: 'claude', sessionId: 'indexed' })
  assert.equal(first.source, 'index')
  assert.equal(first.entries.length, 20)
  assert.deepEqual([first.entries[0].id, first.entries[0].role, first.entries[0].timestamp], ['m0', 'user', iso(NOW - DAY)])
  const rest = await sessions.read({ cwd: project, agent: 'claude', sessionId: 'indexed', cursor: first.nextCursor })
  assert.equal(rest.entries.length, 5)
  assert.equal(rest.nextCursor, null)
  await assert.rejects(sessions.read({ cwd: project, agent: 'codex', sessionId: 'indexed', cursor: first.nextCursor }), { code: 'invalid' })
  const pi = await sessions.read({ cwd: project, agent: 'pi', sessionId: 'pi-one', query: 'pine' })
  assert.deepEqual(pi.entries.map(entry => [entry.role, entry.tool ?? null]), [['user', null], ['assistant', 'call'], ['tool', 'result']])
  await assert.rejects(sessions.read({ cwd: project, agent: 'pi', sessionId: 'missing' }), { code: 'missing' })
  assert.equal((await sessions.read({ cwd: project, agent: 'codex', sessionId: 'live' })).entries[0].text, 'juniper live')

  await index.apply({ ...ON, 'sessions.index': 'off' })
  await assert.rejects(sessions.read({ cwd: project, agent: 'claude', sessionId: 'indexed', cursor: first.nextCursor }), { code: 'invalid' })
  assert.deepEqual((await sessions.search({ cwd: project, query: 'juniper' })).pages.map(page => page.agent), ['claude', 'codex'])
})

test('a failed catch-up gives an incomplete page and does not fail the session tools', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  const path = await claudeSession(home, project, 'grows', [claudeLine('u1', 'user', 'juniper one', project)])
  await piSession(home, project, 'pi-one', ['pine question', 'pine answer'])
  const fs = blockingFs()
  const state = fakeState({ workspaces: [project] })
  const { index } = await service(t, directories, state, { fs })
  const sessions = new SessionHistoryService(state, { claude: liveSource(project), codex: liveSource(project) }, index)
  await index.apply(ON)
  await index.idle()
  await appendFile(path, claudeLine('u2', 'user', 'juniper two', project))
  fs.blocked.add(path)
  const found = await sessions.search({ cwd: project, query: 'juniper' })
  assert.deepEqual(found.pages.map(page => [page.agent, page.source]), [['claude', 'index'], ['codex', undefined], ['pi', 'index']])
  assert.equal(found.pages[0].complete, false)
  assert.equal(found.pages[0].error, message('sessions.incomplete'))
  assert.equal(found.pages[1].matches[0].sessionId, 'live', 'The live page stays')
  const read = await sessions.read({ cwd: project, agent: 'pi', sessionId: 'pi-one' })
  assert.equal(read.source, 'index')
  assert.equal(read.entries[0].text, 'pine question')
})

test('the search pages through more sessions than one page holds', async t => {
  const directories = await fixture(t)
  const { home, project } = directories
  for (let number = 0; number < 23; number++)
    await claudeSession(home, project, `s${number}`, [claudeLine(`u${number}`, 'user', `juniper ${number}`, project)], NOW - number * 1000)
  const { index } = await service(t, directories, fakeState({ workspaces: [project] }))
  const sessions = new SessionHistoryService(fakeState({ workspaces: [project] }), { claude: liveSource(project) }, index)
  await index.apply(ON)
  await index.idle()
  const seen = new Set()
  let page = (await sessions.search({ cwd: project, agent: 'claude', query: 'juniper' })).pages[0]
  for (;;) {
    for (const match of page.matches) seen.add(match.sessionId)
    if (!page.nextCursor) break
    page = (await sessions.search({ cwd: project, agent: 'claude', query: 'juniper', cursor: page.nextCursor })).pages[0]
  }
  assert.equal(seen.size, 23)
})

test('a search past the ranked window shows each session one time', async t => {
  const directories = await fixture(t)
  const { project } = directories
  const { index } = await service(t, directories, fakeState({ workspaces: [project] }))
  await index.apply(ON)
  await index.idle()
  const file = name => ({ path: join(project, `${name}.jsonl`), agent: 'claude', size: 1, mtimeMs: NOW, ino: name })
  const entries = (name, count) => Array.from({ length: count }, (_, number) => ({ key: `${name}-${number}`, role: 'user', text: `juniper ${name} ${number}`, clipped: false }))
  await index.store.write(file('a'), { sessionId: 'a', cwd: project }, entries('a', RANK_WINDOW + 3), 1)
  await index.store.write(file('b'), { sessionId: 'b', cwd: project }, entries('b', 1), 1)
  await index.store.write(file('c'), { sessionId: 'c', cwd: project }, entries('c', 1), 1)
  const seen = []
  let position
  do {
    const page = await index.store.search('claude', project, ['juniper'], position)
    seen.push(...page.hits.map(hit => hit.session.sessionId))
    position = page.next
  } while (position)
  assert.deepEqual(seen.sort(), ['a', 'b', 'c'])
})

test('a later page shows each session one time also after new entries of the searched directory', async t => {
  const directories = await fixture(t)
  const { project } = directories
  const { index } = await service(t, directories, fakeState({ workspaces: [project] }))
  await index.apply(ON)
  await index.idle()
  const store = index.store
  const file = (name, mtimeMs = NOW) => ({ path: join(project, `${name}.jsonl`), agent: 'claude', size: 1, mtimeMs, ino: name })
  const names = Array.from({ length: 12 }, (_, number) => `s${number}`)
  for (const [number, name] of names.entries())
    await store.write(file(name, NOW - number * 1000), { sessionId: name, cwd: project }, [{ key: name, role: 'user', text: `juniper ${name}`, clipped: false }], 1)

  const first = await store.search('claude', project, ['juniper'])
  assert.equal(first.hits.length, 10)
  // The session of the agent that searches gets new entries with the query between two pages.
  await store.write(file('x'), { sessionId: 'x', cwd: project }, [{ key: 'x1', role: 'user', text: 'juniper juniper juniper', clipped: false }], 1)
  await store.write(file(first.hits[0].session.sessionId), { sessionId: first.hits[0].session.sessionId, cwd: project },
    [{ key: 'again', role: 'user', text: 'juniper juniper juniper juniper', clipped: false }], 1)
  const second = await store.search('claude', project, ['juniper'], first.next)
  const seen = [...first.hits, ...second.hits].map(hit => hit.session.sessionId)
  assert.deepEqual([...seen].sort(), [...names].sort(), 'Each session of the first page is on one page, and the new session waits for a new search')
  assert.equal(second.next, undefined)

  const listed = (await store.list('claude', project))
  const page = listed.sessions.map(session => session.sessionId)
  const others = [...names, 'x'].filter(name => !page.includes(name))
  assert.equal(others.length, 3)
  // The oldest session becomes the last active one between two pages.
  await store.write(file(others[2], NOW + 1000), { sessionId: others[2], cwd: project }, [{ key: 'active', role: 'user', text: 'active', clipped: false }], 1)
  const rest = await store.list('claude', project, listed.next)
  assert.deepEqual(rest.sessions.map(session => session.sessionId), others.slice(0, 2), 'No session of the first page comes again')
})

test('the child MCP tools accept pi and say that the index is off', async t => {
  const directories = await fixture(t)
  const { project } = directories
  const state = fakeState({ workspaces: [project] })
  const { index } = await service(t, directories, state)
  const server = new DaemonServer({ sessions: new SessionHistoryService(state, { claude: liveSource(project) }, index) })
  await server.listen()
  const config = server.historyConfiguration()
  const client = new Client({ name: 'child-test', version: '1' })
  t.after(async () => { await client.close(); await server.close() })
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), {
    requestInit: { headers: Object.fromEntries(config.headers.map(header => [header.name, header.value])) },
  }))
  const off = await client.callTool({ name: 'sessions', arguments: { cwd: project, agent: 'pi', query: 'pine' } })
  assert.equal(off.isError, true)
  assert.match(off.content[0].text, /index of past sessions is off/)
  const read = await client.callTool({ name: 'session_history', arguments: { cwd: project, agent: 'pi', sessionId: 'x' } })
  assert.equal(read.isError, true)
})

test('each source parses a line into the session data and one entry with its key, role, time and tool kind', () => {
  const [claude, codex, pi] = sessionSources({ home: '/home/user', environment: {} })
  assert.deepEqual([claude.root, codex.root, pi.root], ['/home/user/.claude/projects', '/home/user/.codex/sessions', '/home/user/.pi/agent/sessions'])
  assert.equal(sessionSources({ home: '/h', environment: { PI_CODING_AGENT_SESSION_DIR: '/pi', CODEX_HOME: '/cx' } })[2].root, '/pi')
  const parse = (source, value, path = '/p/s1.jsonl') => source.parse(value, JSON.stringify(value), path)
  const time = '2026-11-10T10:00:00.000Z'
  assert.deepEqual(parse(claude, { type: 'assistant', uuid: 'u', cwd: '/w', timestamp: time,
    message: { content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'tool_use', name: 'Read', input: { file: 'a' } }] } }),
  { meta: { sessionId: 's1', cwd: '/w' }, entry: { key: 'u', role: 'assistant', tool: 'call', timestamp: Date.parse(time), text: 'Read {"file":"a"}' }, step: 'call' })
  assert.equal(parse(claude, { type: 'user', uuid: 'v', message: { content: [{ type: 'tool_result', content: [{ type: 'text', text: 'out' }] }] } }).entry.tool, 'result')
  assert.equal(parse(claude, { type: 'user', uuid: 'w', isSidechain: true, message: { content: 'side' } }).entry, undefined)
  assert.deepEqual(parse(claude, { type: 'ai-title', aiTitle: 'Named' }).meta, { sessionId: 's1', title: 'Named', titleRank: 2 })
  assert.deepEqual(parse(codex, { type: 'session_meta', timestamp: time, payload: { id: 'c1', cwd: '/w', timestamp: time } }).meta,
    { sessionId: 'c1', cwd: '/w', startedAt: Date.parse(time) })
  assert.deepEqual(parse(codex, { type: 'response_item', timestamp: time, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /w' }] } }), {})
  assert.deepEqual(parse(codex, { type: 'response_item', timestamp: time, payload: { type: 'function_call_output', call_id: 'k', output: 'done' } }).entry,
    { key: 'k:output', role: 'tool', tool: 'result', timestamp: Date.parse(time), text: 'done' })
  assert.deepEqual(parse(pi, { type: 'session', id: 'p1', cwd: '/w', timestamp: time }).meta, { sessionId: 'p1', cwd: '/w', startedAt: Date.parse(time) })
  assert.deepEqual(parse(pi, { type: 'message', id: 'ab12', timestamp: time, message: { role: 'user', content: 'hello' } }).entry,
    { key: `ab12:${time}`, role: 'user', timestamp: Date.parse(time), text: 'hello' })
  assert.equal(claude.relevant('-w/s1.jsonl', [{ cwd: '/w' }]), true)
  assert.equal(claude.relevant('-x/s1.jsonl', [{ cwd: '/w' }]), false)
  assert.equal(claude.relevant('-w/s1/subagents/a.jsonl', [{ cwd: '/w' }]), false)
  assert.equal(pi.relevant('--w-sub--/a.jsonl', [{ cwd: '/w' }]), true)
  assert.equal(codex.relevant('2026/11/10/rollout-x.jsonl'), true)
})

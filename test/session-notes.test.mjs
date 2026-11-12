// The notes about the agent sessions that wait for the user: the setting and its consent, one note for each session and
// state, the restart, several sessions in one note, the working day, the children of Megachat, the delivery without a
// model request, the client and the replay, and a state that a daemon of v0.3.0 opens again. The rows of the sessions
// come from a fake view of agents_running with invented titles and paths.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { isNoteMessage, NOTE_CHECK_MS, NOTE_KIND, NOTE_LINES, noteText, PERMISSION_NOTE_MS, planNotes } from '../src/SessionNotes.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { fakeClock } from './fake-clock.mjs'

const run = promisify(execFile)
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url))
const MINUTE = 60000
const HOUR = 60 * MINUTE
const NOON = '2026-11-11T12:00:00Z'
const terminal = { kind: 'terminal', name: 'Terminal', pid: 2 }
const megachat = { kind: 'megachat', name: 'Megachat', pid: 900 }

/** A row of the view of agents_running. The titles and the paths are invented. */
const row = (pid, status, since, { agent = 'claude', cwd = '/work/demo-app', title = 'Fix the parser', parent = terminal } = {}) =>
  ({ pid, slot: 0, agent, startedAt: Date.parse(NOON) - 2 * HOUR + pid * 1000, parent, cwd, sessionId: `session-${pid}`, title, status,
    statusSince: since, lastActivityAt: since, state: 'idle' })

/** A fake view of agents_running: the test changes its rows. It counts the reads. */
function fakeView(rows = []) {
  const view = { rows, logs: true, reads: 0, read: async () => { view.reads++; return { scannedAt: 0, rows: view.rows, incomplete: [], logs: view.logs } } }
  return view
}

/**
 * A service with a faux model, a fake clock, a fake view and an optional `settings.json`. With [storagePath], the state is
 * a file, so a later service opens it again after a restart.
 */
async function open(t, { storagePath, settings, clock = fakeClock(NOON), view = fakeView(), directory } = {}) {
  const root = directory ?? await realpath(await mkdtemp(join(tmpdir(), 'megachat-notes-')))
  if (!directory) t.after(() => rm(root, { force: true, recursive: true }))
  const settingsPath = join(root, 'settings.json')
  if (settings) await writeFile(settingsPath, JSON.stringify({ schema: 1, onboarding: 'done', values: settings }), { mode: 0o600 })
  const fake = fauxProvider()
  const requests = []
  const answer = text => context => { requests.push(context.messages); return fauxAssistantMessage(text) }
  fake.setResponses(Array.from({ length: 20 }, (_, index) => answer(`Answer ${index + 1}.`)))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const storage = storagePath ? await openNodeSqliteStorage(storagePath) : new MemoryStorage()
  const service = await PiMegachatService.open(storage, models, { provider: model.provider, modelId: model.id }, {},
    { settingsPath, keepAlive: { enabled: false }, environment: {}, morningReport: { clock }, notes: { view: view.read } })
  await service.resume()
  let closed = false
  const close = async () => { if (!closed) { closed = true; await service.close() } }
  t.after(close)
  const tool = async args => JSON.parse((await service.extension().tools.find(item => item.name === 'agents_settings').execute(args)).output[0].text)
  // Each timer of the clock runs, and the check that it starts ends before the next timer.
  const advance = ms => clock.advance(ms, () => service.sessionNotes.running)
  const notes = async () => (await service.root.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)).items
    .filter(entry => entry.kind === NOTE_KIND).map(entry => entry.model[0].content[0].text)
  return { service, tool, advance, notes, clock, view, root, settingsPath, fake, requests, answer, close }
}

const ON = { 'sessions.index': 'on', 'sessions.notes': 'on' }
/** Waits until [find] gives a value, at most 5 seconds. */
async function until(find) {
  for (const end = Date.now() + 5000; Date.now() < end; await new Promise(resolve => setTimeout(resolve, 20))) {
    const found = find()
    if (found) return found
  }
  assert.fail('The value did not come in 5 seconds')
}
const lineOf = (status, agent, project, title, time) => message(`notes.line.${status}`, agent, project, title, time)

test('a session gets a note for a long wait for a permission or for a stuck step, one time for each state', () => {
  const now = Date.parse(NOON)
  const rows = [
    row(10, 'waiting_for_permission', now - 6 * MINUTE),
    row(11, 'waiting_for_permission', now - PERMISSION_NOTE_MS + 1000),
    row(12, 'stuck', now - 25 * MINUTE, { agent: 'codex', cwd: '/work/demo-tool', title: 'Add a `test` [now]' }),
    // A child of Megachat shows its permission request in the chat. Its stuck step gets a note.
    row(13, 'waiting_for_permission', now - HOUR, { parent: megachat }),
    row(14, 'stuck', now - 15 * MINUTE, { parent: megachat, title: '' }),
    row(15, 'waiting_for_user', now - HOUR), row(16, 'idle', now - 2 * HOUR), row(17, 'working', null), row(18, null, null),
  ]
  const plan = planNotes({}, rows, now)
  assert.deepEqual(plan.due.map(item => item.row.pid), [10, 12, 14])
  assert.deepEqual(plan.changes, {})
  assert.equal(noteText(plan.due, now), [message('notes.title.many', 3),
    lineOf('waiting_for_permission', 'Claude Code', 'demo-app', '"Fix the parser"', message('notes.minutes', 6)),
    lineOf('stuck', 'Codex', 'demo-tool', `"Add a test now"`, message('notes.minutes', 25)),
    lineOf('stuck', message('notes.child', 'Claude Code'), 'demo-app', message('notes.untitled'), message('notes.minutes', 15)),
    message('notes.end')].join('\n'))
  // The records after the note: no second note in the same state.
  const records = Object.fromEntries(plan.due.map(({ key, row }) => [key, { status: row.status, since: row.statusSince, left: false, notedAt: now }]))
  assert.deepEqual(planNotes(records, rows, now + 10 * MINUTE).due.map(item => item.row.pid), [11])
  // A reading that comes and goes gives no second note: the session reads as working one time, then waits with the same start.
  const away = planNotes(records, [row(10, 'working', null)], now + MINUTE)
  assert.deepEqual(away.due, [])
  const [key] = Object.keys(away.changes)
  assert.equal(away.changes[key].left, true)
  const back = planNotes({ ...records, ...away.changes }, [rows[0]], now + 2 * MINUTE)
  assert.deepEqual([back.due, back.changes[key].left], [[], false])
  // A new wait after the end of the first one gives a new note after 5 minutes.
  const again = row(10, 'waiting_for_permission', now + MINUTE)
  assert.deepEqual(planNotes({ ...records, ...away.changes }, [again], now + 3 * MINUTE).due, [])
  assert.equal(planNotes({ ...records, ...away.changes }, [again], now + 6 * MINUTE).due.length, 1)
  // A new start time without a seen end, as after a restart, gives no second note.
  assert.deepEqual(planNotes(records, [again], now + 6 * MINUTE).due, [])
  // A stuck session that becomes a wait for a permission is in another state.
  assert.equal(planNotes(records, [row(12, 'waiting_for_permission', now - 6 * MINUTE, { agent: 'codex', cwd: '/work/demo-tool', title: 'Add a `test` [now]' })], now).due.length, 1)
  // One note has at most NOTE_LINES lines of sessions, and a line with the count of the others.
  const many = Array.from({ length: NOTE_LINES + 2 }, (_, index) => ({ row: row(100 + index, 'stuck', now - HOUR) }))
  const lines = noteText(many, now).split('\n')
  assert.equal(lines.length, NOTE_LINES + 3)
  assert.equal(lines.at(-2), message('notes.more', 2))
  assert.match(lines[1], /about 1 h|60 min/)
})

test('the notes are off by default: no read of a session, no timer and no note', async t => {
  const view = fakeView([row(10, 'waiting_for_permission', Date.parse(NOON) - HOUR)])
  const { service, tool, advance, notes } = await open(t, { view })
  await advance(10 * NOTE_CHECK_MS)
  assert.equal(view.reads, 0)
  assert.equal(service.sessionNotes.timer, undefined)
  assert.equal(service.settings.values()['sessions.notes'], 'off')
  assert.deepEqual((await tool({ action: 'get' })).sessionNotes, { on: false })
  assert.deepEqual(await notes(), [])
  assert.equal((await service.state.snapshot()).sessionNotes, undefined)
  // The rules of the main agent say what a note is, and that the notes are off.
  const rules = (await service.root.agent(BACKGROUND_CONTEXT)).sections.find(item => item.key === 'settings').render()
  assert.ok(rules.includes(message('instructions.notes', 'off')))
})

test('the notes need the consent sessions.index, and the change of each setting applies at once', async t => {
  const view = fakeView([row(10, 'waiting_for_permission', Date.parse(NOON) - HOUR)])
  const { service, tool, advance, notes } = await open(t, { view, settings: { 'sessions.notes': 'on' } })
  await advance(3 * NOTE_CHECK_MS)
  assert.equal(view.reads, 0)
  assert.deepEqual((await tool({ action: 'get' })).sessionNotes, { on: false, note: message('settings.notes.consent') })
  const set = await tool({ action: 'set', key: 'sessions.notes', value: 'on' })
  assert.deepEqual(set.sessionNotes, { on: false, note: message('settings.notes.consent') })
  assert.ok(message('setting.sessions.notes').includes('sessions.index'))
  // The setup asks for the notes only after the consent.
  const setup = await readFile(new URL('../resources/instructions-onboarding.md', import.meta.url), 'utf8')
  assert.match(setup, /Set sessions\.index to on only when the user agrees\. Only then, ask [^\n]*sessions\.notes \(default off\)/)
  // The consent gives the first check at once.
  assert.deepEqual((await tool({ action: 'set', key: 'sessions.index', value: 'on' })).sessionNotes, { on: true })
  await service.sessionNotes.running
  assert.equal(view.reads, 1)
  assert.equal((await notes()).length, 1)
  // Off stops the checks.
  await tool({ action: 'set', key: 'sessions.notes', value: 'off' })
  await advance(5 * NOTE_CHECK_MS)
  assert.equal(view.reads, 1)
  assert.equal(service.sessionNotes.timer, undefined)
})

test('several sessions give one note, each session and state gives one note, and a restart gives no second note', async t => {
  const now = Date.parse(NOON)
  const view = fakeView([
    row(10, 'waiting_for_permission', now - 6 * MINUTE, { title: 'Fix the parser' }),
    row(11, 'stuck', now - 40 * MINUTE, { agent: 'pi', cwd: '/work/demo-notes', title: 'Read the notes' }),
    row(12, 'waiting_for_permission', now - 3 * MINUTE, { agent: 'claude', cwd: '/work/demo-tool', title: 'Add a test' }),
    row(13, 'waiting_for_permission', now - HOUR, { parent: megachat, title: 'A child task' }),
    row(14, 'waiting_for_user', now - HOUR),
  ])
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-notes-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const storagePath = join(directory, 'conversation.sqlite')
  const first = await open(t, { storagePath, view, settings: ON })
  await waitForState(first.service.state, state => state.sessionNotes ? true : undefined)
  let texts = await first.notes()
  assert.equal(texts.length, 1)
  assert.equal(texts[0], [message('notes.title.many', 2),
    lineOf('waiting_for_permission', 'Claude Code', 'demo-app', '"Fix the parser"', message('notes.minutes', 6)),
    lineOf('stuck', 'pi', 'demo-notes', '"Read the notes"', message('notes.minutes', 40)), message('notes.end')].join('\n'))
  // The third session waits for 5 minutes after 2 more minutes. The other sessions get no second note.
  await first.advance(2 * MINUTE)
  texts = await first.notes()
  assert.equal(texts.length, 2)
  assert.equal(texts[1].split('\n')[0], message('notes.title.one'))
  assert.ok(texts[1].includes('"Add a test"'))
  await first.advance(20 * MINUTE)
  assert.equal((await first.notes()).length, 2)
  // The state keeps the records without a title, a path or a session ID.
  const records = JSON.stringify((await first.service.state.snapshot()).sessionNotes)
  for (const secret of ['Fix the parser', 'demo-app', 'session-10', '/work']) assert.ok(!records.includes(secret), secret)
  // A note is no turn: the state has no input, and the model got no request.
  assert.deepEqual(Object.keys((await first.service.state.snapshot()).inputs), [])
  assert.equal(first.requests.length, 0)
  await first.close()
  // A restart of the daemon on the same state gives no second note for a session that still waits.
  const second = await open(t, { storagePath, view, settings: ON, clock: fakeClock(new Date(now + 30 * MINUTE).toISOString()) })
  await second.service.sessionNotes.running
  await second.advance(5 * MINUTE)
  assert.equal((await second.notes()).length, 2)
  // The first session answers its permission prompt and waits again: a new note after 5 minutes.
  const at = second.clock.now()
  view.rows = [row(10, 'working', null), ...view.rows.slice(1)]
  await second.advance(MINUTE)
  view.rows = [row(10, 'waiting_for_permission', at + MINUTE), ...view.rows.slice(1)]
  await second.advance(4 * MINUTE)
  assert.equal((await second.notes()).length, 2)
  await second.advance(2 * MINUTE)
  texts = await second.notes()
  assert.equal(texts.length, 3)
  assert.ok(texts[2].startsWith(message('notes.title.one')) && texts[2].includes('"Fix the parser"'))
})

test('a note waits for the end of a turn, lands after the reply, and the main agent sees it in its next request', async t => {
  const now = Date.parse(NOON)
  const view = fakeView([])
  const { service, advance, notes, fake, requests, answer } = await open(t, { view, settings: ON })
  const hold = Promise.withResolvers()
  t.after(() => hold.resolve())
  fake.setResponses([async context => { await hold.promise; return answer('Held answer.')(context) }, answer('Next answer.'), answer('Ping.')])
  await service.submit('held', 'Work')
  await waitForState(service.state, state => state.current ? true : undefined)
  view.rows = [row(10, 'stuck', now - 20 * MINUTE)]
  await advance(2 * NOTE_CHECK_MS)
  assert.deepEqual(await notes(), [])
  hold.resolve()
  await waitForState(service.state, state => state.current === null ? true : undefined)
  await waitForState(service.state, state => Object.keys(state.sessionNotes?.records ?? {}).length ? true : undefined)
  const entries = (await service.root.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)).items
  const reply = entries.findIndex(entry => entry.model?.some(model => model.role === 'assistant' && model.content.some(block => block.text === 'Held answer.')))
  const note = entries.findIndex(entry => entry.kind === NOTE_KIND)
  assert.ok(reply >= 0 && note > reply, 'The note follows the reply of the turn')
  assert.equal((await notes()).length, 1)
  // The next turn of the user sends the note to the model as a message of the assistant.
  await service.submit('next', 'What now?')
  await waitForState(service.state, state => state.inputs.next?.status === 'completed' ? true : undefined)
  const sent = requests.at(-1)
  const index = sent.findIndex(model => model.role === 'assistant' && model.content.some(block => block.text?.startsWith('Megachat note:')))
  assert.ok(index > 0 && sent[index + 1].role === 'user')
  // A keep-alive request holds the note as a turn sends it, and the note does not stand for the last model request.
  view.rows = [row(11, 'stuck', now - 20 * MINUTE)]
  await service.sessionNotes.check()
  assert.equal((await notes()).length, 2)
  await service.ping()
  assert.ok(isNoteMessage(requests.at(-1).at(-1)))
  const { messages } = await service.root.context(BACKGROUND_CONTEXT)
  assert.ok(isNoteMessage(messages.at(-1)))
  assert.equal(await service.lastMessageTime(), messages.findLast(model => !isNoteMessage(model)).timestamp)
})

test('no note goes out while the conversation sleeps; a session that still waits gets it at the start of the working day', async t => {
  const workday = { 'workday.enabled': true, 'workday.timezone': 'UTC', 'workday.start': '09:00', 'workday.end': '19:00', 'workday.idleMinutes': 30 }
  const night = Date.parse('2026-11-11T22:00:00Z')
  const view = fakeView([
    row(10, 'waiting_for_permission', night - 10 * MINUTE),
    row(11, 'stuck', night - 20 * MINUTE, { cwd: '/work/demo-tool', title: 'Build the docs' }),
  ])
  const { service, advance, notes, clock } = await open(t, { view, clock: fakeClock('2026-11-11T22:00:00Z'), settings: { ...ON, ...workday } })
  await service.sessionNotes.running
  assert.equal(service.resultsWait(), true)
  await advance(HOUR)
  assert.ok(view.reads > 1)
  assert.deepEqual(await notes(), [])
  // The second session ends its step at night. The first one still waits in the morning.
  view.rows = [view.rows[0], row(11, 'working', null, { cwd: '/work/demo-tool', title: 'Build the docs' })]
  await advance(Date.parse('2026-11-12T09:00:00Z') - clock.now() - MINUTE)
  assert.deepEqual(await notes(), [])
  await advance(2 * MINUTE)
  const texts = await notes()
  assert.equal(texts.length, 1)
  assert.equal(texts[0].split('\n')[0], message('notes.title.one'))
  assert.ok(texts[0].includes('"Fix the parser"') && !texts[0].includes('Build the docs'))
  // The note starts no turn, so the conversation stays idle, and no keep-alive window opens.
  const state = await service.state.snapshot()
  assert.deepEqual([state.current, Object.keys(state.inputs)], [null, []])
  assert.equal(service.userIdleSince, undefined)
})

test('a note reaches an open view at once and the replay of a new view, as a message of its own', { timeout: 10000 }, async t => {
  const view = fakeView([])
  const { service, notes } = await open(t, { view, settings: ON })
  const server = new DaemonServer(service)
  t.after(() => server.close())
  const daemon = new DaemonClient(await server.listen())
  const attach = async () => {
    const updates = []
    const connection = client({ name: 'test-air' }).onNotification('*', ({ params }) => { updates.push(params) }).connect(new AcpBridge(daemon).app())
    t.after(() => connection.close())
    await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd: REPOSITORY, mcpServers: [] })
    return { updates, sessionId }
  }
  const viewer = await attach()
  view.rows = [row(10, 'waiting_for_permission', Date.parse(NOON) - 10 * MINUTE)]
  await service.sessionNotes.check()
  const [text] = await notes()
  const chunk = event => event.update.sessionUpdate === 'agent_message_chunk' && event.update.content.text === text
  const live = await until(() => viewer.updates.find(chunk))
  assert.match(live.update.messageId, /^megachat-entry-\d+$/)
  assert.equal(live._meta?.loadSessionReplayIndex, undefined)
  const replayed = await attach()
  const shown = replayed.updates.find(chunk)
  assert.ok(shown)
  assert.equal(typeof shown._meta.loadSessionReplayIndex, 'number')
  assert.equal(shown.update.messageId, live.update.messageId)
})

test('a daemon of v0.3.0 opens a state with a note and its records, and this build then sends no second note', { timeout: 30000 }, async t => {
  const tag = await run('git', ['rev-parse', '--verify', '--quiet', 'v0.3.0^{commit}'], { cwd: REPOSITORY }).catch(() => undefined)
  if (!tag) { t.skip('The checkout has no tag v0.3.0.'); return }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-notes-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const old = join(directory, 'v0.3.0')
  await mkdir(old)
  await run('sh', ['-c', 'git archive v0.3.0 | tar -x -C "$1"', 'sh', old], { cwd: REPOSITORY })
  await symlink(join(REPOSITORY, 'node_modules'), join(old, 'node_modules'))
  const storagePath = join(directory, 'conversation.sqlite')
  const view = fakeView([row(10, 'waiting_for_permission', Date.parse(NOON) - 10 * MINUTE)])
  const first = await open(t, { storagePath, view, settings: ON, directory })
  await waitForState(first.service.state, state => state.sessionNotes ? true : undefined)
  const [text] = await first.notes()
  const records = (await first.service.state.snapshot()).sessionNotes
  await first.close()
  // The service of v0.3.0 opens the state, shows the note in its view, sends it to the model in a turn, and keeps the
  // records and the key of the setting.
  const { PiMegachatService: OldService } = await import(pathToFileURL(join(old, 'src', 'PiMegachatService.mjs')).href)
  const lines = []
  t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true })
  const fake = fauxProvider()
  const sent = []
  fake.setResponses([context => { sent.push(context.messages); return fauxAssistantMessage('Old answer.') }])
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await OldService.open(await openNodeSqliteStorage(storagePath), models, { provider: model.provider, modelId: model.id }, {},
    { settingsPath: join(directory, 'settings.json'), keepAlive: { enabled: false }, environment: {} })
  try {
    await service.resume()
    const shown = (await service.view()).entries.filter(entry => entry.kind === NOTE_KIND)
    assert.equal(shown[0].model[0].content[0].text, text)
    await service.submit('old-turn', 'Hello')
    await waitForState(service.state, state => state.inputs['old-turn']?.status === 'completed' ? true : undefined)
    assert.ok(sent[0].some(item => item.role === 'assistant' && item.content[0]?.text === text))
    const tool = service.extension().tools.find(item => item.name === 'agents_settings')
    await tool.execute({ action: 'set', key: 'reply.length', value: 'normal' })
    assert.deepEqual((await service.state.snapshot()).sessionNotes, records)
  }
  finally { await service.close() }
  t.mock.restoreAll()
  assert.ok(!lines.some(line => /cannot read settings\.json|failed|could not/i.test(line)), lines.join(''))
  assert.equal(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).values['sessions.notes'], 'on')
  // This build opens the state again and sends no second note for the same wait.
  const again = await open(t, { storagePath, view, settings: undefined, directory, clock: fakeClock('2026-11-11T12:30:00Z') })
  await again.service.sessionNotes.running
  await again.advance(3 * NOTE_CHECK_MS)
  assert.equal(again.service.settings.values()['sessions.notes'], 'on')
  assert.deepEqual(await again.notes(), [text])
})

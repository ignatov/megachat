// The cloud sessions of the Central login through the plugin airc of JetBrains Central: the detection of airc, the read
// of the list, the plan and the text of a cloud note, the limits of the records, the timer of the reads, the tool
// agents_cloud, the rules, and the delivery of a note through the service. A fake central and a fake airc are shell
// scripts in a temporary directory. The names, the IDs and the repositories of the sessions are invented.
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { CLOUD_CHECK_MS, CLOUD_NOTE_LINES, CLOUD_RECORD_MS, CLOUD_RECORDS, CLOUD_RENEW_MS, cloudKey, cloudNoteText, locateAirc,
  planCloudNotes, pruneCloudRecords, readCloudSessions } from '../src/CloudSessions.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { NOTE_KIND } from '../src/SessionNotes.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { fakeClock } from './fake-clock.mjs'

const MINUTE = 60000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const NOON = '2026-11-11T12:00:00Z'
const at = offset => new Date(Date.parse(NOON) + offset).toISOString()

/** A cloud session in the output of airc. */
const session = (id, status, updatedAt, { name = 'Fix the parser', agent = 'claude', organization = 'demo', repository = 'demo-app',
  resultsBranch, statusComment } = {}) => ({ id, name, status, ...(statusComment ? { statusComment } : {}), agent,
  repositories: [{ host: 'github.com', organization, repository, branch: 'main', ...(resultsBranch ? { resultsBranch } : {}) }],
  updatedAt, taskId: `task-${id}` })

async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-cloud-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return directory
}

/** A shell script [name] in [directory] that runs [body]. */
async function script(directory, name, body) {
  const path = join(directory, name)
  await writeFile(path, `#!/bin/sh\n${body}\n`)
  await chmod(path, 0o700)
  return path
}

/** A fake central whose `plugins` prints [lines], and a plugin directory with a manifest and a binary. */
async function fakeCentral(directory, { state = 'active', line = true, executable = './airc', binary = true } = {}) {
  const plugin = join(directory, 'plugins', 'airc')
  await mkdir(plugin, { recursive: true })
  await writeFile(join(plugin, 'manifest.json'), JSON.stringify({ id: 'airc', executable }))
  if (binary) await script(plugin, 'airc', 'exit 0')
  const output = join(directory, 'plugins.txt')
  await writeFile(output, [
    ['agentctl', '0.2.0', 'active', 'present=true', 'origin=bundled', `source=${join(directory, 'plugins', 'agentctl')}`, 'hooks='].join('\t'),
    ...(line ? [['airc', '0.1.3', state, 'present=true', 'origin=bundled', `source=${plugin}`, 'hooks=plugin-loaded'].join('\t')] : []),
  ].join('\n') + '\n')
  const central = await script(directory, 'central', `echo "$@" >> '${join(directory, 'central.args')}'\nexec cat '${output}'`)
  return { central, plugin }
}

/** A fake airc that prints the file `list.json` and writes its arguments to `airc.args`. */
async function fakeAirc(directory, list, { code = 0, stderr = '' } = {}) {
  await writeFile(join(directory, 'list.json'), typeof list === 'string' ? list : JSON.stringify(list))
  return script(directory, 'airc', `echo "$@" > '${join(directory, 'airc.args')}'\n${stderr ? `echo '${stderr}' >&2\n` : ''}cat '${join(directory, 'list.json')}'\nexit ${code}`)
}

test('Megachat finds airc in the source directory of the active plugin, and finds no airc for another state', async t => {
  const directory = await temporary(t)
  const { central, plugin } = await fakeCentral(directory)
  assert.deepEqual(await locateAirc({ central }), { path: join(plugin, 'airc') })
  assert.equal(await readFile(join(directory, 'central.args'), 'utf8'), 'plugins\n')
  for (const [options, reason] of [[{ state: 'disabled' }, 'plugin'], [{ line: false }, 'plugin'], [{ binary: false }, 'executable'],
    [{ executable: '../../central' }, 'executable']]) {
    const other = await temporary(t)
    assert.deepEqual(await locateAirc({ central: (await fakeCentral(other, options)).central }), { reason }, JSON.stringify(options))
  }
  assert.deepEqual(await locateAirc({ central: join(directory, 'missing') }), { reason: 'central' })
  assert.deepEqual(await locateAirc({}), { reason: 'central' })
})

test('a read runs airc sessions --limit 50 and gives the fields of airc', async t => {
  const directory = await temporary(t)
  const list = [
    session('cloud-1', 'RUNNING', at(-HOUR)),
    { ...session('cloud-2', 'FINISHED', at(-2 * HOUR), { resultsBranch: 'fix-parser' }), estimatedCredits: 12 },
    session('cloud-3', 'ERROR', at(-3 * HOUR), { statusComment: 'The container stopped.' }),
  ]
  const airc = await fakeAirc(directory, list)
  const sessions = await readCloudSessions(airc, { env: { PATH: '/usr/bin:/bin' } })
  assert.equal(await readFile(join(directory, 'airc.args'), 'utf8'), 'sessions --limit 50\n')
  assert.deepEqual(sessions, list.map(({ estimatedCredits, ...rest }) => rest))
})

test('a read fails for an exit code, for an output without a list and after its time limit, and the next read tries again', async t => {
  const directory = await temporary(t)
  const failing = await fakeAirc(directory, '', { code: 1, stderr: 'no credential' })
  await assert.rejects(readCloudSessions(failing), error => error.code === 'cloudExit' && error.message === message('error.cloudExit', 1, 'no credential')
    && error.cloudReason === 'exit' && error.exitCode === 1)
  await assert.rejects(readCloudSessions(await fakeAirc(directory, '', { code: 3 })), { code: 'cloudExitSilent', exitCode: 3 })
  const long = 'x'.repeat(300)
  await assert.rejects(readCloudSessions(await fakeAirc(directory, '', { code: 2, stderr: long })),
    error => error.message === message('error.cloudExit', 2, 'x'.repeat(200)))
  for (const output of ['{"error":true}', 'not json', '[{"name":"no id"}]', '[1]']) {
    await assert.rejects(readCloudSessions(await fakeAirc(directory, output)), { code: 'cloudOutput', cloudReason: 'output' }, output)
  }
  const slow = await script(directory, 'slow', 'exec sleep 5')
  await assert.rejects(readCloudSessions(slow, { timeoutMs: 200 }), { code: 'cloudTimeout', cloudReason: 'timeout' })
  // A stop of the daemon ends the read at once, and it is no failure of airc.
  const stop = new AbortController()
  const started = Date.now()
  const stopped = readCloudSessions(slow, { signal: stop.signal })
  stop.abort()
  await assert.rejects(stopped, error => error.name === 'AbortError' && error.cloudReason === undefined)
  assert.ok(Date.now() - started < 2000)
  await assert.rejects(readCloudSessions(join(directory, 'missing')), { code: 'cloudStart', cloudReason: 'start', exitCode: 'ENOENT' })
  // The same binary with a correct list reads again.
  const list = [session('cloud-1', 'RUNNING', at(0))]
  assert.deepEqual(await readCloudSessions(await fakeAirc(directory, list)), list)
})

test('the first read of a watch is a base, and a later change to a status of a note gives a note', () => {
  const since = Date.parse(NOON)
  const watch = { since, records: {} }
  const first = [session('cloud-1', 'FINISHED', at(-HOUR)), session('cloud-2', 'RUNNING', at(-10 * MINUTE))]
  const base = planCloudNotes(watch, first, since)
  assert.deepEqual(base.due, [])
  assert.deepEqual(base.changes, { [cloudKey('cloud-1')]: { status: 'FINISHED', seenAt: since },
    [cloudKey('cloud-2')]: { status: 'RUNNING', seenAt: since } })
  const records = { ...base.changes }
  const later = since + 2 * MINUTE
  const next = [
    session('cloud-1', 'FINISHED', at(-HOUR)),
    session('cloud-2', 'FINISHED', at(MINUTE)),
    session('cloud-3', 'USER_INPUT_REQUIRED', at(MINUTE)),
    session('cloud-4', 'ERROR', at(MINUTE)),
    session('cloud-5', 'SUSPENDED', at(MINUTE)),
    session('cloud-6', 'CANCELLED', at(MINUTE)),
    session('cloud-7', 'ARCHIVED', at(MINUTE)),
  ]
  const plan = planCloudNotes({ since, records }, next, later)
  assert.deepEqual(plan.due.map(item => item.session.id), ['cloud-2', 'cloud-3', 'cloud-4'])
  assert.deepEqual(Object.keys(plan.changes).sort(), ['cloud-5', 'cloud-6', 'cloud-7'].map(cloudKey).sort())
  // A watch without a start gives no note.
  assert.deepEqual(planCloudNotes({ since: null, records }, next, later).due, [])
})

test('a session gets one note for each status, and a session that runs again gets a second note', () => {
  const since = Date.parse(NOON)
  const noted = { [cloudKey('cloud-1')]: { status: 'FINISHED', seenAt: since } }
  for (const offset of [2 * MINUTE, 4 * MINUTE]) {
    const plan = planCloudNotes({ since, records: noted }, [session('cloud-1', 'FINISHED', at(MINUTE))], since + offset)
    assert.deepEqual([plan.due, plan.changes], [[], {}])
  }
  let records = { [cloudKey('cloud-2')]: { status: 'USER_INPUT_REQUIRED', seenAt: since } }
  const running = planCloudNotes({ since, records }, [session('cloud-2', 'RUNNING', at(3 * MINUTE))], since + 4 * MINUTE)
  assert.deepEqual(running.due, [])
  records = { ...records, ...running.changes }
  const finished = planCloudNotes({ since, records }, [session('cloud-2', 'FINISHED', at(5 * MINUTE))], since + 6 * MINUTE)
  assert.deepEqual(finished.due.map(item => item.session.status), ['FINISHED'])
})

test('a read renews a record after 1 day, and the records keep at most 200 sessions of the last 30 days', () => {
  const since = Date.parse(NOON)
  const records = { [cloudKey('cloud-1')]: { status: 'FINISHED', seenAt: since } }
  const listed = [session('cloud-1', 'FINISHED', at(MINUTE))]
  assert.deepEqual(planCloudNotes({ since, records }, listed, since + CLOUD_RENEW_MS - 1).changes, {})
  assert.deepEqual(planCloudNotes({ since, records }, listed, since + CLOUD_RENEW_MS).changes,
    { [cloudKey('cloud-1')]: { status: 'FINISHED', seenAt: since + CLOUD_RENEW_MS } })
  const now = since + 40 * DAY
  const many = {}
  for (let index = 0; index < 210; index++) many[`key-${index}`] = { status: 'RUNNING', seenAt: index < 5 ? now - 31 * DAY : now - index * MINUTE }
  pruneCloudRecords(many, now)
  assert.equal(Object.keys(many).length, CLOUD_RECORDS)
  for (let index = 0; index < 5; index++) assert.equal(many[`key-${index}`], undefined)
  assert.ok(Object.values(many).every(record => now - record.seenAt < CLOUD_RECORD_MS))
  // After the 5 old records, the 5 oldest of the others go: the newest 200 stay.
  for (let index = 205; index < 210; index++) assert.equal(many[`key-${index}`], undefined)
})

test('one note gives one line for each session, with the results branch of a finished session and the comment of a failed one', () => {
  const due = [
    session('cloud-1', 'FINISHED', at(MINUTE), { resultsBranch: 'fix-parser' }),
    session('cloud-2', 'ERROR', at(MINUTE), { name: 'Add the tests', agent: 'codex', repository: 'demo-tool', statusComment: 'The container stopped.' }),
  ].map(item => ({ key: cloudKey(item.id), session: item }))
  const text = cloudNoteText(due)
  assert.equal(text, [
    'Megachat note: 2 cloud sessions changed their state.',
    '- Claude Code, "Fix the parser" in demo/demo-app: it finished. The results are in the branch fix-parser.',
    '- Codex, "Add the tests" in demo/demo-tool: it failed. The cloud says: The container stopped.',
    'Megachat reads this from airc, the list of the cloud sessions of your Central login. Open the session in Air to see its work. Megachat gives one note for each session and status.',
  ].join('\n'))
  const odd = cloudNoteText([{ session: { ...session('cloud-3', 'USER_INPUT_REQUIRED', at(0), { name: 'Line one\nline `two` [x]' }), agent: 'junie' } },
    { session: { ...session('cloud-4', 'ABORTED', at(0), { name: '' }), repositories: [] } }])
  assert.deepEqual(odd.split('\n').slice(1, 3), [
    message('cloud.note.line.USER_INPUT_REQUIRED', 'Junie', '"Line one line two x"', 'demo/demo-app'),
    message('cloud.note.line.ABORTED', 'Claude Code', message('cloud.note.untitled'), message('cloud.note.noRepository')),
  ])
  assert.equal(cloudNoteText(due.slice(0, 1)).split('\n')[0], message('cloud.note.title.one'))
  const twelve = Array.from({ length: 12 }, (_, index) => ({ session: session(`cloud-${index}`, 'FINISHED', at(MINUTE)) }))
  const lines = cloudNoteText(twelve).split('\n')
  assert.equal(lines.length, CLOUD_NOTE_LINES + 3)
  assert.equal(lines.at(-2), '- 2 more cloud sessions. Ask "what runs in the cloud?" to see each session.')
})

/** A fake airc for the service: [locate] finds the path [airc] or nothing, and [list] gives [sessions] or throws [failure]. */
function fakeCloud(sessions = [], { airc = '/fake/airc' } = {}) {
  const cloud = { sessions, airc, failure: undefined, located: 0, reads: 0, paths: [],
    locate: async () => { cloud.located++; return cloud.airc ? { path: cloud.airc } : { reason: 'plugin' } },
    list: async path => { cloud.reads++; cloud.paths.push(path); if (cloud.failure) throw cloud.failure; return structuredClone(cloud.sessions) } }
  return cloud
}

/** The lines that the daemon writes to its log while the test runs. */
function captureLog(t) {
  const lines = []
  const write = process.stderr.write
  process.stderr.write = chunk => { lines.push(String(chunk)); return true }
  t.after(() => { process.stderr.write = write })
  return lines
}

const ON = { 'cloud.sessions': 'on' }

/**
 * A service with a faux model, a fake clock, a fake airc and an optional `settings.json`. With [storagePath], the state is
 * a file, so a later service opens it again after a restart. [cloud] `list` `null` reads with the real read of airc.
 */
async function open(t, { storagePath, settings, clock = fakeClock(NOON), cloud = fakeCloud(), list = cloud.list } = {}) {
  const root = await temporary(t)
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
    { settingsPath, keepAlive: { enabled: false }, environment: {}, morningReport: { clock }, cloud: { locate: cloud.locate, list: list ?? undefined } })
  await service.resume()
  await service.cloudWatch.running
  let closed = false
  const close = async () => { if (!closed) { closed = true; await service.close() } }
  t.after(close)
  const tools = () => service.extension().tools.map(item => item.name)
  const call = async (name, args = {}) => JSON.parse((await service.extension().tools.find(item => item.name === name).execute(args)).output[0].text)
  const advance = ms => clock.advance(ms, () => service.cloudWatch.running)
  const notes = async () => (await service.root.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)).items
    .filter(entry => entry.kind === NOTE_KIND && entry.data?.type === 'cloud').map(entry => entry.model[0].content[0].text)
  const rules = async () => (await service.root.agent(BACKGROUND_CONTEXT)).sections.find(item => item.key === 'settings').render()
  return { service, tools, call, advance, notes, rules, clock, cloud, fake, requests, answer, close }
}

test('the cloud sessions are off by default: no detection of airc, no read, no tool and no timer', async t => {
  const cloud = fakeCloud([session('cloud-1', 'FINISHED', at(MINUTE))])
  const { service, tools, call, advance, notes, rules } = await open(t, { cloud })
  await advance(10 * MINUTE)
  assert.equal(service.settings.values()['cloud.sessions'], 'off')
  assert.deepEqual([cloud.located, cloud.reads], [0, 0])
  assert.ok(!tools().includes('agents_cloud'))
  assert.equal(service.cloudWatch.timer, undefined)
  assert.deepEqual((await call('agents_settings', { action: 'get' })).cloudSessions, { on: false })
  assert.deepEqual(await notes(), [])
  assert.ok(!/cloud/i.test(await rules()), 'The rules do not name the cloud sessions')
  assert.equal((await service.state.snapshot()).cloudSessions, undefined)
})

test('without airc the cloud sessions stay off with a note, and the agent turns them on when airc is there', async t => {
  const cloud = fakeCloud([], { airc: null })
  const log = captureLog(t)
  const { service, tools, call, rules } = await open(t, { cloud, settings: ON })
  assert.equal(cloud.located, 1)
  assert.deepEqual((await call('agents_settings', { action: 'get' })).cloudSessions,
    { on: false, note: 'The cloud sessions stay off: Megachat found no active plugin airc of JetBrains Central. Run central plugins in a terminal to check it.' })
  assert.ok(!tools().includes('agents_cloud'))
  assert.equal(cloud.reads, 0)
  assert.ok((await rules()).includes(message('instructions.cloud.missing')))
  assert.ok(log.some(line => line.includes(message('log.cloud.missing', 'plugin'))))
  // The plugin is there now. A set of the setting looks for it again.
  cloud.airc = '/fake/airc'
  const set = await call('agents_settings', { action: 'set', key: 'cloud.sessions', value: 'on' })
  assert.deepEqual(set.cloudSessions, { on: true })
  assert.equal(cloud.located, 2)
  assert.ok(tools().includes('agents_cloud'))
  assert.ok((await rules()).includes(message('instructions.cloud')))
  await service.cloudWatch.running
  assert.deepEqual(cloud.paths, ['/fake/airc'])
})

test('agents_cloud runs airc, keeps a status without regard to the case, gives at most limit sessions, and gives the error of airc', async t => {
  const directory = await temporary(t)
  const three = [session('cloud-1', 'RUNNING', at(-HOUR)), session('cloud-2', 'FINISHED', at(-2 * HOUR), { resultsBranch: 'fix-parser' }),
    session('cloud-3', 'ERROR', at(-3 * HOUR), { statusComment: 'The container stopped.' })]
  const airc = await fakeAirc(directory, three)
  const cloud = fakeCloud([], { airc })
  const log = captureLog(t)
  const { call } = await open(t, { cloud, settings: ON, list: null })
  await writeFile(join(directory, 'airc.args'), '')
  assert.deepEqual(await call('agents_cloud'), { sessions: three, more: false })
  assert.equal(await readFile(join(directory, 'airc.args'), 'utf8'), 'sessions --limit 50\n')
  const many = [...Array.from({ length: 25 }, (_, index) => session(`cloud-${index}`, 'RUNNING', at(-MINUTE))), session('cloud-99', 'FINISHED', at(-MINUTE))]
  await writeFile(join(directory, 'list.json'), JSON.stringify(many))
  const finished = await call('agents_cloud', { status: 'finished' })
  assert.deepEqual([finished.sessions.map(item => item.id), finished.more], [['cloud-99'], false])
  const first = await call('agents_cloud')
  assert.deepEqual([first.sessions.length, first.more], [20, true])
  assert.equal((await call('agents_cloud', { limit: 50 })).sessions.length, 26)
  await fakeAirc(directory, '', { code: 1, stderr: 'no credential' })
  await assert.rejects(call('agents_cloud'), error => error.message === message('error.cloudExit', 1, 'no credential'))
  const failed = log.filter(line => line.includes(message('log.cloud.failed', 'exit', 1)))
  assert.equal(failed.length, 1)
  assert.ok(!log.some(line => line.includes('no credential') || line.includes('Fix the parser')))
})

test('the daemon reads the list at once and every 2 minutes, reads nothing at night, and off stops the reads at once', async t => {
  const day = await open(t, { settings: ON })
  assert.equal(day.cloud.reads, 1)
  await day.advance(5 * MINUTE)
  assert.equal(day.cloud.reads, 3)
  assert.equal((await day.service.state.snapshot()).cloudSessions.since, Date.parse(NOON))
  await day.call('agents_settings', { action: 'set', key: 'cloud.sessions', value: 'off' })
  await day.advance(5 * MINUTE)
  assert.equal(day.cloud.reads, 3)
  assert.equal(day.service.cloudWatch.timer, undefined)
  assert.equal((await day.service.state.snapshot()).cloudSessions.since, null)
  assert.ok(!day.tools().includes('agents_cloud'))

  const workday = { 'workday.enabled': true, 'workday.timezone': 'UTC', 'workday.start': '09:00', 'workday.end': '19:00', 'workday.idleMinutes': 30 }
  const night = await open(t, { settings: { ...ON, ...workday }, clock: fakeClock('2026-11-11T20:00:00Z') })
  assert.equal(night.service.sleeping(), true)
  await night.advance(HOUR)
  assert.equal(night.cloud.reads, 0)
  assert.notEqual(night.service.cloudWatch.timer, undefined)
})

test('a cloud session gets one note for each status, a restart gives no second note, and the state and the log hold no name', async t => {
  const directory = await temporary(t)
  const storagePath = join(directory, 'conversation.sqlite')
  const cloud = fakeCloud([session('cloud-1', 'FINISHED', at(-HOUR)), session('cloud-7', 'RUNNING', at(-10 * MINUTE))])
  const log = captureLog(t)
  const first = await open(t, { storagePath, settings: ON, cloud })
  assert.deepEqual(await first.notes(), [])
  cloud.sessions = [session('cloud-1', 'FINISHED', at(-HOUR)), session('cloud-7', 'FINISHED', at(MINUTE), { resultsBranch: 'fix-parser' })]
  await first.advance(2 * MINUTE)
  assert.deepEqual(await first.notes(), [[message('cloud.note.title.one'),
    '- Claude Code, "Fix the parser" in demo/demo-app: it finished. The results are in the branch fix-parser.', message('cloud.note.end')].join('\n')])
  assert.deepEqual(log.filter(line => line.includes(message('log.cloud', 1))).length, 1)
  for (const secret of ['cloud-7', 'Fix the parser', 'demo-app']) {
    assert.ok(!JSON.stringify((await first.service.state.snapshot()).cloudSessions).includes(secret), secret)
    assert.ok(!log.some(line => line.includes(secret)), secret)
  }
  await first.advance(4 * MINUTE)
  assert.equal((await first.notes()).length, 1)
  // A read without a change commits nothing to the state.
  const change = first.service.state.change.bind(first.service.state)
  let commits = 0
  first.service.state.change = (...args) => { commits++; return change(...args) }
  await first.advance(2 * MINUTE)
  assert.equal(commits, 0)
  first.service.state.change = change
  // Another session finishes 2 minutes later: a second note, and the model got no request.
  cloud.sessions = [...cloud.sessions, session('cloud-8', 'ERROR', at(9 * MINUTE), { name: 'Add the tests', statusComment: 'The container stopped.' })]
  await first.advance(2 * MINUTE)
  assert.equal((await first.notes()).length, 2)
  assert.deepEqual(Object.keys((await first.service.state.snapshot()).inputs), [])
  assert.equal(first.requests.length, 0)
  await first.close()
  const second = await open(t, { storagePath, settings: ON, cloud, clock: fakeClock(at(30 * MINUTE)) })
  await second.advance(5 * MINUTE)
  assert.equal((await second.notes()).length, 2)
  assert.equal((await second.service.state.snapshot()).cloudSessions.since, Date.parse(NOON))
  // A session that finished while the daemon was down gets its note at the next read.
  await second.close()
  cloud.sessions = [...cloud.sessions, session('cloud-9', 'USER_INPUT_REQUIRED', at(40 * MINUTE), { name: 'Pick a name' })]
  const third = await open(t, { storagePath, settings: ON, cloud, clock: fakeClock(at(50 * MINUTE)) })
  const texts = await third.notes()
  assert.equal(texts.length, 3)
  assert.ok(texts[2].includes('"Pick a name"') && texts[2].includes('it waits for your input.'))
})

test('a cloud note waits for the end of a turn, and the end of the turn reads at once', async t => {
  const cloud = fakeCloud([session('cloud-1', 'RUNNING', at(-MINUTE))])
  const { service, advance, notes, fake, answer } = await open(t, { settings: ON, cloud })
  const hold = Promise.withResolvers()
  t.after(() => hold.resolve())
  fake.setResponses([async context => { await hold.promise; return answer('Held answer.')(context) }, answer('Next answer.')])
  await service.submit('held', 'Work')
  await waitForState(service.state, state => state.current ? true : undefined)
  cloud.sessions = [session('cloud-1', 'FINISHED', at(MINUTE))]
  await advance(2 * MINUTE)
  assert.deepEqual(await notes(), [])
  assert.equal(service.cloudWatch.waiting, true)
  const reads = cloud.reads
  hold.resolve()
  await waitForState(service.state, state => state.current === null ? true : undefined)
  await waitForState(service.state, state => Object.values(state.cloudSessions?.records ?? {}).some(record => record.status === 'FINISHED') ? true : undefined)
  assert.equal(cloud.reads, reads + 1)
  const entries = (await service.root.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)).items
  const reply = entries.findIndex(entry => entry.model?.some(model => model.role === 'assistant' && model.content.some(block => block.text === 'Held answer.')))
  const note = entries.findIndex(entry => entry.kind === NOTE_KIND)
  assert.ok(reply >= 0 && note > reply, 'The note follows the reply of the turn')
  assert.equal(service.cloudWatch.waiting, false)
})

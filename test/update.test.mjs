// The automatic update: the check of the release tags in a local repository, the comparison of the versions, the
// notice, the copy of npx, the conditions and the time of the stop, the stop of a real daemon from a copy of npx, the
// guard against a stop in a loop, the recorded version, and the message after an update with the notes from a local
// server. No case asks GitHub.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import {
  baseVersion, CHECK_INTERVAL_MS, CONDITION_INTERVAL_MS, fetchReleaseNotes, higherVersion, highestRelease, listRelease, NOTES_LINES,
  npxCopy, recordVersion, RETRY_INTERVAL_MS, UpdateCheck, updateNoteText, updateTime,
} from '../src/MegachatUpdate.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { NOTE_KIND } from '../src/SessionNotes.mjs'
import { WEEKDAYS } from '../src/Workday.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { fakeClock } from './fake-clock.mjs'

const run = promisify(execFile)
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url))
const MINUTE = 60000

async function temporary(t, prefix = 'megachat-update-') {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return directory
}

/** A local git repository with one commit and the tags [tags]. */
async function releaseRepository(t, tags) {
  const directory = await temporary(t, 'megachat-releases-')
  const git = (...args) => run('git', ['-C', directory, ...args], { env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  await git('init', '--quiet')
  await git('-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '--quiet', '--allow-empty', '-m', 'Release')
  for (const tag of tags) await git('tag', tag)
  return { directory, tag: name => git('tag', name) }
}

/** Collects the lines of the error output of this process while [action] runs. */
function captureErrors(t) {
  const lines = []
  const write = process.stderr.write
  process.stderr.write = function (chunk, ...rest) { lines.push(String(chunk)); return write.call(this, chunk, ...rest) }
  t.after(() => { process.stderr.write = write })
  return lines
}

/** A service with a faux model, a fake clock and an optional `settings.json`. */
async function open(t, { settings, clock = fakeClock('2026-11-11T12:00:00Z') } = {}) {
  const root = await temporary(t)
  const settingsPath = join(root, 'settings.json')
  if (settings) await writeFile(settingsPath, JSON.stringify({ schema: 1, onboarding: 'done', values: settings }), { mode: 0o600 })
  const fake = fauxProvider()
  fake.setResponses(Array.from({ length: 20 }, (_, index) => () => fauxAssistantMessage(`Answer ${index + 1}.`)))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { settingsPath, keepAlive: { enabled: false }, environment: {}, morningReport: { clock } })
  await service.resume()
  t.after(() => service.close())
  const server = new DaemonServer(service)
  t.after(() => server.close())
  const daemon = new DaemonClient(await server.listen())
  const say = async (id, text) => {
    const receipt = await service.submit(id, text)
    await daemon.json(`/wait?submission=${receipt.submissionId}`)
    await waitForState(service.state, state => state.current === null ? true : undefined)
  }
  const entries = async () => (await service.root.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)).items
  return { service, server, daemon, say, entries, clock, root }
}

const text = entry => entry.model?.map(item => typeof item.content === 'string' ? item.content
  : item.content.map(part => part.text ?? '').join('')).join('\n') ?? ''

/** An update check with a fake clock. [ready] decides the conditions. The stops go to `stops`. */
function check({ version = '0.4.0', selfUpdating = true, release, ready = async () => true, failed = async () => null, values = { 'update.auto': true }, clock = fakeClock('2026-11-11T23:00:00Z') } = {}) {
  const stops = []
  const update = new UpdateCheck({ version, selfUpdating, release, ready, failed, values: () => values, clock,
    stop: async (from, to) => { stops.push({ from, to, at: new Date(clock.now()).toISOString() }) } })
  const advance = ms => clock.advance(ms, () => update.running)
  return { update, stops, clock, advance }
}

test('the check of a local repository finds the highest release and ignores a pre-release', { timeout: 20000 }, async t => {
  const { directory } = await releaseRepository(t, ['v0.3.0', 'v0.4.0', 'v0.5.0', 'v0.6.0-rc.1', 'other'])
  assert.equal(await listRelease({ repository: directory }), '0.5.0')
  assert.equal(highestRelease('1a2b3c4d\trefs/tags/v0.10.0\n1a2b3c4d\trefs/tags/v0.9.9\n1a2b3c4d\trefs/tags/v1.0.0-rc.1\n'), '0.10.0')
  // git gets the time limits of the entry and no prompt. A variable of the test replaces the repository.
  assert.equal(await listRelease({ environment: { ...process.env, MEGACHAT_RELEASE_REPOSITORY: directory } }), '0.5.0')
})

test('a build of a checkout compares by its base version', () => {
  assert.equal(baseVersion('0.4.0+9.geb044cf'), '0.4.0')
  assert.equal(higherVersion('0.4.0', '0.4.0+9.geb044cf'), false)
  assert.equal(higherVersion('0.4.1', '0.4.0+9.geb044cf.dirty'), true)
  assert.equal(higherVersion('0.10.0', '0.9.0'), true)
})

test('a check finds a new tag 24 hours after the first check', { timeout: 20000 }, async t => {
  const repository = await releaseRepository(t, ['v0.4.0'])
  const { update, advance } = check({ release: () => listRelease({ repository: repository.directory }), selfUpdating: false })
  update.start()
  await advance(0)
  assert.equal(update.status(), undefined)
  await repository.tag('v0.5.0')
  await advance(CHECK_INTERVAL_MS - 1)
  assert.equal(update.status(), undefined)
  await advance(1)
  assert.deepEqual(update.status(), { available: '0.5.0', notice: 'A new release is available: 0.4.0 → 0.5.0' })
  update.close()
})

test('a failed check writes one line to the log and tries again after 1 hour', { timeout: 20000 }, async t => {
  const lines = captureErrors(t)
  const missing = join(await temporary(t), 'missing')
  let calls = 0
  const { update, advance } = check({ release: () => { calls++; return listRelease({ repository: missing }) } })
  update.start()
  await advance(0)
  assert.equal(calls, 1)
  assert.equal(lines.filter(line => line.includes('could not check for a new release')).length, 1)
  assert.equal(update.status(), undefined)
  await advance(RETRY_INTERVAL_MS - 1)
  assert.equal(calls, 1)
  await advance(1)
  assert.equal(calls, 2)
  update.close()
})

test('only a copy of npx without .git updates itself', async t => {
  const directory = await temporary(t)
  const copy = join(directory, '_npx', 'abc', 'node_modules', 'megachat')
  await mkdir(copy, { recursive: true })
  assert.equal(npxCopy(copy), true)
  assert.equal(npxCopy(`${copy}/`), true)
  assert.equal(npxCopy(REPOSITORY), false)
  assert.equal(npxCopy(join(directory, 'node_modules', 'megachat')), false)
  await writeFile(join(copy, '.git'), 'gitdir: elsewhere\n')
  assert.equal(npxCopy(copy), false)
})

test('a git checkout and a copy with update.auto off only give the notice', async () => {
  for (const options of [{ selfUpdating: false }, { values: { 'update.auto': false } }]) {
    const { update, stops, advance } = check({ release: async () => '0.5.0', ...options })
    update.start()
    await advance(0)
    await advance(4 * 60 * MINUTE)
    assert.deepEqual(stops, [])
    assert.equal(update.status().notice, 'A new release is available: 0.4.0 → 0.5.0')
    update.close()
  }
})

test('the night window starts at 01:00, and a stop needs 30 minutes since the last turn of the user', async () => {
  const values = { 'workday.enabled': false, 'workday.timezone': 'UTC' }
  const idle = Date.parse('2026-11-11T22:00:00Z')
  const clock = fakeClock('2026-11-11T23:00:00Z')
  const { update, stops, advance } = check({ clock, release: async () => '0.5.0', ready: async now => updateTime(values, now, idle) })
  update.start()
  await advance(110 * MINUTE)
  assert.deepEqual(stops, [])
  await advance(10 * MINUTE)
  assert.deepEqual(stops, [{ from: '0.4.0', to: '0.5.0', at: '2026-11-12T01:00:00.000Z' }])
  assert.equal(updateTime(values, Date.parse('2026-11-12T05:00:00Z'), idle), false)
  assert.equal(updateTime(values, Date.parse('2026-11-12T04:59:00Z'), Date.parse('2026-11-12T04:40:00Z')), false)
})

test('with the working day, the stop comes when the conversation sleeps', async () => {
  const values = { 'workday.enabled': true, 'workday.start': '09:00', 'workday.end': '19:00', 'workday.days': WEEKDAYS.slice(0, 5),
    'workday.timezone': 'UTC', 'workday.idleMinutes': 30 }
  const idle = Date.parse('2026-11-11T19:10:00Z')
  const clock = fakeClock('2026-11-11T19:00:00Z')
  const { update, stops, advance } = check({ clock, release: async () => '0.5.0', ready: async now => updateTime(values, now, idle) })
  update.start()
  await advance(30 * MINUTE)
  assert.deepEqual(stops, [])
  await advance(10 * MINUTE)
  assert.deepEqual(stops.map(stop => stop.at), ['2026-11-11T19:40:00.000Z'])
})

test('a turn at night delays the stop until 30 minutes after its end', async () => {
  const values = { 'workday.enabled': false, 'workday.timezone': 'UTC' }
  let turn = true
  let idle = Date.parse('2026-11-11T20:00:00Z')
  const clock = fakeClock('2026-11-12T01:00:00Z')
  const { update, stops, advance } = check({ clock, release: async () => '0.5.0', ready: async now => !turn && updateTime(values, now, idle) })
  update.start()
  await advance(0)
  await advance(5 * MINUTE)
  turn = false
  idle = clock.now()
  await advance(30 * MINUTE)
  assert.deepEqual(stops, [])
  await advance(5 * MINUTE)
  assert.deepEqual(stops.map(stop => stop.at), ['2026-11-12T01:40:00.000Z'])
})

test('a running child, an open permission request and a waiting morning report keep the daemon', { timeout: 20000 }, async t => {
  const settings = { 'workday.enabled': false, 'workday.timezone': 'UTC' }
  const { service } = await open(t, { settings, clock: fakeClock('2026-11-12T03:00:00Z') })
  assert.equal(await service.updateReady(), true)
  // A Claude child that runs: the state has a run that is not in a terminal state.
  await service.state.change(state => { state.runs.child = { id: 'child', status: 'running', agent: 'claude', prompt: 'Work', cwd: REPOSITORY, createdAt: Date.now() } })
  assert.equal(await service.updateReady(), false)
  await service.state.change(state => {
    state.runs.child.status = 'completed'
    state.permissions.ask = { id: 'ask', runId: 'child', status: 'pending', createdAt: Date.now() }
  })
  assert.equal(await service.updateReady(), true, 'a request of an ended run is not open')
  await service.state.change(state => {
    state.runs.child.status = 'approval'
  })
  assert.equal(await service.updateReady(), false)
  await service.state.change(state => {
    state.runs.child.status = 'completed'
    state.morningReport.pending = { date: '2026-11-12', data: {}, repeated: false }
  })
  assert.equal(await service.updateReady(), false)
  // The daemon runs the turn of the report. After it, nothing waits.
  await waitForState(service.state, state => state.current === null && !state.morningReport.pending && !state.morningReport.running ? true : undefined)
  assert.equal(await service.updateReady(), true)
  // The time outside the night window keeps the daemon.
  assert.equal(await service.updateReady(Date.parse('2026-11-12T12:00:00Z')), false)
})

test('after the end of a child, the next check 10 minutes later stops the daemon', async () => {
  let child = true
  const { update, stops, advance } = check({ clock: fakeClock('2026-11-12T03:00:00Z'), release: async () => '0.5.0', ready: async () => !child })
  update.start()
  await advance(0)
  child = false
  await advance(CONDITION_INTERVAL_MS - 1)
  assert.deepEqual(stops, [])
  await advance(1)
  assert.deepEqual(stops.map(stop => stop.at), ['2026-11-12T03:10:00.000Z'])
})

/** A copy of the package in `_npx/<hash>/node_modules/megachat`, as npx installs it, with the dependencies of the checkout. */
async function npxPackage(t) {
  const directory = await temporary(t, 'megachat-npx-')
  const copy = join(directory, '_npx', '0123abcd', 'node_modules', 'megachat')
  await mkdir(copy, { recursive: true })
  for (const item of ['bin', 'src', 'resources', 'package.json']) await cp(join(REPOSITORY, item), join(copy, item), { recursive: true })
  await symlink(join(REPOSITORY, 'node_modules'), join(copy, 'node_modules'))
  return { copy, version: JSON.parse(await readFile(join(copy, 'package.json'), 'utf8')).version }
}

/** Starts the daemon of [copy] on [home] in the foreground, with the error output in `log`. */
function startDaemon(t, copy, home, environment) {
  const child = spawn(process.execPath, [join(copy, 'src', 'main.mjs'), 'daemon', home], { env: { ...process.env, ...environment }, stdio: ['ignore', 'ignore', 'pipe'] })
  const result = { child, log: '', exited: once(child, 'exit') }
  child.stderr.on('data', chunk => { result.log += chunk })
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL') })
  return result
}

async function connected(home) {
  for (let attempt = 0; attempt < 300; attempt++) {
    try {
      const client = await DaemonClient.connect(home)
      client.health = await client.json('/health')
      return client
    }
    catch { await delay(50) }
  }
  assert.fail('The daemon did not start.')
}

test('a daemon of a copy of npx stops itself for a new release, and the next daemon of the same version does not stop again', { timeout: 60000 }, async t => {
  const { copy, version } = await npxPackage(t)
  const { directory: releases } = await releaseRepository(t, [`v${version}`, 'v99.0.0'])
  const home = await temporary(t, 'megachat-update-home-')
  // The conversation sleeps: today and yesterday are no working days, and the idle time is 0.
  const today = (new Date().getUTCDay() + 6) % 7
  await writeFile(join(home, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'update.auto': true, 'workday.enabled': true,
    'workday.days': [WEEKDAYS[(today + 3) % 7]], 'workday.start': '09:00', 'workday.end': '10:00', 'workday.timezone': 'UTC', 'workday.idleMinutes': 0 } }), { mode: 0o600 })
  const environment = { MEGACHAT_RELEASE_REPOSITORY: releases, MEGACHAT_UPDATE_START_DELAY_MS: '1500' }
  const first = startDaemon(t, copy, home, environment)
  const client = await connected(home)
  const events = []
  const watching = client.watch(event => { events.push(event) }).catch(() => {})
  const [code] = await first.exited
  await watching
  assert.equal(code, 0, first.log)
  assert.deepEqual(events.filter(event => event.type === 'update'), [{ type: 'update', value: { from: version, to: '99.0.0' } }])
  assert.match(first.log, new RegExp(`Megachat stops for the update from ${version.replace(/\./g, '\\.')} to 99\\.0\\.0\\.`))
  assert.equal(existsSync(join(home, 'daemon', 'connection.json')), false)
  // The copy gave the old version again, as a stale cache of npx would. The daemon keeps running and keeps the notice.
  const second = startDaemon(t, copy, home, environment)
  const again = await connected(home)
  await delay(3500)
  assert.equal(second.child.exitCode, null, second.log)
  assert.deepEqual((await again.json('/health')).update, { available: '99.0.0', notice: `A new release is available: ${version} → 99.0.0` })
  assert.match(second.log, /The automatic update to 99\.0\.0 did not install it/)
  await again.json('/shutdown', {})
  assert.equal((await second.exited)[0], 0)
})

test('a stop without an update allows a stop only for a higher release', async () => {
  for (const [release, expected] of [['0.5.0', 0], ['0.6.0', 1]]) {
    const { update, stops, advance } = check({ clock: fakeClock('2026-11-12T03:00:00Z'), release: async () => release, failed: async () => '0.5.0' })
    update.start()
    await advance(0)
    assert.equal(stops.length, expected, release)
    update.close()
  }
})

test('the state records the version, and a state without the field gets it with no message', { timeout: 20000 }, async t => {
  const { service, say, entries } = await open(t)
  assert.equal((await service.state.snapshot()).update, undefined)
  const first = await recordVersion(service.state, '0.5.0')
  assert.equal(first.notice, null)
  assert.deepEqual((await service.state.snapshot()).update, { version: '0.5.0', stop: null, failed: null, notice: null })
  // The same base version and a lower version give no message.
  for (const version of ['0.5.0+3.g1a2b3c4', '0.4.0']) assert.equal((await recordVersion(service.state, version)).notice, null)
  await say('hello', 'hello')
  assert.equal((await entries()).filter(entry => entry.kind === NOTE_KIND).length, 0)
  // A stop that gave no update records the release.
  await service.state.updateStopped('0.4.0', '0.5.0')
  const stale = await recordVersion(service.state, '0.4.0')
  assert.equal(stale.failed, '0.5.0')
  assert.equal((await service.state.snapshot()).update.failed, '0.5.0')
  assert.equal((await service.state.snapshot()).update.stop, null)
})

test('the next turn of the user starts with the message after an update and the notes, and a later turn gets none', { timeout: 20000 }, async t => {
  const { service, say, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  const result = await recordVersion(service.state, '0.5.0', { fetchNotes: async () => [{ version: '0.5.0', text: '- The daemon finds a new release' }] })
  await result.notes
  await say('hello', 'hello')
  await say('again', 'again')
  const items = await entries()
  const notes = items.filter(entry => entry.kind === NOTE_KIND)
  assert.equal(notes.length, 1)
  assert.deepEqual(notes[0].data, { type: 'update', from: '0.4.0', to: '0.5.0' })
  assert.equal(text(notes[0]), 'Megachat updated from 0.4.0 to 0.5.0.\n\nWhat is new in 0.5.0:\n- The daemon finds a new release')
  // The message comes directly before the input of the turn of the user.
  const index = items.indexOf(notes[0])
  assert.match(text(items[index + 1]), /hello/)
  assert.equal((await service.state.snapshot()).update.notice, null)
})

test('the first turn after an update waits for notes that come after its input', { timeout: 20000 }, async t => {
  const { service, say, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  // The notes come 500 ms after the start of the daemon, and the user sends the first input before that.
  await recordVersion(service.state, '0.5.0', { fetchNotes: async () => { await delay(500); return [{ version: '0.5.0', text: '- The notes came late' }] } })
  await say('hello', 'hello')
  const note = (await entries()).find(entry => entry.kind === NOTE_KIND)
  assert.equal(text(note), 'Megachat updated from 0.4.0 to 0.5.0.\n\nWhat is new in 0.5.0:\n- The notes came late')
})

test('the first turn after an update waits for the notes at most until the time limit of the request ends', { timeout: 20000 }, async t => {
  const { service, say, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  const started = Date.now()
  // The request never ends. Its time limit is 300 ms from the start of the daemon.
  await recordVersion(service.state, '0.5.0', { timeoutMs: 300, fetchNotes: () => new Promise(() => {}) })
  await service.submit('hello', 'hello')
  const waited = Date.now() - started
  assert.ok(waited >= 250 && waited < 5000, `the input waited ${waited} ms`)
  const items = await entries()
  const note = items.findIndex(entry => entry.kind === NOTE_KIND)
  assert.equal(text(items[note]), 'Megachat updated from 0.4.0 to 0.5.0.\nMegachat could not get the release notes. The notes are at https://github.com/ignatov/megachat/releases/tag/v0.5.0')
  assert.match(text(items[note + 1]), /hello/)
  await waitForState(service.state, state => state.current === null ? true : undefined)
})

test('the message after an update comes directly before the turn of the morning report', { timeout: 20000 }, async t => {
  const { service, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  await (await recordVersion(service.state, '0.5.0', { fetchNotes: async () => { throw new Error('offline') } })).notes
  // The daemon starts the turn of a report that waits, as at workday.start.
  await service.state.morningReportReady('2026-11-12', { period: 'test' })
  await waitForState(service.state, state => state.current === null && !state.morningReport.pending && !state.morningReport.running ? true : undefined)
  const items = await entries()
  const note = items.findIndex(entry => entry.kind === NOTE_KIND)
  assert.ok(note >= 0)
  assert.deepEqual(items[note].data, { type: 'update', from: '0.4.0', to: '0.5.0' })
  assert.equal(items[note + 1].data?.type, 'morning')
})

test('the notes come from each release after the recorded version, the newest first, with the limits', { timeout: 20000 }, async t => {
  const releases = [{ tag_name: 'v0.6.0', body: '- Six' }, { tag_name: 'v0.5.0', body: '- Five\r\n- More five' }, { tag_name: 'v0.4.0', body: '- Four' },
    { tag_name: 'v0.7.0-rc.1', body: '- Seven', prerelease: true }]
  const server = createServer((request, response) => { response.writeHead(200, { 'content-type': 'application/json' }); response.end(JSON.stringify(releases)) })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => server.close())
  const environment = { MEGACHAT_RELEASE_NOTES_URL: `http://127.0.0.1:${server.address().port}/releases` }
  const notes = await fetchReleaseNotes({ from: '0.4.0', to: '0.6.0', environment })
  assert.deepEqual(notes, [{ version: '0.6.0', text: '- Six' }, { version: '0.5.0', text: '- Five\r\n- More five' }])
  assert.equal(updateNoteText({ from: '0.4.0', to: '0.6.0', notes }),
    'Megachat updated from 0.4.0 to 0.6.0.\n\nWhat is new in 0.6.0:\n- Six\n\nWhat is new in 0.5.0:\n- Five\n- More five')
  const long = updateNoteText({ from: '0.4.0', to: '0.5.0', notes: [{ version: '0.5.0', text: Array.from({ length: 60 }, (_, index) => `- Line ${index}`).join('\n') }] })
  const lines = long.split('\n')
  assert.equal(lines.at(-1), message('update.more', 'https://github.com/ignatov/megachat/releases/tag/v0.5.0'))
  assert.equal(lines.length, 1 + NOTES_LINES + 2)
  assert.ok(updateNoteText({ from: '0.4.0', to: '0.5.0', notes: [{ version: '0.5.0', text: 'x'.repeat(9000) }] }).length < 8200)
})

test('without an answer of the server, the message gives the address of the release, and the log gets one line', { timeout: 20000 }, async t => {
  const lines = captureErrors(t)
  const server = createServer(() => { /* No answer. */ })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const environment = { MEGACHAT_RELEASE_NOTES_URL: `http://127.0.0.1:${server.address().port}/releases` }
  await assert.rejects(fetchReleaseNotes({ from: '0.4.0', to: '0.5.0', environment, timeoutMs: 300 }))
  const { service, say, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  let calls = 0
  const result = await recordVersion(service.state, '0.5.0', { environment, fetchNotes: options => { calls++; return fetchReleaseNotes({ ...options, timeoutMs: 300 }) } })
  await result.notes
  assert.equal(calls, 1)
  assert.equal(lines.filter(line => line.includes('could not get the release notes of 0.5.0')).length, 1)
  await say('hello', 'hello')
  const note = (await entries()).find(entry => entry.kind === NOTE_KIND)
  assert.equal(text(note), 'Megachat updated from 0.4.0 to 0.5.0.\nMegachat could not get the release notes. The notes are at https://github.com/ignatov/megachat/releases/tag/v0.5.0')
})

// The automatic update: the check of the release tags in a local repository, the comparison of the versions, the
// notice, the copy of npx, the conditions and the time of the stop, the stop of a real daemon from a copy of npx, the
// guard against a stop in a loop, the recorded version, and the message after an update with the notes from a local
// server. No case asks GitHub.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rename, rm, symlink, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { projectStateDirectory } from '../src/MegachatHome.mjs'
import { message } from '../src/messages.mjs'
import {
  APPLY_POLL_MS, baseVersion, CHECK_INTERVAL_MS, CONDITION_INTERVAL_MS, fetchReleaseNotes, higherVersion, highestRelease, listRelease, NOTES_LINES,
  npxCopy, recordVersion, removeRetired, retireCopy, RETRY_INTERVAL_MS, UpdateCheck, updateNoteText, updateTime,
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
function check({ version = '0.4.0', selfUpdating = true, kind, work, release, ready = async () => true, failed = async () => null, values = { 'update.auto': true }, clock = fakeClock('2026-11-11T23:00:00Z') } = {}) {
  const stops = []
  const update = new UpdateCheck({ version, selfUpdating, kind, ...(work ? { work } : {}), release, ready, failed, values: () => values, clock,
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
  // The stop moved the copy of the entry away, so npx cannot reuse it. Only that directory moved.
  const entry = dirname(dirname(copy))
  assert.equal(existsSync(copy), false)
  const retired = (await readdir(dirname(entry))).filter(name => name.startsWith('0123abcd.megachat-old-'))
  assert.equal(retired.length, 1)
  assert.deepEqual((await readdir(dirname(entry))).filter(name => !name.startsWith('0123abcd')), [])
  // An old npm gives the old copy again, as a stale cache would: the copy comes back. The daemon keeps running and keeps the notice.
  await rename(join(dirname(entry), retired[0]), entry)
  const second = startDaemon(t, copy, home, environment)
  const again = await connected(home)
  await delay(3500)
  assert.equal(second.child.exitCode, null, second.log)
  assert.deepEqual((await again.json('/health')).update, { available: '99.0.0', notice: `A new release is available: ${version} → 99.0.0` })
  assert.match(second.log, /The automatic update to 99\.0\.0 did not install it/)
  await again.json('/shutdown', {})
  assert.equal((await second.exited)[0], 0)
})

test('retireCopy moves only a copy of npx that holds the package megachat, and removeRetired removes only its own old directories', async t => {
  const { copy } = await npxPackage(t)
  const entry = dirname(dirname(copy))
  const parent = dirname(entry)
  await mkdir(join(parent, 'other', 'node_modules', 'megachat'), { recursive: true })
  await writeFile(join(parent, 'other', 'node_modules', 'megachat', 'package.json'), '{"name":"megachat"}')
  // A checkout, a path outside `_npx` and a copy with another package name stay where they are.
  assert.equal(retireCopy(REPOSITORY), undefined)
  await mkdir(join(dirname(parent), 'plain', 'node_modules', 'megachat'), { recursive: true })
  await writeFile(join(dirname(parent), 'plain', 'node_modules', 'megachat', 'package.json'), '{"name":"megachat"}')
  assert.equal(retireCopy(join(dirname(parent), 'plain', 'node_modules', 'megachat')), undefined)
  await writeFile(join(copy, 'package.json'), '{"name":"another"}')
  assert.equal(retireCopy(copy), undefined)
  await writeFile(join(copy, 'package.json'), '{"name":"megachat"}')
  const moved = retireCopy(copy, 1000)
  assert.equal(moved, join(parent, '0123abcd.megachat-old-1000'))
  assert.equal(existsSync(copy), false)
  assert.equal(existsSync(join(parent, 'other')), true)
  // A later copy of the same entry, an old directory of this entry and a directory of another entry.
  await mkdir(join(parent, '0123abcd.megachat-old-2000'))
  await mkdir(join(parent, '9999.megachat-old-1000'))
  await mkdir(entry, { recursive: true })
  assert.equal(await removeRetired(REPOSITORY), 0, 'a checkout gives no removal')
  assert.equal(await removeRetired(copy), 2)
  assert.deepEqual((await readdir(parent)).sort(), ['0123abcd', '9999.megachat-old-1000', 'other'])
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

/** Ends the turn that `state.submit` admitted: no service follows it in these tests. */
async function endTurn(service) {
  await service.state.change(state => { state.current = null })
}

/** Waits until the conversation has the note after an update. */
async function noteEntry(entries) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const note = (await entries()).find(entry => entry.kind === NOTE_KIND && entry.data?.type === 'update')
    if (note) return note
    await delay(25)
  }
  assert.fail('The note after the update did not arrive.')
}

test('the message after an update comes on its own, with no input, and goes out once', { timeout: 20000 }, async t => {
  const { service, say, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  const result = await recordVersion(service.state, '0.5.0', { fetchNotes: async () => [{ version: '0.5.0', text: '## New\n\n- The daemon finds a new release' }] })
  t.after(() => result.close())
  await result.notes
  const note = await noteEntry(entries)
  assert.deepEqual(note.data, { type: 'update', from: '0.4.0', to: '0.5.0' })
  assert.equal(text(note), 'Megachat updated from 0.4.0 to 0.5.0.\n- The daemon finds a new release')
  assert.equal((await service.state.snapshot()).update.notice, null)
  assert.equal((await service.state.snapshot()).current, null)
  assert.equal(Object.keys((await service.state.snapshot()).inputs).length, 0)
  // A turn of the user adds no second message, and it did not wait for one.
  await say('hello', 'hello')
  assert.equal((await entries()).filter(entry => entry.kind === NOTE_KIND).length, 1)
})

test('a turn of the user does not wait for the notes, and the message follows when the notes end', { timeout: 20000 }, async t => {
  const { service, say, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  const result = await recordVersion(service.state, '0.5.0', { fetchNotes: async () => { await delay(1500); return [{ version: '0.5.0', text: '- Late' }] }, retryMs: 50 })
  t.after(() => result.close())
  const started = Date.now()
  await say('hello', 'hello')
  assert.ok(Date.now() - started < 1400, `the input waited ${Date.now() - started} ms`)
  assert.equal((await entries()).filter(entry => entry.kind === NOTE_KIND).length, 0)
  const note = await noteEntry(entries)
  assert.equal(text(note), 'Megachat updated from 0.4.0 to 0.5.0.\n- Late')
})

test('a turn that runs holds the message back until the turn ends, and then it goes out without an input', { timeout: 20000 }, async t => {
  const { service, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  await service.state.submit('hello', 'hello')
  assert.notEqual((await service.state.snapshot()).current, null)
  const result = await recordVersion(service.state, '0.5.0', { fetchNotes: async () => [{ version: '0.5.0', text: '- Five' }], retryMs: 50 })
  t.after(() => result.close())
  await delay(200)
  assert.equal((await service.state.snapshot()).update.notice.to, '0.5.0')
  assert.equal((await entries()).filter(entry => entry.kind === NOTE_KIND).length, 0)
  await endTurn(service)
  await noteEntry(entries)
  assert.equal((await service.state.snapshot()).update.notice, null)
})

test('in a view, the message after an update and a later reply are messages with the phase of an answer, live and in the replay', { timeout: 20000 }, async t => {
  const { service, daemon } = await open(t)
  const attach = async () => {
    const updates = []
    const connection = client({ name: 'test-air' }).onNotification('*', ({ params }) => { updates.push(params) }).connect(new AcpBridge(daemon).app())
    t.after(() => connection.close())
    await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
    const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd: REPOSITORY, mcpServers: [] })
    const prompt = text => connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })
    const chunks = () => updates.filter(event => event.update.sessionUpdate === 'agent_message_chunk')
    return { prompt, chunks }
  }
  const viewer = await attach()
  await recordVersion(service.state, '0.4.0')
  const result = await recordVersion(service.state, '0.5.0', { fetchNotes: async () => [{ version: '0.5.0', text: '- Five' }] })
  t.after(() => result.close())
  const ids = list => [...new Set(list.map(event => event.update.messageId))]
  const textOf = (list, id) => list.filter(event => event.update.messageId === id).map(event => event.update.content.text).join('')
  for (let attempt = 0; attempt < 200 && viewer.chunks().length === 0; attempt++) await delay(25)
  const [note] = ids(viewer.chunks())
  assert.match(note, /^megachat-entry-\d+$/)
  assert.equal(textOf(viewer.chunks(), note), 'Megachat updated from 0.4.0 to 0.5.0.\n- Five')
  assert.equal((await viewer.prompt('hello')).stopReason, 'end_turn')
  const live = viewer.chunks()
  assert.equal(ids(live).length, 2)
  assert.equal(textOf(live, ids(live)[1]), 'Answer 1.')
  // Air infers no block "Worked for" for a turn with a message that has a phase.
  assert.ok(live.every(event => event.update._meta?.jetbrains?.air?.phase === 'final_answer'))
  const replayed = (await attach()).chunks()
  assert.deepEqual(ids(replayed), ids(live))
  assert.ok(replayed.every(event => event.update._meta?.jetbrains?.air?.phase === 'final_answer'))
})

test('a message that waits is kept when no client is connected, and a daemon that stops sends no second message', { timeout: 20000 }, async t => {
  const { service, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  await service.state.submit('hello', 'hello')
  const first = await recordVersion(service.state, '0.5.0', { fetchNotes: async () => [{ version: '0.5.0', text: '- Five' }], retryMs: 50 })
  await delay(150)
  // The daemon stops while the message waits. The state keeps the message for the next daemon of the same version.
  first.close()
  await first.notes
  assert.equal((await service.state.snapshot()).update.notice.to, '0.5.0')
  await endTurn(service)
  const second = await recordVersion(service.state, '0.5.0', { fetchNotes: async () => [{ version: '0.5.0', text: '- Five' }] })
  t.after(() => second.close())
  assert.equal(second.notice, null)
  assert.equal(await service.state.writeUpdateNote(), true)
  await noteEntry(entries)
  assert.equal(await service.state.writeUpdateNote(), true)
  assert.equal((await entries()).filter(entry => entry.kind === NOTE_KIND).length, 1)
})

test('a request for the notes that never ends gives the message with the address at its time limit', { timeout: 20000 }, async t => {
  const { service, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  const result = await recordVersion(service.state, '0.5.0', { timeoutMs: 300, fetchNotes: ({ timeoutMs }) => new Promise((resolve, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)) })
  t.after(() => result.close())
  const note = await noteEntry(entries)
  assert.equal(text(note), 'Megachat updated from 0.4.0 to 0.5.0.\nMegachat could not get the release notes. The notes are at https://github.com/ignatov/megachat/releases/tag/v0.5.0')
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
  // Two releases: the lines of the newest release come first, with no heading and no blank line.
  assert.equal(updateNoteText({ from: '0.4.0', to: '0.6.0', notes }), 'Megachat updated from 0.4.0 to 0.6.0.\n- Six\n- Five\n- More five')
  // Long notes: the title, 3 lines of notes and the address. The message has at most 5 lines.
  const long = updateNoteText({ from: '0.4.0', to: '0.5.0', notes: [{ version: '0.5.0', text: Array.from({ length: 60 }, (_, index) => `- Line ${index}`).join('\n') }] })
  assert.equal(long, 'Megachat updated from 0.4.0 to 0.5.0.\n- Line 0\n- Line 1\n- Line 2\nMore: https://github.com/ignatov/megachat/releases/tag/v0.5.0')
  // Four lines of notes fit with the title in 5 lines, five lines do not.
  const four = text => updateNoteText({ from: '0.4.0', to: '0.5.0', notes: [{ version: '0.5.0', text }] }).split('\n')
  assert.equal(four('- a\n- b\n- c\n- d').length, NOTES_LINES)
  assert.equal(four('- a\n- b\n- c\n- d\n- e').length, NOTES_LINES)
  // A long line is cut.
  assert.ok(four('x'.repeat(9000))[1].length <= 160)
})

test('without an answer of the server, the message gives the address of the release, and the log gets one line', { timeout: 20000 }, async t => {
  const lines = captureErrors(t)
  const server = createServer(() => { /* No answer. */ })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); server.close() })
  const environment = { MEGACHAT_RELEASE_NOTES_URL: `http://127.0.0.1:${server.address().port}/releases` }
  await assert.rejects(fetchReleaseNotes({ from: '0.4.0', to: '0.5.0', environment, timeoutMs: 300 }))
  const { service, entries } = await open(t)
  await recordVersion(service.state, '0.4.0')
  let calls = 0
  const result = await recordVersion(service.state, '0.5.0', { environment, fetchNotes: options => { calls++; return fetchReleaseNotes({ ...options, timeoutMs: 300 }) } })
  t.after(() => result.close())
  await result.notes
  assert.equal(calls, 1)
  assert.equal(lines.filter(line => line.includes('could not get the release notes of 0.5.0')).length, 1)
  const note = await noteEntry(entries)
  assert.equal(text(note), 'Megachat updated from 0.4.0 to 0.5.0.\nMegachat could not get the release notes. The notes are at https://github.com/ignatov/megachat/releases/tag/v0.5.0')
})

test('a check on demand finds a release before the next timer, and the summary names the failure of a failed check', async () => {
  let latest = '0.4.0'
  let broken = false
  const { update, advance } = check({ selfUpdating: false, release: async () => { if (broken) throw Object.assign(new Error('x'), { code: 'timeout' }); return latest } })
  update.start()
  await advance(0)
  assert.equal(update.status(), undefined)
  latest = '0.5.0'
  const found = await update.checkNow()
  assert.deepEqual([found.version, found.latest, found.available, found.kind], ['0.4.0', '0.5.0', '0.5.0', 'other'])
  assert.deepEqual(update.status(), { available: '0.5.0', notice: 'A new release is available: 0.4.0 → 0.5.0' })
  broken = true
  const failed = await update.checkNow()
  assert.equal(failed.error, 'timeout')
  update.close()
})

test('a check that the sleep of the computer delayed runs when the computer wakes, by the wall clock', async () => {
  let latest = '0.4.0'
  const { update, advance, clock } = check({ selfUpdating: false, release: async () => latest })
  update.start()
  await advance(0)
  latest = '0.5.0'
  // The timers of the computer do not run in a sleep of 30 hours. The next tick finds that the check is due.
  clock.sleep(30 * 3600000)
  assert.equal(update.status(), undefined)
  await advance(1)
  assert.equal(update.status()?.available, '0.5.0')
  update.close()
})

test('apply in a copy of npx stops when the work is over, waits for busy work, and the turn of the request is no work', async () => {
  let work = [{ kind: 'turn', turn: 'user' }]
  const { update, stops, advance } = check({ release: async () => '0.5.0', work: async () => work, ready: async () => false, values: { 'update.auto': false } })
  // The turn of the request runs: the stop waits for its end, with `update.auto` off.
  const started = await update.apply()
  assert.deepEqual([started.applied, started.scheduled, started.available], [true, true, '0.5.0'])
  await advance(APPLY_POLL_MS * 3)
  assert.equal(stops.length, 0)
  work = []
  await advance(APPLY_POLL_MS)
  assert.deepEqual(stops.map(({ from, to }) => [from, to]), [['0.4.0', '0.5.0']])
  update.close()
  // A child that runs refuses the request, and `whenIdle` accepts it and stops right after the child.
  work = [{ kind: 'turn', turn: 'user' }, { kind: 'child', runId: 'r1', agent: 'claude', title: 'Build', status: 'running' }]
  const busy = check({ release: async () => '0.5.0', work: async () => work, ready: async () => false })
  const refused = await busy.update.apply()
  assert.deepEqual([refused.applied, refused.reason, refused.work.map(item => item.kind)], [false, 'busy', ['child']])
  const waiting = await busy.update.apply({ whenIdle: true })
  assert.deepEqual([waiting.applied, waiting.work.map(item => item.kind)], [true, ['child']])
  await busy.advance(APPLY_POLL_MS * 5)
  assert.equal(busy.stops.length, 0)
  work = []
  await busy.advance(APPLY_POLL_MS)
  assert.equal(busy.stops.length, 1)
  busy.update.close()
})

test('apply says current, a failed check, a checkout and another copy, and stops no daemon', async () => {
  const cases = [
    [{ release: async () => '0.4.0' }, 'current'],
    [{ release: async () => { throw Object.assign(new Error('x'), { code: 'exit128' }) } }, 'checkFailed'],
    [{ release: async () => '0.5.0', selfUpdating: false, kind: 'checkout' }, 'checkout'],
    [{ release: async () => '0.5.0', selfUpdating: false, kind: 'other' }, 'other'],
  ]
  for (const [options, reason] of cases) {
    const { update, stops, advance } = check(options)
    const outcome = await update.apply()
    assert.deepEqual([outcome.applied, outcome.reason], [false, reason])
    await advance(CONDITION_INTERVAL_MS * 2)
    assert.equal(stops.length, 0, reason)
    update.close()
  }
})

test('the tool agents_update checks in each turn, applies only in a turn of the user, and its texts name no @latest', async t => {
  const { service } = await open(t)
  const tool = service.extension().tools.find(item => item.name === 'agents_update')
  await assert.rejects(tool.execute({ action: 'check' }), { code: 'unavailable' })
  const stops = []
  service.updater = new UpdateCheck({ version: '0.4.0', selfUpdating: false, kind: 'checkout', release: async () => '0.5.0', ready: async () => false,
    failed: async () => null, values: () => ({ 'update.auto': true }), stop: async (from, to) => { stops.push([from, to]) } })
  t.after(() => service.updater.close())
  const checked = JSON.parse((await tool.execute({ action: 'check' })).output[0].text)
  assert.deepEqual([checked.latest, checked.available, checked.kind, checked.autoUpdate], ['0.5.0', '0.5.0', 'checkout', true])
  // An automatic turn cannot apply, and the request does not even check.
  for (const kind of ['report', 'event', 'morning']) {
    await service.state.change(state => { state.current = { id: kind, requestId: kind, cancelling: false, kind } })
    await assert.rejects(tool.execute({ action: 'apply' }), { code: 'updateEvent' })
    await service.state.change(state => { state.current = null })
  }
  await service.state.change(state => { state.current = { id: 'u', requestId: 'u', cancelling: false, kind: 'user' } })
  const applied = JSON.parse((await tool.execute({ action: 'apply' })).output[0].text)
  assert.equal(applied.reason, 'checkout')
  assert.match(applied.instruction, /git pull/)
  assert.match(applied.instruction, /node src\/main\.mjs stop/)
  assert.deepEqual(stops, [])
  for (const key of ['update.apply.started', 'update.apply.current', 'update.apply.checkFailed', 'update.apply.checkout', 'update.apply.other', 'update.apply.busy', 'instructions.update', 'tool.update'])
    assert.doesNotMatch(message(key, '0.4.0', '0.5.0'), /@latest/, key)
  assert.match(message('instructions.update'), /github:ignatov\/megachat#semver:x/)
  assert.ok((await service.root.agent(BACKGROUND_CONTEXT)).sections.find(item => item.key === 'settings').render().includes(message('instructions.update')))
})

test('the note after an update tells that the automatic update is on, within the limit of lines', () => {
  const notes = [{ version: '0.5.0', text: Array.from({ length: 9 }, (_, index) => `Line ${index + 1}`).join('\n') }]
  const plain = updateNoteText({ from: '0.4.0', to: '0.5.0', notes })
  const withNote = updateNoteText({ from: '0.4.0', to: '0.5.0', notes, autoOn: true })
  assert.ok(!plain.includes(message('update.autoOn')))
  assert.ok(withNote.endsWith(message('update.autoOn')))
  assert.ok(withNote.split('\n').length <= NOTES_LINES)
  assert.match(updateNoteText({ from: '0.4.0', to: '0.5.0', notes: null, autoOn: true }), /ask me to set update\.auto to false/)
})

test('a daemon stops for an update only when each other daemon of its copy is ready, and it stops them first', async () => {
  let otherReady = false
  const order = []
  const clock = fakeClock('2026-11-12T03:00:00Z')
  const update = new UpdateCheck({ version: '0.4.0', selfUpdating: true, release: async () => '0.5.0', ready: async () => true, failed: async () => null,
    values: () => ({ 'update.auto': true }), clock,
    others: async () => ({ ready: otherReady, stop: async (from, to) => { order.push(['others', from, to]) } }),
    stop: async (from, to) => { order.push(['own', from, to]) } })
  const advance = ms => clock.advance(ms, () => update.running)
  update.start()
  await advance(0)
  // A daemon of the same copy has work: no daemon stops, and the next check of the conditions asks again.
  assert.deepEqual(order, [])
  await advance(CONDITION_INTERVAL_MS)
  assert.deepEqual(order, [])
  otherReady = true
  await advance(CONDITION_INTERVAL_MS)
  assert.deepEqual(order, [['others', '0.4.0', '0.5.0'], ['own', '0.4.0', '0.5.0']])
  // A request of the user waits for the other daemons too.
  otherReady = false
  const asked = []
  const requested = new UpdateCheck({ version: '0.4.0', selfUpdating: true, release: async () => '0.5.0', ready: async () => false, failed: async () => null,
    values: () => ({ 'update.auto': false }), clock, others: async () => ({ ready: otherReady, stop: async () => { asked.push('others') } }),
    stop: async () => { asked.push('own') } })
  assert.equal((await requested.apply()).applied, true)
  await clock.advance(APPLY_POLL_MS, () => requested.running)
  assert.deepEqual(asked, [])
  otherReady = true
  await clock.advance(APPLY_POLL_MS, () => requested.running)
  assert.deepEqual(asked, ['others', 'own'])
  update.close()
  requested.close()
})

test('the daemon tells another daemon of its copy whether it is ready, and it stops for the update of that daemon', { timeout: 20000 }, async t => {
  const { service, server, daemon } = await open(t)
  // A server without a copy gives no root, so it counts as a daemon of another copy.
  assert.deepEqual(await daemon.json('/update/ready'), { root: null, ready: true })
  server.root = '/copy/'
  assert.deepEqual(await daemon.json('/update/ready'), { root: '/copy/', ready: true })
  await service.state.change(state => { state.runs.child = { id: 'child', status: 'running', agent: 'claude', prompt: 'Work', cwd: REPOSITORY, createdAt: Date.now() } })
  assert.deepEqual(await daemon.json('/update/ready'), { root: '/copy/', ready: false })
  await service.state.change(state => { state.runs.child.status = 'completed' })
  // The stop for the update of another daemon needs the two versions, and a server that can stop.
  await assert.rejects(daemon.json('/update/stop', { from: '0.4.0', to: '0.5.0' }))
  const stops = []
  server.updateStop = (from, to) => stops.push([from, to])
  await assert.rejects(daemon.json('/update/stop', { from: '0.4.0' }))
  assert.deepEqual(await daemon.json('/update/stop', { from: '0.4.0', to: '0.5.0' }), { stopping: true })
  await delay(20)
  assert.deepEqual(stops, [['0.4.0', '0.5.0']])
})

test('the daemons of one copy stop together for an update, and a daemon of another copy continues to run', { timeout: 90000 }, async t => {
  const { copy, version } = await npxPackage(t)
  const { directory: releases } = await releaseRepository(t, [`v${version}`, 'v99.0.0'])
  const home = await temporary(t, 'megachat-update-tree-')
  const work = await temporary(t, 'megachat-update-work-')
  const app = join(work, 'app')
  const lib = join(work, 'lib')
  const appState = projectStateDirectory(home, app)
  const libState = projectStateDirectory(home, lib)
  for (const directory of [app, lib, appState, libState]) await mkdir(directory, { recursive: true })
  // The conversation of the machine scope sleeps: today and yesterday are no working days, and the idle time is 0.
  const today = (new Date().getUTCDay() + 6) % 7
  await writeFile(join(home, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'update.auto': true, 'workday.enabled': true,
    'workday.days': [WEEKDAYS[(today + 3) % 7]], 'workday.start': '09:00', 'workday.end': '10:00', 'workday.timezone': 'UTC', 'workday.idleMinutes': 0 } }), { mode: 0o600 })
  // The daemons of the projects do not start an update: `update.auto` is off, and their own check comes late.
  for (const state of [appState, libState]) {
    await writeFile(join(state, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', defaults: 2, values: { 'update.auto': false } }), { mode: 0o600 })
  }
  const environment = { MEGACHAT_HOME: home, MEGACHAT_RELEASE_REPOSITORY: releases }
  const late = { ...environment, MEGACHAT_UPDATE_START_DELAY_MS: '600000' }
  // The daemon of `app` runs from the copy of npx, and the daemon of `lib` runs from this checkout.
  const appDaemon = startDaemon(t, copy, appState, { ...late, MEGACHAT_PROJECT: app })
  const libDaemon = startDaemon(t, REPOSITORY, libState, { ...late, MEGACHAT_PROJECT: lib })
  const appClient = await connected(appState)
  const libClient = await connected(libState)
  assert.equal((await appClient.json('/state')).projectDirectory, app)
  const events = []
  const watching = appClient.watch(event => { events.push(event) }).catch(() => {})
  const machine = startDaemon(t, copy, home, { ...environment, MEGACHAT_UPDATE_START_DELAY_MS: '1500' })
  await connected(home)
  assert.equal((await machine.exited)[0], 0, machine.log)
  assert.equal((await appDaemon.exited)[0], 0, appDaemon.log)
  await watching
  // The daemon of `app` told its views about the update before its stop.
  assert.deepEqual(events.filter(event => event.type === 'update'), [{ type: 'update', value: { from: version, to: '99.0.0' } }])
  assert.match(appDaemon.log, new RegExp(`Megachat stops for the update from ${version.replace(/\./g, '\\.')} to 99\\.0\\.0\\.`))
  assert.equal(existsSync(join(appState, 'daemon', 'connection.json')), false)
  assert.equal(existsSync(join(home, 'daemon', 'connection.json')), false)
  // The copy moved away one time, after both of its daemons ended.
  const entry = dirname(dirname(copy))
  assert.equal(existsSync(copy), false)
  assert.equal((await readdir(dirname(entry))).filter(name => name.startsWith('0123abcd.megachat-old-')).length, 1)
  // The daemon of the checkout is a daemon of another copy: it continues to run.
  assert.equal(libDaemon.child.exitCode, null, libDaemon.log)
  assert.equal((await libClient.json('/health')).pid, libDaemon.child.pid)
  await libClient.json('/shutdown', {})
  assert.equal((await libDaemon.exited)[0], 0)
})

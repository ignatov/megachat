import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { DailySpend } from '../src/DailySpend.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import { collectReportData, MorningReport, REPORT_RECHECK_MS } from '../src/MorningReport.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { SessionIndex } from '../src/SessionIndex.mjs'
import { parseTokprof, readTokprof } from '../src/Tokprof.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { localDate, nextWorkdayStart, reportPeriod, zonedTime } from '../src/Workday.mjs'
import { fakeClock } from './fake-clock.mjs'

const MINUTE = 60000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const WEEK = ['mon', 'tue', 'wed', 'thu', 'fri']
const UTC = { start: '09:00', days: WEEK, timezone: 'UTC' }
const BERLIN = { ...UTC, timezone: 'Europe/Berlin' }
const at = text => Date.parse(text)
const iso = ms => new Date(ms).toISOString()

async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-report-')))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  return directory
}

/** Runs [body] and returns the lines that it wrote to the standard error. */
async function logLines(t, body) {
  const lines = []
  t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true })
  try { await body() }
  finally { process.stderr.write.mock.restore() }
  return lines
}

/**
 * Writes a fake `tokprof` into [directory]. `FAKE_TOKPROF_MODE` selects its behavior: `ok` writes `FAKE_TOKPROF_OUTPUT`
 * to the file of `-o`, `large` writes more than 4 MB, `fail` ends with an error, and `sleep` does not end. `FAKE_TOKPROF_ARGS` gets its arguments.
 */
async function fakeTokprof(directory) {
  const bin = join(directory, 'bin')
  await mkdir(bin, { recursive: true })
  await writeFile(join(bin, 'tokprof'), `#!${process.execPath}
const { appendFileSync, writeFileSync } = require('node:fs')
const args = process.argv.slice(2)
if (process.env.FAKE_TOKPROF_ARGS) appendFileSync(process.env.FAKE_TOKPROF_ARGS, JSON.stringify(args) + '\\n')
const mode = process.env.FAKE_TOKPROF_MODE || 'ok'
if (mode === 'sleep') setTimeout(() => {}, 600000)
else if (mode === 'fail') process.exit(2)
else if (mode === 'large') writeFileSync(args[args.indexOf('-o') + 1], 'claude;~/src/demo-app;prompt 1\\n'.repeat(200000))
else writeFileSync(args[args.indexOf('-o') + 1], process.env.FAKE_TOKPROF_OUTPUT || '')
`)
  await chmod(join(bin, 'tokprof'), 0o755)
  return bin
}

/** The folded stacks of a fake tokprof: two agents of the user, a pi session of the user, and a pi line in the state directory. */
const folded = stateDirectory => [
  'claude;~/src/demo-app;prompt 12500000',
  'claude;~/src/demo-app;agent:Explore 2500000',
  'codex;~/src/demo-tool;prompt 4000000',
  'pi;~/src/demo-tool;prompt 1000000',
  `pi;${join(stateDirectory, 'workspace')};prompt 700000`,
].join('\n')

test('the next start of a working day follows the days, the timezone and the daylight saving time', () => {
  // 2026-11-13 is a Friday. After its start, the next start is on Monday.
  assert.equal(iso(nextWorkdayStart(UTC, at('2026-11-13T08:59:00Z'))), '2026-11-13T09:00:00.000Z')
  assert.equal(iso(nextWorkdayStart(UTC, at('2026-11-13T09:00:00Z'))), '2026-11-16T09:00:00.000Z')
  assert.equal(iso(nextWorkdayStart(UTC, at('2026-11-14T12:00:00Z'))), '2026-11-16T09:00:00.000Z')
  assert.equal(iso(nextWorkdayStart({ ...UTC, days: ['sat'] }, at('2026-11-13T12:00:00Z'))), '2026-11-14T09:00:00.000Z')
  // 09:00 in New York is 14:00 UTC in the winter time.
  assert.equal(iso(nextWorkdayStart({ ...UTC, timezone: 'America/New_York' }, at('2026-11-16T12:00:00Z'))), '2026-11-16T14:00:00.000Z')
  // Berlin leaves the summer time on Sunday 2026-10-25: 09:00 is 07:00 UTC on the Friday before and 08:00 UTC after it.
  assert.equal(iso(nextWorkdayStart(BERLIN, at('2026-10-23T06:00:00Z'))), '2026-10-23T07:00:00.000Z')
  assert.equal(iso(nextWorkdayStart(BERLIN, at('2026-10-23T07:00:00Z'))), '2026-10-26T08:00:00.000Z')
  // A local time that the change skips gives the time after the gap, and a time that occurs two times the second one.
  assert.equal(iso(zonedTime('2026-03-29', '02:30', 'Europe/Berlin')), '2026-03-29T01:30:00.000Z')
  assert.equal(iso(zonedTime('2026-10-25', '02:30', 'Europe/Berlin')), '2026-10-25T01:30:00.000Z')
  assert.equal(localDate(at('2026-11-13T23:30:00Z'), 'Asia/Tokyo'), '2026-11-14')
})

test('the report period goes from the previous working day up to yesterday', () => {
  assert.deepEqual(reportPeriod(UTC, '2026-11-16'), { from: '2026-11-13', to: '2026-11-15', dates: ['2026-11-13', '2026-11-14', '2026-11-15'] })
  assert.deepEqual(reportPeriod(UTC, '2026-11-17'), { from: '2026-11-16', to: '2026-11-16', dates: ['2026-11-16'] })
  assert.equal(reportPeriod({ ...UTC, days: ['mon'] }, '2026-11-16').dates.length, 7)
})

/** A timer on a fake clock with the settings [values]. `prepared` gets each date that the timer prepares. */
function timerFixture({ start, values = {}, lastDate = null }) {
  const clock = fakeClock(start)
  const prepared = []
  const store = { lastDate }
  const settings = { 'report.morning': true, 'workday.start': '09:00', 'workday.days': WEEK, 'workday.timezone': 'UTC', ...values }
  const timer = new MorningReport({ clock, values: () => settings, lastDate: async () => store.lastDate,
    prepare: async date => { prepared.push(`${date} ${iso(clock.now()).slice(11, 16)}`); store.lastDate = date } })
  const advance = ms => clock.advance(ms, () => timer.running)
  return { clock, timer, prepared, store, advance, settings }
}

test('the timer prepares one report at the start of each working day, and none on a weekend', async () => {
  const { timer, prepared, advance } = timerFixture({ start: '2026-11-12T08:00:00Z' })
  await timer.check()
  assert.deepEqual(prepared, [])
  await advance(5 * DAY)
  // Thursday, Friday, and then Monday: no report on Saturday and Sunday.
  assert.deepEqual(prepared, ['2026-11-12 09:00', '2026-11-13 09:00', '2026-11-16 09:00'])
  await timer.close()
})

test('the timer follows the timezone and the daylight saving time', async () => {
  const berlin = timerFixture({ start: '2026-10-23T06:00:00Z', values: { 'workday.timezone': 'Europe/Berlin' } })
  await berlin.timer.check()
  await berlin.advance(4 * DAY)
  assert.deepEqual(berlin.prepared, ['2026-10-23 07:00', '2026-10-26 08:00'])
  await berlin.timer.close()
  const newYork = timerFixture({ start: '2026-11-16T12:00:00Z', values: { 'workday.timezone': 'America/New_York', 'workday.start': '08:30' } })
  await newYork.timer.check()
  await newYork.advance(DAY)
  assert.deepEqual(newYork.prepared, ['2026-11-16 13:30'])
  await newYork.timer.close()
})

test('a missed timer gives one report at the first chance on that day, and a restart gives no second report', async () => {
  const { clock, timer, prepared, advance, store } = timerFixture({ start: '2026-11-16T08:00:00Z' })
  await timer.check()
  // The timer waits at most 15 minutes, so a computer that wakes up looks at the clock again soon.
  assert.ok(clock.now() + REPORT_RECHECK_MS >= timer.timer.at)
  // The computer sleeps through the start of the day, and no timer runs.
  clock.sleep(3 * HOUR)
  await advance(MINUTE)
  assert.deepEqual(prepared, ['2026-11-16 11:00'])
  await advance(HOUR)
  assert.deepEqual(prepared, ['2026-11-16 11:00'])
  await timer.close()
  // A new daemon on the same day reads the date of the last report from the state.
  const restarted = timerFixture({ start: '2026-11-16T12:00:00Z', lastDate: store.lastDate })
  await restarted.timer.check()
  await restarted.advance(22 * HOUR)
  assert.deepEqual(restarted.prepared, ['2026-11-17 09:00'])
  await restarted.timer.close()
  // The daemon was down at the start: the report comes at its start.
  const late = timerFixture({ start: '2026-11-16T10:30:00Z' })
  await late.timer.check()
  assert.deepEqual(late.prepared, ['2026-11-16 10:30'])
  await late.timer.close()
})

test('with report.morning off, the timer prepares no report and waits for no time', async () => {
  const { timer, prepared, advance } = timerFixture({ start: '2026-11-16T08:00:00Z', values: { 'report.morning': false } })
  await timer.check()
  assert.equal(timer.timer, undefined)
  await advance(7 * DAY)
  assert.deepEqual(prepared, [])
})

test('the tokprof part sums the cost by agent, project and origin, and leaves out a pi line of the state directory', () => {
  const stateDirectory = '/home/user/.jetbrains/air/megachat'
  const parsed = parseTokprof(folded(stateDirectory), { home: '/home/user', stateDirectory })
  assert.deepEqual(parsed, { status: 'ok', usd: 20, agents: { claude: 15, codex: 4, pi: 1 },
    projects: [{ project: '~/src/demo-app', usd: 15 }, { project: '~/src/demo-tool', usd: 5 }],
    origins: [{ origin: 'prompt', usd: 17.5 }, { origin: 'agent:Explore', usd: 2.5 }], excludedPiChildUsd: 0.7 })
  // The home directory in the form of tokprof names the same directory.
  assert.equal(parseTokprof('pi;~/.jetbrains/air/megachat;prompt 300000', { home: '/home/user', stateDirectory }).excludedPiChildUsd, 0.3)
  assert.equal(parseTokprof('', { stateDirectory }).usd, 0)
})

test('the tokprof command runs from PATH with a time limit, and each failure says that the part is missing', async t => {
  const directory = await temporary(t)
  const bin = await fakeTokprof(directory)
  const argsFile = join(directory, 'args.jsonl')
  const stateDirectory = join(directory, 'state')
  const environment = { PATH: bin, FAKE_TOKPROF_OUTPUT: folded(stateDirectory), FAKE_TOKPROF_ARGS: argsFile }
  const ok = await readTokprof({ since: '2026-11-13', until: '2026-11-16', environment, home: directory, stateDirectory })
  assert.equal(ok.status, 'ok')
  assert.equal(ok.usd, 20)
  const [args] = (await readFile(argsFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(args.slice(0, -1), ['flame', '--since', '2026-11-13', '--until', '2026-11-16', '--stack', 'agent,project,origin', '--value', 'cost', '-o'])
  assert.deepEqual(await readTokprof({ since: '2026-11-13', until: '2026-11-16', environment: { ...environment, FAKE_TOKPROF_MODE: 'fail' }, home: directory }),
    { status: 'missing', reason: 'failed' })
  assert.deepEqual(await readTokprof({ since: '2026-11-13', until: '2026-11-16', environment: { ...environment, FAKE_TOKPROF_MODE: 'sleep' }, home: directory, timeoutMs: 300 }),
    { status: 'missing', reason: 'timeout' })
  assert.deepEqual(await readTokprof({ since: '2026-11-13', until: '2026-11-16', environment: { ...environment, FAKE_TOKPROF_MODE: 'large' }, home: directory }),
    { status: 'missing', reason: 'output' })
  const empty = join(directory, 'empty')
  await mkdir(empty)
  assert.deepEqual(await readTokprof({ since: '2026-11-13', until: '2026-11-16', environment: { PATH: empty }, home: directory }),
    { status: 'missing', reason: 'notFound' })
  // Without the command on PATH, the command comes from ~/.local/bin.
  await mkdir(join(directory, '.local'))
  execFileSync('cp', ['-R', bin, join(directory, '.local', 'bin')])
  assert.equal((await readTokprof({ since: '2026-11-13', until: '2026-11-16', environment: { PATH: empty, FAKE_TOKPROF_OUTPUT: folded(stateDirectory) }, home: directory, stateDirectory })).usd, 20)
})

test('the data has the child runs, the permissions, the sessions and the spend of the period, and no data for a period without activity', async t => {
  const directory = await temporary(t)
  const time = text => at(text)
  const spend = new DailySpend(undefined, { now: () => time('2026-11-16T09:00:00Z') },
    { schema: 1, day: '2026-11-16', usd: 0, warning: 'none', days: { '2026-11-13': { usd: 1.5, piUsd: 0.5 }, '2026-11-10': { usd: 9, piUsd: 0 } } })
  const run = (id, status, finishedAt, extra = {}) => ({ id, status, title: `Task ${id}`, prompt: 'Work', cwd: '/work/demo-app', agent: 'claude',
    createdAt: time('2026-11-13T10:00:00Z'), ...(finishedAt ? { finishedAt: time(finishedAt) } : {}), ...extra })
  const state = { workspaces: ['/work/demo-app'], projects: [], megachatWorkspace: join(directory, 'workspace'),
    inputs: { 'user-1': { admittedAt: time('2026-11-14T08:00:00Z') }, 'children:1': { admittedAt: time('2026-11-14T09:00:00Z') },
      'user-old': { admittedAt: time('2026-11-12T08:00:00Z') } },
    runs: { done: run('done', 'completed', '2026-11-13T11:00:00Z'), failed: run('failed', 'failed', '2026-11-15T11:00:00Z', { agent: 'codex' }),
      replaced: run('replaced', 'resumed', '2026-11-13T12:00:00Z'), running: run('running', 'approval', undefined, { agent: 'pi' }),
      old: run('old', 'completed', '2026-11-12T11:00:00Z', { createdAt: time('2026-11-12T10:00:00Z') }) },
    permissions: { p: { runId: 'running', status: 'pending', createdAt: time('2026-11-15T20:00:00Z') }, q: { runId: 'done', status: 'answered' } } }
  const sessionStore = { activeSessions: async (from, to) => {
    assert.deepEqual([iso(from), iso(to)], ['2026-11-13T00:00:00.000Z', '2026-11-16T00:00:00.000Z'])
    return [{ agent: 'claude', cwd: '/work/demo-app/module', title: 'Fix the parser' }, { agent: 'codex', cwd: '/work/demo-app', title: null },
      { agent: 'claude', cwd: '/elsewhere', title: 'Notes' }]
  } }
  const data = await collectReportData({ state, date: '2026-11-16', workday: UTC, spend, sessionStore, home: directory, stateDirectory: directory,
    environment: { PATH: join(directory, 'none') }, now: time('2026-11-16T09:00:00Z') })
  assert.deepEqual(data.period, { from: '2026-11-13', to: '2026-11-15', timezone: 'UTC' })
  assert.equal(data.userTurns, 1)
  assert.deepEqual(data.children, {
    done: [{ title: 'Task done', project: '/work/demo-app', agent: 'claude', status: 'completed' }],
    failed: [{ title: 'Task failed', project: '/work/demo-app', agent: 'codex', status: 'failed' }],
    running: [{ title: 'Task running', project: '/work/demo-app', agent: 'pi', status: 'approval' }],
  })
  assert.deepEqual(data.permissionsWaiting, [{ title: 'Task running', project: '/work/demo-app', agent: 'pi', status: 'approval', since: '2026-11-15T20:00:00.000Z' }])
  assert.deepEqual(data.sessions, { state: 'on', moreProjects: 0, projects: [
    { project: '/work/demo-app', sessions: 2, agents: { claude: 1, codex: 1 }, titles: ['Fix the parser'] },
    { project: '/elsewhere', sessions: 1, agents: { claude: 1 }, titles: ['Notes'] }] })
  assert.deepEqual(data.money.megachat, { paidBy: 'megachatKey', usd: 1.5, mainAgentUsd: 1, piChildrenUsd: 0.5, days: [
    { day: '2026-11-13', usd: 1.5, piChildrenUsd: 0.5 }, { day: '2026-11-14', usd: 0, piChildrenUsd: 0 }, { day: '2026-11-15', usd: 0, piChildrenUsd: 0 }] })
  assert.deepEqual(data.money.otherSessions, { paidBy: 'agentAccounts', costKind: 'apiEquivalent', status: 'missing', reason: 'notFound' })
  // The directory of the project is no git repository, so it has no commits.
  assert.deepEqual(data.commits, { projects: [], moreProjects: 0, unreadableProjects: 1 })
  // Without the index, the sessions part says so.
  const off = await collectReportData({ state, date: '2026-11-16', workday: UTC, spend, home: directory, environment: { PATH: join(directory, 'none') } })
  assert.deepEqual(off.sessions, { state: 'off' })
  // The period of Tuesday has no turn of the user, no child run and no spend.
  assert.equal(await collectReportData({ state, date: '2026-11-17', workday: UTC, spend, home: directory, environment: { PATH: join(directory, 'none') } }), null)
})

test('the commits of the period come from git log of each known project with a time limit', async t => {
  const directory = await temporary(t)
  const repository = join(directory, 'demo-app')
  await mkdir(repository)
  const git = (args, date) => execFileSync('git', ['-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', ...args], { cwd: repository,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
      ...(date ? { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : {}) } })
  git(['init', '-q'])
  git(['commit', '-q', '--allow-empty', '-m', 'An old change'], '2026-11-10T10:00:00Z')
  git(['commit', '-q', '--allow-empty', '-m', 'Fix the parser'], '2026-11-14T10:00:00Z')
  git(['commit', '-q', '--allow-empty', '-m', 'A change of today'], '2026-11-16T08:00:00Z')
  const spend = new DailySpend(undefined, { now: () => at('2026-11-16T09:00:00Z') },
    { schema: 1, day: '2026-11-16', usd: 0, warning: 'none', days: { '2026-11-14': { usd: 0.2, piUsd: 0 } } })
  const state = { workspaces: [repository], projects: [], inputs: {}, runs: {}, permissions: {} }
  const data = await collectReportData({ state, date: '2026-11-16', workday: UTC, spend, home: directory,
    environment: { ...process.env, PATH: ['/usr/bin', '/bin', '/usr/local/bin', '/opt/homebrew/bin'].join(':') } })
  assert.equal(data.commits.projects.length, 1)
  assert.equal(data.commits.projects[0].project, repository)
  assert.match(data.commits.projects[0].commits.join('\n'), /^[0-9a-f]{7,} Fix the parser$/)
  assert.equal(data.commits.projects[0].more, false)
})

test('the index gives the sessions with activity in the period', async t => {
  const directory = await temporary(t)
  const index = await SessionIndex.open(join(directory, 'sessions.sqlite'))
  t.after(() => index.close())
  const add = (id, started, updated) => index.db.run(`INSERT INTO sessions (agent, session_id, cwd, title, title_rank, started_at, updated_at)
    VALUES ('claude', ?, '/work/demo-app', ?, 0, ?, ?)`, id, `Session ${id}`, started === null ? null : at(started), at(updated))
  await add('before', '2026-11-10T10:00:00Z', '2026-11-12T10:00:00Z')
  await add('inside', '2026-11-13T10:00:00Z', '2026-11-13T12:00:00Z')
  await add('across', '2026-11-12T10:00:00Z', '2026-11-16T10:00:00Z')
  await add('after', '2026-11-16T08:00:00Z', '2026-11-16T10:00:00Z')
  await add('unknown-start', null, '2026-11-14T10:00:00Z')
  const rows = await index.activeSessions(at('2026-11-13T00:00:00Z'), at('2026-11-16T00:00:00Z'))
  assert.deepEqual(rows.map(row => row.title).sort(), ['Session across', 'Session inside', 'Session unknown-start'])
})

const text = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')

/**
 * A daemon with a fake model, a fake tokprof, and a fake clock that starts at the UTC time [start] for the timer and the
 * spend. `settings.json` holds [values], and `spend.json` the count of [spendToday] and the counts of [spendDays].
 */
async function daemonFixture(t, { start, values = {}, spendDays = {}, spendToday = { day: '2026-11-01', usd: 0 }, replies = [], storage, directory, tokprof = 'ok', settings = true }) {
  directory ??= await temporary(t)
  const stateDirectory = join(directory, 'state')
  const home = join(directory, 'home')
  await mkdir(stateDirectory, { recursive: true })
  await mkdir(home, { recursive: true })
  const project = join(directory, 'demo-app')
  await mkdir(project, { recursive: true })
  if (settings) {
    await writeFile(join(stateDirectory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done',
      values: { 'report.morning': true, 'workday.timezone': 'UTC', ...values } }), { mode: 0o600 })
  }
  await writeFile(join(stateDirectory, 'spend.json'), JSON.stringify({ schema: 1, ...spendToday, warning: 'none', days: spendDays }))
  const bin = await fakeTokprof(directory)
  const argsFile = join(directory, 'tokprof-args.jsonl')
  const environment = { PATH: [...(tokprof === 'none' ? [] : [bin]), '/usr/bin', '/bin'].join(':'), FAKE_TOKPROF_MODE: tokprof,
    FAKE_TOKPROF_OUTPUT: folded(stateDirectory), FAKE_TOKPROF_ARGS: argsFile }
  const clock = fakeClock(start)
  const fake = fauxProvider()
  const requests = []
  fake.setResponses(Array(50).fill(async (context, options) => {
    const prompt = context.messages.findLast(item => item.role === 'user')
    requests.push({ prompt: prompt ? text(prompt.content) : '', at: iso(clock.now()) })
    const reply = replies.shift()
    return typeof reply === 'function' ? reply(context, options) : fauxAssistantMessage(reply ?? 'Morning report text.')
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(storage ?? new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, undefined, {
    settingsPath: join(stateDirectory, 'settings.json'), spendPath: join(stateDirectory, 'spend.json'), stateDirectory, home,
    workspacePath: join(stateDirectory, 'workspace'), environment, clock, keepAlive: { enabled: false }, morningReport: { clock },
  })
  await service.state.addWorkspace(project)
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  let closed
  const close = () => closed ??= (async () => { await server.close(); await service.close() })()
  t.after(close)
  const advance = ms => clock.advance(ms, () => service.morningReport.running)
  const reports = async () => Object.entries((await service.state.snapshot()).inputs).filter(([id]) => id.startsWith('morning:')).map(([, input]) => input)
  const settled = () => waitForState(service.state, state => !state.current && !state.morningReport.pending ? state : undefined)
  return { service, daemon, requests, clock, advance, reports, settled, close, directory, stateDirectory, project, argsFile, fake }
}

const reportData = request => JSON.parse(request.prompt.slice(request.prompt.indexOf('\n') + 1))
const ACTIVE = { '2026-11-13': { usd: 1.25, piUsd: 0.25 } }

test('the report is one automatic turn at the start of the day, with the data in its prompt and the two kinds of money apart', { timeout: 20000 }, async t => {
  const { service, requests, advance, reports, settled, stateDirectory } = await daemonFixture(t, { start: '2026-11-16T08:50:00Z', spendDays: ACTIVE })
  const lines = await logLines(t, async () => {
    await service.resume()
    await advance(9 * MINUTE)
    assert.deepEqual(await reports(), [])
    await advance(MINUTE)
    await settled()
  })
  assert.equal((await reports()).length, 1)
  assert.equal((await reports())[0].status, 'completed')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].at, '2026-11-16T09:00:00.000Z')
  assert.ok(requests[0].prompt.startsWith(message('event.morning')))
  const data = reportData(requests[0])
  assert.deepEqual(data.period, { from: '2026-11-13', to: '2026-11-15', timezone: 'UTC' })
  // The key of Megachat paid the main agent and the pi children. The pi line of the state directory is not in the tokprof part.
  assert.deepEqual([data.money.megachat.paidBy, data.money.megachat.usd, data.money.megachat.piChildrenUsd], ['megachatKey', 1.25, 0.25])
  assert.deepEqual([data.money.otherSessions.paidBy, data.money.otherSessions.costKind, data.money.otherSessions.status, data.money.otherSessions.usd,
    data.money.otherSessions.agents.pi, data.money.otherSessions.excludedPiChildUsd], ['agentAccounts', 'apiEquivalent', 'ok', 20, 1, 0.7])
  assert.ok(!JSON.stringify(data.money.otherSessions).includes(stateDirectory))
  const state = await service.state.snapshot()
  assert.deepEqual(state.morningReport, { lastDate: '2026-11-16', pending: null, running: null })
  assert.ok(lines.some(line => line.includes('The morning report of 2026-11-16 waits for its turn.')))
})

test('a period without activity gives no turn, and the state keeps the date', { timeout: 20000 }, async t => {
  const { service, requests, reports, argsFile } = await daemonFixture(t, { start: '2026-11-16T09:30:00Z' })
  const lines = await logLines(t, async () => {
    await service.resume()
    await service.morningReport.running
  })
  assert.deepEqual(await reports(), [])
  assert.equal(requests.length, 0)
  assert.equal((await service.state.snapshot()).morningReport.lastDate, '2026-11-16')
  assert.ok(lines.some(line => line.includes('had no activity, so no report goes out')))
  // The check of the activity comes first, so tokprof does not run.
  await assert.rejects(readFile(argsFile))
})

test('without tokprof, the data says that the money of the other sessions is missing', { timeout: 20000 }, async t => {
  const { service, requests, settled } = await daemonFixture(t, { start: '2026-11-16T09:30:00Z', spendDays: ACTIVE, tokprof: 'none' })
  await logLines(t, async () => {
    await service.resume()
    await service.morningReport.running
    await settled()
  })
  const data = reportData(requests[0])
  assert.deepEqual(data.money.otherSessions, { paidBy: 'agentAccounts', costKind: 'apiEquivalent', status: 'missing', reason: 'notFound' })
  assert.equal(data.money.megachat.usd, 1.25)
  assert.match(requests[0].prompt, /When money\.otherSessions\.status is missing, say that this part is missing/)
})

test('with report.morning off, and with an old settings.json, no report and no tokprof run happen', { timeout: 20000 }, async t => {
  for (const options of [{ values: { 'report.morning': false } }, { settings: false }]) {
    const { service, requests, advance, argsFile, reports } = await daemonFixture(t, { start: '2026-11-16T08:00:00Z', spendDays: ACTIVE, ...options })
    await service.resume()
    await advance(3 * DAY)
    assert.equal(service.morningReport.timer, undefined)
    assert.deepEqual(await reports(), [])
    assert.equal(requests.length, 0)
    await assert.rejects(readFile(argsFile))
    assert.equal((await service.state.snapshot()).morningReport.lastDate, null)
  }
})

test('a restart on the same day sends no second report, and an old state without the report opens', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  const database = join(directory, 'conversation.sqlite')
  const spendToday = { day: '2026-11-16', usd: 0.5 }
  const first = await daemonFixture(t, { directory, start: '2026-11-16T09:10:00Z', spendDays: ACTIVE, spendToday, storage: await openNodeSqliteStorage(database) })
  await logLines(t, async () => {
    await first.service.resume()
    await first.service.morningReport.running
    await first.settled()
  })
  assert.equal((await first.reports()).length, 1)
  await first.close()
  const second = await daemonFixture(t, { directory, start: '2026-11-16T11:00:00Z', spendDays: ACTIVE, spendToday, storage: await openNodeSqliteStorage(database) })
  await logLines(t, async () => {
    await second.service.resume()
    await second.service.morningReport.running
    assert.equal((await second.reports()).length, 1)
    await second.advance(22 * HOUR)
    await second.settled()
  })
  assert.equal((await second.reports()).length, 2)
  assert.equal(second.requests[0].at, '2026-11-17T09:00:00.000Z')
  assert.equal((await second.service.state.snapshot()).morningReport.lastDate, '2026-11-17')
  await second.close()
  // A state of an earlier build has no record of the report.
  const old = await daemonFixture(t, { directory, start: '2026-11-17T12:00:00Z', storage: await openNodeSqliteStorage(database) })
  await old.service.state.change(state => { delete state.morningReport })
  await old.close()
  const opened = await daemonFixture(t, { directory, start: '2026-11-17T12:00:00Z', storage: await openNodeSqliteStorage(database) })
  assert.deepEqual((await opened.service.state.snapshot()).morningReport, { lastDate: null, pending: null, running: null })
})

/** Collects the results of the tool calls of a transcript, in their order. */
function toolResults(value, found = []) {
  if (Array.isArray(value)) for (const item of value) toolResults(item, found)
  else if (value && typeof value === 'object') {
    if (value.role === 'toolResult') found.push({ isError: value.isError, text: text(value.content) })
    else for (const item of Object.values(value)) toolResults(item, found)
  }
  return found
}

test('the report turn refuses each tool that starts or changes something', { timeout: 20000 }, async t => {
  let results
  const calls = cwd => [
    ['agents_spawn', { cwd, prompt: 'Start a task.' }],
    ['agents_send', { childSessionId: 'child', cwd, prompt: 'More.' }],
    ['agents_steer', { childSessionId: 'child', prompt: 'More.' }],
    ['agents_settings', { action: 'set', key: 'reply.length', value: 'detailed' }],
    ['agents_settings', { action: 'onboarding', status: 'pending' }],
    ['agents_projects', { action: 'create', name: 'demo-new' }],
    ['agents_projects', { action: 'remove', cwd }],
    ['agents_close', { childSessionId: 'child' }],
    ['agents_cancel', { runId: 'run' }],
    ['agents_accounts', {}],
  ]
  let project
  const replies = [...Array(10).keys()].map(index => () => fauxAssistantMessage(fauxToolCall(...calls(project)[index]), { stopReason: 'toolUse' }))
  replies.push(context => { results = toolResults(context.messages); return fauxAssistantMessage('Report.') })
  const fixture = await daemonFixture(t, { start: '2026-11-16T09:30:00Z', spendDays: ACTIVE, replies })
  project = fixture.project
  const before = await readFile(join(fixture.stateDirectory, 'settings.json'), 'utf8')
  await logLines(t, async () => {
    await fixture.service.resume()
    await fixture.service.morningReport.running
    await fixture.settled()
  })
  const codes = ['proposalOnly', 'proposalOnly', 'steerEvent', 'settingEvent', 'settingEvent', 'proposalOnly', 'morningReport', 'morningReport',
    'proposalOnly', 'morningReport']
  assert.equal(results.length, codes.length)
  codes.forEach((code, index) => assert.ok(results[index].text.includes(message(`error.${code}`)), `${index} ${results[index].text}`))
  assert.ok(results.every(result => result.isError))
  const state = await fixture.service.state.snapshot()
  assert.deepEqual(state.runs, {})
  assert.deepEqual(state.workspaces, [project])
  assert.equal(await readFile(join(fixture.stateDirectory, 'settings.json'), 'utf8'), before)
})

test('a user message interrupts the report, and the report runs again one time', { timeout: 20000 }, async t => {
  const started = [Promise.withResolvers(), Promise.withResolvers()]
  const hang = index => async (_context, options) => {
    started[index].resolve()
    await new Promise(resolve => options.signal.addEventListener('abort', resolve, { once: true }))
    return fauxAssistantMessage('Cut.', { stopReason: 'aborted' })
  }
  const { service, daemon, reports, requests, settled } = await daemonFixture(t, { start: '2026-11-16T09:30:00Z', spendDays: ACTIVE,
    replies: [hang(0), 'First answer.', hang(1), 'Second answer.'] })
  await logLines(t, async () => {
    await service.resume()
    await started[0].promise
    const first = await daemon.json('/input', { requestId: 'user-1', text: 'My question comes first.' })
    await daemon.json(`/wait?submission=${first.submissionId}`)
    await started[1].promise
    const second = await daemon.json('/input', { requestId: 'user-2', text: 'Another question.' })
    await daemon.json(`/wait?submission=${second.submissionId}`)
    await settled()
  })
  assert.deepEqual((await reports()).map(input => input.status), ['cancelled', 'cancelled'])
  // The repeat has the same data, and no third report follows.
  assert.equal(requests.filter(request => request.prompt.startsWith(message('event.morning'))).length, 2)
  assert.deepEqual((await service.state.snapshot()).morningReport, { lastDate: '2026-11-16', pending: null, running: null })
})

/** Attaches an ACP client to the daemon and collects its updates. */
async function attach(t, daemon, cwd) {
  const updates = []
  const connection = client({ name: 'test-air' }).onNotification('*', ({ params }) => { updates.push(params) }).connect(new AcpBridge(daemon).app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  return updates
}

const shows = (updates, value) => updates.some(event => event.update?.sessionUpdate === 'agent_message_chunk' && event.update.content?.text?.includes(value))

test('a connected client gets the report as it comes, and a client that connects later finds it in the conversation', { timeout: 20000 }, async t => {
  const connected = await daemonFixture(t, { start: '2026-11-16T08:55:00Z', spendDays: ACTIVE })
  await connected.service.resume()
  const updates = await attach(t, connected.daemon, connected.project)
  await logLines(t, async () => {
    await connected.advance(5 * MINUTE)
    await connected.settled()
  })
  for (let attempt = 0; attempt < 200 && !shows(updates, 'Morning report text.'); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(shows(updates, 'Morning report text.'))
  // Without a client, the reply stays in the conversation, and the replay of the next attach shows it without the prompt.
  const alone = await daemonFixture(t, { start: '2026-11-16T09:30:00Z', spendDays: ACTIVE })
  await logLines(t, async () => {
    await alone.service.resume()
    await alone.service.morningReport.running
    await alone.settled()
  })
  const later = await attach(t, alone.daemon, alone.project)
  assert.ok(shows(later, 'Morning report text.'))
  assert.ok(!later.some(event => event.update?.content?.text?.includes(message('event.morning').slice(0, 40))))
  assert.equal((await alone.reports()).length, 1)
})

test('turning the report on after the start of a working day keeps the first report for the next working day', { timeout: 20000 }, async t => {
  const { service, reports, advance, settled } = await daemonFixture(t, { start: '2026-11-16T10:00:00Z', spendDays: ACTIVE,
    spendToday: { day: '2026-11-16', usd: 0.4 }, values: { 'report.morning': false } })
  await service.resume()
  const tool = service.extension().tools.find(item => item.name === 'agents_settings')
  await logLines(t, async () => {
    await tool.execute({ action: 'set', key: 'report.morning', value: true })
    await service.morningReport.running
    assert.deepEqual(await reports(), [])
    assert.equal((await service.state.snapshot()).morningReport.lastDate, '2026-11-16')
    await advance(DAY)
    await settled()
  })
  assert.equal((await reports()).length, 1)
  assert.equal((await service.state.snapshot()).morningReport.lastDate, '2026-11-17')
})

test('spend.json keeps the spend of the last 31 earlier days with the part of the pi children, and a file of an earlier build opens', async t => {
  const directory = await temporary(t)
  const path = join(directory, 'spend.json')
  // A file of an earlier build has no earlier days and no part of the pi children.
  await writeFile(path, JSON.stringify({ schema: 1, day: '2026-10-01', usd: 0.5, warning: 'none' }))
  let now = new Date(2026, 9, 1, 12).getTime()
  const spend = await DailySpend.open(path, { now: () => now })
  spend.add(0.25, 0, 'pi')
  for (let day = 2; day <= 40; day++) {
    now = new Date(2026, 9, day, 12).getTime()
    spend.add(1, 0)
  }
  await spend.save()
  const reopened = await DailySpend.open(path, { now: () => now })
  // Today is 2026-11-09. The file keeps 2026-10-09 to 2026-11-08, and the older days go.
  const days = reopened.daily(['2026-10-01', '2026-10-08', '2026-10-09', '2026-11-08', '2026-11-09'])
  assert.deepEqual(days, [{ day: '2026-10-01', usd: 0, piUsd: 0 }, { day: '2026-10-08', usd: 0, piUsd: 0 }, { day: '2026-10-09', usd: 1, piUsd: 0 },
    { day: '2026-11-08', usd: 1, piUsd: 0 }, { day: '2026-11-09', usd: 1, piUsd: 0 }])
  assert.equal(Object.keys(reopened.data.days).length, 31)
  // The count of the pi children goes with its day into the earlier days.
  const early = await DailySpend.open(undefined, { now: () => new Date(2026, 9, 2, 12).getTime() })
  early.data = { schema: 1, day: '2026-10-01', usd: 0.75, piUsd: 0.25, warning: 'none' }
  assert.deepEqual(early.daily(['2026-10-01']), [{ day: '2026-10-01', usd: 0.75, piUsd: 0.25 }])
})

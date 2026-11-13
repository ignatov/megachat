// The daemon of the tests of the working day: a service with a fake model, a fake tokprof, and a fake clock.
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { fakeClock } from './fake-clock.mjs'

export const at = text => Date.parse(text)
export const iso = ms => new Date(ms).toISOString()

export async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-report-')))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  return directory
}

/** Runs [body] and returns the lines that it wrote to the standard error. */
export async function logLines(t, body) {
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
export async function fakeTokprof(directory) {
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
export const folded = stateDirectory => [
  'claude;~/src/demo-app;prompt 12500000',
  'claude;~/src/demo-app;agent:Explore 2500000',
  'codex;~/src/demo-tool;prompt 4000000',
  'pi;~/src/demo-tool;prompt 1000000',
  `pi;${join(stateDirectory, 'workspace')};prompt 700000`,
].join('\n')

export const text = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')

/**
 * A daemon with a fake model, a fake tokprof, and a fake clock that starts at the UTC time [start] for the timer and the
 * spend. `settings.json` holds [values], and `spend.json` the count of [spendToday] and the counts of [spendDays]. The
 * state gets one earlier turn of the user at each UTC time of [userTurns]. The model has prices, so each turn costs money.
 * The state lists the directories of [knownProjects] in the home directory as known repositories, by default the two
 * projects of [folded], so that its lines count in the tokprof part. [tokprofOutput] replaces the output of [folded].
 */
export async function daemonFixture(t, { start, values = {}, spendDays = {}, spendToday = { day: '2026-11-01', usd: 0 }, userTurns = [], replies = [], storage,
  directory, tokprof = 'ok', tokprofOutput, knownProjects = ['src/demo-app', 'src/demo-tool'], settings = true, keepAlive = { enabled: false }, accountCheck }) {
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
    FAKE_TOKPROF_OUTPUT: tokprofOutput ?? folded(stateDirectory), FAKE_TOKPROF_ARGS: argsFile }
  const clock = fakeClock(start)
  const fake = fauxProvider({ models: [{ id: 'priced', cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } }] })
  const requests = []
  fake.setResponses(Array(100).fill(async (context, options) => {
    const prompt = context.messages.findLast(item => item.role === 'user')
    requests.push({ prompt: prompt ? text(prompt.content) : '', at: iso(clock.now()), kind: options.maxTokens === 1 ? 'ping' : 'turn' })
    const reply = replies.shift()
    return typeof reply === 'function' ? reply(context, options) : fauxAssistantMessage(reply ?? 'Morning report text.')
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(storage ?? new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, undefined, {
    settingsPath: join(stateDirectory, 'settings.json'), spendPath: join(stateDirectory, 'spend.json'), stateDirectory, home,
    workspacePath: join(stateDirectory, 'workspace'), environment, clock, keepAlive: { clock, minTokens: 1000, ...keepAlive }, morningReport: { clock },
    accountCheck,
  })
  await service.state.addWorkspace(project)
  const known = knownProjects.map(name => join(home, name))
  for (const path of known) await mkdir(path, { recursive: true })
  await service.state.change(state => {
    for (const path of known) if (!state.projects.includes(path)) state.projects.push(path)
    for (const time of userTurns) state.inputs[`user-${time}`] = { digest: time, mainRunId: time, submissionId: 0, status: 'completed', admittedAt: at(time) }
  })
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  let closed
  const close = () => closed ??= (async () => { await server.close(); await service.close() })()
  t.after(close)
  const advance = ms => clock.advance(ms, () => Promise.all([service.morningReport.running, service.keepAlive?.running, service.waitCheck]))
  const reports = async () => Object.entries((await service.state.snapshot()).inputs).filter(([id]) => id.startsWith('morning:')).map(([, input]) => input)
  const settled = () => waitForState(service.state, state => !state.current && !state.morningReport.pending ? state : undefined)
  return { service, daemon, requests, clock, advance, reports, settled, close, directory, stateDirectory, home, project, argsFile, fake }
}

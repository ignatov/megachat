import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { ChildPool } from '../src/ChildPool.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { PiRunService } from '../src/PiRunService.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { fakeModels, MAIN } from './parallel-models.mjs'

// A daemon for the test of a kill with several children in flight. `first` starts an ACP run in the directory a and a
// pi run in the directory b, and it queues one more ACP run in a. Then it waits for the kill. `second` opens the same
// state and runs each task to its end.
const [mode, directory] = process.argv.slice(2)
const a = join(directory, 'a')
const b = join(directory, 'b')
const hang = (_request, options) => new Promise(resolve => {
  options.signal?.addEventListener('abort', () => resolve(fauxAssistantMessage('Too late.')), { once: true })
})

async function open(child) {
  for (const path of [a, b]) await mkdir(path, { recursive: true })
  await writeFile(join(b, 'README.md'), 'The README of the project b.')
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN } }), { mode: 0o600 })
  const { models, requests } = fakeModels([], child)
  const service = await PiMegachatService.open(await openNodeSqliteStorage(join(directory, 'conversation.sqlite')), models, undefined, {},
    { settingsPath: join(directory, 'settings.json'), spendPath: join(directory, 'spend.json'), keepAlive: { enabled: false }, environment: {}, resumeDelayMs: 0 })
  for (const path of [a, b]) await service.state.addWorkspace(path)
  const pool = new ChildPool({ limit: () => service.settings.entry('children.parallel').value })
  const pi = new PiRunService(service.state, service.harness, { agent: path => service.childAgent(path), pool })
  await pi.start()
  const children = new AcpRunService(service.state, { childLaunch: async () => ({ env: process.env }) },
    { args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], pool })
  await children.start()
  await service.resume()
  return { service, requests }
}

const dispatches = async () => (await readFile(join(a, 'dispatches'), 'utf8').catch(() => '')).split('\n').filter(Boolean)

if (mode === 'first') {
  const { service, requests } = await open([hang])
  await service.state.change(state => { state.current = { id: 'user', requestId: 'user', cancelling: false, kind: 'user' } })
  const acp = await service.state.admitChild('spawn-acp', { cwd: a, prompt: 'wait', agent: 'claude' })
  const pi = await service.state.admitChild('spawn-pi', { cwd: b, prompt: 'Read the README.', agent: 'pi' })
  const queued = await service.state.admitChild('spawn-queued', { cwd: a, prompt: 'hello', agent: 'claude' })
  await service.state.change(state => { state.current = null })
  await waitForState(service.state, state => state.runs[acp.id].status === 'dispatched' && state.runs[pi.id].status === 'dispatched' ? true : undefined)
  while (!(await dispatches()).includes('wait') || !requests.some(request => request.child)) await new Promise(resolve => setTimeout(resolve, 10))
  process.send({ acp: acp.id, pi: pi.id, queued: queued.id })
}
else {
  const { service, requests } = await open([fauxAssistantMessage('Done after the restart.')])
  const state = await waitForState(service.state, value => !value.current && Object.values(value.runs).length >= 4
    && Object.values(value.runs).every(run => terminalStates.has(run.status) && run.reported) ? value : undefined, { timeoutMs: 30000 })
  process.send({
    runs: Object.values(state.runs).map(run => ({ id: run.id, status: run.status, output: run.output, resumeOf: run.resumeOf, resumedBy: run.resumedBy,
      resumeAttempt: run.resumeAttempt, providerSessionId: run.providerSessionId, startedAt: run.startedAt, finishedAt: run.finishedAt })),
    reports: Object.values(state.inputs).filter(input => input.resultRunIds).map(input => input.resultRunIds),
    dispatches: await dispatches(),
    childRequests: requests.filter(request => request.child).length,
  })
  await service.close()
  process.exit()
}

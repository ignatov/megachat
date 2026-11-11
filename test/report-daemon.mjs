import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'

// A main agent without a daemon server, for the test of a result report that a kill of its process cuts.
// `first` starts the report of a finished child run and stays in the model request. `second` opens the same state.
const [mode, database] = process.argv.slice(2)
async function open(responses) {
  const fake = fauxProvider()
  fake.setResponses(responses)
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  return PiMegachatService.open(await openNodeSqliteStorage(database), models, { provider: model.provider, modelId: model.id },
    undefined, { reportRetryDelayMs: 20 })
}
if (mode === 'first') {
  const service = await open([fauxAssistantMessage('Delegated.'), async () => {
    process.send('report')
    await new Promise(() => {})
  }])
  await service.state.addWorkspace('/workspace')
  const main = await service.state.submit('main', 'Work')
  const run = await service.state.admitChild('tool', { cwd: '/workspace', prompt: 'Implement it' })
  await service.state.transition(run.id, ['admitted'], { status: 'completed' })
  service.follow(main)
  await service.resume()
}
else {
  const service = await open([fauxAssistantMessage('The report after the restart.')])
  await service.resume()
  const state = await waitForState(service.state, state => {
    const reports = Object.values(state.inputs).filter(input => input.resultRunIds)
    return !state.current && reports.length === 2 && reports.every(report => report.status !== 'running') ? state : undefined
  }, { timeoutMs: 15000 })
  process.send({
    reports: Object.values(state.inputs).filter(input => input.resultRunIds).map(input => [input.status, input.reason ?? null]),
    reported: Object.values(state.runs).map(run => run.reported),
  })
  await service.close()
  process.exit()
}

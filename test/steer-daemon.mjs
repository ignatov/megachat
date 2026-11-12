import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { waitForState } from '../src/waitForState.mjs'

// A daemon for the test of steer messages that a kill of the daemon cuts. `first` starts a child that waits for a
// permission, and records three messages: the agent takes the first, gives no answer to the second, and the third waits
// for the second. Then it waits for the kill. `second` opens the same state and runs the continuation to its end.
const [mode, directory] = process.argv.slice(2)
async function open(responses) {
  const fake = fauxProvider()
  fake.setResponses(responses)
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(await openNodeSqliteStorage(join(directory, 'conversation.sqlite')), models,
    { provider: model.provider, modelId: model.id }, undefined, { resumeDelayMs: 0 })
  await service.state.addWorkspace(directory)
  const children = new AcpRunService(service.state, { childLaunch: async () => ({ env: process.env }) },
    { args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))] })
  await children.start()
  await service.resume()
  return service
}
if (mode === 'first') {
  const service = await open([
    fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd: directory, prompt: 'approval' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage('Delegated.'),
    // The second turn of the user stays in its model request, so the messages come from a turn of the user.
    async () => { await new Promise(() => {}) },
  ])
  await service.submit('work', 'Work')
  const [run] = Object.values((await waitForState(service.state, state => Object.values(state.permissions).length ? state : undefined)).runs)
  await service.submit('more', 'Add more')
  await waitForState(service.state, state => state.current?.requestId === 'more' ? true : undefined)
  const steer = (requestId, prompt) => service.state.steer(requestId, { childSessionId: run.childSessionId, prompt, mode: 'queue' })
  const first = await steer('first', 'First message')
  await waitForState(service.state, state => state.runs[run.id].steers.find(item => item.id === first.id).delivery === 'delivered' ? true : undefined)
  const second = await steer('second', 'Second message')
  await waitForState(service.state, state => state.runs[run.id].steers.find(item => item.id === second.id).sentAt ? true : undefined)
  // The state records `sentAt` before the request goes out, so a kill after it can come before the agent has the
  // request. The test counts the requests that the agent got, so it waits until the agent wrote the second one.
  while ((await readFile(join(directory, 'steerings'), 'utf8').catch(() => '')).trim().split('\n').length < 2) {
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  await steer('third', 'Third message')
  process.send('steered')
}
else {
  const service = await open(Array.from({ length: 4 }, () => fauxAssistantMessage('Done.')))
  const state = await waitForState(service.state, state => Object.values(state.runs).length === 2
    && Object.values(state.runs).every(run => terminalStates.has(run.status)) ? state : undefined, { timeoutMs: 15000 })
  const prompts = (await readFile(join(directory, 'prompts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  process.send({ runs: Object.values(state.runs).map(run => ({ status: run.status, steers: run.steers?.map(item =>
    ({ text: item.text, delivery: item.delivery, repeat: item.repeat ?? false })) })), prompt: prompts.at(-1).at(-1),
  permissions: Object.values(state.permissions).map(permission => permission.status) })
  await service.close()
  process.exit()
}

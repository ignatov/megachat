import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { DaemonDirectory } from '../src/DaemonDirectory.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'

const directory = process.argv[2]
const owner = await DaemonDirectory.acquire(directory)
const fake = fauxProvider()
fake.setResponses([
  fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd: directory, prompt: 'approval' }), { stopReason: 'toolUse' }),
  fauxAssistantMessage('Delegated.'),
  fauxAssistantMessage('The child finished.'),
  fauxAssistantMessage('The child resumed.'),
])
const models = createModels()
models.setProvider(fake.provider)
const model = fake.getModel()
const service = await PiMegachatService.open(await openNodeSqliteStorage(join(directory, 'conversation.sqlite')),
  models, { provider: model.provider, modelId: model.id }, undefined, { searchPath: join(directory, 'search.sqlite'), resumeDelayMs: 0 })
await service.search.catchUp()
await service.state.addWorkspace(directory)
const server = new DaemonServer(service)
const descriptor = await server.listen()
const children = new AcpRunService(service.state, { childLaunch: async () => ({ env: process.env }) }, {
  args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))],
  historyServer: server.historyConfiguration(),
})
await children.start()
await service.resume()
await owner.publish(descriptor)
process.send('ready')
process.once('SIGTERM', async () => { await server.close(); await children.close(); await service.close(); await owner.close(); process.exit() })

// A daemon of a state directory for `test/agent-stop.test.mjs`, with a fake model and a fake child agent. It stops at
// `/shutdown`, as the daemon of `src/main.mjs` does. The mode selects the replies of the model:
// - `idle`: each request gets the reply `Answer.`.
// - `child`: the first turn starts a child that waits for a permission request, and then the turn ends.
// - `turn`: the first request waits until the test sends the IPC message `release`.
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { DaemonDirectory } from '../src/DaemonDirectory.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'

const [directory, mode] = process.argv.slice(2)
const owner = await DaemonDirectory.acquire(directory)
const fake = fauxProvider()
let release
const released = new Promise(resolve => { release = resolve })
process.on('message', value => { if (value === 'release') release() })
fake.setResponses(mode === 'child' ? [
  fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd: directory, prompt: 'approval' }), { stopReason: 'toolUse' }),
  fauxAssistantMessage('Delegated.'),
] : mode === 'turn' ? [async () => { await released; return fauxAssistantMessage('Answer.') }]
  : Array.from({ length: 20 }, () => fauxAssistantMessage('Answer.')))
const models = createModels()
models.setProvider(fake.provider)
const model = fake.getModel()
const service = await PiMegachatService.open(await openNodeSqliteStorage(join(directory, 'conversation.sqlite')),
  models, { provider: model.provider, modelId: model.id }, undefined, { searchPath: join(directory, 'search.sqlite'), resumeDelayMs: 0,
    settingsPath: join(directory, 'settings.json'), memoryPath: join(directory, 'memory.md'), keepAlive: { enabled: false }, environment: {} })
await service.search.catchUp()
await service.state.addWorkspace(directory)
let children
let server
let stopping
const shutdown = () => stopping ??= (async () => {
  await server.close()
  await children.close()
  await service.close()
  await owner.close()
  process.exit(0)
})()
server = new DaemonServer(service, () => shutdown().catch(() => process.exit(1)))
const descriptor = await server.listen()
children = new AcpRunService(service.state, { childLaunch: async () => ({ env: process.env }) }, {
  args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))],
  historyServer: server.historyConfiguration(),
})
await children.start()
await service.resume()
await owner.publish(descriptor)
process.send('ready')
process.once('SIGTERM', () => shutdown())

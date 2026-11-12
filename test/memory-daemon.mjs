import { join } from 'node:path'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { PiMegachatService } from '../src/PiMegachatService.mjs'

// A main agent whose turn calls agents_memory with the action of the third argument, as JSON. At the hook of the second
// argument, the write sends `cut` and stops, so that the test can kill the process at that point of the write.
const [directory, point, args] = process.argv.slice(2)
const fake = fauxProvider()
fake.setResponses([fauxAssistantMessage(fauxToolCall('agents_memory', JSON.parse(args)), { stopReason: 'toolUse' })])
const models = createModels()
models.setProvider(fake.provider)
const model = fake.getModel()
const service = await PiMegachatService.open(await openNodeSqliteStorage(join(directory, 'conversation.sqlite')), models,
  { provider: model.provider, modelId: model.id }, undefined, { settingsPath: join(directory, 'settings.json'),
    memoryPath: join(directory, 'memory.md'), searchPath: join(directory, 'search.sqlite'), keepAlive: { enabled: false }, environment: {},
    memory: { hooks: { [point]: () => { process.send('cut'); return new Promise(() => {}) } } } })
await service.state.addWorkspace(directory)
await service.resume()
await service.submit('first', 'I write Kotlin.')

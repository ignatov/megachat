import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'

/** The free model of the main agent and of the pi children in the tests of the parallel children. */
export const MAIN = 'faux/big'

/** A reply that calls each tool of [calls], each one a pair of the name and the arguments. */
export const call = (...calls) => fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: 'toolUse' })

/** The tools of a request. Pi Durable sends a changed tool set as a later system message, so the replay gives them. */
function toolsOf(messages) {
  const tools = new Set()
  for (const item of messages) {
    if (item.role !== 'system') continue
    for (const tool of item.toolsAdded ?? []) tools.add(tool.name)
    for (const tool of item.toolsRemoved ?? []) tools.delete(tool.name ?? tool)
  }
  return tools
}

/**
 * A fake provider. A request with the tool `read` is a request of a pi child, and it gets the next reply of [child].
 * Each other request gets the next reply of [main]. A reply can be a function of the request, and an empty list gives
 * a short answer.
 */
export function fakeModels(main, child) {
  const fake = fauxProvider({ models: [{ id: 'big', cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
  const requests = []
  fake.setResponses(Array(300).fill((request, options) => {
    const isChild = toolsOf(request.messages).has('read')
    requests.push({ child: isChild, messages: JSON.stringify(request.messages) })
    const reply = (isChild ? child : main).shift() ?? fauxAssistantMessage(isChild ? 'Child answer.' : 'Answer.')
    return typeof reply === 'function' ? reply({ ...request, text: JSON.stringify(request.messages) }, options) : reply
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  return { models, requests }
}

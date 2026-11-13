import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'

/**
 * A daemon on a fake model. [turn] gives the replies of the next model requests. A reply of `gate()` waits until the
 * test calls its `open`, so a turn runs as long as the test needs.
 */
async function fixture(t) {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'megachat-prompt-wait-')))
  const fake = fauxProvider()
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { suggestions: 'off', keepAlive: { enabled: false } })
  await service.state.addWorkspace(cwd)
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  const gates = []
  t.after(async () => {
    for (const gate of gates) gate.open()
    await server.close()
    await service.close()
    await rm(cwd, { force: true, recursive: true })
  })
  const requests = []
  // A gate also ends at the abort of its model request, so a stop of its turn ends the turn.
  const turn = (...replies) => fake.setResponses(replies.map(reply => async (context, options) => {
    requests.push(reply)
    if (!reply.wait) return reply
    await Promise.race([reply.wait, new Promise(resolve => options?.signal?.addEventListener('abort', resolve, { once: true }))])
    return fauxAssistantMessage(reply.text)
  }))
  const gate = text => {
    let open
    const wait = new Promise(resolve => { open = resolve })
    const value = { text, wait, open }
    gates.push(value)
    return value
  }
  return { cwd, service, server, daemon, turn, gate, requests }
}

async function view(t, daemon, cwd) {
  const updates = []
  const connection = client({ name: 'test-air' })
    .onNotification('*', ({ params }) => { updates.push(params) })
    .connect(new AcpBridge(daemon).app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const prompt = (text, clientMessageId) => connection.agent.request(methods.agent.session.prompt,
    { sessionId, prompt: [{ type: 'text', text }], _meta: { jetbrains: { air: { clientMessageId } } } })
  const texts = () => updates.filter(event => event.update.sessionUpdate === 'agent_message_chunk').map(event => event.update.content.text)
  return { connection, sessionId, prompt, texts }
}

/**
 * Starts a user turn that the view does not know about, as the daemon has after its restart: it continues the turn of
 * the last daemon, and the new bridge sent no prompt for it. The daemon does not interrupt a user turn for a new input.
 */
const unknownTurn = service => service.submit('turn-0', 'Fix the lexer')

const until = async (condition, text) => {
  for (let attempt = 0; attempt < 500; attempt++) { if (await condition()) return; await sleep(10) }
  assert.fail(text)
}

test('a prompt during a user turn that the view does not know waits for the end of that turn and then runs its own turn', { timeout: 20000 }, async t => {
  const { cwd, service, daemon, turn, gate, requests } = await fixture(t)
  const viewer = await view(t, daemon, cwd)
  const first = gate('The lexer reads each token now.')
  turn(first, fauxAssistantMessage('The parser reads each line now.'))
  await unknownTurn(service)
  await until(() => requests.length === 1, 'The first turn did not start.')
  let answer
  const prompt = viewer.prompt('Fix the parser', 'turn-1').then(value => { answer = value })
  // The daemon refuses the input while the first turn runs, so the prompt waits and the state has no input.
  await sleep(300)
  assert.equal(answer, undefined)
  assert.equal((await service.state.snapshot()).inputs['turn-1'], undefined)
  first.open()
  await prompt
  assert.equal(answer.stopReason, 'end_turn')
  assert.equal((await service.state.snapshot()).inputs['turn-1'].status, 'completed')
  assert.ok(viewer.texts().includes('The parser reads each line now.'))
  assert.equal((await service.state.snapshot()).inputs['turn-0'].status, 'completed')
})

test('a stop of a prompt that waits for another turn ends the prompt and stops that turn', { timeout: 20000 }, async t => {
  const { cwd, service, daemon, turn, gate, requests } = await fixture(t)
  const viewer = await view(t, daemon, cwd)
  turn(gate('The lexer reads each token now.'))
  await unknownTurn(service)
  await until(() => requests.length === 1, 'The first turn did not start.')
  const prompt = viewer.prompt('Fix the parser', 'turn-1')
  await sleep(300)
  await viewer.connection.agent.notify(methods.agent.session.cancel, { sessionId: viewer.sessionId })
  assert.equal((await prompt).stopReason, 'cancelled')
  await waitForState(service.state, state => state.current === null ? true : undefined, { timeoutMs: 10000 })
  const { inputs } = await service.state.snapshot()
  assert.equal(inputs['turn-1'], undefined)
  assert.notEqual(inputs['turn-0'].status, 'running')
})

test('a prompt that loses its daemon ends with a notice of Megachat and not with the error of the connection', { timeout: 20000 }, async t => {
  const { cwd, server, daemon, turn, gate, requests } = await fixture(t)
  const viewer = await view(t, daemon, cwd)
  turn(gate('The parser reads each line now.'))
  const prompt = viewer.prompt('Fix the parser', 'turn-1')
  await until(() => requests.length === 1, 'The turn did not start.')
  await server.close()
  assert.equal((await prompt).stopReason, 'cancelled')
  assert.ok(viewer.texts().includes(message('error.daemonLost')))
})

test('a prompt that finds no daemon fails with the text of Megachat and not with the error of the connection', { timeout: 20000 }, async t => {
  const { cwd, server, daemon } = await fixture(t)
  const viewer = await view(t, daemon, cwd)
  await server.close()
  await assert.rejects(viewer.prompt('Fix the parser', 'turn-1'), error => error.data?.details === message('error.unavailable'))
})

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
import { recordVersion, updateNoteText } from '../src/MegachatUpdate.mjs'
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

/**
 * The order of events of a restart of the daemon by a child: the child ends, its result report runs, the daemon stops
 * during the report, and the next daemon has a newer version. The view of the new bridge did not start the report.
 */
test('a prompt during the result report that the next daemon sends again after its restart runs its own turn after the update note', { timeout: 20000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'megachat-prompt-wait-')))
  // The stop of the first daemon leaves its storage open, so the next daemon reads the same state.
  const memory = new MemoryStorage()
  const storage = new Proxy(memory, { get(target, name) {
    if (name === 'close') return async () => {}
    const value = Reflect.get(target, name)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  const open = async (version, replies) => {
    const fake = fauxProvider()
    const models = createModels()
    models.setProvider(fake.provider)
    const model = fake.getModel()
    const requests = []
    // A reply without text waits for the abort of its model request, as a report that runs during the stop does.
    fake.setResponses(replies.map(reply => async (context, options) => {
      requests.push(reply)
      if (reply) return fauxAssistantMessage(reply)
      await new Promise(resolve => options?.signal?.addEventListener('abort', resolve, { once: true }))
      return fauxAssistantMessage('The report stopped.')
    }))
    const service = await PiMegachatService.open(storage, models, { provider: model.provider, modelId: model.id }, {},
      { suggestions: 'off', keepAlive: { enabled: false }, reportRetryDelayMs: 20 })
    const record = await recordVersion(service.state, version, { fetchNotes: async () => null, retryMs: 50 })
    t.after(() => record.close())
    return { service, requests }
  }
  const report = state => state.current?.kind === 'report' ? state.current : undefined
  const first = await open('0.6.1', ['Delegated.', null])
  t.after(() => rm(cwd, { force: true, recursive: true }))
  await first.service.state.addWorkspace(cwd)
  const main = await first.service.state.submit('main', 'Update and restart the daemon')
  const run = await first.service.state.admitChild('tool', { cwd, prompt: 'Update and restart the daemon' })
  await first.service.state.transition(run.id, ['admitted'], { status: 'completed' })
  first.service.follow(main)
  await first.service.resume()
  await waitForState(first.service.state, report, { timeoutMs: 10000 })
  await until(() => first.requests.length === 2, 'The report did not start its model request.')
  await first.service.close()

  const next = await open('0.6.2', [null, 'The onboarding starts now.', 'The completed task result.'])
  const server = new DaemonServer(next.service)
  const daemon = new DaemonClient(await server.listen())
  t.after(async () => { await server.close(); await next.service.close() })
  await next.service.resume()
  await waitForState(next.service.state, report, { timeoutMs: 10000 })
  await until(() => next.requests.length === 1, 'The next daemon did not send the report again.')
  // The daemon refuses no prompt here: it stops the report for the prompt of the user.
  const viewer = await view(t, daemon, cwd)
  assert.equal((await viewer.prompt('Start a new onboarding', 'turn-1')).stopReason, 'end_turn')
  // The note after the update goes out on its own when the turn is over, and the viewer gets it live.
  const prefix = updateNoteText({ from: '0.6.1', to: '0.6.2', notes: null }).slice(0, 40)
  await until(() => viewer.texts().some(text => text.startsWith(prefix)), 'The viewer got no note after the update.')
  assert.ok(viewer.texts().includes('The onboarding starts now.'), viewer.texts().join('\n'))
  assert.equal((await next.service.state.snapshot()).inputs['turn-1'].status, 'completed')
})

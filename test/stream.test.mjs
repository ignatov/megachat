import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxText, fauxThinking, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { ReplyStream, streamEnabled } from '../src/ReplyStream.mjs'

const LONG = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ')

/** A daemon with a fake model that writes about 4 characters each 10 ms. */
async function fixture(t, responses, { stream } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'megachat-stream-'))
  const fake = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } })
  fake.setResponses(responses)
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { keepAlive: { enabled: false } })
  const server = new DaemonServer(service, undefined, stream === undefined ? {} : { stream })
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  t.after(async () => { await server.close(); await service.close(); await rm(cwd, { force: true, recursive: true }) })
  return { cwd, service, server, daemon }
}

async function attach(t, daemon, cwd) {
  const updates = []
  const bridge = new AcpBridge(daemon)
  const connection = client({ name: 'test-air' })
    .onNotification('*', ({ params }) => { updates.push({ ...params, at: performance.now() }) })
    .connect(bridge.app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const prompt = text => connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })
  return { connection, updates, sessionId, prompt, chunks: () => chunks(updates) }
}

const chunks = updates => updates.filter(event => event.update.sessionUpdate === 'agent_message_chunk')
  .map(event => ({ id: event.update.messageId, text: event.update.content.text, replay: event._meta?.loadSessionReplayIndex !== undefined, at: event.at }))
/** The text of each message, as Air joins the chunks: one message for each message ID. */
const messages = list => {
  const joined = new Map()
  for (const chunk of list) joined.set(chunk.id, (joined.get(chunk.id) ?? '') + chunk.text)
  return [...joined.values()]
}
const until = async (condition, text) => {
  for (let attempt = 0; attempt < 500; attempt++) { if (await condition()) return; await sleep(10) }
  assert.fail(text)
}
const assistantTexts = async service => (await service.view()).entries.flatMap(entry => entry.model ?? [])
  .filter(model => model.role === 'assistant').map(model => model.content.filter(block => block.type === 'text').map(block => block.text).join(''))

test('the chunks of a reply arrive before its entry, and the entry adds no text again', { timeout: 20000 }, async t => {
  const { cwd, daemon, service } = await fixture(t, [fauxAssistantMessage([fauxThinking('A hidden thought.'), fauxText(LONG)])])
  const viewer = await attach(t, daemon, cwd)
  const reply = viewer.prompt('Hello')
  await until(() => viewer.chunks().length >= 2, 'no chunk arrived')
  assert.deepEqual(await assistantTexts(service), [], 'the chunks arrived before the entry')
  assert.equal((await reply).stopReason, 'end_turn')
  const list = viewer.chunks()
  assert.ok(list.length >= 3)
  assert.deepEqual(messages(list), [LONG])
  assert.match(list[0].id, /^megachat-reply-\d+-1$/)
  assert.ok(!viewer.updates.some(event => event.update.sessionUpdate === 'agent_thought_chunk'))
  // A later view gets the reply from its entry only.
  const later = await attach(t, daemon, cwd)
  assert.deepEqual(later.chunks().map(chunk => [chunk.text, chunk.replay]), [[LONG, true]])
})

test('a stopped reply keeps its partial text one time, in the chat and in a replay', { timeout: 20000 }, async t => {
  const { cwd, daemon, service } = await fixture(t, [fauxAssistantMessage(LONG)])
  const viewer = await attach(t, daemon, cwd)
  const reply = viewer.prompt('Hello')
  await until(() => viewer.chunks().length >= 2, 'no chunk arrived')
  await viewer.connection.agent.notify(methods.agent.session.cancel, { sessionId: viewer.sessionId })
  assert.equal((await reply).stopReason, 'cancelled')
  const [partial, ...rest] = messages(viewer.chunks())
  assert.deepEqual(rest, [])
  assert.ok(partial.length > 0 && partial.length < LONG.length && LONG.startsWith(partial))
  // The partial reply is an entry, so the chat and a replay show the same text.
  assert.deepEqual(await assistantTexts(service), [partial])
  const later = await attach(t, daemon, cwd)
  assert.deepEqual(messages(later.chunks()), [partial])
})

test('a reply that fails in the middle keeps its partial text one time, and the notice is another message', { timeout: 20000 }, async t => {
  const { cwd, daemon, service } = await fixture(t, [
    fauxAssistantMessage(LONG, { stopReason: 'error', errorMessage: 'The provider is overloaded.' }), fauxAssistantMessage('Next reply.')])
  const viewer = await attach(t, daemon, cwd)
  assert.equal((await viewer.prompt('Hello')).stopReason, 'cancelled')
  const texts = messages(viewer.chunks())
  assert.equal(texts.at(-1), message('error.model'))
  assert.deepEqual(texts.slice(0, -1), await assistantTexts(service))
  assert.ok(texts.length <= 2 && texts.join('').split('word7 ').length <= 2)
  // The next reply is a new message.
  assert.equal((await viewer.prompt('Again')).stopReason, 'end_turn')
  assert.equal(messages(viewer.chunks()).at(-1), 'Next reply.')
})

test('a view that connects in the middle of a reply gets the text so far, and a second view gets each text one time', { timeout: 20000 }, async t => {
  const { cwd, daemon, service } = await fixture(t, [fauxAssistantMessage(LONG)])
  const first = await attach(t, daemon, cwd)
  const receipt = await service.submit('request-1', 'Hello')
  await until(() => first.chunks().length >= 3, 'no chunk arrived')
  const second = await attach(t, daemon, cwd)
  const start = second.chunks()[0]
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  await until(() => messages(second.chunks())[0] === LONG && messages(first.chunks())[0] === LONG, 'the reply did not arrive')
  await sleep(100)
  assert.deepEqual(messages(first.chunks()), [LONG])
  assert.deepEqual(messages(second.chunks()), [LONG])
  // The replay holds only entries. The partial reply follows it as a live chunk.
  assert.ok(second.updates.some(event => event.update.sessionUpdate === 'user_message_chunk' && event._meta.loadSessionEndOfRecordedHistory))
  assert.ok(second.chunks().every(chunk => !chunk.replay))
  if (start) assert.ok(start.text.length >= 8 && LONG.startsWith(start.text), 'the first chunk holds the text so far')
  assert.equal(second.chunks()[0].id, first.chunks()[0].id)
})

test('the text before a tool call is a stream, and the tool call stays hidden', { timeout: 20000 }, async t => {
  const before = 'I look at the list of the tasks now, one moment.'
  const { cwd, daemon } = await fixture(t, [
    fauxAssistantMessage([fauxText(before), fauxToolCall('agents_list', {})], { stopReason: 'toolUse' }), fauxAssistantMessage(LONG)])
  const viewer = await attach(t, daemon, cwd)
  assert.equal((await viewer.prompt('Hello')).stopReason, 'end_turn')
  assert.deepEqual(messages(viewer.chunks()), [before, LONG])
  assert.ok(viewer.chunks().filter(chunk => chunk.text !== before && before.startsWith(chunk.text)).length >= 1, 'the first text arrived in parts')
  assert.deepEqual([...new Set(viewer.updates.map(event => event.update.sessionUpdate))].sort(),
    ['agent_message_chunk', 'session_info_update'])
})

test('MEGACHAT_STREAM=0 sends a reply only as its entry', { timeout: 20000 }, async t => {
  assert.equal(streamEnabled({ MEGACHAT_STREAM: '0' }), false)
  assert.equal(streamEnabled({ MEGACHAT_STREAM: '1' }), true)
  assert.equal(streamEnabled({}), true)
  const { cwd, daemon } = await fixture(t, [fauxAssistantMessage(LONG)], { stream: false })
  const viewer = await attach(t, daemon, cwd)
  const types = []
  const abort = new AbortController()
  const watching = daemon.watch(event => { types.push(event.type) }, abort.signal).catch(() => {})
  assert.equal((await viewer.prompt('Hello')).stopReason, 'end_turn')
  abort.abort()
  await watching
  assert.deepEqual(viewer.chunks().map(chunk => chunk.text), [LONG])
  assert.match(viewer.chunks()[0].id, /^megachat-entry-\d+$/)
  assert.ok(!types.includes('stream'))
})

test('the daemon sends at most 20 stream events in a second, and no conversation for a partial reply', { timeout: 20000 }, async t => {
  const { daemon, service } = await fixture(t, [fauxAssistantMessage(`${LONG} ${LONG} ${LONG}`)])
  const events = []
  const abort = new AbortController()
  const watching = daemon.watch(event => { events.push({ ...event, at: performance.now() }) }, abort.signal).catch(() => {})
  await until(() => events.length >= 2, 'no first events')
  const receipt = await service.submit('request-1', 'Hello')
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  await sleep(100)
  abort.abort()
  await watching
  const stream = events.filter(event => event.type === 'stream')
  assert.ok(stream.length >= 5)
  const seconds = (stream.at(-1).at - stream[0].at) / 1000
  assert.ok((stream.length - 1) / seconds <= 21, `${stream.length} events in ${seconds} s`)
  for (let index = 1; index < stream.length; index++) assert.ok(stream[index].at - stream[index - 1].at >= 35)
  // The events join into the text without a gap.
  let text = ''
  for (const { value } of stream) { assert.equal(value.offset, text.length); text += value.text }
  assert.ok(`${LONG} ${LONG} ${LONG}`.startsWith(text))
  // The initial view, the user message, and the reply: the partial reply sends no view of the conversation.
  assert.ok(events.filter(event => event.type === 'conversation').length <= 4)
})

test('a stream joins the text that arrives faster than its interval, and keeps a character of two units whole', async () => {
  const events = []
  const first = []
  const stream = new ReplyStream(async (type, value) => { events.push({ type, ...value }) }, { intervalMs: 40, onFirstText: (event, ms) => first.push(ms) })
  const view = text => ({ docs: { 'pi.live': { run: { taskId: 7 }, generation: { attempt: 1, ...(text === undefined ? {} : { message: { content: [{ type: 'text', text }] } }) } } } })
  await stream.observe(view())
  let text = ''
  for (let index = 0; index < 40; index++) { text += `${index} `; await stream.observe(view(text)); await sleep(2) }
  await stream.observe(view(`${text}\ud83d`))
  await sleep(60)
  assert.ok(events.length >= 2 && events.length <= 5, `${events.length} events`)
  assert.equal(events.map(event => event.text).join(''), text)
  await stream.observe(view(`${text}😀`))
  await sleep(60)
  assert.equal(events.map(event => event.text).join(''), `${text}😀`)
  assert.ok(events.every(event => event.type === 'stream' && event.taskId === 7 && event.attempt === 1))
  assert.equal(first.length, 1)
  // The end of the reply stops a text that waits: the entry gives it to the client.
  await stream.observe(view(`${text}😀 one`))
  await stream.observe(view(`${text}😀 one two`))
  await stream.observe({ docs: { 'pi.live': {} } })
  await sleep(60)
  assert.equal(events.map(event => event.text).join(''), `${text}😀 one`)
})

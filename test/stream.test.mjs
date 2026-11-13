import assert from 'node:assert/strict'
import { createServer } from 'node:http'
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
import { CentralConfigurationService } from '../src/CentralConfigurationService.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { ReplyStream, STOPPED_KIND, stoppedReplyText, STREAM_INTERVAL_MS, streamEnabled } from '../src/ReplyStream.mjs'
import { fakeClock } from './fake-clock.mjs'

const LONG = Array.from({ length: 60 }, (_, index) => `word${index}`).join(' ')

/** A daemon with a fake model that writes about 4 characters each 10 ms. */
async function fixture(t, responses, { stream, onStreamSent } = {}) {
  const cwd = await mkdtemp(join(tmpdir(), 'megachat-stream-'))
  const fake = fauxProvider({ tokensPerSecond: 100, tokenSize: { min: 1, max: 1 } })
  fake.setResponses(responses)
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { keepAlive: { enabled: false } })
  const server = new DaemonServer(service, undefined, { ...(stream === undefined ? {} : { stream }), onStreamSent })
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
// The entry of a stopped turn is for the model only, so the texts of the chat leave it out.
const assistantTexts = async service => (await service.view()).entries.filter(entry => entry.kind !== STOPPED_KIND).flatMap(entry => entry.model ?? [])
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

/** The role and the text of each message of a model request, as the faux model gets them. */
const contextTexts = context => context.messages.filter(model => model.role !== 'system').map(model => [model.role, typeof model.content === 'string' ? model.content
  : model.content.filter(block => block.type === 'text').map(block => block.text).join('')])

test('the next request after a stopped reply holds the partial text with the stop marker, and the chat shows it one time', { timeout: 20000 }, async t => {
  let seen
  const { cwd, daemon, service } = await fixture(t, [fauxAssistantMessage(LONG),
    context => { seen = contextTexts(context); return fauxAssistantMessage('One, two, three, four, five.') }])
  const viewer = await attach(t, daemon, cwd)
  const reply = viewer.prompt('Write an essay')
  await until(() => viewer.chunks().length >= 2, 'no chunk arrived')
  await viewer.connection.agent.notify(methods.agent.session.cancel, { sessionId: viewer.sessionId })
  assert.equal((await reply).stopReason, 'cancelled')
  const [partial] = messages(viewer.chunks())
  assert.equal((await viewer.prompt('Count from 1 to 5')).stopReason, 'end_turn')
  // The model gets the partial reply as a reply that the user stopped, before the next message of the user.
  assert.deepEqual(seen, [['user', 'Write an essay'], ['assistant', `${partial.trimEnd()}\n\n${message('reply.stopped')}`], ['user', 'Count from 1 to 5']])
  // The chat and a replay show the partial text one time, and no marker.
  assert.deepEqual(messages(viewer.chunks()), [partial, 'One, two, three, four, five.'])
  const later = await attach(t, daemon, cwd)
  assert.deepEqual(messages(later.chunks()), [partial, 'One, two, three, four, five.'])
  // The history tool gives the partial text one time.
  const history = await service.history()
  assert.deepEqual(history.entries.filter(entry => entry.role === 'assistant').map(entry => entry.text).reverse(), [partial, 'One, two, three, four, five.'])
})

test('the next request after a reply stopped before its first text holds only the stop marker', { timeout: 20000 }, async t => {
  let seen
  let release
  const held = new Promise(resolve => { release = resolve })
  const { cwd, daemon, service } = await fixture(t, [async () => { await held; return fauxAssistantMessage(LONG) },
    context => { seen = contextTexts(context); return fauxAssistantMessage('Done.') }])
  const viewer = await attach(t, daemon, cwd)
  const reply = viewer.prompt('Hello')
  await until(async () => (await service.state.snapshot()).current, 'the turn did not start')
  const stopping = service.cancel()
  release()
  await stopping
  assert.equal((await reply).stopReason, 'cancelled')
  assert.equal((await viewer.prompt('Again')).stopReason, 'end_turn')
  assert.deepEqual(seen, [['user', 'Hello'], ['assistant', message('reply.stopped')], ['user', 'Again']])
  assert.deepEqual(messages(viewer.chunks()), ['Done.'])
})

test('the text of a stopped turn takes the partial reply of its last request, and a full reply gives no text', () => {
  const user = { id: 1, kind: 'pi.user', model: [{ role: 'user', content: 'Hello' }] }
  const assistant = (id, text, stopReason) => ({ id, kind: 'pi.assistant', model: [{ role: 'assistant', content: [{ type: 'text', text }], stopReason }] })
  const toolResult = { id: 3, kind: 'pi.tool-result', model: [{ role: 'toolResult', toolCallId: 'a', content: [{ type: 'text', text: 'aborted' }] }] }
  assert.equal(stoppedReplyText([assistant(2, 'Queues hold items. ', 'aborted'), user], 'M'), 'Queues hold items.\n\nM')
  assert.equal(stoppedReplyText([user], 'M'), 'M')
  assert.equal(stoppedReplyText([toolResult, assistant(2, 'Look', 'toolUse'), user], 'M'), 'M')
  assert.equal(stoppedReplyText([assistant(2, 'Done.', 'stop'), user], 'M'), undefined)
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

const SHORT = 'A short reply. It has about one hundred characters, so the model writes it in less than a second.'

/**
 * A fake Anthropic API with the event order of Claude Opus 5.5 through Central, as a run on 2026-11-12 recorded it. The
 * thinking block opens at once, and the model thinks for 400 ms. With the display `summarized`, the API then sends the
 * summary and the text that the model wrote in the meantime in one burst, and the response ends 20 ms later. With the
 * display `omitted`, the thinking block closes without text, and the text follows as the model writes it.
 */
async function fakeAnthropic(t) {
  const requests = []
  const headers = []
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
    requests.push(body)
    headers.push(request.headers)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const send = (type, data) => response.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`)
    const text = index => ({ index: 1, delta: { type: 'text_delta', text: SHORT.slice(index, index + 4) } })
    send('message_start', { message: { id: `msg_${requests.length}`, type: 'message', role: 'assistant', model: body.model, content: [],
      stop_reason: null, usage: { input_tokens: 10, output_tokens: 1 } } })
    send('content_block_start', { index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } })
    await sleep(400)
    const summarized = body.thinking?.display !== 'omitted'
    if (summarized) send('content_block_delta', { index: 0, delta: { type: 'thinking_delta', thinking: 'The user greets me.' } })
    send('content_block_delta', { index: 0, delta: { type: 'signature_delta', signature: 'c2lnbmF0dXJl' } })
    send('content_block_stop', { index: 0 })
    send('content_block_start', { index: 1, content_block: { type: 'text', text: '' } })
    for (let index = 0; index < SHORT.length; index += 4) {
      send('content_block_delta', text(index))
      if (!summarized) await sleep(10)
    }
    if (summarized) await sleep(20)
    send('content_block_stop', { index: 1 })
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 40 } })
    send('message_stop', {})
    response.end()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  return { requests, headers, baseUrl: `http://127.0.0.1:${server.address().port}/wire/test` }
}

test('a model request through Central has no fallback models, so the proxy accepts Claude Fable 5.2 and Fable 5', { timeout: 20000 }, async t => {
  // A run through Central on 2026-11-13 with Claude Fable 5.2 failed in each turn with the HTTP status 400: "Anthropic
  // proxy does not support fallback field". pi-ai adds the field to each model with fallback models in the registry.
  const anthropic = await fakeAnthropic(t)
  const configuration = new CentralConfigurationService({ environment: {} })
  configuration.pi = async () => ({ baseUrl: anthropic.baseUrl, apiKey: 'test-key' })
  const models = configuration.models()
  const withFallbacks = models.getModels('anthropic').filter(model => model.compat?.allowedFallbackModels?.length > 0)
  assert.ok(['claude-fable-5-2', 'claude-fable-5'].every(id => withFallbacks.some(model => model.id === id)), 'The registry has fallback models')
  for (const model of withFallbacks) {
    const answer = await models.completeSimple(model, { messages: [{ role: 'user', content: 'Hello', timestamp: Date.now() }] },
      { reasoning: 'low' })
    assert.equal(answer.stopReason, 'stop', `${model.id}: ${answer.errorMessage}`)
  }
  assert.equal(anthropic.requests.length, withFallbacks.length)
  for (const body of anthropic.requests) assert.equal(body.fallbacks, undefined, body.model)
  for (const headers of anthropic.headers) assert.doesNotMatch(headers['anthropic-beta'] ?? '', /server-side-fallback/)
  // The registry keeps the fallback models and the prices.
  const fable = models.getModel('anthropic', 'claude-fable-5-2')
  assert.equal(fable.compat.allowedFallbackModels[0].model, 'claude-opus-5')
  assert.equal(fable.cost.input, 8)
})

test('a short reply that starts with thinking arrives in parts, because the model sends thinking blocks without text', { timeout: 20000 }, async t => {
  const anthropic = await fakeAnthropic(t)
  const configuration = new CentralConfigurationService({ environment: {} })
  configuration.pi = async () => ({ baseUrl: anthropic.baseUrl, apiKey: 'test-key' })
  const service = await PiMegachatService.open(new MemoryStorage(), configuration.models(), { provider: 'anthropic', modelId: 'claude-opus-5-5' }, {},
    { keepAlive: { enabled: false } })
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  const cwd = await mkdtemp(join(tmpdir(), 'megachat-stream-'))
  t.after(async () => { await server.close(); await service.close(); await rm(cwd, { force: true, recursive: true }) })
  const viewer = await attach(t, daemon, cwd)
  const reply = viewer.prompt('Hello')
  await until(() => viewer.chunks().length >= 2, 'no second chunk arrived')
  assert.deepEqual(await assistantTexts(service), [], 'the chunks arrived before the entry')
  assert.equal((await reply).stopReason, 'end_turn')
  assert.deepEqual(messages(viewer.chunks()), [SHORT])
  assert.match(viewer.chunks()[0].id, /^megachat-reply-\d+-1$/)
  assert.ok(anthropic.requests.length >= 1)
  for (const body of anthropic.requests) assert.equal(body.thinking.display, 'omitted')
  // The thinking block keeps its signature, so the next request can send it back.
  const thinking = (await service.view()).entries.flatMap(entry => entry.model ?? []).find(model => model.role === 'assistant')
    .content.find(block => block.type === 'thinking')
  assert.deepEqual([thinking.thinking, thinking.thinkingSignature], ['', 'c2lnbmF0dXJl'])
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
  // The time when the daemon sends each event. The time when the client gets an event can be later, so the gap to the
  // next event can be shorter there.
  const sent = []
  const { daemon, service } = await fixture(t, [fauxAssistantMessage(`${LONG} ${LONG} ${LONG}`)], { onStreamSent: (event, at) => sent.push(at) })
  const events = []
  const abort = new AbortController()
  const watching = daemon.watch(event => { events.push(event) }, abort.signal).catch(() => {})
  await until(() => events.length >= 2, 'no first events')
  const receipt = await service.submit('request-1', 'Hello')
  await daemon.json(`/wait?submission=${receipt.submissionId}`)
  await sleep(100)
  await until(() => events.filter(event => event.type === 'stream').length >= sent.length, 'the client did not get each event')
  abort.abort()
  await watching
  const stream = events.filter(event => event.type === 'stream')
  assert.equal(stream.length, sent.length)
  assert.ok(sent.length >= 5)
  const seconds = (sent.at(-1) - sent[0]) / 1000
  assert.ok((sent.length - 1) / seconds <= 21, `${sent.length} events in ${seconds} s`)
  // Node.js cuts the delay of a timer to whole milliseconds, and its timers count whole milliseconds. So a timer can
  // come due up to 2 ms before its delay on performance.now().
  for (let index = 1; index < sent.length; index++) assert.ok(sent[index] - sent[index - 1] >= STREAM_INTERVAL_MS - 2, `a gap of ${sent[index] - sent[index - 1]} ms`)
  // The events join into the text without a gap.
  let text = ''
  for (const { value } of stream) { assert.equal(value.offset, text.length); text += value.text }
  assert.ok(`${LONG} ${LONG} ${LONG}`.startsWith(text))
  // The initial view, the user message, and the reply: the partial reply sends no view of the conversation.
  assert.ok(events.filter(event => event.type === 'conversation').length <= 4)
})

test('a stream joins the text that arrives faster than its interval, and keeps a character of two units whole', async () => {
  // The time moves only in `advance`. So a slow computer cannot change the number of events.
  const clock = fakeClock()
  const start = clock.now()
  const events = []
  const first = []
  const stream = new ReplyStream(async (type, value) => { events.push({ type, ...value, at: clock.now() - start }) },
    { intervalMs: 40, onFirstText: (event, ms) => first.push(ms), clock })
  const view = text => ({ docs: { 'pi.live': { run: { taskId: 7 }, generation: { attempt: 1, ...(text === undefined ? {} : { message: { content: [{ type: 'text', text }] } }) } } } })
  const joined = () => events.map(event => event.text).join('')
  await stream.observe(view())
  await clock.advance(5)
  // A part of the text each 2 ms, for 80 ms: the first part goes out at once, and the other parts wait for the interval.
  let text = ''
  for (let index = 0; index < 40; index++) { text += `${index} `; await stream.observe(view(text)); await clock.advance(2) }
  assert.deepEqual(events.map(event => event.at), [5, 45, 85])
  assert.equal(joined(), text)
  // One half of a character of two units does not go out, also after the interval.
  await stream.observe(view(`${text}\ud83d`))
  await clock.advance(60)
  assert.equal(joined(), text)
  await stream.observe(view(`${text}😀`))
  assert.equal(joined(), `${text}😀`)
  assert.ok(events.every(event => event.type === 'stream' && event.taskId === 7 && event.attempt === 1))
  assert.deepEqual(first, [5])
  // The end of the reply stops a text that waits: the entry gives it to the client.
  await clock.advance(60)
  await stream.observe(view(`${text}😀 one`))
  await stream.observe(view(`${text}😀 one two`))
  await stream.observe({ docs: { 'pi.live': {} } })
  await clock.advance(60)
  assert.equal(joined(), `${text}😀 one`)
})

test('a streamed reply with agents_suggest after its text ends its turn as a final answer, and the next prompt runs', { timeout: 30000 }, async t => {
  const { cwd, service, daemon } = await fixture(t, [
    fauxAssistantMessage([fauxText(LONG), fauxToolCall('agents_suggest', { proposal: 'Run the tests' })], { stopReason: 'toolUse' }),
    fauxAssistantMessage(SHORT), fauxAssistantMessage('The second reply.')])
  const viewer = await attach(t, daemon, cwd)
  const other = await attach(t, daemon, cwd)
  const first = viewer.prompt('Hello')
  // The prompt of another view during the turn waits for the end of the turn, and then it gets its own turn.
  await until(() => viewer.chunks().length > 0, 'no chunk of the first reply')
  const waiting = other.prompt('Next')
  assert.equal((await first).stopReason, 'end_turn')
  // The turn made one model request: the reply is one message of the stream, without a text after the call.
  assert.deepEqual(messages(viewer.chunks()), [LONG])
  assert.match(viewer.chunks()[0].id, /^megachat-reply-\d+-1$/)
  assert.equal((await waiting).stopReason, 'end_turn')
  assert.deepEqual(messages(other.chunks()), [LONG, SHORT])
  // The state of the daemon is as after a final answer: no current turn, and each input is completed.
  const state = await service.state.snapshot()
  assert.equal(state.current, null)
  assert.deepEqual(Object.values(state.inputs).map(input => input.status), ['completed', 'completed'])
  assert.deepEqual(await assistantTexts(service), [LONG, SHORT])
  // A replay shows the reply one time, and the prompt of a later turn runs.
  const later = await attach(t, daemon, cwd)
  assert.deepEqual(messages(later.chunks()), [LONG, SHORT])
  assert.equal((await later.prompt('Again')).stopReason, 'end_turn')
  assert.deepEqual((await assistantTexts(service)).at(-1), 'The second reply.')
})

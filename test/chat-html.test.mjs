import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxText } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { childRulesText, PiMegachatService } from '../src/PiMegachatService.mjs'
import { MegachatSettings, SettingsStore } from '../src/Settings.mjs'

/** The first line of `resources/air-html.md`, which only the section of the page rules has. */
const SECTION = /Pages in the chat\. The chat of Air draws an `air-html` code fence/
const FENCE = ['Here is the chart.', '', '```air-html', '<!doctype html>', '<title>Sample data</title>', '<svg width="100%" viewBox="0 0 10 10"></svg>',
  '```', '', 'The data is sample data.'].join('\n')

/**
 * A daemon with a fake model. [reply] is the text of each answer. The model records the whole request of each turn.
 * [setting] is a stored `chat.html`, else the default. [storage] lets a second daemon open the same state.
 */
async function fixture(t, { reply = 'Done.', setting, storage = new MemoryStorage() } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-html-'))
  if (setting) await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', defaults: 2, values: { 'chat.html': setting } }), { mode: 0o600 })
  const fake = fauxProvider({ tokensPerSecond: 200, tokenSize: { min: 1, max: 3 } })
  const requests = []
  fake.setResponses(Array(20).fill(context => { requests.push(JSON.stringify(context)); return fauxAssistantMessage([fauxText(reply)]) }))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(storage, models, { provider: model.provider, modelId: model.id }, {},
    { settingsPath: join(directory, 'settings.json'), keepAlive: { enabled: false }, environment: {} })
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  t.after(async () => { await server.close(); await service.close(); await rm(directory, { force: true, recursive: true }) })
  return { directory, service, daemon, requests, storage }
}

/** An ACP view. [air] is `_meta.jetbrains.air` of its `initialize`, or nothing for a client without the Air support. */
async function attach(t, daemon, directory, air) {
  const updates = []
  const connection = client({ name: 'test-air' })
    .onNotification('*', ({ params }) => { updates.push(params) })
    .connect(new AcpBridge(daemon).app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1,
    clientCapabilities: air ? { _meta: { jetbrains: { air } } } : {} })
  const { sessionId } = await connection.agent.request(methods.agent.session.new, { cwd: directory, mcpServers: [] })
  const prompt = text => connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: 'text', text }] })
  return { updates, prompt }
}

const chunks = updates => updates.filter(event => event.update.sessionUpdate === 'agent_message_chunk')
  .map(event => ({ id: event.update.messageId, text: event.update.content.text, replay: event._meta?.loadSessionReplayIndex !== undefined }))
const joined = list => {
  const messages = new Map()
  for (const chunk of list) messages.set(chunk.id, (messages.get(chunk.id) ?? '') + chunk.text)
  return [...messages.values()]
}

test('the resource has the rules of the fence in the text of the project', async () => {
  const text = await readFile(new URL('../resources/air-html.md', import.meta.url), 'utf8')
  assert.match(text, SECTION)
  assert.match(text, /always close the fence/i)
  assert.match(text, /A child gets no skill/)
})

test('a view with the Air support gives the section to the next turn of the main agent', { timeout: 20000 }, async t => {
  const { directory, daemon, requests } = await fixture(t)
  const viewer = await attach(t, daemon, directory, { version: 1, capabilities: [] })
  await viewer.prompt('Draw the tasks.')
  assert.match(requests.at(-1), SECTION)
})

test('a view without the Air support gets no section, and a view that attaches later changes the next turn', { timeout: 30000 }, async t => {
  const { directory, service, daemon, requests } = await fixture(t)
  const plain = await attach(t, daemon, directory)
  await plain.prompt('Hello.')
  assert.doesNotMatch(requests.at(-1), SECTION)
  assert.equal((await service.state.snapshot()).airSupport, false)
  // The last view that attached decides. An automatic turn of the daemon uses its value.
  const air = await attach(t, daemon, directory, { version: 1, capabilities: [] })
  assert.equal((await service.state.snapshot()).airSupport, true)
  await air.prompt('Draw it.')
  assert.match(requests.at(-1), SECTION)
})

test('the setting off gives no section to a view with the Air support, and the setting on gives it to a client without it', { timeout: 30000 }, async t => {
  const off = await fixture(t, { setting: 'off' })
  const air = await attach(t, off.daemon, off.directory, { version: 1, capabilities: ['htmlFence'] })
  await air.prompt('Draw it.')
  assert.doesNotMatch(off.requests.at(-1), SECTION)
  const on = await fixture(t, { setting: 'on' })
  const plain = await attach(t, on.daemon, on.directory)
  await plain.prompt('Draw it.')
  assert.match(on.requests.at(-1), SECTION)
})

test('the setting is auto by default, and the saved support stays after a restart', { timeout: 30000 }, async t => {
  const settings = new MegachatSettings(await SettingsStore.open(undefined), { environment: {} })
  assert.equal(settings.values()['chat.html'], 'auto')
  const { directory, service, daemon, storage } = await fixture(t)
  await attach(t, daemon, directory, { version: 1, capabilities: [] })
  assert.equal(service.html, true)
  const again = await PiMegachatService.open(storage, service.models, service.agent.model, {}, { keepAlive: { enabled: false }, environment: {},
    settingsPath: join(directory, 'settings.json') })
  t.after(() => again.close())
  assert.equal(again.airSupport, true)
  assert.equal(again.html, true)
})

test('a child gets no page rules', async () => {
  for (const mode of ['auto', 'on']) assert.doesNotMatch(childRulesText({ 'chat.html': mode, 'children.commit': 'allow', 'children.push': 'ask', 'children.daemonRestart': 'ask' }), /air-html/)
  // The spawn code adds no skill directory to a child.
  for (const file of ['AcpRunService.mjs', 'PiChild.mjs', 'ChildPool.mjs', 'RunProcesses.mjs']) {
    assert.doesNotMatch(await readFile(new URL(`../src/${file}`, import.meta.url), 'utf8'), /add-dir|air-views/)
  }
})

test('a fence in several chunks reaches the view whole in the stream, in the replay and in the entry', { timeout: 30000 }, async t => {
  const { directory, service, daemon } = await fixture(t, { reply: FENCE })
  const viewer = await attach(t, daemon, directory, { version: 1, capabilities: [] })
  await viewer.prompt('Draw the tasks.')
  const list = chunks(viewer.updates)
  assert.ok(list.length >= 3, 'the reply came in at least three chunks')
  // A chunk ends inside the fence.
  const starts = list.map((_, index) => list.slice(0, index + 1).map(chunk => chunk.text).join(''))
  assert.ok(starts.some(text => text.includes('```air-html') && !text.includes('</svg>')), 'a chunk ends inside the fence')
  assert.deepEqual(joined(list), [FENCE])
  const entry = (await service.view()).entries.flatMap(item => item.model ?? []).filter(model => model.role === 'assistant')
    .map(model => model.content.filter(block => block.type === 'text').map(block => block.text).join(''))
  assert.deepEqual(entry, [FENCE])
  const later = await attach(t, daemon, directory, { version: 1, capabilities: [] })
  assert.deepEqual(chunks(later.updates).map(chunk => chunk.replay), [true])
  assert.deepEqual(joined(chunks(later.updates)), [FENCE])
})

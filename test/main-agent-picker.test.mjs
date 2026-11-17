import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { CentralConfigurationService } from '../src/CentralConfigurationService.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'

/** A daemon with the real model registry of Central. No test sends a model request, so it needs no key. */
async function fixture(t, { storage = new MemoryStorage(), directory } = {}) {
  directory ??= await mkdtemp(join(tmpdir(), 'megachat-picker-'))
  const models = new CentralConfigurationService({ central: join(directory, 'none'), claude: join(directory, 'none'), settings: join(directory, 'none') }).models()
  const service = await PiMegachatService.open(storage, models, undefined, {},
    { settingsPath: join(directory, 'settings.json'), keepAlive: { enabled: false }, environment: {} })
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  t.after(async () => { await server.close(); await service.close() })
  t.after(() => rm(directory, { force: true, recursive: true }))
  return { directory, service, daemon, storage }
}

/** An ACP view. It opens a new session, or loads [load]. */
async function attach(t, daemon, directory, load) {
  const updates = []
  const connection = client({ name: 'test-air' })
    .onNotification('*', ({ params }) => { updates.push(params.update) })
    .connect(new AcpBridge(daemon).app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  const opened = load
    ? { sessionId: load, ...await connection.agent.request(methods.agent.session.load, { sessionId: load, cwd: directory, mcpServers: [] }) }
    : await connection.agent.request(methods.agent.session.new, { cwd: directory, mcpServers: [] })
  const set = (configId, value) => connection.agent.request(methods.agent.session.setConfigOption, { sessionId: opened.sessionId, configId, value })
  const configUpdates = () => updates.filter(update => update.sessionUpdate === 'config_option_update')
  return { ...opened, set, updates, configUpdates }
}

const optionOf = (options, id) => options.find(option => option.id === id)
const settingsOf = async directory => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))
const eventually = async check => {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  assert.ok(check())
}

test('a new session offers the model and the reasoning level of the main agent', { timeout: 20000 }, async t => {
  const { directory, daemon } = await fixture(t)
  const { configOptions } = await attach(t, daemon, directory)
  const model = optionOf(configOptions, 'model')
  assert.equal(model.category, 'model')
  assert.equal(model.type, 'select')
  assert.equal(model.currentValue, 'anthropic/claude-opus-5-5')
  const values = model.options.map(option => option.value)
  assert.ok(values.includes('anthropic/claude-opus-5-5') && values.includes('anthropic/claude-fable-5-2') && values.includes('anthropic/claude-sonnet-5-5'))
  assert.ok(!values.some(value => /haiku|-\d{8}$/.test(value)), values.join())
  assert.equal(model.options.find(option => option.value === 'anthropic/claude-opus-5-5').name, 'Claude Opus 5.5')
  const level = optionOf(configOptions, 'thought_level')
  assert.equal(level.category, 'thought_level')
  assert.equal(level.currentValue, 'low')
  assert.deepEqual(level.options.map(option => option.value), ['low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(level.options.find(option => option.value === 'xhigh').name, message('acp.level.xhigh'))
})

test('a choice is stored, applies to the main agent, and reaches each view', { timeout: 20000 }, async t => {
  const { directory, service, daemon } = await fixture(t)
  const first = await attach(t, daemon, directory)
  const second = await attach(t, daemon, directory)
  const answer = await first.set('thought_level', 'high')
  assert.equal(optionOf(answer.configOptions, 'thought_level').currentValue, 'high')
  assert.equal((await settingsOf(directory)).values['coordinator.thinking'], 'high')
  assert.equal(service.thinkingLevel, 'high')
  assert.equal(first.configUpdates().length, 1)
  assert.equal(optionOf(first.configUpdates()[0].configOptions, 'thought_level').currentValue, 'high')
  await eventually(() => second.configUpdates().length === 1)
  assert.equal(optionOf(second.configUpdates()[0].configOptions, 'thought_level').currentValue, 'high')
  const changed = await first.set('model', 'anthropic/claude-fable-5-2')
  assert.equal(optionOf(changed.configOptions, 'model').currentValue, 'anthropic/claude-fable-5-2')
  assert.deepEqual(optionOf(changed.configOptions, 'thought_level').options.map(option => option.value), ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
  assert.equal(service.model.modelId, 'claude-fable-5-2')
  const stored = (await settingsOf(directory)).values
  assert.equal(stored['coordinator.model'], 'anthropic/claude-fable-5-2')
  // The children keep their settings.
  assert.deepEqual(Object.keys(stored).filter(key => key.startsWith('children.')), [])
  await eventually(() => second.configUpdates().length === 2)
})

test('a model with fewer levels gets the next level that it supports, and a change by the main agent reaches the view', { timeout: 20000 }, async t => {
  const { directory, service, daemon } = await fixture(t)
  const view = await attach(t, daemon, directory)
  await view.set('thought_level', 'xhigh')
  const answer = await view.set('model', 'anthropic/claude-opus-4-6')
  // Claude Opus 4.6 has no `xhigh`: the rule of pi-ai gives the next level that it supports.
  assert.equal(optionOf(answer.configOptions, 'thought_level').currentValue, 'max')
  assert.equal((await settingsOf(directory)).values['coordinator.thinking'], 'max')
  const before = view.configUpdates().length
  await service.settingsTool({ action: 'set', key: 'coordinator.thinking', value: 'minimal' })
  await eventually(() => view.configUpdates().length === before + 1)
  assert.equal(optionOf(view.configUpdates().at(-1).configOptions, 'thought_level').currentValue, 'minimal')
})

test('an invalid choice is refused with a clear error and changes nothing', { timeout: 20000 }, async t => {
  const { directory, daemon } = await fixture(t)
  const view = await attach(t, daemon, directory)
  await view.set('thought_level', 'medium')
  const refused = async (configId, value, text) => {
    await assert.rejects(view.set(configId, value), error => {
      assert.equal(error.code, -32602)
      assert.ok(error.message.includes(message(text)), error.message)
      return true
    })
  }
  await refused('model', 'anthropic/claude-haiku-5-5', 'acp.option.value')
  await refused('model', 'faux/unknown', 'acp.option.value')
  await refused('thought_level', 'off', 'acp.option.value')
  await refused('thought_level', 'ultra', 'acp.option.value')
  await refused('mode', 'high', 'acp.option.unknown')
  await refused('constructor', 'high', 'acp.option.unknown')
  assert.deepEqual((await settingsOf(directory)).values, { 'coordinator.thinking': 'medium' })
  assert.equal(view.configUpdates().length, 1)
})

test('the choice stays after a restart and a loaded session shows it', { timeout: 30000 }, async t => {
  const { directory, daemon, storage } = await fixture(t)
  const view = await attach(t, daemon, directory)
  await view.set('model', 'anthropic/claude-sonnet-5-5')
  await view.set('thought_level', 'max')
  const again = await fixture(t, { storage, directory })
  const loaded = await attach(t, again.daemon, directory, view.sessionId)
  assert.equal(optionOf(loaded.configOptions, 'model').currentValue, 'anthropic/claude-sonnet-5-5')
  assert.equal(optionOf(loaded.configOptions, 'thought_level').currentValue, 'max')
  assert.equal(loaded.configUpdates().length, 0)
})

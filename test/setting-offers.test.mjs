import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { parseOffers, PiMegachatService } from '../src/PiMegachatService.mjs'
import { SETTINGS } from '../src/Settings.mjs'
import { waitForState } from '../src/waitForState.mjs'

const OFFERS = ['children.push', 'children.daemonRestart', 'children.parallel', 'children.timeoutMinutes', 'children.permissionMode',
  'budget.dailyUsd', 'sessions.notes', 'workday.enabled', 'report.morning']
const RULE = 'Offer a setting in one sentence of the reply text, with its current value.'
const PUSH = 'children.push (ask): A child result says that a push is necessary.'
const resource = name => readFile(new URL(`../resources/${name}`, import.meta.url), 'utf8')

/**
 * A daemon on a fake model with `settings.json` of [values] and the status [onboarding] of the setup. [directory] keeps
 * the settings and the conversation, so a second fixture on the same directory is a restart.
 */
async function fixture(t, { values = {}, onboarding = 'done', directory } = {}) {
  const home = directory ?? await realpath(await mkdtemp(join(tmpdir(), 'megachat-offers-')))
  if (!directory) {
    t.after(() => rm(home, { force: true, recursive: true }))
    await writeFile(join(home, 'settings.json'), JSON.stringify({ schema: 1, onboarding, values }), { mode: 0o600 })
  }
  const fake = fauxProvider()
  const requests = []
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(await openNodeSqliteStorage(join(home, 'conversation.sqlite')), models,
    { provider: model.provider, modelId: model.id }, {}, { settingsPath: join(home, 'settings.json'), environment: {}, keepAlive: { enabled: false } })
  await service.state.addWorkspace(home)
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  let closed
  const close = () => closed ??= server.close().then(() => service.close())
  t.after(close)
  const turn = (...replies) => fake.setResponses(replies.map(reply => async context => {
    requests.push(JSON.stringify(context))
    return reply
  }))
  const settings = service.extension().tools.find(item => item.name === 'agents_settings')
  const offer = async (key, taskId = `call-${key}`) => JSON.parse((await settings.execute({ action: 'offer', key }, { taskId })).output[0].text)
  const rules = async () => (await service.root.agent(BACKGROUND_CONTEXT)).sections.find(item => item.key === 'settings').render()
  const stored = async () => JSON.parse(await readFile(join(home, 'settings.json'), 'utf8'))
  return { home, service, daemon, requests, turn, settings, offer, rules, stored, close }
}

/** A view of Air on the conversation. */
async function view(t, daemon, cwd) {
  const updates = []
  const connection = client({ name: 'test-air' })
    .onNotification('*', ({ params }) => { updates.push(params) })
    .connect(new AcpBridge(daemon).app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [] })
  const suggestions = () => updates.map(event => event.update._meta?.promptSuggestions).filter(Boolean)
    .map(payload => payload.suggestions.find(item => item.text?.trim())?.text ?? null)
  return { updates, suggestions }
}

/** A turn of a child result or of the sessions summary, as the event pump starts it, for a direct call of a tool. */
const inTurn = async (service, kind, requestId, body) => {
  await service.state.change(state => { state.current = { id: requestId, requestId, cancelling: false, kind } })
  try { return await body() }
  finally { await service.state.change(state => { state.current = null }) }
}

test('the list of the offers names nine settings of this build, and the setup asks for none of them', async () => {
  const offers = parseOffers(await resource('instructions-offers.md'))
  const setup = await resource('instructions-onboarding.md')
  assert.deepEqual(offers.items.map(item => item.key), OFFERS)
  const keys = new Set(SETTINGS.map(setting => setting.key))
  for (const key of OFFERS) {
    assert.ok(keys.has(key), key)
    assert.ok(!setup.includes(key), key)
  }
  assert.equal(offers.items.find(item => item.key === 'children.push').trigger, 'A child result says that a push is necessary.')
  assert.match(offers.head, /Offer a setting in one sentence of the reply text, with its current value\. An offer of a setting is not a next step of the work\./)
  // The scenario "The rules of the setup" of child-settings: the parallel count left the setup for the offers.
  assert.ok(!setup.includes('children.parallel'))
})

test('after the setup in the mode ghost, the rules show each open offer with its current value', { timeout: 20000 }, async t => {
  const { rules } = await fixture(t)
  const text = await rules()
  assert.ok(text.includes(RULE))
  assert.ok(text.includes('An offer of a setting is not a next step of the work.'))
  assert.ok(text.includes(PUSH))
  for (const key of OFFERS.filter(key => key !== 'sessions.notes')) assert.match(text, new RegExp(`^${key.replace('.', '\\.')} \\(`, 'm'), key)
  // The notes need the consent of the index first.
  assert.doesNotMatch(text, /^sessions\.notes \(/m)
})

test('a stored value, the mode off and a pending setup give no offer line', { timeout: 20000 }, async t => {
  const stored = await fixture(t, { values: { 'children.push': 'allow' } })
  assert.ok(!(await stored.rules()).includes('children.push ('))
  const off = await fixture(t, { values: { 'reply.suggestions': 'off' } })
  assert.ok(!(await off.rules()).includes(RULE))
  assert.equal((await off.offer('children.push')).allowed, false)
  const pending = await fixture(t, { onboarding: 'pending' })
  assert.ok(!(await pending.rules()).includes(RULE))
  assert.equal((await pending.offer('children.push')).allowed, false)
})

test('an allowed offer goes into the state, leaves the rules, and gets no second offer, also after a restart', { timeout: 20000 }, async t => {
  const first = await fixture(t)
  assert.deepEqual(await first.offer('children.push'), { allowed: true, key: 'children.push', value: 'ask' })
  assert.deepEqual(Object.keys((await first.service.state.snapshot()).initiative.offers), ['children.push'])
  assert.ok(!(await first.rules()).includes('children.push ('))
  // A repeated tool call gets the same result, and a new call gets none.
  assert.equal((await first.offer('children.push')).allowed, true)
  assert.equal((await first.offer('children.push', 'call-again')).allowed, false)
  await first.close()
  const second = await fixture(t, { directory: first.home })
  assert.equal((await second.offer('children.push', 'call-after-restart')).allowed, false)
  assert.ok(!(await second.rules()).includes('children.push ('))
  assert.ok((await second.rules()).includes('children.parallel ('))
})

test('a turn of a child result records one offer and changes no setting, and a second offer of the turn gets none', { timeout: 20000 }, async t => {
  const { service, offer, stored } = await fixture(t)
  const before = await stored()
  const results = await inTurn(service, 'report', 'turn-a', async () => [await offer('children.push'), await offer('children.parallel')])
  assert.deepEqual(results[0], { allowed: true, key: 'children.push', value: 'ask' })
  assert.equal(results[1].allowed, false)
  assert.deepEqual(Object.keys((await service.state.snapshot()).initiative.offers), ['children.push'])
  assert.deepEqual(await stored(), before)
})

test('silence, a key out of the list and an unknown key give no offer', { timeout: 20000 }, async t => {
  const { service, offer, settings } = await fixture(t)
  assert.equal((await offer('cache.ttl')).allowed, false)
  await assert.rejects(settings.execute({ action: 'offer', key: 'coordinator.color' }, { taskId: 'call-color' }), { code: 'settingKey' })
  await service.state.feedback('call-silence', 'silence')
  assert.equal((await offer('children.push')).allowed, false)
  assert.deepEqual((await service.state.snapshot()).initiative.offers, {})
})

test('the offer of the notes opens only after the consent of the index', { timeout: 20000 }, async t => {
  const { settings, rules } = await fixture(t)
  assert.doesNotMatch(await rules(), /^sessions\.notes \(/m)
  await settings.execute({ action: 'set', key: 'sessions.index', value: 'on' })
  assert.match(await rules(), /^sessions\.notes \(off\): The summary of the past sessions/m)
})

test('in the mode ghost, a turn of a child result gives the offer in the reply text and its acceptance as grey text', { timeout: 20000 }, async t => {
  const { home, service, daemon, turn, stored } = await fixture(t)
  const viewer = await view(t, daemon, home)
  const reply = 'The child did not push. children.push is ask, so each push waits for your yes. I can set it to allow.'
  turn(fauxAssistantMessage(fauxToolCall('agents_settings', { action: 'offer', key: 'children.push' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(fauxToolCall('agents_suggest', { proposal: 'Let child tasks push without a question' }), { stopReason: 'toolUse' }),
    fauxAssistantMessage(reply))
  await service.state.change(state => {
    state.runs.push1 = { id: 'push1', childSessionId: 'child-push1', mainRunId: 'main', agent: 'claude', requestId: 'spawn-push1', digest: 'push1',
      prompt: 'Release the fix', title: 'Release the fix', cwd: home, status: 'completed', output: 'The fix is committed. A push is necessary.',
      truncated: false, reported: false, createdAt: Date.now() - 60000, finishedAt: Date.now(), closed: false, providerSessionId: null,
      serviceSession: false, generation: null, pid: null, cancelRequested: false }
  })
  await waitForState(service.state, state => state.runs.push1.reported && !state.current ? true : undefined)
  const chunks = () => viewer.updates.filter(event => event.update.sessionUpdate === 'agent_message_chunk').map(event => event.update.content.text).join('')
  // The view gets the turn through the bridge, a moment after the state.
  for (let attempt = 0; attempt < 300 && !(chunks().includes(reply) && viewer.suggestions().length); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  assert.ok(chunks().includes(reply), chunks())
  assert.deepEqual(viewer.suggestions(), ['Let child tasks push without a question'])
  assert.equal((await stored()).values['children.push'], undefined)
  assert.ok(Object.hasOwn((await service.state.snapshot()).initiative.offers, 'children.push'))
})

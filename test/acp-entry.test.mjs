// The dialog about a second entry Megachat: Air has the registry agent, and acp.json has the entry Megachat, so Air
// shows two rows of one conversation. The answers Remove and Keep, the outcome cancelled, and an entry of the user.
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { client, methods } from '@agentclientprotocol/sdk/unstable'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxAssistantMessage, fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpBridge } from '../src/AcpBridge.mjs'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { ACP_CONFIG_VARIABLE, INSTALLED_VARIABLE, RELEASE_ENTRY, removeSecondEntry, secondEntry } from '../src/MegachatInstall.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'

const INSTALLED = JSON.stringify({ agents: { 'acp.registry.megachat-acp': { agent: { id: 'megachat-acp', name: 'Megachat' } } } })
const busy = state => { state.current = { id: 'turn', requestId: 'turn', cancelling: false, kind: 'user' } }

/** A daemon with a faux model and a settings file, and the files of Air in a temporary directory. */
async function open(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-entry-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const fake = fauxProvider()
  fake.setResponses([fauxAssistantMessage('Answer.')])
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const settingsPath = join(directory, 'settings.json')
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { settingsPath, keepAlive: { enabled: false }, environment: {} })
  await service.resume()
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  t.after(async () => { await server.close(); await service.close() })
  const environment = { [ACP_CONFIG_VARIABLE]: join(directory, 'acp.json'), [INSTALLED_VARIABLE]: join(directory, 'installed.json') }
  const entries = { find: () => secondEntry({ environment }), remove: removeSecondEntry }
  return { directory, service, daemon, settingsPath, entries, acp: join(directory, 'acp.json') }
}

/** A view of Air in a connection of its own. [answer] answers each permission request. */
async function view(t, daemon, entries, answer) {
  const asked = []
  const connection = client({ name: 'test-air' })
    .onNotification(methods.client.session.update, () => {})
    .onRequest(methods.client.session.requestPermission, ({ params }) => { asked.push(params); return answer(params, asked.length) })
    .connect(new AcpBridge(daemon, { entries, entryDelayMs: 10, entryIdleMs: 20 }).app())
  t.after(() => connection.close())
  await connection.agent.request(methods.agent.initialize, { protocolVersion: 1, clientCapabilities: {} })
  const attach = () => connection.agent.request(methods.agent.session.new, { cwd: process.cwd(), mcpServers: [] })
  const { sessionId } = await attach()
  return { connection, sessionId, asked, attach }
}

const until = (check, what) => new Promise((resolve, reject) => {
  const started = Date.now()
  const poll = async () => {
    const value = await check()
    if (value) resolve(value)
    else if (Date.now() - started > 8000) reject(new Error(`No ${what}`))
    else setTimeout(poll, 10)
  }
  poll()
})
const pause = ms => new Promise(resolve => setTimeout(resolve, ms))
const selected = optionId => ({ outcome: { outcome: 'selected', optionId } })
const backups = async directory => (await readdir(directory)).filter(name => name.startsWith('acp.json.before-megachat-'))

test('with the registry agent and an own entry, the dialog asks one time, and Remove removes the entry with a backup after the turn', { timeout: 20000 }, async t => {
  const { directory, service, daemon, entries, acp } = await open(t)
  const original = JSON.stringify({ agent_servers: { Other: { command: '/bin/other' }, Megachat: RELEASE_ENTRY } })
  await writeFile(acp, original)
  await writeFile(join(directory, 'installed.json'), INSTALLED)
  await service.state.change(busy)
  const air = await view(t, daemon, entries, () => selected('remove'))
  await until(() => air.asked.length, 'dialog')
  const params = air.asked[0]
  assert.equal(params.sessionId, air.sessionId)
  assert.equal(params.toolCall.title, 'Megachat is installed two times')
  assert.equal(params.toolCall.rawInput.command, `"Megachat": ${JSON.stringify(RELEASE_ENTRY)}`)
  assert.deepEqual(params.options.map(option => [option.optionId, option.kind, option.name]),
    [['remove', 'allow_once', 'Remove the copy'], ['keep', 'reject_once', 'Keep both']])
  assert.equal(params._meta.jetbrains.air.permission.description, message('entry.dialog.description', acp))
  assert.match(params._meta.jetbrains.air.permission.description, /The two copies can stop the tasks of each other\. Remove the copy from acp\.json\? This chat and its history stay\.$/)
  // While a turn runs, the entry stays.
  await pause(100)
  assert.equal(await readFile(acp, 'utf8'), original)
  await service.state.change(state => { state.current = null })
  await until(async () => (await backups(directory)).length, 'removal')
  assert.equal(await readFile(join(directory, (await backups(directory))[0]), 'utf8'), original)
  assert.deepEqual(JSON.parse(await readFile(acp, 'utf8')), { agent_servers: { Other: { command: '/bin/other' } } })
  // The choice is made, so the next attach of this process asks nothing.
  await air.attach()
  await pause(100)
  assert.equal(air.asked.length, 1)
})

test('Keep goes to settings.json, and no later view or start asks again', { timeout: 20000 }, async t => {
  const { directory, daemon, entries, acp, settingsPath } = await open(t)
  const original = JSON.stringify({ agent_servers: { Megachat: RELEASE_ENTRY } })
  await writeFile(acp, original)
  await writeFile(join(directory, 'installed.json'), INSTALLED)
  const air = await view(t, daemon, entries, () => selected('keep'))
  await until(async () => JSON.parse(await readFile(settingsPath, 'utf8').catch(() => '{}')).acpEntry === 'keep', 'choice')
  assert.equal(air.asked.length, 1)
  // A new process of Megachat asks the daemon first, and the choice is there.
  const later = await view(t, daemon, entries, () => assert.fail('no second dialog'))
  await later.attach()
  await pause(100)
  assert.equal(later.asked.length, 0)
  assert.equal(await readFile(acp, 'utf8'), original)
  assert.deepEqual(await backups(directory), [])
})

test('cancelled is no choice: the next attach asks again, and only one dialog runs at a time', { timeout: 20000 }, async t => {
  const { directory, daemon, entries, acp } = await open(t)
  await writeFile(acp, JSON.stringify({ agent_servers: { Megachat: RELEASE_ENTRY } }))
  await writeFile(join(directory, 'installed.json'), INSTALLED)
  const pending = Promise.withResolvers()
  const air = await view(t, daemon, entries, (params, count) => count === 1 ? { outcome: { outcome: 'cancelled' } } : pending.promise)
  await until(() => air.asked.length === 1, 'dialog')
  await pause(50)
  await air.attach()
  await until(() => air.asked.length === 2, 'second dialog')
  // A third attach while the second dialog shows sends no third dialog.
  await air.attach()
  await pause(100)
  assert.equal(air.asked.length, 2)
  pending.resolve(selected('remove'))
  await until(async () => (await backups(directory)).length, 'removal')
})

test('an entry that the user changed gets its own text, and Remove also removes it with a backup', { timeout: 20000 }, async t => {
  const { directory, daemon, entries, acp } = await open(t)
  const changed = { ...RELEASE_ENTRY, env: { ...RELEASE_ENTRY.env, HTTPS_PROXY: 'http://proxy.example.com:3128' } }
  await writeFile(acp, JSON.stringify({ agent_servers: { Megachat: changed } }))
  await writeFile(join(directory, 'installed.json'), INSTALLED)
  const air = await view(t, daemon, entries, () => selected('remove'))
  await until(async () => (await backups(directory)).length, 'removal')
  assert.equal(air.asked[0]._meta.jetbrains.air.permission.description, message('entry.dialog.description.changed', acp))
  assert.match(air.asked[0]._meta.jetbrains.air.permission.description, /This chat and its history stay\. The acp\.json entry has your changes\.$/)
  assert.deepEqual(JSON.parse(await readFile(acp, 'utf8')), { agent_servers: {} })
})

test('without the registry agent, or without the entry, no dialog shows', { timeout: 20000 }, async t => {
  const { directory, daemon, entries, acp } = await open(t)
  await writeFile(acp, JSON.stringify({ agent_servers: { Megachat: RELEASE_ENTRY } }))
  const air = await view(t, daemon, entries, () => assert.fail('no dialog'))
  await pause(100)
  await writeFile(join(directory, 'installed.json'), INSTALLED)
  await writeFile(acp, JSON.stringify({ agent_servers: { Other: { command: '/bin/other' } } }))
  await air.attach()
  await pause(100)
  assert.equal(air.asked.length, 0)
})

test('an entry that changes while the removal waits for the end of a turn stays', { timeout: 20000 }, async t => {
  const { directory, service, daemon, entries, acp } = await open(t)
  await writeFile(acp, JSON.stringify({ agent_servers: { Megachat: RELEASE_ENTRY } }))
  await writeFile(join(directory, 'installed.json'), INSTALLED)
  await service.state.change(busy)
  const air = await view(t, daemon, entries, () => selected('remove'))
  await until(() => air.asked.length, 'dialog')
  const edited = JSON.stringify({ agent_servers: { Megachat: { ...RELEASE_ENTRY, env: { A: '1' } } } })
  await writeFile(acp, edited)
  await service.state.change(state => { state.current = null })
  await pause(200)
  assert.equal(await readFile(acp, 'utf8'), edited)
  assert.deepEqual(await backups(directory), [])
})

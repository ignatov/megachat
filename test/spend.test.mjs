import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { DailySpend, localDay, requestCost } from '../src/DailySpend.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'

const HOUR = 3600000
const text = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const WARNING = /That is more than the daily limit of/

/** A clock that moves only when a test sets it. It starts at 22:00 local time, two hours before the midnight. */
function fakeClock() {
  let now = new Date(2026, 10, 11, 22, 0).getTime()
  return { now: () => now, advance: ms => { now += ms } }
}

async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-spend-')))
  // A service of the test closes after this hook runs, and its last write of the count can still run.
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  return directory
}

test('the count of a day stays in a private file across a restart, starts again at the midnight, and warns one time each day', async t => {
  const directory = await temporary(t)
  const path = join(directory, 'spend.json')
  const clock = fakeClock()
  const first = await DailySpend.open(path, clock)
  assert.equal(first.add(0.4, 1), false)
  assert.equal(first.add(0.4, 1), false)
  await first.save()
  assert.equal((await stat(path)).mode & 0o777, 0o600)
  const second = await DailySpend.open(path, clock)
  assert.deepEqual(second.report(1), { day: localDay(clock.now()), usd: 0.8, limit: 1, warned: false })
  assert.equal(second.add(0.4, 1), true)
  assert.deepEqual(second.notice(1), { usd: 1.2000000000000002, limit: 1 })
  // A higher limit hides the warning, and a lower one brings it back.
  assert.equal(second.notice(5), undefined)
  assert.ok(second.notice(1))
  second.shown()
  assert.equal(second.add(1, 1), false)
  assert.equal(second.notice(1), undefined)
  await second.save()
  const third = await DailySpend.open(path, clock)
  assert.equal(third.report(1).warned, true)
  clock.advance(3 * HOUR)
  assert.deepEqual(third.report(1), { day: localDay(clock.now()), usd: 0, limit: 1, warned: false })
  assert.notEqual(third.report(1).day, second.data.day)
  assert.equal(third.add(2, 1), true)
  // A limit of 0 is no limit.
  const unlimited = await DailySpend.open(undefined, clock)
  assert.equal(unlimited.add(1000, 0), false)
  assert.equal(unlimited.notice(0), undefined)
  // A file that the daemon cannot read gives a new count.
  await writeFile(path, '{ "schema": 1,')
  assert.equal((await DailySpend.open(path, clock)).report(1).usd, 0)
})

test('the cost comes from the provider, else from the prices of the model data', () => {
  assert.equal(requestCost({ input: 10, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.25 } }, undefined), 0.25)
  const model = { cost: { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 } }
  assert.equal(requestCost({ input: 1000000, output: 100000, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } }, model), 3)
  assert.equal(requestCost(undefined, model), 0)
})

/** A fake provider with prices, so each request has a cost. Each request records its system prompt and its kind. */
function fakeModels() {
  const fake = fauxProvider({ models: [{ id: 'priced', reasoning: true, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } }] })
  const requests = []
  fake.setResponses(Array(200).fill(async (context, options) => {
    const summary = context.messages.some(item => item.role === 'system' && text(item.content).startsWith('You summarize'))
    const sections = new Map()
    for (const item of context.messages) {
      if (item.role !== 'system' || !item.sections) continue
      for (const [key, value] of Object.entries(item.sections)) value === null ? sections.delete(key) : sections.set(key, value)
    }
    requests.push({ kind: summary ? 'summary' : options.maxTokens === 1 ? 'ping' : 'turn', system: [...sections.values()].join('\n') })
    return fauxAssistantMessage(summary ? 'SUMMARY' : 'Answer.')
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  return { models, requests }
}

async function open(t, directory, clock) {
  const { models, requests } = fakeModels()
  const service = await PiMegachatService.open(new MemoryStorage(), models, undefined, undefined, {
    settingsPath: join(directory, 'settings.json'), spendPath: join(directory, 'spend.json'), clock, environment: {},
    keepAlive: { minTokens: 1000, enabled: false } })
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  t.after(async () => { await server.close(); await service.close() })
  const say = async (id, content) => {
    const receipt = await service.submit(id, content)
    await daemon.json(`/wait?submission=${receipt.submissionId}`)
    await waitForState(service.state, state => state.current === null ? true : undefined)
  }
  const settings = service.extension().tools.find(item => item.name === 'agents_settings')
  const tool = async args => JSON.parse((await settings.execute(args)).output[0].text)
  return { service, requests, say, tool }
}

test('the main agent warns one time each day when the spend of its requests passes the limit', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done',
    values: { 'coordinator.model': 'faux/priced', 'budget.dailyUsd': 0.000001 } }), { mode: 0o600 })
  const clock = fakeClock()
  const { service, requests, say, tool } = await open(t, directory, clock)
  await say('first', 'A question.')
  assert.doesNotMatch(requests[0].system, WARNING)
  // The reply passed the limit, so the next turn has the warning, and only that turn.
  await say('second', 'A question.')
  assert.match(requests[1].system, WARNING)
  assert.match(requests[1].system, /limit of 0\.000001 USD/)
  await say('third', 'A question.')
  assert.doesNotMatch(requests[2].system, WARNING)
  const described = await tool({ action: 'get' })
  assert.equal(described.spend.limit, 0.000001)
  assert.equal(described.spend.warned, true)
  assert.ok(described.spend.usd > 0)
  assert.equal(described.spend.note, message('settings.spend.note'))
  // A keep-alive request counts too.
  const before = service.spend.data.usd
  await service.ping(undefined)
  assert.ok(service.spend.data.usd > before)
  await service.spend.queue
  const stored = JSON.parse(await readFile(join(directory, 'spend.json'), 'utf8'))
  assert.equal(stored.warning, 'shown')
  // After the midnight, the count starts again, and the next request that passes the limit gives a new warning.
  clock.advance(3 * HOUR)
  await say('fourth', 'A question.')
  assert.doesNotMatch(requests.at(-1).system, WARNING)
  await say('fifth', 'A question.')
  assert.match(requests.at(-1).system, WARNING)
  assert.equal((await tool({ action: 'get' })).spend.day, localDay(clock.now()))
})

test('a summary request counts, and a restart of the daemon keeps the count of the day', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done',
    values: { 'coordinator.model': 'faux/priced' } }), { mode: 0o600 })
  const clock = fakeClock()
  const first = await open(t, directory, clock)
  const large = word => `${word} `.repeat(40000 / (word.length + 1))
  for (const word of ['alpha', 'beta', 'gamma']) await first.say(word, large(word))
  const before = first.service.spend.data.usd
  assert.deepEqual(await first.service.compact(), { compacted: true })
  assert.ok(first.requests.some(request => request.kind === 'summary'))
  assert.ok(first.service.spend.data.usd > before)
  await first.service.spend.queue
  const spent = first.service.spend.data.usd
  const second = await open(t, directory, clock)
  assert.equal(second.service.spend.data.usd, spent)
  assert.equal((await second.tool({ action: 'get' })).spend.limit, 0)
})

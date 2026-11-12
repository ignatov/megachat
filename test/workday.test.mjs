import assert from 'node:assert/strict'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { PromptCacheKeepAlive } from '../src/PromptCacheKeepAlive.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { isWorkingTime, localTime, resolvedTimezone, workdaySettings } from '../src/Workday.mjs'
import { fakeClock } from './fake-clock.mjs'

const MINUTE = 60000
const HOUR = 60 * MINUTE
/** The working day of the defaults, in UTC, so that a test does not depend on the timezone of the machine. */
const WORKDAY = { start: '09:00', end: '19:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], timezone: 'UTC', idleMinutes: 30 }
const at = text => Date.parse(text)
/** The UTC time of [ms] as `MM-DD HH:MM`. */
const clockText = ms => new Date(ms).toISOString().replace(/^\d{4}-(\d\d-\d\d)T(\d\d:\d\d).*$/, '$1 $2')

/** Runs [body] and returns the lines that it wrote to the standard error. */
async function logLines(t, body) {
  const lines = []
  t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true })
  try { await body() }
  finally { process.stderr.write.mock.restore() }
  return lines
}

/**
 * A keep-alive with a 1-hour cache and a context of [size] tokens, on a fake clock that starts at the UTC time [start].
 * Each ping and summary goes into `events` with its UTC time.
 */
function fixture({ start, size = 50000, ttlMs = HOUR, ...options } = {}) {
  const workday = Object.hasOwn(options, 'workday') ? options.workday : WORKDAY
  const clock = fakeClock(start)
  const events = []
  const usage = { input: 10, cacheRead: size, cacheWrite: 0, output: 1, cost: { total: 0.01 } }
  const keepAlive = new PromptCacheKeepAlive({
    ttlMs, windowMs: 6 * HOUR, compactTokens: 100000, workday, clock, tokens: async () => size,
    ping: async () => { events.push(`ping ${clockText(clock.now())}`); return usage },
    compact: async () => { events.push(`compact ${clockText(clock.now())}`); return { compacted: true } },
  })
  const advance = ms => clock.advance(ms, () => keepAlive.running)
  return { clock, events, keepAlive, advance }
}

/** The keep-alive events of a turn that ends at [start] and of the next [hours] without a turn. */
async function eventsAfterTurn(t, options, hours = 24) {
  const { keepAlive, advance, events } = fixture(options)
  const lines = await logLines(t, async () => {
    keepAlive.turnEnded()
    await advance(hours * HOUR)
  })
  await keepAlive.close()
  return { events, lines }
}

test('the working time follows the hours, the days and the timezone of the settings', () => {
  // 2026-11-11 is a Wednesday, and 2026-11-14 is a Saturday.
  assert.equal(isWorkingTime(WORKDAY, at('2026-11-11T08:59:59Z')), false)
  assert.equal(isWorkingTime(WORKDAY, at('2026-11-11T09:00:00Z')), true)
  assert.equal(isWorkingTime(WORKDAY, at('2026-11-11T18:59:59Z')), true)
  assert.equal(isWorkingTime(WORKDAY, at('2026-11-11T19:00:00Z')), false)
  assert.equal(isWorkingTime(WORKDAY, at('2026-11-14T12:00:00Z')), false)
  assert.equal(isWorkingTime({ ...WORKDAY, days: ['sat'] }, at('2026-11-14T12:00:00Z')), true)
  // One time is in the working hours of New York and Berlin, and not in those of Tokyo, where it is the next day.
  const evening = at('2026-11-11T16:00:00Z')
  assert.equal(isWorkingTime({ ...WORKDAY, timezone: 'America/New_York' }, evening), true)
  assert.equal(isWorkingTime({ ...WORKDAY, timezone: 'Europe/Berlin' }, evening), true)
  assert.equal(isWorkingTime({ ...WORKDAY, timezone: 'Asia/Tokyo' }, evening), false)
  // Friday night in UTC is Saturday morning in Tokyo, which is no working day.
  assert.deepEqual(localTime(at('2026-11-13T23:30:00Z'), 'Asia/Tokyo'), { day: 'sat', minute: 8 * 60 + 30 })
  assert.equal(isWorkingTime({ ...WORKDAY, timezone: 'Asia/Tokyo' }, at('2026-11-13T23:30:00Z')), false)
  // auto is the timezone of the system.
  assert.deepEqual(localTime(evening, 'auto'), localTime(evening, resolvedTimezone('auto')))
  assert.equal(isWorkingTime({ ...WORKDAY, timezone: 'auto' }, evening), isWorkingTime({ ...WORKDAY, timezone: resolvedTimezone('auto') }, evening))
})

test('the working hours move with the daylight saving time of the timezone', () => {
  const berlin = { ...WORKDAY, timezone: 'Europe/Berlin' }
  // Berlin leaves the summer time on Sunday 2026-10-25. 07:30 UTC is 09:30 on the Friday before and 08:30 on the Monday after.
  assert.equal(isWorkingTime(berlin, at('2026-10-23T07:30:00Z')), true)
  assert.equal(isWorkingTime(berlin, at('2026-10-26T07:30:00Z')), false)
  assert.equal(isWorkingTime(berlin, at('2026-10-26T08:30:00Z')), true)
  // 17:30 UTC is 19:30 on the Friday, after the end, and 18:30 on the Monday, before the end.
  assert.equal(isWorkingTime(berlin, at('2026-10-23T17:30:00Z')), false)
  assert.equal(isWorkingTime(berlin, at('2026-10-26T17:30:00Z')), true)
  // Berlin starts the summer time on Sunday 2026-03-29.
  assert.equal(isWorkingTime(berlin, at('2026-03-27T07:30:00Z')), false)
  assert.equal(isWorkingTime(berlin, at('2026-03-30T07:30:00Z')), true)
})

test('working hours can go past midnight, equal times give the whole day, and off gives no working-day settings', () => {
  // 2026-11-09 is a Monday.
  const night = { ...WORKDAY, start: '22:00', end: '06:00', days: ['mon'] }
  assert.equal(isWorkingTime(night, at('2026-11-09T23:00:00Z')), true)
  assert.equal(isWorkingTime(night, at('2026-11-10T05:59:00Z')), true)
  assert.equal(isWorkingTime(night, at('2026-11-10T06:00:00Z')), false)
  assert.equal(isWorkingTime(night, at('2026-11-10T23:00:00Z')), false)
  assert.equal(isWorkingTime(night, at('2026-11-09T05:00:00Z')), false)
  const allDay = { ...WORKDAY, start: '00:00', end: '00:00' }
  assert.equal(isWorkingTime(allDay, at('2026-11-11T23:59:00Z')), true)
  assert.equal(isWorkingTime(allDay, at('2026-11-14T12:00:00Z')), false)
  const values = { 'workday.enabled': false, 'workday.start': '08:00', 'workday.end': '17:00', 'workday.days': ['mon'],
    'workday.timezone': 'auto', 'workday.idleMinutes': 10 }
  assert.equal(workdaySettings(values), undefined)
  assert.deepEqual(workdaySettings({ ...values, 'workday.enabled': true }),
    { start: '08:00', end: '17:00', days: ['mon'], timezone: 'auto', idleMinutes: 10 })
})

test('without the working day, the keep-alive requests at night are the keep-alive requests of today', async t => {
  const { events } = await eventsAfterTurn(t, { start: '2026-11-11T23:00:00Z', workday: undefined })
  assert.deepEqual(events, ['11-11 23:50', '11-12 00:40', '11-12 01:30', '11-12 02:20', '11-12 03:10', '11-12 04:00', '11-12 04:50']
    .map(time => `ping ${time}`))
})

test('the keep-alive requests stop at the end of the working hours, and the conversation then sleeps until the next turn', async t => {
  const { events, lines } = await eventsAfterTurn(t, { start: '2026-11-11T17:00:00Z' })
  // No request goes out after 19:00, and none the next morning without a turn.
  assert.deepEqual(events, ['ping 11-11 17:50', 'ping 11-11 18:40'])
  assert.equal(lines.filter(line => line.includes('went to sleep')).length, 1)
  assert.match(lines.at(-1), /^\S+Z Outside the working hours, the idle conversation of 50000 tokens went to sleep\. No keep-alive request goes out until the next turn\.\n$/)
  // A new turn in the morning starts the keep-alive requests again.
  const { keepAlive, advance, events: morning, clock } = fixture({ start: '2026-11-11T17:00:00Z' })
  await logLines(t, async () => {
    keepAlive.turnEnded()
    await advance(16 * HOUR)
    assert.equal(clockText(clock.now()), '11-12 09:00')
    keepAlive.turnStarted()
    keepAlive.turnEnded()
    await advance(HOUR)
  })
  assert.deepEqual(morning, ['ping 11-11 17:50', 'ping 11-11 18:40', 'ping 11-12 09:50'])
  await keepAlive.close()
})

test('the summary of a large conversation waits for the idle time after the end, runs one time, and comes also on a cold cache', async t => {
  // The user still works at 19:10. With 55 minutes of idle time, the summary comes at 20:05, before the cache expires at 20:10.
  const late = await eventsAfterTurn(t, { start: '2026-11-11T19:10:00Z', size: 150000, workday: { ...WORKDAY, idleMinutes: 55 } })
  assert.deepEqual(late.events, ['compact 11-11 20:05'])
  assert.ok(late.lines.some(line => /got a summary before the prompt cache expired: done\./.test(line)))
  assert.ok(late.lines.some(line => line.includes('went to sleep')))
  // With the default idle time, the idle daemon acts at 5/6 of the cache lifetime, as in the working hours.
  const usual = await eventsAfterTurn(t, { start: '2026-11-11T19:10:00Z', size: 150000 })
  assert.deepEqual(usual.events, ['compact 11-11 20:00'])
  // The idle time ends after the cache lifetime. The summary request reads no prompt cache, so the summary comes all the
  // same, one time, at the end of the idle time.
  const cold = await eventsAfterTurn(t, { start: '2026-11-11T19:10:00Z', size: 150000, workday: { ...WORKDAY, idleMinutes: 120 } })
  assert.deepEqual(cold.events, ['compact 11-11 21:10'])
  assert.ok(cold.lines.some(line => /got a summary after the prompt cache expired: done\./.test(line)))
  // With the 5-minute cache, the summary comes at the end of the default idle time of 30 minutes.
  const short = await eventsAfterTurn(t, { start: '2026-11-11T19:10:00Z', size: 150000, ttlMs: 5 * MINUTE })
  assert.deepEqual(short.events, ['compact 11-11 19:40'])
  // In the working hours, a late timer of a computer that slept still does nothing on a cold cache.
  const asleep = fixture({ start: '2026-11-11T12:00:00Z', size: 150000 })
  asleep.keepAlive.turnEnded()
  asleep.clock.sleep(2 * HOUR)
  await asleep.advance(HOUR)
  assert.deepEqual(asleep.events, [])
  await asleep.keepAlive.close()
  // In the working hours, a large conversation gets its summary as without the working day.
  const day = await eventsAfterTurn(t, { start: '2026-11-11T12:00:00Z', size: 150000 })
  assert.deepEqual(day.events, ['compact 11-11 12:50'])
})

test('a small conversation outside the working hours gets no summary and no keep-alive request', async t => {
  const medium = await eventsAfterTurn(t, { start: '2026-11-11T18:30:00Z', size: 50000 })
  assert.deepEqual(medium.events, [])
  assert.ok(medium.lines.some(line => line.includes('of 50000 tokens went to sleep')))
})

test('a turn at night starts no keep-alive request, and the idle rule applies after it', async t => {
  const medium = await eventsAfterTurn(t, { start: '2026-11-11T23:00:00Z' })
  assert.deepEqual(medium.events, [])
  const large = await eventsAfterTurn(t, { start: '2026-11-11T23:00:00Z', size: 150000 })
  assert.deepEqual(large.events, ['compact 11-11 23:50'])
  // A restart at night sends no keep-alive request for the last message of the conversation.
  const { keepAlive, advance, events, clock } = fixture({ start: '2026-11-11T23:00:00Z' })
  await logLines(t, async () => {
    keepAlive.turnEnded(clock.now() - 20 * MINUTE)
    await advance(9 * HOUR)
  })
  assert.deepEqual(events, [])
  await keepAlive.close()
})

test('a weekend, another timezone and a change of the daylight saving time decide the keep-alive requests', async t => {
  // 2026-11-14 is a Saturday.
  assert.deepEqual((await eventsAfterTurn(t, { start: '2026-11-14T12:00:00Z' })).events, [])
  assert.deepEqual((await eventsAfterTurn(t, { start: '2026-11-14T17:00:00Z', workday: { ...WORKDAY, days: ['sat'] } })).events,
    ['ping 11-14 17:50', 'ping 11-14 18:40'])
  // 22:00 UTC is 17:00 in New York, so the requests go out until 19:00 there, which is 00:00 UTC.
  assert.deepEqual((await eventsAfterTurn(t, { start: '2026-11-11T22:00:00Z', workday: { ...WORKDAY, timezone: 'America/New_York' } })).events,
    ['ping 11-11 22:50', 'ping 11-11 23:40'])
  assert.deepEqual((await eventsAfterTurn(t, { start: '2026-11-11T22:00:00Z' })).events, [])
  // 17:00 UTC is 19:00 in Berlin in the summer time, and 18:00 after the change on 2026-10-25.
  const berlin = { ...WORKDAY, timezone: 'Europe/Berlin' }
  assert.deepEqual((await eventsAfterTurn(t, { start: '2026-10-19T17:00:00Z', workday: berlin })).events, [])
  assert.deepEqual((await eventsAfterTurn(t, { start: '2026-10-26T17:00:00Z', workday: berlin })).events, ['ping 10-26 17:50'])
})

const text = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')

/**
 * A service with `settings.json` that holds [values], a fake model, and a fake clock that starts at the UTC time [start].
 * [requests] gets each model request with its kind, its UTC time, whether its context holds the summary, and the size of
 * its context in characters. [replies] gives the replies of the first turn requests, else `Answer.`.
 */
async function serviceFixture(t, { start, values, replies = [] }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-workday-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  if (values) await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values }), { mode: 0o600 })
  const clock = fakeClock(start)
  const fake = fauxProvider()
  const requests = []
  fake.setResponses(Array(100).fill(async (context, options) => {
    const summary = context.messages.some(model => model.role === 'system' && text(model.content).startsWith('You summarize'))
    requests.push({ kind: summary ? 'summary' : options.maxTokens === 1 ? 'ping' : 'turn', at: clockText(clock.now()),
      fromSummary: JSON.stringify(context.messages).includes('SUMMARY-OF-OLD-PART'), size: JSON.stringify(context.messages).length })
    if (summary) return fauxAssistantMessage('SUMMARY-OF-OLD-PART')
    return replies.length ? replies.shift()(directory) : fauxAssistantMessage('Answer.')
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, undefined,
    { settingsPath: join(directory, 'settings.json'), environment: {}, keepAlive: { clock, minTokens: 1000 } })
  await service.state.addWorkspace(directory)
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  t.after(async () => { await server.close(); await service.close() })
  const say = async (id, content) => {
    const receipt = await service.submit(id, content)
    const settled = await daemon.json(`/wait?submission=${receipt.submissionId}`)
    // The state watch tells the end of the turn to the keep-alive after the wait returns.
    for (let attempt = 0; attempt < 200 && service.keepAlive?.busy; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    return settled
  }
  const tool = async args => {
    const settings = service.extension().tools.find(item => item.name === 'agents_settings')
    return JSON.parse((await settings.execute(args)).output[0].text)
  }
  const advance = ms => clock.advance(ms, () => service.keepAlive?.running)
  return { service, requests, say, tool, advance, directory, clock }
}

const large = word => `${word} `.repeat(40000 / (word.length + 1))
const UTC_WORKDAY = { 'workday.enabled': true, 'workday.timezone': 'UTC' }

test('at the end of the day the large conversation gets one summary on a warm cache, and the first morning turn starts from it', { timeout: 30000 }, async t => {
  const { service, requests, say, advance } = await serviceFixture(t, { start: '2026-11-11T18:30:00Z', values: UTC_WORKDAY })
  // The limit of a turn stays at 100,000 tokens, so no turn writes a summary. Only the idle daemon gets a lower limit.
  service.keepAlive.compactTokens = 25000
  for (const word of ['alpha', 'beta', 'gamma']) await say(word, large(word))
  const turns = requests.length
  const before = requests.at(-1).size
  await logLines(t, async () => { await advance(14.5 * HOUR) })
  // The summary comes at 5/6 of the cache lifetime after the last turn at 18:30, so the cache is warm.
  assert.deepEqual(requests.slice(turns).map(request => `${request.kind} ${request.at}`), ['summary 11-11 19:20'])
  assert.notEqual((await service.root.context(BACKGROUND_CONTEXT)).head, undefined)
  await say('morning', 'Good morning.')
  const morning = requests.at(-1)
  assert.deepEqual([morning.kind, morning.at, morning.fromSummary], ['turn', '11-12 09:00', true])
  // The summary replaced the older part, so the morning request is smaller than the last turn of the evening.
  assert.ok(morning.size < before)
})

test('a turn at night works, and the idle rule stops the keep-alive request that would follow it', { timeout: 30000 }, async t => {
  const night = await serviceFixture(t, { start: '2026-11-11T23:00:00Z', values: UTC_WORKDAY })
  const settled = await night.say('first', large('alpha'))
  assert.equal(settled.status, 'completed')
  await logLines(t, async () => { await night.advance(9 * HOUR) })
  assert.deepEqual(night.requests.map(request => request.kind), ['turn'])
  // Without the working day, the same turn gets keep-alive requests.
  const off = await serviceFixture(t, { start: '2026-11-11T23:00:00Z' })
  assert.equal(off.service.keepAlive.workday, undefined)
  await off.say('first', large('alpha'))
  await logLines(t, async () => { await off.advance(HOUR) })
  assert.deepEqual(off.requests.map(request => request.kind), ['turn', 'ping'])
})

test('a child result at night starts its turn at once, and the idle rule applies after that turn', { timeout: 30000 }, async t => {
  const { service, requests, say, advance, clock } = await serviceFixture(t, { start: '2026-11-11T23:00:00Z', values: UTC_WORKDAY, replies: [
    cwd => fauxAssistantMessage(fauxToolCall('agents_spawn', { cwd, prompt: 'Run the long build.' }), { stopReason: 'toolUse' }),
  ] })
  await say('task', large('alpha'))
  const [run] = Object.values((await service.state.snapshot()).runs)
  const lines = await logLines(t, async () => {
    await advance(3 * HOUR)
    // The sleep does not stop the child. Its result at 02:00 starts a turn at once.
    await service.state.transition(run.id, ['admitted'], { status: 'completed', output: 'The build passed.' })
    await waitForState(service.state, state => !state.current && state.runs[run.id].reported ? true : undefined)
    for (let attempt = 0; attempt < 200 && service.keepAlive.busy; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(service.keepAlive.idleSince, clock.now())
    await advance(9 * HOUR)
  })
  assert.deepEqual(requests.map(request => `${request.kind} ${request.at}`), ['turn 11-11 23:00', 'turn 11-11 23:00', 'turn 11-12 02:00'])
  // The conversation went to sleep after the turn of the user and again after the turn of the child result.
  assert.equal(lines.filter(line => line.includes('went to sleep')).length, 2)
})

test('a settings.json without the working-day keys opens, and the settings change the keep-alive of a running daemon', { timeout: 30000 }, async t => {
  const { service, tool, directory } = await serviceFixture(t, { start: '2026-11-11T12:00:00Z', values: { 'keepAlive.hours': 3 } })
  const described = (await tool({ action: 'get' })).settings.filter(entry => entry.key.startsWith('workday.'))
  assert.deepEqual(described.map(entry => [entry.key, entry.value, entry.source]), [
    ['workday.enabled', false, 'default'], ['workday.start', '09:00', 'default'], ['workday.end', '19:00', 'default'],
    ['workday.days', ['mon', 'tue', 'wed', 'thu', 'fri'], 'default'], ['workday.timezone', 'auto', 'default'],
    ['workday.idleMinutes', 30, 'default']])
  assert.equal(service.keepAlive.workday, undefined)
  await tool({ action: 'set', key: 'workday.enabled', value: 'on' })
  assert.deepEqual(service.keepAlive.workday, { start: '09:00', end: '19:00', days: ['mon', 'tue', 'wed', 'thu', 'fri'], timezone: 'auto', idleMinutes: 30 })
  await tool({ action: 'set', key: 'workday.end', value: '18:00' })
  await tool({ action: 'set', key: 'workday.days', value: ['mon', 'wed'] })
  await tool({ action: 'set', key: 'workday.timezone', value: 'Europe/Berlin' })
  await tool({ action: 'set', key: 'workday.idleMinutes', value: '45' })
  assert.deepEqual(service.keepAlive.workday, { start: '09:00', end: '18:00', days: ['mon', 'wed'], timezone: 'Europe/Berlin', idleMinutes: 45 })
  assert.equal(service.keepAlive.windowMs, 3 * HOUR)
  assert.deepEqual(JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8')).values, { 'keepAlive.hours': 3, 'workday.enabled': true,
    'workday.end': '18:00', 'workday.days': ['mon', 'wed'], 'workday.timezone': 'Europe/Berlin', 'workday.idleMinutes': 45 })
  // Without the keep-alive, the working day has no effect.
  await tool({ action: 'set', key: 'keepAlive.enabled', value: false })
  assert.equal(service.keepAlive, undefined)
  await tool({ action: 'reset', key: 'keepAlive.enabled' })
  await tool({ action: 'set', key: 'workday.enabled', value: false })
  assert.equal(service.keepAlive.workday, undefined)
})

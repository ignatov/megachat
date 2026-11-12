import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { CACHE_TTL_VARIABLE, KEEPALIVE_HOURS_VARIABLE, KEEPALIVE_VARIABLE, keepAliveSettings, PromptCacheKeepAlive } from '../src/PromptCacheKeepAlive.mjs'
import { fakeClock } from './fake-clock.mjs'

const MINUTE = 60000
const HOUR = 60 * MINUTE

/** A keep-alive on a fake clock with a 1-hour cache and a context of [size] tokens. It records each ping and summary. */
function timerFixture({ size = 50000, windowMs = 6 * HOUR, ping } = {}) {
  const clock = fakeClock()
  const start = clock.now()
  const events = []
  const usage = { input: 10, cacheRead: size, cacheWrite: 0, output: 1, cost: { total: 0.01 } }
  const keepAlive = new PromptCacheKeepAlive({
    ttlMs: HOUR, windowMs, compactTokens: 100000, clock, tokens: async () => size,
    ping: ping ?? (async () => { events.push(`ping ${(clock.now() - start) / MINUTE}`); return usage }),
    compact: async () => { events.push(`compact ${(clock.now() - start) / MINUTE}`); return { compacted: true } },
  })
  const advance = ms => clock.advance(ms, () => keepAlive.running)
  return { clock, events, keepAlive, advance, usage }
}

/** Runs [body] and returns the lines that it wrote to the standard error. */
async function logLines(t, body) {
  const lines = []
  t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true })
  try { await body() }
  finally { process.stderr.write.mock.restore() }
  return lines
}

test('the variables set the cache lifetime, the idle time of the keep-alive requests, and turn them off', () => {
  assert.deepEqual(keepAliveSettings({}), { retention: 'long', enabled: true, windowMs: 6 * HOUR })
  assert.equal(keepAliveSettings({ [CACHE_TTL_VARIABLE]: '5m' }).retention, 'short')
  assert.equal(keepAliveSettings({ [CACHE_TTL_VARIABLE]: '1h' }).retention, 'long')
  assert.equal(keepAliveSettings({ [CACHE_TTL_VARIABLE]: 'long' }).retention, 'long')
  assert.equal(keepAliveSettings({ [KEEPALIVE_VARIABLE]: '0' }).enabled, false)
  assert.equal(keepAliveSettings({ [KEEPALIVE_VARIABLE]: '1' }).enabled, true)
  assert.equal(keepAliveSettings({ [KEEPALIVE_HOURS_VARIABLE]: '2' }).windowMs, 2 * HOUR)
  assert.equal(keepAliveSettings({ [KEEPALIVE_HOURS_VARIABLE]: '0.5' }).windowMs, 30 * MINUTE)
  assert.equal(keepAliveSettings({ [KEEPALIVE_HOURS_VARIABLE]: '0' }).windowMs, 0)
  assert.equal(keepAliveSettings({ [KEEPALIVE_HOURS_VARIABLE]: 'long' }).windowMs, 6 * HOUR)
  assert.equal(keepAliveSettings({ [KEEPALIVE_HOURS_VARIABLE]: '-1' }).windowMs, 6 * HOUR)
})

test('a keep-alive request goes out at 5/6 of the cache lifetime after the last model request, and then again', async t => {
  const { events, keepAlive, advance } = timerFixture()
  const lines = await logLines(t, async () => {
    keepAlive.turnEnded()
    await advance(50 * MINUTE - 1)
    assert.deepEqual(events, [])
    await advance(1)
    assert.deepEqual(events, ['ping 50'])
    await advance(50 * MINUTE)
    assert.deepEqual(events, ['ping 50', 'ping 100'])
  })
  // The log has the token counts of each request, so a profiler can count the cost.
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^\S+Z A keep-alive request kept the prompt cache warm: context 50000, input 10, cache read 50000, cache write 0, output 1 tokens, cost 0\.01 USD\.\n$/)
  await keepAlive.close()
})

test('the keep-alive requests stop 6 hours after the last turn', async t => {
  const { events, keepAlive, advance } = timerFixture()
  await logLines(t, async () => {
    keepAlive.turnEnded()
    await advance(24 * HOUR)
  })
  assert.deepEqual(events, [50, 100, 150, 200, 250, 300, 350].map(minute => `ping ${minute}`))
  // A new turn starts the idle time again.
  const short = timerFixture({ windowMs: 2 * HOUR })
  await logLines(t, async () => {
    short.keepAlive.turnEnded()
    await short.advance(24 * HOUR)
    assert.deepEqual(short.events, ['ping 50', 'ping 100'])
    short.keepAlive.turnStarted()
    short.keepAlive.turnEnded()
    await short.advance(50 * MINUTE)
  })
  assert.deepEqual(short.events, ['ping 50', 'ping 100', `ping ${24 * 60 + 50}`])
})

test('no keep-alive request goes out while a turn runs, and a turn stops a request that runs', async t => {
  const { events, keepAlive, advance } = timerFixture()
  await logLines(t, async () => {
    keepAlive.turnEnded()
    await advance(40 * MINUTE)
    keepAlive.turnStarted()
    await advance(3 * HOUR)
    assert.deepEqual(events, [])
    // The time counts from the end of the turn, not from the earlier end.
    keepAlive.turnEnded()
    await advance(50 * MINUTE - 1)
    assert.deepEqual(events, [])
    await advance(1)
    assert.deepEqual(events, ['ping 270'])
  })
  let signal
  const slow = timerFixture({ ping: abort => new Promise((resolve, reject) => {
    signal = abort
    abort.addEventListener('abort', () => reject(new Error('aborted')))
  }) })
  const lines = await logLines(t, async () => {
    slow.keepAlive.turnEnded()
    await slow.clock.advance(50 * MINUTE)
    assert.equal(signal.aborted, false)
    slow.keepAlive.turnStarted()
    assert.equal(signal.aborted, true)
    await slow.keepAlive.running
    await slow.advance(3 * HOUR)
  })
  assert.ok(lines.every(line => !line.includes('kept the prompt cache warm')))
})

test('an idle context above the compaction limit gets a summary before the cache expires, and no keep-alive request', async t => {
  const { events, keepAlive, advance } = timerFixture({ size: 150000 })
  const lines = await logLines(t, async () => {
    keepAlive.turnEnded()
    await advance(50 * MINUTE - 1)
    assert.deepEqual(events, [])
    await advance(24 * HOUR)
  })
  assert.deepEqual(events, ['compact 50'])
  assert.match(lines[0], /The idle conversation of 150000 tokens got a summary before the prompt cache expired: done\.\n$/)
})

test('a small context, a cold cache, and a closed keep-alive get no request', async t => {
  const small = timerFixture({ size: 19999 })
  small.keepAlive.turnEnded()
  await small.advance(24 * HOUR)
  assert.deepEqual(small.events, [])
  // The computer slept through the lifetime of the cache. The late timer must not write the cold cache again.
  const late = timerFixture()
  late.keepAlive.turnEnded()
  late.clock.sleep(2 * HOUR)
  await late.advance(24 * HOUR)
  assert.deepEqual(late.events, [])
  // The last message before a restart is older than the lifetime.
  const old = timerFixture()
  old.keepAlive.turnEnded(old.clock.now() - 61 * MINUTE)
  await old.advance(24 * HOUR)
  assert.deepEqual(old.events, [])
  // The last message before a restart is younger than the lifetime: the request comes at 5/6 after that message.
  const recent = timerFixture()
  await logLines(t, async () => {
    recent.keepAlive.turnEnded(recent.clock.now() - 20 * MINUTE)
    await recent.advance(30 * MINUTE)
  })
  assert.deepEqual(recent.events, ['ping 30'])
  const closed = timerFixture()
  closed.keepAlive.turnEnded()
  await closed.keepAlive.close()
  await closed.advance(24 * HOUR)
  assert.deepEqual(closed.events, [])
})

test('a failed keep-alive request writes its failure to the log and sends no more requests', async t => {
  let calls = 0
  const failing = timerFixture({ ping: async () => { calls++; throw new Error('a secret text') } })
  const lines = await logLines(t, async () => {
    failing.keepAlive.turnEnded()
    await failing.advance(24 * HOUR)
  })
  assert.equal(calls, 1)
  assert.equal(lines.length, 1)
  assert.match(lines[0], /A keep-alive request failed\./)
  assert.doesNotMatch(lines[0], /secret/)
})

const text = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')

/** A service on a fake model and a fake clock. [requests] gets the options of each model request. */
async function serviceFixture(t, { keepAlive, compactTokens } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-keepalive-')))
  const fake = fauxProvider()
  const requests = []
  fake.setResponses(Array(100).fill(async (context, options) => {
    const summary = context.messages.some(model => model.role === 'system' && text(model.content).startsWith('You summarize'))
    requests.push({ kind: summary ? 'summary' : options.maxTokens === 1 ? 'ping' : 'turn', options, messages: context.messages.length })
    return fauxAssistantMessage(summary ? 'SUMMARY-OF-OLD-PART' : 'Answer.')
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const clock = fakeClock()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id },
    undefined, { compactTokens, keepAlive: { clock, minTokens: 1000, ...keepAlive } })
  await service.state.addWorkspace(directory)
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  t.after(async () => { await server.close(); await service.close(); await rm(directory, { force: true, recursive: true }) })
  const say = async (id, content) => {
    const receipt = await service.submit(id, content)
    const settled = await daemon.json(`/wait?submission=${receipt.submissionId}`)
    // The state watch tells the end of the turn to the keep-alive after the wait returns.
    for (let attempt = 0; attempt < 200 && service.keepAlive?.busy; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    return settled
  }
  const advance = ms => clock.advance(ms, () => service.keepAlive?.running)
  return { service, requests, say, advance, clock }
}

const large = word => `${word} `.repeat(40000 / (word.length + 1))

test('each model request asks for the 1-hour cache, and the variable of the lifetime asks for the 5-minute cache', { timeout: 30000 }, async t => {
  const long = await serviceFixture(t)
  await long.say('first', 'A question.')
  assert.deepEqual(long.requests.map(request => request.kind), ['turn'])
  assert.equal(long.requests[0].options.cacheRetention, 'long')
  assert.equal(long.service.keepAlive.ttlMs, HOUR)
  const short = await serviceFixture(t, { keepAlive: keepAliveSettings({ [CACHE_TTL_VARIABLE]: '5m' }) })
  await short.say('first', 'A question.')
  assert.equal(short.requests[0].options.cacheRetention, 'short')
  assert.equal(short.service.keepAlive.ttlMs, 5 * MINUTE)
})

test('a keep-alive request of the daemon reads the cached context for one output token and adds nothing to the conversation', { timeout: 30000 }, async t => {
  const { service, requests, say, advance } = await serviceFixture(t)
  await say('first', large('alpha'))
  await say('second', 'A short question.')
  const before = (await service.root.context(BACKGROUND_CONTEXT)).messages.length
  const history = await service.history({})
  const lines = await logLines(t, async () => {
    await advance(50 * MINUTE - 1)
    assert.deepEqual(requests.map(request => request.kind), ['turn', 'turn'])
    await advance(1)
  })
  assert.deepEqual(requests.map(request => request.kind), ['turn', 'turn', 'ping'])
  const ping = requests[2]
  assert.equal(ping.options.maxTokens, 1)
  assert.equal(ping.options.cacheRetention, 'long')
  // The request has the session and the thinking level of the turns, so it reads their cache.
  assert.equal(ping.options.sessionId, requests[1].options.sessionId)
  assert.equal(ping.options.reasoning, requests[1].options.reasoning)
  assert.equal(ping.messages, before)
  const [, context, cacheRead, cacheWrite] = lines.find(line => line.includes('kept the prompt cache warm'))
    .match(/context (\d+), input \d+, cache read (\d+), cache write (\d+),/).map(Number)
  assert.ok(context > 10000)
  // The reply of the last turn is the only part that the cache does not hold.
  assert.ok(cacheRead > 10000)
  assert.ok(cacheWrite < 100)
  assert.equal((await service.root.context(BACKGROUND_CONTEXT)).messages.length, before)
  assert.deepEqual(await service.history({}).then(page => page.entries), history.entries)
})

test('the idle daemon writes a summary of a context above the limit before the cache expires', { timeout: 30000 }, async t => {
  // The limit of a turn stays at 100,000 tokens, so no turn writes a summary. Only the idle daemon gets a lower limit.
  const { service, requests, say, advance } = await serviceFixture(t)
  service.keepAlive.compactTokens = 25000
  for (const word of ['alpha', 'beta', 'gamma']) await say(word, large(word))
  const turns = requests.length
  assert.ok(requests.every(request => request.kind === 'turn'))
  const lines = await logLines(t, async () => { await advance(24 * HOUR) })
  assert.deepEqual(requests.slice(turns).map(request => request.kind), ['summary'])
  assert.notEqual((await service.root.context(BACKGROUND_CONTEXT)).head, undefined)
  assert.ok(lines.some(line => /A summary request: input \d+, cache read \d+, cache write \d+, output \d+ tokens, cost [\d.]+ USD\./.test(line)))
  assert.ok(lines.some(line => /got a summary before the prompt cache expired: done\./.test(line)))
})

test('the variable MEGACHAT_KEEPALIVE=0 stops the keep-alive requests and the summary of an idle conversation', { timeout: 30000 }, async t => {
  const { service, requests, say, advance } = await serviceFixture(t, { keepAlive: keepAliveSettings({ [KEEPALIVE_VARIABLE]: '0' }) })
  assert.equal(service.keepAlive, undefined)
  await say('first', large('alpha'))
  await advance(24 * HOUR)
  assert.deepEqual(requests.map(request => request.kind), ['turn'])
  // The lifetime of the cache stays 1 hour.
  assert.equal(requests[0].options.cacheRetention, 'long')
})

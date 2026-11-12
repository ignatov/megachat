import assert from 'node:assert/strict'
import test from 'node:test'
import { Watch } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { MegachatError, message } from '../src/messages.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'

test('a large retained conversation stays connected while idle', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const conversation = new Watch({ entries: [{ id: 1, text: 'x'.repeat(2 * 1024 * 1024) }] }, () => {}, assert.fail)
  const tasks = new Watch({ current: null }, () => {}, assert.fail)
  const server = new DaemonServer({ root: { watch: async () => conversation }, state: { watch: async () => tasks } })
  const closed = Promise.withResolvers()
  server.server.once('request', (_, response) => response.once('close', closed.resolve))
  const daemon = new DaemonClient(await server.listen())
  const abort = new AbortController()
  t.after(async () => { abort.abort(); await server.close(); await closed.promise })
  const received = []
  const both = Promise.withResolvers()
  const heartbeat = Promise.withResolvers()
  const watching = daemon.watch(event => {
    received.push(event)
    if (received.length === 2) both.resolve()
    if (event.type === 'heartbeat') heartbeat.resolve()
  }, abort.signal)
  watching.catch(both.reject)
  watching.catch(heartbeat.reject)
  await both.promise
  assert.deepEqual(received.map(event => event.type), ['conversation', 'tasks'])
  assert.equal(received[0].value.entries[0].text.length, 2 * 1024 * 1024)
  t.mock.timers.tick(15000)
  await heartbeat.promise
  abort.abort()
  await watching.catch(error => assert.equal(error.name, 'AbortError'))
})

test('an event line above 32 MB ends the watch with the code of the event limit', async t => {
  t.mock.method(globalThis, 'fetch', async () => new Response('x'.repeat(32 * 1024 * 1024 + 1)))
  const daemon = new DaemonClient({ port: 1, token: 'a'.repeat(64) })
  await assert.rejects(daemon.watch(() => assert.fail('no event')), { code: 'eventLimit', message: message('error.eventLimit', 32) })
})

// The list of the codes in the client of v0.2.0 and v0.3.0 also has no code of a limit. So a bridge of each build gets
// `invalid` for each of these codes, as it got for `limit`.
test('the client gives each code of a limit to the bridge as invalid, as it gave the code limit', { timeout: 10000 }, async t => {
  const codes = [['limit', 30], ['turnChildLimit', 8], ['unfinishedLimit', 8], ['permissionLimit', 32], ['projectLimit', 100],
    ['steerLimit', 16], ['viewLimit', 32], ['eventLimit', 32], ['outputLimit', 1], ['busy']]
  let refusal
  const server = new DaemonServer({ submit: async () => { throw new MegachatError(...refusal) } })
  const daemon = new DaemonClient(await server.listen())
  t.after(() => server.close())
  for (refusal of codes)
    await assert.rejects(daemon.json('/input', { requestId: refusal[0], text: 'Work' }), { code: refusal[0] === 'busy' ? 'busy' : 'invalid' })
})

test('waiting for a long task keeps the response open and returns valid JSON', { timeout: 10000 }, async t => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const attached = Promise.withResolvers()
  const input = { submissionId: 1, status: 'running' }
  const tasks = new Watch({ inputs: { request: input } }, () => {}, assert.fail)
  const server = new DaemonServer({ state: { watch: async () => { attached.resolve(); return tasks } } })
  const daemon = new DaemonClient(await server.listen())
  const abort = new AbortController()
  t.after(async () => { abort.abort(); await server.close() })
  const pending = daemon.request('/wait?submission=1', undefined, abort.signal)
  pending.catch(() => {})
  await attached.promise
  t.mock.timers.tick(15000)
  const response = await pending
  const reader = response.body.getReader()
  const heartbeat = await reader.read()
  assert.equal(Buffer.from(heartbeat.value).toString(), ' ')
  const completed = { ...input, status: 'completed' }
  const value = { inputs: { request: completed } }
  tasks.advance({ kind: 'value', value, ops: [['r', value]], retired: false }, BACKGROUND_CONTEXT)
  let body = ' '
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    body += Buffer.from(chunk.value).toString()
  }
  assert.deepEqual(JSON.parse(body), completed)
})

test('the daemon accepts an input of 100,000 characters that are not ASCII, and refuses a larger body', { timeout: 10000 }, async t => {
  const received = []
  const server = new DaemonServer({ submit: async (requestId, text) => { received.push(text); return { requestId } } })
  const daemon = new DaemonClient(await server.listen())
  t.after(() => server.close())
  const text = 'ж'.repeat(100000)
  assert.deepEqual(await daemon.json('/input', { requestId: 'long', text }), { requestId: 'long' })
  assert.equal(received[0], text)
  await assert.rejects(daemon.json('/input', { requestId: 'larger', text: 'x'.repeat(1000001) }))
  assert.equal(received.length, 1)
})

test('the daemon answers /health while more than 32 views hold an event stream', { timeout: 20000 }, async t => {
  // Each stream starts a watch of its own.
  const server = new DaemonServer({ root: { watch: async () => new Watch({ entries: [] }, () => {}, assert.fail) },
    state: { watch: async () => new Watch({ current: null }, () => {}, assert.fail) } })
  const daemon = new DaemonClient(await server.listen())
  const abort = new AbortController()
  t.after(async () => { abort.abort(); await server.close() })
  // One bridge has at most 32 views, and each view holds one stream. A second bridge adds its own views.
  const streams = Array.from({ length: 40 }, () => {
    const opened = Promise.withResolvers()
    const watching = daemon.watch(event => { if (event.type === 'tasks') opened.resolve() }, abort.signal)
    watching.catch(opened.reject)
    watching.catch(() => {})
    return opened.promise
  })
  await Promise.all(streams)
  assert.equal((await daemon.json('/health')).version, 1)
})

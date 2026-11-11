import assert from 'node:assert/strict'
import test from 'node:test'
import { Watch } from '@earendil-works/chord'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { DaemonClient } from '../src/DaemonClient.mjs'
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

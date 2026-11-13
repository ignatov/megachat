import assert from 'node:assert/strict'
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { CentralConfigurationService } from '../src/CentralConfigurationService.mjs'
import { describeError, MegachatError } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'

/** Collects what the code under test writes to the standard error. */
function logged(t) {
  const lines = []
  t.mock.method(process.stderr, 'write', text => { lines.push(String(text)); return true })
  return lines
}

test('the description of an error for the log has no message of the error', () => {
  const error = Object.assign(new Error('The key is sk-secret-value'), { code: 'ENOENT', signal: 'SIGTERM', stdout: 'sk-secret-value' })
  const text = describeError(error)
  assert.ok(!text.includes('sk-secret-value'), text)
  assert.match(text, /^name=Error code=ENOENT signal=SIGTERM \| at /)
  assert.ok(!describeError(new SyntaxError('Unexpected token sk-secret-value')).includes('sk-secret-value'))
  // A code that is not a short word can be a part of a message.
  assert.ok(!describeError(Object.assign(new Error('x'), { code: 'sk secret value' })).includes('secret'))
  assert.equal(describeError(new MegachatError('central')), 'central: Central did not supply a valid local provider configuration.')
  assert.equal(describeError('sk-secret-value'), 'string')
  // A failed fetch has the code only in its cause.
  const fetchError = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' }) })
  assert.match(describeError(fetchError), /^name=TypeError cause\.name=Error cause\.code=ECONNREFUSED \| at /)
  assert.ok(!describeError(fetchError).includes('127.0.0.1'))
  assert.match(describeError(Object.assign(new Error('x'), { code: 'ERR_SQLITE_ERROR', errstr: 'database or disk is full' })),
    /sqlite=database or disk is full/)
})

test('a failed Central command gets a log line without its output', { skip: process.platform === 'win32' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-central-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const central = join(directory, 'central')
  await writeFile(central, '#!/bin/sh\necho "apiKey sk-secret-value"\necho "sk-secret-value" >&2\nexit 7\n')
  await chmod(central, 0o700)
  const lines = logged(t)
  await assert.rejects(new CentralConfigurationService({ central }).pi(), { code: 'central' })
  await assert.rejects(new CentralConfigurationService({ central: join(directory, 'missing') }).pi(), { code: 'central' })
  t.mock.restoreAll()
  assert.equal(lines.length, 2)
  assert.ok(lines.every(line => !line.includes('sk-secret-value')), lines.join(''))
  assert.match(lines[0], /Central gave no configuration to the main agent: name=Error code=7/)
  assert.match(lines[1], /code=ENOENT/)
})

test('a reply through a Central that refuses the connection gets log lines without the error text', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-central-'))
  t.after(() => rm(directory, { force: true, recursive: true }))
  // A free port that nothing listens on, as a Central whose local proxy is down.
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  await new Promise(resolve => server.close(resolve))
  const central = join(directory, 'central')
  await writeFile(central, `#!/bin/sh\necho '{"anthropic":{"baseUrl":"http://127.0.0.1:${port}/wire/sk-secret-value","apiKey":"sk-secret-value"}}'\n`)
  await chmod(central, 0o700)
  const service = await PiMegachatService.open(new MemoryStorage(), new CentralConfigurationService({ central }).models(),
    { provider: 'anthropic', modelId: 'claude-opus-5-5' }, {}, { keepAlive: { enabled: false } })
  t.after(() => service.close().catch(() => {}))
  await service.resume()
  const lines = logged(t)
  await service.submit('hello', 'Hello')
  await waitForState(service.state, state => state.inputs.hello?.status !== 'running' && !state.current ? state : undefined, { timeoutMs: 15000 })
  t.mock.restoreAll()
  assert.equal((await service.state.snapshot()).inputs.hello.status, 'interrupted')
  const log = lines.join('')
  assert.match(log, /A model request through Central got no response: name=TypeError cause\.name=Error cause\.code=ECONNREFUSED/)
  assert.match(log, /The turn [\w-]+ of the main agent ended without an answer: kind=user reason=model_error\n/)
  for (const text of ['sk-secret-value', `127.0.0.1:${port}`, 'Connection error', 'fetch failed']) assert.ok(!log.includes(text), log)
})

test('a storage error tells the owner of the main agent and gets a log line', { timeout: 10000 }, async t => {
  const storage = new MemoryStorage()
  let broken = false
  // The storage works until the test breaks it. Then each commit fails, as on a full disk.
  const failing = new Proxy(storage, { get(target, name) {
    const value = target[name]
    if (typeof value !== 'function') return value
    return name === 'commit' ? (...args) => {
      if (broken) throw Object.assign(new Error('The disk is full: sk-secret-value'), { code: 'ENOSPC' })
      return value.apply(target, args)
    } : value.bind(target)
  } })
  const fake = fauxProvider()
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(failing, models, { provider: model.provider, modelId: model.id })
  t.after(() => service.close().catch(() => {}))
  let failed = false
  service.failed.then(() => { failed = true })
  await service.state.addWorkspace('/workspace')
  assert.equal(failed, false)
  const lines = logged(t)
  broken = true
  await assert.rejects(service.state.addWorkspace('/other'))
  const error = await service.failed
  t.mock.restoreAll()
  assert.equal(error.code, 'ENOSPC')
  assert.ok(lines.some(line => /Pi Durable reported storage_failed: name=Error code=ENOSPC/.test(line)), lines.join(''))
  assert.ok(lines.every(line => !line.includes('sk-secret-value')), lines.join(''))
})

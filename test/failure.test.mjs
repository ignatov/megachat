import assert from 'node:assert/strict'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { CentralConfigurationService, commandCause, logFailedRequests, requestCause } from '../src/CentralConfigurationService.mjs'
import { describeError, MegachatError, message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { centralChat, centralCommand, configurationOf, freePort, resetProxy, SECRET, statusProxy } from './fake-central.mjs'

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

test('a failure of the Central command records its cause', { skip: process.platform === 'win32' }, async t => {
  const failed = async central => {
    const configuration = new CentralConfigurationService({ central, log: () => {} })
    await assert.rejects(configuration.pi(), { code: 'central' })
    return configuration.lastFailure
  }
  const before = Date.now()
  const missing = await failed(join(tmpdir(), 'megachat-no-such-directory', 'central'))
  assert.equal(missing.cause, 'central_missing')
  assert.ok(missing.at >= before)
  assert.equal((await failed((await centralCommand('echo "Not logged in" >&2\nexit 1')).central)).cause, 'central_command')
  // validate accepts only an address of the local proxy.
  const remote = JSON.stringify({ anthropic: { baseUrl: `https://example.com/wire/${SECRET}`, apiKey: SECRET } })
  assert.equal((await failed((await centralCommand(`echo '${remote}'`)).central)).cause, 'central_command')
  assert.equal((await failed((await centralCommand('echo "no JSON"')).central)).cause, 'central_command')
  // The time limit of 15 seconds kills the command with SIGTERM.
  assert.equal(commandCause(Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM', code: null })), 'central_command')
  assert.equal(commandCause(Object.assign(new Error('spawn central ENOENT'), { code: 'ENOENT' })), 'central_missing')
  // A successful command changes no cause.
  const port = await freePort()
  const configuration = new CentralConfigurationService({ central: (await centralCommand(`echo '${configurationOf(port)}'`)).central })
  await configuration.pi()
  assert.equal(configuration.lastFailure, undefined)
})

test('a failed model request records the cause of Central, and another HTTP status records none', async t => {
  t.mock.method(process.stderr, 'write', () => true)
  const connectionError = code => new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ${code} 127.0.0.1:9`), { code }) })
  const causes = []
  const request = (fetch, signal) => logFailedRequests(fetch, signal, cause => causes.push(cause))('http://127.0.0.1:9/wire/x', {})
  await assert.rejects(request(async () => { throw connectionError('ECONNREFUSED') }))
  await assert.rejects(request(async () => { throw connectionError('ECONNRESET') }))
  await assert.rejects(request(async () => { throw new TypeError('fetch failed', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }) }))
  for (const status of [401, 403, 529, 429, 500, 200]) await request(async () => new Response('{}', { status }))
  // A stop of the request by its caller is no failure.
  const stopped = new AbortController()
  stopped.abort()
  await assert.rejects(request(async () => { throw connectionError('ECONNREFUSED') }, stopped.signal))
  t.mock.restoreAll()
  assert.deepEqual(causes, ['central_proxy', 'central_unreachable', 'central_unreachable', 'central_refused', 'central_refused'])
  assert.equal(requestCause(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })), 'central_proxy')
  assert.equal(requestCause(new DOMException('The operation was aborted.', 'AbortError')), 'central_unreachable')
})

/** Sends "Hello" through the Central command [central], and checks the text of the notice and the cause in the state. */
async function failedReply(t, central, cause) {
  const chat = await centralChat(t, central)
  const lines = logged(t)
  const reply = await chat.prompt('Hello')
  t.mock.restoreAll()
  assert.equal(reply.stopReason, 'cancelled')
  const state = await chat.service.state.snapshot()
  const input = Object.values(state.inputs).at(-1)
  assert.deepEqual([input.status, input.reason, input.cause], ['interrupted', 'model_error', cause])
  for (const text of [SECRET, 'ECONNREFUSED', 'Connection error', 'Not logged in', 'refused it', 'fetch failed']) {
    assert.ok(!JSON.stringify(state).includes(text), text)
    assert.ok(!lines.join('').includes(text) || text === 'ECONNREFUSED', lines.join(''))
  }
  return reply.notice
}

// The installer of Central puts `central` in ~/.local/bin and does not put that directory on the PATH. So a text that
// tells the user to run a bare `central` command gives "command not found" in a new terminal.
test('each text that tells the user to run a Central command gives the full path of the command', async () => {
  const text = await readFile(new URL('../resources/Megachat.properties', import.meta.url), 'utf8')
  const bare = text.split('\n').filter(line => line && !line.startsWith('#'))
    .filter(line => /(?<!~\/\.local\/bin\/)\bcentral (?:login|logout|repair|proxy|add|run|status)\b/.test(line.slice(line.indexOf('=') + 1)))
  assert.deepEqual(bare, [])
})

test('the text of a missing Central command gives the setup line of the README', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8')
  const line = 'curl -fsSL https://github.com/ignatov/megachat/releases/latest/download/setup.sh | bash'
  assert.ok(readme.includes(`\n${line}\n`), 'README')
  assert.ok(message('error.central.missing').includes(`\`${line}\``))
  assert.ok(message('install.centralMissing', '/home/user/.local/bin/central').includes(`"${line}"`))
})

test('a reply without the Central command names the missing command', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const notice = await failedReply(t, join(tmpdir(), 'megachat-no-such-directory', 'central'), 'central_missing')
  assert.equal(notice, message('error.central.missing'))
  assert.equal(notice, 'Megachat cannot find the JetBrains Central CLI at ~/.local/bin/central. To install it and log in, run the setup line `curl -fsSL https://github.com/ignatov/megachat/releases/latest/download/setup.sh | bash` in a terminal, and then send the message again.')
})

test('a reply through a Central command that fails names the login', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const { central } = await centralCommand(`echo "Not logged in ${SECRET}" >&2\nexit 1`)
  assert.equal(await failedReply(t, central, 'central_command'),
    'JetBrains Central gave Megachat no configuration. Run `~/.local/bin/central login` in a terminal. When you are logged in, run `~/.local/bin/central repair`. Then send the message again.')
})

test('a reply through a local proxy that refuses the connection names the proxy', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const { central } = await centralCommand(`echo '${configurationOf(await freePort())}'`)
  assert.equal(await failedReply(t, central, 'central_proxy'),
    'Megachat cannot connect to the local proxy of JetBrains Central. Run `~/.local/bin/central proxy start` or `~/.local/bin/central repair` in a terminal, and then send the message again.')
})

test('a reply through a local proxy that closes the connection names the network', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const { central } = await centralCommand(`echo '${configurationOf(await resetProxy(t))}'`)
  assert.equal(await failedReply(t, central, 'central_unreachable'),
    'Megachat got no response from JetBrains Central. Check the network, or run `~/.local/bin/central repair` in a terminal. Then send the message again.')
})

test('a reply that Central refuses with the HTTP status 401 names the login', { skip: process.platform === 'win32', timeout: 20000 }, async t => {
  const { central } = await centralCommand(`echo '${configurationOf(await statusProxy(t, 401))}'`)
  assert.equal(await failedReply(t, central, 'central_refused'),
    'JetBrains Central refused the request of the model. Your Central login can have expired. Run `~/.local/bin/central login` in a terminal, and then send the message again.')
})

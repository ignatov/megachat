import assert from 'node:assert/strict'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { fauxAssistantMessage } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { ChildPool } from '../src/ChildPool.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { PiRunService } from '../src/PiRunService.mjs'
import { ChildTextFilter, HELD_TEXT_LIMIT, KnownSecrets, redactOwnSecrets } from '../src/SessionText.mjs'
import { waitForState } from '../src/waitForState.mjs'
import { fakeModels, MAIN } from './parallel-models.mjs'

const FAKE_ACP = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))
const MARKER = message('sessions.secret')
// Invented values: a key without a known prefix, and a base URL of the shape of Central that holds it.
const KEY = 'Qm7Tz2Lw9Xc4Vb8Nk1Rj6Hs3Fd5Gp0Ya2Ue'
const ADDRESS = `http://127.0.0.1:41234/wire/${KEY}`
// A key after /wire/ that the daemon does not know.
const OTHER = 'Pk3Wq8Zr1Xn6Cm9Vt4Bs7Lh2Jd5Fg0Ka8Ty'

function known() {
  const secrets = new KnownSecrets()
  secrets.add(KEY, ADDRESS)
  return secrets
}

test('the filter of a child text removes only the own secret of Megachat: the exact known values and the key after /wire/', () => {
  const secrets = known()
  assert.equal(redactOwnSecrets(`key=${KEY} base=${ADDRESS}/v1 other=http://127.0.0.1:9/wire/${OTHER}/v1`, secrets),
    `key=${MARKER} base=${MARKER}/v1 other=http://127.0.0.1:9/wire/${MARKER}/v1`)
  // The other patterns of the index do not apply: the main agent can need this text.
  const kept = 'sk-abcdefghijklmnopqrstuvwxyz password=hunter2hunter2 https://user:pa55word@example.com/repo Bearer abcdefghijklmnopqrstuvwxyz'
  assert.equal(redactOwnSecrets(kept, secrets), kept)
  // A text that the filter changed already stays as it is.
  const once = redactOwnSecrets(`${ADDRESS} http://127.0.0.1:9/wire/${OTHER}`, secrets)
  assert.equal(redactOwnSecrets(once, secrets), once)
  assert.equal(redactOwnSecrets(`http://127.0.0.1:9/wire/${OTHER}`), `http://127.0.0.1:9/wire/${MARKER}`)
})

test('a secret in two parts of a child text goes as a whole, and a filter of the kept text again would keep its second part', () => {
  const secrets = known()
  const text = `ANTHROPIC_API_KEY=${KEY}\nANTHROPIC_BASE_URL=${ADDRESS}\ncurl "http://127.0.0.1:9/wire/${OTHER}/v1/models" (done)\nThe end`
  const whole = redactOwnSecrets(text, secrets)
  assert.ok(!whole.includes(KEY) && !whole.includes(OTHER) && !whole.includes(KEY.slice(10)) && whole.endsWith('The end'))
  // Each cut into two parts and each cut into three parts gives the text that a filter of the whole text gives.
  for (let first = 0; first <= text.length; first++) {
    const filter = new ChildTextFilter(secrets)
    assert.equal(filter.push(text.slice(0, first)) + filter.push(text.slice(first)) + filter.end(), whole, `cut at ${first}`)
    for (let second = first; second <= text.length; second += 7) {
      const three = new ChildTextFilter(secrets)
      assert.equal(three.push(text.slice(0, first)) + three.push(text.slice(first, second)) + three.push(text.slice(second)) + three.end(), whole)
    }
  }
  // The filter holds back only the last word and the start of a known value. The rest goes out at once.
  const filter = new ChildTextFilter(secrets)
  assert.equal(filter.push('The key is '), 'The key is ')
  assert.equal(filter.push(`${KEY.slice(0, 10)}`), '')
  assert.equal(filter.push(`${KEY.slice(10)} and more`), `${MARKER} and `)
  assert.equal(filter.end(), 'more')
  assert.equal(filter.end(), 'more')
  // A filter of the kept text again after each part keeps the second part of the key.
  const first = redactOwnSecrets(`base http://127.0.0.1:9/wire/${OTHER.slice(0, 10)}`, secrets)
  assert.ok(redactOwnSecrets(`${first}${OTHER.slice(10)}/v1`, secrets).includes(OTHER.slice(10)))
  // A known value with a white space in it waits as a whole too.
  const spaced = new KnownSecrets()
  spaced.add('correct horse battery')
  const words = new ChildTextFilter(spaced)
  assert.equal(words.push('say correct horse '), 'say ')
  assert.equal(words.push('battery staple'), `${MARKER} `)
  assert.equal(words.end(), 'staple')
  // At most HELD_TEXT_LIMIT characters wait. A pair of surrogates stays whole.
  const long = new ChildTextFilter()
  assert.equal(long.push('x'.repeat(HELD_TEXT_LIMIT + 10)), 'x'.repeat(10))
  assert.equal(long.end().length, HELD_TEXT_LIMIT)
  const emoji = new ChildTextFilter()
  const given = emoji.push('😀'.repeat(HELD_TEXT_LIMIT))
  assert.equal(given + emoji.end(), '😀'.repeat(HELD_TEXT_LIMIT))
  assert.equal(given.replaceAll('😀', ''), '')
})

/**
 * A service with the secrets of a Central configuration that the daemon read, the ACP run service of the fake agent
 * with the key and the base URL in the environment of each child, and the pi run service. [child] gives the replies of
 * a pi child.
 */
async function open(t, { child = [] } = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-child-secrets-')))
  t.after(() => rm(directory, { force: true, recursive: true, maxRetries: 5 }))
  const cwd = join(directory, 'project')
  await mkdir(cwd)
  await writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values: { 'coordinator.model': MAIN } }), { mode: 0o600 })
  const { models, requests } = fakeModels([], child)
  const service = await PiMegachatService.open(new MemoryStorage(), models, undefined, {}, { settingsPath: join(directory, 'settings.json'),
    spendPath: join(directory, 'spend.json'), keepAlive: { enabled: false }, environment: {}, resumeDelayMs: 0, secrets: known() })
  await service.state.addWorkspace(cwd)
  const pool = new ChildPool()
  const pi = new PiRunService(service.state, service.harness, { agent: project => service.childAgent(project), pool })
  const acp = new AcpRunService(service.state, { childLaunch: async () => ({ env: { ...process.env, ANTHROPIC_API_KEY: KEY, ANTHROPIC_BASE_URL: ADDRESS } }) },
    { args: [FAKE_ACP], pool })
  await pi.start()
  await acp.start()
  await service.resume()
  t.after(async () => { await acp.close(); await pi.close(); await service.close() })
  return { cwd, service, requests }
}

let turns = 0
/** Admits [task] in a turn of the user of its own, as a tool call of the main agent does. */
async function admit(service, task) {
  const id = `user-${++turns}`
  await waitForState(service.state, state => state.current ? undefined : true)
  await service.state.change(state => { state.current = { id, requestId: id, cancelling: false, kind: 'user' } })
  try { return await service.state.admitChild(`${id}:spawn`, task) }
  finally { await service.state.change(state => { if (state.current?.id === id) state.current = null }) }
}

const ended = (service, runId) => waitForState(service.state, state => terminalStates.has(state.runs[runId]?.status) ? state : undefined, { timeoutMs: 15000 })
/** Waits until the main agent took the report of [runId] and its turn ended. */
const reported = (service, runId) => waitForState(service.state, state => state.runs[runId]?.reported && !state.current ? state : undefined, { timeoutMs: 15000 })
const tool = (service, name) => service.extension().tools.find(item => item.name === name)
const conversation = async service => JSON.stringify((await service.root.entries({ order: 'ascending' }, 200, undefined, BACKGROUND_CONTEXT)).items)

test('the output of a Claude child, its permission request, agents_inspect and the result report have no key of Central', { timeout: 20000 }, async t => {
  const { cwd, service, requests } = await open(t)
  const run = await admit(service, { cwd, prompt: 'environment' })
  // The chunks and the permission request come on two ways, so the test waits for both.
  const permission = await waitForState(service.state, state => state.runs[run.id].output.includes('BASE_URL')
    ? Object.values(state.permissions).find(item => item.status === 'pending') : undefined)
  // The dialog shows the filtered title and input. The ID of the tool call and the options stay.
  assert.deepEqual(permission.request.toolCall, { toolCallId: 'curl', title: `curl ${MARKER}/v1/models`, kind: 'execute',
    rawInput: { command: `curl ${MARKER}/v1/models`, description: 'List the models' } })
  assert.deepEqual(permission.request.options.map(option => option.optionId), ['yes', 'no'])
  // The last word waits while the run works.
  assert.equal((await service.state.snapshot()).runs[run.id].output, `ANTHROPIC_API_KEY=${MARKER}\nANTHROPIC_BASE_URL=${MARKER}\nThe `)
  await service.state.respondPermission(permission.id, 'yes')
  const state = await ended(service, run.id)
  assert.equal(state.runs[run.id].status, 'completed')
  const output = `ANTHROPIC_API_KEY=${MARKER}\nANTHROPIC_BASE_URL=${MARKER}\nThe end`
  assert.equal(state.runs[run.id].output, output)
  await reported(service, run.id)
  // The conversation storage, which the search index reads, and each request to the provider.
  const stored = await conversation(service)
  assert.ok(stored.includes(`ANTHROPIC_API_KEY=${MARKER}`))
  for (const text of [stored, ...requests.map(request => request.messages)]) {
    assert.ok(!text.includes(KEY) && !text.includes(KEY.slice(10)))
  }
  // The read of the run comes after the report: a read of an ended run before it takes the place of the report turn.
  assert.equal(JSON.parse((await tool(service, 'agents_inspect').execute({ runId: run.id })).output[0].text).output, output)
})

test('the output of a pi child and the error text of a run have no key of Central', { timeout: 20000 }, async t => {
  const { cwd, service } = await open(t, { child: [fauxAssistantMessage(`The base is ${ADDRESS} and the key is ${KEY}.`)] })
  const run = await admit(service, { cwd, prompt: 'Read the environment', agent: 'pi' })
  const state = await ended(service, run.id)
  assert.equal(state.runs[run.id].status, 'completed')
  assert.equal(state.runs[run.id].output, `The base is ${MARKER} and the key is ${MARKER}.`)
  await reported(service, run.id)
  assert.ok(!(await conversation(service)).includes(KEY))
  // An error text of a run can hold a text of the child.
  const failed = await admit(service, { cwd, prompt: 'wait' })
  await service.state.transition(failed.id, ['admitted', 'launching', 'ready', 'dispatched', 'running'], { status: 'failed', error: `The child stopped at ${ADDRESS}/v1` })
  assert.equal((await service.state.snapshot()).runs[failed.id].error, `The child stopped at ${MARKER}/v1`)
})

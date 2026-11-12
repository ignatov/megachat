import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { message } from '../src/messages.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'

const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })

/**
 * A service with `settings.json` in a temporary directory, a run service with the fake agent, and the rules paragraph
 * of the daemon. `turn` gives the replies of the model in their order, and `Answer.` follows them.
 */
async function fixture(t, values) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-children-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const settingsPath = join(directory, 'settings.json')
  if (values) await writeFile(settingsPath, JSON.stringify({ schema: 1, onboarding: 'done', values }), { mode: 0o600 })
  const cwd = join(directory, 'project')
  await mkdir(cwd)
  const script = []
  const fake = fauxProvider()
  fake.setResponses(Array(100).fill(() => script.shift() ?? fauxAssistantMessage('Answer.')))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { settingsPath, keepAlive: { enabled: false } })
  await service.state.addWorkspace(cwd)
  const launched = []
  const children = new AcpRunService(service.state, { childLaunch: async agent => { launched.push(agent); return { env: process.env } } },
    { args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], childRules: () => service.childRules() })
  await children.start()
  await service.resume()
  t.after(async () => { await children.close(); await service.close() })
  /** One turn of the user with [replies], then the wait for each child and for its report. */
  const turn = async (id, ...replies) => {
    script.push(...replies)
    await service.submit(id, 'Work')
    return waitForState(service.state, state => !state.current && Object.keys(state.runs).length
      && Object.values(state.runs).every(run => terminalStates.has(run.status) && run.reported) ? state : undefined)
  }
  const prompts = async () => (await readFile(join(cwd, 'prompts'), 'utf8')).trim().split('\n').map(line => JSON.parse(line))
  return { service, cwd, launched, turn, prompts, settingsPath }
}

test('a task without a named agent goes to the agent of children.agent, and a follow-up stays with its session', { timeout: 20000 }, async t => {
  const { cwd, launched, turn } = await fixture(t, { 'children.agent': 'codex' })
  let state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  const [first] = Object.values(state.runs)
  assert.equal(first.agent, 'codex')
  assert.deepEqual(launched, ['codex'])
  // The change applies to the next child, also in the turn that made it.
  state = await turn('second', call('agents_settings', { action: 'set', key: 'children.agent', value: 'claude' }),
    call('agents_spawn', { cwd, prompt: 'second task' }), call('agents_send', { childSessionId: first.childSessionId, cwd, prompt: 'more' }),
    fauxAssistantMessage('Started.'))
  const runs = Object.values(state.runs)
  assert.deepEqual(runs.map(run => [run.prompt, run.agent]), [['first task', 'codex'], ['second task', 'claude'], ['more', 'codex']])
  assert.deepEqual(launched, ['codex', 'claude', 'codex'])
})

test('the daemon adds the rules of the user to each child prompt at its dispatch, and the run keeps only the task', { timeout: 20000 }, async t => {
  const { service, cwd, turn, prompts } = await fixture(t)
  let state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  const defaults = [message('child.rules'), message('child.rule.commit.allow'), message('child.rule.push.ask'),
    message('child.rule.daemonRestart.ask')].join('\n')
  assert.deepEqual(await prompts(), [[defaults, 'first task']])
  const [first] = Object.values(state.runs)
  assert.equal(first.prompt, 'first task')
  // The section of the main agent tells it the same values.
  const section = (await service.root.agent(BACKGROUND_CONTEXT)).sections.find(item => item.key === 'settings').render()
  assert.match(section, /goes to claude\. .*commit allow, push ask, restart or stop of the Megachat daemon ask\./)
  state = await turn('second', call('agents_settings', { action: 'set', key: 'children.push', value: 'deny' }),
    call('agents_settings', { action: 'set', key: 'children.commit', value: 'ask' }),
    call('agents_send', { childSessionId: first.childSessionId, cwd, prompt: 'follow-up' }), fauxAssistantMessage('Sent.'))
  const changed = [message('child.rules'), message('child.rule.commit.ask'), message('child.rule.push.deny'),
    message('child.rule.daemonRestart.ask')].join('\n')
  assert.deepEqual((await prompts())[1], [changed, 'follow-up'])
  assert.deepEqual(Object.values(state.runs).map(run => run.prompt), ['first task', 'follow-up'])
  // A report of a result quotes the stored task, without the rules.
  assert.doesNotMatch(JSON.stringify(Object.values(state.runs)), /The user of Megachat set these rules/)
})

test('a turn of a child result or of the sessions summary cannot change a setting of the children', { timeout: 20000 }, async t => {
  const { service, settingsPath } = await fixture(t, {})
  const tool = service.extension().tools.find(item => item.name === 'agents_settings')
  // The kind `report` is the turn of a child result, and the kind `event` is the turn of the summary of the past sessions.
  for (const kind of ['report', 'event']) {
    await service.state.change(state => { state.current = { id: kind, requestId: kind, cancelling: false, kind } })
    for (const [key, value] of [['children.agent', 'codex'], ['children.push', 'allow'], ['children.daemonRestart', 'allow']])
      await assert.rejects(tool.execute({ action: 'set', key, value }), { code: 'settingEvent' })
    await service.state.change(state => { state.current = null })
  }
  assert.deepEqual(JSON.parse(await readFile(settingsPath, 'utf8')).values, {})
})

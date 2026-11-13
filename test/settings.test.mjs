import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, sep } from 'node:path'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { DaemonClient } from '../src/DaemonClient.mjs'
import { DaemonServer } from '../src/DaemonServer.mjs'
import { message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { expandHome } from '../src/ProjectDirectories.mjs'
import { MegachatSettings, SETTINGS, SettingsStore } from '../src/Settings.mjs'
import { waitForState } from '../src/waitForState.mjs'

const MINUTE = 60000
const HOUR = 60 * MINUTE
const FAST = 'faux/fast'
const DEEP = 'faux/deep'
const text = content => typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const ONBOARDING = /The setup of Megachat is pending\./
const SETTINGS_RULE = /Read or change a setting of Megachat with agents_settings only when the user asks, or for an offer of the offer rules\./

/**
 * The system prompt that a request gives the model. Pi Durable sends a changed section as a later system message, so
 * the last text of each section is in effect, as `replaySections` of Pi Durable reads it.
 */
function effectiveSections(messages) {
  const shown = new Map()
  for (const item of messages) {
    if (item.role !== 'system' || !item.sections) continue
    for (const [key, value] of Object.entries(item.sections)) {
      if (value === null) shown.delete(key)
      else shown.set(key, value)
    }
  }
  return [...shown.values()].join('\n')
}

/** A fake provider with two models that think. [replies] gives a reply to each request of a turn, else `Answer.`. */
function fakeModels(replies = []) {
  const fake = fauxProvider({ models: [
    { id: 'fast', reasoning: true, cost: { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } },
    { id: 'deep', reasoning: true, cost: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
  ] })
  const requests = []
  fake.setResponses(Array(200).fill(async (context, options, _state, model) => {
    const summary = context.messages.some(item => item.role === 'system' && text(item.content).startsWith('You summarize'))
    requests.push({ kind: summary ? 'summary' : options.maxTokens === 1 ? 'ping' : 'turn', model: `${model.provider}/${model.id}`,
      reasoning: options.reasoning, cacheRetention: options.cacheRetention,
      system: effectiveSections(context.messages),
      lastSections: Object.keys(context.messages.findLast(item => item.role === 'system')?.sections ?? {}),
      request: JSON.stringify(context) })
    if (summary) return fauxAssistantMessage('SUMMARY-OF-OLD-PART')
    const reply = replies.shift() ?? 'Answer.'
    return typeof reply === 'string' ? fauxAssistantMessage(reply) : reply
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  return { models, requests }
}

async function temporary(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-settings-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return directory
}

const seed = (directory, values, onboarding = 'done') =>
  writeFile(join(directory, 'settings.json'), JSON.stringify({ schema: 1, onboarding, values }), { mode: 0o600 })
const stored = async directory => JSON.parse(await readFile(join(directory, 'settings.json'), 'utf8'))

/** A service with `settings.json` in [directory] and no environment variable. Each call opens a new conversation. */
async function open(t, directory, { replies, environment = {}, options = {} } = {}) {
  const { models, requests } = fakeModels(replies)
  const service = await PiMegachatService.open(new MemoryStorage(), models, undefined, undefined,
    { settingsPath: join(directory, 'settings.json'), environment, keepAlive: { minTokens: 1000 }, ...options })
  await service.state.addWorkspace(directory)
  const server = new DaemonServer(service)
  const daemon = new DaemonClient(await server.listen())
  await service.resume()
  let closed = false
  const close = async () => {
    if (closed) return
    closed = true
    await server.close()
    await service.close()
  }
  t.after(close)
  const tool = async args => {
    const settings = service.extension().tools.find(item => item.name === 'agents_settings')
    return JSON.parse((await settings.execute(args)).output[0].text)
  }
  const say = async (id, content) => {
    const receipt = await service.submit(id, content)
    await daemon.json(`/wait?submission=${receipt.submissionId}`)
    await waitForState(service.state, state => state.current === null ? true : undefined)
  }
  // The rules of the section `settings` that the next request gets.
  const instructions = async () => {
    const agent = await service.root.agent(BACKGROUND_CONTEXT)
    return agent.sections.find(section => section.key === 'settings').render()
  }
  return { service, requests, tool, say, close, instructions, daemon }
}

test('the registry gives the environment, then the stored setting, then the default, with the source of each value', async () => {
  const { models } = fakeModels()
  const store = await SettingsStore.open(undefined)
  const settings = new MegachatSettings(store, { models, environment: { MEGACHAT_CACHE_TTL: '5m', MEGACHAT_KEEPALIVE_HOURS: 'many' } })
  assert.equal(store.onboarding, 'pending')
  assert.deepEqual(settings.values(), {
    'coordinator.model': 'anthropic/claude-opus-5-5', 'coordinator.thinking': 'low', 'keepAlive.enabled': true, 'keepAlive.hours': 6,
    'cache.ttl': '5m', 'compaction.tokens': 100000,
    'workday.enabled': false, 'workday.start': '09:00', 'workday.end': '19:00', 'workday.days': ['mon', 'tue', 'wed', 'thu', 'fri'],
    'workday.timezone': 'auto', 'workday.idleMinutes': 30, 'report.morning': false, 'update.auto': false, 'reply.suggestions': 'ghost', 'reply.language': 'auto', 'reply.length': 'short',
    'reply.quoteRequest': false,
    'children.agent': 'claude', 'children.parallel': 3, 'children.piModel': 'anthropic/claude-haiku-5-5', 'children.claudeModel': 'inherit', 'children.codexModel': 'inherit', 'children.permissionMode': 'inherit', 'children.commit': 'allow', 'children.push': 'ask', 'children.daemonRestart': 'ask',
    'children.timeoutMinutes': 240, 'children.showInProject': false,
    'projects.newRoot': '~/src', 'budget.dailyUsd': 0, 'memory.characters': 4000, 'memory.reflection': true, 'sessions.index': 'off', 'sessions.days': 180, 'sessions.notes': 'off',
  })
  assert.equal(settings.entry('cache.ttl').source, 'environment')
  // A variable that the daemon cannot read has no effect.
  assert.equal(settings.entry('keepAlive.hours').source, 'default')
  await settings.set('keepAlive.hours', '2')
  assert.deepEqual(settings.entry('keepAlive.hours'), { key: 'keepAlive.hours', value: 2, source: 'setting', default: 6,
    variable: 'MEGACHAT_KEEPALIVE_HOURS', stored: 2 })
  const hidden = await settings.set('cache.ttl', '1h')
  assert.equal(hidden.value, '5m')
  assert.equal(hidden.source, 'environment')
  assert.equal(hidden.storedHidden, true)
  assert.equal(hidden.note, message('settings.hidden', 'MEGACHAT_CACHE_TTL'))
  const reset = await settings.reset('keepAlive.hours')
  assert.equal(reset.source, 'default')
  assert.equal(reset.value, 6)
  const option = new MegachatSettings(store, { models, overrides: { 'cache.ttl': '1h' }, environment: { MEGACHAT_CACHE_TTL: '5m' } })
  assert.equal(option.entry('cache.ttl').source, 'option')
})

test('each setting accepts its allowed values and refuses each other value', async () => {
  const { models } = fakeModels()
  const settings = new MegachatSettings(await SettingsStore.open(undefined), { models, environment: {} })
  const accepted = {
    'coordinator.model': [[FAST, FAST], [` ${DEEP} `, DEEP]],
    // The fake models map no level above high.
    'coordinator.thinking': [['off', 'off'], ['high', 'high'], [' minimal ', 'minimal']],
    'keepAlive.enabled': [[false, false], ['on', true], ['0', false]],
    'keepAlive.hours': [[0, 0], ['0.5', 0.5], [168, 168]],
    'cache.ttl': [['5m', '5m'], ['1h', '1h']],
    'compaction.tokens': [[50000, 50000], ['999999999', 999999999]],
    'workday.enabled': [[true, true], ['off', false], ['yes', true]],
    'workday.start': [['08:30', '08:30'], [' 7:05 ', '07:05'], ['00:00', '00:00']],
    'workday.end': [['23:59', '23:59'], ['18:00', '18:00']],
    // A list and a text give the days in the order of the week, without a repeat. A range can go past Sunday.
    'workday.days': [[['fri', 'mon'], ['mon', 'fri']], ['mon-fri', ['mon', 'tue', 'wed', 'thu', 'fri']], [' Sat , sunday ', ['sat', 'sun']],
      ['fri-mon', ['mon', 'fri', 'sat', 'sun']], [['tue', 'Tuesday'], ['tue']]],
    'workday.timezone': [[' AUTO ', 'auto'], ['Europe/Berlin', 'Europe/Berlin'], ['UTC', 'UTC'], ['America/New_York', 'America/New_York']],
    'workday.idleMinutes': [[0, 0], ['45', 45], [1440, 1440]],
    'report.morning': [[true, true], ['on', true], [' off ', false]],
    'update.auto': [[false, false], ['on', true], [' off ', false]],
    // The values of v0.3.0, true and false, and the words of a boolean give reply and off.
    'reply.suggestions': [['ghost', 'ghost'], [' Reply ', 'reply'], ['off', 'off'], [true, 'reply'], [false, 'off'], ['on', 'reply'], ['0', 'off']],
    'reply.language': [['Deutsch', 'Deutsch'], ['AUTO', 'auto'], ['Português (Brasil)', 'Português (Brasil)']],
    'reply.length': [['detailed', 'detailed'], ['normal', 'normal']],
    'reply.quoteRequest': [['yes', true], [false, false]],
    'children.agent': [['codex', 'codex'], [' claude ', 'claude']],
    'children.parallel': [[1, 1], [' 8 ', 8], ['3', 3]],
    'children.piModel': [[FAST, FAST], [` ${DEEP} `, DEEP]],
    'children.permissionMode': [['ask', 'ask'], [' allowEdits ', 'allowEdits'], ['auto', 'auto'], ['inherit', 'inherit']],
    // A model ID of Claude Code needs no model of the registry: the fake registry has no anthropic model.
    'children.claudeModel': [['inherit', 'inherit'], [' inherit ', 'inherit'], ['anthropic/claude-sonnet-5-5', 'anthropic/claude-sonnet-5-5'],
      [' anthropic/fable ', 'anthropic/fable'], ['anthropic/claude-opus-5-5[1m]', 'anthropic/claude-opus-5-5[1m]']],
    // A model ID of Codex needs no model of the registry either.
    'children.codexModel': [['inherit', 'inherit'], [' inherit ', 'inherit'], ['openai/gpt-5.5', 'openai/gpt-5.5'],
      [' openai/gpt-5.3-codex ', 'openai/gpt-5.3-codex'], ['openai/o4_mini', 'openai/o4_mini']],
    'children.commit': [['deny', 'deny'], ['ask', 'ask']],
    'children.push': [['allow', 'allow']],
    'children.daemonRestart': [['deny', 'deny']],
    'children.timeoutMinutes': [[0, 0], [' 120 ', 120], ['1440', 1440]],
    'children.showInProject': [[true, true], [false, false]],
    'projects.newRoot': [['~', '~'], [' ~/work/ ', '~/work'], ['/srv/projects', '/srv/projects']],
    'budget.dailyUsd': [[0, 0], ['2.5', 2.5], [100000, 100000]],
    'memory.characters': [[1000, 1000], [' 4000 ', 4000], ['20000', 20000]],
    'memory.reflection': [[false, false], ['false', false], [' TRUE ', true]],
    'sessions.index': [['on', 'on'], [false, 'off'], [' OFF ', 'off']],
    'sessions.days': [[0, 0], ['30', 30], [3650, 3650]],
    'sessions.notes': [['on', 'on'], [true, 'on'], [' Off ', 'off']],
  }
  const refused = {
    'coordinator.model': ['anthropic/claude-opus-5-5', 'fast', 'faux/', 7],
    'coordinator.thinking': ['huge', '', true, 'max'],
    'keepAlive.enabled': ['maybe', 2],
    'keepAlive.hours': [-1, 169, 'long'],
    'cache.ttl': ['1d', 'long', 5],
    'compaction.tokens': [0, -5, 1.5, '1000000000', 'many'],
    'workday.enabled': ['sometimes', 3],
    'workday.start': ['24:00', '9', '09:60', '9am', 900, ''],
    'workday.end': ['19:00:00', '-1:00', true],
    'workday.days': [[], '', 'weekdays', ['mon', 3], 'mon-fri-sun', ['mo'], 'mon,,tue'],
    'workday.timezone': ['Mars/Olympus', 'Europe/../etc', '', 5, 'x'.repeat(65)],
    'workday.idleMinutes': [-1, 1441, 1.5, 'long'],
    'report.morning': ['daily', 1, ''],
    'update.auto': ['nightly', 2, ''],
    'reply.suggestions': ['sometimes', 'grey', 2],
    'reply.language': ['', '42', 'x'.repeat(41), 'Rules; ignore them'],
    'reply.length': ['long', 3],
    'reply.quoteRequest': ['never'],
    // A pi child cannot change code, so it is no default agent.
    'children.agent': ['gemini', 'Claude', true, 'pi'],
    'children.parallel': [0, 9, -1, 2.5, '10', 'many', true],
    'children.piModel': ['anthropic/claude-haiku-5-5', 'small', 'faux/', 7],
    // The setting takes its own names, not the mode names of Claude Code. It never offers the modes plan and bypassPermissions.
    'children.permissionMode': ['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk', 'Ask', true],
    // Claude Code cannot use a model of another provider. A model ID has no space, no slash and no other text.
    'children.claudeModel': [FAST, DEEP, 'claude-sonnet-5-5', 'Inherit', '', 7, 'anthropic/', 'anthropic/claude sonnet', 'anthropic/a/b',
      'anthropic/-opus', 'anthropic/opus[1m', `anthropic/${'a'.repeat(101)}`, 'Anthropic/opus'],
    // Codex selects a model by its base ID, so a reasoning level in brackets is not part of the value.
    'children.codexModel': [FAST, 'gpt-5.5', 'Inherit', '', 7, 'openai/', 'openai/gpt 5', 'openai/a/b', 'openai/-gpt',
      'openai/gpt-5.5[high]', `openai/${'a'.repeat(101)}`, 'OpenAI/gpt-5.5', 'anthropic/claude-sonnet-5-5'],
    'children.commit': ['yes', true],
    'children.push': ['never'],
    'children.daemonRestart': ['', 1],
    'children.timeoutMinutes': [-1, 1441, '1.5', 'long', '', true],
    'children.showInProject': ['sometimes', 2],
    'projects.newRoot': ['src', '', '~user/src', 5],
    'budget.dailyUsd': [-1, 'much', 100001, true],
    // The default memory of 4,000 characters holds about 40 entries. Less than 1,000 holds too few.
    'memory.characters': [999, 20001, 1500.5, '4k', true, ''],
    'memory.reflection': ['sometimes', 2, ''],
    'sessions.index': ['later', 2],
    'sessions.days': [-1, 3651, 1.5, 'long'],
    'sessions.notes': ['soon', 5, ''],
  }
  assert.deepEqual(Object.keys(accepted).sort(), SETTINGS.map(setting => setting.key).sort())
  for (const [key, cases] of Object.entries(accepted)) {
    for (const [value, normalized] of cases) assert.deepEqual((await settings.set(key, value)).value, normalized, `${key} ${value}`)
    for (const value of refused[key]) await assert.rejects(settings.set(key, value), { code: 'settingValue' }, `${key} ${value}`)
  }
  // The setting accepts a directory of the new projects only in a form that the create expands on this platform.
  for (const value of ['~\\work', '~/work', '~', '/srv', 'C:\\work', '\\\\server\\share', '~work']) {
    const usable = isAbsolute(expandHome(value, '/home/user'))
    if (usable) assert.equal((await settings.set('projects.newRoot', value)).value, value, value)
    else await assert.rejects(settings.set('projects.newRoot', value), { code: 'settingValue' }, value)
  }
  if (sep === '/') await assert.rejects(settings.set('projects.newRoot', '~\\work'), { code: 'settingValue' })
  await assert.rejects(settings.set('coordinator.color', 'red'), { code: 'settingKey' })
  await assert.rejects(settings.reset('coordinator.color'), { code: 'settingKey' })
  await assert.rejects(settings.setOnboarding('later'), { code: 'settingValue' })
})

test('the levels of a model limit the reasoning level, and get lists the models with their prices', async () => {
  const { models } = fakeModels()
  const settings = new MegachatSettings(await SettingsStore.open(undefined), { models, environment: {} })
  const described = settings.describe()
  const model = described.settings.find(entry => entry.key === 'coordinator.model')
  assert.deepEqual(model.values.map(item => item.value), [FAST, DEEP])
  assert.deepEqual(model.values[1].usdPerMillionTokens, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 })
  assert.equal(model.note, message('settings.model.measurement'))
  assert.match(model.note, /2\.8 s and cost about 0\.013 USD/)
  for (const entry of described.settings) {
    assert.equal(entry.description, message(`setting.${entry.key}`))
    assert.equal(entry.applies, message(`settings.applies.${SETTINGS.find(setting => setting.key === entry.key).applies}`))
    assert.ok(entry.values || entry.minimum !== undefined || entry.other, entry.key)
  }
  // Claude Opus 5.5 has no levels off and minimal, so the setting refuses them for that model.
  const anthropic = createModels()
  const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic')
  anthropic.setProvider(anthropicProvider())
  const opus = new MegachatSettings(await SettingsStore.open(undefined), { models: anthropic, environment: {} })
  await assert.rejects(opus.set('coordinator.thinking', 'off'), { code: 'settingValue' })
  assert.equal((await opus.set('coordinator.thinking', 'high')).value, 'high')
  assert.deepEqual(opus.describe().settings.find(entry => entry.key === 'coordinator.thinking').values, ['low', 'medium', 'high', 'xhigh', 'max'])
  // The model of a Claude child is a model ID of Claude Code with the provider anthropic, also one that the registry does
  // not know. The Claude child refuses a model that Claude Code does not offer.
  assert.equal(opus.entry('children.claudeModel').value, 'inherit')
  assert.equal((await opus.set('children.claudeModel', ' anthropic/claude-haiku-5-5 ')).value, 'anthropic/claude-haiku-5-5')
  assert.equal((await opus.set('children.claudeModel', 'anthropic/claude-unknown-9')).value, 'anthropic/claude-unknown-9')
  for (const value of ['claude-opus-5-5', 'anthropic/', 'openai/gpt-5'])
    await assert.rejects(opus.set('children.claudeModel', value), { code: 'settingValue' }, value)
  // The model of a Codex child is a model ID of Codex with the provider openai. The registry of this test has no openai
  // model, and the value is valid all the same.
  assert.equal(opus.entry('children.codexModel').value, 'inherit')
  assert.equal((await opus.set('children.codexModel', ' openai/gpt-unknown-9 ')).value, 'openai/gpt-unknown-9')
  for (const value of ['gpt-5.5', 'openai/', 'anthropic/claude-haiku-5-5'])
    await assert.rejects(opus.set('children.codexModel', value), { code: 'settingValue' }, value)
  assert.deepEqual(opus.describe().settings.find(entry => entry.key === 'children.codexModel').values, ['inherit'])
})

test('no file means a pending onboarding, and each answer goes at once to a private file that a new start reads', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  const first = await open(t, directory)
  assert.match(await first.instructions(), ONBOARDING)
  assert.doesNotMatch(await first.instructions(), SETTINGS_RULE)
  assert.equal((await first.tool({ action: 'get' })).onboarding, 'pending')
  // The first start writes no file. The first answer writes it.
  assert.deepEqual(await readdir(directory), [])
  await first.tool({ action: 'set', key: 'reply.length', value: 'detailed' })
  assert.deepEqual(await stored(directory), { schema: 1, onboarding: 'pending', values: { 'reply.length': 'detailed' } })
  assert.equal((await stat(join(directory, 'settings.json'))).mode & 0o777, 0o600)
  await first.tool({ action: 'set', key: 'reply.language', value: 'Deutsch' })
  await first.tool({ action: 'set', key: 'keepAlive.hours', value: 2 })
  await first.tool({ action: 'onboarding', status: 'skipped' })
  assert.deepEqual(await readdir(directory), ['settings.json'])
  await first.close()
  const second = await open(t, directory)
  const described = await second.tool({ action: 'get' })
  assert.equal(described.onboarding, 'skipped')
  const value = key => described.settings.find(entry => entry.key === key)
  assert.deepEqual([value('reply.length').value, value('reply.length').source], ['detailed', 'setting'])
  assert.equal(value('reply.language').value, 'Deutsch')
  assert.equal(value('keepAlive.hours').value, 2)
  assert.equal(second.service.keepAlive.windowMs, 2 * HOUR)
  assert.doesNotMatch(await second.instructions(), ONBOARDING)
  assert.match(await second.instructions(), SETTINGS_RULE)
})

test('after done or skipped, the setup rules stay away after a restart, and pending brings them back', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'coordinator.model': FAST }, 'pending')
  const first = await open(t, directory)
  await first.say('hello', 'Hello.')
  assert.match(first.requests.at(-1).system, ONBOARDING)
  assert.match(first.requests.at(-1).request, /agents_settings/)
  assert.deepEqual(await first.tool({ action: 'onboarding', status: 'done' }), { onboarding: 'done' })
  await first.say('next', 'Next.')
  // The change sends the section of the settings again, and not the bundled rules.
  assert.deepEqual(first.requests.at(-1).lastSections, ['settings'])
  assert.doesNotMatch(first.requests.at(-1).system, ONBOARDING)
  assert.match(first.requests.at(-1).system, SETTINGS_RULE)
  await first.close()
  const second = await open(t, directory)
  await second.say('hello', 'Hello again.')
  assert.doesNotMatch(second.requests.at(-1).system, ONBOARDING)
  const again = await second.tool({ action: 'onboarding', status: 'pending' })
  assert.equal(again.onboarding, 'pending')
  // A new setup starts in the same turn, so the result holds the setup rules.
  assert.match(again.rules, ONBOARDING)
  await second.say('setup', 'Run the setup.')
  assert.match(second.requests.at(-1).system, ONBOARDING)
  await second.tool({ action: 'onboarding', status: 'skipped' })
  await second.close()
  const third = await open(t, directory)
  assert.doesNotMatch(await third.instructions(), ONBOARDING)
  assert.equal((await stored(directory)).onboarding, 'skipped')
})

test('a set model and reasoning level reach the next turn, and a change in a turn waits for its end', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'coordinator.model': FAST })
  const { requests, tool, say, service, instructions } = await open(t, directory, { replies: [
    fauxAssistantMessage([fauxToolCall('agents_settings', { action: 'set', key: 'coordinator.model', value: DEEP }),
      fauxToolCall('agents_settings', { action: 'set', key: 'coordinator.thinking', value: 'high' }),
      fauxToolCall('agents_settings', { action: 'set', key: 'reply.length', value: 'detailed' })], { stopReason: 'toolUse' }),
    'Changed.',
  ] })
  await say('change', 'Use the deep model and think more.')
  assert.deepEqual(requests.map(request => [request.model, request.reasoning]), [[FAST, 'low'], [FAST, 'low']])
  // The tool calls of the turn changed the stored settings at once.
  assert.deepEqual((await stored(directory)).values, { 'coordinator.model': DEEP, 'coordinator.thinking': 'high', 'reply.length': 'detailed' })
  assert.match(requests[1].system, /Keep answers short\./)
  await say('next', 'A question.')
  assert.deepEqual([requests[2].model, requests[2].reasoning], [DEEP, 'high'])
  assert.match(requests[2].system, /Give detailed answers\./)
  assert.doesNotMatch(requests[2].system, /Keep answers short\./)
  assert.deepEqual(service.model, { provider: 'faux', modelId: 'deep' })
  // Off sends no reasoning option, as Pi Durable does.
  await tool({ action: 'set', key: 'coordinator.thinking', value: 'off' })
  await say('third', 'Another question.')
  assert.equal(requests[3].reasoning, undefined)
  assert.match(await instructions(), /Give detailed answers\./)
})

test('a keep-alive request uses the stored model and reasoning level of the turns', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'coordinator.model': DEEP, 'coordinator.thinking': 'medium' })
  const { service, requests, say } = await open(t, directory)
  await say('first', 'A question.')
  assert.equal(await service.ping(undefined).then(() => requests.at(-1).kind), 'ping')
  assert.deepEqual([requests.at(-1).model, requests.at(-1).reasoning], [DEEP, 'medium'])
  assert.equal(requests.at(-1).reasoning, requests[0].reasoning)
})

test('the keep-alive, the cache lifetime and the limit of a summary take the stored values and change in a running daemon', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'coordinator.model': FAST, 'cache.ttl': '5m', 'keepAlive.hours': 3, 'compaction.tokens': 50000 })
  const { service, requests, tool, say } = await open(t, directory)
  assert.equal(service.keepAlive.ttlMs, 5 * MINUTE)
  assert.equal(service.keepAlive.windowMs, 3 * HOUR)
  assert.equal(service.keepAlive.compactTokens, 50000)
  await say('first', 'A question.')
  assert.equal(requests[0].cacheRetention, 'short')
  const before = service.keepAlive
  await tool({ action: 'set', key: 'cache.ttl', value: '1h' })
  await tool({ action: 'set', key: 'compaction.tokens', value: 80000 })
  assert.notEqual(service.keepAlive, before)
  assert.equal(service.keepAlive.ttlMs, HOUR)
  assert.equal(service.keepAlive.compactTokens, 80000)
  // The new keep-alive of the idle daemon waits for the cache lifetime after the last model request.
  assert.notEqual(service.keepAlive.timer, undefined)
  await say('second', 'A question.')
  assert.equal(requests[1].cacheRetention, 'long')
  await tool({ action: 'set', key: 'keepAlive.enabled', value: false })
  assert.equal(service.keepAlive, undefined)
  await tool({ action: 'reset', key: 'keepAlive.enabled' })
  assert.equal(service.keepAlive.windowMs, 3 * HOUR)
})

test('the limit of a summary sets the reserve of the harness for the window of the model', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  const { models } = fakeModels()
  await seed(directory, { 'coordinator.model': FAST, 'compaction.tokens': 50000 })
  // The fake models have a window of 128,000 tokens, which leaves room for a limit of 50,000 tokens.
  const fast = models.getModel('faux', 'fast')
  const { service, tool } = await open(t, directory)
  // The reserve is for the model of the main agent only, so a pi child with a smaller window keeps the limits of Pi Durable.
  assert.deepEqual(service.live.harness.compaction, { modelOverrides: { [FAST]: { reserveTokens: fast.contextWindow - 50000 - 32768 } } })
  await tool({ action: 'set', key: 'compaction.tokens', value: 60000 })
  assert.deepEqual(service.live.harness.compaction, { modelOverrides: { [FAST]: { reserveTokens: fast.contextWindow - 60000 - 32768 } } })
  await tool({ action: 'reset', key: 'compaction.tokens' })
  assert.deepEqual(service.live.harness.compaction, { modelOverrides: { [FAST]: {} } })
})

test('the reply style gives lines of the rules, and the defaults give the rules from before the settings', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  const { tool, instructions } = await open(t, directory)
  const defaults = await instructions()
  assert.match(defaults, /Keep answers short\.\nUse the user's language\.\n/)
  // The default mode of the suggestions is ghost.
  assert.match(defaults, /Do not propose a next step in the reply text unless the user asks for one\./)
  assert.doesNotMatch(defaults, /quote the original request/)
  await tool({ action: 'set', key: 'reply.language', value: 'Deutsch' })
  await tool({ action: 'set', key: 'reply.length', value: 'normal' })
  await tool({ action: 'set', key: 'reply.quoteRequest', value: true })
  await tool({ action: 'set', key: 'reply.suggestions', value: true })
  const changed = await instructions()
  assert.match(changed, /Write each answer in Deutsch, unless the user asks for another language\./)
  assert.match(changed, /Give complete answers of a usual length\./)
  assert.match(changed, /first quote the original request of the user for that task in one short line\./)
  assert.match(changed, /Call agents_suggest before every proposal/)
  assert.doesNotMatch(changed, /Keep answers short|Use the user's language/)
})

test('the suggestions setting changes the tools of the running main agent', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'reply.suggestions': 'off' })
  const { service, tool } = await open(t, directory)
  const names = () => service.registry.snapshot().tools().map(item => item.tool.name)
  assert.ok(!names().includes('agents_suggest'))
  await tool({ action: 'set', key: 'reply.suggestions', value: 'on' })
  assert.ok(names().includes('agents_suggest'))
  assert.equal(service.state.eventSuffix, '.suggest')
  assert.equal(service.state.suggestionMode, 'reply')
  // The mode ghost keeps the two tools, with the description of a prompt suggestion.
  const set = await tool({ action: 'set', key: 'reply.suggestions', value: 'ghost' })
  assert.deepEqual([set.value, set.source, set.stored], ['ghost', 'setting', 'ghost'])
  const description = () => service.registry.snapshot().tools().find(item => item.tool.name === 'agents_suggest').tool.description
  assert.equal(description(), message('tool.suggest.ghost'))
  assert.equal(service.state.suggestionMode, 'ghost')
  assert.equal(service.state.eventSuffix, '.suggest')
  await tool({ action: 'set', key: 'reply.suggestions', value: 'off' })
  assert.ok(!names().includes('agents_suggest'))
  assert.equal(service.state.eventSuffix, '')
})

test('the setting reply.suggestions takes the stored values true and false of v0.3.0 and the variable values 0, 1 and ghost', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'reply.suggestions': true })
  const reply = await open(t, directory)
  assert.equal(reply.service.suggestions, 'reply')
  assert.match(await reply.instructions(), /Call agents_suggest before every proposal/)
  const entry = reply.service.settings.entry('reply.suggestions')
  assert.deepEqual([entry.value, entry.source, entry.stored, entry.storedIgnored], ['reply', 'setting', true, undefined])
  await reply.close()
  await seed(directory, { 'reply.suggestions': false })
  const off = await open(t, directory)
  assert.equal(off.service.suggestions, 'off')
  assert.match(await off.instructions(), /Do not propose a next step unless the user asks for one\./)
  await off.close()
  // A stored off keeps its mode.
  await seed(directory, { 'reply.suggestions': 'off' })
  const stored = await open(t, directory)
  assert.equal(stored.service.suggestions, 'off')
  assert.match(await stored.instructions(), /Do not propose a next step unless the user asks for one\./)
  await stored.close()
  // Without a stored value and without the variable, the mode is the default ghost.
  await seed(directory, {})
  const defaults = await open(t, directory)
  assert.equal(defaults.service.suggestions, 'ghost')
  assert.ok(defaults.service.extension().tools.some(item => item.name === 'agents_suggest'))
  await defaults.close()
  // The variable wins over a stored value.
  await seed(directory, { 'reply.suggestions': 'reply' })
  const variable = await open(t, directory, { environment: { MEGACHAT_SUGGESTIONS: '0' } })
  assert.equal(variable.service.suggestions, 'off')
  await variable.close()
  // A value of the variable that the daemon cannot read, such as true, has no effect, so the default ghost applies.
  await seed(directory, {})
  for (const [text, mode] of [['1', 'reply'], ['0', 'off'], ['ghost', 'ghost'], [' GHOST ', 'ghost'], ['reply', 'reply'], ['true', 'ghost']]) {
    const settings = new MegachatSettings(await SettingsStore.open(join(directory, 'settings.json')), { environment: { MEGACHAT_SUGGESTIONS: text } })
    assert.equal(settings.entry('reply.suggestions').value, mode, text)
  }
  await seed(directory, {})
  const ghost = await open(t, directory, { environment: { MEGACHAT_SUGGESTIONS: 'ghost' } })
  const rules = await ghost.instructions()
  assert.match(rules, /Do not propose a next step in the reply text unless the user asks for one\./)
  assert.match(rules, /call agents_suggest one time in the turn/)
  assert.doesNotMatch(rules, /Call agents_suggest before every proposal|Do not propose a next step unless/)
})

test('an environment variable wins over the stored value, and the tool says so', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  const { service, tool } = await open(t, directory, { environment: { MEGACHAT_KEEPALIVE: '0', MEGACHAT_COMPACT_TOKENS: '40000' } })
  assert.equal(service.keepAlive, undefined)
  const set = await tool({ action: 'set', key: 'keepAlive.enabled', value: true })
  assert.deepEqual([set.value, set.source, set.stored, set.storedHidden], [false, 'environment', true, true])
  assert.equal(set.note, message('settings.hidden', 'MEGACHAT_KEEPALIVE'))
  assert.equal(service.keepAlive, undefined)
  const limit = (await tool({ action: 'get' })).settings.find(entry => entry.key === 'compaction.tokens')
  assert.deepEqual([limit.value, limit.source, limit.variable], [40000, 'environment', 'MEGACHAT_COMPACT_TOKENS'])
})

test('a compaction of the conversation does not lose a setting', { timeout: 30000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'coordinator.model': FAST })
  const { service, requests, tool, say } = await open(t, directory)
  await tool({ action: 'set', key: 'reply.language', value: 'Deutsch' })
  const large = word => `${word} `.repeat(40000 / (word.length + 1))
  for (const word of ['alpha', 'beta', 'gamma']) await say(word, large(word))
  assert.deepEqual(await service.compact(), { compacted: true })
  assert.notEqual((await service.root.context(BACKGROUND_CONTEXT)).head, undefined)
  await say('after', 'A question.')
  assert.match(requests.at(-1).system, /Write each answer in Deutsch/)
  assert.equal((await stored(directory)).values['reply.language'], 'Deutsch')
})

test('a turn of a child result cannot change a setting', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'coordinator.model': FAST })
  const { service, requests } = await open(t, directory, { replies: [
    fauxAssistantMessage(fauxToolCall('agents_settings', { action: 'set', key: 'reply.length', value: 'detailed' }), { stopReason: 'toolUse' }),
    'Noted.',
  ] })
  // A finished run that no report named yet starts the turn of its result.
  await service.state.change(state => {
    state.runs.finished = { id: 'finished', childSessionId: 'child', agent: 'claude', requestId: 'spawn', prompt: 'Work', cwd: directory,
      status: 'completed', output: 'Done.', truncated: false, reported: false, createdAt: Date.now(), finishedAt: Date.now() }
  })
  await waitForState(service.state, state => state.current === null && state.runs.finished.reported && requests.length >= 2 ? true : undefined)
  assert.match(requests[0].request, /Child tasks ended after your previous reply\./)
  assert.equal((await stored(directory)).values['reply.length'], undefined)
  assert.match(requests[1].request, /An automatic turn, such as a child result, the summary of the past sessions or the morning report, cannot change a setting\./)
})

test('a file that the daemon cannot read stays under another name, and the defaults apply', { timeout: 20000 }, async t => {
  for (const content of ['{ "schema": 1, "onboarding": ', JSON.stringify({ schema: 2, onboarding: 'done', values: {} }), '[]']) {
    const directory = await temporary(t)
    await writeFile(join(directory, 'settings.json'), content, { mode: 0o600 })
    const lines = []
    t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true })
    let store
    try { store = await SettingsStore.open(join(directory, 'settings.json')) }
    finally { process.stderr.write.mock.restore() }
    assert.equal(store.onboarding, 'pending')
    assert.equal(store.stored('reply.length'), undefined)
    const files = await readdir(directory)
    assert.equal(files.length, 1)
    assert.match(files[0], /^settings\.json\.unreadable-\d{4}-\d\d-\d\dT[\d-]+Z$/)
    assert.equal(await readFile(join(directory, files[0]), 'utf8'), content)
    assert.equal(lines.length, 1)
    assert.match(lines[0], /Megachat cannot read settings\.json \((json|schema|shape)\)\. The file is now settings\.json\.unreadable-/)
    await store.change(data => { data.values['reply.length'] = 'normal' })
    assert.equal((await stored(directory)).values['reply.length'], 'normal')
  }
})

test('a stored value that this build does not accept gives the default, and the file keeps it', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'coordinator.model': FAST, 'cache.ttl': '1d', 'future.key': 1 })
  const { tool } = await open(t, directory)
  const ttl = (await tool({ action: 'get' })).settings.find(entry => entry.key === 'cache.ttl')
  assert.deepEqual([ttl.value, ttl.source, ttl.stored, ttl.storedIgnored], ['1h', 'default', '1d', true])
  await tool({ action: 'set', key: 'reply.length', value: 'normal' })
  assert.deepEqual((await stored(directory)).values, { 'coordinator.model': FAST, 'cache.ttl': '1d', 'future.key': 1, 'reply.length': 'normal' })
})

test('a stored setting of the project events of v0.3.0 causes no error, and the next write drops it', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'coordinator.model': FAST, 'events.enabled': false, 'events.ignore': ['gen/**'], 'future.key': 1 })
  const { tool, say, requests } = await open(t, directory)
  const described = await tool({ action: 'get' })
  assert.ok(described.settings.every(entry => !entry.key.startsWith('events.')))
  for (const key of ['events.enabled', 'events.ignore']) {
    await assert.rejects(tool({ action: 'set', key, value: true }), { code: 'settingKey' })
    await assert.rejects(tool({ action: 'reset', key }), { code: 'settingKey' })
  }
  await say('hello', 'Hello.')
  assert.equal(requests.at(-1).kind, 'turn')
  assert.deepEqual((await stored(directory)).values, { 'coordinator.model': FAST, 'events.enabled': false, 'events.ignore': ['gen/**'], 'future.key': 1 })
  await tool({ action: 'set', key: 'reply.length', value: 'normal' })
  assert.deepEqual((await stored(directory)).values, { 'coordinator.model': FAST, 'future.key': 1, 'reply.length': 'normal' })
})

test('the setup asks three questions: the pair of agents, the index and the repositories, and the account check shows only problems', async () => {
  const rules = await readFile(new URL('../resources/instructions-onboarding.md', import.meta.url), 'utf8')
  const keys = new Set(SETTINGS.map(setting => setting.key))
  const named = new Set(rules.match(/\b[a-z][A-Za-z]*\.[a-z][A-Za-z]+\b/g).filter(word => keys.has(word)))
  assert.deepEqual([...named].sort(), ['children.agent', 'children.codexModel', 'coordinator.model', 'sessions.index'])
  // The pair question changes only the children, and the main model keeps its value.
  assert.match(rules, /\+ Claude[^\n]*children\.agent claude/)
  assert.match(rules, /\+ Codex on GPT-6 Astra[^\n]*children\.agent codex, children\.codexModel openai\/gpt-6-astra/)
  assert.match(rules, /Do not change coordinator\.model/)
  assert.match(rules, /call agents_accounts/)
  assert.match(rules, /Show only the agents with a problem and what to fix\. When each agent is ready, say nothing about the check\./)
  assert.match(rules, /tell the user that each setting can change later in the chat/)
})

test('the answers of the pair with Codex change only the children, and the main model stays', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  await seed(directory, { 'coordinator.model': DEEP }, 'pending')
  const { tool } = await open(t, directory)
  await tool({ action: 'set', key: 'children.agent', value: 'codex' })
  await tool({ action: 'set', key: 'children.codexModel', value: 'openai/gpt-6-astra' })
  const values = Object.fromEntries((await tool({ action: 'get' })).settings.map(entry => [entry.key, entry.value]))
  assert.deepEqual([values['children.agent'], values['children.codexModel'], values['coordinator.model']], ['codex', 'openai/gpt-6-astra', DEEP])
})

test('each setting of the children, the projects and the spend stays across a restart', { timeout: 20000 }, async t => {
  const directory = await temporary(t)
  const values = { 'children.agent': 'codex', 'children.parallel': 1, 'children.piModel': DEEP, 'children.permissionMode': 'allowEdits', 'children.commit': 'deny', 'children.push': 'allow', 'children.daemonRestart': 'deny',
    'children.timeoutMinutes': 0, 'projects.newRoot': '~/work', 'budget.dailyUsd': 3 }
  const first = await open(t, directory)
  for (const [key, value] of Object.entries(values)) await first.tool({ action: 'set', key, value })
  await first.close()
  const second = await open(t, directory)
  const described = (await second.tool({ action: 'get' })).settings
  for (const [key, value] of Object.entries(values)) {
    const entry = described.find(item => item.key === key)
    assert.deepEqual([entry.value, entry.source], [value, 'setting'], key)
  }
})

test('update.auto is false by default, and a change goes to settings.json and applies at the next check of the update', async t => {
  const directory = await temporary(t)
  const { tool } = await open(t, directory)
  const entry = (await tool({ action: 'get' })).settings.find(item => item.key === 'update.auto')
  assert.equal(entry.value, false)
  assert.equal(entry.source, 'default')
  assert.deepEqual(entry.values, [true, false])
  const changed = await tool({ action: 'set', key: 'update.auto', value: true })
  assert.equal(changed.value, true)
  assert.equal(changed.applies, 'At once. The next check of the update uses the new value.')
  assert.equal((await stored(directory)).values['update.auto'], true)
})

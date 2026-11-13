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
import { RULES_LIMIT } from '../src/PiChild.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { waitForState } from '../src/waitForState.mjs'

const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })

/**
 * A service with `settings.json` in a temporary directory, a run service with the fake agent, and the rules paragraph
 * of the daemon. `turn` gives the replies of the model in their order, and `Answer.` follows them. [options] go to the run
 * service.
 */
async function fixture(t, values, configuration, options = {}) {
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
    { settingsPath, memoryPath: join(directory, 'memory.md'), keepAlive: { enabled: false } })
  await service.state.addWorkspace(cwd)
  const launched = []
  const children = new AcpRunService(service.state, { childLaunch: async agent => {
    launched.push(agent)
    return configuration ? configuration.childLaunch(agent) : { env: process.env }
  } },
    { args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], childRules: cwd => service.childRules(cwd),
      // The fake agent stays alive after a refusal, as the adapters do, so the wait for its error output is short here.
      settings: cwd => service.settings.values(cwd), errorOutputWaitMs: 100, ...options })
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
  const lines = name => async () => (await readFile(join(cwd, name), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean)
  return { service, cwd, launched, script, turn, prompts, modes: lines('modes'), configs: lines('configs'), settingsPath, memoryPath: join(directory, 'memory.md') }
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
  // It also tells the mode and the model of a Claude child, and that no value skips a permission request.
  assert.ok(section.includes(message('instructions.claude', 'inherit', 'inherit')))
  assert.match(message('instructions.claude', 'ask', 'inherit'), /bypassPermissions.*Codex child or a pi child/)
  state = await turn('second', call('agents_settings', { action: 'set', key: 'children.push', value: 'deny' }),
    call('agents_settings', { action: 'set', key: 'children.commit', value: 'ask' }),
    call('agents_settings', { action: 'set', key: 'children.permissionMode', value: 'ask' }),
    call('agents_settings', { action: 'set', key: 'children.claudeModel', value: 'anthropic/fable' }),
    call('agents_send', { childSessionId: first.childSessionId, cwd, prompt: 'follow-up' }), fauxAssistantMessage('Sent.'))
  const changed = [message('child.rules'), message('child.rule.commit.ask'), message('child.rule.push.deny'),
    message('child.rule.daemonRestart.ask')].join('\n')
  assert.deepEqual((await prompts())[1], [changed, 'follow-up'])
  assert.deepEqual(Object.values(state.runs).map(run => run.prompt), ['first task', 'follow-up'])
  const changedSection = (await service.root.agent(BACKGROUND_CONTEXT)).sections.find(item => item.key === 'settings').render()
  assert.ok(changedSection.includes(message('instructions.claude', 'ask', 'anthropic/fable')))
  assert.ok(changedSection.includes(message('instructions.codex', 'inherit')))
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

test('a Claude child loads the settings of the user, of the project and the local settings, and its options hold no key, no base URL and no turn limit', { timeout: 20000 }, async t => {
  const env = { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/wire/test-key', ANTHROPIC_API_KEY: 'test-key' }
  const { cwd, turn } = await fixture(t, undefined, { childLaunch: async () => ({ env }) })
  // A project env without ANTHROPIC_BASE_URL does not move the key of Megachat, so the run starts.
  await mkdir(join(cwd, '.claude'))
  await writeFile(join(cwd, '.claude', 'settings.json'), JSON.stringify({ env: { ANTHROPIC_API_KEY: 'project-key', DEBUG: '1' } }))
  const state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  assert.equal(Object.values(state.runs)[0].status, 'completed')
  const options = JSON.parse(await readFile(join(cwd, 'claude-options.json'), 'utf8'))
  assert.deepEqual(options.settingSources, ['user', 'project', 'local'])
  // A turn limit cut long runs at 30 turns. The time limit `children.timeoutMinutes` is the only limit of a run.
  assert.equal(options.maxTurns, undefined)
  // The SDK puts session settings in the command line of Claude, and the base URL of Central holds the key. So the
  // options hold neither. The key and the base URL go only in the environment of the agent.
  assert.equal(options.settings, undefined)
  assert.doesNotMatch(JSON.stringify(options), /test-key|wire/)
})

test('a Claude child never gets the mode bypassPermissions: its options turn the mode off, and a request loses each bypass option', { timeout: 20000 }, async t => {
  const { service, cwd, script } = await fixture(t)
  script.push(call('agents_spawn', { cwd, prompt: 'plan' }), fauxAssistantMessage('Started.'))
  await service.submit('first', 'Work')
  const permission = await waitForState(service.state, state => Object.values(state.permissions).find(item => item.status === 'pending'))
  assert.equal(JSON.parse(await readFile(join(cwd, 'claude-options.json'), 'utf8')).allowDangerouslySkipPermissions, false)
  // The state keeps the request without the options of the adapter that switch the child to bypassPermissions.
  assert.deepEqual(permission.request.options.map(option => option.optionId), ['exit-plan-auto', 'exit-plan-default', 'reject'])
  for (const decision of ['exit-plan-bypass', 'exit-plan-clear-bypass'])
    await assert.rejects(service.state.respondPermission(permission.id, decision), { code: 'invalid' })
  assert.equal((await service.state.snapshot()).permissions[permission.id].status, 'pending')
  await service.state.respondPermission(permission.id, 'exit-plan-default')
  const state = await waitForState(service.state, value => Object.values(value.runs).every(run => terminalStates.has(run.status)) ? value : undefined)
  assert.equal(Object.values(state.runs)[0].status, 'completed')
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'plan-answer'), 'utf8')), { outcome: 'selected', optionId: 'exit-plan-default' })
})

test('the adapter of Claude Code starts a session of a user mode bypassPermissions in the mode default, because the options of a Claude child turn the mode off', async () => {
  // A contract test of the adapter that npm installs with Megachat. A real run of 2026-11-12 showed the same for
  // `session/new` and for `session/load` of a transcript in bypassPermissions, with no error.
  const { resolveInitialPermissionMode } = await import('@agentclientprotocol/claude-agent-acp/dist/session-mode.js')
  const errors = []
  const logger = { error: text => errors.push(text), log: () => {} }
  // `allowDangerouslySkipPermissions: false` in the options gives `allowBypass: false`.
  const availability = { allowBypass: false, allowAuto: true }
  assert.deepEqual(resolveInitialPermissionMode({ defaultMode: 'bypassPermissions' }, logger, availability), { mode: 'default', builtInDefault: false })
  assert.equal(resolveInitialPermissionMode({ defaultMode: 'bypassPermissions', resumed: 'bypassPermissions' }, logger, availability).mode, 'default')
  assert.ok(errors.length > 0)
})

test('a project ANTHROPIC_BASE_URL refuses a Claude child before the start of the agent process, and the message has no value', { timeout: 20000 }, async t => {
  const { cwd, launched, turn } = await fixture(t)
  await mkdir(join(cwd, '.claude'))
  const settings = join(cwd, '.claude', 'settings.json')
  await writeFile(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'http://127.0.0.1:9/wire/project' } }))
  t.mock.method(process.stderr, 'write', () => true)
  const state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  const [run] = Object.values(state.runs)
  assert.equal(run.status, 'interrupted')
  assert.equal(run.error, message('error.settingsBaseUrl', settings))
  assert.doesNotMatch(run.error, /127\.0\.0\.1/)
  // The guard compares the address with the environment of the launch, so the launch is ready, but no adapter started:
  // the run has no process, and the fake agent wrote no file.
  assert.deepEqual(launched, ['claude'])
  assert.equal(run.pid ?? null, null)
  await assert.rejects(readFile(join(cwd, 'session-request.json'), 'utf8'), { code: 'ENOENT' })
  // Claude Code ignores a settings file that is not valid, so the check does too.
  await writeFile(settings, '{"env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:9/wire/project"},}')
  const next = await turn('second', call('agents_spawn', { cwd, prompt: 'second task' }), fauxAssistantMessage('Started.'))
  assert.deepEqual(Object.values(next.runs).map(item => item.status), ['interrupted', 'completed'])
})

test('a base URL of the user or of the local settings refuses a Claude child only when it is not the Central address of the child', { timeout: 20000 }, async t => {
  const address = 'http://127.0.0.1:9/wire/central'
  const env = { ...process.env, ANTHROPIC_BASE_URL: address, ANTHROPIC_API_KEY: 'test-key' }
  const { cwd, turn } = await fixture(t, undefined, { childLaunch: async () => ({ env }) })
  t.mock.method(process.stderr, 'write', () => true)
  // `test/state-guard.mjs` gives each test file an empty configuration directory of Claude Code.
  const user = join(process.env.CLAUDE_CONFIG_DIR, 'settings.json')
  t.after(() => rm(user, { force: true }))
  // The Central entry of `central add claude-code` has the address of the child, so the run starts.
  await writeFile(user, JSON.stringify({ apiKeyHelper: 'echo test-key', env: { ANTHROPIC_BASE_URL: address } }))
  let state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ['completed'])
  // Another address in the settings of the user refuses the run, and the message names the file of the user.
  await writeFile(user, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.test' } }))
  state = await turn('second', call('agents_spawn', { cwd, prompt: 'second task' }), fauxAssistantMessage('Started.'))
  assert.equal(Object.values(state.runs)[1].error, message('error.settingsBaseUrl', user))
  // The local settings of the project count too.
  await rm(user)
  await mkdir(join(cwd, '.claude'))
  const local = join(cwd, '.claude', 'settings.local.json')
  await writeFile(local, JSON.stringify({ env: { ANTHROPIC_BASE_URL: 'https://gateway.test' } }))
  state = await turn('third', call('agents_spawn', { cwd, prompt: 'third task' }), fauxAssistantMessage('Started.'))
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ['completed', 'interrupted', 'interrupted'])
  assert.equal(Object.values(state.runs)[2].error, message('error.settingsBaseUrl', local))
})

test('a Claude child gets AGENTS.md in its prompt only when the directory has no CLAUDE.md', { timeout: 20000 }, async t => {
  const { cwd, turn, prompts } = await fixture(t)
  const agents = 'Run npm test after each change.'
  await writeFile(join(cwd, 'AGENTS.md'), `${agents}\n`)
  await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  const block = `${message('child.claude.rules', 'AGENTS.md')}\n<repository_rules file="AGENTS.md">\n${agents}\n</repository_rules>`
  assert.deepEqual((await prompts())[0].slice(1), [block, 'first task'])
  // Claude Code loads a CLAUDE.md by itself, with its imports, so the prompt holds no block. This covers .claude/CLAUDE.md too.
  await mkdir(join(cwd, '.claude'))
  await writeFile(join(cwd, '.claude', 'CLAUDE.md'), '@../AGENTS.md\n')
  await turn('second', call('agents_spawn', { cwd, prompt: 'second task' }), fauxAssistantMessage('Started.'))
  assert.deepEqual((await prompts())[1].slice(1), ['second task'])
  await rm(join(cwd, '.claude'), { recursive: true })
  await writeFile(join(cwd, 'CLAUDE.md'), '@AGENTS.md\n')
  await turn('third', call('agents_spawn', { cwd, prompt: 'third task' }), fauxAssistantMessage('Started.'))
  assert.deepEqual((await prompts())[2].slice(1), ['third task'])
  // A long AGENTS.md gives its start and the note of the limit.
  await rm(join(cwd, 'CLAUDE.md'))
  await writeFile(join(cwd, 'AGENTS.md'), 'x'.repeat(RULES_LIMIT + 10))
  await turn('fourth', call('agents_spawn', { cwd, prompt: 'fourth task' }), fauxAssistantMessage('Started.'))
  assert.ok((await prompts())[3][1].endsWith(`</repository_rules>\n${message('child.claude.rulesTruncated', RULES_LIMIT)}`))
})

test('a Claude child and a Codex child get no memory in their prompt', { timeout: 20000 }, async t => {
  for (const agent of ['claude', 'codex']) {
    const { service, cwd, turn, prompts, memoryPath } = await fixture(t, { 'children.agent': agent })
    await writeFile(memoryPath, '## About the user\n- The user writes Kotlin.\n')
    const state = await turn('first', call('agents_spawn', { cwd, prompt: 'Fix the build.' }), fauxAssistantMessage('Started.'))
    assert.equal(Object.values(state.runs)[0].agent, agent)
    const [prompt] = await prompts()
    assert.equal(prompt.at(-1), 'Fix the build.')
    assert.ok(!JSON.stringify(prompt).includes('The user writes Kotlin.'), agent)
    // The main agent has the memory in its section.
    assert.match(await service.memorySection(), /- The user writes Kotlin\./)
  }
})

test('a Codex child gets no AGENTS.md block, because Codex reads AGENTS.md by itself', { timeout: 20000 }, async t => {
  const { cwd, turn, prompts } = await fixture(t, { 'children.agent': 'codex' })
  await writeFile(join(cwd, 'AGENTS.md'), 'Run npm test after each change.\n')
  await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  assert.deepEqual((await prompts())[0].slice(1), ['first task'])
})

test('each value of children.permissionMode sends its mode of Claude Code before the prompt, and inherit sends none', { timeout: 30000 }, async t => {
  // A settings.json of an earlier build has no key children.permissionMode. It opens with the default inherit.
  const { service, cwd, turn, modes } = await fixture(t, { 'children.commit': 'deny' })
  assert.deepEqual([service.settings.entry('children.permissionMode').value, service.settings.entry('children.permissionMode').source],
    ['inherit', 'default'])
  let state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  assert.equal(Object.values(state.runs)[0].status, 'completed')
  assert.deepEqual(await modes(), [])
  const [first] = Object.values(state.runs)
  // A change applies to the next child, also in the turn that made it. A follow-up loads its session and gets the mode too.
  state = await turn('second', call('agents_settings', { action: 'set', key: 'children.permissionMode', value: 'ask' }),
    call('agents_send', { childSessionId: first.childSessionId, cwd, prompt: 'follow-up' }), fauxAssistantMessage('Sent.'))
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ['completed', 'completed'])
  for (const [index, [value, mode]] of [['allowEdits', 'acceptEdits'], ['auto', 'auto']].entries()) {
    await turn(`mode-${index}`, call('agents_settings', { action: 'set', key: 'children.permissionMode', value }),
      call('agents_spawn', { cwd, prompt: `task ${mode}` }), fauxAssistantMessage('Started.'))
  }
  assert.deepEqual(await modes(), ['default before the prompt', 'acceptEdits before the prompt', 'auto before the prompt'])
  // Inherit sends no mode again, and a Codex child never gets one.
  await turn('inherit', call('agents_settings', { action: 'set', key: 'children.permissionMode', value: 'inherit' }),
    call('agents_spawn', { cwd, prompt: 'inherit task' }), fauxAssistantMessage('Started.'))
  await turn('codex', call('agents_settings', { action: 'set', key: 'children.permissionMode', value: 'ask' }),
    call('agents_spawn', { cwd, agent: 'codex', prompt: 'codex task' }), fauxAssistantMessage('Started.'))
  assert.equal((await modes()).length, 3)
})

test('a permission mode that the agent refuses fails the run before the prompt, with no continuation, and the log gets the answer', { timeout: 20000 }, async t => {
  const env = { ...process.env, FAKE_ACP_MODES: 'default,acceptEdits,plan' }
  const { cwd, turn, prompts, modes } = await fixture(t, { 'children.permissionMode': 'auto' }, { childLaunch: async () => ({ env }) })
  const lines = []
  t.mock.method(process.stderr, 'write', text => { lines.push(String(text)); return true })
  const state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  const runs = Object.values(state.runs)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'interrupted')
  // The fixed text of the refusal stays, with no reason. The log gets the answer of the agent.
  assert.equal(runs[0].error, message('error.childMode', 'auto'))
  assert.equal(runs[0].autoResume, false)
  assert.ok(lines.join('').includes(message('log.child.answer', 'session/set_mode', runs[0].id, -32602, '"Invalid params: Mode auto is not available in this session"', 'none')), lines.join(''))
  assert.deepEqual(await modes(), ['auto before the prompt'])
  await assert.rejects(prompts(), { code: 'ENOENT' })
})

test('an agent that ends in the mode request interrupts the run, and the run gets a continuation', { timeout: 20000 }, async t => {
  const env = { ...process.env, FAKE_ACP_MODES: 'exit' }
  const { service, cwd, script } = await fixture(t, { 'children.permissionMode': 'ask' }, { childLaunch: async () => ({ env }) })
  t.mock.method(process.stderr, 'write', () => true)
  script.push(call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  await service.submit('first', 'Work')
  const run = await waitForState(service.state, state => Object.values(state.runs).find(item => terminalStates.has(item.status)), { timeoutMs: 15000 })
  assert.ok(['interrupted', 'resumed'].includes(run.status), run.status)
  assert.notEqual(run.error, message('error.childMode', 'ask'))
  assert.equal(run.autoResume, true)
})

test('a failed read of the settings of Claude Code goes to the log without its message, and the Claude child starts', { timeout: 20000 }, async t => {
  const lines = []
  const resolveSettings = async () => { throw new SyntaxError('Unexpected token in {"env":{"ANTHROPIC_BASE_URL":"http://secret"}}') }
  const { cwd, turn } = await fixture(t, undefined, undefined, { resolveSettings })
  t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true })
  const state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  assert.equal(Object.values(state.runs)[0].status, 'completed')
  const logged = lines.filter(line => line.includes(message('log.claudeSettings')))
  assert.equal(logged.length, 1)
  assert.match(logged[0], /name=SyntaxError/)
  assert.doesNotMatch(lines.join(''), /secret|ANTHROPIC_BASE_URL":/)
})

test('with children.claudeModel inherit a Claude child gets no model request, and a model of the setting goes before the mode and the prompt', { timeout: 30000 }, async t => {
  // The test changes the value of the setting between the turns. The settings test covers the validation.
  let model
  const { service, cwd, turn, configs, modes } = await fixture(t, { 'children.commit': 'deny', 'children.permissionMode': 'ask' },
    { childLaunch: async () => ({ env: process.env, model: 'claude-sonnet-5-5' }) },
    { settings: () => ({ ...service.settings.values(), ...(model ? { 'children.claudeModel': model } : {}) }) })
  const options = async () => JSON.parse(await readFile(join(cwd, 'claude-options.json'), 'utf8'))
  // A settings.json of an earlier build has no key children.claudeModel. It opens with the default inherit.
  assert.deepEqual([service.settings.entry('children.claudeModel').value, service.settings.entry('children.claudeModel').source],
    ['inherit', 'default'])
  let state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  // With inherit, the options keep the model of the launch, and no request switches the model.
  assert.equal((await options()).model, 'claude-sonnet-5-5')
  assert.deepEqual(await configs(), [])
  const [first] = Object.values(state.runs)
  // A change applies to the next child. A follow-up loads its session and gets the model too.
  model = 'anthropic/claude-haiku-5-5'
  state = await turn('second', call('agents_send', { childSessionId: first.childSessionId, cwd, prompt: 'follow-up' }), fauxAssistantMessage('Sent.'))
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ['completed', 'completed'])
  await turn('third', call('agents_spawn', { cwd, prompt: 'third task' }), fauxAssistantMessage('Started.'))
  assert.equal((await options()).model, 'claude-haiku-5-5')
  await turn('codex', call('agents_spawn', { cwd, agent: 'codex', prompt: 'codex task' }), fauxAssistantMessage('Started.'))
  assert.deepEqual(await configs(), ['model=claude-haiku-5-5 before the prompt', 'model=claude-haiku-5-5 before the prompt'])
  assert.equal((await modes()).length, 3)
})

test('a model that the registry does not know reaches the agent, and a model that the agent refuses fails the run before the prompt, with no continuation', { timeout: 20000 }, async t => {
  const env = { ...process.env, FAKE_ACP_MODELS: 'claude-opus-5-5' }
  // The registry of the test knows no anthropic model. The stored value is a model ID of Claude Code all the same.
  const { cwd, turn, prompts, modes, configs, service } = await fixture(t, { 'children.permissionMode': 'ask', 'children.claudeModel': 'anthropic/claude-unknown-9' },
    { childLaunch: async () => ({ env }) })
  assert.equal(service.settings.entry('children.claudeModel').value, 'anthropic/claude-unknown-9')
  t.mock.method(process.stderr, 'write', () => true)
  const state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  const runs = Object.values(state.runs)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].error, message('error.childModel', 'anthropic/claude-unknown-9'))
  assert.equal(runs[0].autoResume, false)
  assert.equal(JSON.parse(await readFile(join(cwd, 'claude-options.json'), 'utf8')).model, 'claude-unknown-9')
  assert.deepEqual(await configs(), ['model=claude-unknown-9 before the prompt'])
  // The model comes before the mode, so the refused model sends no mode.
  assert.deepEqual(await modes(), [])
  await assert.rejects(prompts(), { code: 'ENOENT' })
})

test('with children.codexModel inherit a Codex child gets no model request, and a model of the setting goes before the prompt, also in a follow-up', { timeout: 30000 }, async t => {
  // A settings.json of an earlier build has no key children.codexModel. It opens with the default inherit.
  const { service, cwd, turn, configs, modes } = await fixture(t, { 'children.agent': 'codex', 'children.permissionMode': 'ask' })
  assert.deepEqual([service.settings.entry('children.codexModel').value, service.settings.entry('children.codexModel').source],
    ['inherit', 'default'])
  const section = async () => (await service.root.agent(BACKGROUND_CONTEXT)).sections.find(item => item.key === 'settings').render()
  assert.ok((await section()).includes(message('instructions.codex', 'inherit')))
  let state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  assert.equal(Object.values(state.runs)[0].status, 'completed')
  // With inherit, the session of the Codex child gets no request that Megachat did not send before this setting.
  assert.deepEqual([await configs(), await modes()], [[], []])
  const [first] = Object.values(state.runs)
  // A change applies to the next child, also in the turn that made it. A follow-up loads its session and gets the model.
  state = await turn('second', call('agents_settings', { action: 'set', key: 'children.codexModel', value: 'openai/gpt-5.5' }),
    call('agents_send', { childSessionId: first.childSessionId, cwd, prompt: 'follow-up' }), fauxAssistantMessage('Sent.'))
  assert.deepEqual(Object.values(state.runs).map(run => run.status), ['completed', 'completed'])
  assert.deepEqual(JSON.parse(await readFile(join(cwd, 'session-request.json'), 'utf8')).operation, 'load')
  assert.ok((await section()).includes(message('instructions.codex', 'openai/gpt-5.5')))
  await turn('third', call('agents_spawn', { cwd, prompt: 'third task' }), fauxAssistantMessage('Started.'))
  // The setting does not change a Claude child. The Claude child gets only its mode.
  await turn('claude', call('agents_spawn', { cwd, agent: 'claude', prompt: 'claude task' }), fauxAssistantMessage('Started.'))
  assert.deepEqual(await configs(), ['model=gpt-5.5 before the prompt', 'model=gpt-5.5 before the prompt'])
  assert.deepEqual(await modes(), ['default before the prompt'])
})

test('a Codex model that the agent refuses fails the run before the prompt, with no continuation, and an invalid value is refused', { timeout: 20000 }, async t => {
  const env = { ...process.env, FAKE_ACP_MODELS: 'gpt-5.5' }
  const { cwd, turn, prompts, configs, service, settingsPath } = await fixture(t, { 'children.agent': 'codex', 'children.codexModel': 'openai/gpt-unknown-9' },
    { childLaunch: async () => ({ env }) })
  const tool = service.extension().tools.find(item => item.name === 'agents_settings')
  for (const value of ['gpt-5.5', 'openai/gpt-5.5[high]', 'anthropic/claude-sonnet-5-5', 'openai/gpt 5'])
    await assert.rejects(tool.execute({ action: 'set', key: 'children.codexModel', value }), { code: 'settingValue' }, value)
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).values['children.codexModel'], 'openai/gpt-unknown-9')
  t.mock.method(process.stderr, 'write', () => true)
  const state = await turn('first', call('agents_spawn', { cwd, prompt: 'first task' }), fauxAssistantMessage('Started.'))
  const runs = Object.values(state.runs)
  assert.equal(runs.length, 1)
  assert.equal(runs[0].status, 'interrupted')
  assert.equal(runs[0].error, message('error.childCodexModel', 'openai/gpt-unknown-9'))
  assert.equal(runs[0].autoResume, false)
  assert.deepEqual(await configs(), ['model=gpt-unknown-9 before the prompt'])
  await assert.rejects(prompts(), { code: 'ENOENT' })
})

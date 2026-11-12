// The project values of the settings of a child run: the store, the lookup, the tool, the rules of the main agent and a
// child run in a project. The last test opens a file with project values with the sources of v0.3.0.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { BACKGROUND_CONTEXT } from '@earendil-works/chord/context'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { AcpRunService } from '../src/AcpRunService.mjs'
import { message } from '../src/messages.mjs'
import { terminalStates } from '../src/MegachatState.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { MegachatSettings, PROJECT_SETTINGS, SETTINGS, SettingsStore } from '../src/Settings.mjs'
import { waitForState } from '../src/waitForState.mjs'

const run = promisify(execFile)
const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })
const FAST = 'faux/fast'
const DEEP = 'faux/deep'
const REPOSITORY = fileURLToPath(new URL('..', import.meta.url))

function fakeModels() {
  const fake = fauxProvider({ models: [{ id: 'fast', reasoning: true }, { id: 'deep', reasoning: true }] })
  const script = []
  fake.setResponses(Array(200).fill(() => script.shift() ?? fauxAssistantMessage('Answer.')))
  const models = createModels()
  models.setProvider(fake.provider)
  return { models, script }
}

/**
 * A temporary directory with the projects `app`, `app/server` and `lib`, the symbolic link `link` to `app`, and the
 * directory `state` for `settings.json`.
 */
async function directories(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-projects-')))
  t.after(() => rm(root, { force: true, recursive: true }))
  const paths = { root, app: join(root, 'app'), server: join(root, 'app', 'server'), lib: join(root, 'lib'), link: join(root, 'link'),
    app2: join(root, 'app2'), state: join(root, 'state') }
  for (const path of [paths.server, paths.lib, paths.app2, paths.state]) await mkdir(path, { recursive: true })
  await symlink(paths.app, paths.link)
  return { ...paths, settingsPath: join(paths.state, 'settings.json') }
}

const stored = async path => JSON.parse(await readFile(path, 'utf8'))
const seed = (path, data) => writeFile(path, JSON.stringify({ schema: 1, onboarding: 'done', values: {}, ...data }), { mode: 0o600 })

/** A service with the fake agent, the listed projects and a tool call function. */
async function open(t, paths, { settings } = {}) {
  if (settings) await seed(paths.settingsPath, settings)
  const { models, script } = fakeModels()
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: 'faux', modelId: 'fast' }, {},
    { settingsPath: paths.settingsPath, keepAlive: { enabled: false }, environment: {} })
  for (const cwd of [paths.app, paths.server, paths.lib]) await service.state.addWorkspace(cwd)
  const launched = []
  const children = new AcpRunService(service.state, { childLaunch: async agent => { launched.push(agent); return { env: process.env } } },
    { args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))], childRules: cwd => service.childRules(cwd),
      settings: cwd => service.settings.values(cwd) })
  await children.start()
  await service.resume()
  t.after(async () => { await children.close(); await service.close() })
  const tool = async args => {
    const settings = service.extension().tools.find(item => item.name === 'agents_settings')
    return JSON.parse((await settings.execute(args)).output[0].text)
  }
  const turn = async (id, ...replies) => {
    script.push(...replies)
    await service.submit(id, 'Work')
    return waitForState(service.state, state => !state.current && Object.keys(state.runs).length
      && Object.values(state.runs).every(item => terminalStates.has(item.status) && item.reported) ? state : undefined)
  }
  const section = async () => (await service.root.agent(BACKGROUND_CONTEXT)).sections.find(item => item.key === 'settings').render()
  const lines = (cwd, name) => readFile(join(cwd, name), 'utf8').then(text => text.trim().split('\n').filter(Boolean), () => [])
  return { service, tool, turn, section, lines, launched }
}

const rulesOf = values => [message('child.rules'), message(`child.rule.commit.${values.commit}`), message(`child.rule.push.${values.push}`),
  message(`child.rule.daemonRestart.${values.daemonRestart}`)].join('\n')

test('only the settings of a child run can have a project value', () => {
  assert.deepEqual(PROJECT_SETTINGS, ['children.agent', 'children.piModel', 'children.claudeModel', 'children.permissionMode',
    'children.commit', 'children.push', 'children.daemonRestart'])
  assert.ok(SETTINGS.filter(setting => !PROJECT_SETTINGS.includes(setting.key)).every(setting => !setting.key.startsWith('children.')
    || setting.key === 'children.parallel'))
})

test('a child run uses the value of the nearest project directory, else the global value, and an option wins over both', async t => {
  const paths = await directories(t)
  const { models } = fakeModels()
  const settings = new MegachatSettings(await SettingsStore.open(paths.settingsPath), { models, environment: {} })
  // Without a project value, nothing changes.
  assert.deepEqual(settings.values(paths.server), settings.values())
  await settings.set('children.commit', 'ask')
  await settings.set('children.push', 'deny', paths.link)
  await settings.set('children.agent', 'codex', paths.app)
  await settings.set('children.push', 'allow', paths.server)
  await settings.set('children.piModel', DEEP, paths.lib)
  assert.deepEqual(await stored(paths.settingsPath), { schema: 1, onboarding: 'pending', values: { 'children.commit': 'ask' }, projects: {
    [paths.app]: { 'children.push': 'deny', 'children.agent': 'codex' }, [paths.server]: { 'children.push': 'allow' }, [paths.lib]: { 'children.piModel': DEEP } } })
  const pick = values => [values['children.agent'], values['children.commit'], values['children.push'], values['children.piModel']]
  // Each key takes its nearest project directory: server has its own push, and the agent of app.
  assert.deepEqual(pick(settings.values(join(paths.server, 'src'))), ['codex', 'ask', 'allow', 'anthropic/claude-haiku-5-5'])
  assert.deepEqual(pick(settings.values(paths.server)), ['codex', 'ask', 'allow', 'anthropic/claude-haiku-5-5'])
  assert.deepEqual(pick(settings.values(paths.app)), ['codex', 'ask', 'deny', 'anthropic/claude-haiku-5-5'])
  // A path through the symbolic link is the project, and app2 is not in app.
  assert.deepEqual(pick(settings.values(paths.link)), ['codex', 'ask', 'deny', 'anthropic/claude-haiku-5-5'])
  assert.deepEqual(pick(settings.values(paths.app2)), ['claude', 'ask', 'ask', 'anthropic/claude-haiku-5-5'])
  assert.deepEqual(pick(settings.values(paths.lib)), ['claude', 'ask', 'ask', DEEP])
  assert.deepEqual(pick(settings.values()), ['claude', 'ask', 'ask', 'anthropic/claude-haiku-5-5'])
  assert.deepEqual(settings.entry('children.push', undefined, paths.server), { key: 'children.push', value: 'allow', source: 'project',
    default: 'ask', project: paths.server })
  // A setting of the daemon as a whole takes no project value, also when a file has one.
  await settings.store.change(data => { data.projects[paths.lib]['children.parallel'] = 1 })
  assert.equal(settings.values(paths.lib)['children.parallel'], 3)
  // An explicit option and an environment variable win over a project value. No setting of a run has a variable now, so
  // the option shows the order.
  const option = new MegachatSettings(settings.store, { models, environment: {}, overrides: { 'children.push': 'ask' } })
  const hidden = option.entry('children.push', undefined, paths.server)
  assert.deepEqual([hidden.value, hidden.source, hidden.project, hidden.projectHidden], ['ask', 'option', paths.server, true])
})

test('the tool sets, shows and removes a project value, and refuses a setting of the daemon and a directory that does not exist', { timeout: 20000 }, async t => {
  const paths = await directories(t)
  const { tool, section } = await open(t, paths)
  assert.equal((await section()).includes(message('instructions.projects.none')), true)
  const set = await tool({ action: 'set', key: 'children.push', value: 'deny', project: paths.link })
  assert.deepEqual([set.value, set.source, set.project, set.directory], ['deny', 'project', paths.app, paths.app])
  assert.equal((await tool({ action: 'get' })).settings.find(entry => entry.key === 'children.push').source, 'default')
  // The validation of a project value is the validation of the global value.
  await assert.rejects(tool({ action: 'set', key: 'children.push', value: 'sometimes', project: paths.app }), { code: 'settingValue' })
  await assert.rejects(tool({ action: 'set', key: 'children.agent', value: 'pi', project: paths.app }), { code: 'settingValue' })
  for (const key of ['children.parallel', 'coordinator.model', 'workday.enabled', 'reply.length', 'budget.dailyUsd', 'projects.newRoot'])
    await assert.rejects(tool({ action: 'set', key, value: '1', project: paths.app }), { code: 'settingGlobal',
      message: message('error.settingGlobal', key, PROJECT_SETTINGS.join(', ')) })
  for (const project of [join(paths.root, 'none'), 'app', '', join(paths.root, 'state', 'settings.json')])
    await assert.rejects(tool({ action: 'set', key: 'children.push', value: 'deny', project }), { code: 'settingProject' })
  await tool({ action: 'set', key: 'children.commit', value: 'ask', project: paths.app })
  await tool({ action: 'set', key: 'children.permissionMode', value: 'auto', project: paths.server })
  const described = await tool({ action: 'get' })
  assert.deepEqual(described.projects, [{ directory: paths.app, values: { 'children.push': 'deny', 'children.commit': 'ask' } },
    { directory: paths.server, values: { 'children.permissionMode': 'auto' } }])
  assert.equal(described.projectsNote, message('settings.projects.note'))
  assert.deepEqual(described.settings.filter(entry => entry.perProject).map(entry => entry.key), PROJECT_SETTINGS)
  // The rules of the main agent give each project value in one line.
  const rules = await section()
  assert.ok(rules.includes(message('instructions.projects', PROJECT_SETTINGS.join(', '))))
  assert.ok(rules.includes(message('instructions.project', paths.app, 'children.push=deny, children.commit=ask')))
  assert.ok(rules.includes(message('instructions.project', paths.server, 'children.permissionMode=auto')))
  assert.ok(!rules.includes(message('instructions.projects.none')))
  // A reset of a project value gives the value of the project that holds it, or the global value.
  await tool({ action: 'set', key: 'children.commit', value: 'deny', project: paths.server })
  const reset = await tool({ action: 'reset', key: 'children.commit', project: paths.server })
  assert.deepEqual([reset.value, reset.source, reset.project], ['ask', 'project', paths.app])
  await assert.rejects(tool({ action: 'reset', key: 'children.parallel', project: paths.app }), { code: 'settingGlobal' })
  // A directory that no longer exists keeps its values, get shows it as missing, and a reset with its path removes them.
  await rm(paths.server, { recursive: true })
  assert.deepEqual((await tool({ action: 'get' })).projects[1], { directory: paths.server, values: { 'children.permissionMode': 'auto' }, missing: true })
  await assert.rejects(tool({ action: 'reset', project: join(paths.root, 'none') }), { code: 'settingProject' })
  assert.deepEqual(await tool({ action: 'reset', project: paths.server }), { directory: paths.server, removed: ['children.permissionMode'] })
  assert.deepEqual(await tool({ action: 'reset', project: paths.app }), { directory: paths.app, removed: ['children.push', 'children.commit'] })
  // Without a project value, the file has the shape of v0.3.0 again.
  assert.deepEqual(await stored(paths.settingsPath), { schema: 1, onboarding: 'pending', values: {} })
})

test('a stored project value that this build does not accept gives the next value, and the file keeps it', { timeout: 20000 }, async t => {
  const paths = await directories(t)
  const { service, tool } = await open(t, paths, { settings: { values: { 'children.push': 'deny' },
    projects: { [paths.app]: { 'children.push': 'sometimes', 'children.commit': 'ask', 'future.key': 1 }, [paths.lib]: 'invalid' } } })
  assert.deepEqual([service.settings.values(paths.app)['children.push'], service.settings.values(paths.app)['children.commit']], ['deny', 'ask'])
  assert.deepEqual((await tool({ action: 'get' })).projects, [{ directory: paths.app, values: { 'children.commit': 'ask' },
    ignored: { 'children.push': 'sometimes', 'future.key': 1 } }])
  await tool({ action: 'set', key: 'children.agent', value: 'codex', project: paths.app })
  assert.deepEqual((await stored(paths.settingsPath)).projects, { [paths.app]: { 'children.push': 'sometimes', 'children.commit': 'ask',
    'future.key': 1, 'children.agent': 'codex' }, [paths.lib]: 'invalid' })
})

test('a child in a project gets the agent, the rules, the mode, the model and the pi model of the project', { timeout: 30000 }, async t => {
  const paths = await directories(t)
  const { service, turn, launched, lines, tool } = await open(t, paths)
  await turn('first',
    call('agents_settings', { action: 'set', key: 'children.agent', value: 'codex', project: paths.app }),
    call('agents_settings', { action: 'set', key: 'children.push', value: 'deny', project: paths.app }),
    call('agents_settings', { action: 'set', key: 'children.permissionMode', value: 'ask', project: paths.server }),
    call('agents_settings', { action: 'set', key: 'children.claudeModel', value: 'anthropic/fable', project: paths.server }),
    call('agents_settings', { action: 'set', key: 'children.piModel', value: DEEP, project: paths.lib }),
    call('agents_settings', { action: 'set', key: 'children.commit', value: 'ask' }),
    // The changes apply to the next child, also in the turn that made them.
    call('agents_spawn', { cwd: paths.app, prompt: 'app task' }), fauxAssistantMessage('Started.'))
  await turn('second', call('agents_spawn', { cwd: paths.server, agent: 'claude', prompt: 'server task' }),
    call('agents_spawn', { cwd: paths.lib, prompt: 'lib task' }), fauxAssistantMessage('Started.'))
  const runs = Object.values((await service.state.snapshot()).runs)
  assert.deepEqual(runs.map(item => [item.prompt, item.agent, item.status]), [['app task', 'codex', 'completed'],
    ['server task', 'claude', 'completed'], ['lib task', 'claude', 'completed']])
  assert.deepEqual(launched, ['codex', 'claude', 'claude'])
  const prompt = async cwd => JSON.parse((await lines(cwd, 'prompts'))[0])
  assert.equal((await prompt(paths.app))[0], rulesOf({ commit: 'ask', push: 'deny', daemonRestart: 'ask' }))
  assert.equal((await prompt(paths.server))[0], rulesOf({ commit: 'ask', push: 'deny', daemonRestart: 'ask' }))
  assert.equal((await prompt(paths.lib))[0], rulesOf({ commit: 'ask', push: 'ask', daemonRestart: 'ask' }))
  assert.deepEqual(await lines(paths.server, 'modes'), ['default before the prompt'])
  assert.deepEqual(await lines(paths.server, 'configs'), ['model=fable before the prompt'])
  assert.deepEqual([await lines(paths.lib, 'modes'), await lines(paths.lib, 'configs')], [[], []])
  // A pi child takes its model at its dispatch from the directory of the run.
  assert.deepEqual((await service.childAgent(paths.lib)).model, { provider: 'faux', modelId: 'deep' })
  assert.deepEqual((await service.childAgent(paths.app)).model, { provider: 'faux', modelId: 'fast' })
  // A follow-up uses the value at its own dispatch.
  await tool({ action: 'set', key: 'children.push', value: 'allow', project: paths.app })
  const [app] = runs
  await turn('third', call('agents_send', { childSessionId: app.childSessionId, cwd: paths.app, prompt: 'follow-up' }), fauxAssistantMessage('Sent.'))
  assert.equal(JSON.parse((await lines(paths.app, 'prompts'))[1])[0], rulesOf({ commit: 'ask', push: 'allow', daemonRestart: 'ask' }))
})

test('an automatic turn cannot change a project value', { timeout: 20000 }, async t => {
  const paths = await directories(t)
  const { service, tool } = await open(t, paths)
  for (const kind of ['report', 'event', 'morning']) {
    await service.state.change(state => { state.current = { id: kind, requestId: kind, cancelling: false, kind } })
    await assert.rejects(tool({ action: 'set', key: 'children.push', value: 'allow', project: paths.app }), { code: 'settingEvent' })
    await assert.rejects(tool({ action: 'reset', key: 'children.push', project: paths.app }), { code: 'settingEvent' })
    await service.state.change(state => { state.current = null })
  }
  await assert.rejects(readFile(paths.settingsPath, 'utf8'), { code: 'ENOENT' })
})

test('a daemon of v0.3.0 opens a settings.json with project values, ignores them, and keeps them when it writes the file', { timeout: 30000 }, async t => {
  // The sources of the tag run with the dependencies of this checkout, because package.json did not change since v0.3.0.
  const tag = await run('git', ['rev-parse', '--verify', '--quiet', 'v0.3.0^{commit}'], { cwd: REPOSITORY }).catch(() => undefined)
  if (!tag) { t.skip('The checkout has no tag v0.3.0.'); return }
  const paths = await directories(t)
  const old = join(paths.root, 'v0.3.0')
  await mkdir(old)
  await run('sh', ['-c', 'git archive v0.3.0 | tar -x -C "$1"', 'sh', old], { cwd: REPOSITORY })
  await symlink(join(REPOSITORY, 'node_modules'), join(old, 'node_modules'))
  // This build writes a project value.
  const { models } = fakeModels()
  const settings = new MegachatSettings(await SettingsStore.open(paths.settingsPath), { models, environment: {} })
  await settings.setOnboarding('done')
  await settings.set('children.push', 'deny', paths.app)
  const written = await stored(paths.settingsPath)
  // The service of v0.3.0 opens the file, gives the global values to a child in the project, and keeps the project
  // values when its tool changes a setting.
  const { PiMegachatService: OldService } = await import(pathToFileURL(join(old, 'src', 'PiMegachatService.mjs')).href)
  const lines = []
  t.mock.method(process.stderr, 'write', chunk => { lines.push(String(chunk)); return true })
  const service = await OldService.open(new MemoryStorage(), models, { provider: 'faux', modelId: 'fast' }, {},
    { settingsPath: paths.settingsPath, keepAlive: { enabled: false }, environment: {} })
  try {
    assert.equal(service.settings.onboarding, 'done')
    assert.equal(service.settings.values()['children.push'], 'ask')
    const tool = service.extension().tools.find(item => item.name === 'agents_settings')
    await tool.execute({ action: 'set', key: 'children.commit', value: 'deny' })
  }
  finally { await service.close() }
  assert.ok(!lines.some(line => /cannot read settings\.json/.test(line)), lines.join(''))
  assert.deepEqual(await stored(paths.settingsPath), { ...written, values: { 'children.commit': 'deny' } })
  // This build reads the file of v0.3.0 again with both values.
  const again = new MegachatSettings(await SettingsStore.open(paths.settingsPath), { models, environment: {} })
  assert.deepEqual([again.values(paths.app)['children.push'], again.values(paths.app)['children.commit']], ['deny', 'deny'])
})

test('a settings.json of v0.3.0 without project values opens with no project value', { timeout: 20000 }, async t => {
  const paths = await directories(t)
  const { service, tool } = await open(t, paths, { settings: { values: { 'children.push': 'deny', 'events.enabled': false } } })
  assert.deepEqual((await tool({ action: 'get' })).projects, [])
  assert.equal(service.settings.values(paths.app)['children.push'], 'deny')
})

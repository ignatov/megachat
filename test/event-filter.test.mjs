import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { PiMegachatService } from '../src/PiMegachatService.mjs'
import { DEFAULT_EVENT_IGNORE, eventMatcher, eventPatterns } from '../src/ProjectEventFilter.mjs'
import { ProjectWatchService } from '../src/ProjectWatchService.mjs'
import { waitForState } from '../src/waitForState.mjs'

const call = (name, args) => fauxAssistantMessage(fauxToolCall(name, args), { stopReason: 'toolUse' })

test('a pattern matches a name at each depth without a slash, the path from the root with a slash, and each path in a match', () => {
  const ignored = eventMatcher(DEFAULT_EVENT_IGNORE)
  for (const path of ['Kotlin.tmbundle/Syntaxes/Kotlin.json', 'plugins/textmate/lib/bundles/Java.tmbundle/info.json',
    'build/download/kotlin/lib.json', '.claude/settings.local.json']) assert.ok(ignored(path), path)
  for (const path of ['src/Main.kt', 'community/build/download/lib.json', 'build/downloads/lib.json', 'build/download.json',
    'app/.claude/settings.local.json', 'tmbundle/info.json']) assert.ok(!ignored(path), path)
  const globs = eventMatcher(['**/generated/*.kt', 'src/?.md', 'docs/**', '*.log'])
  for (const path of ['generated/A.kt', 'a/b/generated/B.kt', 'src/a.md', 'docs/x/y.md', 'deep/run.log']) assert.ok(globs(path), path)
  for (const path of ['a/generated/sub/C.kt', 'src/ab.md', 'docs.md', 'run.log.json']) assert.ok(!globs(path), path)
  assert.ok(eventMatcher(['a+b(1)'])('x/a+b(1)/y.kt'))
  assert.deepEqual(eventPatterns('a, b\nc,,a'), ['a', 'b', 'c'])
  for (const value of ['../a', 'a/./b', '/', 'x'.repeat(201)]) assert.equal(eventPatterns(value), undefined, value)
})

test('each pattern of a table matches the same paths as the earlier regular expressions', () => {
  const paths = ['Main.kt', 'src/Main.kt', 'src/app/build/Main.kt', 'build/download/lib.json', 'build/x', 'a/b', 'a/x/y/b',
    'a/xb', 'a/b/c', 'ab/b', 'a/c/b', 'x.md', 'src/x.md', 'src/a/x', 'src/ab/x', 'a-b.json', 'dir/a-b-c.json', 'abc', 'aXbYc/d',
    'x/y', 'x/a/b/y', 'x/a/y/z', 'gen/generated/A.kt', 'generated/sub/A.kt', 'a+b(1)/q', 'test/x', 'a/test', 'a/testx']
  // The results come from the matcher with regular expressions, before the matcher without backtracking.
  const table = {
    '*.kt': ['Main.kt', 'src/Main.kt', 'src/app/build/Main.kt', 'gen/generated/A.kt', 'generated/sub/A.kt'],
    'build': ['src/app/build/Main.kt', 'build/download/lib.json', 'build/x'],
    'build/download': ['build/download/lib.json'],
    '**/generated/*.kt': ['gen/generated/A.kt'],
    'src/**': ['src/Main.kt', 'src/app/build/Main.kt', 'src/x.md', 'src/a/x', 'src/ab/x'],
    'src/**.kt': ['src/Main.kt', 'src/app/build/Main.kt'],
    '**': paths,
    '***': paths,
    '*': paths,
    '**/*.json': ['build/download/lib.json', 'a-b.json', 'dir/a-b-c.json'],
    'a/**/b': ['a/b', 'a/x/y/b', 'a/b/c', 'a/c/b'],
    'a/**b': ['a/b', 'a/x/y/b', 'a/xb', 'a/b/c', 'a/c/b'],
    'a**/b': ['a/b', 'a/x/y/b', 'a/b/c', 'ab/b', 'a/c/b'],
    '?.md': ['x.md', 'src/x.md'],
    'src/?/x': ['src/a/x'],
    '*-*.json': ['a-b.json', 'dir/a-b-c.json'],
    'a*b*c': ['abc', 'aXbYc/d'],
    'x/**/**/y': ['x/y', 'x/a/b/y', 'x/a/y/z'],
    'a+b(1)': ['a+b(1)/q'],
    '**/test': ['test/x', 'a/test'],
  }
  for (const [pattern, expected] of Object.entries(table)) {
    const matches = eventMatcher(eventPatterns([pattern]))
    assert.deepEqual(paths.filter(path => matches(path)), expected, pattern)
  }
})

test('a pattern with many wildcards ends at once on a long path', () => {
  const name = `${'x-'.repeat(63)}y.txt`
  const patterns = ['**/*-*-*-*-*-*-*-*.json', '*-*-*-*-*-*-*-*.json', 'a/**/**/**/**/**/**/**/*-*-*-*-*-*.json',
    `${'*-'.repeat(99)}*`.slice(0, 200), `**${'/**'.repeat(66)}`.slice(0, 200)]
  const started = performance.now()
  for (const pattern of patterns) {
    const ignored = eventMatcher(eventPatterns([pattern]))
    for (const path of [name, `a/${name}`, `${'a/'.repeat(400)}${name}`]) ignored(path)
  }
  assert.ok(performance.now() - started < 1000, `${performance.now() - started} ms`)
  assert.ok(eventMatcher(['*-*-*.json'])(`a/${'x-'.repeat(63)}y.json`))
  assert.ok(!eventMatcher(['**/*'])(`${'a/'.repeat(1000)}b`), 'a path of more than 1024 characters does not match')
})

test('the watcher drops a path of the ignore list at each file event and reads a changed list at the next one', { timeout: 10000 }, async t => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'megachat-filter-watch-')))
  for (const directory of ['src', 'lib', 'Kotlin.tmbundle']) await mkdir(join(cwd, directory))
  const events = []
  let changed = Promise.withResolvers()
  let filter = { enabled: true, ignored: eventMatcher(DEFAULT_EVENT_IGNORE) }
  const state = {
    projectFilter: () => filter,
    async watch() { return { value: { workspaces: [cwd] }, start() {}, async stop() {} } },
    async projectChanged(event) { events.push(event.paths); changed.resolve() },
  }
  const service = new ProjectWatchService(state, { debounceMs: 50 })
  t.after(async () => { await service.close(); await rm(cwd, { force: true, recursive: true }) })
  await service.start()
  await writeFile(join(cwd, 'Kotlin.tmbundle', 'info.json'), '{}')
  await writeFile(join(cwd, 'src', 'Main.kt'), 'fun main() {}')
  await changed.promise
  assert.deepEqual(events, [['src/Main.kt']])
  changed = Promise.withResolvers()
  filter = { enabled: true, ignored: eventMatcher(['src']) }
  await writeFile(join(cwd, 'src', 'Other.kt'), 'class Other')
  await writeFile(join(cwd, 'lib', 'Lib.kt'), 'class Lib')
  await changed.promise
  assert.deepEqual(events[1], ['lib/Lib.kt'])
})

/** A service with `settings.json` in a temporary directory and one registered project. */
async function open(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-filter-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const cwd = join(directory, 'project')
  await mkdir(cwd)
  const script = []
  const requests = []
  const fake = fauxProvider()
  fake.setResponses(Array(100).fill(async context => {
    requests.push(JSON.stringify(context.messages.at(-1)))
    const reply = script.shift() ?? fauxAssistantMessage('Answer.')
    return typeof reply === 'function' ? reply() : reply
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  const model = fake.getModel()
  const settingsPath = join(directory, 'settings.json')
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { settingsPath, keepAlive: { enabled: false } })
  await service.state.addWorkspace(cwd)
  await service.resume()
  t.after(() => service.close())
  const idle = () => waitForState(service.state, state => !state.current ? state : undefined)
  const turn = async (id, ...replies) => {
    script.push(...replies)
    await service.submit(id, 'Work')
    await waitForState(service.state, state => state.inputs[id]?.status !== 'running' ? true : undefined)
    return idle()
  }
  const changed = (revision, paths) => service.state.projectChanged({ cwd, revision, paths })
  return { service, turn, changed, idle, requests, settingsPath }
}

test('the state drops the ignored paths of an event, and a changed list applies to the next event', { timeout: 20000 }, async t => {
  const { service, turn, changed, requests } = await open(t)
  // The event waits for the end of this turn. Then the event turn takes it.
  await turn('first', async () => {
    assert.deepEqual(await changed('noise', ['Kotlin.tmbundle/info.json', 'build/download/lib.json']), { accepted: false, ignored: true })
    assert.equal((await changed('mixed', ['src/Main.kt', '.claude/settings.local.json'])).notify, true)
    return call('agents_settings', { action: 'set', key: 'events.ignore', value: ['src'] })
  }, fauxAssistantMessage('Changed.'))
  const state = await waitForState(service.state, state => !state.current
    && Object.entries(state.inputs).some(([id, input]) => id.startsWith('project:') && input.status !== 'running') ? state : undefined)
  const event = requests.find(request => request.includes('A project changed.'))
  assert.match(event, /src\/Main\.kt/)
  assert.doesNotMatch(event, /settings\.local\.json/)
  assert.deepEqual(state.initiative.pending, {})
  assert.deepEqual(await changed('next', ['src/Other.kt']), { accepted: false, ignored: true })
})

test('without project events, no event reaches the conversation, and a waiting event does not come later', { timeout: 20000 }, async t => {
  const { service, turn, changed, idle, requests, settingsPath } = await open(t)
  await turn('off', async () => {
    assert.equal((await changed('waiting', ['src/Main.kt'])).notify, true)
    return call('agents_settings', { action: 'set', key: 'events.enabled', value: false })
  }, fauxAssistantMessage('Off.'))
  const count = requests.length
  // The event pump looks at the waiting event after the turn, and it drops the event.
  let state = await waitForState(service.state, state => !state.current && !Object.keys(state.initiative.pending).length ? state : undefined)
  assert.ok(!Object.keys(state.inputs).some(id => id.startsWith('project:')))
  assert.deepEqual(await changed('ignored', ['src/Other.kt']), { accepted: false, ignored: true })
  await turn('on', call('agents_settings', { action: 'set', key: 'events.enabled', value: true }), fauxAssistantMessage('On.'))
  state = await idle()
  assert.equal(requests.length, count + 2)
  assert.ok(!requests.some(request => request.includes('src/Main.kt') || request.includes('src/Other.kt')))
  assert.ok(!Object.keys(state.inputs).some(id => id.startsWith('project:')))
  assert.equal(JSON.parse(await readFile(settingsPath, 'utf8')).values['events.enabled'], true)
})

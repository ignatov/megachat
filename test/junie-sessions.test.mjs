// The sessions of Junie: the source of `~/.junie/sessions`, the entries and the steps of an event log, the status of a
// session that waits, and the session tools with the agent junie. The fixtures have the shapes of the event log of
// Junie CLI 26.10.5 (see the design of the change `junie-sessions`) and invented texts.

import assert from 'node:assert/strict'
import * as fsp from 'node:fs/promises'
import { appendFile, mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { JunieSessionSource } from '../src/JunieSessionSource.mjs'
import { message } from '../src/messages.mjs'
import { RunningAgents } from '../src/RunningAgents.mjs'
import { SessionCatalog } from '../src/SessionCatalog.mjs'
import { SessionHistoryService } from '../src/SessionHistoryService.mjs'
import { SessionIndex } from '../src/SessionIndex.mjs'
import { SessionIndexService } from '../src/SessionIndexService.mjs'
import { SMALL_FILE_FLAGS } from '../src/SessionLog.mjs'
import { sessionSources } from '../src/SessionSources.mjs'
import { sessionStatus } from '../src/SessionStatus.mjs'
import { SOURCE_TEXT_LIMIT } from '../src/SessionText.mjs'

const MINUTE = 60000
const HOUR = 60 * MINUTE
const NOW = Date.parse('2026-11-11T12:00:00Z')
const ON = { 'sessions.index': 'on', 'sessions.days': 180 }
const ID = 'session-260101-120000-abcd'
const STEP = '11111111-2222-4333-8444-555555555555'
const AGENT = { id: 'main', kind: 'MAIN', name: 'Junie', type: 'main' }

/** The lines of an event log of Junie. A `SessionA2uxEvent` holds the state of the session and an event of the agent. */
const agentEvent = (state, kind, fields = {}) => ({ kind: 'SessionA2uxEvent', taskId: 'task-1', event: { state, agentEvent: { kind, agent: AGENT, ...fields } } })
const junie = {
  prompt: (text, requestId = `request-${text.length}-${text.slice(0, 8)}`) => ({ kind: 'UserPromptEvent', requestId, prompt: text, presentablePrompt: text,
    customAttachments: [], extraAttachments: [], requiresConfirmation: false }),
  response: text => ({ kind: 'UserResponseEvent', prompt: text }),
  answer: (question, answer) => ({ kind: 'UserAsyncResponseEvent', entries: [{ question, answer }] }),
  started: () => ({ kind: 'TaskStartedEvent', taskId: 'task-1' }),
  ended: (state = 'COMPLETED') => ({ kind: 'TaskState', state }),
  cancel: () => ({ kind: 'CancelAgentEvent' }),
  command: (status, { state = 'IN_PROGRESS', command = 'npm test', output, approval = false, stepId = STEP } = {}) => agentEvent(state, 'TerminalBlockUpdatedEvent',
    { stepId, status, command, ...(output === undefined ? {} : { output, presentableOutput: output }), ...(approval ? { approvalRequest: { id: 'approval-1' } } : {}) }),
  tool: (status, text, output, stepId) => agentEvent('IN_PROGRESS', 'ToolBlockUpdatedEvent', { stepId, status, text, details: '', toolType: 'SEARCH', ...(output ? { output } : {}) }),
  view: (status, files, stepId) => agentEvent('IN_PROGRESS', 'ViewFilesBlockUpdatedEvent', { stepId, status, details: 'Opened the files', files: files.map(relativePath => ({ relativePath })) }),
  changes: (status, files, stepId) => agentEvent('IN_PROGRESS', 'FileChangesBlockUpdatedEvent', { stepId, status, details: 'Changed the files',
    changes: files.map(afterRelativePath => ({ afterRelativePath, afterContent: { kind: 'text', text: 'the secret content of a file' } })) }),
  mcp: (status, toolName, input, stepId) => agentEvent('IN_PROGRESS', 'McpBlockUpdatedEvent', { stepId, status, toolName, input, details: 'A call of an MCP tool' }),
  result: (text, { state = 'COMPLETED', title = '', stepId = `result-${text.length}` } = {}) => agentEvent(state, 'ResultBlockUpdatedEvent', { stepId, cancelled: false, result: text, title, changes: [], errorCode: 'NONE' }),
  markdown: (text, stepId = `markdown-${text.length}`) => agentEvent('IN_PROGRESS', 'MarkdownBlockUpdatedEvent', { stepId, text }),
  thought: text => agentEvent('IN_PROGRESS', 'AgentThoughtBlockUpdatedEvent', { stepId: 'thought-1', text, thoughtType: 'THINKING' }),
  ask: (state = 'INPUT_REQUIRED', status = 'IN_PROGRESS') => agentEvent(state, 'AskAsyncRequestUpdatedEvent', { stepId: 'ask-1', status, title: 'A question',
    request: { id: 'ask-1', name: 'branch', question: 'Which branch?', options: [{ id: 'a', title: 'main', description: '' }], allowMultiple: false, isRequired: true } }),
  tip: (state = 'INPUT_REQUIRED') => agentEvent(state, 'TipSuggestionCreatedEvent', { id: 'tip-1', description: 'A tip for the user' }),
  status: (state = 'IN_PROGRESS') => agentEvent(state, 'AgentCurrentStatusUpdatedEvent', { status: 'Sending LLM request' }),
  usage: (state = 'IN_PROGRESS') => agentEvent(state, 'LlmResponseMetadataEvent', { modelUsage: [{ model: 'a-model', outputTokens: 5 }] }),
  name: name => agentEvent('IN_PROGRESS', 'AgentTaskNameUpdatedEvent', { name }),
  directory: currentDirectory => agentEvent('IN_PROGRESS', 'CurrentDirectoryUpdatedEvent', { currentDirectory }),
}

async function temporary(t) {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'megachat-junie-sessions-')))
  t.after(() => rm(home, { force: true, recursive: true }))
  await mkdir(join(home, 'state'))
  return home
}

const sessionsOf = home => join(home, '.junie', 'sessions')
const logOf = (home, id = ID) => join(sessionsOf(home), id, 'events.jsonl')
const lineOf = (value, time) => `${JSON.stringify({ ...value, timestampMs: time })}\n`

/**
 * Writes a session folder of Junie: the event log, with one line each second from [start], and `summary.json` when
 * [summary] gives the project directory and the task name. [mtime] sets the time of the last write of the log.
 */
async function junieSession(home, id, lines, { summary, mtime, start = NOW - HOUR } = {}) {
  const path = logOf(home, id)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, lines.map((value, index) => lineOf(value, start + index * 1000)).join(''))
  await writeFile(join(dirname(path), 'transcript.md'), '# A transcript\n')
  if (summary) await writeFile(join(dirname(path), 'summary.json'), JSON.stringify({ sessionId: id, createdAt: start, updatedAt: start + lines.length * 1000,
    lifecycle: 'ACTIVE', mainAgent: { modelUsage: [] }, ...summary }))
  if (mtime !== undefined) await utimes(path, new Date(mtime), new Date(mtime))
  return path
}

/** Adds a line of a session to `index.jsonl` of Junie. */
async function junieIndexLine(home, sessionId, projectDir, { taskName = 'A task', createdAt = NOW - HOUR, updatedAt = NOW - HOUR } = {}) {
  await mkdir(sessionsOf(home), { recursive: true })
  await appendFile(join(sessionsOf(home), 'index.jsonl'), `${JSON.stringify({ sessionId, createdAt, updatedAt, projectDir, taskName })}\n`)
}

/** A file system that records each open with its flags. */
function recordingFs() {
  const opens = []
  return { opens, readdir: fsp.readdir, stat: fsp.stat, open: (path, flags, ...rest) => { opens.push([String(path), flags]); return fsp.open(path, flags, ...rest) } }
}

const fakeClock = (time = NOW) => ({ time, value: time, now() { return this.time } })
const stillTimers = { setInterval: () => undefined, clearInterval() {} }

/** A live table of the session files of [home] on its own `sessions.sqlite`. */
async function catalogOf(t, home, { fs = fsp, clock = fakeClock() } = {}) {
  const index = await SessionIndex.open(join(home, 'state', 'sessions.sqlite'))
  const catalog = new SessionCatalog({ index, sources: sessionSources({ home, environment: {} }), fs, clock, timers: stillTimers })
  let closed = false
  catalog.shut = async () => { if (closed) return; closed = true; await catalog.close(); await index.close() }
  t.after(() => catalog.shut())
  await catalog.start()
  await catalog.idle()
  return { catalog, index, clock }
}

function fakeState({ workspaces = [] } = {}) {
  const value = { megachatWorkspace: null, workspaces, projects: [], runs: {} }
  return { snapshot: async () => value, watch: async () => ({ value, start() {}, stop: async () => {} }),
    sessionsTask: async () => {}, sessionsIndexed: async () => {}, sessionsOff: async () => {} }
}

/** An index service of the sessions of [home], with the listed directories [workspaces]. */
async function indexOf(t, home, workspaces, { fs } = {}) {
  const state = fakeState({ workspaces })
  const index = new SessionIndexService({ path: join(home, 'state', 'sessions.sqlite'), state, home, environment: {}, clock: fakeClock(), debounceMs: 10,
    watch: () => ({ close() {}, on() {} }), catalog: { fs: fsp, timers: stillTimers }, ...(fs ? { fs } : {}) })
  t.after(() => index.close())
  await index.apply(ON)
  await index.idle()
  return { index, state }
}

const parseAll = (source, lines, path = '/home/user/.junie/sessions/session-260101-120000-abcd/events.jsonl') =>
  lines.map((value, index) => source.parse({ ...value, timestampMs: NOW + index * 1000 }, lineOf(value, NOW + index * 1000), path))
const stepsOf = (source, lines) => {
  let step
  return parseAll(source, lines).map(parsed => (step = parsed.step ?? step))
}

test('the source of Junie gives the event log of each session folder, with the name of the folder as the session ID', async t => {
  const home = await temporary(t)
  await junieSession(home, ID, [junie.prompt('Run the tests')])
  // A folder without an event log, and each other file of the folder of the sessions, is no session file.
  await mkdir(join(sessionsOf(home), 'session-260101-130000-efgh'))
  await writeFile(join(sessionsOf(home), 'session-260101-130000-efgh', 'transcript.md'), '# A transcript\n')
  await writeFile(join(sessionsOf(home), 'index.jsonl'), '')
  const source = sessionSources({ home, environment: {} }).find(item => item.agent === 'junie')
  assert.ok(source instanceof JunieSessionSource)
  assert.equal(source.root, sessionsOf(home))
  assert.deepEqual(await source.all(fsp), [{ path: logOf(home) }])
  assert.deepEqual(await source.files([{ cwd: '/work/demo-app' }], fsp), [{ path: logOf(home) }])
  assert.equal(source.nameId(logOf(home)), ID)
  assert.deepEqual([`${ID}/events.jsonl`, `${ID}/transcript.md`, 'index.jsonl', 'events.jsonl', `${ID}/task-1/events.jsonl`].map(path => source.matches(path)),
    [true, false, false, false, false])
  assert.equal(source.relevant(`${ID}/events.jsonl`, []), true)
  assert.equal(source.relevant('agent-workbench-archive-state.jsonl', []), false)
  // The live table and the index open each file of Junie read-only.
  const fs = recordingFs()
  const { catalog } = await catalogOf(t, home, { fs })
  assert.equal(catalog.session('junie', ID)?.read, true)
  assert.ok(fs.opens.length > 0)
  assert.deepEqual(fs.opens.filter(([, flags]) => flags !== 'r' && flags !== SMALL_FILE_FLAGS), [])
  assert.deepEqual([...new Set(fs.opens.map(([path]) => path.slice(sessionsOf(home).length + 1)))].sort(), ['index.jsonl', `${ID}/events.jsonl`, `${ID}/summary.json`])
})

test('the project directory and the title of a Junie session come from summary.json, else from the index of Junie, and not from the log', async t => {
  const home = await temporary(t)
  // The directory of the summary: the log names a directory above the project, and the summary names the project.
  await junieSession(home, ID, [junie.prompt('Fix the parser now'), junie.directory('/work'), junie.result('The parser works.')],
    { summary: { projectDir: '/work/demo-app', taskName: 'Fix the parser' } })
  // The directory of the index of Junie: a folder without a summary. The newest line of the session counts.
  await junieSession(home, 'session-260101-130000-efgh', [junie.prompt('Write the notes'), junie.result('The notes are there.')])
  await junieIndexLine(home, 'session-260101-130000-efgh', '/work/old-notes', { updatedAt: NOW - 3 * HOUR })
  await junieIndexLine(home, 'session-260101-130000-efgh', '/work/demo-notes/', { taskName: 'Write the notes', updatedAt: NOW - 2 * HOUR })
  await junieIndexLine(home, 'session-260101-999999-zzzz', '/work/other')
  // A session without a directory: neither file names it.
  await junieSession(home, 'session-260101-140000-ijkl', [junie.prompt('A lost task'), junie.directory('/work/demo-app'), junie.result('Done.')])
  // The summary of Junie keeps the first name of the task. A later name in the log is a newer title of the agent.
  await junieSession(home, 'session-260101-150000-mnop', [junie.prompt('Start'), junie.name('The first name'), junie.result('Done.'), junie.ended(),
    junie.prompt('Go on'), junie.name('A later name'), junie.result('Done again.'), junie.ended()], { summary: { projectDir: '/work/renamed', taskName: 'The first name' } })
  const source = new JunieSessionSource({ home })
  assert.deepEqual(await source.describe(logOf(home), fsp), { sessionId: ID, cwd: '/work/demo-app', startedAt: NOW - HOUR, title: 'Fix the parser',
    titleRank: 2, updatedAt: NOW - HOUR + 3000 })
  assert.deepEqual(await source.describe(logOf(home, 'session-260101-140000-ijkl'), fsp), { sessionId: 'session-260101-140000-ijkl' })
  const { catalog } = await catalogOf(t, home)
  const rows = Object.fromEntries([...catalog.of('junie')].map(record => [record.sessionId, [record.cwd, record.title, record.startedAt]]))
  assert.deepEqual(rows, {
    [ID]: ['/work/demo-app', 'Fix the parser', NOW - HOUR],
    'session-260101-130000-efgh': ['/work/demo-notes', 'Write the notes', NOW - HOUR],
    'session-260101-140000-ijkl': [undefined, undefined, NOW - HOUR],
    'session-260101-150000-mnop': ['/work/renamed', 'A later name', NOW - HOUR],
  })
  await catalog.shut()
  // The index holds the sessions of the listed directories, and no entry of the session without a directory.
  const { index } = await indexOf(t, home, ['/work/demo-app', '/work/demo-notes'])
  const listed = async cwd => (await index.store.list('junie', cwd)).sessions.map(session => [session.sessionId, session.title])
  assert.deepEqual(await listed('/work/demo-app'), [[ID, 'Fix the parser']])
  assert.deepEqual(await listed('/work/demo-notes'), [['session-260101-130000-efgh', 'Write the notes']])
  assert.equal((await index.store.search('junie', '/work/demo-app', ['lost'])).hits.length, 0)
  assert.equal((await index.store.counts()).entries, 4)
  // A later name of the task in the log is a newer title of the agent.
  await appendFile(logOf(home), lineOf(junie.name('Fix the parser and its tests'), NOW))
  await index.catchUp('/work/demo-app')
  assert.deepEqual(await listed('/work/demo-app'), [[ID, 'Fix the parser and its tests']])
})

test('the event log of Junie gives a user entry, one tool entry for a block that Junie writes again, and an assistant entry', async t => {
  const source = new JunieSessionSource({ home: '/home/user' })
  // A turn with a command: the block comes three times, and again after the end of the turn.
  const turn = [junie.prompt('Run the tests', 'request-1'), junie.started(), junie.command('IN_PROGRESS'), junie.command('IN_PROGRESS', { output: 'one test' }),
    junie.command('COMPLETED', { output: 'one test\n2 tests pass' }), junie.thought('The tests pass, so the work is done.'), junie.status(), junie.usage(),
    junie.result('The tests pass.'), junie.command('COMPLETED', { state: 'COMPLETED', output: 'one test\n2 tests pass' }), junie.ended(), junie.tip('COMPLETED')]
  const entries = parseAll(source, turn).map(parsed => parsed.entry).filter(Boolean)
  assert.deepEqual(entries.map(entry => [entry.key, entry.role, entry.tool, entry.text, entry.timestamp]), [
    ['request-1', 'user', undefined, 'Run the tests', NOW],
    [STEP, 'tool', 'result', 'npm test\none test\n2 tests pass', NOW + 4000],
    ['result-15', 'assistant', undefined, 'The tests pass.', NOW + 8000],
    [STEP, 'tool', 'result', 'npm test\none test\n2 tests pass', NOW + 9000],
  ])
  // An answer to a question, an answer to a permission request, and a prompt without a request ID.
  const answers = parseAll(source, [junie.answer('Which branch?', 'main'), junie.response('Yes'), { ...junie.prompt('A shown text'), requestId: null, prompt: 'A long text of the model' }])
  assert.deepEqual(answers.map(parsed => [parsed.entry.role, parsed.entry.text, parsed.step]), [['user', 'Which branch?\nmain', 'prompt'], ['user', 'Yes', 'prompt'],
    ['user', 'A shown text', 'prompt']])
  assert.ok(answers.every(parsed => /^[\w-]{32}$/.test(parsed.entry.key)))
  // Each other ended block gives a tool entry. A change of a file names its path and not its content.
  const blocks = parseAll(source, [junie.tool('COMPLETED', 'Searched "parser"', '3 matches', 's1'), junie.view('COMPLETED', ['src/parser.mjs', 'README.md'], 's2'),
    junie.changes('COMPLETED', ['src/parser.mjs'], 's3'), junie.mcp('COMPLETED', 'issue_read', '{"id":"DEMO-7"}', 's4'), junie.tool('IN_PROGRESS', 'Searching', undefined, 's5'),
    junie.command('FAILED', { command: 'npm run lint', output: 'a lint error', stepId: 's6' }), junie.markdown('A text block.', 's7')])
  assert.deepEqual(blocks.map(parsed => parsed.entry && [parsed.entry.key, parsed.entry.role, parsed.entry.text]), [
    ['s1', 'tool', 'Searched "parser"\n3 matches'], ['s2', 'tool', 'Opened the files\nsrc/parser.mjs\nREADME.md'], ['s3', 'tool', 'Changed the files\nsrc/parser.mjs'],
    ['s4', 'tool', 'issue_read {"id":"DEMO-7"}\nA call of an MCP tool'], undefined, ['s6', 'tool', 'npm run lint\na lint error'], ['s7', 'assistant', 'A text block.']])
  // A line that the parser does not know, and a block without a step ID, give no entry and no error.
  assert.deepEqual(parseAll(source, [{ kind: 'SessionModelEffortSetEvent', modelId: 'a-model' }, { kind: 'SessionA2uxEvent' }, { kind: 'NewEvent', text: 'x' },
    agentEvent('IN_PROGRESS', 'TerminalBlockUpdatedEvent', { status: 'COMPLETED', command: 'ls' })]).map(parsed => parsed.entry), [undefined, undefined, undefined, undefined])
  // The index keeps one entry of a key, so the session has three entries.
  const home = await temporary(t)
  await junieSession(home, ID, turn, { summary: { projectDir: '/work/demo-app', taskName: 'Run the tests' } })
  const { index } = await indexOf(t, home, ['/work/demo-app'])
  const session = await index.store.session('junie', '/work/demo-app', ID)
  const page = await index.store.entries(session.id)
  assert.deepEqual(page.entries.map(entry => [entry.role, entry.tool ?? undefined, entry.text]), [['user', undefined, 'Run the tests'],
    ['tool', 'result', 'npm test\none test\n2 tests pass'], ['assistant', undefined, 'The tests pass.']])
})

test('a tool entry of Junie has the size limit of an entry, and a copy of a block in a fork is the same entry', async t => {
  const home = await temporary(t)
  const output = 'o'.repeat(300000)
  // The line of the ended block has more than 400,000 bytes, and the reader still gives it.
  const long = junie.command('COMPLETED', { output: `${output}${'p'.repeat(100000)}` })
  assert.ok(lineOf(long, NOW).length > 400000)
  const source = new JunieSessionSource({ home })
  const [parsed] = parseAll(source, [junie.command('COMPLETED', { output })])
  assert.equal(parsed.entry.text.length, SOURCE_TEXT_LIMIT)
  assert.ok(parsed.entry.text.startsWith('npm test\nooooo'))
  const lines = [junie.prompt('Run the tests', 'request-1'), junie.command('IN_PROGRESS'), long, junie.result('The tests pass.')]
  await junieSession(home, ID, lines, { summary: { projectDir: '/work/demo-app', taskName: 'Run the tests' } })
  // A fork: a second folder holds the same prompt and the same ended block with the same step ID, and its own reply.
  await junieSession(home, 'session-260101-130000-fork', [...lines.slice(0, 3), junie.result('The fork has its own reply.')],
    { summary: { projectDir: '/work/demo-app', taskName: 'Run the tests in a fork' } })
  const { index } = await indexOf(t, home, ['/work/demo-app'])
  const found = await index.store.search('junie', '/work/demo-app', ['npm', 'test'])
  assert.equal(found.hits.length, 1, 'One entry of the block')
  assert.ok(found.hits[0].entry.text.startsWith('npm test\nooooo'))
  assert.ok(found.hits[0].entry.text.length < 300000)
  // The prompt, the block and the two replies.
  assert.equal((await index.store.counts()).entries, 4)
  assert.equal((await index.store.search('junie', '/work/demo-app', ['fork', 'reply'])).hits.length, 1)
})

test('the steps of a Junie session follow the state of its events, and a wait gives the step permission or question', () => {
  const source = new JunieSessionSource({ home: '/home/user' })
  // The steps of a turn.
  assert.deepEqual(stepsOf(source, [junie.prompt('Run the tests'), junie.command('IN_PROGRESS'), junie.result('The tests pass.'), junie.ended()]),
    ['prompt', 'open', 'reply', 'end'])
  // A permission and its answer: a tip in the state of the wait changes no step.
  assert.deepEqual(stepsOf(source, [junie.command('IN_PROGRESS'), junie.command('IN_PROGRESS', { state: 'INPUT_REQUIRED', approval: true }), junie.tip(),
    junie.command('IN_PROGRESS')]), ['open', 'permission', 'permission', 'open'])
  // A question.
  assert.deepEqual(stepsOf(source, [junie.ask(), junie.answer('Which branch?', 'main')]), ['question', 'prompt'])
  // Each other line in the state of the wait tells nothing about the wait.
  assert.deepEqual(stepsOf(source, [junie.ask(), junie.tip(), junie.status('INPUT_REQUIRED'), junie.usage('INPUT_REQUIRED'), junie.ask(),
    junie.command('IN_PROGRESS', { state: 'INPUT_REQUIRED' })]), ['question', 'question', 'question', 'question', 'question', 'question'])
  // An answer to a permission request is a message of the user. A refused command and the rest of the turn follow.
  assert.deepEqual(stepsOf(source, [junie.command('IN_PROGRESS', { state: 'INPUT_REQUIRED', approval: true }), junie.response('No'), junie.status(),
    junie.command('REJECTED'), junie.result('The command did not run.', { state: 'IN_PROGRESS' }), junie.status(), junie.result('The command did not run.'),
    junie.status('COMPLETED'), junie.ended()]), ['permission', 'prompt', 'open', 'open', 'reply', 'open', 'reply', 'end', 'end'])
  // A cancel and a cancelled turn end the turn. A question that Junie cancelled itself is no wait.
  assert.deepEqual(stepsOf(source, [junie.ask(), junie.cancel(), junie.ask('IN_PROGRESS', 'COMPLETED'), junie.ended('CANCELED')]), ['question', 'end', 'open', 'end'])
  // A line of the start of a task, a line without a state, and a line that the parser does not know change no step.
  assert.deepEqual(stepsOf(source, [junie.prompt('Go'), junie.started(), { kind: 'SessionModelEffortSetEvent' }, { kind: 'UserMessagesCommittedToHistory' },
    { kind: 'SessionA2uxEvent', event: {} }]), ['prompt', 'prompt', 'prompt', 'prompt', 'prompt'])
  // The step has the time of its line, so a reader knows the start of a wait.
  const [waiting, tip] = parseAll(source, [junie.command('IN_PROGRESS', { state: 'INPUT_REQUIRED', approval: true }), junie.tip()])
  assert.deepEqual([waiting.step, waiting.stepAt, tip.step, tip.stepAt], ['permission', NOW, undefined, undefined])
})

const proc = (pid, ppid, command, { startedAt = NOW - HOUR, name = command.split(' ', 1)[0].split('/').pop() } = {}) => ({ pid, ppid, startedAt, cpu: 0, name, command })
const JUNIE = '/Users/user/.local/share/junie/versions/3579.7/Applications/junie.app/Contents/MacOS/junie'
/** A process table with a terminal that owns each process with the parent PID 2. */
function fakeTable(processes, resolved) {
  return { platform: 'darwin', supported: true,
    async processes() { return [proc(1, 0, '/sbin/launchd'), proc(2, 1, '/Applications/iTerm.app/Contents/MacOS/iTerm2', { name: 'iTerm2' }), ...processes] },
    async resolve(pids) { return new Map(pids.map(pid => [pid, { cwd: resolved[pid] ?? null, files: [] }])) } }
}
const viewOf = (catalog, table, clock) => new RunningAgents({ snapshot: async () => ({ runs: {} }) }, { table, clock, daemonPid: 900, logs: () => catalog }).view()

test('a Junie session that waits for a permission or for an answer keeps that status at each age of the last write', async t => {
  const home = await temporary(t)
  const start = NOW - HOUR
  const summary = cwd => ({ projectDir: cwd, taskName: `A task of ${cwd.slice(6)}` })
  // A permission for 20 minutes: the log ends with a command block with an approval request.
  await junieSession(home, 'session-260101-120000-perm', [junie.prompt('Remove the old files'), junie.command('IN_PROGRESS', { command: 'rm -r build' }),
    junie.command('IN_PROGRESS', { state: 'INPUT_REQUIRED', approval: true, command: 'rm -r build' })], { summary: summary('/work/permission'), start, mtime: NOW - 20 * MINUTE })
  // A question for 40 minutes: Junie wrote tips after the question, and the last one 40 minutes ago.
  await junieSession(home, 'session-260101-120000-ask0', [junie.prompt('Merge the branch'), junie.ask(), junie.tip(), junie.tip()],
    { summary: summary('/work/question'), start, mtime: NOW - 40 * MINUTE })
  // An answered permission: the same block in the state of the work again, 1 minute ago.
  await junieSession(home, 'session-260101-120000-done', [junie.prompt('Remove the old files'), junie.command('IN_PROGRESS', { state: 'INPUT_REQUIRED', approval: true }),
    junie.response('Yes'), junie.command('IN_PROGRESS')], { summary: summary('/work/answered'), start, mtime: NOW - MINUTE })
  // An open step without a write for 20 minutes is stuck, and a finished turn without a write for 40 minutes is idle.
  await junieSession(home, 'session-260101-120000-open', [junie.prompt('Run the tests'), junie.command('IN_PROGRESS')], { summary: summary('/work/open'), start, mtime: NOW - 20 * MINUTE })
  await junieSession(home, 'session-260101-120000-idle', [junie.prompt('Run the tests'), junie.result('The tests pass.'), junie.ended()],
    { summary: summary('/work/idle'), start, mtime: NOW - 40 * MINUTE })
  const { catalog, index, clock } = await catalogOf(t, home)
  const recordOf = id => catalog.session('junie', `session-260101-120000-${id}`)
  assert.deepEqual(['perm', 'ask0', 'done', 'open', 'idle'].map(id => [recordOf(id).step, sessionStatus(recordOf(id), NOW)]),
    [['permission', 'waiting_for_permission'], ['question', 'waiting_for_user'], ['open', 'working'], ['open', 'stuck'], ['end', 'idle']])
  // The start of a wait is the time of its event, not the last write: Junie writes a tip every half minute.
  assert.deepEqual([recordOf('perm').stepAt, recordOf('ask0').stepAt], [start + 2000, start + 1000])
  // Each session has a process in a terminal that started with its log, so each row gets its log and its status.
  const table = fakeTable(['perm', 'ask0', 'done', 'open', 'idle'].map((id, index) => proc(10 + index, 2, `${JUNIE} --skip-update-check`, { startedAt: start, name: 'junie' })),
    { 10: '/work/permission', 11: '/work/question', 12: '/work/answered', 13: '/work/open', 14: '/work/idle' })
  const view = await viewOf(catalog, table, clock)
  assert.deepEqual(view.rows.map(row => [row.pid, row.agent, row.sessionId.slice(-4), row.status, row.statusSince, row.parent.kind]).sort(), [
    [10, 'junie', 'perm', 'waiting_for_permission', start + 2000, 'terminal'], [11, 'junie', 'ask0', 'waiting_for_user', start + 1000, 'terminal'],
    [12, 'junie', 'done', 'working', null, 'terminal'], [13, 'junie', 'open', 'stuck', NOW - 20 * MINUTE, 'terminal'], [14, 'junie', 'idle', 'idle', null, 'terminal']])
  assert.equal(view.rows.find(row => row.pid === 10).title, 'A task of permission')
  // A later tip moves the last write and not the start of the wait.
  await appendFile(logOf(home, 'session-260101-120000-perm'), lineOf(junie.tip(), NOW))
  await catalog.read(logOf(home, 'session-260101-120000-perm'))
  assert.deepEqual([recordOf('perm').step, recordOf('perm').stepAt, Math.floor(recordOf('perm').mtimeMs) > NOW - MINUTE], ['permission', start + 2000, true])
  // The table keeps the step across a restart, and it reads the time of a wait again.
  await catalog.shut()
  const again = await catalogOf(t, home)
  const record = again.catalog.session('junie', 'session-260101-120000-perm')
  assert.deepEqual([record.step, record.stepAt, record.cwd], ['permission', start + 2000, '/work/permission'])
  void index
})

/** A history service with the index of [home] and stand-ins of the live sources of Claude Code and Codex. */
function historyOf(state, index) {
  const none = { list: async () => ({ sessions: [], nextCursor: null }), read: async () => { throw new Error('none') }, close() {} }
  return new SessionHistoryService(state, { claude: none, codex: none }, index)
}

test('the session tools find and read a Junie session through the index and the log, and without the index a request for Junie fails with its text', async t => {
  const home = await temporary(t)
  const project = join(home, 'work', 'demo-app')
  await mkdir(project, { recursive: true })
  const turn = [junie.prompt('Run the tests', 'request-1'), junie.command('IN_PROGRESS'), junie.command('COMPLETED', { output: '2 tests pass' }),
    junie.result('The tests pass.', { state: 'IN_PROGRESS' }), junie.command('COMPLETED', { state: 'COMPLETED', output: '2 tests pass' }), junie.result('The tests pass.'), junie.ended()]
  await junieSession(home, ID, turn, { summary: { projectDir: project, taskName: 'Run the tests' } })
  // Junie without the index.
  const off = historyOf(fakeState({ workspaces: [project] }), undefined)
  const text = 'The index of past sessions is off, so Megachat cannot read Junie sessions. Only the user can turn it on, with the setting sessions.index.'
  assert.equal(message('error.sessionsIndexOff', 'Junie'), text)
  await assert.rejects(off.search({ cwd: project, agent: 'junie' }), { code: 'sessionsIndexOff', message: text })
  await assert.rejects(off.read({ cwd: project, agent: 'junie', sessionId: ID }), { code: 'sessionsIndexOff', message: text })
  assert.deepEqual((await off.search({ cwd: project })).pages.map(page => page.agent), ['claude', 'codex'])
  // A search for a reply of Junie, without an agent.
  const { index, state } = await indexOf(t, home, [project])
  const sessions = historyOf(state, index)
  const found = await sessions.search({ cwd: project, query: 'tests pass' })
  const page = found.pages.find(item => item.agent === 'junie')
  assert.deepEqual([page.source, page.matches.length, page.matches[0].sessionId, page.matches[0].title], ['index', 1, ID, 'Run the tests'])
  assert.match(page.matches[0].text, /tests pass/)
  assert.deepEqual((await sessions.search({ cwd: project, agent: 'junie' })).pages[0].matches.map(match => match.sessionId), [ID])
  // A read of the session from the index: one entry of each key.
  const read = await sessions.read({ cwd: project, agent: 'junie', sessionId: ID })
  assert.deepEqual([read.source, read.entries.map(entry => entry.text)], ['index', ['Run the tests', 'npm test\n2 tests pass', 'The tests pass.']])
  // A read from the end: the last entries of the event log, each key one time, in the order of the log.
  const newest = await sessions.readNewest({ agent: 'junie', sessionId: ID })
  assert.deepEqual([newest.source, newest.order, newest.session.cwd, newest.session.title], ['log', 'newest', project, 'Run the tests'])
  assert.deepEqual(newest.entries.map(entry => [entry.role, entry.text]), [['user', 'Run the tests'], ['tool', 'npm test\n2 tests pass'], ['assistant', 'The tests pass.']])
  assert.deepEqual((await sessions.readNewest({ agent: 'junie', sessionId: ID, limit: 1 })).entries.map(entry => entry.text), ['The tests pass.'])
  // A session of another directory is not in the listed directory.
  await assert.rejects(sessions.read({ cwd: project, agent: 'junie', sessionId: 'session-260101-999999-zzzz' }), { code: 'missing' })
})

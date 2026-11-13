#!/usr/bin/env node
// The live smoke run: the daemon of this checkout with the real main agent through Central, real Claude, Codex and pi
// children, and a scripted ACP client that sends what Air sends. Each scenario has its own temporary state home and its
// own throwaway projects. The run costs real money. See the section about the live smoke run in `README.md`.
//
// Usage: node test/live/smoke.mjs [<scenario>[:<item>,<item>...]...]
// The scenarios are chat, suggest, rules, permissions, tasks, steer, others, workday, restart, twotools, withdraw,
// waiting, failures and processes. Without a name, all of them run. The items after a colon select the items of the
// scenarios failures and processes by their numbers, for example `failures:14.3b,14.4c`.
import { execFile, spawn } from 'node:child_process'
import { existsSync, realpathSync } from 'node:fs'
import { chmod, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  assertTemporary, daemonEnvironment, daemonOf, delay, LEASE, leaks, LiveClient, loadSecrets, makeHome, makeProject, makeRoot,
  redact, replies, stopDaemon, suggestions, writeSettings,
} from './live-client.mjs'

const { terminalStates } = await import(join(LEASE, 'src', 'MegachatState.mjs'))
const { message } = await import(join(LEASE, 'src', 'messages.mjs'))
const SCENARIOS = ['chat', 'suggest', 'rules', 'permissions', 'tasks', 'steer', 'others', 'workday', 'restart', 'twotools',
  'withdraw', 'waiting', 'failures', 'processes']
// The items that an argument selects, by scenario. A scenario without an entry runs each of its items.
const only = {}
const selected = process.argv.slice(2).length ? process.argv.slice(2).map(argument => {
  const [name, items] = argument.split(':')
  if (items) only[name] = new Set(items.split(','))
  return name
}) : SCENARIOS
for (const name of selected) if (!SCENARIOS.includes(name)) throw new Error(`Unknown scenario ${name}`)
/** True when the run must do the item [item] of [scenario]. The number of the item is its first word. */
const wanted = (scenario, item) => !only[scenario] || only[scenario].has(item.split(' ')[0])

await loadSecrets()
const root = await makeRoot()
const homes = []
// Each process that a child run of this smoke run started and that the run watches. At the end, each one that still
// runs with the same command line gets SIGKILL.
const leftovers = []
const results = []
const say = text => process.stdout.write(`${redact(text)}\n`)
say(`The files of this run are in ${root}.`)

/** One result of an item of the list: `pass`, `fail` or `not checked`, with the evidence. */
function record(item, status, evidence) {
  results.push({ item, status, evidence })
  say(`${status.toUpperCase().padEnd(11)} ${item}`)
}

const snapshot = async home => (await daemonOf(home)).json('/state')
const conversationOf = async home => (await daemonOf(home)).json('/conversation')
async function waitState(home, predicate, timeoutMs, what) {
  const end = Date.now() + timeoutMs
  for (;;) {
    try {
      const value = predicate(await snapshot(home))
      if (value) return value
    }
    catch { /* The daemon can restart in the wait. */ }
    if (Date.now() > end) throw new Error(`Timeout: ${what}`)
    await delay(1000)
  }
}
const runsOf = state => Object.values(state.runs).sort((a, b) => (a.admittedAt ?? 0) - (b.admittedAt ?? 0))
const quiet = count => state => !state.current && runsOf(state).length >= count
  && runsOf(state).every(item => terminalStates.has(item.status) && item.reported) ? state : undefined
const byTitle = (state, title) => runsOf(state).filter(item => item.title === title || item.prompt?.includes(title))
const iso = time => time ? new Date(time).toISOString().slice(11, 23) : null

/** Starts a home with [values] and the project values [projects], and gives its environment. */
async function setup(name, values, extra = {}, projects) {
  // The index of past sessions is on by default, and the run must not read the sessions of the user.
  const home = await makeHome(root, name, { 'keepAlive.enabled': false, 'sessions.index': 'off', ...values }, projects)
  const env = daemonEnvironment(root, { MEGACHAT_HOME: home, ...extra })
  homes.push({ home, env })
  return { name, home, env, log: join(root, `${name}.acp.jsonl`) }
}

async function connect(context, directories, { name = 'view', sessionId, cwd, permission } = {}) {
  const client = new LiveClient({ home: context.home, env: context.env, directories, log: context.log, name,
    ...(permission ? { permission } : {}) })
  await client.start()
  await client.initialize()
  if (sessionId) await client.loadSession(sessionId, cwd ?? directories[0])
  else await client.newSession(cwd ?? directories[0])
  return client
}

/** The rows of the background tasks in [updates]: each spawn, with its end when it came. */
function rows(updates) {
  const list = new Map()
  for (const item of updates) {
    const update = item.update
    if (update?.sessionUpdate === 'async_task_spawned') list.set(update.asyncTaskId, { ...update, spawnedAt: item.at })
    if (update?.sessionUpdate === 'async_task_state_update' && list.has(update.asyncTaskId))
      Object.assign(list.get(update.asyncTaskId), { endState: update.state, endedAt: item.at })
  }
  return [...list.values()]
}
const openRow = (client, runId) => rows(client.updates).filter(row => row.asyncTaskId.startsWith(`${runId}:`) && !row.endState).at(-1)

async function transcript(home, runId) {
  const directory = join(home, 'transcripts')
  const file = join(directory, `${runId}.txt`)
  if (!existsSync(file)) return { exists: false }
  const [info, folder, text] = await Promise.all([stat(file), stat(directory), readFile(file, 'utf8')])
  return { exists: true, mode: (info.mode & 0o777).toString(8), directoryMode: (folder.mode & 0o777).toString(8), bytes: info.size,
    task: text.includes('Task:'), tools: (text.match(/\] Tool /g) ?? []).length, ended: /The run ended: ([a-z]+)/.exec(text)?.[1] ?? null,
    leaks: leaks(text), text }
}
const excerpt = (text, length = 900) => redact(text.length <= length ? text : `${text.slice(0, length)}…`)

/** Waits until the transcript of [runId] shows a tool call whose line holds [word], and the child runs it. */
async function waitForTool(home, client, runId, word, timeoutMs = 240000) {
  return client.waitFor(async () => {
    const facts = await transcript(home, runId)
    const line = facts.exists && facts.text.split('\n').find(text => text.includes('] Tool ') && text.includes(word))
    const state = await snapshot(home)
    return line && ['dispatched', 'running'].includes(state.runs[runId]?.status) && !Object.values(state.permissions)
      .some(permission => permission.runId === runId && permission.status === 'pending') ? line : undefined
  }, timeoutMs, `the tool ${word} of ${runId}`)
}

const readText = path => readFile(path, 'utf8').catch(() => null)

/**
 * The entries of the daemon log of [home] about the child run [runId]: each line that names the run, with the lines of
 * the agent (`  | `) that follow it. The text is redacted.
 */
async function childLog(home, runId) {
  const lines = ((await readText(join(home, 'daemon', 'daemon.log'))) ?? '').split('\n')
  const found = []
  let inside = false
  for (const line of lines) {
    if (line.startsWith('  | ')) { if (inside) found.push(redact(line)); continue }
    inside = Boolean(runId) && line.includes(runId)
    if (inside) found.push(redact(line))
  }
  return found
}
/** The lines of the daemon log of [home] about a signal that a supervisor refused (`log.child.refused`). */
const refusals = async home => ((await readText(join(home, 'daemon', 'daemon.log'))) ?? '').split('\n')
  .filter(line => !line.startsWith('  | ') && line.includes('sent no signal to the PID')).map(redact)
/** True when [lines] of the log show the answer or the error output of an agent: only a failed run shows them. */
const showsErrorOutput = lines => lines.some(line => /wrote this error output|wrote no error output|answered the request/.test(line))
/** True when the error of a run names an exit code, a signal or the error output of the agent. */
const namesAgentEnd = text => /exit code|the signal|error output says|daemon\.log/.test(text ?? '')
const lastAssistantTexts = async home => (await conversationOf(home)).entries
  .flatMap(entry => (entry.model ?? []).filter(item => item.role === 'assistant'))
  .map(item => item.content.filter(block => block.type === 'text').map(block => block.text).join(''))
  .filter(Boolean)

/** The model IDs in the Claude Code session file of [run], which Claude Code writes for each child. Read only. */
async function claudeModels(run) {
  if (!run?.providerSessionId) return []
  const file = join(homedir(), '.claude', 'projects', run.cwd.replace(/[^a-zA-Z0-9]/g, '-'), `${run.providerSessionId}.jsonl`)
  const text = await readText(file)
  if (!text) return ['session file not found']
  const models = new Set()
  for (const line of text.split('\n')) {
    try { const model = JSON.parse(line).message?.model; if (model) models.add(model) }
    catch { /* A partial last line. */ }
  }
  return [...models]
}

const stalls = []
const STALL_MS = 240000

/**
 * The generations of the main agent that wait for tool tasks that all ended. The store of Pi Durable is read only, so
 * the read changes nothing.
 */
async function stalledGenerations(home) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(home, 'conversation.sqlite'), { readOnly: true })
  try {
    const tasks = db.prepare('select id, kind, status, record from tasks').all().map(row => ({ ...row, record: JSON.parse(row.record) }))
    const byId = new Map(tasks.map(task => [task.id, task]))
    return tasks.filter(task => task.status === 'waiting' && task.record.state?.on?.every(id => byId.get(id)?.status === 'terminal'))
      .map(task => ({ task: task.id, kind: JSON.parse(task.kind), on: task.record.state.on, policy: task.record.state.policy,
        toolsEnded: task.record.state.on.map(id => iso(byId.get(id).record.endedAt)) }))
  }
  finally { db.close() }
}

/**
 * One prompt of the user. A turn that gives no answer in [timeoutMs] is a stall: the run keeps the evidence, stops the
 * daemon, and attaches the view again, so the scenario goes on with the next start of the daemon.
 */
async function turn(context, view, text, timeoutMs = STALL_MS) {
  const sentAt = Date.now()
  try { return await view.prompt(text, timeoutMs) }
  catch (error) {
    if (!/No answer to session\/prompt/.test(error.message)) throw error
    const state = await snapshot(context.home)
    stalls.push({ scenario: context.name, sentAt: iso(sentAt), noticedAt: iso(Date.now()), current: state.current?.kind ?? null,
      runs: runsOf(state).map(item => item.status), waitingGenerations: await stalledGenerations(context.home) })
    say(`STALL       a turn of the scenario ${context.name} gave no answer in ${timeoutMs / 1000} s. The daemon starts again.`)
    await stopDaemon(context.home, context.env)
    await view.reconnect()
    return { stalled: true, sentAt, endedAt: Date.now(), updates: [], from: view.updates.length, to: view.updates.length }
  }
}

const prompts = {
  one: (cwd, title, task) => `Start one Claude task now in the project ${cwd}. Title: "${title}". Task for the child: "${task}" Do not wait for the result. Answer in one sentence.`,
}

// Item 1: the reply stream, also when the model thinks first.
async function chat() {
  const project = await makeProject(root, 'chat', parserFile)
  const context = await setup('chat', { 'reply.suggestions': 'ghost', 'coordinator.thinking': 'medium' })
  const view = await connect(context, [project])
  const first = await turn(context, view, 'Think it through first. Then explain in about 120 words, in plain prose and without a list, why a durable queue helps a chat agent that hands work to helpers.')
  const streamed = replies(first.updates).filter(item => item.messageId.startsWith('megachat-reply-'))
  const entries = (await conversationOf(context.home)).entries
  const blocks = entries.flatMap(entry => (entry.model ?? []).filter(item => item.role === 'assistant').map(item => item.content.map(block => block.type)))
  const thought = blocks.some(types => types[0] === 'thinking')
  const most = Math.max(0, ...streamed.map(item => item.chunks))
  record('1 Streaming', most > 1 ? 'pass' : 'fail', {
    messages: streamed.map(item => ({ messageId: item.messageId.replace(/-\d+-/, '-<task>-'), chunks: item.chunks, characters: item.text.length,
      firstChunk: iso(item.first), lastChunk: iso(item.last) })), promptSent: iso(first.sentAt), promptAnswered: iso(first.endedAt),
    assistantBlocks: blocks, thinkingFirst: thought })

  await view.close()
  await stopDaemon(context.home, context.env)
}

/** The child task of the second try of [ghostSuggestion]: a Claude task that writes a test, or a pi task that only reads. */
const ghostTasks = {
  claude: project => prompts.one(project, 'empty test', 'Create the file test_parser.py with one pytest test: parse("") must return []. Do not run it, and change no other file.'),
  pi: project => `Start one pi task now in the project ${project}. Title: "parser bug". Task for the child: "Read parser.py and name in one sentence the input with quoted fields that it splits wrongly. Change no file." Do not wait for the result. Answer in one sentence.`,
}

/**
 * Gets a prompt suggestion in the mode ghost: from the reply of a user step, or else from the report of a child result
 * that leaves a clear next action. [agent] is the agent of that child. Gives the suggestion, the index of the first
 * update of its step, and its source.
 */
async function ghostSuggestion(context, view, project, agent = 'claude') {
  const review = code => `Read this Python function and name its bug in one sentence. Do not change a file. ${code}`
  let step = await turn(context, view, review('def parse(text): return [line.split(",") for line in text.splitlines()] # for CSV text with quoted fields'))
  let ghost = suggestions(step.updates).filter(item => item.text).at(-1)
  let from = step.from
  let source = 'reply of the user step'
  if (!ghost) {
    // The suggestion then comes in the automatic step of the report.
    const count = runsOf(await snapshot(context.home)).length
    step = await turn(context, view, ghostTasks[agent](project))
    await waitState(context.home, quiet(count + 1), 360000, 'the test task')
    await delay(3000)
    ghost = suggestions(view.updates.slice(step.to)).filter(item => item.text).at(-1)
    from = step.to
    source = 'report of the child result'
  }
  return { ghost, from, source }
}

const parserFile = { 'parser.py': 'def parse(text):\n    return [line.split(",") for line in text.splitlines()]\n' }

// Item 2: the prompt suggestion in the modes ghost, reply and off.
async function suggest() {
  const project = await makeProject(root, 'suggest', parserFile)
  const context = await setup('suggest', { 'reply.suggestions': 'ghost', 'children.permissionMode': 'allowEdits' })
  const view = await connect(context, [project])
  const { ghost, from, source } = await ghostSuggestion(context, view, project)
  const window = view.updates.slice(from).filter(item => !ghost || item.at <= ghost.at + 50)
  const ghostReply = replies(window).map(item => item.text).join('')
  const lastChunk = Math.max(0, ...window.filter(item => item.update?.sessionUpdate === 'agent_message_chunk').map(item => item.at))
  const second = await connect(context, [project], { name: 'second view', sessionId: view.sessionId })
  await delay(3000)
  const replayEnd = second.updates.findIndex(item => item._meta?.loadSessionEndOfRecordedHistory)
  const again = suggestions(second.updates.slice(replayEnd + 1)).filter(item => item.text)
  const ghostOk = ghost && ghost.at >= lastChunk && !ghostReply.toLowerCase().includes(ghost.text.toLowerCase().slice(0, 30))
    && again.some(item => item.text === ghost.text)
  await second.close()
  await view.close()

  // The mode reply, then the mode off, after a restart of the daemon with the changed setting.
  const modes = {}
  const tasksOf = { reply: ['mean test', 'Create the file test_mean.py with one pytest test: mean([]) must raise ValueError. The module is stats.py with def mean(values): return sum(values) / len(values). Create stats.py too. Do not run the test.'],
    off: ['last test', 'Create the file test_last.py with one pytest test: last([1, 2]) must return 2. The module is items.py with def last(items): return items[len(items)]. Create items.py too. Do not run the test.'] }
  for (const mode of ['reply', 'off']) {
    await stopDaemon(context.home, context.env)
    await writeSettings(context.home, { 'keepAlive.enabled': false, 'reply.suggestions': mode, 'children.permissionMode': 'allowEdits' })
    const client = await connect(context, [project], { name: `view ${mode}`, sessionId: view.sessionId })
    const before = new Set(Object.keys((await snapshot(context.home)).initiative.decisions))
    const count = runsOf(await snapshot(context.home)).length
    const answer = await turn(context, client, prompts.one(project, ...tasksOf[mode]))
    await waitState(context.home, quiet(count + 1), 360000, `the task in the mode ${mode}`)
    await delay(3000)
    const decisions = Object.entries((await snapshot(context.home)).initiative.decisions).filter(([key]) => !before.has(key))
      .map(([, value]) => value.result).filter(result => result && 'suggestion' in result)
    const later = client.updates.slice(answer.from)
    const reply = replies(later).map(item => item.text).join('\n---\n')
    modes[mode] = { reply: excerpt(reply, 900), proposals: decisions.map(result => ({ allowed: result.allowed, suggestion: result.suggestion })),
      promptSuggestions: suggestions(later).map(item => item.text) }
    await client.close()
  }
  await stopDaemon(context.home, context.env)
  const replyOk = modes.reply.proposals.some(item => item.allowed) && !modes.reply.promptSuggestions.some(Boolean)
  const offOk = modes.off.proposals.length === 0 && !modes.off.promptSuggestions.some(Boolean)
  record('2 Ghost suggestion', ghostOk && replyOk && offOk ? 'pass' : 'fail', {
    ghost: { source, suggestion: ghost?.text ?? null, arrivedAt: iso(ghost?.at), lastChunkBefore: iso(lastChunk),
      reply: excerpt(ghostReply, 600), sentAgainOnLoad: again.map(item => item.text) }, ...modes })
}

// Item 3: the rules of the project reach a Claude child, and a project that moves the base URL gets a refusal.
async function rules() {
  const rule = marker => `# Rules\n\nEach new file that you create in this project must end with the line \`${marker}\`. This rule has no exception.\n`
  const claude = await makeProject(root, 'rules-claude', { 'CLAUDE.md': rule('-- checked by rule R7 --') })
  const agents = await makeProject(root, 'rules-agents', { 'AGENTS.md': rule('-- checked by rule A9 --') })
  const canary = 'canary-q7x41'
  const url = await makeProject(root, 'rules-url', { '.claude/settings.json': JSON.stringify({ env: { ANTHROPIC_BASE_URL: `http://127.0.0.1:9/${canary}` } }) })
  const context = await setup('rules', { 'children.permissionMode': 'allowEdits' })
  const view = await connect(context, [claude, agents, url])
  await turn(context, view, `Start three Claude tasks now, one in each project below, with the same task for each child: "Create the file note.txt that holds the word hello." Titles: "note R7", "note A9", "note URL". Projects: 1) ${claude} 2) ${agents} 3) ${url}. Do not wait for the results. Answer in one sentence.`)
  const state = await waitState(context.home, quiet(3), 480000, 'the three rule tasks')
  const find = cwd => runsOf(state).find(item => item.cwd === cwd)
  const notes = { claude: await readText(join(claude, 'note.txt')), agents: await readText(join(agents, 'note.txt')) }
  const refused = find(url)
  const texts = [JSON.stringify(state), ...(await lastAssistantTexts(context.home)), await readText(context.log) ?? '',
    ...(await Promise.all(runsOf(state).map(item => transcript(context.home, item.id).then(facts => facts.text ?? ''))))]
  await view.close()
  await stopDaemon(context.home, context.env)
  const lastLine = text => text?.trimEnd().split('\n').at(-1)
  const ok = lastLine(notes.claude) === '-- checked by rule R7 --' && lastLine(notes.agents) === '-- checked by rule A9 --'
    && refused?.status === 'interrupted' && refused.autoResume === false && !runsOf(state).some(item => item.resumeOf === refused.id)
    && /ANTHROPIC_BASE_URL/.test(refused.error ?? '') && /settings\.json/.test(refused.error ?? '')
    && !texts.some(text => text.includes(canary))
  record('3 Project rules', ok ? 'pass' : 'fail', {
    claudeMd: { status: find(claude)?.status, note: notes.claude }, agentsMd: { status: find(agents)?.status, note: notes.agents },
    baseUrl: { status: refused?.status, error: redact(refused?.error ?? ''), valueInAnyText: texts.some(text => text.includes(canary)) } })
}

// Item 4: the permission modes ask and allowEdits, and the model of a Claude child with inherit and with an explicit value.
async function permissions() {
  const tapLog = join(root, 'permissions.tap.jsonl')
  const adapter = join(LEASE, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')
  const command = JSON.stringify({ command: process.execPath, args: [join(LEASE, 'test', 'live', 'tap.mjs'), process.execPath, adapter], env: { TAP_LOG: tapLog } })
  const ask = await makeProject(root, 'perm-ask')
  const edits = await makeProject(root, 'perm-edits')
  const context = await setup('permissions', { 'children.permissionMode': 'ask', 'children.claudeModel': 'inherit' }, { MEGACHAT_CLAUDE_ACP: command })
  const permission = params => delay(1500).then(() => params.options.find(option => option.kind === 'allow_once')?.optionId)
  let view = await connect(context, [ask, edits], { permission })
  await turn(context, view, prompts.one(ask, 'perm file', 'Create the file perm.txt with the text perm. Do nothing else.'))
  let state = await waitState(context.home, quiet(1), 360000, 'the task in the mode ask')
  const askRun = byTitle(state, 'perm file')[0]
  const askPermissions = view.permissions.map(entry => ({ title: entry.params.toolCall?.title,
    options: entry.params.options.map(option => `${option.optionId}:${option.kind}`), answer: entry.answer }))
  const sessionId = view.sessionId
  const askFile = await readText(join(ask, 'perm.txt'))
  await view.close()
  await stopDaemon(context.home, context.env)
  const tapAsk = (await readText(tapLog)) ?? ''

  await writeSettings(context.home, { 'keepAlive.enabled': false, 'children.permissionMode': 'allowEdits', 'children.claudeModel': 'anthropic/claude-haiku-5-5' })
  view = await connect(context, [ask, edits], { name: 'view allowEdits', sessionId, permission })
  await turn(context, view, prompts.one(edits, 'edit file', 'Create the file edit.txt with the text edit. Do nothing else.'))
  state = await waitState(context.home, quiet(2), 360000, 'the task in the mode allowEdits')
  const editRun = byTitle(state, 'edit file')[0]
  const editPermissions = view.permissions.map(entry => entry.params.toolCall?.title)
  const editFile = await readText(join(edits, 'edit.txt'))
  await view.close()
  await stopDaemon(context.home, context.env)
  const tapAll = (await readText(tapLog)) ?? ''
  const tapEdit = tapAll.slice(tapAsk.length)
  const tapFacts = text => text.split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(entry => entry.model || entry.mode || entry.method === 'session/set_mode' || entry.method === 'session/set_config_option'
      || entry.update === 'config_option_update' || entry.update === 'current_mode_update' || entry.config)
    .map(({ at, ...entry }) => entry)
  const titleOk = askPermissions.length > 0 && askPermissions.every(entry => /^Claude · perm file needs permission: /.test(entry.title))
  const noBypass = askPermissions.every(entry => !entry.options.some(option => /bypass/i.test(option)))
  const ok = titleOk && noBypass && askRun?.status === 'completed' && askFile?.trim() === 'perm' && editRun?.status === 'completed'
    && editPermissions.length === 0 && editFile?.trim() === 'edit'
  record('4 Permission mode and model', ok ? 'pass' : 'fail', {
    ask: { status: askRun?.status, file: askFile, permissions: askPermissions, tap: tapFacts(tapAsk), sessionModels: await claudeModels(askRun) },
    allowEdits: { status: editRun?.status, file: editFile, permissions: editPermissions, tap: tapFacts(tapEdit), sessionModels: await claudeModels(editRun) } })
}

// Items 5 and 6: the rows with Stop and transcript, the Stop of a running and of a queued row, and the parallel children.
async function tasks() {
  const a = await makeProject(root, 'tasks-a', { 'sub/README.md': 'sub\n' })
  const b = await makeProject(root, 'tasks-b')
  const sub = join(a, 'sub')
  const context = await setup('tasks', { 'children.permissionMode': 'allowEdits', 'children.parallel': 3 })
  const view = await connect(context, [a, sub, b])
  // The turn runs while the scenario stops the rows, so a stall of the turn does not stop the checks.
  const pending = turn(context, view, `Start these five Claude tasks now, in this order, without a wait between them. Do not wait for the results. Answer in one sentence.
1. Title "sleep A", project ${a}: "Run the shell command \`sleep 60\`. Then create the file a1.txt with the text a1."
2. Title "sleep B", project ${b}: "Run the shell command \`sleep 25\`. Then create the file b1.txt with the text b1."
3. Title "file A2", project ${a}: "Create the file a2.txt with the text a2."
4. Title "file sub", project ${sub}: "Create the file s.txt with the text s."
5. Title "file B2", project ${b}: "Create the file b2.txt with the text b2."`, 420000)
  let state = await waitState(context.home, value => runsOf(value).length >= 5 ? value : undefined, 180000, 'the five tasks')
    .catch(() => snapshot(context.home))
  const id = title => byTitle(state, title)[0]?.id
  const ids = { A: id('sleep A'), B: id('sleep B'), A2: id('file A2'), sub: id('file sub'), B2: id('file B2') }
  if (Object.values(ids).some(value => !value)) {
    const step = await pending
    record('5 Task rows, Stop, transcript', 'fail', { reason: 'The main agent did not start the five tasks.', reply: excerpt(replies(step.updates).map(item => item.text).join('')), runs: runsOf(state).map(item => item.title) })
    return
  }
  // The queued row of B2 waits behind B in the same project.
  const queued = await view.waitFor(() => openRow(view, ids.B2), 30000, 'the queued row of B2')
  const queuedStopAt = Date.now()
  const queuedStop = await view.stopTask(queued.asyncTaskId)
  const queuedEnd = await view.waitFor(() => rows(view.updates).find(row => row.asyncTaskId === queued.asyncTaskId && row.endState), 30000, 'the end of the row of B2')
  // The running row of A, while its command runs.
  const toolLine = await waitForTool(context.home, view, ids.A, 'sleep')
  await delay(3000)
  const running = openRow(view, ids.A)
  const transcriptA = await transcript(context.home, ids.A)
  const runningStopAt = Date.now()
  const runningStop = await view.stopTask(running.asyncTaskId)
  const stoppedAt = Date.now()
  const runningEnd = await view.waitFor(() => rows(view.updates).find(row => row.asyncTaskId === running.asyncTaskId && row.endState), 60000, 'the end of the row of A')
  await pending
  state = await waitState(context.home, quiet(5), 600000, 'the five tasks')
  const run = key => state.runs[ids[key]]
  const allRows = rows(view.updates)
  const later = runsOf(state).filter(item => item.admittedAt > stoppedAt && /a1\.txt/.test(item.prompt ?? ''))
  const reports = await lastAssistantTexts(context.home)
  const finalTranscriptA = await transcript(context.home, ids.A)
  const files = Object.fromEntries(await Promise.all([['a1', a], ['a2', a], ['b1', b], ['b2', b], ['s', sub]]
    .map(async ([name, directory]) => [name, existsSync(join(directory, `${name}.txt`))])))
  const homeLeaks = await scanLeaks(context.home, context.log)
  // A stopped run shows no error output of the agent, and its stop does not wait for that output.
  const stoppedLogs = { A: await childLog(context.home, ids.A), B2: await childLog(context.home, ids.B2) }
  const quietStop = !showsErrorOutput([...stoppedLogs.A, ...stoppedLogs.B2]) && !namesAgentEnd(run('A').error) && !namesAgentEnd(run('B2').error)
  await view.close()
  await stopDaemon(context.home, context.env)

  const runningRows = allRows.filter(row => row.asyncTaskId.endsWith(':running') || row.asyncTaskId.endsWith(':approval'))
  const queuedRows = allRows.filter(row => row.asyncTaskId.endsWith(':queued'))
  const rowsOk = allRows.every(row => row.canStop === true) && runningRows.every(row => row.outputFilePath?.endsWith('.txt'))
    && queuedRows.every(row => !row.outputFilePath)
  const fileOk = transcriptA.mode === '600' && transcriptA.directoryMode === '700' && transcriptA.task && transcriptA.tools > 0 && !transcriptA.leaks
  const stopOk = runningStop?.stopped === true && runningEnd.endState === 'stopped' && queuedStop?.stopped === true && queuedEnd.endState === 'stopped'
    && run('A').status === 'cancelled' && run('B2').status === 'cancelled' && !run('B2').startedAt && run('B').status === 'completed'
    && later.length === 0 && !files.a1 && !files.b2
  record('5 Task rows, Stop, transcript', rowsOk && fileOk && stopOk && quietStop && !homeLeaks.length ? 'pass' : 'fail', {
    rows: allRows.map(row => ({ id: row.asyncTaskId.replace(/^[0-9a-f-]{36}/, short => keyOf(ids, short)), name: row.name, description: row.description,
      canStop: row.canStop, outputFilePath: row.outputFilePath ? row.outputFilePath.replace(context.home, '<home>') : null, spawned: iso(row.spawnedAt),
      end: row.endState ?? null, ended: iso(row.endedAt) })),
    transcriptOfA: { mode: transcriptA.mode, directoryMode: transcriptA.directoryMode, bytes: transcriptA.bytes, toolLines: transcriptA.tools,
      endedLine: finalTranscriptA.ended, leaks: transcriptA.leaks, toolLine: redact(toolLine), excerpt: excerpt(finalTranscriptA.text ?? '', 1500) },
    stops: { running: runningStop, runningEnd: runningEnd.endState, runningMs: runningEnd.endedAt - runningStopAt,
      runningRunEndMs: run('A').finishedAt - runningStopAt, queued: queuedStop,
      queuedEnd: queuedEnd.endState, queuedMs: queuedEnd.endedAt - queuedStopAt, errors: { A: run('A').error ?? null, B2: run('B2').error ?? null },
      logLines: stoppedLogs, quietStop },
    statuses: Object.fromEntries(Object.keys(ids).map(key => [key, run(key).status])), startedAgain: later.length, files,
    reports: reports.slice(1).map(text => excerpt(text, 500)), leaksInHome: homeLeaks })

  const times = Object.fromEntries(Object.keys(ids).map(key => [key, { started: iso(run(key).startedAt), finished: iso(run(key).finishedAt) }]))
  const overlap = run('A').startedAt < run('B').finishedAt && run('B').startedAt < run('A').finishedAt
  const sameAfter = run('A2').startedAt >= run('A').finishedAt
  const insideAfter = run('sub').startedAt >= run('A').finishedAt && run('sub').startedAt >= Math.min(run('A2').finishedAt, Infinity)
  // A stopped run keeps its place in its directory until its supervisor exited, at most 6 seconds after its end.
  const placeHeldMs = run('A2').startedAt - run('A').finishedAt
  record('6 Parallel children', overlap && sameAfter && insideAfter && placeHeldMs <= PLACE_MS ? 'pass' : 'fail', { times, overlap,
    sameDirectoryAfter: sameAfter, insideDirectoryAfter: insideAfter, placeHeldMs })
}
const keyOf = (ids, value) => Object.entries(ids).find(([, id]) => id === value)?.[0] ?? '<run>'
/** The longest time that a run keeps its place in its directory after its end: 6 seconds and a margin for the start. */
const PLACE_MS = 7000

// Item 7: a message of the user reaches a running child through agents_steer.
async function steer() {
  const project = await makeProject(root, 'steer')
  const context = await setup('steer', { 'children.permissionMode': 'allowEdits' })
  const view = await connect(context, [project])
  await turn(context, view, prompts.one(project, 'word file', 'Run the shell command `sleep 40`. After that, create the file word.txt with the one word that the user sends you during the task. If no word came, write NONE.'))
  const runId = byTitle(await snapshot(context.home), 'word file')[0]?.id
  if (!runId) { record('7 Steering', 'fail', { reason: 'The main agent did not start the task.' }); return }
  await waitForTool(context.home, view, runId, 'sleep')
  await delay(3000)
  const step = await turn(context, view, 'For the running task "word file": the word is ZEBRA.')
  const state = await waitState(context.home, quiet(1), 360000, 'the steered task')
  const runs = byTitle(state, 'word file')
  const steers = runs.flatMap(item => (item.steers ?? []).map(entry => ({ run: item.id === runId ? 'first' : 'later', mode: entry.mode, delivery: entry.delivery, outcome: entry.outcome ?? null, text: entry.text })))
  const facts = await Promise.all(runs.map(item => transcript(context.home, item.id)))
  const word = await readText(join(project, 'word.txt'))
  await view.close()
  await stopDaemon(context.home, context.env)
  const lines = facts.flatMap(item => (item.text ?? '').split('\n').filter(line => /Message of the user|ZEBRA/.test(line)))
  record('7 Steering', word?.trim() === 'ZEBRA' && steers.length > 0 && lines.some(line => line.includes('added to the turn')) ? 'pass' : 'fail', {
    reply: excerpt(replies(step.updates).map(item => item.text).join(''), 400), steers, runs: runs.map(item => item.status), word, transcriptLines: lines.map(redact) })
}

// Item 8: one Codex task and one pi task.
async function others() {
  const codex = await makeProject(root, 'codex', { 'README.md': 'codex\n' }, { git: true })
  const pi = await makeProject(root, 'pi', { 'README.md': 'Pelican field notes\n\nA list of birds.\n' })
  const context = await setup('others', {})
  const view = await connect(context, [codex, pi])
  await turn(context, view, `Start two tasks now. Do not wait for the results. Answer in one sentence.
1. A Codex task in the project ${codex}, title "codex file": "Create the file codex.txt with the text hi. Do nothing else."
2. A pi task in the project ${pi}, title "pi read": "Read README.md and give its first line."`)
  const state = await waitState(context.home, quiet(2), 480000, 'the Codex and pi tasks')
  const found = agent => runsOf(state).filter(item => item.agent === agent)
  const allRows = rows(view.updates)
  const evidence = {}
  for (const agent of ['codex', 'pi']) {
    const list = found(agent)
    const facts = await Promise.all(list.map(item => transcript(context.home, item.id)))
    evidence[agent] = { runs: list.map(item => ({ status: item.status, error: redact(item.error ?? ''), output: excerpt(item.output ?? '', 300) })),
      rows: allRows.filter(row => list.some(item => row.asyncTaskId.startsWith(item.id))).map(row => ({ phase: row.asyncTaskId.split(':').at(-1), description: row.description, file: Boolean(row.outputFilePath), end: row.endState })),
      transcripts: facts.map(item => ({ exists: item.exists, mode: item.mode, tools: item.tools, ended: item.ended, leaks: item.leaks, excerpt: excerpt(item.text ?? '', 700) })) }
  }
  evidence.codex.file = await readText(join(codex, 'codex.txt'))
  evidence.records = view.records.map(entry => entry.agentId)
  await view.close()
  await stopDaemon(context.home, context.env)
  const good = agent => evidence[agent].runs.at(-1)?.status === 'completed' && evidence[agent].rows.length > 0 && evidence[agent].transcripts.some(item => item.exists && !item.leaks)
  record('8 Codex child', good('codex') && evidence.codex.file?.trim() === 'hi' ? 'pass' : 'fail', evidence.codex)
  record('8 Pi child', good('pi') && /Pelican/.test(evidence.pi.runs.at(-1)?.output ?? '') ? 'pass' : 'fail', evidence.pi)
}

// Item 9: outside the working hours, the result of a child waits for the next message of the user. With
// `workday.idleMinutes` 1, the child ends after the idle time, so the conversation sleeps at its end. With 0, the
// conversation sleeps at once after each turn of the user.
async function workday() {
  for (const idleMinutes of [1, 0]) await workdayCase(idleMinutes)
}

/** The settings of a working day of one day in 3 days, so that the conversation sleeps today. */
function nightSettings(idleMinutes) {
  const days = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']
  return { 'children.permissionMode': 'allowEdits', 'workday.enabled': true, 'workday.days': days[(new Date().getDay() + 3) % 7],
    'workday.start': '09:00', 'workday.end': '10:00', 'workday.idleMinutes': idleMinutes }
}

async function workdayCase(idleMinutes) {
  const item = `9 Working day, idleMinutes ${idleMinutes}`
  const project = await makeProject(root, `workday-${idleMinutes}`)
  const context = await setup(`workday-${idleMinutes}`, nightSettings(idleMinutes))
  const view = await connect(context, [project])
  const task = idleMinutes > 0 ? `Run the shell command \`sleep ${idleMinutes * 60 + 20}\`. Then create the file w.txt with the text w.`
    : 'Create the file w.txt with the text w. Do nothing else.'
  const first = await turn(context, view, prompts.one(project, 'night file', task))
  const done = await waitState(context.home, state => runsOf(state).length && runsOf(state).every(entry => terminalStates.has(entry.status)) ? state : undefined, 480000, 'the night task')
  const finishedAt = runsOf(done)[0].finishedAt
  await delay(20000)
  const waiting = await snapshot(context.home)
  const reportsBefore = Object.keys(waiting.inputs).filter(key => key.startsWith('children:'))
  const chunksBefore = view.updates.slice(first.to).filter(entry => entry.update?.sessionUpdate === 'agent_message_chunk')
  const second = await turn(context, view, 'I am back. Answer in one short sentence.')
  const after = await waitState(context.home, quiet(1), 120000, 'the report after the user turn').catch(() => snapshot(context.home))
  await delay(2000)
  const reports = Object.entries(after.inputs).filter(([key]) => key.startsWith('children:')).map(([, input]) => input)
  const userInput = Object.entries(after.inputs).filter(([key, input]) => !key.startsWith('children:') && input.admittedAt >= second.sentAt - 1000)[0]?.[1]
  const reportChunks = replies(view.updates.slice(second.to))
  await view.close()
  await stopDaemon(context.home, context.env)
  const ok = !runsOf(waiting)[0].reported && reportsBefore.length === 0 && chunksBefore.length === 0 && reports.length === 1
    && reports[0].admittedAt >= (userInput?.settledAt ?? second.endedAt) - 1000 && reportChunks.length > 0
  record(item, ok ? 'pass' : 'fail', { firstTurnEnded: iso(first.endedAt), childFinished: iso(finishedAt), reportedWhileAsleep: runsOf(waiting)[0].reported,
    reportTurnsBeforeUser: reportsBefore.length, chunksBeforeUser: chunksBefore.length, userTurnSettled: iso(userInput?.settledAt),
    reportAdmitted: iso(reports[0]?.admittedAt) ?? 'no report turn in 120 s', replyOfUserTurn: excerpt(replies(second.updates).map(entry => entry.text).join(''), 300),
    replyAfterUserTurn: excerpt(reportChunks.map(entry => entry.text).join('\n'), 400) })
}

// Item 10: a stop of the daemon during a running Claude child, and a new start on the same home.
async function restart() {
  const project = await makeProject(root, 'restart', {}, { git: true })
  const context = await setup('restart', { 'children.permissionMode': 'allowEdits' })
  let view = await connect(context, [project])
  const sessionId = view.sessionId
  await turn(context, view, prompts.one(project, 'restart file', 'Run the shell command `sleep 45`. Then create the file r.txt with the text r.'))
  const firstId = byTitle(await snapshot(context.home), 'restart file')[0]?.id
  if (!firstId) { record('10 Restart', 'fail', { reason: 'The main agent did not start the task.' }); return }
  await waitForTool(context.home, view, firstId, 'sleep')
  await delay(5000)
  // The processes of the run and the daemon at the stop. A stop of the daemon keeps the shell of the run, as before.
  const tree = await runTree(context.home, firstId)
  const daemonProcess = { pid: await daemonPid(context.home), ppid: null, command: `${process.execPath} ${join(LEASE, 'src', 'main.mjs')} daemon ${context.home}` }
  leftovers.push(...tree)
  const watcher = watch([daemonProcess, ...tree])
  await watcher.ready
  const stoppedAt = Date.now()
  const stop = await stopDaemon(context.home, context.env)
  const stopMs = Date.now() - stoppedAt
  await delay(3000)
  await watcher.stop()
  const ends = endOrder([daemonProcess, ...tree], watcher, stoppedAt)
  const clientExit = await Promise.race([view.exited, delay(15000).then(() => 'still running')])
  const beforeText = (await transcript(context.home, firstId)).text ?? ''
  view = await connect(context, [project], { name: 'view after restart', sessionId })
  const state = await waitState(context.home, quiet(2), 480000, 'the continued task')
  const runs = byTitle(state, 'restart file')
  const first = state.runs[firstId]
  const next = runs.find(item => item.resumeOf === firstId)
  const facts = await Promise.all(runs.map(item => transcript(context.home, item.id)))
  const file = await readText(join(project, 'r.txt'))
  const allRows = rows(view.updates)
  // A stop of the daemon shows no error output of the agent, and it does not wait for that output.
  const firstLog = await childLog(context.home, firstId)
  const quietStop = !showsErrorOutput(firstLog) && !namesAgentEnd(first?.error)
  await view.close()
  await stopDaemon(context.home, context.env)
  const ok = stop.stopped && first?.status === 'resumed' && next?.status === 'completed' && file?.trim() === 'r' && quietStop
  record('10 Restart', ok ? 'pass' : 'fail', { daemonStopped: stop.stopped, stoppedAt: iso(stoppedAt), stopMs, clientExit, ends,
    first: { status: first?.status, finished: iso(first?.finishedAt), error: redact(first?.error ?? ''), resumedBy: Boolean(first?.resumedBy),
      logLines: firstLog, quietStop },
    continuation: next ? { status: next.status, started: iso(next.startedAt), finished: iso(next.finishedAt), sameSession: next.providerSessionId === first.providerSessionId } : null,
    runs: runs.length, file, rowsAfterRestart: allRows.map(row => ({ phase: row.asyncTaskId.split(':').at(-1), description: row.description, end: row.endState ?? null })),
    transcriptBeforeStop: excerpt(beforeText.split('\n').slice(-4).join('\n'), 600),
    transcripts: facts.map(item => ({ exists: item.exists, ended: item.ended, continues: /continues an earlier run/.test(item.text ?? ''), lines: (item.text ?? '').split('\n').length })) })
}

/** The text of a model message of the conversation. */
const textOf = item => typeof item.content === 'string' ? item.content
  : (item.content ?? []).filter(block => block.type === 'text').map(block => block.text).join('')
const modelItems = async home => (await conversationOf(home)).entries.flatMap(entry => entry.model ?? [])

/** The model messages after the last user message that holds [text], up to the next user message. */
async function turnItems(home, text) {
  const items = await modelItems(home)
  const start = items.findLastIndex(item => item.role === 'user' && textOf(item).includes(text))
  if (start < 0) return []
  const end = items.findIndex((item, index) => index > start && item.role === 'user')
  return items.slice(start + 1, end < 0 ? undefined : end)
}
const toolCalls = item => item.role === 'assistant' ? (item.content ?? []).filter(block => block.type === 'toolCall') : []
// Item 11: one reply of the main agent with two tool calls, in three turns in a row. Each turn must end. With Pi Durable
// 1.5.0, the step that waits for its tool calls could lose its wake-up, and the turn then had no end (issue #25).
async function twotools() {
  const project = await makeProject(root, 'twotools')
  const context = await setup('twotools', {})
  const view = await connect(context, [project])
  const steps = []
  for (const index of [1, 2, 3]) {
    const text = `Question ${index}. Call the tools agents_list and agents_settings (action get) together, in one reply. Then tell me in one short sentence the number of the tasks and the value of reply.suggestions.`
    const step = await turn(context, view, text)
    const items = step.stalled ? [] : await turnItems(context.home, `Question ${index}.`)
    const calls = items.map(item => toolCalls(item).map(block => block.name)).filter(names => names.length)
    steps.push({ stalled: Boolean(step.stalled), stopReason: step.stopReason ?? null, seconds: Math.round((step.endedAt - step.sentAt) / 1000),
      toolCallsByReply: calls, twoInOneReply: calls.some(names => names.includes('agents_list') && names.includes('agents_settings')),
      answer: excerpt(replies(step.updates).map(item => item.text).join(''), 300) })
  }
  await view.close()
  await stopDaemon(context.home, context.env)
  const ended = steps.every(step => !step.stalled && step.stopReason === 'end_turn')
  const parallel = steps.every(step => step.twoInOneReply)
  record('11 Two tool calls in one reply', ended && parallel ? 'pass' : 'fail', { everyTurnEnded: ended, twoCallsInEachTurn: parallel,
    steps })
}

// Item 12: a change of reply.suggestions from ghost to reply withdraws the shown prompt suggestion, and a new attach gets
// no suggestion. Part A changes the setting through the main agent. A turn of the user withdraws the suggestion at its
// start in each mode, so part A does not depend on the mode. Part B changes the setting file while the daemon is
// stopped. Only the withdrawal at the start of the daemon then removes the suggestion.
async function withdraw() {
  const project = await makeProject(root, 'withdraw', parserFile)
  const context = await setup('withdraw', { 'reply.suggestions': 'ghost', 'children.permissionMode': 'allowEdits' })
  const values = mode => ({ 'keepAlive.enabled': false, 'reply.suggestions': mode, 'children.permissionMode': 'allowEdits' })
  const attachFacts = async name => {
    const client = await connect(context, [project], { name, sessionId: context.sessionId })
    await delay(4000)
    const shown = suggestions(client.updates).filter(item => item.text).map(item => item.text)
    const stored = Boolean((await snapshot(context.home)).initiative.promptSuggestion)
    await client.close()
    return { shown, stored }
  }
  const settingOf = async () => JSON.parse(await readText(join(context.home, 'settings.json'))).values['reply.suggestions']

  // Part A: the setting through the main agent.
  let view = await connect(context, [project])
  context.sessionId = view.sessionId
  const first = await ghostSuggestion(context, view, project, 'pi')
  const partA = { source: first.source, suggestion: first.ghost?.text ?? null }
  if (first.ghost) {
    const change = await turn(context, view, 'Set the setting reply.suggestions to reply. Answer in one short sentence.')
    await delay(3000)
    const later = suggestions(view.updates.slice(change.from))
    const withdrawal = later.find(item => item.text === null)
    Object.assign(partA, { setting: await settingOf(), withdrawal: iso(withdrawal?.at), turnSent: iso(change.sentAt), turnEnded: iso(change.endedAt),
      shownAfterWithdrawal: later.filter(item => item.text && (!withdrawal || item.at > withdrawal.at)).map(item => item.text),
      newAttach: await attachFacts('view A') })
    partA.ok = partA.setting === 'reply' && Boolean(withdrawal) && !partA.shownAfterWithdrawal.length && !partA.newAttach.stored
      && !partA.newAttach.shown.length
  }
  await view.close()

  // Part B: the setting file, changed while the daemon is stopped, as an edit of the user between two starts.
  await stopDaemon(context.home, context.env)
  await writeSettings(context.home, values('ghost'))
  view = await connect(context, [project], { name: 'view B', sessionId: context.sessionId })
  const second = await ghostSuggestion(context, view, project, 'pi')
  const partB = { source: second.source, suggestion: second.ghost?.text ?? null }
  if (second.ghost) {
    const before = view.updates.length
    await stopDaemon(context.home, context.env)
    await writeSettings(context.home, values('reply'))
    partB.newAttach = await attachFacts('view B2')
    // The first view lost its daemon. It gets the withdrawal only when it attaches to the new daemon.
    const later = suggestions(view.updates.slice(before))
    partB.firstView = { exitCode: view.exitCode ?? 'still running', withdrawal: later.some(item => item.text === null),
      shownAgain: later.filter(item => item.text).map(item => item.text) }
    partB.ok = !partB.newAttach.shown.length && !partB.newAttach.stored
  }
  await view.close()
  await stopDaemon(context.home, context.env)
  const status = !first.ghost || !second.ghost ? 'not checked' : partA.ok && partB.ok ? 'pass' : 'fail'
  record('12 Suggestion withdrawn at a change of the mode', status, { throughMainAgent: partA, throughSettingFileAndStart: partB })
}

// Item 13: a turn of the user before a waiting result. The conversation sleeps, a child ends, and the user asks for the
// task. A pi child does the task, because it is short and it needs no Claude account. The main agent can answer in two
// correct ways. With agents_list, the run has separateResult true: the answer must say that the task ended and that its
// result follows, and the result message must come after the turn. With agents_inspect, the main agent reads the
// result: the answer gives it, and no result message repeats it. In both ways, the answer must not say that the task
// has no result or still runs. The first question asks for the task, the second one asks for the list of the tasks.
async function waiting() {
  const project = await makeProject(root, 'waiting', { 'README.md': 'Heron field notes\n\nA list of birds.\n', 'NOTES.md': 'Egret survey\n\nTwo birds.\n' })
  const context = await setup('waiting', nightSettings(0))
  const view = await connect(context, [project])
  const cases = [['night read', 'README.md', 'Heron field notes', 'How is the task?'], ['night notes', 'NOTES.md', 'Egret survey', 'Which tasks do I have?']]
  for (const [title, file, line, question] of cases) {
    const item = `13 Waiting result, "${question}"`
    const count = runsOf(await snapshot(context.home)).length
    const first = await turn(context, view, `Start one pi task now in the project ${project}. Title: "${title}". Task for the child: "Read ${file} and give its first line." Do not wait for the result. Answer in one sentence.`)
    const done = await waitState(context.home, state => runsOf(state).length > count && runsOf(state).every(entry => terminalStates.has(entry.status)) ? state : undefined, 480000, `the task ${title}`)
    const run = byTitle(done, title).at(-1)
    if (run?.status !== 'completed') {
      record(item, 'not checked', { reason: 'The child task did not complete.', runs: runsOf(done).map(entry => ({ agent: entry.agent, status: entry.status, error: redact(entry.error ?? '') })) })
      continue
    }
    await delay(20000)
    const asleep = await snapshot(context.home)
    const second = await turn(context, view, question)
    const after = await waitState(context.home, quiet(count + 1), 120000, 'the result message after the user turn').catch(() => snapshot(context.home))
    await delay(3000)
    const items = await turnItems(context.home, question)
    const calls = items.flatMap(entry => toolCalls(entry).map(block => block.name))
    const listed = items.filter(entry => entry.role === 'toolResult' && entry.toolName === 'agents_list').map(entry => {
      try { return JSON.parse(textOf(entry)).runs?.map(entry => ({ title: entry.title, status: entry.status, separateResult: entry.separateResult ?? null })) }
      catch { return excerpt(textOf(entry), 200) }
    })
    const userInput = Object.entries(after.inputs).filter(([key, input]) => !key.startsWith('children:') && input.admittedAt >= second.sentAt - 1000)[0]?.[1]
    const settled = userInput?.settledAt ?? second.endedAt
    const reports = Object.entries(after.inputs).filter(([key, input]) => key.startsWith('children:') && input.admittedAt >= settled - 1000).map(([, input]) => input)
    const answer = replies(second.updates).map(entry => entry.text).join('')
    const resultMessage = replies(view.updates.slice(second.to)).map(entry => entry.text).join('\n')
    // The words of a real model vary. These patterns only flag the answer. The report quotes it for a reader.
    const saysEnded = /\b(ended|finished|completed|complete|done)\b/i.test(answer)
    const saysFollows = /\b(follow|follows|coming|comes|separate|own message|next message|shortly|soon|arrive)/i.test(answer)
    const saysOpen = /no result|not (yet )?(reported|returned|delivered|sent)|(isn't|is not|hasn't|has not) (yet )?(done|finished|ended|completed)|still (runs|running|working|in progress)|\bis running\b/i.test(answer)
    const way = calls.includes('agents_inspect') ? 'agents_inspect' : calls.includes('agents_list') ? 'agents_list' : 'no tool'
    const ok = !byTitle(asleep, title).at(-1).reported && !saysOpen && (way === 'agents_list'
      ? saysEnded && saysFollows && reports.length === 1 && resultMessage.length > 0
      : way === 'agents_inspect' && answer.includes(line) && after.runs[run.id].reported && reports.length === 0 && !resultMessage)
    record(item, ok ? 'pass' : 'fail', { way, childFinished: iso(run.finishedAt), firstTurnEnded: iso(first.endedAt),
      reportedBeforeQuestion: byTitle(asleep, title).at(-1).reported, toolsOfTheTurn: calls, agentsList: listed, answer: redact(answer),
      saysEnded, saysFollows, saysOpen, userTurnSettled: iso(userInput?.settledAt), resultMessages: reports.length,
      resultAdmitted: iso(reports[0]?.admittedAt), resultMessage: excerpt(resultMessage, 400) })
  }
  await view.close()
  await stopDaemon(context.home, context.env)
}

// Item 14: the error of a child run that fails. A refused model of Codex and of Claude, an agent process that dies
// during the task, a Claude Code process that dies during the task, and an agent that fails at its start. Each case
// records the error of each run, the answer of the main agent and the entries of the daemon log about the run.
const execute = promisify(execFile)
const failurePrompt = (agent, cwd, title, task) => `Start one ${agent} task now in the project ${cwd}. Title: "${title}". Task for the child: "${task}" Do not wait for the result. If the task fails, tell me why in at most two sentences, and do not start it again. Answer in one sentence.`

/**
 * Each process of the machine: its PID, the PID of its parent, and the first line of its command line, without the
 * spaces at its end. An argument can hold a line break or be empty. Nothing of it goes out unredacted.
 */
async function processes() {
  const { stdout } = await execute('ps', ['-A', '-ww', '-o', 'pid=,ppid=,command='], { maxBuffer: 16 * 1024 * 1024 })
  return stdout.split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, ppid, command]) => ({ pid: Number(pid), ppid: Number(ppid), command: command.trimEnd() }))
}
/** The first line of the command line of the process [pid], as `processes` gives it, or null when it does not run. */
const commandOf = pid => execute('ps', ['-ww', '-p', String(pid), '-o', 'command='])
  .then(result => result.stdout.replace(/^\n+/, '').split('\n')[0].trimEnd() || null, () => null)
/** The processes under [pid], the first level first. */
function below(list, pid) {
  const found = []
  for (let level = [pid]; level.length;) {
    level = list.filter(item => level.includes(item.ppid)).map(item => (found.push(item), item.pid))
  }
  return found
}
const shortCommand = command => redact(command.replaceAll(LEASE, '<lease>').replaceAll(root, '<root>').replaceAll(homedir(), '~')).slice(0, 200)

/**
 * Sends SIGKILL to one process of the Claude child [runId], while its tool `sleep` runs. [target] `agent` is the agent
 * process of the run, whose PID the state holds. `claude` is the Claude Code process under the adapter. The command
 * line of each process must be the one of this run before the signal.
 */
async function killChild(context, view, runId, target) {
  await waitForTool(context.home, view, runId, 'sleep')
  await delay(3000)
  const pid = (await snapshot(context.home)).runs[runId]?.pid
  const list = await processes()
  const agent = list.find(item => item.pid === pid)
  const supervisor = join(LEASE, 'src', 'child-supervisor.mjs')
  if (!pid || !agent?.command.includes(supervisor) || !agent.command.includes('claude-agent-acp')) throw new Error(`The PID of the run ${runId} is not its Claude agent`)
  const tree = below(list, pid)
  const adapter = tree.find(item => item.ppid === pid)
  const claude = tree.filter(item => item.ppid === adapter?.pid && !/node_modules\/\.bin|\/(z|ba)?sh /.test(item.command))
  const victim = target === 'agent' ? agent : claude.length === 1 ? claude[0] : undefined
  if (!victim) throw new Error(`No single Claude Code process under the adapter of the run ${runId}`)
  // The PID can only belong to this run when its command line did not change since the list.
  if (await commandOf(victim.pid) !== victim.command) throw new Error(`The process ${victim.pid} changed`)
  leftovers.push(agent, ...tree)
  process.kill(victim.pid, 'SIGKILL')
  return { killedAt: Date.now(), target, victim: shortCommand(victim.command), tree: [agent, ...tree], watch: watch([agent, ...tree]) }
}

/**
 * Each process of [items] that still runs with the same first line of its command line. One `ps` reads all of them.
 */
async function running(items) {
  if (!items.length) return []
  // `ps -p` exits with 1 when no PID of the list runs. Its output then is empty.
  const output = await execute('ps', ['-ww', '-o', 'pid=,command=', '-p', items.map(item => item.pid).join(',')])
    .then(result => result.stdout, error => error.stdout ?? '')
  const now = new Map(output.split('\n').map(line => /^\s*(\d+) (.*)$/.exec(line)).filter(Boolean)
    .map(([, pid, command]) => [Number(pid), command.trimEnd()]))
  return items.filter(item => now.get(item.pid) === item.command)
}

/**
 * Looks every 50 ms which processes of [tree] still run, until each one ended or `stop` is called. `seen` gives the
 * last time when each one ran, and `ends` the first time when it no longer ran. `ready` resolves after the first look.
 */
function watch(tree) {
  const seen = new Map()
  const ends = new Map()
  let stopped = false
  let looked
  const ready = new Promise(resolve => { looked = resolve })
  const done = (async () => {
    while (!stopped && ends.size < tree.length) {
      const at = Date.now()
      const live = new Set((await running(tree.filter(item => !ends.has(item.pid)))).map(item => item.pid))
      for (const item of tree) {
        if (ends.has(item.pid)) continue
        if (live.has(item.pid)) seen.set(item.pid, at)
        else ends.set(item.pid, Date.now())
      }
      looked()
      await delay(50)
    }
    looked()
  })()
  return { seen, ends, ready, stop: async () => { stopped = true; await done } }
}

/** The processes of [tree] in the order of their ends, each with its times in ms after [from]. */
const endOrder = (tree, { seen, ends }, from) => tree.map(item => ({ pid: item.pid, command: shortCommand(item.command).slice(0, 120),
  lastSeenMs: seen.has(item.pid) ? seen.get(item.pid) - from : null, endedMs: ends.has(item.pid) ? ends.get(item.pid) - from : null }))
  .sort((a, b) => (a.endedMs ?? Infinity) - (b.endedMs ?? Infinity))

/**
 * The processes of [tree] that still run with the same command line 3 seconds after the end of their run. Each one gets
 * SIGKILL, because this run started it and nothing else stops it.
 */
async function survivors(tree) {
  const found = []
  for (const item of tree) {
    if (await commandOf(item.pid) !== item.command) continue
    found.push(shortCommand(item.command))
    try { process.kill(item.pid, 'SIGKILL') }
    catch { /* It ended in the meantime. */ }
  }
  return found
}

/** Waits until each run of [home] ended and was reported, and no new run came for 10 seconds. */
async function settled(home, count, timeoutMs) {
  const end = Date.now() + timeoutMs
  for (let last = -1; ;) {
    const state = await waitState(home, quiet(count + 1), Math.max(1000, end - Date.now()), 'the end of the failed runs')
    if (runsOf(state).length === last) return state
    last = runsOf(state).length
    await delay(10000)
  }
}

/**
 * One case of item 14: one prompt to the main agent, an optional action [during] on the first run, and the evidence of
 * each run that the case made. [check] gives true when the case passes.
 */
async function failureCase(context, view, { item, title, prompt, during, check }) {
  if (!wanted('failures', item)) return undefined
  const count = runsOf(await snapshot(context.home)).length
  const step = await turn(context, view, prompt)
  let action
  if (during) {
    const runId = await view.waitFor(async () => byTitle(await snapshot(context.home), title)[0]?.id, 60000, `the run ${title}`)
    action = await during(runId)
    await waitState(context.home, value => terminalStates.has(value.runs[runId]?.status), 120000, `the end of the run ${title}`)
    await delay(3000)
    action.left = await survivors(action.tree)
    await action.watch?.stop()
  }
  const state = await settled(context.home, count, 600000)
  const made = runsOf(state).slice(count)
  // The ends of the processes of the first run, against the start of its continuation in the same directory.
  const continuation = made.find(run => run.resumeOf === made[0]?.id)
  const order = action?.watch ? endOrder(action.tree, action.watch, action.killedAt) : null
  const beforeContinuation = order && continuation?.startedAt
    ? order.every(entry => entry.lastSeenMs === null || entry.lastSeenMs < continuation.startedAt - action.killedAt) : null
  const runs = await Promise.all(made.map(async run => {
    const facts = await transcript(context.home, run.id)
    const log = await childLog(context.home, run.id)
    return { id: run.id.slice(0, 8), title: run.title, agent: run.agent, status: run.status, error: run.error ?? null,
      autoResume: run.autoResume ?? null, continues: made.find(other => other.id === run.resumeOf)?.id.slice(0, 8) ?? null,
      ms: run.finishedAt && run.startedAt ? run.finishedAt - run.startedAt : null,
      transcript: { exists: facts.exists, ended: facts.ended ?? null, leaks: facts.leaks ?? false },
      errorLeaks: leaks(run.error ?? ''), logLineCount: log.length, agentLineCount: log.filter(line => line.startsWith('  | ')).length,
      log: log.slice(0, 12) }
  }))
  const answer = replies(view.updates.slice(step.from)).map(entry => entry.text).join('\n---\n')
  const logInfo = await stat(join(context.home, 'daemon', 'daemon.log'))
  const evidence = { action: action ? { target: action.target, victim: action.victim, processes: action.tree.length,
    ends: order, continuationStartedMs: continuation?.startedAt ? continuation.startedAt - action.killedAt : null, beforeContinuation,
    refused: await refusals(context.home) } : null,
    survivors: action?.left ?? [], runs, answer: redact(answer), logMode: (logInfo.mode & 0o777).toString(8), leaksInHome: await scanLeaks(context.home, context.log) }
  const verdict = runs.length > 0 ? check(made, runs, evidence) : false
  const safe = evidence.logMode === '600' && !evidence.leaksInHome.length && runs.every(run => !run.errorLeaks && !run.transcript.leaks)
  record(item, verdict === 'not checked' && safe ? verdict : verdict === true && safe ? 'pass' : 'fail', evidence)
  return evidence
}

/** True when [run] holds the answer of the agent to [method] in the log. */
const loggedAnswer = (run, method) => run.log.some(line => line.includes(`answered the request ${method} `))

async function failures() {
  const codex = await makeProject(root, 'fail-codex-model', { 'README.md': 'codex\n' }, { git: true })
  const claude = await makeProject(root, 'fail-claude-model')
  const kill = await makeProject(root, 'fail-kill', {}, { git: true })
  const codexModel = 'openai/gpt-nonexistent-9'
  const claudeModel = 'anthropic/claude-nonexistent-9'
  const context = await setup('failures', { 'children.permissionMode': 'allowEdits' }, {},
    { [codex]: { 'children.codexModel': codexModel }, [claude]: { 'children.claudeModel': claudeModel } })
  const view = await connect(context, [codex, claude, kill])
  const refused = (key, model, method) => (made, runs) => runs.length === 1 && runs[0].status === 'interrupted'
    && runs[0].error === message(key, model) && runs[0].autoResume === false && loggedAnswer(runs[0], method)
  await failureCase(context, view, { item: '14.1 Refused Codex model', title: 'codex model',
    prompt: failurePrompt('Codex', codex, 'codex model', 'Create the file codex.txt with the text hi. Do nothing else.'),
    check: refused('error.childCodexModel', codexModel, 'session/set_config_option') })
  await failureCase(context, view, { item: '14.2 Refused Claude model', title: 'claude model',
    prompt: failurePrompt('Claude', claude, 'claude model', 'Create the file claude.txt with the text hi. Do nothing else.'),
    check: refused('error.childModel', claudeModel, 'session/set_config_option') })
  // After the task: the agent got the prompt, so the error says that the task can have run in part, and a continuation follows.
  const killTask = file => `Run the shell command \`sleep 45\`. Then create the file ${file} with the text done. Do nothing else.`
  // A run with a continuation has the status resumed.
  const afterPrompt = start => (made, runs) => ['interrupted', 'resumed'].includes(runs[0].status) && runs[0].autoResume === true && start.test(runs[0].error ?? '')
    && /after it got the task, so the task can have run in part/.test(runs[0].error ?? '') && runs.some(run => run.continues === runs[0].id)
  // The adapter writes only its debug lines before the signal, and no debug line names a failure, so the error quotes no
  // line of the error output. The log keeps the lines.
  const killedAgent = `${message('error.child.exit.after', message('error.child.signal', 'SIGKILL'))} ${message('error.child.log')}`
  await failureCase(context, view, { item: '14.3 Agent process killed during the task', title: 'killed agent',
    prompt: failurePrompt('Claude', kill, 'killed agent', killTask('agent.txt')), during: runId => killChild(context, view, runId, 'agent'),
    check: afterPrompt(new RegExp(`^${killedAgent.replace(/[.,/]/g, '\\$&')}$`)) })
  // The adapter fails the prompt while the daemon runs, so the supervisor ends each process of the run, also the shell of
  // the Bash tool in its own session. Nothing of the run runs when the continuation starts in the same directory.
  await failureCase(context, view, { item: '14.3b Claude Code process killed during the task', title: 'killed claude',
    prompt: failurePrompt('Claude', kill, 'killed claude', killTask('claude.txt')), during: runId => killChild(context, view, runId, 'claude'),
    check: (made, runs, evidence) => afterPrompt(/^The agent (answered session\/prompt with the error|process ended with)/)(made, runs)
      && !evidence.survivors.length && evidence.action.beforeContinuation === true && !evidence.action.refused.length })
  await view.close()
  await stopDaemon(context.home, context.env)

  // At the start: Megachat did not send the task. Each variant needs its own agent command, so it has its own home.
  const adapter = join(LEASE, 'node_modules', '@agentclientprotocol', 'claude-agent-acp', 'dist', 'index.js')
  const notAFolder = join(root, 'claude-config-file')
  await writeFile(notAFolder, 'not a folder\n', { mode: 0o600 })
  // A Claude Code executable that runs the real one with an option that it does not know, so Claude Code exits at its start.
  const badClaude = join(root, 'claude-unknown-option.sh')
  await writeFile(badClaude, '#!/bin/sh\nexec "$SMOKE_REAL_CLAUDE" --smoke-unknown-option "$@"\n', { mode: 0o700 })
  await chmod(badClaude, 0o700)
  const starts = [
    ['14.4a Claude Code with a configuration folder that is a file', 'config file',
      { command: process.execPath, args: [adapter], env: { CLAUDE_CONFIG_DIR: notAFolder } }],
    ['14.4b Claude Code that exits at its start', 'claude exits',
      { command: '/bin/sh', args: ['-c', 'export SMOKE_REAL_CLAUDE="$CLAUDE_CODE_EXECUTABLE" CLAUDE_CODE_EXECUTABLE="$SMOKE_BAD_CLAUDE"; exec "$@"', 'sh', process.execPath, adapter],
        env: { SMOKE_BAD_CLAUDE: badClaude } }],
    ['14.4c Agent command that exits at its start', 'agent exits',
      { command: process.execPath, args: ['-e', 'process.stderr.write("Error: the agent cannot open its license file /opt/agent/license.\\n"); process.exit(3)'] }],
  ]
  for (const [item, title, command] of starts) {
    if (!wanted('failures', item)) continue
    const name = `failures-${title.replace(' ', '-')}`
    const project = await makeProject(root, name)
    const start = await setup(name, { 'children.permissionMode': 'allowEdits' }, { MEGACHAT_CLAUDE_ACP: JSON.stringify(command) })
    const client = await connect(start, [project])
    await failureCase(start, client, { item, title,
      prompt: failurePrompt('Claude', project, title, 'Create the file start.txt with the text hi. Do nothing else.'),
      // A Claude Code that does not fail with this cause gives no evidence for the case.
      check: (made, runs) => runs[0].status === 'completed' ? 'not checked' : runs.every(run => ['interrupted', 'resumed'].includes(run.status)
        && /so Megachat did not send the task to the agent in this run|before Megachat sent the task, so the agent did not get the task/.test(run.error ?? '')
        && run.error.includes(message('error.child.log')) && !/^Internal error\.?$/.test(run.error))
        && runs.every(run => loggedAnswer(run, 'session/new') || loggedAnswer(run, 'initialize') || run.agentLineCount > 0) })
    await client.close()
    await stopDaemon(start.home, start.env)
  }
}

// Item 15: the processes of a Claude child run at its end (the capability `child-processes`). While the daemon runs, a
// stop of a run ends each process that the run started, also the shell of the Bash tool in its own session. A completed
// run keeps a process that its task left. A child can restart the daemon from its own shell. Each case lists the
// processes of the run, the order of their ends, and the processes that run 3 seconds after the end of the run. A
// process of this smoke run outside the run must still run after the end of the run, and no supervisor may refuse a
// signal (`log.child.refused`).
const LEFT_MS = 3000
/** The longest time from the end of a run to the exit of its supervisor: 6 seconds and a margin for the reads. */
const SUPERVISOR_MS = 6500
const TEMPORARY = realpathSync(tmpdir())

/** The supervisor of the run [runId] and each process under it. The command line must be the one of a supervisor. */
async function runTree(home, runId) {
  const pid = (await snapshot(home)).runs[runId]?.pid
  const list = await processes()
  const supervisor = list.find(item => item.pid === pid)
  if (!pid || !supervisor?.command.includes(join(LEASE, 'src', 'child-supervisor.mjs'))) throw new Error(`The PID of the run ${runId} is not its supervisor`)
  return [supervisor, ...below(list, pid)]
}

/** The process whose PID a command of the child wrote to [file], when that PID runs [command] now. */
async function pidFrom(file, command) {
  const pid = Number((await readText(file))?.trim())
  if (!Number.isSafeInteger(pid) || pid <= 1) return null
  return await commandOf(pid) === command ? { pid, ppid: null, command } : null
}

/** A process of this smoke run outside each child run. The end of a run must not end it. */
function outsider(seconds) {
  const child = spawn('/bin/sleep', [String(seconds)], { detached: true, stdio: 'ignore' })
  child.unref()
  const item = { pid: child.pid, ppid: process.pid, command: `/bin/sleep ${seconds}` }
  leftovers.push(item)
  return item
}

/** A Stop of the row of the run, as the Stop button of Air sends it. */
const stopRow = view => async runId => {
  const row = openRow(view, runId)
  const at = Date.now()
  const answer = await view.stopTask(row.asyncTaskId)
  return { at, facts: { by: 'row', answer, answerMs: Date.now() - at } }
}

/**
 * A cancel through the main agent with `agents_cancel`. The time of the stop is the first look, every 100 ms, that sees
 * the request of the cancel in the state.
 */
const cancelBy = (context, view, title) => async runId => {
  const sentAt = Date.now()
  const pending = turn(context, view, `Cancel the task "${title}" now with the tool agents_cancel. Do not start a task. Answer in one sentence.`)
  for (const end = Date.now() + STALL_MS; Date.now() < end; await delay(100)) {
    if ((await snapshot(context.home)).runs[runId]?.cancelRequested) {
      const at = Date.now()
      return { at, answer: pending, facts: { by: 'agents_cancel', requestMs: at - sentAt } }
    }
  }
  throw new Error(`The main agent did not cancel the run ${title}`)
}

/**
 * One case of item 15: one task of a Claude child in [project]. When the tool call that holds [tool] runs, the case lists
 * the processes of the run and the processes in the files of [extra], and then calls [stop]. Without [stop], the run ends
 * by itself. Each process of the run that still runs after the check gets SIGKILL.
 */
async function processCase(context, view, { item, title, project, task, tool, stop, extra = [] }) {
  if (!wanted('processes', item)) return undefined
  const count = runsOf(await snapshot(context.home)).length
  await turn(context, view, prompts.one(project, title, task))
  const runId = await view.waitFor(async () => byTitle(await snapshot(context.home), title)[0]?.id, 60000, `the run ${title}`)
  await waitForTool(context.home, view, runId, tool)
  // The supervisor reads the process table each second, so its record has the processes of the tool call.
  await delay(3000)
  const tree = await runTree(context.home, runId)
  for (const [file, command] of extra) {
    const found = await pidFrom(join(project, file), command)
    if (found && !tree.some(entry => entry.pid === found.pid)) tree.push(found)
  }
  leftovers.push(...tree)
  const other = outsider(900)
  const refusedBefore = (await refusals(context.home)).length
  const watcher = watch(tree)
  // The first look shows each process of the run before the stop.
  await watcher.ready
  const stopped = stop ? await stop(runId) : {}
  const ended = await waitState(context.home, value => terminalStates.has(value.runs[runId]?.status) ? value.runs[runId] : undefined,
    240000, `the end of the run ${title}`)
  await view.waitFor(() => watcher.ends.has(tree[0].pid) || undefined, 15000, 'the exit of the supervisor').catch(() => {})
  await delay(Math.max(0, ended.finishedAt + LEFT_MS - Date.now()))
  const left = await running(tree)
  await watcher.stop()
  const outsiderRuns = (await running([other])).length === 1
  await survivors([...left, other])
  const refused = (await refusals(context.home)).slice(refusedBefore)
  const answer = stopped.answer ? await stopped.answer : null
  await waitState(context.home, quiet(count + 1), 300000, `the report of the run ${title}`).catch(() => {})
  // The row that ended last. A row of the phase approval ends when its permission request ends.
  const rowEnd = rows(view.updates).filter(row => row.asyncTaskId.startsWith(`${runId}:`) && row.endState)
    .sort((a, b) => a.endedAt - b.endedAt).at(-1)
  const from = stopped.at ?? ended.finishedAt
  const exit = watcher.ends.get(tree[0].pid)
  return { item, status: ended.status, error: redact(ended.error ?? ''), stop: stopped.facts ?? null,
    processes: tree.map(entry => ({ pid: entry.pid, ppid: entry.ppid, command: shortCommand(entry.command).slice(0, 120) })),
    ends: endOrder(tree, watcher, from), left: left.map(entry => shortCommand(entry.command)),
    ms: { from: stop ? 'the stop' : 'the end of the run', toRowEnd: rowEnd ? rowEnd.endedAt - from : null, toRunEnd: ended.finishedAt - from,
      toSupervisorExit: exit ? exit - from : null, supervisorAfterRunEnd: exit ? exit - ended.finishedAt : null },
    outsiderRuns, refused, answer: answer ? excerpt(replies(answer.updates).map(entry => entry.text).join(''), 300) : null }
}

const isShell = entry => /\/(z|ba)?sh /.test(entry.command)
/** True when a stopped run had a shell and [command], and nothing of it ran after the stop. */
const stopEnded = (evidence, command) => evidence.status === 'cancelled' && evidence.processes.some(isShell) && seenFirst(evidence)
  && evidence.processes.some(entry => entry.command === command) && !evidence.left.length && quietEnd(evidence)
/** True when the first look of the watch saw each process of the run. */
const seenFirst = evidence => evidence.ends.every(entry => entry.lastSeenMs !== null)
const quietEnd = evidence => evidence.ms.supervisorAfterRunEnd !== null && evidence.ms.supervisorAfterRunEnd <= SUPERVISOR_MS
  && evidence.outsiderRuns && !evidence.refused.length

const quote = value => `'${String(value).replaceAll("'", `'\\''`)}'`
/**
 * The script that a child runs to restart the daemon of [home]. It refuses each home that is not a home of this smoke run.
 * The variant [dry] only shows the commands. [env] is the environment of the daemon.
 */
function restartScript({ project, home, env, dry }) {
  const variables = Object.entries(env).map(([name, value]) => `${name}=${quote(value)}`).join(' ')
  return `#!/bin/sh
# The live smoke run wrote this script. It restarts the daemon of one temporary home of the run.
trap '' HUP
DIR=${quote(project)}
ROOT=${quote(root)}
HOME_DIR=${quote(home)}
NODE=${quote(process.execPath)}
MAIN=${quote(join(LEASE, 'src', 'main.mjs'))}
${dry ? '' : 'exec >> "$DIR/restart.log" 2>&1'}
case "$ROOT" in ${quote(TEMPORARY)}/megachat-live-*) ;; *) echo "Refused: the root of the run is not in the temporary directory."; exit 2 ;; esac
case "$HOME_DIR" in "$ROOT"/home-*) ;; *) echo "Refused: the home is not below the root of the run."; exit 2 ;; esac
[ -f "$HOME_DIR/settings.json" ] || { echo "Refused: the home has no settings.json."; exit 2; }
[ -x "$NODE" ] && [ -f "$MAIN" ] || { echo "Refused: node or main.mjs is missing."; exit 2; }
if [ -e "$DIR/restarted.txt" ]; then echo "The daemon restarted before. Nothing to do."; exit 0; fi
daemon() { ${dry ? 'echo "would run:"' : `env -i ${variables}`} "$NODE" "$MAIN" "$1" "$HOME_DIR"; }
daemon stop || { echo "The stop failed."; exit 1; }
sleep 1
daemon start || { echo "The start failed."; exit 1; }
${dry ? 'echo "would write: $DIR/restarted.txt"' : 'date > "$DIR/restarted.txt"; echo "The daemon restarted."'}
`
}

const runOf = (sh, file) => execute(sh, [file]).then(result => ({ code: 0, output: result.stdout + result.stderr }),
  error => ({ code: error.code, output: `${error.stdout ?? ''}${error.stderr ?? ''}` }))
/** The PID of the daemon of [home] from its connection file. Only the PID leaves this function. */
async function daemonPid(home) {
  try { return JSON.parse(await readFile(join(home, 'daemon', 'connection.json'), 'utf8')).pid ?? null }
  catch { return null }
}
/** The PIDs of each Megachat daemon on the machine that does not run from this checkout. Read only. */
const otherDaemons = async () => (await processes()).filter(entry => /\.m?js daemon( |$)/.test(entry.command) && !entry.command.includes(LEASE))
  .map(entry => entry.pid).sort((a, b) => a - b)
// True when the run must stop: a daemon that does not belong to this run changed.
let abort = false

/**
 * Item 15.5: a child runs a script that stops and starts the daemon of its home. A stop of the daemon keeps the
 * processes of its runs, so the shell of the script lives on, the start runs, and the run gets its continuation. A dry
 * run of the script shows each path first, and a variant with the shared home of the user must refuse.
 */
async function daemonRestartCase(context, view, project) {
  const item = '15.5 A child restarts the daemon'
  if (!wanted('processes', item)) return
  const main = join(LEASE, 'src', 'main.mjs')
  await writeFile(join(project, 'restart.sh'), restartScript({ project, home: context.home, env: context.env, dry: false }), { mode: 0o700 })
  const dryFile = join(root, 'restart-dry.sh')
  const wrongFile = join(root, 'restart-wrong.sh')
  await writeFile(dryFile, restartScript({ project, home: context.home, env: {}, dry: true }), { mode: 0o700 })
  await writeFile(wrongFile, restartScript({ project, home: join(homedir(), '.jetbrains', 'air', 'megachat'), env: {}, dry: true }), { mode: 0o700 })
  const dry = await runOf('/bin/sh', dryFile)
  const wrong = await runOf('/bin/sh', wrongFile)
  const line = command => `would run: ${process.execPath} ${main} ${command} ${context.home}`
  const dryOk = dry.code === 0 && dry.output.includes(line('stop')) && dry.output.includes(line('start')) && wrong.code === 2
    && !wrong.output.includes('would run')
  const lines = text => text.split('\n').filter(Boolean).map(shortCommand)
  const dryFacts = { dry: { code: dry.code, output: lines(dry.output) }, sharedHome: { code: wrong.code, output: lines(wrong.output) } }
  if (!dryOk) { record(item, 'fail', { reason: 'The dry run of the script did not show the right paths.', ...dryFacts }); return }
  const othersBefore = await otherDaemons()
  const oldPid = await daemonPid(context.home)
  const count = runsOf(await snapshot(context.home)).length
  await turn(context, view, prompts.one(project, 'daemon restart', 'Run the shell command `sh restart.sh` in this project one time. Do not run it again, and do nothing else.'))
  const runId = await view.waitFor(async () => byTitle(await snapshot(context.home), 'daemon restart')[0]?.id, 60000, 'the run daemon restart')
  const marker = await view.waitFor(() => existsSync(join(project, 'restarted.txt')) || undefined, 300000, 'the marker of the restart').catch(() => false)
  const daemonCommand = `${process.execPath} ${main} daemon ${context.home}`
  const newPid = marker ? await view.waitFor(async () => {
    const pid = await daemonPid(context.home)
    return pid && pid !== oldPid && await commandOf(pid) === daemonCommand ? pid : undefined
  }, 30000, 'the new daemon').catch(() => null) : null
  const othersAfter = await otherDaemons()
  const sameOthers = othersBefore.join() === othersAfter.join()
  const log = (await readText(join(project, 'restart.log'))) ?? ''
  if (!sameOthers) {
    abort = true
    record(item, 'fail', { reason: 'A Megachat daemon outside this run changed. The run stops.', before: othersBefore.length, after: othersAfter.length })
    return
  }
  await view.close()
  const after = await connect(context, [project], { name: 'view after the restart by the child', sessionId: view.sessionId })
  const state = await waitState(context.home, quiet(count + 2), 480000, 'the continued task').catch(() => snapshot(context.home))
  const runs = byTitle(state, 'daemon restart')
  const first = state.runs[runId]
  const next = runs.find(entry => entry.resumeOf === runId)
  const refused = await refusals(context.home)
  const facts = await Promise.all(runs.map(entry => transcript(context.home, entry.id)))
  await after.close()
  const ok = Boolean(marker) && Boolean(newPid) && first?.status === 'resumed' && next?.status === 'completed' && !refused.length
  record(item, ok ? 'pass' : 'fail', { ...dryFacts, marker: Boolean(marker), daemonAgain: Boolean(newPid), otherDaemons: othersAfter.length,
    otherDaemonsUnchanged: sameOthers, scriptLog: lines(log),
    first: { status: first?.status, error: redact(first?.error ?? '') },
    continuation: next ? { status: next.status, output: excerpt(next.output ?? '', 300) } : null, runs: runs.length, refused,
    transcripts: facts.map(entry => excerpt((entry.text ?? '').split('\n').slice(-6).join('\n'), 600)) })
}

async function runProcesses() {
  const projects = {}
  for (const name of ['row', 'cancel', 'background', 'completed', 'restart']) projects[name] = await makeProject(root, `processes-${name}`)
  const context = await setup('processes', { 'children.permissionMode': 'allowEdits', 'children.daemonRestart': 'allow' })
  const view = await connect(context, Object.values(projects))
  const row = await processCase(context, view, { item: '15.1 Stop of a row during a shell command', title: 'row sleep', project: projects.row,
    task: 'Run the shell command `sleep 120`. Then create the file row.txt with the text row.', tool: 'sleep', stop: stopRow(view) })
  if (row) record(row.item, stopEnded(row, 'sleep 120') ? 'pass' : 'fail', row)
  const cancel = await processCase(context, view, { item: '15.2 agents_cancel during a shell command', title: 'cancel sleep',
    project: projects.cancel, task: 'Run the shell command `sleep 120`. Then create the file cancel.txt with the text cancel.', tool: 'sleep',
    stop: cancelBy(context, view, 'cancel sleep') })
  if (cancel) record(cancel.item, stopEnded(cancel, 'sleep 120') ? 'pass' : 'fail', cancel)
  // The first command leaves a process at once, which the spec does not cover. The second one leaves a process while its
  // shell still runs for 3 seconds, so the record has it.
  const background = await processCase(context, view, { item: '15.3 Stop of a row with background commands', title: 'background sleep',
    project: projects.background, task: 'Run these three shell commands, each one as its own Bash tool call, in this order: first `nohup sleep 303 > /dev/null 2>&1 & echo $! > fast.pid`, then `nohup sleep 313 > /dev/null 2>&1 & echo $! > slow.pid; sleep 3`, then `sleep 60`. After that, create the file bg.txt with the text bg.',
    tool: 'sleep 60', stop: stopRow(view), extra: [['fast.pid', 'sleep 303'], ['slow.pid', 'sleep 313']] })
  if (background) {
    const state = command => !background.processes.some(entry => entry.command === command) ? 'not found'
      : background.left.includes(command) ? 'survived' : 'ended'
    background.observed = { leftAtOnce: state('sleep 303'), leftAfterRead: state('sleep 313') }
    const ok = background.status === 'cancelled' && background.observed.leftAfterRead === 'ended' && seenFirst(background)
      && !background.left.some(command => command !== 'sleep 303') && quietEnd(background)
    record(background.item, ok ? 'pass' : 'fail', background)
  }
  const completed = await processCase(context, view, { item: '15.4 A completed run keeps a process of its task', title: 'keep sleep',
    project: projects.completed, task: 'Run the shell command `nohup sleep 304 > /dev/null 2>&1 & echo $! > bg.pid; sleep 8`. Then create the file done.txt with the text done. Do nothing else.',
    tool: 'sleep 304', extra: [['bg.pid', 'sleep 304']] })
  if (completed) {
    const ok = completed.status === 'completed' && completed.processes.some(entry => entry.command === 'sleep 304')
      && completed.left.includes('sleep 304') && quietEnd(completed)
    record(completed.item, ok ? 'pass' : 'fail', completed)
  }
  await daemonRestartCase(context, view, projects.restart)
  await view.close()
  await stopDaemon(context.home, context.env)
}

/** The files in [home] and the log of the client that hold a value or an address of Central. */
async function scanLeaks(home, ...files) {
  const found = []
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (leaks((await readFile(path)).toString('latin1'))) found.push(path.replace(home, '<home>'))
    }
  }
  await walk(home)
  for (const file of files) if (leaks(await readText(file) ?? '')) found.push(file.replace(root, '<root>'))
  return found
}

async function spend() {
  let usd = 0
  let piUsd = 0
  for (const { home } of homes) {
    try {
      const data = JSON.parse(await readFile(join(home, 'spend.json'), 'utf8'))
      usd += data.usd ?? 0
      piUsd += data.piUsd ?? 0
    }
    catch { /* A home without a model request has no file. */ }
  }
  return { usd: Number(usd.toFixed(4)), piUsd: Number(piUsd.toFixed(4)) }
}

const scenarios = { chat, suggest, rules, permissions, tasks, steer, others, workday, restart, twotools, withdraw, waiting, failures,
  processes: runProcesses }
try {
  for (const name of selected) {
    if (abort) break
    say(`Scenario ${name} starts at ${new Date().toISOString().slice(11, 19)}.`)
    try { await scenarios[name]() }
    catch (error) { record(`scenario ${name}`, 'fail', { error: redact(error.stack ?? error.message) }) }
  }
}
finally {
  const killed = await survivors(leftovers).catch(() => [])
  if (killed.length) say(`The run ended ${killed.length} processes of its children that still ran: ${killed.join('; ')}`)
  for (const { home, env } of homes) await stopDaemon(home, env).catch(() => {})
  // Each file of the run: the homes, the projects, the logs of the clients and of the tap.
  const leaked = (await scanLeaks(assertTemporary(root))).map(path => path.replace(root, '<root>'))
  const total = await spend()
  const report = { root, results, stalls, leaks: leaked, spend: total }
  await writeFile(join(root, 'report.json'), redact(JSON.stringify(report, null, 1)), { mode: 0o600 })
  say(`Spend of the main agent and the pi children in the daemon count: ${total.usd} USD (pi ${total.piUsd} USD).`)
  say(`Turns that stalled: ${stalls.length}.`)
  say(`Files with a value of Central: ${leaked.length}. The report is in ${join(root, 'report.json')}.`)
}

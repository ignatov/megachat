#!/usr/bin/env node
// The live smoke run: the daemon of this checkout with the real main agent through Central, real Claude, Codex and pi
// children, and a scripted ACP client that sends what Air sends. Each scenario has its own temporary state home and its
// own throwaway projects. The run costs real money. See the section about the live smoke run in `README.md`.
//
// Usage: node test/live/smoke.mjs [<scenario>...]
// The scenarios are chat, suggest, rules, permissions, tasks, steer, others, workday, restart, twotools, withdraw and
// waiting. Without a name, all of them run.
import { existsSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  assertTemporary, daemonEnvironment, daemonOf, delay, LEASE, leaks, LiveClient, loadSecrets, makeHome, makeProject, makeRoot,
  redact, replies, stopDaemon, suggestions, writeSettings,
} from './live-client.mjs'

const { terminalStates } = await import(join(LEASE, 'src', 'MegachatState.mjs'))
const SCENARIOS = ['chat', 'suggest', 'rules', 'permissions', 'tasks', 'steer', 'others', 'workday', 'restart', 'twotools',
  'withdraw', 'waiting']
const selected = process.argv.slice(2).length ? process.argv.slice(2) : SCENARIOS
for (const name of selected) if (!SCENARIOS.includes(name)) throw new Error(`Unknown scenario ${name}`)

await loadSecrets()
const root = await makeRoot()
const homes = []
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

/** Starts a home with [values] and gives its environment. */
async function setup(name, values, extra = {}) {
  const home = await makeHome(root, name, { 'keepAlive.enabled': false, ...values })
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
  const queuedStop = await view.stopTask(queued.asyncTaskId)
  const queuedEnd = await view.waitFor(() => rows(view.updates).find(row => row.asyncTaskId === queued.asyncTaskId && row.endState), 30000, 'the end of the row of B2')
  // The running row of A, while its command runs.
  const toolLine = await waitForTool(context.home, view, ids.A, 'sleep')
  await delay(3000)
  const running = openRow(view, ids.A)
  const transcriptA = await transcript(context.home, ids.A)
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
  record('5 Task rows, Stop, transcript', rowsOk && fileOk && stopOk && !homeLeaks.length ? 'pass' : 'fail', {
    rows: allRows.map(row => ({ id: row.asyncTaskId.replace(/^[0-9a-f-]{36}/, short => keyOf(ids, short)), name: row.name, description: row.description,
      canStop: row.canStop, outputFilePath: row.outputFilePath ? row.outputFilePath.replace(context.home, '<home>') : null, spawned: iso(row.spawnedAt),
      end: row.endState ?? null, ended: iso(row.endedAt) })),
    transcriptOfA: { mode: transcriptA.mode, directoryMode: transcriptA.directoryMode, bytes: transcriptA.bytes, toolLines: transcriptA.tools,
      endedLine: finalTranscriptA.ended, leaks: transcriptA.leaks, toolLine: redact(toolLine), excerpt: excerpt(finalTranscriptA.text ?? '', 1500) },
    stops: { running: runningStop, runningEnd: runningEnd.endState, queued: queuedStop, queuedEnd: queuedEnd.endState },
    statuses: Object.fromEntries(Object.keys(ids).map(key => [key, run(key).status])), startedAgain: later.length, files,
    reports: reports.slice(1).map(text => excerpt(text, 500)), leaksInHome: homeLeaks })

  const times = Object.fromEntries(Object.keys(ids).map(key => [key, { started: iso(run(key).startedAt), finished: iso(run(key).finishedAt) }]))
  const overlap = run('A').startedAt < run('B').finishedAt && run('B').startedAt < run('A').finishedAt
  const sameAfter = run('A2').startedAt >= run('A').finishedAt
  const insideAfter = run('sub').startedAt >= run('A').finishedAt && run('sub').startedAt >= Math.min(run('A2').finishedAt, Infinity)
  record('6 Parallel children', overlap && sameAfter && insideAfter ? 'pass' : 'fail', { times, overlap, sameDirectoryAfter: sameAfter, insideDirectoryAfter: insideAfter })
}
const keyOf = (ids, value) => Object.entries(ids).find(([, id]) => id === value)?.[0] ?? '<run>'

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
  const stoppedAt = Date.now()
  const stop = await stopDaemon(context.home, context.env)
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
  await view.close()
  await stopDaemon(context.home, context.env)
  const ok = stop.stopped && first?.status === 'resumed' && next?.status === 'completed' && file?.trim() === 'r'
  record('10 Restart', ok ? 'pass' : 'fail', { daemonStopped: stop.stopped, stoppedAt: iso(stoppedAt), clientExit,
    first: { status: first?.status, finished: iso(first?.finishedAt), error: redact(first?.error ?? ''), resumedBy: Boolean(first?.resumedBy) },
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
/** The lines of the daemon log of [home] that tell of a write of the guard against a lost wake-up of the scheduler. */
const wakeWrites = async home => ((await readText(join(home, 'daemon', 'daemon.log'))) ?? '').split('\n')
  .filter(line => /wrote its record again/.test(line)).length

// Item 11: one reply of the main agent with two tool calls, in three turns in a row. Each turn must end. Before the
// guard of `src/SchedulerWake.mjs`, the step that waits for its tool calls could lose its wake-up, and the turn then
// had no end.
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
  const guardWrites = await wakeWrites(context.home)
  await view.close()
  await stopDaemon(context.home, context.env)
  const ended = steps.every(step => !step.stalled && step.stopReason === 'end_turn')
  const parallel = steps.every(step => step.twoInOneReply)
  record('11 Two tool calls in one reply', ended && parallel ? 'pass' : 'fail', { everyTurnEnded: ended, twoCallsInEachTurn: parallel,
    guardWrites, steps })
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

const scenarios = { chat, suggest, rules, permissions, tasks, steer, others, workday, restart, twotools, withdraw, waiting }
try {
  for (const name of selected) {
    say(`Scenario ${name} starts at ${new Date().toISOString().slice(11, 19)}.`)
    try { await scenarios[name]() }
    catch (error) { record(`scenario ${name}`, 'fail', { error: redact(error.stack ?? error.message) }) }
  }
}
finally {
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

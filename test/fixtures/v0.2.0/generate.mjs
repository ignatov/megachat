// Makes the fixture of `test/upgrade.test.mjs`: state directories that the code of the release v0.2.0 wrote.
//
// To make the fixture again, from the root of the repository:
//
//   mkdir /tmp/megachat-v0.2.0 && git archive v0.2.0 | tar -x -C /tmp/megachat-v0.2.0
//   ln -s "$PWD/node_modules" /tmp/megachat-v0.2.0/node_modules
//   node test/fixtures/v0.2.0/generate.mjs /tmp/megachat-v0.2.0
//   rm -rf /tmp/megachat-v0.2.0
//
// The link is correct only while v0.2.0 and this checkout have the same dependencies. Else run `npm ci` in the export.
// The script runs the service of v0.2.0 with a fake model and with the fake agent of v0.2.0. It needs no network and no
// account. It writes `close/` and `kill/` next to itself, each with `conversation.sqlite.gz` and `search.sqlite.gz`.
// In `close/`, the service stopped with `close()`, as a daemon stops. In `kill/`, the process got SIGKILL.
//
// The service of v0.2.0 works in the directory WORKSPACE. The fixture keeps that path, and the test replaces it in
// `conversation.sqlite` with a new directory (see `replaceText`). Only one copy of this script can run at a time.
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'

/** The workspace of the service of v0.2.0, as the state stores it. */
export const WORKSPACE = '/tmp/megachat-upgrade-fixture/workspace'
/** The model of the root conversation. Its small window lets Pi Durable write a summary after a long turn. */
export const MODEL = { provider: 'faux', modelId: 'main' }
/** A word of the first turn. The summary replaced that turn in the model context, but the search finds it. */
export const EARLY_WORD = 'marigold'
/** The files of the state directory in the fixture. */
export const FILES = ['conversation.sqlite', 'search.sqlite']
const here = fileURLToPath(new URL('.', import.meta.url))

/**
 * Replaces [from] with [to] in each text column of each table of the database [path]. Pi Durable keeps each document,
 * each revision and each entry as JSON text, and the text has no checksum. So the result is valid JSON when [from] and
 * [to] need no escape in JSON.
 */
export function replaceText(path, from, to) {
  const database = new DatabaseSync(path)
  try {
    const tables = database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    for (const { name } of tables) {
      for (const { name: column } of database.prepare(`PRAGMA table_info("${name}")`).all()) {
        database.prepare(`UPDATE "${name}" SET "${column}" = replace("${column}", ?, ?) WHERE typeof("${column}") = 'text' AND instr("${column}", ?) > 0`)
          .run(from, to, from)
      }
    }
  }
  finally { database.close() }
}

/** Moves the content of the journal into the database file and removes the free pages. The data does not change. */
function compact(path) {
  const database = new DatabaseSync(path)
  try { database.exec('PRAGMA wal_checkpoint(TRUNCATE); VACUUM;') }
  finally { database.close() }
}

async function main() {
  const [source, worker, ...rest] = process.argv.slice(2)
  if (!source) throw new Error('Give the directory of the export of v0.2.0.')
  if (worker === '--worker') return run(source, ...rest)
  for (const mode of ['close', 'kill']) {
    const state = await mkdtemp(join(tmpdir(), 'megachat-v020-'))
    try {
      await rm(WORKSPACE, { recursive: true, force: true })
      await mkdir(WORKSPACE, { recursive: true })
      await writeFile(join(WORKSPACE, 'notes.md'), '# Notes\n\nThe parser reads one line at a time.\n')
      const child = fork(fileURLToPath(import.meta.url), [source, '--worker', state, mode], { stdio: 'inherit' })
      const [code, signal] = await once(child, 'exit')
      if (mode === 'close' ? code !== 0 : signal !== 'SIGKILL') throw new Error(`The worker of ${mode} ended with ${code ?? signal}.`)
      const target = join(here, mode)
      await rm(target, { recursive: true, force: true })
      await mkdir(target)
      for (const name of FILES) {
        compact(join(state, name))
        await writeFile(join(target, `${name}.gz`), gzipSync(await readFile(join(state, name)), { level: 9 }))
      }
    }
    finally {
      await rm(state, { recursive: true, force: true })
      await rm(join(WORKSPACE, '..'), { recursive: true, force: true })
    }
  }
}

/** Runs the service of v0.2.0 in [state], and stops it as [mode] says. */
async function run(source, state, mode) {
  const load = path => import(pathToFileURL(join(source, path)).href)
  const { BACKGROUND_CONTEXT } = await import('@earendil-works/chord/context')
  const { createModels } = await import('@earendil-works/pi-ai/models')
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import('@earendil-works/pi-ai/providers/faux')
  const { openNodeSqliteStorage } = await import('@earendil-works/pi-durable/storage/sqlite/node')
  const { PiMegachatService } = await load('src/PiMegachatService.mjs')
  const { AcpRunService } = await load('src/AcpRunService.mjs')
  const { terminalStates } = await load('src/MegachatState.mjs')
  const { waitForState } = await load('src/waitForState.mjs')

  const call = (...calls) => fauxAssistantMessage(calls.map(([name, args]) => fauxToolCall(name, args)), { stopReason: 'toolUse' })
  const replies = []
  const fake = fauxProvider({ models: [{ id: MODEL.modelId, contextWindow: 60000, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] })
  fake.setResponses(Array(200).fill(request => {
    // The summary request of Pi Durable has a system message with a text. A request of the main agent has sections.
    if (request.messages.some(item => item.role === 'system' && !item.sections && item.content))
      return fauxAssistantMessage('Summary of the earlier turns: the user greeted, and a child summarized notes.md.')
    const reply = replies.shift()
    if (!reply) throw new Error('No reply is queued.')
    return reply
  }))
  const models = createModels()
  models.setProvider(fake.provider)
  // The service of v0.2.0 reads no session of an agent with an empty map of session providers. A report that failed
  // waits 1 minute for its repeat, so the repeat is due when a test opens the fixture, and not before the stop.
  const service = await PiMegachatService.open(await openNodeSqliteStorage(join(state, 'conversation.sqlite')), models, MODEL, {},
    { searchPath: join(state, 'search.sqlite'), reportRetryDelayMs: 60000 })
  await service.search.catchUp()
  const children = new AcpRunService(service.state, { childLaunch: async () => ({ env: process.env }) },
    { args: [join(source, 'test', 'fake-acp.mjs')], deadlineMs: 600000 })
  await children.start()
  await service.resume()
  await service.state.addWorkspace(WORKSPACE)
  const until = select => waitForState(service.state, select, { timeoutMs: 30000 })
  const idle = () => until(value => value.current === null ? value : undefined)
  const settled = () => until(value => !value.current
    && Object.values(value.runs).every(item => terminalStates.has(item.status) && (item.reported || item.reportAfter)) ? value : undefined)
  const say = async (id, text, ...answers) => {
    replies.push(...answers)
    await service.submit(id, text)
    await idle()
  }

  await say('user-1', `Hello. Remember the word ${EARLY_WORD} for later.`, fauxAssistantMessage(`Hello. I keep the word ${EARLY_WORD}.`))
  // A change of the project starts an event turn. Megachat has no project events now, and the upgrade test proves
  // that this event turn stays readable.
  replies.push(fauxAssistantMessage('The notes changed. Nothing to do.'))
  await service.state.projectChanged({ cwd: WORKSPACE, revision: 'revision-1', paths: ['notes.md'] })
  await until(value => !value.current
    && Object.entries(value.inputs).some(([key, input]) => key.startsWith('project:') && input.status === 'completed') ? value : undefined)
  // A child task that completes, and the report of its result.
  await say('user-2', 'Summarize notes.md in the workspace.',
    call(['agents_spawn', { cwd: WORKSPACE, prompt: 'Summarize notes.md', title: 'Notes summary' }]),
    fauxAssistantMessage('I started a task for the summary.'), fauxAssistantMessage('The summary task finished.'))
  await settled()
  // A suggestion that waits for the answer of the user.
  await say('user-3', 'What is next?', call(['agents_suggest', { proposal: 'Add a test for the parser.' }]),
    fauxAssistantMessage('I suggest a test for the parser.'))
  // A long turn. After it, Pi Durable writes a summary of the older turns in the background.
  const design = Array.from({ length: 1500 }, (_, index) => `Line ${index} of the design text: the parser reads one line at a time.`)
  await say('user-4', `Keep this design text.\n${design.join('\n')}`, fauxAssistantMessage('I keep the design text.'))
  await say('user-5', 'Thank you.', fauxAssistantMessage('You are welcome.'))
  await until(async () => (await service.root.entries({ order: 'ascending' }, 500, undefined, BACKGROUND_CONTEXT))
    .items.some(entry => entry.head !== undefined) ? true : undefined)
  // A child task that completes. The model fails at its report, so the report waits for its repeat.
  await say('user-6', 'Count the words of notes.md.',
    call(['agents_spawn', { cwd: WORKSPACE, prompt: 'Count the words of notes.md', title: 'Word count' }]),
    fauxAssistantMessage('I started a task for the count.'),
    fauxAssistantMessage('', { stopReason: 'error', errorMessage: 'The model is overloaded.' }))
  await settled()
  // A task that asks for a permission. The daemon of v0.2.0 runs one child at a time, so this task keeps the slot.
  await say('user-7', 'Write the changelog.', call(['agents_spawn', { cwd: WORKSPACE, prompt: 'approval', title: 'Changelog' }]),
    fauxAssistantMessage('I started a task for the changelog.'))
  await until(value => Object.values(value.permissions).find(item => item.status === 'pending'))
  // Two tasks that wait for the slot. The fake agent of the new code waits for a steer at the prompt `steer`.
  await say('user-8', 'Add a steer test and check the links.',
    call(['agents_spawn', { cwd: WORKSPACE, prompt: 'steer', title: 'Steer test' }],
      ['agents_spawn', { cwd: WORKSPACE, prompt: 'Check the links in notes.md', title: 'Link check' }]),
    fauxAssistantMessage('I started two tasks.'))
  if (mode === 'kill') {
    // A daemon of v0.2.0 that started the link check before a kill has these records. The fake agent cannot be in two
    // tasks at a time, so the script writes the records of the run service.
    const { id } = Object.values((await service.state.snapshot()).runs).find(item => item.title === 'Link check')
    await service.state.transition(id, ['admitted'], { status: 'launching', generation: 'generation-of-the-killed-daemon' })
    await service.state.transition(id, ['launching'], { pid: 999999 })
    await service.state.transition(id, ['launching'], { providerSessionId: 'link-session', status: 'ready' })
    await service.state.transition(id, ['ready'], { status: 'dispatched' })
    process.kill(process.pid, 'SIGKILL')
  }
  await children.close()
  await service.close()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()

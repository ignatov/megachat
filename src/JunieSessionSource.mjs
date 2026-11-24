import { basename, dirname, join, sep } from 'node:path'
import { entryOf, lineKey, readSmall, timeOf, TITLE_RANK } from './SessionLog.mjs'

/** The name of the event log in the folder of a session. */
const LOG = 'events.jsonl'
/** The file of a session folder with the project directory and the title, and its size limit. It has about 1 KB. */
const SUMMARY = 'summary.json'
const SUMMARY_LIMIT = 64 * 1024
/** The file of Junie with one line for each session of the machine, and its size limit. A line has about 200 bytes. */
const INDEX = 'index.jsonl'
const INDEX_LIMIT = 4 * 1024 * 1024
/**
 * The file of Air with the archive state of the sessions of Junie, next to `index.jsonl`, and its size limit. "Done" of
 * Air adds one line of about 150 bytes for a session, and a restore adds one more. The last line of a session and its
 * project directory tells its state (`JunieSessionSource.kt` of Air).
 */
const ARCHIVE_STATE = 'agent-workbench-archive-state.jsonl'
const ARCHIVE_STATE_LIMIT = 16 * 1024 * 1024
/** A project directory as the index of Junie gives it: without a separator at its end. */
const directory = value => text(value).replace(/(.)[/\\]+$/, '$1')
/** The blocks of a turn that give a tool entry at their end. Each one has a `stepId` and a `status`. */
const TOOL_BLOCKS = new Set(['TerminalBlockUpdatedEvent', 'ToolBlockUpdatedEvent', 'ViewFilesBlockUpdatedEvent', 'FileChangesBlockUpdatedEvent',
  'McpBlockUpdatedEvent'])

const text = value => typeof value === 'string' ? value : ''
/** The relative paths of the files of a file view or of a file change, one in each line. */
const paths = (items, name) => Array.isArray(items) ? items.map(item => text(item?.[name])).filter(Boolean).join('\n') : ''

/** The parts of the text of a tool entry: the command or the text of the block, then its output. */
function toolParts(kind, block) {
  if (kind === 'TerminalBlockUpdatedEvent') return [text(block.command), text(block.output) || text(block.presentableOutput)]
  if (kind === 'ToolBlockUpdatedEvent') return [text(block.text), text(block.details), text(block.output)]
  if (kind === 'ViewFilesBlockUpdatedEvent') return [text(block.details), paths(block.files, 'relativePath')]
  // The lines of a change hold the content of a file, so the entry names only the paths.
  if (kind === 'FileChangesBlockUpdatedEvent') return [text(block.details), paths(block.changes, 'afterRelativePath') || paths(block.changes, 'beforeRelativePath')]
  return [`${text(block.toolName)} ${text(block.input)}`.trim(), text(block.details)]
}

/**
 * The sessions of Junie: `<root>/<session ID>/events.jsonl`, with `~/.junie/sessions` as the root. The name of the
 * folder is the session ID. The event log holds no project directory, so [describe] reads it from `summary.json` of
 * the folder, else from the line of the session in `index.jsonl` of Junie. Megachat opens each file read-only.
 *
 * A line of the log is one event with `kind` and `timestampMs`. A `SessionA2uxEvent` holds an event of the agent
 * (`event.agentEvent`) and the state of the session at that event (`event.state`). Junie writes a block of a turn 1
 * to 10 times with the same `stepId`: while it works, at its end, and again after the end of the turn. So the key of
 * an entry is the step ID: the index keeps the first entry of a key, and a copy of the block in a fork is the same
 * entry. The format is no public contract of Junie: a line that the parser does not know gives nothing.
 */
export class JunieSessionSource {
  constructor({ home }) {
    this.agent = 'junie'
    this.root = join(home, '.junie', 'sessions')
  }

  /** Each session file of the machine: the event log of each folder that has one. */
  async all(fs) {
    const files = []
    for (const entry of await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue
      const path = join(this.root, entry.name, LOG)
      if (await fs.stat(path).then(stat => stat.isFile(), () => false)) files.push({ path })
    }
    return files
  }

  /** The path names no project, so each session file can belong to a listed directory: only [describe] tells it. */
  files(directories, fs) { return this.all(fs) }

  matches(path) {
    const parts = path.split(sep)
    return parts.length === 2 && parts[1] === LOG
  }

  relevant(path) { return this.matches(path) }

  nameId(path) { return basename(dirname(path)) }

  /**
   * The session data that the files next to the log at [path] hold, as `meta` of [parse]: the session ID, the project
   * directory as `cwd`, the start time, and the task name as a title of the agent. `summary.json` of the folder comes
   * first, then the newest line of the session in `index.jsonl`. A file that Megachat cannot read gives nothing, so
   * a session without both has no `cwd` and is a session of no listed directory.
   */
  async describe(path, fs) {
    const sessionId = this.nameId(path)
    const record = await this.#summary(path, fs) ?? await this.#indexLine(sessionId, fs)
    const cwd = directory(record?.projectDir)
    const title = text(record?.taskName).trim()
    return { sessionId, ...(cwd ? { cwd } : {}), ...(timeOf(record?.createdAt) !== undefined ? { startedAt: timeOf(record.createdAt) } : {}),
      ...(title ? { title, titleRank: TITLE_RANK.agent } : {}), ...(timeOf(record?.updatedAt) !== undefined ? { updatedAt: timeOf(record.updatedAt) } : {}) }
  }

  /** The path of the archive state file of Air. Megachat adds a line to it for a hide and for a restore. */
  get archiveFile() { return join(this.root, ARCHIVE_STATE) }

  /**
   * The archive state of the session [sessionId] of the project directory [cwd]: the value of `archived` in its last
   * line in the archive state file of Air, or undefined without such a line or without a file that Megachat can read.
   * Without [cwd], the last line of the session ID counts.
   */
  async archived(sessionId, cwd, fs) {
    let state
    try {
      for (const line of (await readSmall(fs, this.archiveFile, ARCHIVE_STATE_LIMIT)).split('\n')) {
        if (!line.includes(sessionId)) continue
        let value
        try { value = JSON.parse(line) }
        catch { continue }
        if (value?.sessionId === sessionId && typeof value.archived === 'boolean' && (!cwd || directory(value.projectDir) === cwd)) state = value.archived
      }
    }
    catch { /* No archive state file: no session of Junie is archived. */ }
    return state
  }

  /**
   * One line of the archive state file, in the format of Air: `sessionId`, `updatedAt`, `projectDir` and `archived`, in
   * this order. `updatedAt` is the time [now], or the `updatedAt` of the session when that is later, as Air writes it.
   */
  archiveLine({ sessionId, cwd, archived, updatedAt, now }) {
    return `${JSON.stringify({ sessionId, updatedAt: Math.max(now, updatedAt ?? 0), projectDir: directory(cwd), archived })}\n`
  }

  async #summary(path, fs) {
    try {
      const value = JSON.parse(await readSmall(fs, join(dirname(path), SUMMARY), SUMMARY_LIMIT))
      return value && typeof value === 'object' && typeof value.projectDir === 'string' ? value : undefined
    }
    catch { return undefined }
  }

  /** The line of [sessionId] in `index.jsonl` with the newest `updatedAt`. Junie adds a line at each change. */
  async #indexLine(sessionId, fs) {
    let found
    try {
      for (const line of (await readSmall(fs, join(this.root, INDEX), INDEX_LIMIT)).split('\n')) {
        if (!line.includes(sessionId)) continue
        let value
        try { value = JSON.parse(line) }
        catch { continue }
        if (value?.sessionId === sessionId && typeof value.projectDir === 'string' && !(found?.updatedAt > value.updatedAt)) found = value
      }
    }
    catch { /* No index of Junie, or one that Megachat cannot read. */ }
    return found
  }

  /**
   * One line of the event log. The steps follow the state of the session: a message of the user gives `prompt`, an
   * event of the agent in the state `IN_PROGRESS` gives `open`, the result of a turn gives `reply`, and the end of a
   * turn gives `end`. In the state `INPUT_REQUIRED`, a command block with an approval request gives `permission`, and a
   * question to the user gives `question`. Junie writes a tip every half minute while it waits, so each other event
   * in that state changes no step. `stepAt` is the time of the line of a step, so a reader knows the start of a wait.
   */
  parse(value, line, path) {
    const time = timeOf(value.timestampMs)
    const meta = time === undefined ? undefined : { startedAt: time }
    const result = (entry, step, more) => ({ ...(more || meta ? { meta: { ...meta, ...more } } : {}), ...(entry ? { entry } : {}),
      ...(step ? { step, ...(time === undefined ? {} : { stepAt: time }) } : {}) })
    switch (value.kind) {
      case 'UserPromptEvent':
        return result(entryOf(typeof value.requestId === 'string' && value.requestId ? value.requestId : lineKey(line), 'user', undefined, time,
          [text(value.presentablePrompt) || text(value.prompt)]), 'prompt')
      case 'UserResponseEvent':
        return result(entryOf(lineKey(line), 'user', undefined, time, [text(value.prompt)]), 'prompt')
      case 'UserAsyncResponseEvent':
        return result(entryOf(lineKey(line), 'user', undefined, time, (Array.isArray(value.entries) ? value.entries : [])
          .flatMap(item => [text(item?.question), text(item?.answer)])), 'prompt')
      case 'TaskState':
      case 'CancelAgentEvent': return result(undefined, 'end')
      case 'SessionA2uxEvent': break
      default: return result()
    }
    const state = value.event?.state
    const block = value.event?.agentEvent
    if (!block || typeof block !== 'object') return result()
    const kind = block.kind
    const key = typeof block.stepId === 'string' && block.stepId ? block.stepId : undefined
    // The step that the state of the session gives when the event tells no more.
    const stateStep = state === 'IN_PROGRESS' ? 'open' : state === 'INPUT_REQUIRED' ? undefined : 'end'
    if (kind === 'AgentTaskNameUpdatedEvent') {
      const title = text(block.name).trim()
      return result(undefined, stateStep, title ? { title, titleRank: TITLE_RANK.agent } : undefined)
    }
    if (kind === 'ResultBlockUpdatedEvent') {
      return result(key ? entryOf(key, 'assistant', undefined, time, [text(block.title), text(block.result)]) : undefined,
        state === 'INPUT_REQUIRED' ? undefined : 'reply')
    }
    if (kind === 'MarkdownBlockUpdatedEvent') return result(key ? entryOf(key, 'assistant', undefined, time, [text(block.text)]) : undefined, stateStep)
    if (kind === 'AskAsyncRequestUpdatedEvent') return result(undefined, state === 'INPUT_REQUIRED' ? 'question' : stateStep)
    if (TOOL_BLOCKS.has(kind)) {
      // Only a command block had an approval request in the logs of Junie 26.10.5. Each block with one waits the same way.
      const waits = state === 'INPUT_REQUIRED' && block.approvalRequest
      const ended = typeof block.status === 'string' && block.status !== 'IN_PROGRESS'
      return result(ended && key ? entryOf(key, 'tool', 'result', time, toolParts(kind, block)) : undefined, waits ? 'permission' : stateStep)
    }
    return result(undefined, stateStep)
  }
}

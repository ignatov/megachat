import { basename, dirname, join, sep } from 'node:path'
import { callText, contentText, encodedDirectory, entryOf, lineKey, readSmall, TITLE_RANK } from './SessionLog.mjs'

/** The longest name of a project directory that Claude Code writes. A longer name ends with a hash. */
const NAME_LIMIT = 200

/** Claude Code names the directory of a project after its path: each character other than a letter or a digit is `-`. */
function encode(cwd) {
  const full = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return { full, prefix: full.length >= NAME_LIMIT ? full.slice(0, NAME_LIMIT) : `${full}-` }
}

/** The text of the content of a tool result: a string or a list of text blocks. */
const resultText = content => contentText(content)
/** A user message that Claude Code writes when the user stops a turn. The turn ends without a reply. */
const interrupted = /^\[Request interrupted by user/
/**
 * A user message that holds a local command, such as `/model`, a shell line of the bash mode (`!`) or a note of the
 * memory mode (`#`), or the output of one. It starts no turn of the model.
 */
const localCommand = /^\s*<(?:command-name|command-message|local-command-[\w-]+|bash-(?:input|stdout|stderr)|user-memory-input)>/
/** The system records that Claude Code writes at the end of a turn. */
const TURN_END = new Set(['turn_duration', 'stop_hook_summary'])
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/**
 * The difference between the start time of a process and the field `startedAt` of its process file, when the file has
 * no field `procStart`. On the Mac of the author, 26 of 27 files had at most 6 seconds.
 */
const START_SLACK_MS = 10000

/** The time of the text that `ps -o lstart` gives in UTC, such as `Wed Nov 11 18:22:25 2026`, or undefined. */
function utcStart(text) {
  const match = typeof text === 'string' && /^[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(text.trim())
  if (!match || !MONTHS.includes(match[1])) return undefined
  return Date.UTC(Number(match[6]), MONTHS.indexOf(match[1]), Number(match[2]), Number(match[3]), Number(match[4]), Number(match[5]))
}

/**
 * The step of a session that one record shows, for the status of a running session: `call`, `result` and `prompt`
 * open a step of the agent, `open` is a part of a reply before more work, `reply` and `end` finish a turn.
 */
function stepOf(value, blocks) {
  if (value.type === 'system') return TURN_END.has(value.subtype) ? 'end' : undefined
  if (value.type === 'user') {
    // A summary of `/compact` ends the command: the session then waits for the user.
    if (value.isCompactSummary) return 'end'
    if (blocks.some(block => block?.type === 'tool_result')) return 'result'
    const text = blocks.filter(block => block?.type === 'text').map(block => block.text).join('\n')
    if (interrupted.test(text)) return 'end'
    return text.trim() && !localCommand.test(text) ? 'prompt' : undefined
  }
  if (blocks.some(block => block?.type === 'tool_use' || block?.type === 'server_tool_use')) return 'call'
  // A text before a tool call has the stop reason `tool_use`. A thinking block comes before a text.
  if (value.message.stop_reason === 'tool_use' || !blocks.some(block => block?.type === 'text')) return 'open'
  return 'reply'
}

/**
 * The sessions of Claude Code: `<root>/<encoded cwd>/<session ID>.jsonl`, with `~/.claude/projects` as the root. The
 * session ID is the name of the file. The directory of a subagent of a session holds no top-level session file, so the
 * source skips it.
 */
export class ClaudeSessionSource {
  constructor({ home, environment = {} }) {
    this.agent = 'claude'
    this.root = join(environment.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')
    // Claude Code writes `<config>/sessions/<PID>.json` for each running process, with its session ID.
    this.processes = join(dirname(this.root), 'sessions')
  }

  /** Each session file of the machine: the directory of each project, without the directories of the subagents. */
  async all(fs) {
    const files = []
    for (const name of await fs.readdir(this.root).catch(() => [])) {
      for (const file of await fs.readdir(join(this.root, name)).catch(() => [])) {
        if (file.endsWith('.jsonl')) files.push({ path: join(this.root, name, file) })
      }
    }
    return files
  }

  /** True when a path relative to `root` has the form of a session file of each project. */
  matches(path) {
    const parts = path.split(sep)
    return parts.length === 2 && parts[1].endsWith('.jsonl')
  }

  /** The session ID that the name of a file gives. */
  nameId(path) { return basename(path, '.jsonl') }

  /** The path of the session file of [sessionId] in [cwd]. A long path of a directory ends with a hash, so it can differ. */
  pathOf(cwd, sessionId) { return join(this.root, encode(cwd).full, `${sessionId}.jsonl`) }

  /**
   * The session of a running process from its process file, as `{ sessionId, cwd }`, or undefined. The file must name
   * the PID, and its start time must be the start time of the process: else the PID is of another process. The field
   * `procStart` has the form of `ps -o lstart` in UTC, so it gives the start time to the second.
   */
  async processSession(pid, startedAt, fs) {
    let value
    try { value = JSON.parse(await readSmall(fs, join(this.processes, `${pid}.json`))) }
    catch { return undefined }
    if (!value || value.pid !== pid || typeof value.sessionId !== 'string' || !value.sessionId) return undefined
    const start = utcStart(value.procStart)
    const same = start !== undefined ? Math.abs(start - startedAt) < 1000
      : typeof value.startedAt === 'number' && Math.abs(value.startedAt - startedAt) <= START_SLACK_MS
    if (!same) return undefined
    return { sessionId: value.sessionId, ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}) }
  }

  async files(directories, fs) {
    const names = await fs.readdir(this.root).catch(() => [])
    const files = []
    for (const name of names) {
      const directory = encodedDirectory(name, directories, encode)
      if (!directory) continue
      for (const file of await fs.readdir(join(this.root, name)).catch(() => [])) {
        if (file.endsWith('.jsonl')) files.push({ path: join(this.root, name, file), directory })
      }
    }
    return files
  }

  relevant(path, directories) {
    return this.matches(path) && encodedDirectory(path.split(sep)[0], directories, encode) !== undefined
  }

  parse(value, line, path) {
    const meta = { sessionId: basename(path, '.jsonl') }
    if (typeof value.cwd === 'string') meta.cwd = value.cwd
    const title = value.type === 'custom-title' ? [value.customTitle, TITLE_RANK.user]
      : value.type === 'ai-title' ? [value.aiTitle, TITLE_RANK.agent]
        : value.type === 'summary' ? [value.summary, TITLE_RANK.summary] : []
    if (typeof title[0] === 'string' && title[0].trim()) Object.assign(meta, { title: title[0].trim(), titleRank: title[1] })
    if (value.type === 'system' && !value.isSidechain) {
      const step = stepOf(value, [])
      return { meta, ...(step ? { step } : {}) }
    }
    // A sidechain is the work of a subagent, and a meta message is a text of Claude Code, not of the user.
    if (!['user', 'assistant'].includes(value.type) || value.isSidechain || value.isMeta || !value.message) return { meta }
    const content = value.message.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
    const step = stepOf(value, blocks)
    const texts = []
    const calls = []
    const results = []
    for (const block of blocks) {
      if (block?.type === 'text' && typeof block.text === 'string') texts.push(block.text)
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') calls.push(callText(block.name, block.input))
      if (block?.type === 'tool_result') results.push(resultText(block.content))
    }
    const role = value.type === 'assistant' ? 'assistant' : results.length && !texts.length ? 'tool' : 'user'
    const tool = results.length ? 'result' : calls.length ? 'call' : undefined
    const entry = entryOf(value.uuid ?? lineKey(line), role, tool, value.timestamp, [...texts, ...calls, ...results])
    return { meta, ...(entry ? { entry } : {}), ...(step ? { step } : {}) }
  }
}

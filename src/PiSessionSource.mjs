import { basename, join, sep } from 'node:path'
import { callText, contentText, encodedDirectory, entryOf, timeOf, TITLE_RANK } from './SessionLog.mjs'

/** pi names the directory of a project `--<path>--`, with `-` for each separator of the path. */
function encode(cwd) {
  const core = cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')
  return { full: `--${core}--`, prefix: `--${core}-` }
}

/**
 * The sessions of pi: `<root>/--<path>--/*.jsonl`, with `~/.pi/agent/sessions` or `PI_CODING_AGENT_SESSION_DIR` as the
 * root. The first line `session` gives the session ID and the `cwd`. A file directly in the root is a candidate too.
 * The entry ID of pi is short and only unique in its session, so the key adds the time of the entry: a fork copies both.
 */
export class PiSessionSource {
  constructor({ home, environment = {} }) {
    this.agent = 'pi'
    this.root = environment.PI_CODING_AGENT_SESSION_DIR || join(home, '.pi', 'agent', 'sessions')
  }

  /** Each session file of the machine: the files in the root and in the directory of each project. */
  async all(fs) {
    const files = []
    for (const entry of await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ path: join(this.root, entry.name) })
      if (!entry.isDirectory()) continue
      for (const file of await fs.readdir(join(this.root, entry.name)).catch(() => [])) {
        if (file.endsWith('.jsonl')) files.push({ path: join(this.root, entry.name, file) })
      }
    }
    return files
  }

  matches(path) {
    const parts = path.split(sep)
    return parts.at(-1).endsWith('.jsonl') && parts.length <= 2
  }

  /** The name of a session file is `<time>_<session ID>.jsonl`. */
  nameId(path) { return /^[^_]+_(.+)\.jsonl$/.exec(basename(path))?.[1] }

  async files(directories, fs) {
    const entries = await fs.readdir(this.root, { withFileTypes: true }).catch(() => [])
    const files = []
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push({ path: join(this.root, entry.name) })
      if (!entry.isDirectory()) continue
      const directory = encodedDirectory(entry.name, directories, encode)
      if (!directory) continue
      for (const file of await fs.readdir(join(this.root, entry.name)).catch(() => [])) {
        if (file.endsWith('.jsonl')) files.push({ path: join(this.root, entry.name, file), directory })
      }
    }
    return files
  }

  relevant(path, directories) {
    const parts = path.split(sep)
    if (!parts.at(-1).endsWith('.jsonl')) return false
    return parts.length === 1 || parts.length === 2 && encodedDirectory(parts[0], directories, encode) !== undefined
  }

  parse(value) {
    if (value.type === 'session') {
      return { meta: { ...(typeof value.id === 'string' ? { sessionId: value.id } : {}),
        ...(typeof value.cwd === 'string' ? { cwd: value.cwd } : {}), startedAt: timeOf(value.timestamp) } }
    }
    if (value.type === 'session_info' && typeof value.name === 'string' && value.name.trim())
      return { meta: { title: value.name.trim(), titleRank: TITLE_RANK.user } }
    const model = value.message
    if (value.type !== 'message' || !model || typeof value.id !== 'string') return {}
    const key = `${value.id}:${value.timestamp ?? model.timestamp ?? ''}`
    const timestamp = value.timestamp ?? model.timestamp
    let entry
    let step
    if (model.role === 'user') {
      entry = entryOf(key, 'user', undefined, timestamp, [contentText(model.content)])
      step = 'prompt'
    }
    if (model.role === 'assistant') {
      const calls = Array.isArray(model.content) ? model.content.filter(block => block?.type === 'toolCall').map(block => callText(block.name, block.arguments)) : []
      entry = entryOf(key, 'assistant', calls.length ? 'call' : undefined, timestamp, [contentText(model.content), ...calls])
      // pi writes a reply when it is complete. Each stop reason other than `toolUse` ends the turn, also an error.
      step = calls.length || model.stopReason === 'toolUse' ? 'call' : 'reply'
    }
    if (model.role === 'toolResult') {
      entry = entryOf(key, 'tool', 'result', timestamp, [contentText(model.content)])
      step = 'result'
    }
    return { ...(entry ? { entry } : {}), ...(step ? { step } : {}) }
  }
}

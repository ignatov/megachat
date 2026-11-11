import { basename, join, sep } from 'node:path'
import { callText, contentText, encodedDirectory, entryOf, lineKey, TITLE_RANK } from './SessionLog.mjs'

/** The longest name of a project directory that Claude Code writes. A longer name ends with a hash. */
const NAME_LIMIT = 200

/** Claude Code names the directory of a project after its path: each character other than a letter or a digit is `-`. */
function encode(cwd) {
  const full = cwd.replace(/[^a-zA-Z0-9]/g, '-')
  return { full, prefix: full.length >= NAME_LIMIT ? full.slice(0, NAME_LIMIT) : `${full}-` }
}

/** The text of the content of a tool result: a string or a list of text blocks. */
const resultText = content => contentText(content)

/**
 * The sessions of Claude Code: `<root>/<encoded cwd>/<session ID>.jsonl`, with `~/.claude/projects` as the root. The
 * session ID is the name of the file. The directory of a subagent of a session holds no top-level session file, so the
 * source skips it.
 */
export class ClaudeSessionSource {
  constructor({ home, environment = {} }) {
    this.agent = 'claude'
    this.root = join(environment.CLAUDE_CONFIG_DIR || join(home, '.claude'), 'projects')
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
    const parts = path.split(sep)
    return parts.length === 2 && parts[1].endsWith('.jsonl') && encodedDirectory(parts[0], directories, encode) !== undefined
  }

  parse(value, line, path) {
    const meta = { sessionId: basename(path, '.jsonl') }
    if (typeof value.cwd === 'string') meta.cwd = value.cwd
    const title = value.type === 'custom-title' ? [value.customTitle, TITLE_RANK.user]
      : value.type === 'ai-title' ? [value.aiTitle, TITLE_RANK.agent]
        : value.type === 'summary' ? [value.summary, TITLE_RANK.summary] : []
    if (typeof title[0] === 'string' && title[0].trim()) Object.assign(meta, { title: title[0].trim(), titleRank: title[1] })
    // A sidechain is the work of a subagent, and a meta message is a text of Claude Code, not of the user.
    if (!['user', 'assistant'].includes(value.type) || value.isSidechain || value.isMeta || !value.message) return { meta }
    const content = value.message.content
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : Array.isArray(content) ? content : []
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
    return { meta, ...(entry ? { entry } : {}) }
  }
}

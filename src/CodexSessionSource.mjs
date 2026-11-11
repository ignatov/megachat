import { basename, join } from 'node:path'
import { callText, contentText, entryOf, lineKey, timeOf, TITLE_RANK } from './SessionLog.mjs'

/** A user message that Codex adds itself: the environment, the rules of `AGENTS.md`, a notice. */
const injected = /^\s*(?:<[\w-]+>|# AGENTS\.md instructions)/
const sessionFile = name => name.startsWith('rollout-') && name.endsWith('.jsonl')

/**
 * The sessions of Codex: `<root>/YYYY/MM/DD/rollout-*.jsonl`, with `~/.codex/sessions` or `$CODEX_HOME/sessions` as
 * the root. A file holds one session, and its first line `session_meta` gives the session ID and the `cwd`. The files
 * allow an incremental import without a Codex process. The app-server stays the live source of the present tools.
 */
export class CodexSessionSource {
  constructor({ home, environment = {} }) {
    this.agent = 'codex'
    this.root = join(environment.CODEX_HOME || join(home, '.codex'), 'sessions')
  }

  /** The path of a file does not tell its project, so each session file is a candidate. */
  async files(_directories, fs) {
    const names = await fs.readdir(this.root, { recursive: true }).catch(() => [])
    return names.filter(name => sessionFile(basename(name))).sort().map(name => ({ path: join(this.root, name) }))
  }

  relevant(path) { return sessionFile(basename(path)) }

  parse(value, line) {
    const payload = value.payload
    if (!payload || typeof payload !== 'object') return {}
    if (value.type === 'session_meta') {
      return { meta: { ...(typeof payload.id === 'string' ? { sessionId: payload.id } : {}),
        ...(typeof payload.cwd === 'string' ? { cwd: payload.cwd } : {}), startedAt: timeOf(payload.timestamp ?? value.timestamp) } }
    }
    if (value.type === 'event_msg' && payload.type === 'thread_name_updated' && typeof payload.thread_name === 'string' && payload.thread_name.trim())
      return { meta: { title: payload.thread_name.trim(), titleRank: TITLE_RANK.user } }
    if (value.type !== 'response_item') return {}
    const key = payload.id ?? lineKey(line)
    let entry
    if (payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
      const text = contentText(payload.content, ['input_text', 'output_text'])
      if (payload.role === 'user' && injected.test(text)) return {}
      entry = entryOf(key, payload.role, undefined, value.timestamp, [text])
    }
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call')
      entry = entryOf(key, 'assistant', 'call', value.timestamp, [callText(payload.name, payload.arguments ?? payload.input)])
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const output = typeof payload.output === 'string' ? payload.output
        : typeof payload.output?.content === 'string' ? payload.output.content : JSON.stringify(payload.output ?? '')
      entry = entryOf(payload.id ?? (payload.call_id ? `${payload.call_id}:output` : key), 'tool', 'result', value.timestamp, [output])
    }
    return entry ? { entry } : {}
  }
}

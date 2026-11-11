import { basename, join } from 'node:path'
import { callText, contentText, entryOf, lineKey, timeOf, TITLE_RANK } from './SessionLog.mjs'

/** A user message that Codex adds itself: the environment, the rules of `AGENTS.md`, a notice. */
const injected = /^\s*(?:<[\w-]+>|# AGENTS\.md instructions)/
const sessionFile = name => name.startsWith('rollout-') && name.endsWith('.jsonl')
/** The name of a session file: `rollout-<local time>-<session ID>.jsonl`. */
const NAME = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/
/** The events that end a turn: the turn is complete, or the user stopped it. */
const TURN_END = new Set(['task_complete', 'turn_aborted'])

/**
 * The sessions of Codex: `<root>/YYYY/MM/DD/rollout-*.jsonl`, with `~/.codex/sessions` or `$CODEX_HOME/sessions` as
 * the root. A file holds one session, and its first line `session_meta` gives the session ID and the `cwd`. The files
 * allow an incremental import without a Codex process. The app-server stays the live source of the present tools.
 */
export class CodexSessionSource {
  constructor({ home, environment = {} }) {
    this.agent = 'codex'
    this.root = join(environment.CODEX_HOME || join(home, '.codex'), 'sessions')
    // A Codex process keeps the session file of each loaded session open, so its open files link it to its sessions.
    this.keepsOpen = true
  }

  async all(fs) { return this.files([], fs) }

  matches(path) { return sessionFile(basename(path)) }

  nameId(path) { return NAME.exec(basename(path))?.[1] }

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
    // The steps of a session: a turn starts with `task_started` and ends with `task_complete` or `turn_aborted`.
    if (value.type === 'event_msg') return payload.type === 'task_started' ? { step: 'open' } : TURN_END.has(payload.type) ? { step: 'end' } : {}
    if (value.type !== 'response_item') return {}
    const key = payload.id ?? lineKey(line)
    let entry
    let step
    if (payload.type === 'message' && ['user', 'assistant'].includes(payload.role)) {
      const text = contentText(payload.content, ['input_text', 'output_text'])
      if (payload.role === 'user' && injected.test(text)) return {}
      entry = entryOf(key, payload.role, undefined, value.timestamp, [text])
      // A message of the phase `commentary` comes before more work in the same turn.
      step = payload.role === 'user' ? 'prompt' : payload.phase === 'commentary' ? 'open' : 'reply'
    }
    if (payload.type === 'reasoning') step = 'open'
    if (payload.type === 'function_call' || payload.type === 'custom_tool_call') {
      entry = entryOf(key, 'assistant', 'call', value.timestamp, [callText(payload.name, payload.arguments ?? payload.input)])
      step = 'call'
    }
    if (payload.type === 'function_call_output' || payload.type === 'custom_tool_call_output') {
      const output = typeof payload.output === 'string' ? payload.output
        : typeof payload.output?.content === 'string' ? payload.output.content : JSON.stringify(payload.output ?? '')
      entry = entryOf(payload.id ?? (payload.call_id ? `${payload.call_id}:output` : key), 'tool', 'result', value.timestamp, [output])
      step = 'result'
    }
    return { ...(entry ? { entry } : {}), ...(step ? { step } : {}) }
  }
}

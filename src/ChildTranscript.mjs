import { chmod, mkdir, open, readdir, unlink } from 'node:fs/promises'
import { join } from 'node:path'
import { logFailure, message } from './messages.mjs'
import { terminalStates } from './MegachatState.mjs'
import { redactSecrets } from './SessionText.mjs'

/** The bytes of one transcript. A transcript stops at the limit with a note, so a long run cannot fill the disk. */
export const TRANSCRIPT_LIMIT = 1000000
/** The characters of a message that the transcript keeps before it writes them without the end of a paragraph. */
const MESSAGE_BUFFER = 16000
/** The characters of a tool title in the transcript. */
const TITLE_LIMIT = 300
/** The tool calls of one run whose last title the transcript keeps, so a changed title shows once. */
const TOOL_LIMIT = 1000
const FILE_NAME = /^([0-9a-f-]{36})\.txt$/

const agentName = agent => agent === 'codex' ? 'Codex' : agent === 'pi' ? 'Pi' : 'Claude'
const clock = () => new Date().toTimeString().slice(0, 8)
const clip = text => {
  const line = String(text ?? '').replace(/\s+/g, ' ').trim()
  return line.length <= TITLE_LIMIT ? line : `${line.slice(0, TITLE_LIMIT - 1)}…`
}

/** The path of the transcript of the run [runId] in [directory]. The bridge names it to Air, and the daemon writes it. */
export const transcriptPath = (directory, runId) => join(directory, `${runId}.txt`)

/**
 * The transcripts of the child runs: one plain text file for each run in [directory], a private directory of the state
 * directory. Air opens the file from the row of the run in the chat. The file holds the task, the messages of the child,
 * its tool calls by name and title, its permission requests, each message of the user that a steer added to its turn,
 * and the end of the run. The secret filter of the session index applies to each text, and a file has at most [limit]
 * bytes.
 *
 * A transcript never slows or fails a run: each write goes to a queue of its own, and the first failure of a file goes to
 * the log one time, without content. The run then goes on without its transcript. The file of a run goes away when the
 * retention of the state drops the run, and the start of the service removes each file of a run that the state does not
 * have.
 */
export class ChildTranscripts {
  constructor(directory, { limit = TRANSCRIPT_LIMIT } = {}) {
    this.directory = directory
    this.limit = limit
    this.active = new Map()
    this.files = new Set()
    this.removing = Promise.resolve()
  }

  /** Removes the files of the dropped runs now, and after each change of the state. */
  async start(state) {
    this.watch = await state.watch()
    const names = await readdir(this.directory).catch(() => [])
    for (const name of names) {
      const runId = FILE_NAME.exec(name)?.[1]
      if (runId) this.files.add(runId)
    }
    this.observe(this.watch.value)
    this.watch.start(call => { if (call.kind === 'value') this.observe(call.value) })
  }

  observe(snapshot) {
    for (const [runId, transcript] of this.active) {
      const run = snapshot.runs[runId]
      if (!run || terminalStates.has(run.status)) {
        this.active.delete(runId)
        transcript.end(run?.status, run?.error)
      }
    }
    const dropped = [...this.files].filter(runId => !Object.hasOwn(snapshot.runs, runId))
    if (dropped.length === 0) return
    for (const runId of dropped) this.files.delete(runId)
    this.removing = this.removing.then(() => Promise.all(dropped.map(runId =>
      unlink(transcriptPath(this.directory, runId)).catch(error => { if (error.code !== 'ENOENT') logFailure('log.transcript.remove', error, runId) }))))
  }

  /**
   * Opens the transcript of [run] at the start of its execution, and writes its head. [again] is the execution of a
   * dispatched run after a restart of the daemon: its transcript continues.
   */
  begin(run, { again = false } = {}) {
    const transcript = new ChildTranscript(this, run)
    this.active.get(run.id)?.end()
    this.active.set(run.id, transcript)
    this.files.add(run.id)
    if (again) transcript.line(message('transcript.again', clock()))
    else transcript.head()
    return transcript
  }

  async close() {
    await this.watch?.stop()
    const active = [...this.active.values()]
    this.active.clear()
    await Promise.allSettled(active.map(transcript => transcript.end()))
    await this.removing
  }
}

/** The transcript of one run. Each method only adds to the queue of the file, and none of them throws. */
class ChildTranscript {
  constructor(service, run) {
    this.service = service
    this.run = run
    this.path = transcriptPath(service.directory, run.id)
    this.queue = Promise.resolve()
    this.handle = null
    this.bytes = 0
    this.stopped = false
    this.message = ''
    this.tools = new Map()
    // A new file starts without an empty line.
    this.newlines = 2
  }

  head() {
    const run = this.run
    this.line([message('transcript.title', clip(run.title ?? (run.task ?? run.prompt).split('\n').find(line => line.trim()) ?? '')),
      message('transcript.agent', agentName(run.agent)), message('transcript.project', run.cwd),
      message('transcript.started', new Date().toISOString()),
      ...(run.resumeOf ? [message('transcript.continues')] : [])].join('\n'))
  }

  /** The prompt that the run sends: the task, and the messages of the user that the prompt holds. */
  prompt(text, steers = []) {
    this.line(`${message('transcript.task')}\n${text}`)
    for (const item of steers) this.line(`${message('transcript.steer.prompt')}\n${item.text}`)
  }

  /** One update of an ACP agent: a part of a message, a tool call, or a change of the title or status of a tool call. */
  update(update) {
    if (update.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text') return this.text(update.content.text, true)
    if (update.sessionUpdate !== 'tool_call' && update.sessionUpdate !== 'tool_call_update') return
    const id = String(update.toolCallId ?? '')
    const known = this.tools.get(id)
    const name = update._meta?.claudeCode?.toolName ?? update.kind ?? known?.name ?? 'tool'
    const title = clip(update.title ?? known?.title ?? '')
    if (update.sessionUpdate === 'tool_call' || (title && title !== known?.title)) {
      if (!known && this.tools.size >= TOOL_LIMIT) this.tools.delete(this.tools.keys().next().value)
      this.tools.set(id, { name, title })
      this.line(message('transcript.tool', clock(), name, title))
    }
    if (update.status === 'failed') this.line(message('transcript.tool.failed', clock(), name, title))
  }

  /**
   * A text of the child. A part of a message ([part]) waits for the end of its paragraph, so the secret filter sees a
   * whole secret. Each other event writes the waiting text first.
   */
  text(text, part = false) {
    if (!part) {
      this.flush()
      this.line(String(text).trim())
      return
    }
    this.message += text
    const end = this.message.lastIndexOf('\n\n')
    if (this.message.length > MESSAGE_BUFFER) this.flush()
    else if (end >= 0) {
      this.write(this.separated(this.message.slice(0, end + 2)))
      this.message = this.message.slice(end + 2)
    }
  }

  tool(name, title) { this.line(message('transcript.tool', clock(), clip(name), clip(title))) }
  permission(title) { this.line(message('transcript.permission', clock(), clip(title))) }
  steer(text) { this.line(`${message('transcript.steer', clock())}\n${text}`) }

  /** A block of its own: the waiting text of a message, then [text] after an empty line. */
  line(text) {
    this.flush()
    this.write(`${'\n'.repeat(Math.max(0, 2 - this.newlines))}${text}\n`)
    this.block = true
  }

  /** [text] of a message. The first text after a block starts after an empty line. */
  separated(text) {
    const separator = this.block ? '\n'.repeat(Math.max(0, 2 - this.newlines)) : ''
    this.block = false
    return `${separator}${text}`
  }

  flush() {
    if (!this.message) return
    const text = this.message
    this.message = ''
    this.write(this.separated(text.endsWith('\n') ? text : `${text}\n`))
  }

  /** Writes the end of the run, and closes the file. */
  end(status, error) {
    if (this.ended) return this.queue
    if (status) this.line([message('transcript.ended', clock(), status), ...(error ? [error] : [])].join('\n'))
    else this.flush()
    this.ended = true
    this.queue = this.queue.then(() => this.handle?.close()).catch(() => {}).then(() => { this.handle = null })
    return this.queue
  }

  write(text) {
    if (this.ended || this.stopped || !text) return
    // The count of the new lines at the end of the text so far, so a block starts after one empty line.
    const trailing = text.length - text.trimEnd().length
    this.newlines = trailing === text.length ? this.newlines + trailing : (text.match(/\n*$/)[0].length)
    this.queue = this.queue.then(() => this.append(redactSecrets(text))).catch(error => {
      // The first failure goes to the log without content, and the run goes on without its transcript.
      if (!this.stopped) logFailure('log.transcript', error, this.run.id)
      this.stopped = true
    })
  }

  async append(text) {
    if (this.stopped) return
    if (!this.handle) {
      await mkdir(this.service.directory, { recursive: true, mode: 0o700 })
      await chmod(this.service.directory, 0o700)
      this.handle = await open(this.path, 'a', 0o600)
      await this.handle.chmod(0o600)
      this.bytes = (await this.handle.stat()).size
    }
    let data = Buffer.from(text)
    const note = Buffer.from(`\n${message('transcript.limit', clock(), this.service.limit)}\n`)
    if (this.bytes + data.length + note.length > this.service.limit) {
      // The cut must not leave a part of a character at the end.
      let end = Math.max(0, this.service.limit - note.length - this.bytes)
      while (end > 0 && (data[end] & 0xc0) === 0x80) end--
      data = Buffer.concat([data.subarray(0, end), note])
      this.stopped = true
    }
    await this.handle.write(data)
    this.bytes += data.length
  }
}

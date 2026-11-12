import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { sep } from 'node:path'
import { pipeline } from 'node:stream'
import { createZstdDecompress } from 'node:zlib'
import { SOURCE_TEXT_LIMIT } from './SessionText.mjs'

/** The rank of a title: a title of the user wins over a title of the agent, and that one wins over a first prompt. */
export const TITLE_RANK = { prompt: 0, summary: 1, agent: 2, user: 3 }

/** The time of an ISO text or of a number in milliseconds, or undefined. */
export function timeOf(value) {
  const time = typeof value === 'number' ? value : typeof value === 'string' ? Date.parse(value) : NaN
  return Number.isFinite(time) ? time : undefined
}

/** A key for a line without an entry ID. A fork copies the line, so the copy gets the same key. */
export const lineKey = line => createHash('sha256').update(line).digest('base64url').slice(0, 32)

/** The text of a content that is a string or a list of blocks with `text`. */
export function contentText(content, types = ['text']) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content.filter(block => block && types.includes(block.type) && typeof block.text === 'string').map(block => block.text).join('\n')
}

/** The text of a tool call: its name and its arguments, cut early. */
export function callText(name, input) {
  const args = typeof input === 'string' ? input : JSON.stringify(input ?? {})
  return `${name ?? ''} ${args.slice(0, SOURCE_TEXT_LIMIT)}`.trim()
}

/** An entry, or undefined for an entry without text. The text is cut to the limit of a source. */
export function entryOf(key, role, tool, timestamp, parts) {
  const text = parts.filter(Boolean).join('\n')
  if (!text.trim()) return undefined
  return { key, role, ...(tool ? { tool } : {}), timestamp: timeOf(timestamp), text: text.length > SOURCE_TEXT_LIMIT ? text.slice(0, SOURCE_TEXT_LIMIT) : text }
}

/** True when [cwd] is [directory] or a directory in it. */
export function isInside(directory, cwd) {
  return typeof cwd === 'string' && (cwd === directory || cwd.startsWith(directory.endsWith(sep) ? directory : `${directory}${sep}`))
}

/** The most specific listed directory that holds [cwd], or undefined. */
export function directoryOf(cwd, directories) {
  let found
  for (const directory of directories) {
    if (isInside(directory.cwd, cwd) && (!found || directory.cwd.length > found.cwd.length)) found = directory
  }
  return found
}

/** The listed directory whose encoded name is [name] or a prefix of it, the most specific first. */
export function encodedDirectory(name, directories, encode) {
  let found
  for (const directory of directories) {
    const encoded = encode(directory.cwd)
    if (name === encoded.full || name.startsWith(encoded.prefix)) {
      if (!found || directory.cwd.length > found.cwd.length) found = directory
    }
  }
  return found
}

/**
 * Parses one line of a session file with its source, as `{ value, parsed }`, or undefined for a line that is no JSON
 * object. `value` is the JSON value, so a reader also gets the field `timestamp` that each agent writes.
 */
export function parseLine(source, line, path) {
  let value
  try { value = JSON.parse(line) }
  catch { return undefined }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
  return { value, parsed: source.parse(value, line, path) }
}

/**
 * The flags of the open of a small file of another program: read-only, no open through a symbolic link, and no wait
 * for a writer when the path is a FIFO.
 */
export const SMALL_FILE_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/**
 * The text of a small regular file, at most [limit] bytes. A larger file, a symbolic link and a path that is not a
 * regular file give an error. The file opens read-only.
 */
export async function readSmall(fs, path, limit = 64 * 1024) {
  const handle = await fs.open(path, SMALL_FILE_FLAGS)
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('type')
    if (stat.size > limit) throw new Error('large')
    const buffer = Buffer.alloc(limit + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > limit) throw new Error('large')
    }
    return buffer.subarray(0, length).toString('utf8')
  }
  finally { await handle.close() }
}

/** True for a session file that zstd compressed, such as a cold Codex session `rollout-*.jsonl.zst`. */
export const isCompressed = path => path.endsWith('.zst')

/**
 * The chunks of a file from [start] to [end], as `{ buffer, bytesRead }`. A compressed file gives the chunks of its
 * text from the start, and [end] then counts the bytes of the text. The zstd stream of Node.js decompresses outside
 * the event loop.
 */
async function* chunksOf(handle, { start, end, chunkBytes, compressed }) {
  if (!compressed) {
    const buffer = Buffer.alloc(chunkBytes)
    for (let position = start; end === undefined || position < end;) {
      const { bytesRead } = await handle.read(buffer, 0, end === undefined ? chunkBytes : Math.min(chunkBytes, end - position), position)
      if (bytesRead === 0) return
      yield { buffer, bytesRead }
      position += bytesRead
    }
    return
  }
  const input = handle.createReadStream({ start: 0, autoClose: false, highWaterMark: chunkBytes })
  const output = createZstdDecompress()
  pipeline(input, output, () => {})
  try {
    let position = 0
    for await (const chunk of output) {
      const bytesRead = end === undefined ? chunk.length : Math.min(chunk.length, end - position)
      yield { buffer: chunk, bytesRead }
      position += bytesRead
      if (end !== undefined && position >= end) return
    }
  }
  finally {
    input.destroy()
    output.destroy()
  }
}

/**
 * Reads the complete lines of a file from [start] to [end] in batches, as `{ lines, end }`. `end` is the byte offset
 * after the last line of the batch. A last line without a newline stays unread until a writer completes it. A line
 * above [maxLine] bytes is skipped, because the parse of such a line blocks the event loop: mostly an image or a large
 * tool output. A compressed file (`compressed`) is complete: the reader reads its text from the start, offsets count the
 * bytes of the text, and a last line without a newline counts too.
 */
export async function* readLines(fs, path, { start = 0, end, chunkBytes = 256 * 1024, batchBytes = 256 * 1024, batchLines = 64, maxLine = 4 * 1024 * 1024, compressed = false } = {}) {
  const handle = await fs.open(path, 'r')
  try {
    if (compressed) start = 0
    let position = start
    let pending = []
    let pendingBytes = 0
    let skipping = false
    let lines = []
    let bytes = 0
    let consumed = start
    let given = start
    for await (const { buffer, bytesRead } of chunksOf(handle, { start, end, chunkBytes, compressed })) {
      let from = 0
      for (let newline = buffer.indexOf(10, 0); newline >= 0 && newline < bytesRead; newline = buffer.indexOf(10, from)) {
        const part = buffer.subarray(from, newline)
        if (!skipping && pendingBytes + part.length <= maxLine) {
          const line = pendingBytes ? Buffer.concat([...pending, part]).toString('utf8') : part.toString('utf8')
          if (line.trim()) lines.push(line)
          bytes += pendingBytes + part.length
        }
        pending = []
        pendingBytes = 0
        skipping = false
        consumed = position + newline + 1
        from = newline + 1
        if (bytes >= batchBytes || lines.length >= batchLines) {
          given = consumed
          yield { lines, end: consumed }
          lines = []
          bytes = 0
        }
      }
      if (from < bytesRead && !skipping) {
        if (pendingBytes + bytesRead - from > maxLine) { skipping = true; pending = []; pendingBytes = 0 }
        else {
          pending.push(Buffer.from(buffer.subarray(from, bytesRead)))
          pendingBytes += bytesRead - from
        }
      }
      position += bytesRead
    }
    // No writer adds to a compressed file, so its last line is complete also without a newline.
    if (compressed && pendingBytes && (end === undefined || position < end)) {
      const line = Buffer.concat(pending).toString('utf8')
      if (line.trim()) lines.push(line)
      consumed = position
    }
    if (consumed > given) yield { lines, end: consumed }
  }
  finally { await handle.close() }
}

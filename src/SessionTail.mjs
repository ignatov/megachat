import { parseLine } from './SessionLog.mjs'
import { indexedText } from './SessionText.mjs'

/**
 * Reads the complete lines of a file backwards from the byte offset [end], the newest line first, as
 * `{ line, start, end }`. `start` is the offset of the first byte of the line, and `end` is the offset after its
 * newline. The bytes after the last newline before [end] are a line that a writer has not completed, so they stay
 * unread. A line above [maxLine] bytes gives `line` null, because the parse of such a line blocks the event loop.
 * The reader reads blocks of [blockBytes] from the end, so a large file costs only the bytes of the lines that the
 * caller takes. After [budget] bytes, the reader stops with `{ line: null, start, cut: true }`: one line without a
 * newline in a large part of a file then costs no read of the whole file. `start` is the start of the oldest line that
 * came out of this read, so a next read that ends there reads the open line whole. When no line came out, `start` is
 * the offset where the reader stopped, so a next read moves on. The file opens read-only.
 */
export async function* readBackward(fs, path, { end, blockBytes = 64 * 1024, maxLine = 4 * 1024 * 1024, budget = Infinity } = {}) {
  const handle = await fs.open(path, 'r')
  try {
    let position = end ?? (await handle.stat()).size
    const first = position
    // The parts of the current line after the scan point, oldest first. `lineEnd` is the offset of its newline.
    let parts = []
    let length = 0
    let skipping = false
    let lineEnd
    // The start of the oldest line that came out of this read.
    let oldest
    const collect = part => {
      if (skipping || !part.length) return
      if (length + part.length > maxLine) { skipping = true; parts = []; length = 0; return }
      parts.unshift(part)
      length += part.length
    }
    const emit = start => {
      const value = { line: skipping ? null : Buffer.concat(parts, length).toString('utf8'), start, end: lineEnd + 1 }
      parts = []
      length = 0
      skipping = false
      return value
    }
    while (position > 0) {
      const size = Math.min(blockBytes, position)
      const buffer = Buffer.alloc(size)
      const { bytesRead } = await handle.read(buffer, 0, size, position - size)
      // A file that became shorter during the read has no more complete lines here.
      if (bytesRead < size) return
      position -= size
      let to = size
      while (to > 0) {
        const index = buffer.lastIndexOf(10, to - 1)
        if (index < 0) break
        if (lineEnd !== undefined) {
          collect(buffer.subarray(index + 1, to))
          oldest = position + index + 1
          yield emit(oldest)
        }
        lineEnd = position + index
        to = index
      }
      if (lineEnd !== undefined) collect(buffer.subarray(0, to))
      if (position > 0 && first - position >= budget) { yield { line: null, start: oldest ?? position, end: oldest ?? position, cut: true }; return }
    }
    if (lineEnd !== undefined && (length || skipping)) yield emit(0)
  }
  finally { await handle.close() }
}

/** The bytes that one page of a read from the end scans at most. A query without a match then still gives a cursor. */
export const PAGE_SCAN_BYTES = 8 * 1024 * 1024

/**
 * One page of the entries of a session log, read backwards from the byte offset [before] or from the end of the file.
 * It gives the last [limit] entries whose text, after the secret filter, holds [query], in the order of the log, and
 * `before`: the offset of the oldest line that the page read, or null at the start of the file or when the read gave no
 * line. A page reads at most about 8 MB, so a large log opens without a read of the whole file. Each text is cut to
 * about 2 KB. [secrets] is an optional `KnownSecrets`: the filter removes its exact values too.
 */
export async function newestPage(fs, source, path, { before, limit, query = '', secrets }) {
  const end = before ?? (await fs.stat(path)).size
  const needle = query.toLowerCase()
  const entries = []
  // A read that gives no line, such as of a file that became shorter, gives no cursor, so a caller does not loop.
  let oldest = 0
  for await (const { line, start } of readBackward(fs, path, { end, budget: PAGE_SCAN_BYTES })) {
    oldest = start
    const entry = line ? parseLine(source, line, path)?.parsed.entry : undefined
    if (entry) {
      const { text, clipped } = indexedText(entry.text, secrets)
      if (text.toLowerCase().includes(needle)) entries.push({ ...entry, text, clipped })
    }
    if (entries.length >= limit || end - start >= PAGE_SCAN_BYTES) break
  }
  return { entries: entries.reverse(), before: oldest > 0 ? oldest : null }
}

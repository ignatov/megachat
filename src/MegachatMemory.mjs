import { createHash } from 'node:crypto'
import { chmod, lstat, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { ensurePrivateDirectory } from './MegachatHome.mjs'
import { logEvent, message } from './messages.mjs'
import { redactSecrets } from './SessionText.mjs'

/** The sections of `memory.md` by the name that the tool gives. `forgotten` holds the topics of `forget`. */
export const MEMORY_SECTIONS = ['user', 'notes', 'forgotten']
/** The longest entry and the longest topic that the tool writes, in characters. */
export const ENTRY_LIMIT = 500
export const TOPIC_LIMIT = 80
/** A file above this size in bytes is not read for the prompt and not written. */
export const FILE_LIMIT = 65536
const VERSIONS_KEPT = 20
const UNDONE_KEPT = 5
const TRIES = 3
/**
 * The marks of a prompt injection, in lower case: the instructions to a model and the tags of the prompt sections. The
 * check compares them with the text in lower case, with each run of white space as one space (see [folded]). The list
 * is a best effort: the section also says that the entries are facts and not instructions.
 */
export const INJECTION_MARKS = ['ignore previous', 'ignore all previous', 'ignore the above', 'disregard previous',
  'you are now', 'new instructions', '<memory', '</memory', '<system', '</system', '<|', '[inst]']
/**
 * The characters that the check refuses: each control character but the tab, the line and paragraph separators, the
 * format characters that hide text or change its direction: U+200B, U+2060 to U+2064, U+FEFF, U+202A to U+202E, U+2066
 * to U+2069 and the tags U+E0000 to U+E007F, the interlinear annotation marks U+FFF9 to U+FFFB, the Mongolian vowel
 * separator U+180E, and the Hangul fillers U+115F, U+1160 and U+3164, which show as no character. The joiners U+200C and
 * U+200D, the marks U+200E and U+200F and the soft hyphen U+00AD are parts of normal text, so they pass.
 */
const UNSAFE_CHARACTERS = /[\u0000-\u0008\u000A-\u001F\u007F-\u009F\u2028\u2029\u200B\u2060-\u2064\uFEFF\u202A-\u202E\u2066-\u2069\u{E0000}-\u{E007F}\uFFF9-\uFFFB\u180E\u115F\u1160\u3164]/u
/** A text that starts as a Markdown heading. */
const HEADING_START = /^#{1,6}(\s|$)/
/**
 * The words that the topic rule ignores: the function words of English and Russian, and the word "user", which is in
 * almost each entry.
 */
const STOP_WORDS = new Set(['a', 'an', 'the', 'of', 'in', 'on', 'at', 'to', 'for', 'from', 'by', 'with', 'about', 'and', 'or', 'not', 'no',
  'is', 'are', 'was', 'were', 'be', 'it', 'its', 'this', 'that', 'my', 'me', 'i', 'mine', 'your', 'his', 'her', 'our', 'their',
  'user', 'users', "user's",
  'и', 'в', 'во', 'на', 'с', 'со', 'к', 'ко', 'о', 'об', 'обо', 'от', 'по', 'за', 'из', 'у', 'для', 'до', 'не', 'а', 'но', 'или',
  'что', 'это', 'как', 'же', 'ли', 'бы', 'я', 'мой', 'моя', 'моё', 'мое', 'мои', 'моего', 'моей', 'меня', 'мне', 'его', 'её', 'ее', 'их',
  'пользователь', 'пользователя', 'пользователю', 'пользователем', 'пользователе'])
/** Two words of this count of letters or more match by their stem (see [sameWord]). */
const STEM_FROM = 5
/** The longest difference of the lengths of two words that match by their stem. */
const STEM_LONGER = 3
const CYRILLIC = /^\p{Script=Cyrillic}+$/u
const LATIN = /^\p{Script=Latin}+$/u
const VERSION_NAME = /^(\d{8})\.md$/
const UNDONE_NAME = /^undone-(\d{8})\.md$/
const LAST_WRITE = 'last-write.json'
const BOM = '\uFEFF'

const heading = section => message(`memory.section.${section}`)
const codePoints = text => [...text].length
const normalized = text => text.replace(/\s+/g, ' ').trim().toLowerCase()
/** The text in lower case, with each run of white space, also U+00A0, as one space. */
const folded = text => text.toLowerCase().replace(/\s+/gu, ' ')
const digestOf = text => createHash('sha256').update(text).digest('hex')
const segmenter = new Intl.Segmenter('und', { granularity: 'word' })
/** The words of [text] in the Unicode word rules, in the form NFC and in lower case, without a final `'s` or `’s`. */
const textWords = text => [...segmenter.segment(text.normalize('NFC'))].filter(part => part.isWordLike)
  .map(part => part.segment.toLowerCase().replace(/['’]s$/u, '')).filter(Boolean)
/** The words of a topic that the rule compares: each word that is not a stop word. */
export const topicWords = topic => textWords(topic).filter(word => !STOP_WORDS.has(word))
const escaped = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The forms of an English word that count as the same word: without a final -s or -es, and -y for a final -ies. */
function englishForms(word) {
  const forms = [word]
  if (word.length > 4 && word.endsWith('ies')) forms.push(`${word.slice(0, -3)}y`)
  if (word.length > 4 && word.endsWith('es')) forms.push(word.slice(0, -2))
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) forms.push(word.slice(0, -1))
  return forms
}

/** The count of the letters at the start that the letter lists [left] and [right] share. */
function commonStart(left, right) {
  let count = 0
  while (count < left.length && count < right.length && left[count] === right[count]) count++
  return count
}

/**
 * True when the topic word [term] and the word [item] of an entry are the same word. The rule is a small backstop: the
 * main agent also refuses an entry by its meaning. The words match when one of these is true:
 * - The words are equal.
 * - Both are English words, and a form without -s or -es, or with -y for -ies, is the same: "cats" and "cat",
 *   "salaries" and "salary".
 * - [term] is a Russian word of 3 or 4 letters, [item] has the same first 3 letters, and [item] has at most 2 letters
 *   after the start that both words share: "жена" and "жену", "дети" and "детей", "муж" and "мужа".
 * - Both have 5 or more letters, the shorter word without its last third, rounded down and at least 5 letters, starts the
 *   longer word, and the longer word has at most 3 letters more: "problems" and "problem", "children" and "child".
 */
export function sameWord(term, item) {
  if (term === item) return true
  const [left, right] = [[...term], [...item]]
  if (LATIN.test(term) && LATIN.test(item)) {
    const forms = englishForms(item)
    if (englishForms(term).some(form => forms.includes(form))) return true
  }
  if (CYRILLIC.test(term) && CYRILLIC.test(item) && (left.length === 3 || left.length === 4)) {
    const shared = commonStart(left, right)
    if (shared >= 3 && right.length - shared <= 2) return true
  }
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left]
  if (shorter.length < STEM_FROM || longer.length - shorter.length > STEM_LONGER) return false
  return commonStart(shorter, longer) >= Math.max(STEM_FROM, shorter.length - Math.floor(shorter.length / 3))
}

/** True when the topic word [word] occurs in [list], the words of an entry (see [sameWord]). */
const occurs = (word, list) => list.some(item => sameWord(word, item))

/**
 * The places of [needle] in [haystack], without regard to the case: each `{ index, length }` in the original text, also
 * two places that overlap. The search uses the simple case folding of Unicode, so a letter that `toLowerCase` makes
 * longer does not move a place.
 */
function places(haystack, needle) {
  const pattern = new RegExp(escaped(needle), 'giu')
  const found = []
  for (let match = pattern.exec(haystack); match; match = pattern.exec(haystack)) {
    found.push({ index: match.index, length: match[0].length })
    pattern.lastIndex = match.index + (haystack.codePointAt(match.index) > 0xffff ? 2 : 1)
  }
  return found
}

/** True when [match] is the whole text of [entry] after a merge of the white space, without regard to the case. */
const exact = (entry, match) => new RegExp(`^${escaped(match.replace(/\s+/g, ' ').trim())}$`, 'iu').test(entry.text.replace(/\s+/g, ' ').trim())

/** The text of a new file: a title, a line for the user, and the three headings. */
export function memoryTemplate() {
  return [`# ${message('memory.file.title')}`, '', message('memory.file.hint'), '',
    ...MEMORY_SECTIONS.flatMap(section => [`## ${heading(section)}`, '']), ''].join('\n').replace(/\n+$/, '\n')
}

/**
 * Reads the text of `memory.md`. A heading of a section starts the section, without regard to the case and the white
 * space at the end. Only a heading of level 1 or 2 ends a section: a heading of level 3 or lower is a line of the user
 * in the section. A line that starts with `- ` or `* `, also after an indent, in a section is an entry. A line with an
 * indent of two or more spaces after an entry, and without a bullet, continues the entry. Each other line is ignored:
 * it stays in the file and does not render. A byte order mark at the start does not count. The raw lines keep their
 * `\r` and the mark, so a write changes only the lines of the entry that it addresses.
 */
export function parseMemory(text) {
  const lines = text.split('\n')
  const names = new Map(MEMORY_SECTIONS.map(section => [heading(section).toLowerCase(), section]))
  const headings = {}
  const entries = []
  let section
  let entry
  let ignored = 0
  lines.forEach((raw, index) => {
    const line = (index === 0 && raw.startsWith(BOM) ? raw.slice(BOM.length) : raw).replace(/\r$/, '')
    const title = /^##\s+(.+?)\s*$/.exec(line)
    if (title || /^#{1,2}(\s|$)/.test(line)) {
      section = title ? names.get(title[1].toLowerCase()) : undefined
      if (section && headings[section] === undefined) headings[section] = index
      entry = undefined
      return
    }
    // An indented bullet is an entry of its own, so a write of the entry above it does not change it.
    const bullet = /^([ \t]*[-*] )(.*)$/.exec(line)
    if (section && bullet) {
      entry = { section, start: index, end: index, parts: [{ index, prefix: bullet[1], text: bullet[2] }] }
      entries.push(entry)
      return
    }
    const continued = /^( {2,})(\S.*)$/.exec(line)
    if (entry && continued) {
      entry.parts.push({ index, prefix: continued[1], text: continued[2] })
      entry.end = index
      return
    }
    entry = undefined
    if (line.trim() && line !== message('memory.file.hint')) ignored++
  })
  for (const item of entries) item.text = item.parts.map(part => part.text.trim()).join(' ')
  return { text, lines, eol: text.includes('\r\n') ? '\r' : '', headings, entries, ignored, characters: codePoints(text) }
}

/**
 * The reason why the check of a write refuses [text], else `undefined`: `unsafe` for a character of
 * [UNSAFE_CHARACTERS], a start as a Markdown heading or a mark of [INJECTION_MARKS] in the [folded] text, and `secret`
 * when the secret filter with the exact values of [known] changes the text.
 */
export function unsafeReason(text, known) {
  const lower = folded(text)
  if (UNSAFE_CHARACTERS.test(text) || HEADING_START.test(text.trim()) || INJECTION_MARKS.some(mark => lower.includes(mark))) return 'unsafe'
  if (redactSecrets(text, known) !== text) return 'secret'
  return undefined
}

/**
 * The text of an entry that a result can show: the text of a safe entry, the text after the secret filter for the
 * reason `secret`, and only `[blocked: unsafe]` for the reason `unsafe`.
 */
function visible(text, known) {
  const reason = unsafeReason(text, known)
  return !reason ? text : reason === 'secret' ? redactSecrets(text, known) : message('memory.prompt.blocked', reason)
}

/**
 * The topic of `## Do not remember` that refuses [text]: each word of the topic that is not a stop word occurs in the
 * text (see [occurs]). A topic without such a word refuses nothing.
 */
export function forgottenTopic(text, topics) {
  const list = textWords(text)
  return topics.find(topic => { const terms = topicWords(topic); return terms.length > 0 && terms.every(term => occurs(term, list)) })
}

/**
 * The entry that [match] addresses, else a refusal. With [topics], the topics of `## Do not remember` are entries too.
 * An entry whose whole text is [match] wins. Else the entries that hold [match], without regard to the case: one entry
 * is the address, and more than one is `ambiguous`. Without a match, the result gives at most 3 closest entries: the
 * most words of [match] first, in the order of the file on a tie.
 */
export function addressEntry(doc, match, { known, topics = false } = {}) {
  const entries = doc.entries.filter(entry => topics || entry.section !== 'forgotten')
  const whole = entries.filter(entry => exact(entry, match))
  const found = whole.length ? whole : entries.filter(entry => places(entry.text, match).length > 0)
  if (found.length === 1) return { entry: found[0] }
  if (found.length > 1) return { refusal: { reason: 'ambiguous', candidates: found.map(entry => visible(entry.text, known)) } }
  const terms = topicWords(match)
  const score = entry => { const list = textWords(entry.text); return terms.filter(term => occurs(term, list)).length }
  const closest = entries.map((entry, order) => ({ entry, order, score: score(entry) }))
    .sort((left, right) => right.score - left.score || left.order - right.order).slice(0, 3).map(item => visible(item.entry.text, known))
  return { refusal: { reason: 'noMatch', closest } }
}

const topicsOf = doc => doc.entries.filter(entry => entry.section === 'forgotten').map(entry => entry.text)
const refuse = (reason, fields = {}) => ({ refusal: { reason, ...fields } })

/** The entries of the sections `user` and `notes` that the topic rule of [topic] matches, as a result shows them. */
function topicMatches(doc, topic, known) {
  return doc.entries.filter(entry => entry.section !== 'forgotten' && forgottenTopic(entry.text, [topic])).map(entry => visible(entry.text, known))
}

/** The checks of the new text of an entry. [except] is the entry that a patch changes. A refusal changes nothing. */
function entryRefusal(doc, text, known, except) {
  if (!text.trim()) return refuse('empty')
  if (codePoints(text) > ENTRY_LIMIT) return refuse('tooLong', { limit: ENTRY_LIMIT })
  const unsafe = unsafeReason(text, known)
  if (unsafe) return refuse(unsafe)
  const topic = forgottenTopic(text, topicsOf(doc))
  if (topic) return refuse('forgotten', { topic: visible(topic, known) })
  if (doc.entries.some(entry => entry !== except && entry.section !== 'forgotten' && normalized(entry.text) === normalized(text)))
    return refuse('duplicate')
  return undefined
}

function topicRefusal(topic, known) {
  if (codePoints(topic) > TOPIC_LIMIT) return refuse('tooLong', { limit: TOPIC_LIMIT })
  if (!topicWords(topic).length) return refuse('topic', { note: message('memory.topic.vague') })
  const unsafe = unsafeReason(topic, known)
  return unsafe ? refuse(unsafe) : undefined
}

/**
 * Puts [added] into [lines] before [index]. After the last line of a file without a line end at its end, the last line
 * gets a line end, and the file still has none at its end.
 */
function insertAt(lines, index, added, eol) {
  const block = [...added]
  if (index === lines.length && index > 0) {
    lines[index - 1] += eol
    block[block.length - 1] = block.at(-1).replace(/\r$/, '')
  }
  lines.splice(index, 0, ...block)
}

/** The text of [doc] with a new entry at the end of [section]. A file without the heading gets it at its end. */
function inserted(doc, section, text) {
  const lines = [...doc.lines]
  const bullet = `- ${text}${doc.eol}`
  const last = doc.entries.filter(entry => entry.section === section).at(-1)
  if (last) insertAt(lines, last.end + 1, [bullet], doc.eol)
  else if (doc.headings[section] !== undefined) insertAt(lines, doc.headings[section] + 1, [bullet], doc.eol)
  else {
    const index = lines.at(-1) === '' ? lines.length - 1 : lines.length
    const blank = index > 0 && lines[index - 1].replace(/\r$/, '').trim() ? [doc.eol] : []
    insertAt(lines, index, [...blank, `## ${heading(section)}${doc.eol}`, bullet], doc.eol)
  }
  return lines.join('\n')
}

/** The text of [doc] without the lines of [entry]. */
function removed(doc, entry) {
  const lines = [...doc.lines]
  lines.splice(entry.start, entry.end - entry.start + 1)
  // The entry was the last line of a file without a line end at its end, so the file keeps none.
  if (entry.end === doc.lines.length - 1 && entry.start > 0) lines[entry.start - 1] = lines[entry.start - 1].replace(/\r$/, '')
  return lines.join('\n')
}

/**
 * The lines of [doc] with the span [offset, offset + length) of the text of [entry] replaced by [text]. A span in one
 * line changes only that line. A span over two lines makes the entry one line.
 */
function patched(doc, entry, offset, length, text, after) {
  const lines = [...doc.lines]
  let position = 0
  for (const part of entry.parts) {
    const trimmed = part.text.trim()
    const lead = part.text.indexOf(trimmed)
    if (offset >= position && offset + length <= position + trimmed.length) {
      const start = lead + offset - position
      const carriage = lines[part.index].endsWith('\r') ? '\r' : ''
      lines[part.index] = `${part.prefix}${part.text.slice(0, start)}${text}${part.text.slice(start + length)}${carriage}`
      return lines.join('\n')
    }
    position += trimmed.length + 1
  }
  const carriage = lines[entry.end].endsWith('\r') ? '\r' : ''
  lines.splice(entry.start, entry.end - entry.start + 1, `${entry.parts[0].prefix}${after}${carriage}`)
  return lines.join('\n')
}

/**
 * Applies one action of the tool to the file [doc]. The result is `{ text, result }` for a change, else `{ refusal }`.
 * A forget also gives `forget: true`. Only `undo` reads the versions, so it is not here. A line and a candidate show an
 * entry as [visible] does, so a result never holds the raw text of a blocked entry.
 */
export function applyMemoryAction(doc, args, { known, limit }) {
  // Only a write that makes the file longer can pass the cap, so `remove`, `forget` and `undo` work above it.
  const full = text => codePoints(text) > doc.characters && codePoints(text) > limit ? refuse('full', { characters: doc.characters, limit }) : undefined
  if (args.action === 'add') {
    if (args.section !== 'user' && args.section !== 'notes') return refuse('section')
    const text = typeof args.text === 'string' ? args.text.trim() : ''
    const refusal = entryRefusal(doc, text, known)
    if (refusal) return refusal
    const next = inserted(doc, args.section, text)
    return full(next) ?? { text: next, result: { line: message('memory.line.add', heading(args.section), text) } }
  }
  if (args.action === 'patch' || args.action === 'remove' || args.action === 'forget') {
    const match = typeof args.match === 'string' ? args.match : ''
    if (args.action === 'forget' && !match.trim()) return forget(doc, undefined, args.topic, known)
    if (!match.trim()) return refuse('empty')
    // Only `remove` can address a topic, so that the user can let the agent save a topic again.
    const { entry, refusal } = addressEntry(doc, match, { known, topics: args.action === 'remove' })
    // A forget whose match finds no entry still adds the topic and deletes the versions: an earlier write can have
    // removed the entry, and a version still holds it.
    if (args.action === 'forget' && refusal?.reason === 'noMatch') return forget(doc, undefined, args.topic, known)
    if (refusal) return { refusal }
    if (args.action === 'remove')
      return { text: removed(doc, entry), result: { line: message('memory.line.remove', heading(entry.section), visible(entry.text, known)) } }
    if (args.action === 'forget') return forget(doc, entry, args.topic, known)
    const spans = exact(entry, match) ? [{ index: 0, length: entry.text.length }] : places(entry.text, match)
    if (spans.length > 1) return refuse('ambiguous', { candidates: [visible(entry.text, known)] })
    const [{ index: offset, length }] = spans
    const replacement = typeof args.text === 'string' ? args.text : ''
    const after = `${entry.text.slice(0, offset)}${replacement}${entry.text.slice(offset + length)}`
    const checked = entryRefusal(doc, after, known, entry)
    if (checked) return checked
    const next = patched(doc, entry, offset, length, replacement, after)
    return full(next) ?? { text: next, result: { line: message('memory.line.patch', heading(entry.section), visible(entry.text, known), after) } }
  }
  return refuse('action')
}

/**
 * Removes [entry], when the call gives one, and adds [topic] under `## Do not remember`. The line names only the section
 * and the topic, never the text of the entry, because the reply quotes the line and the search index keeps the reply.
 * `matched` is false when no entry was removed. A forget always deletes the versions and the records of the writes, also
 * without an entry and for a topic that the section already holds: then the file does not change. `otherMatches` gives
 * each other entry that the topic rule matches. The forget does not remove them.
 */
function forget(doc, entry, topic, known) {
  const text = typeof topic === 'string' ? topic.trim() : ''
  const refusal = topicRefusal(text, known)
  if (refusal) return refusal
  const listed = topicsOf(doc).some(item => normalized(item) === normalized(text))
  let next = entry ? removed(doc, entry) : doc.text
  if (!listed) next = inserted(parseMemory(next), 'forgotten', text)
  const otherMatches = topicMatches(parseMemory(next), text, known)
  const line = entry ? message('memory.line.forget', heading(entry.section), heading('forgotten'), text)
    : message(listed ? 'memory.line.topicKept' : 'memory.line.topic', heading('forgotten'), text)
  return { text: next, forget: true, removed: entry ? entry.text : null,
    result: { line, topic: text, matched: entry !== undefined, otherMatches, note: message('memory.forget.note') } }
}

/**
 * The file `memory.md` of the learned memory. One queue writes it, so a write of Megachat waits for the write before
 * it. A write reads the file, applies the action, writes a temporary file and the version, reads the file again, and
 * renames the temporary file only when the second read gives the text of the first read. Else it starts again from the
 * new text. So only the comparison and the rename are between the second read and the rename. A symbolic link stays: the
 * write changes the file of the link. `memory-versions/last-write.json` holds the digest of the file after the last
 * write of Megachat, so `undo` can see a hand edit. [secrets] is the `KnownSecrets` of the daemon. [hooks] are for a
 * test: `afterTemporary` runs after the write of the temporary file, `beforeSecondRead` after the write of the version,
 * and `afterRename` after the rename.
 */
export class MegachatMemory {
  constructor(path, { secrets, hooks = {} } = {}) {
    Object.assign(this, { path, secrets, hooks, versions: join(dirname(path), 'memory-versions') })
    this.queue = Promise.resolve()
  }

  /** The text of the file: the template for a missing file, `unreadable` for a file above [FILE_LIMIT] or not in UTF-8. */
  async read() {
    await this.#ready()
    let bytes
    try { bytes = await readFile(this.path) }
    catch (error) {
      if (error.code !== 'ENOENT') throw error
      const link = await lstat(this.path).then(stats => stats.isSymbolicLink(), () => false)
      return { text: memoryTemplate(), exists: false, raw: null, dangling: link }
    }
    if (bytes.length > FILE_LIMIT) return { unreadable: true, raw: bytes, bytes: bytes.length }
    try { return { text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes), exists: true, raw: bytes } }
    catch { return { unreadable: true, raw: bytes, bytes: bytes.length } }
  }

  /** The SHA-256 of the file text, or `null` for a missing file. */
  async digest() {
    const read = await this.read()
    return read.exists ? digestOf(read.raw) : null
  }

  /**
   * The topics of `## Do not remember` that a model request can name, as the summary request does. A topic that the
   * checks of a write refuse is not in the list: its text can hold an injection or a key. It still refuses an entry.
   */
  async topics() {
    const read = await this.read()
    return read.unreadable ? [] : topicsOf(parseMemory(read.text)).filter(topic => !unsafeReason(topic, this.secrets))
  }

  /** The text of the section `memory` of the system prompt for the cap [limit]. */
  async section(limit) {
    const read = await this.read()
    const lines = [message('memory.prompt.path', this.path), message('memory.prompt.facts')]
    if (read.unreadable) return [...lines, message('memory.prompt.unreadable', FILE_LIMIT)].join('\n')
    const doc = parseMemory(read.text)
    if (!doc.entries.length) lines.push(message('memory.prompt.empty'))
    for (const section of MEMORY_SECTIONS) {
      const entries = doc.entries.filter(entry => entry.section === section)
      if (!entries.length) continue
      lines.push(`${heading(section)}:`)
      for (const entry of entries) {
        const reason = unsafeReason(entry.text, this.secrets)
        lines.push(`- ${reason ? message('memory.prompt.blocked', reason) : entry.text}`)
      }
    }
    if (doc.characters > limit) lines.push(message('memory.prompt.full', doc.characters, limit))
    return lines.join('\n')
  }

  /**
   * The result of `show`. A blocked entry shows as `[blocked: <reason>]` in its section. `blocked` gives its section,
   * its line in the file and its reason, and for the reason `secret` its text after the secret filter. An unsafe text
   * can hold an injection, so no part of it goes to the model.
   */
  async show(limit) {
    const read = await this.read()
    const base = { path: this.path, versions: this.versions, limit }
    if (read.unreadable) return { ...base, reason: 'unreadable', bytes: read.bytes, note: message('memory.unreadable', FILE_LIMIT) }
    const doc = parseMemory(read.text)
    const blocked = []
    const sections = Object.fromEntries(MEMORY_SECTIONS.map(section => [section, doc.entries.filter(entry => entry.section === section)
      .map(entry => {
        const reason = unsafeReason(entry.text, this.secrets)
        if (!reason) return entry.text
        blocked.push({ section, line: entry.start + 1, reason, ...(reason === 'secret' ? { text: redactSecrets(entry.text, this.secrets) } : {}) })
        return message('memory.prompt.blocked', reason)
      })]))
    return { ...base, exists: read.exists, characters: doc.characters, ...sections, blocked, ignoredLines: doc.ignored }
  }

  /**
   * Applies [args] of the tool. [journal] connects the write to the records of the state, so a call that runs again
   * after a restart can find its outcome:
   * - `recorded`: the record of an earlier run of the same call, else `undefined`. When the file has the digest of the
   *   record, the call gives the recorded result. When the file has the digest before that write, the call applies its
   *   action again. Else the file changed after that write, and the call gives the reason `replayed` and changes nothing.
   * - `record({ before, digest, result, forget })`: runs before the rename with the digests of the file before and after
   *   the write. Its result has no `otherMatches`.
   * - `forgotten({ topic, removed })`: runs after the rename of a forget and the delete of the versions. It removes the
   *   other records. [removed] is the text of the removed entry, `null` when the forget removed no entry, and `undefined`
   *   when a call that runs again does not know the text.
   * - `proceed()`: runs in the queue before the write. `false` refuses the write with the reason `stopped`.
   * - `settled(result)`: runs in the queue after the write, so the next write of the queue sees its outcome.
   * A forget deletes each version and each undone file only after its rename, so a forget that ends `busy` keeps them.
   */
  change(args, limit, journal = {}) {
    return this.#serial(async () => {
      if (journal.proceed && !await journal.proceed()) return { changed: false, reason: 'stopped' }
      const result = await this.#write(first => {
        const applied = applyMemoryAction(parseMemory(first.text), args, { known: this.secrets, limit })
        if (applied.refusal) return { refusal: { changed: false, ...applied.refusal } }
        const result = { changed: true, ...applied.result, characters: codePoints(applied.text), limit }
        const { otherMatches, ...stored } = result
        return { text: applied.text, result, stored, forget: applied.forget === true,
          forgotten: applied.forget === true ? { topic: applied.result.topic, removed: applied.removed } : undefined }
      }, journal, args.action)
      await journal.settled?.(result)
      return result
    })
  }

  /**
   * Restores the newest version and removes it from the list. The text that it replaces goes to `undone-<number>.md`
   * in the directory of the versions. Undo is refused when the file is not the file of the last write of Megachat, so
   * it never removes a hand edit, and when a forget deleted the versions.
   */
  undo(limit, journal = {}) {
    return this.#serial(async () => {
      let restored
      return this.#write(async first => {
        const last = await this.#lastWrite()
        let names = await this.#names(VERSION_NAME)
        if (names.length && (!last || last.digest !== (first.exists ? digestOf(first.raw) : null)))
          return { refusal: { changed: false, reason: 'edited', note: message('memory.undo.edited') } }
        // A crash after the rename of an undo can keep the restored version, and that version is the file now.
        while (names.length && first.exists && Buffer.compare(await readFile(join(this.versions, names.at(-1))), first.raw) === 0) {
          await rm(join(this.versions, names.at(-1)), { force: true })
          names = names.slice(0, -1)
        }
        if (!names.length) return { refusal: last?.forget ? { changed: false, reason: 'afterForget', note: message('memory.undo.forget') }
          : { changed: false, reason: 'noVersion' } }
        restored = names.at(-1)
        const text = await readFile(join(this.versions, restored), 'utf8')
        const slot = await this.#slot(UNDONE_NAME, 'undone-', first)
        return { text, result: { changed: true, line: message('memory.line.undo', Number(VERSION_NAME.exec(restored)[1]), slot.path), characters: codePoints(text),
          limit, undone: slot.path }, keep: () => this.#fill(slot) }
      }, journal, 'undo', {
        // The version goes only after the rename, so a crash before it keeps the version.
        after: async () => {
          await rm(join(this.versions, restored), { force: true })
          await this.#prune(UNDONE_NAME, UNDONE_KEPT)
        },
      })
    })
  }

  #serial(operation) {
    const next = this.queue.then(operation)
    this.queue = next.catch(() => {})
    return next
  }

  /**
   * Removes each temporary file that a crash of an earlier daemon left. Such a file can hold a forgotten entry. It runs
   * one time, at the first use of the memory in the daemon.
   */
  #ready() {
    this.prepared ??= (async () => {
      const target = await realpath(this.path).catch(() => this.path)
      for (const [directory, name] of [[dirname(this.path), basename(this.path)], [dirname(target), basename(target)], [this.versions, LAST_WRITE]]) {
        const pattern = new RegExp(`^${escaped(name)}\\.\\d+\\.tmp$`)
        const names = await readdir(directory).catch(() => [])
        for (const item of names.filter(entry => pattern.test(entry))) await rm(join(directory, item), { force: true })
      }
    })()
    return this.prepared
  }

  /**
   * The read, the temporary file, the version, the second read and the rename, at most [TRIES] times. [build] gives the
   * new text for the first read, and its `keep` replaces the copy of the earlier file to `memory-versions/`. A try that
   * starts again removes its version. A forget writes no version, and it deletes the versions only after the rename,
   * before `last-write.json`: a crash between the rename and the delete leaves the old digest there, so `undo` is
   * refused with `edited` until the call runs again. [after] runs after the rename. [journal] is as for [change].
   */
  async #write(build, journal, action, { after } = {}) {
    for (let attempt = 0; attempt < TRIES; attempt++) {
      const first = await this.read()
      if (first.unreadable) return { changed: false, reason: 'unreadable', bytes: first.bytes, note: message('memory.unreadable', FILE_LIMIT) }
      if (first.dangling) return { changed: false, reason: 'link', note: message('memory.link') }
      const before = first.exists ? digestOf(first.raw) : null
      if (attempt === 0 && journal.recorded && journal.recorded.before !== before) return this.#replayed(first, before, journal)
      const built = await build(first)
      if (built.refusal) return built.refusal
      // The temporary file is next to the file of a symbolic link, so the rename stays in one file system and keeps the link.
      const target = first.exists ? await realpath(this.path) : this.path
      const temporary = `${target}.${process.pid}.tmp`
      const digest = digestOf(built.text)
      const forget = built.forget === true
      await journal.record?.({ before, digest, result: built.stored ?? built.result, forget })
      await this.#private(temporary, built.text, false)
      await this.hooks.afterTemporary?.(attempt)
      const kept = built.keep ? await built.keep(first) : forget ? undefined : await this.#version(first)
      await this.hooks.beforeSecondRead?.(attempt)
      const second = await this.read()
      if (!same(first, second)) {
        await rm(temporary, { force: true })
        if (kept) await rm(kept, { force: true })
        continue
      }
      await rename(temporary, target)
      await this.hooks.afterRename?.(attempt)
      await this.#written(digest, forget, journal, built.forgotten)
      await after?.()
      logEvent('log.memory', action, built.result.characters)
      return built.result
    }
    logEvent('log.memory.busy', action)
    return { changed: false, reason: 'busy' }
  }

  /**
   * The steps after the rename of a write with the new [digest]: for a forget, the delete of the versions; then
   * `last-write.json`; then, for a forget, `forgotten` of the [journal] with [forgotten].
   */
  async #written(digest, forget, journal, forgotten) {
    if (forget) await this.#purge()
    const last = await this.#lastWrite()
    await this.#private(join(this.versions, LAST_WRITE), JSON.stringify({ digest, forget: forget || last?.forget === true }), true, true)
    if (forget) await journal.forgotten?.(forgotten)
  }

  /**
   * The answer to a call that runs again when the file [first] does not have the digest before the recorded write. When
   * the file has the digest of the record, the write was renamed: the call does the steps after the rename again and
   * gives the recorded result, with the `otherMatches` of a forget from the file. Else the file changed after the write,
   * and the call does not apply its action again: a match can now address another entry.
   */
  async #replayed(first, current, journal) {
    const { recorded } = journal
    if (recorded.digest !== current) return { changed: false, reason: 'replayed', note: message('memory.replayed') }
    // The record does not hold the text of the removed entry, because a forget must not keep it.
    const forgotten = recorded.forget === true ? { topic: recorded.result.topic, removed: recorded.result.matched ? undefined : null } : undefined
    await this.#written(current, recorded.forget === true, journal, forgotten)
    if (!recorded.forget) return recorded.result
    return { ...recorded.result, otherMatches: topicMatches(parseMemory(first.text), recorded.result.topic, this.secrets) }
  }

  /** Keeps the earlier file, or the template for a missing file, as the newest version, and the newest 20 versions. */
  async #version(first) {
    const path = await this.#fill(await this.#slot(VERSION_NAME, '', first))
    await this.#prune(VERSION_NAME, VERSIONS_KEPT)
    return path
  }

  /**
   * The file of [pattern] for the earlier file [first]: the newest file when it holds the same bytes, as after a write
   * that runs again, else a new file with the next number.
   */
  async #slot(pattern, prefix, first) {
    const content = first.exists ? first.raw : Buffer.from(first.text)
    const newest = (await this.#names(pattern)).at(-1)
    if (newest && Buffer.compare(await readFile(join(this.versions, newest)), content) === 0) return { path: join(this.versions, newest), content, exists: true }
    const number = await this.#next(pattern)
    return { path: join(this.versions, `${prefix}${number}.md`), content, exists: false }
  }

  /** Writes the file of a new [slot]. The result is the path of a new file, else `undefined`. */
  async #fill(slot) {
    if (slot.exists) { await ensurePrivateDirectory(this.versions); return undefined }
    await this.#private(slot.path, slot.content)
    return slot.path
  }

  /** Deletes each version and each undone file, for a forget. */
  async #purge() {
    await ensurePrivateDirectory(this.versions)
    for (const name of await this.#list()) if (VERSION_NAME.test(name) || UNDONE_NAME.test(name)) await rm(join(this.versions, name), { force: true })
  }

  async #prune(pattern, kept) {
    const names = await this.#names(pattern)
    for (const name of names.slice(0, Math.max(0, names.length - kept))) await rm(join(this.versions, name), { force: true })
  }

  /** The names of [pattern] in the order of their numbers. */
  async #names(pattern) {
    return (await this.#list()).filter(name => pattern.test(name)).sort((left, right) => Number(pattern.exec(left)[1]) - Number(pattern.exec(right)[1]))
  }

  /** The next number of [pattern]: one more than the highest number in the directory, with 8 digits. */
  async #next(pattern) {
    const newest = (await this.#names(pattern)).at(-1)
    return String(newest ? Number(pattern.exec(newest)[1]) + 1 : 1).padStart(8, '0')
  }

  async #list() {
    return readdir(this.versions).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  }

  /** The record of the last write of Megachat: the digest of the file after it, and whether a forget deleted the versions. */
  async #lastWrite() {
    try { return JSON.parse(await readFile(join(this.versions, LAST_WRITE), 'utf8')) }
    catch { return undefined }
  }

  /**
   * Writes [content] with the mode 0600. With [versions], the directory of the versions gets the mode 0700 first. With
   * [atomic], a temporary file and a rename write it.
   */
  async #private(path, content, versions = true, atomic = false) {
    if (versions) await ensurePrivateDirectory(this.versions)
    const written = atomic ? `${path}.${process.pid}.tmp` : path
    await writeFile(written, content, { mode: 0o600 })
    if (process.platform !== 'win32') await chmod(written, 0o600)
    if (atomic) await rename(written, path)
  }
}

const same = (first, second) => first.exists === second.exists && !second.unreadable
  && (first.raw === null ? second.raw === null : second.raw !== null && Buffer.compare(first.raw, second.raw) === 0)

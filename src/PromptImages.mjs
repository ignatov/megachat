import { readFile, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { message } from './messages.mjs'

/** At most this many images go with one prompt. */
export const MAX_IMAGES = 4
/** The limit of one image, in characters of base64: the limit of the tool `read` of Pi Durable. */
export const MAX_IMAGE_BASE64 = 4_500_000
/** The same limit in bytes of the file. */
export const MAX_IMAGE_BYTES = Math.floor(MAX_IMAGE_BASE64 / 4) * 3
/** The model context holds the images of this many last user messages with images. */
export const CONTEXT_IMAGE_MESSAGES = 3
/** The text of an image that left the model context. */
export const IMAGE_PLACEHOLDER = '[image removed from the context]'

const EXTENSION = /\.(png|jpe?g|gif|webp)$/i
const MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** The MIME type from the first bytes of [bytes], or `undefined` for a format that the model does not take. */
export function sniffImage(bytes) {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp'
  return undefined
}

/** The paths of image files that [text] names: `@path`, a Markdown image or link with a path or a `file:` URI. */
export function imagePaths(text, home = homedir()) {
  const found = []
  const add = raw => {
    let path = raw
    try {
      if (path.startsWith('file://')) path = fileURLToPath(path)
      else if (path.startsWith('~/')) path = home + path.slice(1)
    }
    catch { return }
    if (path.startsWith('/') && EXTENSION.test(path) && !found.includes(path)) found.push(path)
  }
  for (const link of text.matchAll(/!?\[[^\]]*\]\((?:<([^>\n]+)>|([^)\s]+))\)/g)) {
    const target = link[1] ?? link[2]
    let decoded = target
    // A `file:` URI and a bare target use percent codes. A target in angle brackets is a path as it is.
    if (link[1] === undefined) try { decoded = decodeURIComponent(target) } catch { /* Keep the raw target. */ }
    add(link[1] === undefined ? decoded : target)
  }
  for (const mention of text.matchAll(/(?:^|\s)@((?:~|\/)[^\s<>]+)/g)) add(mention[1].replace(/[.,;:!?)\]]+$/, ''))
  return found
}

/**
 * Makes the images of a prompt: the image blocks [inline] (`{ mimeType, data }`) and the image files that [text] names.
 * Gives `{ images, notes }`. An image that Megachat cannot attach gives a note, never an error. A file counts only
 * under [home], as a regular file of a known image format.
 */
export async function promptImages(text, inline = [], { home = homedir() } = {}) {
  const images = []
  const notes = []
  const seen = new Set()
  const skip = (name, reason) => notes.push(message('prompt.imageSkipped', name, message(`prompt.imageSkipped.${reason}`)))
  const accept = (name, mimeType, data) => {
    if (images.length >= MAX_IMAGES) return skip(name, 'tooMany')
    images.push({ mimeType, data })
  }
  for (const [index, image] of inline.entries()) {
    const name = `#${index + 1}`
    if (!MIME_TYPES.has(image.mimeType)) skip(name, 'unsupported')
    else if (image.data.length > MAX_IMAGE_BASE64) skip(name, 'tooLarge')
    else accept(name, image.mimeType, image.data)
  }
  let root
  for (const path of imagePaths(text, home)) {
    try {
      root ??= await realpath(home)
      const real = await realpath(path)
      if (seen.has(real)) continue
      seen.add(real)
      if (!real.startsWith(root + sep)) { skip(path, 'outside'); continue }
      const info = await stat(real)
      if (!info.isFile()) { skip(path, 'unreadable'); continue }
      if (info.size > MAX_IMAGE_BYTES) { skip(path, 'tooLarge'); continue }
      const bytes = await readFile(real)
      const mimeType = sniffImage(bytes)
      if (!mimeType) skip(path, 'unsupported')
      else accept(path, mimeType, bytes.toString('base64'))
    }
    catch (error) { skip(path, error?.code === 'ENOENT' ? 'missing' : 'unreadable') }
  }
  return { images, notes }
}

/** The content of a user message: the text with the notes, then each image. A prompt without an image keeps a string. */
export function promptContent(text, { images, notes }) {
  const full = notes.length ? `${text}\n\n${notes.join('\n')}` : text
  if (images.length === 0) return full
  return [{ type: 'text', text: full }, ...images.map(image => ({ type: 'image', data: image.data, mimeType: image.mimeType }))]
}

/**
 * The messages of a model request, where each image of a user message is a placeholder, except the images of the last
 * [CONTEXT_IMAGE_MESSAGES] user messages with images. The rule depends on the position only, so the prefix of the
 * prompt cache changes only when a new image arrives. Gives [messages] itself when nothing changes.
 */
export function limitImages(messages, keep = CONTEXT_IMAGE_MESSAGES) {
  const hasImage = model => model.role === 'user' && Array.isArray(model.content) && model.content.some(block => block.type === 'image')
  const indexes = messages.flatMap((model, index) => hasImage(model) ? [index] : [])
  const old = new Set(indexes.slice(0, Math.max(0, indexes.length - keep)))
  if (old.size === 0) return messages
  return messages.map((model, index) => !old.has(index) ? model : {
    ...model, content: model.content.map(block => block.type === 'image' ? { type: 'text', text: IMAGE_PLACEHOLDER } : block),
  })
}

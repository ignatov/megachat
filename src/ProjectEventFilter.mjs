/** The noise sources of the issue: TextMate bundles, the downloads of a build, and the local rules of Claude Code. */
export const DEFAULT_EVENT_IGNORE = ['*.tmbundle', 'build/download', '.claude/settings.local.json']
const PATTERN_LIMIT = 50
const PATTERN_LENGTH = 200

/** Gives the pattern without a leading `./` or `/` and without a trailing `/`, or `undefined` for an invalid pattern. */
function normalizePattern(text) {
  if (typeof text !== 'string') return undefined
  const pattern = text.trim().replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!pattern || pattern.length > PATTERN_LENGTH || /[\0\\]/.test(pattern)) return undefined
  return pattern.split('/').some(part => part === '' || part === '.' || part === '..') ? undefined : pattern
}

/**
 * Reads the setting `events.ignore`: an array of patterns, or one text with the patterns apart by commas or new lines.
 * Gives the list without blanks and repetitions, or `undefined` when a pattern is invalid or the list is too long.
 */
export function eventPatterns(value) {
  const items = Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[,\n]/) : undefined
  if (!items) return undefined
  const texts = items.filter(item => typeof item !== 'string' || item.trim())
  if (texts.length > PATTERN_LIMIT) return undefined
  const patterns = texts.map(normalizePattern)
  return patterns.includes(undefined) ? undefined : [...new Set(patterns)]
}

/** The regular expression of a glob: `*` in one path segment, `**` across segments, `?` for one character. */
function globSource(pattern) {
  let source = ''
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      index++
      if (pattern[index + 1] === '/') { index++; source += '(?:.*/)?' }
      else source += '.*'
    }
    else if (character === '*') source += '[^/]*'
    else if (character === '?') source += '[^/]'
    else source += character.replace(/[.+^${}()|[\]]/g, '\\$&')
  }
  return source
}

/**
 * Gives a function that tells whether Megachat does not report a project-relative path. A pattern without a slash
 * matches the name of a file or a directory at each depth. A pattern with a slash matches the path from the root of the
 * project. A path in a matching directory matches too.
 */
export function eventMatcher(patterns) {
  const tests = patterns.map(pattern => {
    const source = globSource(pattern)
    if (pattern.includes('/')) {
      const expression = new RegExp(`^${source}(?:/.*)?$`)
      return path => expression.test(path)
    }
    const expression = new RegExp(`^${source}$`)
    return path => path.split('/').some(part => expression.test(part))
  })
  return path => tests.some(test => test(path))
}

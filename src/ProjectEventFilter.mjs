/** The noise sources of the issue: TextMate bundles, the downloads of a build, and the local rules of Claude Code. */
export const DEFAULT_EVENT_IGNORE = ['*.tmbundle', 'build/download', '.claude/settings.local.json']
const PATTERN_LIMIT = 50
const PATTERN_LENGTH = 200

/**
 * Gives the pattern without a trailing `/`, or `undefined` for an invalid pattern. A leading `./` or `/` becomes one
 * `/`, which keeps the match from the root of the project.
 */
function normalizePattern(text) {
  if (typeof text !== 'string') return undefined
  const trimmed = text.trim()
  const pattern = trimmed.replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '')
  if (!pattern || pattern.length > PATTERN_LENGTH || /[\0\\]/.test(pattern)) return undefined
  if (pattern.split('/').some(part => part === '' || part === '.' || part === '..')) return undefined
  return /^\.?\//.test(trimmed) ? `/${pattern}` : pattern
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

/** The matcher reads no path that is longer than the `PATH_MAX` of macOS. Such a path does not match. */
const PATH_READ_LIMIT = 1024
// The kinds of the steps of a glob. `*` matches in one path segment, `**` matches across segments, and `**/` matches
// nothing or a text that ends with a slash.
const CHARACTER = 0, ONE = 1, SEGMENT = 2, ANY = 3, DIRECTORIES = 4

/** Gives the steps of a glob: `*` in one path segment, `**` across segments, `?` for one character. */
function globSteps(pattern) {
  const steps = []
  for (let index = 0; index < pattern.length; index++) {
    const character = pattern[index]
    if (character === '*' && pattern[index + 1] === '*') {
      index++
      if (pattern[index + 1] === '/') { index++; steps.push({ kind: DIRECTORIES }) }
      else steps.push({ kind: ANY })
    }
    else if (character === '*') steps.push({ kind: SEGMENT })
    else if (character === '?') steps.push({ kind: ONE })
    else steps.push({ kind: CHARACTER, character })
  }
  return steps
}

/**
 * Gives a function that runs the steps as a set of states over the characters of a text, without backtracking. One
 * text takes at most the count of the steps times the length of the text. With `prefix`, the text matches also when
 * the steps match the text before a slash.
 */
function globAutomaton(pattern, prefix) {
  const steps = globSteps(pattern)
  const end = steps.length
  let active = new Uint8Array(end + 1)
  let next = new Uint8Array(end + 1)
  // A wildcard step can match nothing, so a state of a wildcard also enters the state after it.
  const enter = (states, state) => {
    while (!states[state]) {
      states[state] = 1
      if (state === end || steps[state].kind < SEGMENT) return
      state++
    }
  }
  return text => {
    active.fill(0)
    enter(active, 0)
    for (let index = 0; index < text.length; index++) {
      const character = text[index]
      if (prefix && character === '/' && active[end]) return true
      next.fill(0)
      let alive = false
      for (let state = 0; state < end; state++) {
        if (!active[state]) continue
        const step = steps[state]
        switch (step.kind) {
          case CHARACTER: if (step.character === character) enter(next, state + 1); break
          case ONE: if (character !== '/') enter(next, state + 1); break
          case SEGMENT: if (character !== '/') enter(next, state); break
          case ANY: enter(next, state); break
          // The state stays without an entry, because only its first entry can match nothing. The loop reads the states
          // in order, and each step goes forward, so each entry of this state in `next` came before this line.
          case DIRECTORIES: next[state] = 1; if (character === '/') enter(next, state + 1); break
        }
        alive = true
      }
      if (!alive) return false
      ;[active, next] = [next, active]
    }
    return active[end] === 1
  }
}

/**
 * Gives a function that tells whether Megachat does not report a project-relative path. A pattern without a slash
 * matches the name of a file or a directory at each depth. A pattern with a slash, also a leading slash, matches the
 * path from the root of the project. A path in a matching directory matches too.
 */
export function eventMatcher(patterns) {
  const tests = patterns.map(pattern => {
    if (pattern.includes('/')) return globAutomaton(pattern.replace(/^\//, ''), true)
    const matches = globAutomaton(pattern, false)
    return path => path.split('/').some(matches)
  })
  return path => path.length <= PATH_READ_LIMIT && tests.some(test => test(path))
}

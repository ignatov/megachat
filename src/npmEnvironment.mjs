import { basename, delimiter, dirname, isAbsolute } from 'node:path'

/**
 * The environment of npm in a process that npm or npx started. The entry of `acp.json` starts Megachat with `npx`, and
 * npx gives Megachat its own variables and `PATH` entries. The daemon and each child must get the environment that the
 * IDE gives a direct command instead: the first `node_modules/.bin` directory on the `PATH` of npx holds the `codex`,
 * the `codex-acp` and the `claude-agent-acp` of the dependencies.
 *
 * This module has only `node:` imports, so a test can run it without the dependencies.
 */

/**
 * The variables that the IDE adds for the command `npx`. They configure the install of the agent, and each npm command
 * of a child would use the cache of the IDE. The IDE also adds `NODE_USE_SYSTEM_CA`, and that variable stays.
 */
export const IDE_NPM_VARIABLES = ['NPM_CONFIG_CACHE', 'NPM_CONFIG_MIN_RELEASE_AGE', 'NPM_CONFIG_GLOBAL', 'NPM_CONFIG_DRY_RUN',
  'NPM_CONFIG_INCLUDE', 'NPM_CONFIG_ENGINE_STRICT', 'NPM_CONFIG_STRICT_PEER_DEPS']

/** Whether npm or npx started the process of [environment]. npm sets `npm_execpath` in each process that it starts. */
export function startedByNpm(environment) {
  return typeof environment.npm_execpath === 'string' && environment.npm_execpath !== ''
}

/**
 * Whether [entry] of a `PATH` is a directory that npm adds: a `node_modules/.bin` directory, or the `node-gyp-bin`
 * directory of npm. npm adds only absolute paths, so a relative entry of the user stays.
 */
export function npmPathEntry(entry) {
  if (!isAbsolute(entry)) return false
  const directory = entry.replace(/[\\/]+$/, '')
  return basename(directory) === 'node-gyp-bin' || (basename(directory) === '.bin' && basename(dirname(directory)) === 'node_modules')
}

/**
 * [path] without the entries that npm put before it. npm puts the `node_modules/.bin` directories first, then its
 * `node-gyp-bin` directory, then the `PATH` that it got. So a `node_modules/.bin` directory of the user after these
 * entries stays.
 */
function withoutNpmPath(path, pathDelimiter) {
  const entries = path.split(pathDelimiter)
  let start = 0
  while (start < entries.length && npmPathEntry(entries[start])) {
    start++
    if (basename(entries[start - 1].replace(/[\\/]+$/, '')) === 'node-gyp-bin') break
  }
  return entries.slice(start).join(pathDelimiter)
}

/**
 * [environment] without the environment of npm, when npm started the process. Else [environment] stays as it is.
 *
 * npm adds the variables `npm_*`, `INIT_CWD`, `COLOR`, `NODE` and `EDITOR`, and the entries at the start of `PATH`.
 * The result has none of them, and none of [IDE_NPM_VARIABLES]. Another `NPM_CONFIG_*` variable comes from the user,
 * and it stays. npm sets `EDITOR` to `EDITOR`, `VISUAL` or `vi`, so an `EDITOR` with the value of `VISUAL` or with the
 * default of npm goes. A program that reads `EDITOR` uses the same editor without it. npm removes duplicates from the
 * `PATH` that it gets, so a duplicate of the IDE does not come back.
 */
export function withoutNpm(environment, { pathDelimiter = delimiter, platform = process.platform } = {}) {
  if (!startedByNpm(environment)) return environment
  const npmEditor = environment.VISUAL ?? (platform === 'win32' ? 'notepad.exe' : 'vi')
  const result = {}
  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith('npm_') || IDE_NPM_VARIABLES.includes(name) || name === 'INIT_CWD' || name === 'COLOR') continue
    if (name === 'NODE' && value === environment.npm_node_execpath) continue
    if (name === 'EDITOR' && value === npmEditor) continue
    result[name] = /^path$/i.test(name) ? withoutNpmPath(value, pathDelimiter) : value
  }
  return result
}

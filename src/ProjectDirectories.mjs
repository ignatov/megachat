import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { message, requireCondition } from './messages.mjs'

/** More roots, besides the home directory of the user, that can hold a known repository. */
export const ROOTS_VARIABLE = 'MEGACHAT_PROJECT_ROOTS'
export const KNOWN_PROJECTS_LIMIT = 100
/** The directories of the home directory that hold the data of applications, not repositories. */
const applicationDirectories = new Set(['Library', 'AppData'])

export function projectRoots(environment = process.env) {
  return (environment[ROOTS_VARIABLE] ?? '').split(delimiter).filter(isAbsolute).map(path => resolve(path))
}

/** Replaces a `~` at the start of the path with the home directory. */
export function expandHome(path, home = homedir()) {
  return path === '~' ? home : path.startsWith('~/') || path.startsWith(`~${sep}`) ? join(home, path.slice(2)) : path
}

const inside = (root, path) => {
  const rest = relative(root, path)
  return rest !== '' && !rest.startsWith('..') && !isAbsolute(rest)
}

/**
 * Gives the real path of a directory that can become a known repository. The path must be absolute or start with `~`.
 * The real path must be an existing directory in the home directory of the user or in an allowed root. Thus a
 * symbolic link cannot lead out of these directories. The home directory itself, its application data, its hidden
 * directories and the state directory of Megachat are refused.
 */
export async function resolveRepository(path, { home = homedir(), roots = projectRoots(), stateDirectory } = {}) {
  requireCondition(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'), 'directory')
  const expanded = expandHome(path, home)
  requireCondition(isAbsolute(expanded), 'directory')
  const real = directory => realpath(directory).catch(() => undefined)
  const canonical = await real(expanded)
  requireCondition(canonical && (await stat(canonical)).isDirectory(), 'directory')
  const state = stateDirectory && await real(stateDirectory)
  requireCondition(!state || canonical !== state && !inside(state, canonical), 'directory')
  for (const root of roots) {
    const allowed = await real(root)
    if (allowed && (canonical === allowed || inside(allowed, canonical))) return canonical
  }
  const userHome = await real(home)
  requireCondition(userHome && inside(userHome, canonical), 'directory')
  const first = relative(userHome, canonical).split(sep)[0]
  requireCondition(!first.startsWith('.') && !applicationDirectories.has(first), 'directory')
  return canonical
}

/**
 * The directories where a child can work, each one time, with its origin: `megachat` for the workspace of Megachat,
 * `ide` for a project that an IDE registered, and `known` for a repository of the known list.
 */
export function directoriesOf(state) {
  const directories = new Map()
  const add = (cwd, origin, name) => { if (!directories.has(cwd)) directories.set(cwd, { cwd, origin, ...(name ? { name } : {}) }) }
  if (state.megachatWorkspace) add(state.megachatWorkspace, 'megachat', message('workspace.name'))
  for (const cwd of state.workspaces ?? []) add(cwd, 'ide')
  for (const cwd of state.projects ?? []) add(cwd, 'known')
  return [...directories.values()]
}

export function isDirectoryOf(state, cwd) {
  return state.megachatWorkspace === cwd || (state.workspaces ?? []).includes(cwd) || (state.projects ?? []).includes(cwd)
}

/**
 * Gives the listed directory that the path names. The path can start with `~`, and it can be a symbolic link to a
 * listed directory: the real path comes first, because an IDE and the known list register real paths.
 */
export async function listedDirectory(state, cwd, home = homedir()) {
  requireCondition(typeof cwd === 'string' && cwd.length > 0 && cwd.length <= 4096)
  const canonical = await realpath(expandHome(cwd, home)).catch(() => undefined)
  if (canonical !== undefined && isDirectoryOf(state, canonical)) return canonical
  requireCondition(isDirectoryOf(state, cwd), 'workspace')
  return cwd
}

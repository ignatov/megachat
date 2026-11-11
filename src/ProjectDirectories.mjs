import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { message, requireCondition } from './messages.mjs'

/** More roots, besides the home directory of the user, that can hold a known repository. */
export const ROOTS_VARIABLE = 'MEGACHAT_PROJECT_ROOTS'
export const KNOWN_PROJECTS_LIMIT = 100
/** The most repositories that one discovery gives. */
export const DISCOVERY_LIMIT = 200
/** The directories of the home directory that the discovery scans, besides the roots of `MEGACHAT_PROJECT_ROOTS`. */
const DISCOVERY_DIRECTORIES = ['src', 'IdeaProjects']
/** One directory name: a letter, a digit or `_` first, then also `.` and `-`. So it cannot be hidden or leave its root. */
const PROJECT_NAME = /^[\p{L}\p{N}_][\p{L}\p{N}._-]{0,99}$/u
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
 * symbolic link cannot lead out of these directories. The home directory itself, its application data, the hidden
 * directories directly in it and the state directory of Megachat are refused.
 */
export async function resolveRepository(path, { home = homedir(), roots = projectRoots(), stateDirectory } = {}) {
  requireCondition(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'), 'directory')
  const expanded = expandHome(path, home)
  requireCondition(isAbsolute(expanded), 'directory')
  const canonical = await real(expanded)
  requireCondition(canonical && (await stat(canonical)).isDirectory(), 'directory')
  requireCondition(await allowedLocation(canonical, { home, roots, stateDirectory }), 'directory')
  return canonical
}

const real = directory => realpath(directory).catch(() => undefined)

/** Tells whether a directory of the relative path [rest] is hidden. */
const hidden = rest => rest.split(sep).some(part => part.startsWith('.'))

/**
 * Tells whether a real path can hold a known repository: it is in an allowed root or in the home directory, out of the
 * application data and the hidden directories of the home directory, and out of the state directory. A repository that
 * the user names can be in a hidden directory deeper in the home directory or in a root. [newProjects] is for the
 * directory of the new projects: it permits the home directory itself, and it refuses each hidden directory below the
 * home directory or the root, because Megachat chooses that place itself.
 */
async function allowedLocation(canonical, { home, roots, stateDirectory, newProjects = false }) {
  const state = stateDirectory && await real(stateDirectory)
  if (state && (canonical === state || inside(state, canonical))) return false
  for (const root of roots) {
    const allowed = await real(root)
    if (allowed && (canonical === allowed || inside(allowed, canonical))) return !newProjects || !hidden(relative(allowed, canonical))
  }
  const userHome = await real(home)
  if (newProjects && canonical === userHome) return true
  if (!userHome || !inside(userHome, canonical)) return false
  const rest = relative(userHome, canonical)
  const first = rest.split(sep)[0]
  return !first.startsWith('.') && !applicationDirectories.has(first) && !(newProjects && hidden(rest))
}

/** The real path of [path], also when its last parts do not exist yet: the real path of the nearest existing parent. */
async function plannedPath(path) {
  const missing = []
  for (let current = path; ; current = dirname(current)) {
    const canonical = await real(current)
    if (canonical) return join(canonical, ...missing)
    if (dirname(current) === current) return undefined
    missing.unshift(basename(current))
  }
}

const exists = path => lstat(path).then(() => true, () => false)
const emptyDirectory = path => readdir(path).then(entries => entries.length === 0, () => false)

/**
 * Makes the directory of a new project: `<root>/<name>`, or `<root>/<name>-2` and so on when the name is taken. The root
 * must be a place for a known repository or the home directory, and the daemon makes it when it does not exist.
 * `mkdir` refuses an existing directory, so two calls cannot get the same directory.
 * [reserve] records a path before its `mkdir`. A call again after a stop gives the recorded path as [reserved]: an empty
 * directory there is the directory of the first call, and the call uses it again.
 */
export async function createProjectDirectory(root, name, { home = homedir(), roots = projectRoots(), stateDirectory } = {},
  { reserve = async () => {}, reserved } = {}) {
  requireCondition(typeof name === 'string' && PROJECT_NAME.test(name), 'projectName')
  requireCondition(typeof root === 'string' && isAbsolute(expandHome(root, home)), 'newRoot')
  const planned = await plannedPath(resolve(expandHome(root, home)))
  requireCondition(planned && await allowedLocation(planned, { home, roots, stateDirectory, newProjects: true }), 'newRoot')
  await mkdir(planned, { recursive: true })
  const names = Array.from({ length: 100 }, (_, index) => index ? `${name}-${index + 1}` : name)
  if (reserved && dirname(reserved) === planned && names.includes(basename(reserved)) && await emptyDirectory(reserved)) return reserved
  for (const path of names.map(item => join(planned, item))) {
    if (await exists(path)) continue
    await reserve(path)
    try {
      await mkdir(path)
      return path
    }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  return requireCondition(false, 'projectName')
}

/** The time of the last change of the `.git` entry of [directory], or `undefined` without one. It follows no link. */
async function gitTime(directory) {
  const status = await lstat(join(directory, '.git')).catch(() => undefined)
  return status && (status.isDirectory() || status.isFile()) ? status.mtimeMs : undefined
}

/** The directories in [directory] that are not hidden. A symbolic link is no directory here, so the scan does not follow it. */
async function subdirectories(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
  return entries.filter(entry => entry.isDirectory() && !entry.name.startsWith('.')).map(entry => join(directory, entry.name))
}

/**
 * Finds the git repositories in `~/src`, in `~/IdeaProjects` and in each root of `MEGACHAT_PROJECT_ROOTS`: a directory of
 * a root, or a directory in a directory of a root, that holds a `.git` entry. The scan does not go into a repository,
 * follows no symbolic link and reads no file. It gives at most [limit] repositories that are not in [listed], the
 * newest change of `.git` first, and `truncated` when more exist.
 */
export async function discoverRepositories({ home = homedir(), roots = projectRoots(), listed = [], limit = DISCOVERY_LIMIT } = {}) {
  const skipped = new Set(listed)
  const scanned = new Set()
  const found = []
  for (const start of [...DISCOVERY_DIRECTORIES.map(name => join(home, name)), ...roots]) {
    const status = await lstat(start).catch(() => undefined)
    const root = status?.isDirectory() && await real(start)
    if (!root || scanned.has(root)) continue
    scanned.add(root)
    for (const child of await subdirectories(root)) {
      const time = await gitTime(child)
      const candidates = time !== undefined ? [[child, time]]
        : await Promise.all((await subdirectories(child)).map(async path => [path, await gitTime(path)]))
      for (const [cwd, changed] of candidates) {
        if (changed === undefined || skipped.has(cwd)) continue
        // A root in another root gives the same repository two times.
        skipped.add(cwd)
        found.push({ cwd, changed })
      }
    }
  }
  found.sort((left, right) => right.changed - left.changed)
  return { repositories: found.slice(0, limit).map(({ cwd, changed }) => ({ cwd, changedAt: new Date(changed).toISOString() })),
    truncated: found.length > limit, roots: [...scanned] }
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

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { lstat, mkdir, readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { message, requireCondition } from './messages.mjs'

/** More roots that the discovery scans and that can hold the directory of the new projects, also out of the home directory. */
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

/**
 * The key of a directory: its real path. So two names of one directory, such as a path through a symbolic link, give one
 * key. A directory that the daemon cannot read gives its absolute path.
 */
export function directoryKey(cwd) {
  try { return realpathSync.native(cwd) }
  catch { return resolve(String(cwd)) }
}

/** True when [inner] is [outer] or a directory in it. The check compares path segments, so `/app2` is not in `/app`. */
export const isWithin = (inner, outer) => {
  const path = relative(outer, inner)
  return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)
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
 * The real path must be an existing directory. The user can name a directory in the home directory or out of it. The
 * root of the file system, the home directory and each directory that holds it, the application data and the hidden
 * directories directly in the home directory, and the state directory of Megachat are refused. The check uses the real
 * path, so a symbolic link cannot lead into a refused directory.
 */
export async function resolveRepository(path, { home = homedir(), stateDirectory } = {}) {
  requireCondition(typeof path === 'string' && path.length > 0 && path.length <= 4096 && !path.includes('\0'), 'directory')
  const expanded = expandHome(path, home)
  requireCondition(isAbsolute(expanded), 'directory')
  const canonical = await real(expanded)
  requireCondition(canonical && (await stat(canonical)).isDirectory(), 'directory')
  requireCondition(await allowedRepository(canonical, { home, stateDirectory }), 'directory')
  return canonical
}

/** Tells whether the real path [canonical] can be a known repository (see `resolveRepository`). */
async function allowedRepository(canonical, { home, stateDirectory }) {
  if (dirname(canonical) === canonical) return false
  const state = stateDirectory && await real(stateDirectory)
  if (state && (isWithin(canonical, state) || isWithin(state, canonical))) return false
  const userHome = await real(home) ?? resolve(home)
  if (isWithin(userHome, canonical)) return false
  if (!inside(userHome, canonical)) return true
  const first = relative(userHome, canonical).split(sep)[0]
  return !first.startsWith('.') && !applicationDirectories.has(first)
}

const real = directory => realpath(directory).catch(() => undefined)

/** Tells whether a directory of the relative path [rest] is hidden. */
const hidden = rest => rest.split(sep).some(part => part.startsWith('.'))

/**
 * Tells whether a real path can be the directory of the new projects or a project in it: it is in an allowed root or in
 * the home directory, out of the application data and the hidden directories of the home directory, and out of the
 * state directory. [newProjects] permits the home directory itself, and it refuses each hidden directory below the home
 * directory or the root, because Megachat chooses that place itself.
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


/** The longest `.git` file or `commondir` file that the detection reads. A real one has one short line. */
const GIT_FILE_LIMIT = 4096

/** The first line of a small file, or `undefined` when the file is missing, too big or not readable. */
function firstLine(path) {
  try {
    const text = readFileSync(path, 'utf8')
    return text.length <= GIT_FILE_LIMIT ? text.split('\n')[0].trim() : undefined
  }
  catch { return undefined }
}

/**
 * Gives the real path of the main repository when [directory] is a linked worktree of git, else `undefined`. A linked
 * worktree has a `.git` file, not a directory, with the line `gitdir: <main>/.git/worktrees/<name>`. The file
 * `commondir` of that directory names the `.git` directory of the main repository, and the file `gitdir` of it must
 * name the `.git` file of [directory] again. So a copied or forged `.git` file does not make a worktree. A submodule
 * has another path and is no worktree, and the `.git` of a bare repository or of a separate git directory gives no main
 * directory. The check spawns no git, follows no link of the `.git` entry itself, and uses real paths.
 */
export function mainRepositoryOf(directory) {
  try {
    const entry = join(directory, '.git')
    if (!lstatSync(entry).isFile()) return undefined
    const line = firstLine(entry)
    if (!line?.startsWith('gitdir:')) return undefined
    const gitdir = realpathSync.native(resolve(directory, line.slice('gitdir:'.length).trim()))
    if (basename(dirname(gitdir)) !== 'worktrees') return undefined
    const common = firstLine(join(gitdir, 'commondir'))
    const back = firstLine(join(gitdir, 'gitdir'))
    if (!common || !back) return undefined
    const commonDirectory = realpathSync.native(resolve(gitdir, common))
    if (basename(commonDirectory) !== '.git' || !lstatSync(commonDirectory).isDirectory()) return undefined
    if (realpathSync.native(back) !== join(realpathSync.native(directory), '.git')) return undefined
    const main = dirname(commonDirectory)
    return main === realpathSync.native(directory) ? undefined : main
  }
  catch { return undefined }
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
 * Finds the git repositories in `~/src`, in `~/IdeaProjects` and in each root of `MEGACHAT_PROJECT_ROOTS`, or only in
 * the [folder] that the user named: a directory of a root, or a directory in a directory of a root, that holds a `.git`
 * entry. The scan does not go into a repository and follows no symbolic link. It reads no file but the small `.git`
 * file of a linked worktree (see `mainRepositoryOf`). It gives at most [limit] repositories that are not in [listed],
 * the newest change of `.git` first, and `truncated` when more exist. A named folder must be a real path that
 * `resolveRepository` gives, and the result tells whether the folder itself is a repository and whether it is listed.
 *
 * A linked worktree is no repository of its own. It goes to `worktrees` with its main repository as `worktreeOf`, and the
 * main repository gets it in its own `worktrees`. A main repository that the scan did not find is offered too, when it
 * is not listed and [allowed] accepts it, so the user adds the main repository and not its worktrees.
 */
export async function discoverRepositories({ home = homedir(), roots = projectRoots(), listed = [], limit = DISCOVERY_LIMIT, folder,
  allowed = async () => true } = {}) {
  const skipped = new Set(listed)
  const scanned = new Set()
  const found = []
  const worktrees = []
  const starts = folder === undefined ? [...DISCOVERY_DIRECTORIES.map(name => join(home, name)), ...roots] : [folder]
  const folderMain = folder === undefined ? undefined : mainRepositoryOf(folder)
  const repository = folder !== undefined && await gitTime(folder) !== undefined
  for (const start of repository ? [] : starts) {
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
        const main = mainRepositoryOf(cwd)
        if (main) worktrees.push({ cwd, worktreeOf: main, changed })
        else found.push({ cwd, changed, worktrees: [] })
      }
    }
  }
  for (const worktree of worktrees) {
    let entry = found.find(item => item.cwd === worktree.worktreeOf)
    if (!entry && !skipped.has(worktree.worktreeOf) && await allowed(worktree.worktreeOf)) {
      skipped.add(worktree.worktreeOf)
      entry = { cwd: worktree.worktreeOf, changed: await gitTime(worktree.worktreeOf) ?? worktree.changed, worktrees: [] }
      found.push(entry)
    }
    entry?.worktrees.push(worktree.cwd)
  }
  found.sort((left, right) => right.changed - left.changed)
  worktrees.sort((left, right) => right.changed - left.changed)
  return { ...(folder === undefined ? {} : { folder: { cwd: folder, repository, listed: listed.includes(folder),
      ...(folderMain ? { worktreeOf: folderMain } : {}) } }),
    repositories: found.slice(0, limit).map(({ cwd, changed, worktrees }) => ({ cwd, changedAt: new Date(changed).toISOString(),
      ...(worktrees.length ? { worktrees } : {}) })),
    ...(worktrees.length ? { worktrees: worktrees.map(({ cwd, worktreeOf }) => ({ cwd, worktreeOf })) } : {}),
    truncated: found.length > limit, roots: [...scanned] }
}

/**
 * The directories where a child can work, each one time, with its origin: `megachat` for the workspace of Megachat,
 * `ide` for a project that an IDE registered, and `known` for a repository of the known list. A linked worktree has
 * `worktreeOf`, the real path of its main repository, and it follows its main repository in the list. A main repository
 * in the list has `worktrees`, the listed paths of its worktrees. So the reader sees one project with its worktrees.
 * Each worktree stays a listed directory, because a child can work in it.
 */
export function directoriesOf(state) {
  const directories = new Map()
  const add = (cwd, origin, name) => { if (!directories.has(cwd)) directories.set(cwd, { cwd, origin, ...(name ? { name } : {}) }) }
  if (state.megachatWorkspace) add(state.megachatWorkspace, 'megachat', message('workspace.name'))
  for (const cwd of state.workspaces ?? []) add(cwd, 'ide')
  for (const cwd of state.projects ?? []) add(cwd, 'known')
  const items = [...directories.values()]
  const byKey = new Map(items.map(item => [directoryKey(item.cwd), item]))
  const children = new Map()
  for (const item of items) {
    const main = item.origin === 'megachat' ? undefined : mainRepositoryOf(item.cwd)
    if (!main) continue
    item.worktreeOf = main
    const parent = byKey.get(main)
    if (parent && parent !== item) children.set(parent, [...(children.get(parent) ?? []), item])
  }
  for (const [parent, worktrees] of children) parent.worktrees = worktrees.map(item => item.cwd)
  const glued = new Set([...children.values()].flat())
  return items.filter(item => !glued.has(item)).flatMap(item => [item, ...(children.get(item) ?? [])])
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

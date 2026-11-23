import { createHash } from 'node:crypto'
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { delimiter, isAbsolute, join, posix, resolve, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CURRENT_SQLITE_SCHEMA_VERSION } from '@earendil-works/pi-durable/storage/sqlite'
import { MegachatError, message, requireCondition } from './messages.mjs'
import { resolveRepository } from './ProjectDirectories.mjs'

export const HOME_VARIABLE = 'MEGACHAT_HOME'
/**
 * The variable that selects a project scope: the absolute path of the project directory. The IDE sets it when it starts
 * the Megachat of one project. Without it, Megachat has the machine scope (see the capability `project-scope`).
 */
export const PROJECT_VARIABLE = 'MEGACHAT_PROJECT'
/** The directory of the state directories of the project scopes, in the state directory of the machine scope. */
export const PROJECTS_DIRECTORY = 'projects'
/** The file of a state directory of a project scope that names its project directory. */
export const PROJECT_RECORD = 'project.json'
export const LEGACY_VARIABLE = 'MEGACHAT_LEGACY_DIRS'
export const MIGRATION_MARKER = 'MIGRATED_TO'
const USER_INSTRUCTIONS_LIMIT = 64 * 1024

/** The per-user state directory that every JetBrains product shares. */
export function defaultStateDirectory({ platform = process.platform, env = process.env, homedir = osHomedir } = {}) {
  if (env[HOME_VARIABLE]) return platform === 'win32' ? win32.resolve(env[HOME_VARIABLE]) : posix.resolve(env[HOME_VARIABLE])
  if (platform === 'win32') return win32.join(env.USERPROFILE || homedir(), '.jetbrains', 'air', 'megachat')
  return posix.join(homedir(), '.jetbrains', 'air', 'megachat')
}

/**
 * Gives the project directory that [value], the value of `MEGACHAT_PROJECT`, names: the real path of an existing
 * directory. The value must be an absolute path, and the directory must be one that can be a known repository (see
 * `resolveRepository`). So the root, the home directory, a hidden directory directly in it and the state directory of
 * Megachat are no project. A refused value gives the error `project`, which names the value.
 */
export async function resolveProject(value, options = {}) {
  try {
    requireCondition(typeof value === 'string' && isAbsolute(value), 'directory')
    return await resolveRepository(value, options)
  }
  catch (error) {
    if (!(error instanceof MegachatError)) throw error
    throw new MegachatError('project', String(value).slice(0, 4096))
  }
}

/**
 * The state directory of the project scope of [projectDirectory], a real path, in [machineDirectory], the state
 * directory of the machine scope. The name holds the last segment of the path for a reader, and a digest of the path, so
 * two projects with one name get two directories.
 */
export function projectStateDirectory(machineDirectory, projectDirectory, platform = process.platform) {
  const path = platform === 'win32' ? win32 : posix
  const name = path.basename(projectDirectory).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 40) || 'project'
  const digest = createHash('sha256').update(projectDirectory).digest('hex').slice(0, 12)
  return path.join(machineDirectory, PROJECTS_DIRECTORY, `${name}-${digest}`)
}

/** Reads the project directory that `project.json` of the state directory [directory] names, or `undefined` without the file. */
export async function readProjectRecord(directory) {
  let text
  try { text = await readFile(join(directory, PROJECT_RECORD), 'utf8') }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw error }
  let record
  try { record = JSON.parse(text) }
  catch { /* A file that is no JSON names no project. */ }
  requireCondition(record?.schema === 1 && typeof record.directory === 'string' && isAbsolute(record.directory), 'projectRecord', directory)
  return record.directory
}

/**
 * Writes `project.json` of the state directory [directory] of the project scope of [project], when the file does not
 * exist yet. The file makes the state directory describe itself: a command with only the directory finds the scope.
 */
export async function writeProjectRecord(directory, project) {
  const path = join(directory, PROJECT_RECORD)
  if (existsSync(path)) return
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify({ schema: 1, directory: project })}\n`, { mode: 0o600 })
  if (process.platform !== 'win32') await chmod(temporary, 0o600)
  await rename(temporary, path)
}

/**
 * The state tree of [machineDirectory]: the state directory of the machine scope, and each state directory of a project
 * scope in its directory `projects`. `uninstall` and the update act on each daemon of the tree.
 */
export async function stateDirectories(machineDirectory) {
  const root = join(machineDirectory, PROJECTS_DIRECTORY)
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  return [machineDirectory, ...entries.filter(entry => entry.isDirectory()).map(entry => join(root, entry.name)).sort()]
}

/** Earlier state locations, newest first. The variable replaces the list in tests. */
export function legacyStateDirectories({ platform = process.platform, env = process.env, homedir = osHomedir } = {}) {
  if (env[LEGACY_VARIABLE] !== undefined) return env[LEGACY_VARIABLE].split(delimiter).filter(Boolean).map(path => resolve(path))
  return platform === 'darwin' ? [join(homedir(), 'Library/Application Support/JetBrains/AirMegachat')] : []
}

export async function ensurePrivateDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(directory, 0o700)
}

/**
 * The longest wait of a read of the state for the lock of a writer, as the storage of Pi Durable waits. A daemon holds
 * this lock for a moment while it makes or migrates `conversation.sqlite`, and a concurrent start reads the file then.
 */
const STATE_BUSY_TIMEOUT_MS = 5000

/** Refuses state from a newer pi-durable schema before this build can migrate or write it. */
export function assertSupportedState(path) {
  if (!existsSync(path)) return
  const database = new DatabaseSync(path, { readOnly: true, timeout: STATE_BUSY_TIMEOUT_MS })
  try {
    const table = database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'durable_schema'").get()
    const version = table ? database.prepare('SELECT version FROM durable_schema WHERE singleton = 1').get()?.version ?? 0 : 0
    if (version > CURRENT_SQLITE_SCHEMA_VERSION) throw new MegachatError('newerState')
  }
  finally { database.close() }
}

/** Holds a legacy owner lock so an old daemon cannot start during the copy. */
function lockLegacy(directory) {
  const path = join(directory, 'owner.sqlite')
  if (!existsSync(path)) return undefined
  const database = new DatabaseSync(path)
  try { database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;') }
  catch { database.close(); throw new MegachatError('legacyLocked') }
  return database
}

/**
 * Copies the newest unmigrated legacy conversation into an empty target. The caller must own the target.
 * VACUUM INTO reads committed WAL content. The search index is rebuilt from the copy.
 *
 * A daemon that starts on an empty target without the legacy directory in [sources] makes a new, empty conversation.
 * After that, this function never copies, because the target has a conversation. So the first start after a move of
 * the state names the legacy directory in `MEGACHAT_LEGACY_DIRS`.
 */
export async function migrateLegacyState(target, sources, log = () => {}) {
  const destination = join(target, 'conversation.sqlite')
  if (existsSync(destination)) return undefined
  for (const source of sources) {
    if (resolve(source) === resolve(target)) continue
    const original = join(source, 'conversation.sqlite')
    if (!existsSync(original) || existsSync(join(source, MIGRATION_MARKER))) continue
    const lock = lockLegacy(source)
    try {
      assertSupportedState(original)
      const temporary = join(target, 'conversation.migrating.sqlite')
      await rm(temporary, { force: true })
      const reader = new DatabaseSync(original, { readOnly: true })
      try { reader.prepare('VACUUM INTO ?').run(temporary) }
      finally { reader.close() }
      const copy = new DatabaseSync(temporary)
      let integrity
      try { integrity = copy.prepare('PRAGMA integrity_check').all().map(row => Object.values(row)[0]) }
      finally { copy.close() }
      if (integrity.length !== 1 || integrity[0] !== 'ok') {
        await rm(temporary, { force: true })
        throw new MegachatError('migration')
      }
      if (process.platform !== 'win32') await chmod(temporary, 0o600)
      for (const stale of ['search.sqlite', 'search.sqlite-wal', 'search.sqlite-shm']) await rm(join(target, stale), { force: true })
      await rename(temporary, destination)
      await writeFile(join(source, MIGRATION_MARKER), `${target}\n`, { mode: 0o600 })
      log(message('state.migrated', source, target))
      return source
    }
    finally { lock?.close() }
  }
  return undefined
}

/** Reads the optional rules of the user. A missing, empty or too large file gives `undefined`. */
export async function readUserInstructions(userPath) {
  if (!userPath) return undefined
  try {
    if ((await stat(userPath)).size > USER_INSTRUCTIONS_LIMIT) return undefined
    return (await readFile(userPath, 'utf8')).trim() || undefined
  }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error }
}

/** Appends the rules of the user after the bundled rules. The bundled rules keep priority. */
export function withUserInstructions(bundled, text) {
  if (!text) return bundled
  return `${bundled.trimEnd()}\n\n## User preferences\n\n${message('instructions.user')}\n\n<user-preferences>\n${text}\n</user-preferences>\n`
}

export async function composeInstructions(bundled, userPath) {
  return withUserInstructions(bundled, await readUserInstructions(userPath))
}

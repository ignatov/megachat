import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir as osHomedir } from 'node:os'
import { delimiter, join, posix, resolve, win32 } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CURRENT_SQLITE_SCHEMA_VERSION } from '@earendil-works/pi-durable/storage/sqlite'
import { MegachatError, message } from './messages.mjs'

export const HOME_VARIABLE = 'MEGACHAT_HOME'
export const LEGACY_VARIABLE = 'MEGACHAT_LEGACY_DIRS'
export const MIGRATION_MARKER = 'MIGRATED_TO'
const USER_INSTRUCTIONS_LIMIT = 64 * 1024

/** The per-user state directory that every JetBrains product shares. */
export function defaultStateDirectory({ platform = process.platform, env = process.env, homedir = osHomedir } = {}) {
  if (env[HOME_VARIABLE]) return platform === 'win32' ? win32.resolve(env[HOME_VARIABLE]) : posix.resolve(env[HOME_VARIABLE])
  if (platform === 'win32') return win32.join(env.USERPROFILE || homedir(), '.jetbrains', 'air', 'megachat')
  return posix.join(homedir(), '.jetbrains', 'air', 'megachat')
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

/** Refuses state from a newer pi-durable schema before this build can migrate or write it. */
export function assertSupportedState(path) {
  if (!existsSync(path)) return
  const database = new DatabaseSync(path, { readOnly: true })
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

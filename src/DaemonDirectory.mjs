import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { MegachatError } from './messages.mjs'

/** Holds an operating-system lock for the full storage lifetime. Process death releases the lock. */
export class DaemonDirectory {
  static async acquire(directory) {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const database = new DatabaseSync(join(directory, 'owner.sqlite'))
    try { database.exec('PRAGMA busy_timeout=0; CREATE TABLE IF NOT EXISTS owner (id INTEGER); BEGIN EXCLUSIVE;') }
    catch { database.close(); throw new MegachatError('lock') }
    try {
      await mkdir(join(directory, 'daemon'), { recursive: true, mode: 0o700 })
      await rm(join(directory, 'daemon', 'connection.json'), { force: true })
    }
    catch (error) { database.close(); throw error }
    return new DaemonDirectory(directory, database)
  }

  constructor(directory, database) {
    this.directory = directory
    this.database = database
  }

  async publish(descriptor) {
    const temporary = join(this.directory, 'daemon', 'connection.tmp')
    await writeFile(temporary, JSON.stringify(descriptor), { mode: 0o600 })
    await rename(temporary, join(this.directory, 'daemon', 'connection.json'))
  }

  async close() {
    try { await rm(join(this.directory, 'daemon', 'connection.json'), { force: true }) }
    finally { this.database.close() }
  }
}

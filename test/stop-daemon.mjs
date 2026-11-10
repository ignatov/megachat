import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as delay } from 'node:timers/promises'
import { DaemonClient } from '../src/DaemonClient.mjs'

/** Whether a live daemon holds the owner lock of [directory]. The probe takes the lock for a moment only. */
function ownerLocked(directory) {
  const path = join(directory, 'owner.sqlite')
  if (!existsSync(path)) return false
  const database = new DatabaseSync(path)
  try {
    database.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE; ROLLBACK;')
    return false
  }
  catch { return true }
  finally { database.close() }
}

/** The connection file of the daemon of [directory]. While a daemon holds the lock and did not publish, this waits. */
async function published(directory, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try { return JSON.parse(await readFile(join(directory, 'daemon', 'connection.json'), 'utf8')) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!ownerLocked(directory) || Date.now() >= deadline) return undefined
    await delay(50)
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

async function exited(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (alive(pid)) {
    if (Date.now() >= deadline) return false
    await delay(20)
  }
  return true
}

/**
 * Stops the daemon of [directory] and waits for the exit of its process. The process id comes from the connection
 * file before the shutdown request. When the process stays, this kills it and fails.
 *
 * Call it from a `t.after` hook before the removal of [directory]. On a timeout, `node:test` runs the hooks before the
 * `finally` blocks of the test. A stop in such a block then finds no connection file, and the daemon stays.
 *
 * This cannot find a daemon that did not take the lock yet. That occurs only when `start` stops its wait after 10
 * seconds, before its daemon took the lock.
 */
export async function stopDaemon(directory, { startMs = 15000, exitMs = 10000 } = {}) {
  const descriptor = await published(directory, startMs)
  if (descriptor === undefined) return
  const { pid } = descriptor
  // A process id of 0 or less signals a process group, which can hold the test runner.
  if (!Number.isInteger(pid) || pid <= 0) throw new Error(`The connection file has no process id: ${pid}`)
  try { await new DaemonClient(descriptor).json('/shutdown', {}) }
  catch { /* The daemon can close the connection while it stops. */ }
  if (await exited(pid, exitMs)) return
  process.kill(pid, 'SIGKILL')
  await exited(pid, 5000)
  throw new Error(`The daemon ${pid} did not exit after the shutdown request. The test killed it.`)
}

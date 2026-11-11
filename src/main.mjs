#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { ndJsonStream } from '@agentclientprotocol/sdk/unstable'
import { openNodeSqliteStorage } from '@earendil-works/pi-durable/storage/sqlite/node'
import { AcpBridge } from './AcpBridge.mjs'
import { CentralConfigurationService } from './CentralConfigurationService.mjs'
import { AcpRunService } from './AcpRunService.mjs'
import { DaemonClient } from './DaemonClient.mjs'
import { DaemonDirectory } from './DaemonDirectory.mjs'
import { DaemonServer } from './DaemonServer.mjs'
import { daemonBuild, needsReplacement } from './MegachatBuild.mjs'
import { assertSupportedState, defaultStateDirectory, ensurePrivateDirectory, legacyStateDirectories, migrateLegacyState } from './MegachatHome.mjs'
import { install } from './MegachatInstall.mjs'
import { PiMegachatService } from './PiMegachatService.mjs'
import { ProjectWatchService } from './ProjectWatchService.mjs'
import { MegachatError, message, requireCondition } from './messages.mjs'

process.umask(0o077)
const command = process.argv[2]
// An explicit directory selects isolated state for tests and development. Only the shared home migrates legacy state.
const explicit = process.argv[3] !== undefined
const directory = explicit ? resolve(process.argv[3]) : defaultStateDirectory()
const build = daemonBuild()
const log = text => process.stderr.write(`${new Date().toISOString()} ${text}\n`)

async function daemon() {
  await ensurePrivateDirectory(directory)
  const owner = await DaemonDirectory.acquire(directory)
  let service
  let children
  let server
  let projects
  let stopping
  const shutdown = () => stopping ??= (async () => {
    try { await server?.close() }
    finally {
      try { await projects?.close(); await children?.close() }
      finally {
        try { await service?.close() }
        finally { await owner.close() }
      }
    }
  })()
  process.once('SIGTERM', () => shutdown().catch(() => { process.exitCode = 1 }))
  process.once('SIGINT', () => shutdown().catch(() => { process.exitCode = 1 }))
  try {
    if (!explicit) await migrateLegacyState(directory, legacyStateDirectories(), log)
    assertSupportedState(join(directory, 'conversation.sqlite'))
    const configuration = new CentralConfigurationService()
    service = await PiMegachatService.open(await openNodeSqliteStorage(join(directory, 'conversation.sqlite')), configuration.models(),
      undefined, undefined, { searchPath: join(directory, 'search.sqlite'), userInstructionsPath: join(directory, 'instructions.md') })
    await service.search.catchUp()
    server = new DaemonServer(service, () => shutdown().catch(() => { process.exitCode = 1 }), { build })
    const descriptor = await server.listen()
    children = new AcpRunService(service.state, configuration, { historyServer: server.historyConfiguration() })
    await children.start()
    await service.resume()
    projects = new ProjectWatchService(service.state)
    await projects.start()
    await owner.publish(descriptor)
  }
  catch (error) { await shutdown(); throw error }
}

async function connect(target = directory) {
  const client = await DaemonClient.connect(target)
  client.health = await client.json('/health')
  return client
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

/** Stops a daemon of another build and waits until its process exits, so that this build can take the lock. */
async function stopOtherBuild(client) {
  if (!needsReplacement(client.health.build, build)) return false
  log(message('daemon.replacing', client.health.build ?? '?', build))
  try { await client.json('/shutdown', {}) }
  catch { /* The daemon may close the connection while it stops. */ }
  for (let attempt = 0; attempt < 300; attempt++) {
    if (!alive(client.health.pid)) return true
    await delay(100)
  }
  throw new MegachatError('unavailable')
}

/** Before migration, an older daemon may still own the legacy state. Use it until it stops. */
async function connectLegacy() {
  if (explicit || existsSync(join(directory, 'conversation.sqlite'))) return undefined
  for (const legacy of legacyStateDirectories()) {
    if (existsSync(join(legacy, 'MIGRATED_TO'))) continue
    try {
      const client = await connect(legacy)
      log(message('state.legacy', legacy))
      return client
    }
    catch { /* No live daemon owns this directory. */ }
  }
  return undefined
}

/**
 * Connects to the daemon of the state directory, and starts a daemon when none runs. The daemon gets the environment of
 * this process, and `central run pi` gets all of it. So start the shared daemon from the environment of the IDE, not
 * from an agent shell that has its own Claude or Anthropic variables.
 */
async function start() {
  let running
  try { running = await connect() }
  catch { /* The lock arbitrates concurrent starts. */ }
  if (running && !await stopOtherBuild(running)) return running
  const legacy = await connectLegacy()
  if (legacy) return legacy
  assertSupportedState(join(directory, 'conversation.sqlite'))
  await ensurePrivateDirectory(join(directory, 'daemon'))
  const output = await open(join(directory, 'daemon', 'daemon.log'), 'a', 0o600)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon', ...(explicit ? [directory] : [])], {
    detached: true, stdio: ['ignore', output.fd, output.fd], env: { ...process.env, ...(explicit ? {} : { MEGACHAT_HOME: directory }) },
  })
  await output.close()
  let failed = false
  child.once('error', () => { failed = true })
  child.unref()
  for (let attempt = 0; attempt < 100 && !failed; attempt++) {
    let client
    try { client = await connect() }
    catch { await delay(100); continue }
    // When a concurrent start won, its daemon holds the lock. The daemon of this start then waits only for the lock.
    // It takes over the directory when the other daemon stops, also after a removal of the directory. So stop it now.
    if (client.health.pid !== child.pid) child.kill()
    return client
  }
  throw new MegachatError('unavailable')
}

try {
  switch (command) {
    case 'daemon': await daemon(); break
    case 'start': await start(); process.stdout.write(`${message('daemon.started')}\n`); break
    case 'status': {
      const state = await (await connect()).json('/state')
      process.stdout.write(`${JSON.stringify({ running: true, current: state.current, children: Object.values(state.runs).map(run => ({ id: run.id, status: run.status })) })}\n`)
      break
    }
    case 'stop': await (await connect()).json('/shutdown', {}); break
    case 'install': process.exitCode = await install(); break
    case 'acp': {
      const bridge = new AcpBridge(await start())
      const connection = bridge.app().connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
      try { await connection.closed }
      finally { bridge.close() }
      break
    }
    default: requireCondition(false)
  }
}
catch (error) {
  process.stderr.write(`${error instanceof MegachatError ? error.message : message('error.unavailable')}\n`)
  process.exitCode = 1
}

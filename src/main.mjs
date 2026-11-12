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
import { checkAccounts } from './AgentAccountCheck.mjs'
import { CentralConfigurationService } from './CentralConfigurationService.mjs'
import { AcpRunService } from './AcpRunService.mjs'
import { ChildTranscripts } from './ChildTranscript.mjs'
import { ChildPool } from './ChildPool.mjs'
import { DaemonClient } from './DaemonClient.mjs'
import { DaemonDirectory } from './DaemonDirectory.mjs'
import { DaemonServer } from './DaemonServer.mjs'
import { restrictFileMask } from './fileMask.mjs'
import { daemonBuild, needsReplacement } from './MegachatBuild.mjs'
import { assertSupportedState, defaultStateDirectory, ensurePrivateDirectory, legacyStateDirectories, migrateLegacyState } from './MegachatHome.mjs'
import { install } from './MegachatInstall.mjs'
import { PiMegachatService } from './PiMegachatService.mjs'
import { PiRunService } from './PiRunService.mjs'
import { logFailure, MegachatError, message, requireCondition } from './messages.mjs'
import { withoutNpm } from './npmEnvironment.mjs'

// The files of Megachat are private to the user. A child agent gets the first mask of the user, see `fileMask.mjs`.
restrictFileMask()
// The entry of `acp.json` starts Megachat with npx. The daemon and each other process that Megachat starts must get the
// environment of the IDE, without the variables and the PATH entries of npm. The modules keep a reference to
// `process.env`, so this changes the object in place.
const environment = withoutNpm(process.env)
if (environment !== process.env) {
  for (const name of Object.keys(process.env)) delete process.env[name]
  Object.assign(process.env, environment)
}
const command = process.argv[2]
// An explicit directory selects isolated state for tests and development. Only the shared home migrates legacy state.
const explicit = process.argv[3] !== undefined
const directory = explicit ? resolve(process.argv[3]) : defaultStateDirectory()
const build = daemonBuild()
const log = text => process.stderr.write(`${new Date().toISOString()} ${text}\n`)
/** The exit code of a daemon that found another daemon on its directory. `start` reads it. */
const LOCK_EXIT_CODE = 3
/** The longest wait of `start` for a daemon. The first start after a move of the state copies the conversation. */
const START_TIMEOUT_MS = 120000

async function daemon() {
  await ensurePrivateDirectory(directory)
  const owner = await DaemonDirectory.acquire(directory)
  let service
  let children
  let piChildren
  let transcripts
  let server
  let stopping
  let starting
  // A stop in the start waits for the end of the start, so it closes each part that the start opened. The start ends at
  // its next step, and it cannot publish the connection file after the stop released the lock.
  const shutdown = () => stopping ??= (async () => {
    await starting?.catch(() => {})
    try { await server?.close() }
    finally {
      try { await children?.close(); await piChildren?.close(); await transcripts?.close() }
      finally {
        try { await service?.close() }
        finally { await owner.close() }
      }
    }
  })()
  process.once('SIGTERM', () => shutdown().catch(() => { process.exitCode = 1 }))
  process.once('SIGINT', () => shutdown().catch(() => { process.exitCode = 1 }))
  const proceed = () => requireCondition(stopping === undefined, 'unavailable')
  starting = (async () => {
    if (!explicit) await migrateLegacyState(directory, legacyStateDirectories(), log)
    proceed()
    assertSupportedState(join(directory, 'conversation.sqlite'))
    const configuration = new CentralConfigurationService()
    service = await PiMegachatService.open(await openNodeSqliteStorage(join(directory, 'conversation.sqlite')), configuration.models(),
      undefined, undefined, { searchPath: join(directory, 'search.sqlite'), sessionsPath: join(directory, 'sessions.sqlite'),
        secrets: configuration.secrets, userInstructionsPath: join(directory, 'instructions.md'),
        settingsPath: join(directory, 'settings.json'), workspacePath: join(directory, 'workspace'), stateDirectory: directory,
        spendPath: join(directory, 'spend.json'),
        accountCheck: () => checkAccounts(configuration, { cwd: join(directory, 'workspace') }) })
    proceed()
    await service.search.catchUp()
    proceed()
    // After a storage error each request fails, but the process and its lock stay. So the daemon stops, and the next
    // start opens the state again. The timer ends a stop that does not return.
    service.failed.then(error => {
      logFailure('log.storage', error)
      process.exitCode = 1
      setTimeout(() => process.exit(1), 10000).unref()
      return shutdown()
    }).catch(() => {})
    server = new DaemonServer(service, () => shutdown().catch(() => { process.exitCode = 1 }), { build })
    const descriptor = await server.listen()
    proceed()
    // The daemon runs at most `children.parallel` children at a time, ACP and pi together, and one child in a checkout.
    // A pi run that was dispatched before a restart takes its place first, because Pi Durable continues it.
    const pool = new ChildPool({ limit: () => service.settings.entry('children.parallel').value })
    // The transcripts of the child runs, which Air opens from the rows of the chat. The filter removes the exact key
    // and base URL of each Central configuration that the daemon read.
    transcripts = new ChildTranscripts(join(directory, 'transcripts'), { secrets: configuration.secrets })
    await transcripts.start(service.state)
    proceed()
    piChildren = new PiRunService(service.state, service.harness, { agent: cwd => service.childAgent(cwd), pool, transcripts })
    await piChildren.start()
    proceed()
    children = new AcpRunService(service.state, configuration, { historyServer: server.historyConfiguration(),
      childRules: cwd => service.childRules(cwd), settings: cwd => service.settings.values(cwd), pool, transcripts })
    await children.start()
    proceed()
    await service.resume()
    proceed()
    await owner.publish(descriptor)
  })()
  try { await starting }
  catch (error) {
    // After SIGTERM, SIGINT or a storage error in the start, the start ends on purpose. The daemon then only stops.
    const stopped = stopping !== undefined
    await shutdown()
    if (!stopped) throw error
  }
}

async function connect(target = directory, signal) {
  const client = await DaemonClient.connect(target)
  client.health = await client.json('/health', undefined, signal)
  return client
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

/** Stops a daemon of another build and waits until its process exits, so that this build can take the lock. */
async function stopOtherBuild(client) {
  if (!needsReplacement(client.health.build, build)) return false
  // A build that cannot open the state must not stop the daemon that can. The check only reads the state.
  assertSupportedState(join(directory, 'conversation.sqlite'))
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
 * this process without the environment of npm, and `central run pi` gets all of it. So start the shared daemon from the
 * environment of the IDE, not from an agent shell that has its own Claude or Anthropic variables.
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
  const deadline = Date.now() + START_TIMEOUT_MS
  // The daemon of this start can find another daemon on the directory, and that daemon can be at its end. Then a new
  // daemon is necessary. The count and the longer delays keep one start from many daemon processes.
  for (let spawns = 1, retryMs = 500; ; spawns++, retryMs *= 2) {
    const child = await spawnDaemon()
    const client = await waitForDaemon(child, () => child.ended !== undefined || Date.now() >= deadline)
    if (client) return client
    if (child.ended !== LOCK_EXIT_CODE || Date.now() >= deadline) break
    const retryAt = spawns < 5 ? Math.min(deadline, Date.now() + retryMs) : deadline
    const owner = await waitForDaemon(child, () => Date.now() >= retryAt)
    if (owner) return owner
    if (Date.now() >= deadline) break
  }
  throw new MegachatError('unavailable')
}

/** Starts a daemon process in the background. `ended` gets its exit code when it ends. */
async function spawnDaemon() {
  const output = await open(join(directory, 'daemon', 'daemon.log'), 'a', 0o600)
  // The log can hold the filtered error output of a failed child run. The mode of the open applies only to a new file.
  if (process.platform !== 'win32') await output.chmod(0o600)
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'daemon', ...(explicit ? [directory] : [])], {
    detached: true, stdio: ['ignore', output.fd, output.fd], env: { ...process.env, ...(explicit ? {} : { MEGACHAT_HOME: directory }) },
  })
  await output.close()
  child.once('error', () => { child.ended ??= 1 })
  child.once('exit', code => { child.ended ??= code ?? 1 })
  child.unref()
  return child
}

/**
 * Connects to the daemon of the directory, and tries again until [done] says to stop. The wait has no count of
 * attempts: a daemon that copies or indexes a large conversation needs more than a few seconds for its start.
 */
async function waitForDaemon(child, done) {
  for (;;) {
    let client
    // A daemon that does not answer must not hold one attempt for the usual 15 seconds.
    try { client = await connect(directory, AbortSignal.timeout(2000)) }
    catch { /* No daemon answers yet. */ }
    if (client) {
      // When a concurrent start won, its daemon holds the lock. A daemon of this start that did not look at the lock
      // yet ends on the lock, also after a removal of the directory. So stop it now.
      if (client.health.pid !== child.pid) child.kill()
      return client
    }
    if (done()) return undefined
    await delay(100)
  }
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
    case 'compact': {
      // The daemon owns the conversation, so it writes the summary. The request has no time limit of its own.
      const outcome = await (await connect()).json('/compact', {}, AbortSignal.timeout(3600000))
      process.stdout.write(`${message(outcome.compacted ? 'compact.done' : outcome.reason === 'nothing' ? 'compact.nothing' : 'compact.failed', outcome.reason)}\n`)
      if (!outcome.compacted && outcome.reason !== 'nothing') process.exitCode = 1
      break
    }
    case 'install': process.exitCode = await install(); break
    case 'acp': {
      const bridge = new AcpBridge(await start(), { transcripts: join(directory, 'transcripts') })
      const connection = bridge.app().connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
      try { await connection.closed }
      finally { bridge.close() }
      break
    }
    default: requireCondition(false)
  }
}
catch (error) {
  // The daemon writes to its log, so the reason of its stop goes there. Each other command writes for the user.
  if (command === 'daemon' && !(error instanceof MegachatError)) logFailure('log.daemon', error)
  process.stderr.write(`${error instanceof MegachatError ? error.message : message('error.unavailable')}\n`)
  process.exitCode = command === 'daemon' && error.code === 'lock' ? LOCK_EXIT_CODE : 1
}

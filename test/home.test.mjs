import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { CURRENT_SQLITE_SCHEMA_VERSION } from '@earendil-works/pi-durable/storage/sqlite'
import { DaemonDirectory } from '../src/DaemonDirectory.mjs'
import { assertSupportedState, composeInstructions, defaultStateDirectory, ensurePrivateDirectory, legacyStateDirectories,
  migrateLegacyState } from '../src/MegachatHome.mjs'
import { stopDaemon } from './stop-daemon.mjs'

const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url))
const temporary = async (t, prefix) => {
  const directory = await mkdtemp(join(tmpdir(), prefix))
  t.after(() => rm(directory, { force: true, recursive: true }))
  return directory
}
const mode = async path => (await stat(path)).mode & 0o777

test('the shared home resolves per platform and the variable overrides it', () => {
  const homedir = () => '/Users/me'
  assert.equal(defaultStateDirectory({ platform: 'darwin', env: {}, homedir }), '/Users/me/.jetbrains/air/megachat')
  assert.equal(defaultStateDirectory({ platform: 'linux', env: {}, homedir: () => '/home/me' }), '/home/me/.jetbrains/air/megachat')
  assert.equal(defaultStateDirectory({ platform: 'win32', env: { USERPROFILE: 'C:\\Users\\me' }, homedir }),
    'C:\\Users\\me\\.jetbrains\\air\\megachat')
  assert.equal(defaultStateDirectory({ platform: 'linux', env: { MEGACHAT_HOME: '/tmp/x' }, homedir }), '/tmp/x')
  assert.deepEqual(legacyStateDirectories({ platform: 'linux', env: { MEGACHAT_LEGACY_DIRS: '' }, homedir }), [])
  assert.deepEqual(legacyStateDirectories({ platform: 'darwin', env: {}, homedir }),
    ['/Users/me/Library/Application Support/JetBrains/AirMegachat'])
  assert.deepEqual(legacyStateDirectories({ platform: 'linux', env: {}, homedir }), [])
})

test('the test guard gives each test process a temporary home and no legacy directories', () => {
  assert.ok(defaultStateDirectory().startsWith(join(tmpdir(), 'megachat-guard-')), defaultStateDirectory())
  assert.deepEqual(legacyStateDirectories(), [])
})

test('state directories are private and the daemon files are owner-only', { skip: process.platform === 'win32' }, async t => {
  const root = await temporary(t, 'megachat-home-')
  const home = join(root, '.jetbrains', 'air', 'megachat')
  await ensurePrivateDirectory(home)
  assert.equal(await mode(home), 0o700)
  const owner = await DaemonDirectory.acquire(home)
  await owner.publish({ version: 1 })
  assert.equal(await mode(join(home, 'daemon')), 0o700)
  assert.equal(await mode(join(home, 'daemon', 'connection.json')), 0o600)
  await owner.close()
})

function legacyDatabase(path) {
  const database = new DatabaseSync(path)
  database.exec(`PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
    CREATE TABLE durable_schema (singleton INTEGER PRIMARY KEY, version INTEGER NOT NULL);
    INSERT INTO durable_schema VALUES (1, ${CURRENT_SQLITE_SCHEMA_VERSION});
    CREATE TABLE entries (id INTEGER PRIMARY KEY, text TEXT)`)
  return database
}

test('migration copies WAL content, verifies it, and marks the old directory', async t => {
  const root = await temporary(t, 'megachat-migrate-')
  const legacy = join(root, 'legacy')
  const home = join(root, 'home')
  await mkdir(legacy)
  await ensurePrivateDirectory(home)
  const writer = legacyDatabase(join(legacy, 'conversation.sqlite'))
  writer.exec("INSERT INTO entries (text) VALUES ('only in the WAL')")
  assert.ok((await stat(join(legacy, 'conversation.sqlite-wal'))).size > 0)
  await writeFile(join(home, 'search.sqlite'), 'stale')
  const owner = await DaemonDirectory.acquire(home)
  t.after(() => owner.close())
  const logs = []
  assert.equal(await migrateLegacyState(home, [join(root, 'missing'), legacy], text => logs.push(text)), legacy)
  writer.close()
  const copy = new DatabaseSync(join(home, 'conversation.sqlite'), { readOnly: true })
  assert.deepEqual(copy.prepare('SELECT text FROM entries').all().map(row => row.text), ['only in the WAL'])
  copy.close()
  if (process.platform !== 'win32') assert.equal(await mode(join(home, 'conversation.sqlite')), 0o600)
  assert.equal(existsSync(join(home, 'search.sqlite')), false)
  assert.equal((await readFile(join(legacy, 'MIGRATED_TO'), 'utf8')).trim(), home)
  assert.ok(existsSync(join(legacy, 'conversation.sqlite')))
  assert.equal(logs.length, 1)
  assert.equal(await migrateLegacyState(home, [legacy]), undefined)
})

test('migration refuses a legacy directory that a live daemon owns', async t => {
  const root = await temporary(t, 'megachat-locked-')
  const legacy = join(root, 'legacy')
  const home = join(root, 'home')
  await ensurePrivateDirectory(home)
  const running = await DaemonDirectory.acquire(legacy)
  legacyDatabase(join(legacy, 'conversation.sqlite')).close()
  await assert.rejects(migrateLegacyState(home, [legacy]), { code: 'legacyLocked' })
  assert.equal(existsSync(join(home, 'conversation.sqlite')), false)
  assert.equal(existsSync(join(legacy, 'MIGRATED_TO')), false)
  await running.close()
  assert.equal(await migrateLegacyState(home, [legacy]), legacy)
})

test('the version guard refuses state from a newer schema', async t => {
  const root = await temporary(t, 'megachat-version-')
  const path = join(root, 'conversation.sqlite')
  assert.doesNotThrow(() => assertSupportedState(path))
  const database = legacyDatabase(path)
  assert.doesNotThrow(() => assertSupportedState(path))
  database.exec(`UPDATE durable_schema SET version = ${CURRENT_SQLITE_SCHEMA_VERSION + 1}`)
  database.close()
  assert.throws(() => assertSupportedState(path), { code: 'newerState', message: /newer Megachat build; update Megachat\./ })
  const home = join(root, 'home')
  await ensurePrivateDirectory(home)
  await assert.rejects(migrateLegacyState(home, [root]), { code: 'newerState' })
  assert.equal(existsSync(join(home, 'conversation.sqlite')), false)
})

test('the version guard waits for the write lock of a daemon that makes the state, and does not fail on it', { timeout: 20000 }, async t => {
  const root = await temporary(t, 'megachat-busy-')
  const path = join(root, 'conversation.sqlite')
  // Another process holds the lock that a daemon holds for a moment while it makes the state, and then ends it.
  const writer = spawn(process.execPath, ['-e', `const { DatabaseSync } = require('node:sqlite')
const database = new DatabaseSync(process.argv[1])
database.exec('BEGIN EXCLUSIVE')
console.log('locked')
setTimeout(() => { database.exec('ROLLBACK'); database.close() }, 2000)`, path], { stdio: ['ignore', 'pipe', 'inherit'] })
  const [line] = await once(writer.stdout, 'data')
  assert.equal(String(line).trim(), 'locked')
  // Without the wait, the read fails at once with "database is locked".
  assert.doesNotThrow(() => assertSupportedState(path))
  await once(writer, 'exit')
})

test('user instructions follow the bundled rules as preferences', async t => {
  const root = await temporary(t, 'megachat-instructions-')
  const path = join(root, 'instructions.md')
  assert.equal(await composeInstructions('Bundled.', path), 'Bundled.')
  await writeFile(path, '  \n')
  assert.equal(await composeInstructions('Bundled.', path), 'Bundled.')
  await writeFile(path, 'Answer in Russian.\n')
  const composed = await composeInstructions('Bundled.', path)
  assert.ok(composed.startsWith('Bundled.\n\n## User preferences'))
  assert.match(composed, /cannot override/)
  assert.ok(composed.endsWith('<user-preferences>\nAnswer in Russian.\n</user-preferences>\n'))
})

function run(args, env) {
  const child = spawn(process.execPath, [main, ...args], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  return once(child, 'exit').then(([code]) => ({ code, output }))
}

test('a second product attaches to the shared daemon and a second daemon fails fast', { timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'megachat-shared-'))
  const home = join(root, 'home')
  // One hook stops the daemon and then removes the directory. It runs also when the test fails or times out.
  t.after(async () => {
    try { await stopDaemon(home) }
    finally { await rm(root, { force: true, recursive: true }) }
  })
  await sharedDaemon(home, { MEGACHAT_HOME: home, MEGACHAT_LEGACY_DIRS: '' })
})

async function sharedDaemon(home, env) {
  const [first, second] = await Promise.all([run(['start'], env), run(['start'], env)])
  assert.equal(first.code, 0, first.output)
  assert.equal(second.code, 0, second.output)
  const descriptor = JSON.parse(await readFile(join(home, 'daemon', 'connection.json'), 'utf8'))
  assert.equal((await run(['start'], env)).code, 0)
  assert.deepEqual(JSON.parse(await readFile(join(home, 'daemon', 'connection.json'), 'utf8')), descriptor)
  const started = Date.now()
  const duplicate = await run(['daemon'], env)
  assert.equal(duplicate.code, 3)
  assert.match(duplicate.output, /Another Megachat daemon owns this directory/)
  assert.ok(Date.now() - started < 5000)
  if (process.platform !== 'win32') assert.equal(await mode(home), 0o700)
}

function alive(pid) {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

test('a start that loses the race stops its own daemon', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'megachat-race-'))
  const home = join(root, 'home')
  const slowPids = join(root, 'slow-daemons')
  let slow
  t.after(async () => {
    try {
      if (slow && alive(slow)) process.kill(slow, 'SIGKILL')
      await stopDaemon(home)
    }
    finally { await rm(root, { force: true, recursive: true }) }
  })
  // The daemon of the first start blocks before it takes the lock. So the daemon of the second start wins.
  const losing = run(['start', home], { MEGACHAT_LEGACY_DIRS: '', MEGACHAT_TEST_SLOW_DAEMON: slowPids,
    NODE_OPTIONS: `--import=${JSON.stringify(new URL('./slow-daemon.mjs', import.meta.url).href)}` })
  for (let attempt = 0; attempt < 500 && !slow; attempt++) {
    slow = Number((await readFile(slowPids, 'utf8').catch(() => '')).trim()) || undefined
    if (!slow) await delay(20)
  }
  assert.ok(slow, 'The first start did not spawn its daemon')
  const winning = await run(['start', home], { MEGACHAT_LEGACY_DIRS: '' })
  assert.equal(winning.code, 0, winning.output)
  const lost = await losing
  assert.equal(lost.code, 0, lost.output)
  // Without the stop, the blocked daemon takes over the directory after the winner stops.
  for (let attempt = 0; attempt < 250 && alive(slow); attempt++) await delay(20)
  assert.equal(alive(slow), false)
})

/** The process ID and the build of the daemon of [home], from its connection file. */
async function published(home) {
  const { pid, build } = JSON.parse(await readFile(join(home, 'daemon', 'connection.json'), 'utf8'))
  return { pid, build }
}

test('a start without agent commands keeps the daemon, and a start with other commands replaces it', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'megachat-replace-'))
  const home = join(root, 'home')
  t.after(async () => {
    try { await stopDaemon(home) }
    finally { await rm(root, { force: true, recursive: true }) }
  })
  const start = async env => {
    const result = await run(['start', home], { MEGACHAT_LEGACY_DIRS: '', MEGACHAT_CLAUDE_ACP: undefined, MEGACHAT_CODEX_ACP: undefined, ...env })
    assert.equal(result.code, 0, result.output)
    return published(home)
  }
  const first = await start({ MEGACHAT_CLAUDE_ACP: '/air/claude-a' })
  // A terminal passes no agent command. It must not stop the daemon that an IDE started.
  assert.deepEqual(await start({}), first)
  assert.deepEqual(await start({ MEGACHAT_CLAUDE_ACP: '/air/claude-a' }), first)
  const second = await start({ MEGACHAT_CLAUDE_ACP: '/air/claude-b' })
  assert.notEqual(second.pid, first.pid)
  assert.notEqual(second.build, first.build)
  assert.equal(alive(first.pid), false)
})

test('a start that cannot open the state does not stop the running daemon', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'megachat-newer-'))
  const home = join(root, 'home')
  t.after(async () => {
    try { await stopDaemon(home) }
    finally { await rm(root, { force: true, recursive: true }) }
  })
  const env = { MEGACHAT_LEGACY_DIRS: '', MEGACHAT_CODEX_ACP: undefined }
  const started = await run(['start', home], { ...env, MEGACHAT_CLAUDE_ACP: '/air/claude-a' })
  assert.equal(started.code, 0, started.output)
  const daemon = await published(home)
  // The state now has the schema of a newer build, as after a start of that build.
  const database = new DatabaseSync(join(home, 'conversation.sqlite'))
  database.prepare('UPDATE durable_schema SET version = ? WHERE singleton = 1').run(CURRENT_SQLITE_SCHEMA_VERSION + 1)
  database.close()
  const refused = await run(['start', home], { ...env, MEGACHAT_CLAUDE_ACP: '/air/claude-b' })
  assert.equal(refused.code, 1)
  assert.match(refused.output, /created by a newer Megachat build/)
  assert.equal(alive(daemon.pid), true)
  assert.deepEqual(await published(home), daemon)
})

const slowDaemon = `--import=${JSON.stringify(new URL('./slow-daemon.mjs', import.meta.url).href)}`

test('a start ends at once when its daemon ends with an error', { skip: process.platform === 'win32', timeout: 30000 }, async t => {
  const root = await temporary(t, 'megachat-failed-start-')
  const home = join(root, 'home')
  const pids = join(root, 'daemons')
  const started = Date.now()
  const result = await run(['start', home], { MEGACHAT_LEGACY_DIRS: '', NODE_OPTIONS: slowDaemon,
    MEGACHAT_TEST_SLOW_DAEMON: pids, MEGACHAT_TEST_SLOW_DAEMON_EXIT: '1' })
  assert.equal(result.code, 1)
  assert.match(result.output, /could not connect to its local daemon/)
  // A wait of a fixed count of attempts took 10 seconds.
  assert.ok(Date.now() - started < 5000, `The start took ${Date.now() - started} ms`)
  assert.equal((await readFile(pids, 'utf8')).trim().split('\n').length, 1)
})

test('a start waits for a daemon that needs more than 10 seconds for its start', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'megachat-slow-start-'))
  const home = join(root, 'home')
  t.after(async () => {
    try { await stopDaemon(home, { startMs: 20000 }) }
    finally { await rm(root, { force: true, recursive: true }) }
  })
  const started = Date.now()
  const result = await run(['start', home], { MEGACHAT_LEGACY_DIRS: '', NODE_OPTIONS: slowDaemon,
    MEGACHAT_TEST_SLOW_DAEMON: join(root, 'daemons'), MEGACHAT_TEST_SLOW_DAEMON_MS: '11000' })
  assert.equal(result.code, 0, result.output)
  assert.ok(Date.now() - started >= 11000)
  assert.equal(alive((await published(home)).pid), true)
})

test('a start during the end of another daemon starts a daemon again, with a limit', { skip: process.platform === 'win32', timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'megachat-ending-'))
  const home = join(root, 'home')
  const pids = join(root, 'daemons')
  t.after(async () => {
    try { await stopDaemon(home) }
    finally { await rm(root, { force: true, recursive: true }) }
  })
  // The test holds the lock without a connection file, as a daemon at its end does.
  const ending = await DaemonDirectory.acquire(home)
  const env = { MEGACHAT_LEGACY_DIRS: '', NODE_OPTIONS: slowDaemon, MEGACHAT_TEST_SLOW_DAEMON: pids, MEGACHAT_TEST_SLOW_DAEMON_MS: '0' }
  const starting = run(['start', home], env)
  const spawned = async () => (await readFile(pids, 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(Number)
  for (let attempt = 0; attempt < 500 && (await spawned()).length < 2; attempt++) await delay(20)
  const lost = await spawned()
  assert.ok(lost.length >= 2, 'The start did not start a daemon again')
  await ending.close()
  const result = await starting
  assert.equal(result.code, 0, result.output)
  const all = await spawned()
  assert.ok(all.length <= 5, `The start made ${all.length} daemon processes`)
  assert.equal((await published(home)).pid, all.at(-1))
  for (const pid of all.slice(0, -1)) assert.equal(alive(pid), false)
})

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { IDE_NPM_VARIABLES, npmPathEntry, startedByNpm, withoutNpm } from '../src/npmEnvironment.mjs'
import { commandOnPath, processEnvironment } from './process-environment.mjs'
import { stopDaemon } from './stop-daemon.mjs'

const execute = promisify(execFile)
const main = fileURLToPath(new URL('../src/main.mjs', import.meta.url))

test('npm_execpath is the sign that npm or npx started the process', () => {
  assert.equal(startedByNpm({ npm_execpath: '/opt/npm/bin/npm-cli.js' }), true)
  assert.equal(startedByNpm({ npm_execpath: '' }), false)
  assert.equal(startedByNpm({ npm_config_cache: '/cache', NPM_CONFIG_CACHE: '/cache' }), false)
  assert.equal(startedByNpm({}), false)
})

test('a node_modules/.bin directory and the node-gyp-bin directory of npm are the PATH entries of npm', () => {
  assert.equal(npmPathEntry('/cache/_npx/0123456789abcdef/node_modules/.bin'), true)
  assert.equal(npmPathEntry('/work/project/node_modules/.bin/'), true)
  assert.equal(npmPathEntry('/node/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin'), true)
  // npm adds only absolute paths. A relative entry comes from the user.
  assert.equal(npmPathEntry('node_modules/.bin'), false)
  assert.equal(npmPathEntry('/usr/local/bin'), false)
  assert.equal(npmPathEntry('/work/.bin'), false)
})

test('without npm, the environment loses the variables and the PATH entries of npm and keeps each other value', () => {
  const environment = {
    HOME: '/Users/me', MEGACHAT_CLAUDE_ACP: '/air/claude-agent-acp', NODE_USE_SYSTEM_CA: '1', NPM_CONFIG_REGISTRY: 'https://npm.example.com/',
    npm_execpath: '/node/lib/node_modules/npm/bin/npm-cli.js', npm_command: 'exec', npm_lifecycle_event: 'npx',
    npm_config_local_prefix: '/work', npm_config_prefix: '/node', npm_node_execpath: '/node/bin/node', NODE: '/node/bin/node',
    NPM_CONFIG_CACHE: '/ide/npm-cache', NPM_CONFIG_MIN_RELEASE_AGE: '0', NPM_CONFIG_GLOBAL: 'false', NPM_CONFIG_DRY_RUN: 'false',
    NPM_CONFIG_INCLUDE: 'optional', NPM_CONFIG_ENGINE_STRICT: 'false', NPM_CONFIG_STRICT_PEER_DEPS: 'false',
    INIT_CWD: '/work', COLOR: '0', EDITOR: 'vi',
    PATH: ['/cache/_npx/0123456789abcdef/node_modules/.bin', '/work/node_modules/.bin', '/node_modules/.bin',
      '/node/lib/node_modules/npm/node_modules/@npmcli/run-script/lib/node-gyp-bin', '/node/bin', 'node_modules/.bin',
      '/Users/me/tools/node_modules/.bin', '/usr/bin'].join(':'),
  }
  // The NPM_CONFIG_REGISTRY of the user and a node_modules/.bin directory of the user after the entries of npm stay.
  assert.deepEqual(withoutNpm(environment, { pathDelimiter: ':', platform: 'darwin' }), {
    HOME: '/Users/me', MEGACHAT_CLAUDE_ACP: '/air/claude-agent-acp', NODE_USE_SYSTEM_CA: '1', NPM_CONFIG_REGISTRY: 'https://npm.example.com/',
    PATH: '/node/bin:node_modules/.bin:/Users/me/tools/node_modules/.bin:/usr/bin',
  })
  // A NODE that npm did not set stays. npm sets EDITOR to VISUAL, so another EDITOR comes from the user. Windows names
  // the variable Path.
  assert.deepEqual(withoutNpm({ npm_execpath: '/npm', npm_node_execpath: '/node', NODE: '/other', VISUAL: 'code', EDITOR: 'nano',
    Path: '/work/node_modules/.bin;C:/bin' }, { pathDelimiter: ';', platform: 'win32' }), { NODE: '/other', VISUAL: 'code', EDITOR: 'nano', Path: 'C:/bin' })
  assert.deepEqual(withoutNpm({ npm_execpath: '/npm', VISUAL: 'code', EDITOR: 'code' }), { VISUAL: 'code' })
  // A process that npm did not start keeps its environment.
  const direct = { ...environment }
  delete direct.npm_execpath
  assert.equal(withoutNpm(direct), direct)
})

/** Starts the daemon of [state] with `start` in [env], and returns the environment that the daemon got. */
async function daemonEnvironment(state, env) {
  await execute(process.execPath, [main, 'start', state], { env })
  const { pid } = JSON.parse(await readFile(join(state, 'daemon', 'connection.json'), 'utf8'))
  return processEnvironment(pid)
}

test('a daemon that npx started gets the environment of the IDE, and a daemon that Node.js started keeps its own',
  { timeout: 60000 }, async t => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-environment-')))
    const fromNpm = join(directory, 'npm-state')
    const direct = join(directory, 'direct-state')
    t.after(async () => {
      try { await stopDaemon(fromNpm) }
      finally {
        try { await stopDaemon(direct) }
        finally { await rm(directory, { recursive: true, force: true }) }
      }
    })
    // The user has codex and claude. The npx copy has the codex of a dependency in its node_modules/.bin.
    const user = join(directory, 'user', 'bin')
    const copy = join(directory, 'npm-cache', '_npx', '0123456789abcdef', 'node_modules', '.bin')
    const gyp = join(directory, 'npm', 'node_modules', '@npmcli', 'run-script', 'lib', 'node-gyp-bin')
    for (const path of [user, copy, gyp, join(directory, 'home')]) await mkdir(path, { recursive: true })
    for (const file of [join(user, 'codex'), join(user, 'claude'), join(copy, 'codex'), join(copy, 'claude-agent-acp')]) {
      await writeFile(file, '#!/bin/sh\n', { mode: 0o755 })
    }
    const ide = { HOME: join(directory, 'home'), TMPDIR: tmpdir(), MEGACHAT_LEGACY_DIRS: '', PATH: [user, '/usr/bin', '/bin'].join(':'),
      NPM_CONFIG_REGISTRY: 'https://npm.example.com/', NODE_USE_SYSTEM_CA: '1' }
    const npx = {
      ...ide, npm_execpath: join(directory, 'npm', 'bin', 'npm-cli.js'), npm_command: 'exec', npm_lifecycle_event: 'npx',
      npm_config_local_prefix: directory, npm_node_execpath: process.execPath, NODE: process.execPath, INIT_CWD: directory, COLOR: '0',
      EDITOR: 'vi', ...Object.fromEntries(IDE_NPM_VARIABLES.map(name => [name, 'false'])), NPM_CONFIG_CACHE: join(directory, 'npm-cache'),
      PATH: [copy, join(directory, 'node_modules', '.bin'), gyp, ide.PATH].join(':'),
    }
    const cleaned = await daemonEnvironment(fromNpm, npx)
    assert.deepEqual(cleaned.names.filter(name => /^npm_/.test(name) || [...IDE_NPM_VARIABLES, 'INIT_CWD', 'NODE', 'COLOR', 'EDITOR'].includes(name)), [])
    for (const name of ['NPM_CONFIG_REGISTRY', 'NODE_USE_SYSTEM_CA']) assert.ok(cleaned.names.includes(name), name)
    assert.equal(cleaned.path, ide.PATH)
    assert.equal(await commandOnPath('codex', cleaned.path), join(user, 'codex'))
    assert.equal(await commandOnPath('claude', cleaned.path), join(user, 'claude'))

    // Without npm_execpath, Node.js started the process. Then each variable and each PATH entry stays.
    const own = { ...npx }
    delete own.npm_execpath
    const kept = await daemonEnvironment(direct, own)
    for (const name of ['npm_command', 'npm_config_local_prefix', 'NPM_CONFIG_CACHE', 'INIT_CWD', 'NODE', 'COLOR']) assert.ok(kept.names.includes(name), name)
    assert.equal(kept.path, own.PATH)
    assert.equal(await commandOnPath('codex', kept.path), join(copy, 'codex'))
  })

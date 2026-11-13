import { constants } from 'node:fs'
import { access, chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { bundledBinaries, CentralConfigurationService } from './CentralConfigurationService.mjs'
import { megachatVersion } from './MegachatBuild.mjs'
import { message } from './messages.mjs'
import { ENTRY_GIT_VARIABLES, npmPathEntry } from './npmEnvironment.mjs'
import { gitCheckout } from './sourceBuildId.mjs'

/** A test sets this variable, so that no test can reach the `acp.json` of the user. */
export const ACP_CONFIG_VARIABLE = 'MEGACHAT_ACP_CONFIG'
/** Air derives the agent ID `acp.megachat` from this name. */
const ENTRY = 'Megachat'
/** The package spec of the last release for npx. `#semver:x` selects the tag `v<version>` with the highest version. */
export const RELEASE_SPEC = 'github:ignatov/megachat#semver:x'
/** The command and the arguments of the npx entry. `install` 0.3.0 and 0.4.0 wrote an entry with only these keys. */
const NPX_START = { command: 'npx', args: ['-y', RELEASE_SPEC, 'acp'] }
/**
 * The entry of a copy that is not a git checkout. The IDE starts `npx` with its own Node.js, and npx starts the last
 * release. So the next start of the agent after a release starts the new release. The `env` holds the time limits of
 * git for a stalled transfer of npx (see [ENTRY_GIT_VARIABLES]).
 */
export const RELEASE_ENTRY = { ...NPX_START, env: { ...ENTRY_GIT_VARIABLES } }

/** The ACP configuration of the JetBrains IDEs: `~/.jetbrains/acp.json`, or the file that the variable names. */
export function acpConfigPath(environment = process.env) {
  return environment[ACP_CONFIG_VARIABLE] ? resolve(environment[ACP_CONFIG_VARIABLE]) : join(homedir(), '.jetbrains', 'acp.json')
}

/**
 * A path of the running Node.js that stays valid after an upgrade: the first `node` on [path] that is the same file as
 * [execPath], else [execPath]. A Homebrew Node.js runs from a versioned Cellar path, and the next upgrade removes it.
 */
export async function stableNodePath({ execPath = process.execPath, path = process.env.PATH ?? '', platform = process.platform } = {}) {
  const target = await realpath(execPath)
  for (const directory of path.split(delimiter).filter(item => isAbsolute(item))) {
    const candidate = join(directory, platform === 'win32' ? 'node.exe' : 'node')
    try { if (await realpath(candidate) === target) return candidate }
    catch { /* This directory has no node. */ }
  }
  return execPath
}

const plainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Whether [entry] is the entry that `install` 0.2.0 wrote: Node.js starts `bin/megachat.mjs acp` of a copy in an
 * `_npx` directory of npm, and the entry has no other key. Only `install` wrote such an entry, and its copy came from
 * the same install line. So `install` replaces it with [RELEASE_ENTRY].
 */
export function earlierEntry(entry) {
  return plainObject(entry) && Object.keys(entry).sort().join() === 'args,command'
    && typeof entry.command === 'string' && /(^|[\\/])node(\.exe)?$/.test(entry.command)
    && Array.isArray(entry.args) && entry.args.length === 2 && entry.args[1] === 'acp' && typeof entry.args[0] === 'string'
    && /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]megachat[\\/]bin[\\/]megachat\.mjs$/.test(entry.args[0])
}

/**
 * Whether [entry] is the entry that `install` 0.3.0 and 0.4.0 wrote: [RELEASE_ENTRY] without the `env`, and with no
 * other key. So `install` replaces it with [RELEASE_ENTRY]. An entry with an `env` of the user stays a different entry.
 */
export function entryWithoutTimeLimits(entry) {
  return isDeepStrictEqual(entry, NPX_START)
}

/**
 * Adds [entry] as `Megachat` to `agent_servers` of the file [path]. The result is `created`, `added`, `replaced`,
 * `same`, `different` or `unreadable`. Only `created`, `added` and `replaced` write a file. A different entry gives
 * `replaced` when [replaceable] accepts it, else `different`. Before `added` and `replaced`, this copies the file to
 * `<path>.before-megachat-<UTC time>`. They keep each other key, the key order and the mode of the file.
 */
export async function writeEntry(path, entry, now = new Date(), replaceable = () => false) {
  let text
  try { text = await readFile(path, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') return { status: 'unreadable' }
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, `${JSON.stringify({ agent_servers: { [ENTRY]: entry } }, null, 2)}\n`, { mode: 0o600, flag: 'wx' })
    return { status: 'created' }
  }
  let configuration
  try { configuration = JSON.parse(text) }
  catch { return { status: 'unreadable' } }
  if (!plainObject(configuration) || (configuration.agent_servers !== undefined && !plainObject(configuration.agent_servers))) {
    return { status: 'unreadable' }
  }
  const existing = configuration.agent_servers?.[ENTRY]
  if (existing !== undefined && isDeepStrictEqual(existing, entry)) return { status: 'same' }
  if (existing !== undefined && !replaceable(existing)) return { status: 'different', existing }
  const backup = `${path}.before-megachat-${now.toISOString().replace(/[-:]|\.\d+/g, '')}`
  await copyFile(path, backup, constants.COPYFILE_EXCL)
  await chmod(backup, (await stat(path)).mode & 0o777)
  // An entry that the file holds keeps its place among the keys.
  configuration.agent_servers = { ...configuration.agent_servers, [ENTRY]: entry }
  await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`)
  return existing === undefined ? { status: 'added', backup } : { status: 'replaced', backup, existing }
}

async function executable(path) {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile() }
  catch { return false }
}

/**
 * The first `codex` on [path]. A directory that npm adds does not count, such as `node_modules/.bin`: the daemon does
 * not get it.
 */
async function codexOnPath(path) {
  for (const directory of path.split(delimiter).filter(item => isAbsolute(item))) {
    if (npmPathEntry(directory)) continue
    if (await executable(join(directory, 'codex'))) return join(directory, 'codex')
  }
  return undefined
}

/**
 * Checks what Megachat needs at run time, at the places that `CentralConfigurationService` and the shims use. Each
 * result is one line. The checks never print the output of Central or of the key helper of Claude Code. [binaries]
 * holds the platform binaries that npm installed with the agents. The checks pass when the platform and Central pass
 * and a child agent is ready: Claude with a binary and a key, or Codex with a binary. A Claude child gets its key from
 * the Central entry of Claude Code, else from the route of pi in Central.
 */
async function checks({ configuration, platform, path, binaries }) {
  const lines = []
  const platformPassed = platform === 'darwin'
  lines.push(platformPassed ? message('install.macos') : message('install.platform', platform))
  let centralPassed = false
  if (!await executable(configuration.central)) lines.push(message('install.centralMissing', configuration.central))
  else {
    try {
      await configuration.pi()
      centralPassed = true
      lines.push(message('install.central'))
    }
    catch { lines.push(message('install.centralFailed')) }
  }
  const userClaude = await executable(configuration.claude)
  lines.push(userClaude ? message('install.claude', configuration.claude)
    : binaries.claude ? message('install.claudeBundled', configuration.claude) : message('install.claudeMissing', configuration.claude))
  let claudeKey = false
  try {
    const { source, fallback } = await configuration.claudeConfiguration()
    claudeKey = true
    const key = source === 'settings' ? 'install.claudeKey' : fallback === 'helper' ? 'install.claudeKeyHelper' : 'install.claudeKeyPi'
    lines.push(message(key, configuration.settings, configuration.keyHelperTimeout / 1000))
  }
  catch { lines.push(message('install.claudeCentral')) }
  const codex = await codexOnPath(path)
  lines.push(codex ? message('install.codex', codex) : binaries.codex ? message('install.codexBundled') : message('install.codexMissing'))
  const claudeReady = (userClaude || binaries.claude !== undefined) && claudeKey
  const codexReady = codex !== undefined || binaries.codex !== undefined
  return { lines, passed: platformPassed && centralPassed && (claudeReady || codexReady) }
}

/**
 * The command `install`: checks the machine and adds the entry `Megachat` to `acp.json`. In a git checkout, the entry
 * starts the checkout with the Node.js of this process. In each other copy, the entry is [RELEASE_ENTRY], and it
 * replaces an [earlierEntry] or an [entryWithoutTimeLimits]. The command prints one line for each result, then the lines
 * about the IDE build, the network and npx, then the version and the directory of this copy. It returns 0 only when the
 * entry is in place and the checks passed. The lines about the IDE build and the network do not change it. A test can
 * pass its own [configuration] and [binaries]. The default [configuration] writes no log line: each check prints one
 * plain line, and a log line of a failure has the frames of the stack.
 */
export async function install({ environment = process.env, platform = process.platform, print = line => process.stdout.write(`${line}\n`),
  root = fileURLToPath(new URL('..', import.meta.url)).replace(/[\\/]$/, ''),
  configuration = new CentralConfigurationService({ environment, log: () => {} }), binaries = bundledBinaries() } = {}) {
  const { lines, passed } = await checks({ configuration, platform, path: environment.PATH ?? '', binaries })
  for (const line of lines) print(line)
  const path = acpConfigPath(environment)
  const checkout = gitCheckout(root)
  const entry = checkout ? { command: await stableNodePath({ path: environment.PATH ?? '', platform }), args: [join(root, 'bin', 'megachat.mjs'), 'acp'] }
    : RELEASE_ENTRY
  const result = await writeEntry(path, entry, new Date(), checkout ? () => false : existing => earlierEntry(existing) || entryWithoutTimeLimits(existing))
  const pasted = value => `"${ENTRY}": ${JSON.stringify(value)}`
  switch (result.status) {
    case 'created': print(message('install.created', path)); break
    case 'added': print(message('install.added', path, result.backup)); break
    case 'replaced':
      print(message(earlierEntry(result.existing) ? 'install.replaced' : 'install.replacedEarlier', path, result.backup))
      print(pasted(result.existing))
      break
    case 'same': print(message('install.same', path)); break
    case 'different': print(message('install.different', path)); print(pasted(result.existing)); print(message('install.entry')); print(pasted(entry)); break
    default: print(message('install.unreadable', path)); print(pasted(entry))
  }
  const placed = ['created', 'added', 'replaced', 'same'].includes(result.status)
  // Nothing in a terminal tells which IDE build starts the entry, so this line only names the need.
  print(message('install.air'))
  if (checkout) print(message('install.copy', root, megachatVersion()))
  else {
    if (placed) {
      print(message('install.network'))
      print(message('install.ide'))
    }
    print(message('install.release', root, megachatVersion()))
  }
  return passed && placed ? 0 : 1
}

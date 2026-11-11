import { constants } from 'node:fs'
import { access, chmod, copyFile, mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { CentralConfigurationService } from './CentralConfigurationService.mjs'
import { VERSION } from './MegachatBuild.mjs'
import { message } from './messages.mjs'

/** A test sets this variable, so that no test can reach the `acp.json` of the user. */
export const ACP_CONFIG_VARIABLE = 'MEGACHAT_ACP_CONFIG'
/** Air derives the agent ID `acp.megachat` from this name. */
const ENTRY = 'Megachat'

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
 * Adds [entry] as `Megachat` to `agent_servers` of the file [path]. The result is `created`, `added`, `same`,
 * `different` or `unreadable`, and only `created` and `added` write a file. Before `added`, this copies the file to
 * `<path>.before-megachat-<UTC time>`. `added` keeps each other key, the key order and the mode of the file.
 */
export async function writeEntry(path, entry, now = new Date()) {
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
  if (existing !== undefined) return isDeepStrictEqual(existing, entry) ? { status: 'same' } : { status: 'different', existing }
  const backup = `${path}.before-megachat-${now.toISOString().replace(/[-:]|\.\d+/g, '')}`
  await copyFile(path, backup, constants.COPYFILE_EXCL)
  await chmod(backup, (await stat(path)).mode & 0o777)
  configuration.agent_servers = { ...configuration.agent_servers, [ENTRY]: entry }
  await writeFile(path, `${JSON.stringify(configuration, null, 2)}\n`)
  return { status: 'added', backup }
}

async function executable(path) {
  try { await access(path, constants.X_OK); return (await stat(path)).isFile() }
  catch { return false }
}

/**
 * The first `codex` on [path]. A `node_modules/.bin` directory does not count: npm and npx add it, but the IDE starts
 * Megachat without it.
 */
async function codexOnPath(path) {
  for (const directory of path.split(delimiter).filter(item => isAbsolute(item))) {
    if (basename(directory) === '.bin' && basename(dirname(directory)) === 'node_modules') continue
    if (await executable(join(directory, 'codex'))) return join(directory, 'codex')
  }
  return undefined
}

/**
 * Checks what Megachat needs at run time, at the places that `CentralConfigurationService` and the shims use. Each
 * result is one line. The checks never print the output of Central or of the key helper of Claude Code.
 */
async function checks({ configuration, platform, path }) {
  const results = [platform === 'darwin' ? { passed: true, text: message('install.macos') }
    : { passed: false, text: message('install.platform', platform) }]
  if (!await executable(configuration.central)) results.push({ passed: false, text: message('install.centralMissing', configuration.central) })
  else {
    try { await configuration.pi(); results.push({ passed: true, text: message('install.central') }) }
    catch { results.push({ passed: false, text: message('install.centralFailed') }) }
  }
  if (!await executable(configuration.claude)) results.push({ passed: false, text: message('install.claudeMissing', configuration.claude) })
  else {
    try { await configuration.childEnvironment(); results.push({ passed: true, text: message('install.claude', configuration.claude) }) }
    catch { results.push({ passed: false, text: message('install.claudeCentral') }) }
  }
  const codex = await codexOnPath(path)
  results.push(codex ? { passed: true, text: message('install.codex', codex) } : { passed: false, text: message('install.codexMissing') })
  return results
}

/**
 * The command `install`: checks the machine and adds the entry `Megachat` that starts this copy to `acp.json`. It
 * prints one line for each result, then the version and the directory of this copy. It returns 0 only when the entry
 * is in place and each check passed.
 */
export async function install({ environment = process.env, platform = process.platform, print = line => process.stdout.write(`${line}\n`) } = {}) {
  let passed = true
  for (const result of await checks({ configuration: new CentralConfigurationService({ environment }), platform, path: environment.PATH ?? '' })) {
    print(result.text)
    passed &&= result.passed
  }
  const path = acpConfigPath(environment)
  const entry = { command: await stableNodePath({ path: environment.PATH ?? '', platform }),
    args: [fileURLToPath(new URL('../bin/megachat.mjs', import.meta.url)), 'acp'] }
  const result = await writeEntry(path, entry)
  const pasted = value => `"${ENTRY}": ${JSON.stringify(value)}`
  switch (result.status) {
    case 'created': print(message('install.created', path)); break
    case 'added': print(message('install.added', path, result.backup)); break
    case 'same': print(message('install.same', path)); break
    case 'different': print(message('install.different', path)); print(pasted(result.existing)); print(message('install.entry')); print(pasted(entry)); break
    default: print(message('install.unreadable', path)); print(pasted(entry))
  }
  print(message('install.copy', fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, ''), VERSION))
  return passed && ['created', 'added', 'same'].includes(result.status) ? 0 : 1
}

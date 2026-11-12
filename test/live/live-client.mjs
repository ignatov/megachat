// The helpers of the live smoke run: a scripted ACP client that sends what Air sends, the temporary state homes, the
// environment of the daemon, and the filter that keeps the key and the address of Central out of each printed text.
// `npm test` does not load this directory. See the section about the live smoke run in `README.md`.
import { spawn, execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { appendFileSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, realpath, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, join, relative, resolve, sep } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

export const LEASE = resolve(fileURLToPath(new URL('../..', import.meta.url)))
const MAIN = join(LEASE, 'src', 'main.mjs')
const run = promisify(execFile)
export const delay = ms => new Promise(done => setTimeout(done, ms))

/**
 * The capabilities that Air sends in `initialize` to the application agent (`acpClientExtensionMeta` of
 * `AcpInitializedClientFactory.kt`). Megachat reads `asyncTasks`, `serviceSessions` and `workspaces`.
 */
export const AIR_CAPABILITIES = ['sessionFailure', 'recommendedValue', 'nativeSubagentSessions', 'serviceSessions',
  'workspaces', 'asyncTasks', 'backgroundSubagents', 'agentFileChangeReport', 'planFile', 'diffPatch', 'rawInputRendering',
  'planContentDelta', 'modelProviderGroups', 'loadReplayEnd', 'sessionIndex']

// The filter of each text that the run prints or keeps. The values come from the Central configuration in the memory of
// this process. They never go to a file or to the output.
const secrets = []
export async function loadSecrets() {
  const { CentralConfigurationService } = await import(join(LEASE, 'src', 'CentralConfigurationService.mjs'))
  const central = new CentralConfigurationService()
  const main = await central.pi()
  secrets.push(main.apiKey, main.baseUrl, new URL(main.baseUrl).pathname)
  try {
    const child = await central.childEnvironment()
    secrets.push(child.ANTHROPIC_API_KEY, child.ANTHROPIC_BASE_URL, new URL(child.ANTHROPIC_BASE_URL).pathname)
  }
  catch { /* The check of the Claude children then fails on its own. */ }
  for (let index = secrets.length - 1; index >= 0; index--) if (!secrets[index] || secrets[index].length < 8) secrets.splice(index, 1)
}
const ADDRESS = /http:\/\/127\.0\.0\.1:\d+\/wire\/[^\s"'\\)]*/g
export function redact(text) {
  let value = String(text)
  for (const secret of secrets) value = value.split(secret).join('<redacted>')
  return value.replace(ADDRESS, '<central>')
}
/** True when [text] holds a value of the Central configuration or an address of Central. */
export function leaks(text) {
  const value = String(text)
  return secrets.some(secret => value.includes(secret)) || new RegExp(ADDRESS.source).test(value)
}

/** The real temporary directory. A state home must be in it, and never the shared state of the user. */
const TEMPORARY = realpathSync(tmpdir())
export function assertTemporary(path) {
  const real = realpathSync(path)
  const shared = join(homedir(), '.jetbrains')
  if (real === TEMPORARY || !real.startsWith(TEMPORARY + sep) || real.startsWith(shared))
    throw new Error(`Refused: ${path} is not a directory in the temporary directory`)
  return real
}

/** The root of one smoke run: a new temporary directory for the homes, the projects and the logs. */
export async function makeRoot() {
  return assertTemporary(await mkdtemp(join(tmpdir(), 'megachat-live-')))
}

/** A new state home with [values] in `settings.json`, the onboarding done. */
export async function makeHome(root, name, values, projects) {
  const home = join(root, `home-${name}`)
  await mkdir(home, { mode: 0o700 })
  await writeSettings(home, values, projects)
  return assertTemporary(home)
}

/** Writes `settings.json` of [home] with [values], and with [projects], the values of each project by its real path. */
export async function writeSettings(home, values, projects) {
  assertTemporary(home)
  await writeFile(join(home, 'settings.json'), JSON.stringify({ schema: 1, onboarding: 'done', values, ...(projects ? { projects } : {}) }, null, 1),
    { mode: 0o600 })
}

/** A throwaway project with [files], optionally a git repository. */
export async function makeProject(root, name, files = {}, { git = false } = {}) {
  const directory = join(root, 'projects', name)
  await mkdir(directory, { recursive: true })
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(directory, path, '..'), { recursive: true })
    await writeFile(join(directory, path), text)
  }
  if (git) {
    await run('git', ['init', '-q'], { cwd: directory })
    await run('git', ['-c', 'user.name=Smoke', '-c', 'user.email=smoke@example.invalid', 'commit', '-q', '--allow-empty', '-m', 'Start'], { cwd: directory })
  }
  return realpath(directory)
}

/**
 * The environment of the daemon: the variables that an IDE gives a direct command, and no variable of the shell of an
 * agent. The temporary `acp.json` and the empty list of legacy directories keep the state of the user safe.
 */
export function daemonEnvironment(root, extra = {}) {
  const names = ['HOME', 'USER', 'LOGNAME', 'SHELL', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SSH_AUTH_SOCK', 'CODEX_HOME']
  const env = Object.fromEntries(names.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]]))
  env.PATH = (process.env.PATH ?? '').split(delimiter).filter(entry => !entry.includes('node_modules')).join(delimiter)
  return { ...env, MEGACHAT_ACP_CONFIG: join(root, 'acp.json'), MEGACHAT_LEGACY_DIRS: '', MEGACHAT_KEEPALIVE: '0', ...extra }
}

/** The daemon of [home] through the local HTTP API. The token stays in the memory of this process. */
export async function daemonOf(home) {
  const { DaemonClient } = await import(join(LEASE, 'src', 'DaemonClient.mjs'))
  return DaemonClient.connect(assertTemporary(home))
}

export async function stopDaemon(home, env) {
  assertTemporary(home)
  let pid
  try { pid = JSON.parse(await readFile(join(home, 'daemon', 'connection.json'), 'utf8')).pid }
  catch { return { running: false } }
  await run(process.execPath, [MAIN, 'stop', home], { env, timeout: 30000 }).catch(() => {})
  for (let attempt = 0; attempt < 200; attempt++) {
    try { process.kill(pid, 0) }
    catch { return { running: true, pid, stopped: true } }
    await delay(100)
  }
  return { running: true, pid, stopped: false }
}

/** The ACP client of one view. It speaks JSON-RPC to `src/main.mjs acp <home>` as Air does. */
export class LiveClient {
  constructor({ home, env, directories = [], permission = allowOnce, log, name = 'client' }) {
    this.home = assertTemporary(home)
    this.env = env
    this.directories = directories
    this.permission = permission
    this.logPath = log
    this.name = name
    this.updates = []
    this.permissions = []
    this.records = []
    this.pending = new Map()
    this.nextId = 1
  }

  log(direction, value) {
    if (this.logPath) appendFileSync(this.logPath, `${redact(JSON.stringify({ at: new Date().toISOString(), client: this.name, direction, value }))}\n`, { mode: 0o600 })
  }

  async start() {
    this.child = spawn(process.execPath, [MAIN, 'acp', this.home], { env: this.env, stdio: ['pipe', 'pipe', 'pipe'] })
    this.exited = new Promise(done => this.child.once('exit', code => { this.exitCode = code; done(code) }))
    createInterface({ input: this.child.stdout }).on('line', line => this.receive(line))
    createInterface({ input: this.child.stderr }).on('line', line => this.log('stderr', line))
    this.child.stdin.on('error', () => {})
    return this
  }

  send(value) {
    this.log('out', value)
    if (this.child.stdin.writable) this.child.stdin.write(`${JSON.stringify(value)}\n`)
  }

  receive(line) {
    let item
    try { item = JSON.parse(line) }
    catch { this.log('stdout', line); return }
    this.log('in', item)
    if (item.method && item.id !== undefined) { this.answer(item).catch(() => {}); return }
    if (item.method) {
      if (item.method === 'session/update') this.updates.push({ at: Date.now(), ...item.params })
      return
    }
    const waiter = this.pending.get(item.id)
    if (!waiter) return
    this.pending.delete(item.id)
    if (item.error) waiter.reject(Object.assign(new Error(item.error.message), { rpc: item.error }))
    else waiter.resolve(item.result)
  }

  async answer(item) {
    const reply = result => this.send({ jsonrpc: '2.0', id: item.id, result })
    switch (item.method) {
      case '_workspaces/list': reply({ directories: this.directories }); return
      case '_session/service/record': this.records.push({ at: Date.now(), ...item.params }); reply({}); return
      case 'session/request_permission': {
        const entry = { at: Date.now(), params: item.params }
        this.permissions.push(entry)
        const optionId = await this.permission(item.params, entry)
        entry.answer = optionId ?? null
        entry.answeredAt = Date.now()
        if (optionId) reply({ outcome: { outcome: 'selected', optionId } })
        else reply({ outcome: { outcome: 'cancelled' } })
        return
      }
      default: this.send({ jsonrpc: '2.0', id: item.id, error: { code: -32601, message: 'Method not found' } })
    }
  }

  request(method, params, timeoutMs = 600000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`No answer to ${method}`)) }, timeoutMs)
      this.pending.set(id, { resolve: value => { clearTimeout(timer); resolve(value) }, reject: error => { clearTimeout(timer); reject(error) } })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  async initialize() {
    this.initialized = await this.request('initialize', { protocolVersion: 1, clientInfo: { name: 'live-smoke', version: '1' },
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false,
        _meta: { 'user-colocated': true, jetbrains: { air: { version: 1, capabilities: AIR_CAPABILITIES } } } } }, 180000)
    return this.initialized
  }

  async newSession(cwd) {
    const result = await this.request('session/new', { cwd, mcpServers: [] }, 180000)
    this.sessionId = result.sessionId
    return result
  }

  async loadSession(sessionId, cwd) {
    this.sessionId = sessionId
    return this.request('session/load', { sessionId, cwd, mcpServers: [] }, 180000)
  }

  /** Sends one prompt and gives its answer with the updates that arrived while it ran. */
  async prompt(text, timeoutMs = 600000) {
    const from = this.updates.length
    const sentAt = Date.now()
    const result = await this.request('session/prompt', { sessionId: this.sessionId, prompt: [{ type: 'text', text }],
      _meta: { jetbrains: { air: { clientMessageId: randomUUID() } } } }, timeoutMs)
    return { ...result, sentAt, endedAt: Date.now(), updates: this.updates.slice(from), from, to: this.updates.length }
  }

  /** Closes the process of this view and attaches a new one to the same session, as a new window of Air does. */
  async reconnect(cwd) {
    await this.close()
    for (const waiter of this.pending.values()) waiter.reject(new Error('The view closed'))
    this.pending.clear()
    this.exitCode = undefined
    await this.start()
    await this.initialize()
    await this.loadSession(this.sessionId, cwd ?? this.directories[0])
  }

  stopTask(asyncTaskId) {
    return this.request('_session/async_task/stop', { sessionId: this.sessionId, asyncTaskId }, 60000)
  }

  async waitFor(predicate, timeoutMs, what = 'a condition') {
    const end = Date.now() + timeoutMs
    for (;;) {
      const value = await predicate()
      if (value) return value
      if (Date.now() > end) throw new Error(`Timeout: ${what}`)
      await delay(500)
    }
  }

  async close() {
    if (!this.child || this.exitCode !== undefined) return
    this.child.stdin.end()
    const ended = await Promise.race([this.exited, delay(5000).then(() => 'timeout')])
    if (ended === 'timeout') { this.child.kill('SIGTERM'); await this.exited }
  }
}

/** The permission policy of a user who allows each request one time. */
export function allowOnce(params) {
  return (params.options.find(option => option.kind === 'allow_once') ?? params.options.find(option => option.kind.startsWith('allow')))?.optionId
}

/** The text of the reply chunks in [updates], by message ID in their order. */
export function replies(updates) {
  const messages = new Map()
  for (const item of updates) {
    const update = item.update
    if (update?.sessionUpdate !== 'agent_message_chunk' || item._meta?.loadSessionReplayIndex !== undefined) continue
    const entry = messages.get(update.messageId) ?? { messageId: update.messageId, chunks: 0, text: '', first: item.at, last: item.at }
    entry.chunks++
    entry.text += update.content?.text ?? ''
    entry.last = item.at
    messages.set(update.messageId, entry)
  }
  return [...messages.values()]
}

/** The prompt suggestions in [updates]: each `session_info_update` with `_meta.promptSuggestions`. */
export function suggestions(updates) {
  return updates.filter(item => item.update?.sessionUpdate === 'session_info_update' && item.update._meta?.promptSuggestions)
    .map(item => ({ at: item.at, text: item.update._meta.promptSuggestions.suggestions?.[0]?.text ?? null }))
}

export const relativeTo = (root, path) => relative(root, path)

import { createHash } from 'node:crypto'
import { terminalStates } from './MegachatState.mjs'

/**
 * Finds the agent sessions in a process table for the tool `agents_running`. Only this module reads the command line of
 * a process, because a command line can hold a prompt or a secret. A row that it gives has the metadata only.
 */

/** The name of each agent for the user, also the name of the service of an agent that owns a session. */
const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', opencode: 'OpenCode' }
export const AGENTS = Object.keys(AGENT_NAMES)
const MEGACHAT = 'Megachat'

/**
 * The programs of the agents. A native program has its name as the executable name, and a program that Node.js or Bun
 * runs has its name as the script name, or a script in its npm package. An adapter speaks ACP for an IDE and starts the
 * agent of each session as a child process.
 */
const PROGRAMS = [
  { agent: 'claude', role: 'adapter', names: ['claude-agent-acp', 'claude-code-acp'], script: /\/(claude-agent-acp|claude-code-acp)\// },
  { agent: 'codex', role: 'adapter', names: ['codex-acp'], script: /\/codex-acp\// },
  { agent: 'claude', role: 'agent', names: ['claude'], script: /\/@anthropic-ai\/claude-code\// },
  { agent: 'codex', role: 'agent', names: ['codex'], script: /\/@openai\/codex\// },
  { agent: 'pi', role: 'agent', names: ['pi'], script: /\/pi-coding-agent\// },
  { agent: 'opencode', role: 'agent', names: ['opencode'], script: /\/opencode-ai\// },
]
const INTERPRETERS = new Set(['node', 'nodejs', 'bun', 'deno'])
/** The apps that own a session as an IDE: the JetBrains IDEs, the other editors, and the desktop apps of the agents. */
const IDE_APPS = /^(IntelliJ IDEA|PyCharm|WebStorm|GoLand|CLion|PhpStorm|RubyMine|Rider|DataGrip|DataSpell|RustRover|Aqua|Writerside|Fleet|Android Studio|JetBrains Gateway|JetBrains Client|Air|Visual Studio Code|VSCodium|Code - OSS|Cursor|Windsurf|Zed|Xcode|Nova|Sublime Text|Kiro|Trae|Antigravity|ChatGPT|Codex|Claude|OpenCode)\b/
const TERMINAL_APPS = /^(Terminal|iTerm2?|Ghostty|WezTerm|kitty|Alacritty|Warp|WarpPreview|Hyper|Tabby|Rex|Wave|Termius)\b/
/** The terminal programs without an app: the server of a remote terminal. */
const TERMINAL_PROGRAMS = { 'mosh-server': 'mosh', sshd: 'SSH', 'sshd-session': 'SSH' }
/**
 * The servers of a multiplexer. Such a server stays alive without a client, so it owns its sessions also when it is
 * detached. A session in it is never an orphan.
 */
const MULTIPLEXERS = { tmux: 'tmux', screen: 'screen', SCREEN: 'screen', zellij: 'zellij', herdr: 'herdr', 'herdr-core': 'herdr',
  dtach: 'dtach', abduco: 'abduco' }
/**
 * The main classes of a JetBrains IDE that runs from sources. Such an IDE is a bare `java` process without an app
 * bundle. The run configurations of the IntelliJ monorepo start `com.intellij.idea.Main`, or the dev server
 * `org.jetbrains.intellij.build.devServer.DevMainKt`, which builds the IDE and runs it in the same process. Their mode
 * of a short command line puts only the class path into an argument file, so the main class stays on the command line.
 */
const IDE_MAIN_CLASSES = new Set(['com.intellij.idea.Main', 'org.jetbrains.intellij.build.devServer.DevMainKt'])
/**
 * The programs that own no session: a shell that stays after its terminal, and the programs that only start another
 * program. A process of another program in the parent chain can own the session, so a chain with such a process and
 * without a known owner gives no orphan.
 */
const NO_OWNERS = new Set(['sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'login', 'env', 'nohup'])

const baseName = path => path.slice(path.lastIndexOf('/') + 1)
const escapeRegExp = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Splits a command line into the parts that the rules read. The path of the executable can hold spaces, as an app
 * bundle has. The kernel gives the executable name, so the path ends at the first `/<name>` before a space, when no
 * argument (a space and a dash or a slash) comes before it. Else the path is the first word.
 */
function parts({ name = '', command = '' }) {
  let executable
  if (name && (command === name || command.startsWith(`${name} `))) executable = name
  else if (name) {
    const match = new RegExp(`/${escapeRegExp(name)}(?= |$)`).exec(command)
    if (match && !/ [-/]/.test(command.slice(0, match.index))) executable = command.slice(0, match.index + name.length + 1)
  }
  executable ??= command.split(' ', 1)[0]
  const base = baseName(executable).replace(/:$/, '')
  const words = command.slice(executable.length).trim().split(/\s+/).filter(Boolean)
  const interpreted = INTERPRETERS.has(base) || INTERPRETERS.has(name)
  const index = interpreted ? words.findIndex(word => !word.startsWith('-')) : -1
  const script = index < 0 ? '' : words[index]
  // The outermost app bundle in the path of the executable is the app. The path ends before the first argument.
  const path = command.slice(0, / [-/]/.exec(command)?.index ?? command.length)
  const app = /^\/(?:[^/]+\/)*?([^/]+)\.app\//.exec(path)?.[1]
  return { base, script, words: interpreted ? (index < 0 ? [] : words.slice(index + 1)) : words, interpreted, app }
}

/**
 * Describes one process: the agent and its role (an agent, an adapter, a service or a helper), or the owner that it
 * is for the processes below it, or both. The role `service` is a background service of an agent that the agent
 * starts for its sessions. The role `helper` is a process of an agent that is no session.
 */
function describe(item) {
  const { base, script, words, interpreted, app } = parts(item)
  const program = interpreted ? baseName(script) : base
  const label = app ?? base
  // A script of Megachat itself, but not a script of a package that Megachat installed, as its adapters are.
  if (interpreted && /megachat/i.test(script.replace(/.*\/node_modules\//, ''))) {
    if (/\/(src\/main|dist\/megachat)\.mjs$/.test(script) && words[0] === 'daemon') return { label, owner: { kind: 'megachat', name: MEGACHAT } }
    // The launchers in `bin`, the supervisor of a child and the ACP command are no agents, and they own no session.
    return { label, passive: true }
  }
  const found = PROGRAMS.find(rule => rule.names.includes(program) || interpreted && rule.script.test(script))
  if (found) {
    const { agent } = found
    let role = found.role
    if (agent === 'claude' && words[0] === 'daemon' || agent === 'codex' && words[0] === 'app-server' && words[1] === 'daemon') role = 'service'
    else if (agent === 'claude' && /^bg-/.test(words[0] ?? '')) role = 'helper'
    // The name of the program for the user: the executable name, or the name of the package of a script.
    const name = found.names.includes(program) ? program : found.names[0]
    return { label, agent, role, program: name, ...(role === 'service' ? { owner: { kind: 'unknown', name: AGENT_NAMES[agent] } } : {}) }
  }
  if (app) {
    const kind = TERMINAL_APPS.test(app) ? 'terminal' : IDE_APPS.test(app) ? 'ide' : 'unknown'
    return { label, owner: { kind, name: app } }
  }
  if (TERMINAL_PROGRAMS[base]) return { label, owner: { kind: 'terminal', name: TERMINAL_PROGRAMS[base] } }
  if (MULTIPLEXERS[base]) return { label, owner: { kind: 'multiplexer', name: MULTIPLEXERS[base] } }
  if (base === 'java' && words.some(word => IDE_MAIN_CLASSES.has(word))) return { label, owner: { kind: 'ide', name: label } }
  // A login shell has a dash before its name.
  return { label, ...(NO_OWNERS.has(base.replace(/^-/, '')) ? { passive: true } : {}) }
}

/**
 * A digest of the executable name and the command line of a process. A stop compares it, so a PID that now runs
 * another command is another process. The digest holds no readable part of the command line.
 */
export const identityOf = item => createHash('sha256').update(`${item.name ?? ''}\0${item.command ?? ''}`).digest('hex')

/** The longest parent chain that Megachat follows. A chain from a table with a reused PID can have a loop. */
const MAX_DEPTH = 64

/**
 * Gives one row for each agent session in [processes]. One session is the top agent process of its tree: an agent
 * process below another process of the same agent is a helper of that session. An adapter is a row only when no agent
 * of its own runs below it, because each agent below an adapter is one session.
 *
 * The parent of a row is the nearest owner in its parent chain: Megachat, an IDE, a terminal, a multiplexer, the
 * service of an agent, or another app. A chain that reaches [daemonPid] belongs to this daemon. Then the state is the
 * authority: a process below a supervisor PID of a run is the session of that run, an orphan when the run ended, and
 * each other process of the daemon is a helper of Megachat and not a row.
 *
 * `ownership` is `owned` with an owner, and `orphan` only when the owner is gone for certain: the chain reaches launchd,
 * and each process in it is a shell, a program that only starts another program, a helper of Megachat or a process of
 * the same agent. A chain with another live process, such as a bare `java` that is no IDE for certain or a script that
 * started the agent, can have a live owner, so its `ownership` is `unknown`. So is a chain that ends before launchd.
 *
 * The CPU load of a row is the sum of its process and of each process below it that is no row of its own. `program` is
 * the name of the program of the session for the user, `uid` the user of its process, and `identity` the digest of its
 * command line for a stop.
 */
export function agentSessions(processes, { daemonPid = process.pid, runs = [] } = {}) {
  const byPid = new Map(processes.map(item => [item.pid, item]))
  const described = new Map(processes.map(item => [item.pid, describe(item)]))
  const runByPid = new Map()
  for (const run of runs) {
    if (!Number.isSafeInteger(run.pid)) continue
    const known = runByPid.get(run.pid)
    if (!known || terminalStates.has(known.status) && !terminalStates.has(run.status)) runByPid.set(run.pid, run)
  }
  const ancestors = item => {
    const chain = []
    const seen = new Set([item.pid])
    for (let next = byPid.get(item.ppid); next && !seen.has(next.pid) && chain.length < MAX_DEPTH; next = byPid.get(next.ppid)) {
      chain.push(next)
      seen.add(next.pid)
    }
    return chain
  }
  const covered = new Set()
  const candidates = []
  for (const item of processes) {
    const { agent, role } = described.get(item.pid)
    if (role !== 'agent' && role !== 'adapter') continue
    const chain = ancestors(item)
    if (role === 'agent') for (const above of chain) if (described.get(above.pid).agent === agent && described.get(above.pid).role === 'adapter') covered.add(above.pid)
    const absorbed = chain.some(above => {
      const other = described.get(above.pid)
      return other.agent === agent && (other.role === 'agent' || role === 'adapter' && other.role === 'adapter')
    })
    if (!absorbed) candidates.push({ item, chain })
  }
  const rows = []
  for (const { item, chain } of candidates) {
    const { agent, role } = described.get(item.pid)
    if (role === 'adapter' && covered.has(item.pid)) continue
    const daemon = chain.findIndex(above => above.pid === daemonPid)
    let parent
    let ownership = 'owned'
    let run
    if (daemon >= 0) {
      run = [item, ...chain.slice(0, daemon)].map(above => runByPid.get(above.pid)).find(Boolean)
      if (!run) continue
      parent = { kind: 'megachat', name: MEGACHAT, pid: daemonPid }
      if (terminalStates.has(run.status)) ownership = 'orphan'
    }
    else {
      const owner = chain.find(above => described.get(above.pid).owner)
      // A chain that ends before launchd is cut: a loop of reused PIDs, or a parent that the table does not have.
      const top = chain.at(-1) ?? item
      const whole = top.pid <= 1 || top.ppid <= 1
      const possible = chain.find(above => above.pid > 1 && !described.get(above.pid).passive && described.get(above.pid).agent !== agent)
      if (owner) parent = { ...described.get(owner.pid).owner, pid: owner.pid }
      else if (possible || !whole) {
        ownership = 'unknown'
        parent = { kind: 'unknown', name: possible ? described.get(possible.pid).label : '', pid: possible ? possible.pid : item.ppid }
      }
      else {
        ownership = 'orphan'
        parent = { kind: 'unknown', name: chain.length ? described.get(chain[0].pid).label : '', pid: item.ppid }
      }
    }
    rows.push({ pid: item.pid, agent, startedAt: item.startedAt, cpu: 0, parent, ownership, uid: item.uid,
      program: described.get(item.pid).program, identity: identityOf(item),
      ...(run ? { run: { id: run.id, sessionId: run.providerSessionId ?? '', title: run.title ?? '', cwd: run.cwd } } : {}) })
  }
  const rowByPid = new Map(rows.map(row => [row.pid, row]))
  const nearest = new Map()
  const rowOf = item => {
    const path = []
    let found = null
    for (let next = item; next && path.length < MAX_DEPTH && !path.includes(next.pid); next = byPid.get(next.ppid)) {
      if (nearest.has(next.pid)) { found = nearest.get(next.pid); break }
      path.push(next.pid)
      if (rowByPid.has(next.pid)) { found = rowByPid.get(next.pid); break }
    }
    for (const pid of path) nearest.set(pid, found)
    return found
  }
  for (const item of processes) {
    const row = rowOf(item)
    if (row) row.cpu += item.cpu
  }
  return rows
}

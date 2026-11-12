import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join, relative } from 'node:path'
import { expandHome } from './ProjectDirectories.mjs'

/** The first run of tokprof reads each log of the machine. On 9 GB of logs, that takes about 45 seconds. */
export const TOKPROF_TIMEOUT_MS = 120000
/** The largest output file that Megachat reads. One line is one stack of agent, project and origin. */
const OUTPUT_LIMIT = 4 * 1024 * 1024
const STACK = 'agent,project,origin'
const TOP = 15
const usd = micro => Math.round(micro / 10000) / 100

const insideOrSame = (root, path) => {
  const rest = relative(root, path)
  return !rest.startsWith('..') && !isAbsolute(rest)
}

const top = (map, key) => [...map].sort((left, right) => right[1] - left[1]).slice(0, TOP)
  .map(([name, micro]) => ({ [key]: name, usd: usd(micro) }))

/**
 * Reads the folded stacks of `tokprof flame --stack agent,project,origin --value cost`: each line is
 * `<agent>;<project>;<origin> <micro-dollars>`. tokprof reads no store of Pi Durable, so a pi child of Megachat is not
 * in its output. A line of the agent `pi` in the state directory of Megachat, where the store of the pi children is,
 * is left out all the same, so the cost of a pi child cannot count two times.
 */
export function parseTokprof(text, { home = homedir(), stateDirectory } = {}) {
  const agents = new Map()
  const projects = new Map()
  const origins = new Map()
  let total = 0
  let excluded = 0
  const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value)
  for (const line of text.split('\n')) {
    const match = /^(.+) (\d+)$/.exec(line.trim())
    if (!match) continue
    const frames = match[1].split(';')
    const micro = Number(match[2])
    const agent = frames[0]
    const project = frames.length > 2 ? frames.slice(1, -1).join(';') : frames[1] ?? ''
    const origin = frames.length > 2 ? frames.at(-1) : 'unknown'
    const path = expandHome(project, home)
    if (agent === 'pi' && stateDirectory && isAbsolute(path) && insideOrSame(stateDirectory, path)) {
      excluded += micro
      continue
    }
    total += micro
    add(agents, agent, micro)
    add(projects, project || 'unknown', micro)
    add(origins, origin, micro)
  }
  return { status: 'ok', usd: usd(total), agents: Object.fromEntries([...agents].map(([name, micro]) => [name, usd(micro)])),
    projects: top(projects, 'project'), origins: top(origins, 'origin'), excludedPiChildUsd: usd(excluded) }
}

/**
 * The API-equivalent cost of the agent sessions of this machine from the date [since] up to the day before the date
 * [until], from the command `tokprof`. The command comes from `PATH`, else from `~/.local/bin`. It runs with no shell,
 * with [timeoutMs], and it writes its output to a private temporary file, which Megachat reads up to a size limit.
 * Without the command, or after a failure, a timeout or an output that is too large, the result says that this part is
 * missing, and why. [signal] stops the command at the stop of the daemon.
 */
export async function readTokprof({ since, until, environment = process.env, home = homedir(), stateDirectory, timeoutMs = TOKPROF_TIMEOUT_MS,
  signal }) {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-tokprof-'))
  const file = join(directory, 'spend.folded')
  try {
    const env = { ...environment, PATH: [environment.PATH, join(home, '.local', 'bin')].filter(Boolean).join(delimiter) }
    const failure = await new Promise(resolve => {
      execFile('tokprof', ['flame', '--since', since, '--until', until, '--stack', STACK, '--value', 'cost', '-o', file],
        { env, timeout: timeoutMs, maxBuffer: 1024 * 1024, windowsHide: true, signal }, error => resolve(error))
    })
    if (failure) return { status: 'missing', reason: failure.code === 'ENOENT' ? 'notFound' : failure.killed ? 'timeout' : 'failed' }
    const size = await stat(file).then(info => info.size, () => undefined)
    if (size === undefined) return { status: 'missing', reason: 'failed' }
    if (size > OUTPUT_LIMIT) return { status: 'missing', reason: 'output' }
    return parseTokprof(await readFile(file, 'utf8'), { home, stateDirectory })
  }
  finally { await rm(directory, { force: true, recursive: true }) }
}

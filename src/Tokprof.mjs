import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { delimiter, isAbsolute, join } from 'node:path'
import { directoryKey, expandHome, isWithin } from './ProjectDirectories.mjs'

/** The first run of tokprof reads each log of the machine. On 9 GB of logs, that takes about 45 seconds. */
export const TOKPROF_TIMEOUT_MS = 120000
/** The largest output file that Megachat reads. One line is one stack of agent, project and origin. */
const OUTPUT_LIMIT = 4 * 1024 * 1024
const STACK = 'agent,project,origin'
const TOP = 15
const usd = micro => Math.round(micro / 10000) / 100

const top = (map, key) => [...map].sort((left, right) => right[1] - left[1]).slice(0, TOP)
  .map(([name, micro]) => ({ [key]: name, usd: usd(micro) }))

/**
 * Reads the folded stacks of `tokprof flame --stack agent,project,origin --value cost`: each line is
 * `<agent>;<project>;<origin> <micro-dollars>`. tokprof reads no store of Pi Durable, so a pi child of Megachat is not
 * in its output. A line of the agent `pi` in the state directory of Megachat, where the store of the pi children is,
 * is left out all the same, so the cost of a pi child cannot count two times.
 *
 * tokprof reads the logs of the whole machine, so only a line in a project of [known] counts. [known] holds the real
 * paths of the projects that Megachat knows. A line counts when its project frame, with `~` as [home], is an absolute
 * path, and that path or its real path is a known project or a directory in one. A group of tokprof, such as
 * `temporary folders`, is no path, so it does not count. A line in doubt does not count. The result gives no cost, no
 * name and no count of the other lines: only `otherWork: 'notShown'` when there is at least one.
 */
export function parseTokprof(text, { home = homedir(), stateDirectory, known = [] } = {}) {
  const agents = new Map()
  const projects = new Map()
  const origins = new Map()
  const counts = new Map()
  let total = 0
  let excluded = 0
  let otherWork = false
  const add = (map, key, value) => map.set(key, (map.get(key) ?? 0) + value)
  const isKnown = path => isAbsolute(path) && [path, directoryKey(path)].some(candidate => known.some(root => isWithin(candidate, root)))
  for (const line of text.split('\n')) {
    const match = /^(.+) (\d+)$/.exec(line.trim())
    if (!match) continue
    const frames = match[1].split(';')
    const micro = Number(match[2])
    const agent = frames[0]
    const project = frames.length > 2 ? frames.slice(1, -1).join(';') : frames[1] ?? ''
    const origin = frames.length > 2 ? frames.at(-1) : 'unknown'
    const path = expandHome(project, home)
    if (agent === 'pi' && stateDirectory && isAbsolute(path) && isWithin(path, stateDirectory)) {
      excluded += micro
      continue
    }
    // One real path for each distinct project frame.
    if (!counts.has(project)) counts.set(project, isKnown(path))
    if (!counts.get(project)) {
      otherWork = true
      continue
    }
    total += micro
    add(agents, agent, micro)
    add(projects, project, micro)
    add(origins, origin, micro)
  }
  return { status: 'ok', usd: usd(total), agents: Object.fromEntries([...agents].map(([name, micro]) => [name, usd(micro)])),
    projects: top(projects, 'project'), origins: top(origins, 'origin'), excludedPiChildUsd: usd(excluded),
    ...(otherWork ? { otherWork: 'notShown' } : {}) }
}

/**
 * The API-equivalent cost of the agent sessions of this machine from the date [since] up to the day before the date
 * [until], from the command `tokprof`. The command comes from `PATH`, else from `~/.local/bin`. It runs with no shell,
 * with [timeoutMs], and it writes its output to a private temporary file, which Megachat reads up to a size limit.
 * Without the command, or after a failure, a timeout or an output that is too large, the result says that this part is
 * missing, and why. [signal] stops the command at the stop of the daemon. The command runs one time, with no
 * `--project`, and only the lines of the [known] projects count (see `parseTokprof`).
 */
export async function readTokprof({ since, until, environment = process.env, home = homedir(), stateDirectory, known = [],
  timeoutMs = TOKPROF_TIMEOUT_MS, signal }) {
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
    return parseTokprof(await readFile(file, 'utf8'), { home, stateDirectory, known })
  }
  finally { await rm(directory, { force: true, recursive: true }) }
}

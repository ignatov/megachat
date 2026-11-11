import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
/** The C locale gives the start time and the CPU load in one format on each machine. */
const ENVIRONMENT = { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
const TIMEOUT_MS = 10000
/** A command line can be long, for example the class path of a Java process. */
const MAX_BUFFER = 64 * 1024 * 1024
/** `ps` writes the column `ucomm` with this width: the length of the executable name that the kernel keeps. */
const NAME_WIDTH = 16
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const LINE = /^\s*(\d+)\s+(\d+)\s+[A-Z][a-z]{2} ([A-Z][a-z]{2})\s+(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})\s+(\d+(?:[.,]\d+)?) (.*)$/

const utf8 = text => Buffer.from(text, 'latin1').toString('utf8')

/**
 * Reads the output of `ps -o pid=,ppid=,lstart=,pcpu=,ucomm=,args=`. Each byte of [output] must be one character, as
 * the encoding `latin1` gives, because `ps` pads the column `ucomm` to 16 bytes and not to 16 characters. A line that
 * does not have this form gives no process.
 */
export function parseProcesses(output) {
  const text = Buffer.isBuffer(output) ? output.toString('latin1') : output
  const processes = []
  for (const line of text.split('\n')) {
    const match = LINE.exec(line)
    if (!match) continue
    const [, pid, ppid, month, day, hours, minutes, seconds, year, cpu, rest] = match
    const startedAt = new Date(Number(year), MONTHS.indexOf(month), Number(day), Number(hours), Number(minutes), Number(seconds)).getTime()
    if (!MONTHS.includes(month) || !Number.isFinite(startedAt)) continue
    // A name of 16 bytes has no space after it, so the space after the column separates the name from the command.
    const padded = rest.length > NAME_WIDTH && rest[NAME_WIDTH] === ' '
    processes.push({
      pid: Number(pid), ppid: Number(ppid), startedAt, cpu: Number(cpu.replace(',', '.')),
      name: utf8(padded ? rest.slice(0, NAME_WIDTH).trimEnd() : rest.length <= NAME_WIDTH ? rest.trimEnd() : ''),
      command: utf8(padded ? rest.slice(NAME_WIDTH + 1) : rest.length <= NAME_WIDTH ? '' : rest),
    })
  }
  return processes
}

/**
 * Reads the output of `lsof -a -d cwd -p <pids> -Fn` into a map from each PID to its working directory. In the C locale,
 * `lsof` writes each byte outside ASCII as `\xNN`, so a name in UTF-8 comes back from these escapes. A process without
 * a name line is not in the map: `lsof` gives no line for a process without permission and for a process that ended.
 */
export function parseWorkingDirectories(output) {
  const directories = new Map()
  let pid
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) pid = /^p(\d+)$/.test(line) ? Number(line.slice(1)) : undefined
    else if (line.startsWith('n') && pid !== undefined && line.length > 1 && !directories.has(pid)) {
      directories.set(pid, utf8(line.slice(1).replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))))
    }
  }
  return directories
}

/**
 * The process table of macOS: one `ps` call for all the processes, and one `lsof` call for the working directories of
 * some PIDs. `lsof` ends with the exit code 1 when it found no line for one PID, so its output still counts then.
 */
function macProcessTable() {
  return {
    platform: 'darwin', supported: true,
    async processes() {
      const { stdout } = await execute('/bin/ps', ['-axww', '-o', 'pid=,ppid=,lstart=,pcpu=,ucomm=,args='],
        { env: ENVIRONMENT, encoding: 'latin1', maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS })
      return parseProcesses(stdout)
    },
    async resolve(pids) {
      if (!pids.length) return new Map()
      let output
      try {
        output = (await execute('/usr/sbin/lsof', ['-w', '-a', '-d', 'cwd', '-p', pids.join(','), '-Fn'],
          { env: ENVIRONMENT, encoding: 'latin1', maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS })).stdout
      }
      catch (error) {
        if (error.code !== 1 || typeof error.stdout !== 'string') throw error
        output = error.stdout
      }
      const directories = parseWorkingDirectories(output)
      return new Map(pids.map(pid => [pid, { cwd: directories.get(pid) ?? null }]))
    },
  }
}

/**
 * The process table of the platform. Each platform has the same interface, so a test gives a fake:
 * - `processes()` gives each process as `{ pid, ppid, startedAt, cpu, name, command }`. `startedAt` is in milliseconds,
 *   `cpu` is the load in percent of one core, `name` is the name of the executable file, and `command` is the command
 *   line. The command line can hold a prompt or a secret, so only `AgentProcesses.mjs` reads it.
 * - `resolve(pids)` gives a map from each PID to `{ cwd }`, in one call for all the PIDs. `cwd` is null when Megachat
 *   cannot read it.
 * On a platform without an implementation, `supported` is false and the table has no process.
 */
export function processTable(platform = process.platform) {
  if (platform === 'darwin') return macProcessTable()
  return { platform, supported: false, processes: async () => [], resolve: async () => new Map() }
}

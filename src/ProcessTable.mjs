import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execute = promisify(execFile)
/** The C locale gives the start time and the CPU load in one format on each machine. */
const ENVIRONMENT = { LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' }
/**
 * In the C locale, `ps` writes each byte outside ASCII of the column `args` in the form of vis(3), such as `M-CM-)` for
 * `é`. The character type `UTF-8` keeps these bytes. The other categories stay C, so `lstart` and `pcpu` keep their
 * format, and the column `ucomm` is the same in both locales. A machine without the locale `UTF-8` gives the C output.
 */
const PS_ENVIRONMENT = { LANG: 'C', LC_CTYPE: 'UTF-8', PATH: ENVIRONMENT.PATH }
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

/** In the C locale, `lsof` writes each byte outside ASCII as `\xNN`, so a name in UTF-8 comes back from these escapes. */
const lsofName = text => utf8(text.replace(/\\x([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16))))

/**
 * Reads the output of `lsof -p <pids> -Ffn` into a map from each PID to `{ cwd, files }`. `cwd` is the working
 * directory, and `files` holds each open file with a numeric descriptor and a name that ends with `.jsonl`: only a
 * session log can link a process to its session, and the other names are of no use here. A process without a `cwd`
 * line has the `cwd` null: `lsof` gives no line for a process without permission and for a process that ended.
 */
export function parseOpenFiles(output) {
  const found = new Map()
  let item
  let descriptor
  for (const line of output.split('\n')) {
    if (line.startsWith('p')) {
      const pid = /^p(\d+)$/.test(line) ? Number(line.slice(1)) : undefined
      item = pid === undefined ? undefined : found.get(pid) ?? { cwd: null, files: [] }
      if (item) found.set(pid, item)
      descriptor = undefined
    }
    else if (line.startsWith('f')) descriptor = line.slice(1)
    else if (line.startsWith('n') && item && line.length > 1) {
      if (descriptor === 'cwd' && item.cwd === null) item.cwd = lsofName(line.slice(1))
      else if (/^\d+$/.test(descriptor ?? '') && line.endsWith('.jsonl')) {
        const name = lsofName(line.slice(1))
        if (!item.files.includes(name)) item.files.push(name)
      }
    }
  }
  return found
}

/**
 * The process table of macOS: one `ps` call for all the processes, and one `lsof` call for the working directories and
 * the open session logs of some PIDs. `lsof` ends with the exit code 1 when it found no line for one PID, so its output
 * still counts then.
 */
function macProcessTable() {
  return {
    platform: 'darwin', supported: true,
    async processes() {
      const { stdout } = await execute('/bin/ps', ['-axww', '-o', 'pid=,ppid=,lstart=,pcpu=,ucomm=,args='],
        { env: PS_ENVIRONMENT, encoding: 'latin1', maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS })
      return parseProcesses(stdout)
    },
    async resolve(pids) {
      if (!pids.length) return new Map()
      let output
      try {
        output = (await execute('/usr/sbin/lsof', ['-w', '-p', pids.join(','), '-Ffn'],
          { env: ENVIRONMENT, encoding: 'latin1', maxBuffer: MAX_BUFFER, timeout: TIMEOUT_MS })).stdout
      }
      catch (error) {
        if (error.code !== 1 || typeof error.stdout !== 'string') throw error
        output = error.stdout
      }
      const found = parseOpenFiles(output)
      return new Map(pids.map(pid => [pid, found.get(pid) ?? { cwd: null, files: [] }]))
    },
  }
}

/**
 * The process table of the platform. Each platform has the same interface, so a test gives a fake:
 * - `processes()` gives each process as `{ pid, ppid, startedAt, cpu, name, command }`. `startedAt` is in milliseconds,
 *   `cpu` is the load in percent of one core, `name` is the name of the executable file, and `command` is the command
 *   line. The command line can hold a prompt or a secret, so only `AgentProcesses.mjs` reads it.
 * - `resolve(pids)` gives a map from each PID to `{ cwd, files }`, in one call for all the PIDs. `cwd` is null when
 *   Megachat cannot read it. `files` holds the open session logs of the process. Codex keeps its log open, so the open
 *   files link a Codex process to its sessions.
 * On a platform without an implementation, `supported` is false and the table has no process.
 */
export function processTable(platform = process.platform) {
  if (platform === 'darwin') return macProcessTable()
  return { platform, supported: false, processes: async () => [], resolve: async () => new Map() }
}

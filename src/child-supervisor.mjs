import { spawn } from 'node:child_process'
import { Socket } from 'node:net'
import { applyFileMask } from './fileMask.mjs'
import { RunProcesses } from './RunProcesses.mjs'

// The daemon is the parent of this process at its start.
const daemon = process.ppid
// The lifetime pipe closes when the daemon exits, including after SIGKILL. It also carries lines: the word `clean` from
// the daemon, and the lines `ended` and `refused` to the daemon. The half-open mode keeps the writes after the end of
// the side of the daemon.
const lifetime = new Socket({ fd: 3, readable: true, writable: true, allowHalfOpen: true })
// The daemon has the mask 077. The agent gets the mask of the user, as in a terminal.
applyFileMask()
const child = spawn(process.argv[2], process.argv.slice(3), {
  stdio: ['pipe', 'pipe', 'pipe'], detached: true,
})
const tell = line => {
  if (lifetime.writable && !lifetime.destroyed) lifetime.write(`${line}\n`)
}
const processes = new RunProcesses({ agentPid: child.pid, daemon, report: (pid, check) => tell(`refused ${pid} ${check}`) })
let words = ''
let lifetimeEnded = false
let ending

const agentExit = new Promise(resolve => child.once('exit', code => resolve(code ?? 1)))
let errorBytes = 0
child.stderr.on('data', chunk => { errorBytes += chunk.length })
const errorEnded = new Promise(resolve => { child.stderr.once('end', resolve); child.stderr.once('close', resolve) })
// The daemon takes the end of the error output of the agent from this line, so the end of the other processes of the
// run does not cut it. The empty write comes after each write of the error output, so the line comes after the bytes.
const reported = Promise.all([agentExit, errorEnded])
  .then(([code]) => new Promise(resolve => process.stderr.write('', () => { tell(`ended ${code} ${errorBytes}`); resolve() })))

/** True when the daemon of the start still runs: the lifetime pipe is open, and the daemon has its PID. */
const daemonRuns = () => {
  if (lifetimeEnded) return false
  try { process.kill(daemon, 0); return true }
  catch (error) { return error.code === 'EPERM' }
}

/**
 * Ends the run once. The end `clean` also ends each process of the run, and only the word `clean` of the daemon or an
 * exit of the agent while the daemon runs gives it. Each other end is the end of before: a stop and a loss of the
 * daemon keep the processes of the run, because a child can restart the daemon from its own shell.
 */
const end = mode => ending ??= (async () => {
  try { await processes.end(mode) }
  catch {}
  const code = await agentExit
  await Promise.race([reported, new Promise(resolve => setTimeout(resolve, 200))])
  const exit = () => process.exit(code)
  lifetime.once('finish', exit)
  lifetime.once('error', exit)
  setTimeout(exit, 200)
  lifetime.end()
})()

// A look a moment later: a lost daemon also ends the input of the agent, and the agent can exit before this process
// reads the end of the lifetime pipe.
const endLater = () => setTimeout(() => end(daemonRuns() ? 'clean' : 'keep'), 50)

child.once('error', () => process.exit(1))
child.once('exit', () => {
  processes.agentExited()
  if (!ending) endLater()
})
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.stdin.on('error', endLater)
// A dead daemon also closes the output pipes. A write to a closed pipe gives an error on the stream. Without a handler,
// that error ends this process before it reads the end of the lifetime pipe, and the child stays alive.
process.stdout.on('error', () => end('keep'))
process.stderr.on('error', () => end('keep'))
lifetime.on('data', chunk => { words = `${words}${chunk}`.slice(-64) })
const lifetimeEnd = () => {
  lifetimeEnded = true
  end(/^clean$/m.test(words) ? 'clean' : 'keep')
}
lifetime.once('end', lifetimeEnd)
lifetime.once('error', lifetimeEnd)
process.once('SIGTERM', () => end('keep'))
process.once('SIGINT', () => end('keep'))
processes.start()

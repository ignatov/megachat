import { spawn } from 'node:child_process'
import { Socket } from 'node:net'

// The private pipe closes when the daemon exits, including after SIGKILL.
const lifetime = new Socket({ fd: 3, readable: true, writable: false })
const child = spawn(process.argv[2], process.argv.slice(3), {
  stdio: ['pipe', 'pipe', 'pipe'], detached: true,
})
const stop = () => {
  if (child.pid && child.exitCode === null && child.signalCode === null) {
    try { process.kill(-child.pid, 'SIGKILL') }
    catch (error) { if (error.code !== 'ESRCH') process.exitCode = 1 }
  }
}
child.once('error', () => process.exit(1))
child.once('exit', code => { lifetime.destroy(); process.exit(code ?? 1) })
process.stdin.pipe(child.stdin)
child.stdout.pipe(process.stdout)
child.stderr.pipe(process.stderr)
child.stdin.on('error', stop)
lifetime.on('data', () => {})
lifetime.once('end', stop)
lifetime.once('error', stop)
process.once('SIGTERM', stop)
process.once('SIGINT', stop)

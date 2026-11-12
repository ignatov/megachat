import { spawn } from 'node:child_process'
import { appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { agent, methods, ndJsonStream } from '@agentclientprotocol/sdk/unstable'

/**
 * Stand-in processes for `test/child-processes.test.mjs`. Each one writes its PID to a file of FAKE_TREE_DIR at its
 * start, so the test selects it only by that PID, and each one ends by itself after at most 61 seconds.
 *
 * - `daemon`: starts the supervisor FAKE_TREE_SUPERVISOR with four pipes, as `AcpRunService` does, with the adapter as
 *   its agent. The message `clean` ends the lifetime pipe with the word `clean`, and `end` ends it without a word.
 * - `adapter`: starts the stand-in of Claude Code in its process group, as the Claude Agent SDK does. With
 *   FAKE_TREE_ADAPTER_EXIT=1 it exits with the code 1 when the stand-in of Claude Code ends.
 * - `claude`: starts the shell of its Bash tool with `detached: true`, as Claude Code does: a session and a process
 *   group of its own.
 * - `acp`: an ACP agent. The prompt `shell` starts a shell and waits for the cancel, `shell-done` starts a shell and
 *   ends with `end_turn`, `shell-crash` starts a shell that ignores SIGTERM and then crashes, `shell-fail` starts a
 *   shell that ignores SIGTERM, writes a reason without a line break and answers with an error, and `shell-stop` starts
 *   the shell `stop`. Each other prompt ends with `end_turn`.
 *
 * FAKE_TREE_SHELL selects the shell: `sleep` (the default), `term` (writes `term` at SIGTERM), `ignore` (ignores
 * SIGTERM), `slow` (ends 500 ms after SIGTERM, and writes `ended` then), or `stop` (writes `stop` after 2.5 seconds, so
 * a read of the record saw it, then `marker` 1 second later, and `term` at SIGTERM).
 */
const SHELLS = {
  sleep: 'sleep 61 & echo $! > sleep.pid; wait',
  term: "trap 'echo term > term; exit 0' TERM; sleep 61 & echo $! > sleep.pid; wait",
  ignore: "trap '' TERM; sleep 61 & echo $! > sleep.pid; wait; wait",
  slow: "trap 'sleep 0.5; echo ended > ended; exit 0' TERM; sleep 61 & echo $! > sleep.pid; wait",
  stop: "trap 'echo term > term; exit 0' TERM; sleep 2.5; echo stop > stop; sleep 1; echo marker > marker",
}
const directory = process.env.FAKE_TREE_DIR
const mode = process.argv[2]
const self = fileURLToPath(import.meta.url)
setTimeout(() => process.exit(0), 60000)
writeFileSync(join(directory, `${mode}.pid`), String(process.pid))

function startShell(kind = process.env.FAKE_TREE_SHELL ?? 'sleep') {
  const shell = spawn('/bin/sh', ['-c', `echo $$ > shell.pid; ${SHELLS[kind]}`], { cwd: directory, detached: true, stdio: 'ignore' })
  shell.unref()
}

if (mode === 'daemon') {
  const supervisor = spawn(process.execPath, [process.env.FAKE_TREE_SUPERVISOR, process.execPath, self, 'adapter'],
    { stdio: ['pipe', 'pipe', 'pipe', 'pipe'], env: process.env })
  writeFileSync(join(directory, 'supervisor.pid'), String(supervisor.pid))
  supervisor.stdout.resume()
  supervisor.stderr.resume()
  supervisor.stdio[3].resume()
  supervisor.stdio[3].on('error', () => {})
  let asked
  process.on('message', word => {
    asked = Date.now()
    supervisor.stdio[3].end(word === 'clean' ? 'clean\n' : undefined)
  })
  supervisor.once('exit', () => process.send({ exitedAfterMs: asked === undefined ? null : Date.now() - asked }))
}
else if (mode === 'adapter') {
  const claude = spawn(process.execPath, [self, 'claude'], { stdio: ['pipe', 'inherit', 'inherit'], env: process.env })
  process.stdin.resume()
  claude.once('exit', () => { if (process.env.FAKE_TREE_ADAPTER_EXIT === '1') process.exit(1) })
}
else if (mode === 'claude') {
  startShell()
  process.stdin.resume()
}
else if (mode === 'acp') {
  appendFileSync(join(directory, 'agents'), `${process.pid} ${Date.now()}\n`)
  let cancel
  agent({ name: 'fake-process-tree' })
    .onRequest(methods.agent.initialize, async () => ({ protocolVersion: 1, agentCapabilities: { loadSession: true, mcpCapabilities: { http: true } }, authMethods: [] }))
    .onRequest(methods.agent.session.new, async () => ({ sessionId: 'tree-session' }))
    .onRequest(methods.agent.session.load, async () => ({}))
    .onNotification(methods.agent.session.cancel, () => cancel?.())
    .onRequest(methods.agent.session.prompt, async ctx => {
      const text = ctx.params.prompt.at(-1).text
      if (text === 'shell' || text === 'shell-stop') {
        startShell(text === 'shell-stop' ? 'stop' : undefined)
        await new Promise(resolve => { cancel = resolve })
        return { stopReason: 'cancelled' }
      }
      if (text === 'shell-done') startShell()
      if (text === 'shell-crash') {
        startShell('ignore')
        // A read of the record sees the shell before the crash.
        await new Promise(resolve => setTimeout(resolve, 2500))
        process.stderr.write('Error: The stand-in agent crashed.\n', () => process.exit(1))
        return new Promise(() => {})
      }
      if (text === 'shell-fail') {
        startShell('ignore')
        await new Promise(resolve => setTimeout(resolve, 2500))
        // The last word of an error output without a line break goes when the daemon reads the output as open.
        await new Promise(resolve => process.stderr.write('Error: The stand-in agent failed', resolve))
        throw new Error('The stand-in turn failed.')
      }
      return { stopReason: 'end_turn' }
    })
    .connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)))
}

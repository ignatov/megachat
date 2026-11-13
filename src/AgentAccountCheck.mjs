import { spawn } from 'node:child_process'
import { Readable, Writable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { client, methods, ndJsonStream, PROTOCOL_VERSION, RequestError } from '@agentclientprotocol/sdk'
import { fileMaskEnvironment } from './fileMask.mjs'
import { megachatVersion } from './MegachatBuild.mjs'
import { MegachatError, message } from './messages.mjs'
import { CHILD_AGENTS } from './Settings.mjs'

export const ACCOUNT_CHECK_TIMEOUT_MS = 30000
const AUTH_REQUIRED = RequestError.authRequired().code
const NAMES = { claude: 'Claude Code', codex: 'Codex' }

/** The result of an agent that failed at [step]. The texts come from the resources, never from the agent. */
const failure = (agent, step, login = 'unknown') => ({ agent, status: 'failed', login, problem: message(`accounts.${step}`, NAMES[agent]),
  fix: message(`accounts.fix.${step}.${agent}`) })

/**
 * Starts [agent] as a child run starts it, and asks for `initialize` and `session/new`. It sends no prompt, so it spends
 * no tokens. An agent that needs a login refuses the session with the ACP error `authRequired`. A session that opens
 * does not prove that the provider accepts the login: only a prompt does. So the result is then `started`, with the
 * login `unknown`. The process closes after the check, also after the time limit.
 */
async function checkAgent(configuration, agent, { cwd, timeoutMs, launch: overrides = {} }) {
  let launch
  try { launch = { ...await configuration.childLaunch(agent), ...overrides } }
  catch (error) { return failure(agent, error instanceof MegachatError && error.code === 'central' ? 'central' : 'start') }
  let step = 'start'
  let timer
  let connection
  const child = spawn(process.execPath, [fileURLToPath(new URL('./child-supervisor.mjs', import.meta.url)),
    launch.command ?? process.execPath, ...launch.args ?? []], {
    cwd: launch.cwd ?? cwd, env: { ...launch.env, ...fileMaskEnvironment() }, stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
  })
  // The output of the agent can hold a secret, so the check reads none of it.
  child.stderr.resume()
  const ended = new Promise(resolve => {
    child.once('error', resolve)
    child.once('exit', resolve)
  })
  try {
    connection = client({ name: 'air-megachat' }).connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout)))
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve('timeout'), timeoutMs) })
    const check = (async () => {
      await connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'air-megachat', version: megachatVersion() }, clientCapabilities: {},
      })
      step = 'session'
      // The check has no project, so Claude loads no settings file. A child loads the project settings.
      await connection.agent.request(methods.agent.session.new, { cwd, mcpServers: [],
        ...(agent === 'claude' ? { _meta: { claudeCode: { options: { model: launch.model, settingSources: [], promptSuggestions: false, maxTurns: 1 } } } } : {}) })
      return 'started'
    })()
    // After the time limit or the end of the process, the close of the connection rejects the open request.
    check.catch(() => {})
    const outcome = await Promise.race([check, timeout, ended.then(() => 'ended')]).catch(error => error)
    if (outcome === 'started') return { agent, status: 'started', login: 'unknown', note: message('accounts.started', NAMES[agent]) }
    if (outcome === 'timeout') return failure(agent, 'timeout')
    if (outcome?.code === AUTH_REQUIRED) return failure(agent, 'login', 'missing')
    return failure(agent, step)
  }
  finally {
    clearTimeout(timer)
    connection?.close()
    if (child.pid && child.exitCode === null && child.signalCode === null) {
      try { child.stdio[3]?.destroy(); child.kill('SIGTERM') }
      catch (error) { if (error.code !== 'ESRCH') throw error }
    }
  }
}

/**
 * Checks each agent in parallel, each one with its own time limit. [configuration] gives the launch of an agent, as for
 * a child run. [cwd] is the directory of the session of the check: the workspace of Megachat, not a project.
 */
export async function checkAccounts(configuration, { cwd, timeoutMs = ACCOUNT_CHECK_TIMEOUT_MS, launch } = {}) {
  return { accounts: await Promise.all(CHILD_AGENTS.map(agent => checkAgent(configuration, agent, { cwd, timeoutMs, launch }))) }
}

import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createModels } from '@earendil-works/pi-ai/models'
import { fauxProvider } from '@earendil-works/pi-ai/providers/faux'
import { MemoryStorage } from '@earendil-works/pi-durable'
import { checkAccounts } from '../src/AgentAccountCheck.mjs'
import { MegachatError, message } from '../src/messages.mjs'
import { PiMegachatService } from '../src/PiMegachatService.mjs'

const FAKE_AGENT = fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))

/** A directory for each agent, so the fake agent of each one writes its files apart. */
async function directories(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-accounts-')))
  t.after(() => rm(root, { force: true, recursive: true, maxRetries: 5 }))
  for (const name of ['claude', 'codex', 'workspace']) await mkdir(join(root, name))
  return root
}

/** A launch of the fake agent in the directory of [agent], with more variables. */
const fake = (root, agent, env = {}) => ({ command: process.execPath, args: [FAKE_AGENT], cwd: join(root, agent), env: { ...process.env, ...env } })

const alive = pid => {
  try { process.kill(pid, 0); return true }
  catch { return false }
}

async function stopped(pid) {
  for (let attempt = 0; attempt < 100 && alive(pid); attempt++) await delay(20)
  return !alive(pid)
}

test('the check reports an agent that starts, an agent without a login, and closes each agent without a prompt', { timeout: 20000 }, async t => {
  const root = await directories(t)
  const configuration = { childLaunch: async agent => agent === 'claude' ? fake(root, 'claude') : fake(root, 'codex', { FAKE_ACP_LOGIN: 'missing' }) }
  const { accounts } = await checkAccounts(configuration, { cwd: join(root, 'workspace') })
  assert.deepEqual(accounts, [
    { agent: 'claude', status: 'started', login: 'unknown', note: message('accounts.started', 'Claude Code') },
    { agent: 'codex', status: 'failed', login: 'missing', problem: message('accounts.login', 'Codex'), fix: message('accounts.fix.login.codex') },
  ])
  // The session of the check got the options of a child, and no prompt went out.
  assert.deepEqual(JSON.parse(await readFile(join(root, 'claude', 'session-request.json'), 'utf8')), { operation: 'new', claudeOptions: true })
  // The check has no project, so it loads no settings file.
  assert.deepEqual(JSON.parse(await readFile(join(root, 'claude', 'claude-options.json'), 'utf8')).settingSources, [])
  assert.ok(!(await readdir(join(root, 'claude'))).includes('dispatches'))
  assert.ok(await stopped(Number(await readFile(join(root, 'claude', 'agent.pid'), 'utf8'))))
})

test('the check reports an agent that does not start, a failed Central configuration, and an agent that does not answer', { timeout: 20000 }, async t => {
  const root = await directories(t)
  const missing = { childLaunch: async agent => agent === 'claude' ? { ...fake(root, 'claude'), command: join(root, 'no-such-agent') }
    : Promise.reject(new MegachatError('central')) }
  assert.deepEqual((await checkAccounts(missing, { cwd: join(root, 'workspace') })).accounts, [
    { agent: 'claude', status: 'failed', login: 'unknown', problem: message('accounts.start', 'Claude Code'), fix: message('accounts.fix.start.claude') },
    { agent: 'codex', status: 'failed', login: 'unknown', problem: message('accounts.central', 'Codex'), fix: message('accounts.fix.central.codex') },
  ])
  // An agent that reads its input and never answers gets the time limit. Both checks run at the same time.
  const silent = { childLaunch: async agent => ({ ...fake(root, agent), args: ['-e', 'process.stdin.resume()'] }) }
  const started = Date.now()
  const { accounts } = await checkAccounts(silent, { cwd: join(root, 'workspace'), timeoutMs: 500 })
  assert.ok(Date.now() - started < 3000)
  assert.deepEqual(accounts.map(account => [account.agent, account.status, account.problem]),
    [['claude', 'failed', message('accounts.timeout', 'Claude Code')], ['codex', 'failed', message('accounts.timeout', 'Codex')]])
})

test('the tool agents_accounts gives the result of the daemon check, and two calls share one check', { timeout: 20000 }, async t => {
  const fakeModel = fauxProvider()
  const models = createModels()
  models.setProvider(fakeModel.provider)
  const model = fakeModel.getModel()
  let checks = 0
  const result = { accounts: [{ agent: 'claude', status: 'started', login: 'unknown' }] }
  const service = await PiMegachatService.open(new MemoryStorage(), models, { provider: model.provider, modelId: model.id }, {},
    { keepAlive: { enabled: false }, accountCheck: async () => { checks++; await delay(50); return result } })
  t.after(() => service.close())
  const tool = service.extension().tools.find(item => item.name === 'agents_accounts')
  const answers = await Promise.all([tool.execute({}), tool.execute({})])
  assert.deepEqual(answers.map(answer => JSON.parse(answer.output[0].text)), [result, result])
  assert.equal(checks, 1)
  await tool.execute({})
  assert.equal(checks, 2)
})

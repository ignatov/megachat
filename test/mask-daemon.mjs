// A test loads this module with `--import` in `NODE_OPTIONS` into `start` and its daemon. Before the daemon publishes its
// connection file, this module runs the account check of the daemon with the fake agent. Each fake agent works in its
// directory in `MEGACHAT_TEST_MASK_AGENTS` and writes its files there with the file mask that it got. The launch of the
// agent gets the environment of the daemon without `NODE_OPTIONS` and `MEGACHAT_UMASK`, as a launch from Central does.
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkAccounts } from '../src/AgentAccountCheck.mjs'
import { DaemonDirectory } from '../src/DaemonDirectory.mjs'

if (process.argv[2] === 'daemon') {
  const root = process.env.MEGACHAT_TEST_MASK_AGENTS
  const publish = DaemonDirectory.prototype.publish
  DaemonDirectory.prototype.publish = async function (...args) {
    const { NODE_OPTIONS, MEGACHAT_UMASK, ...env } = process.env
    const launch = agent => ({ command: process.execPath, args: [fileURLToPath(new URL('./fake-acp.mjs', import.meta.url))],
      cwd: join(root, agent), env })
    const result = await checkAccounts({ childLaunch: async agent => launch(agent) }, { cwd: join(root, 'workspace') })
    await writeFile(join(root, 'accounts.json'), JSON.stringify(result))
    return publish.apply(this, args)
  }
}

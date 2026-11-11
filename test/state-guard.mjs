// `npm test` loads this module with `node --import` before each test file. When a test names no state directory,
// Megachat then uses a temporary home and no legacy directories. So a test cannot reach the conversation of the user
// in `~/.jetbrains/air/megachat`, and it cannot start a migration of earlier state. The command `install` then writes
// a temporary `acp.json`, so a test cannot change `~/.jetbrains/acp.json` of the user.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOME_VARIABLE, LEGACY_VARIABLE } from '../src/MegachatHome.mjs'
import { ACP_CONFIG_VARIABLE } from '../src/MegachatInstall.mjs'

// `defaultStateDirectory` ignores an empty home variable, so an empty value counts as unset.
if (!process.env[HOME_VARIABLE]) {
  const home = mkdtempSync(join(tmpdir(), 'megachat-guard-'))
  process.env[HOME_VARIABLE] = home
  process.once('exit', () => rmSync(home, { recursive: true, force: true }))
}
process.env[LEGACY_VARIABLE] ??= ''
if (!process.env[ACP_CONFIG_VARIABLE]) {
  const directory = mkdtempSync(join(tmpdir(), 'megachat-acp-guard-'))
  process.env[ACP_CONFIG_VARIABLE] = join(directory, 'acp.json')
  process.once('exit', () => rmSync(directory, { recursive: true, force: true }))
}

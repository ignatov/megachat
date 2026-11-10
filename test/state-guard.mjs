// `npm test` loads this module with `node --import` before each test file. When a test names no state directory,
// Megachat then uses a temporary home and no legacy directories. So a test cannot reach the conversation of the user
// in `~/.jetbrains/air/megachat`, and it cannot start a migration of earlier state.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HOME_VARIABLE, LEGACY_VARIABLE } from '../src/MegachatHome.mjs'

// `defaultStateDirectory` ignores an empty home variable, so an empty value counts as unset.
if (!process.env[HOME_VARIABLE]) {
  const home = mkdtempSync(join(tmpdir(), 'megachat-guard-'))
  process.env[HOME_VARIABLE] = home
  process.once('exit', () => rmSync(home, { recursive: true, force: true }))
}
process.env[LEGACY_VARIABLE] ??= ''

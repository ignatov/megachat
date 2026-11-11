import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import manifest from '../package.json' with { type: 'json' }
import { CLAUDE_ACP_VARIABLE, CODEX_ACP_VARIABLE } from './CentralConfigurationService.mjs'
import { sourceBuildId } from './sourceBuildId.mjs'

/**
 * The version of `package.json`. The bundle holds a copy of the file, so the bundle gives the same version.
 * Node.js 24.22.1 and 26.7.0 load this JSON import without a warning. Nobody tested Node.js 22.
 */
export const VERSION = manifest.version

/* global MEGACHAT_BUILD_ID */
/**
 * The id of this build. `build.mjs` defines it for the bundle. A git checkout is `dev`, and an installed copy gets
 * an id from its files.
 */
export const BUILD_ID = typeof MEGACHAT_BUILD_ID === 'string' ? MEGACHAT_BUILD_ID : sourceBuildId(fileURLToPath(new URL('..', import.meta.url)))

/**
 * What a running daemon must match to serve this client: the build and the agent commands that the IDE passed.
 * The daemon reads the commands at its start, so an update of Claude or Codex in the IDE also needs a new daemon.
 */
export function daemonBuild(environment = process.env) {
  const agents = createHash('sha256').update(JSON.stringify([environment[CLAUDE_ACP_VARIABLE] ?? null, environment[CODEX_ACP_VARIABLE] ?? null]))
    .digest('hex').slice(0, 12)
  return `${BUILD_ID}+${agents}`
}

/** The part of a daemon build before the digest of the agent commands. */
const buildId = build => build.slice(0, build.lastIndexOf('+'))

/**
 * Whether a client of [expected] must replace the daemon that reported [actual]. A source checkout keeps a daemon
 * from before the build field, so development does not stop a daemon of an earlier prototype.
 *
 * A replacement stops the work of the daemon. So a client that passes no agent command keeps a daemon of its own
 * build: it has no agents to prefer, and it uses the agents of the daemon. Such a client is a terminal command, or
 * an IDE that passes no commands.
 */
export function needsReplacement(actual, expected, environment = process.env) {
  if (actual === undefined) return !expected.startsWith('dev+')
  if (actual === expected) return false
  const passesCommands = environment[CLAUDE_ACP_VARIABLE] !== undefined || environment[CODEX_ACP_VARIABLE] !== undefined
  return passesCommands || buildId(actual) !== buildId(expected)
}

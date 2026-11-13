import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'

/** Whether [root] is a git checkout: a package root with a `.git` entry. A worktree of git has a `.git` file. */
export function gitCheckout(root) {
  return existsSync(join(root, '.git'))
}

/** The time limit of the git command of [buildVersion], in milliseconds. */
const GIT_TIMEOUT_MS = 2000

/**
 * The version of the build of the package in [root]. A copy without `.git` gives the [version] of `package.json`, and
 * it starts no git command. A git checkout runs one `git describe` with the time limit [GIT_TIMEOUT_MS]:
 * - `0.4.0` at the tag `v0.4.0` with no change of a tracked file;
 * - `0.4.0+3.g1a2b3c4` three commits after that tag, at the commit `1a2b3c4`;
 * - `0.5.0+g1a2b3c4` when the tag `v0.5.0` of the version is not in the history of the commit;
 * - `.dirty` at the end when a tracked file has a change;
 * - `0.4.0+dev` when git fails or gives no answer in time.
 *
 * The suffix is SemVer build metadata, so npm semver reads the value as the version of `package.json`.
 */
export function buildVersion(root, { version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version, environment = process.env } = {}) {
  if (!gitCheckout(root)) return version
  // The variables of an outer git command, such as a hook, point git to another repository. `GIT_OPTIONAL_LOCKS`
  // stops the write of the index, so the command does not hold the lock of a git command of the user.
  const { GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, ...rest } = environment
  const result = spawnSync('git', ['-C', root, 'describe', '--tags', '--long', '--always', '--dirty', '--abbrev=7', '--match', `v${version}`], {
    encoding: 'utf8', timeout: GIT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'], env: { ...rest, GIT_OPTIONAL_LOCKS: '0' },
  })
  // The output is `v0.4.0-3-g1a2b3c4[-dirty]` when the tag is in the history, else `1a2b3c4[-dirty]`.
  const match = result.status === 0 && /^(?:(.+)-(\d+)-g)?([0-9a-f]{7,64})(-dirty)?$/.exec(result.stdout.trim())
  if (!match || (match[1] !== undefined && match[1] !== `v${version}`)) return `${version}+dev`
  const [, , count, commit, dirty] = match
  if (count === '0' && !dirty) return version
  return `${version}+${count === undefined ? '' : `${count}.`}g${commit}${dirty ? '.dirty' : ''}`
}

/**
 * The build id of the package in [root], when it is not the bundle. A git checkout, which is a root with a `.git`
 * entry, gives `dev`, so a pull keeps the running daemon. A copy without `.git`, such as an install of npm, gives the
 * version and a digest of `package.json` and of each file in `bin`, `resources` and `src`. So an update of the copy
 * replaces its daemon at the next start.
 *
 * This module has only `node:` imports, so a test can run it on a temporary copy.
 */
export function sourceBuildId(root) {
  if (gitCheckout(root)) return 'dev'
  const files = ['bin', 'resources', 'src'].flatMap(directory => readdirSync(join(root, directory), { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile()).map(entry => relative(root, join(entry.parentPath, entry.name)).split(sep).join('/')))
  const hash = createHash('sha256')
  for (const file of ['package.json', ...files].sort()) hash.update(file).update('\0').update(readFileSync(join(root, file))).update('\0')
  return `${JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version}-${hash.digest('hex').slice(0, 16)}`
}

// Makes the release of the version in `package.json`: the tag `v<version>` and its GitHub release. The install line
// `npx -y "github:ignatov/megachat#semver:x" install` gives a colleague the release with the highest version.
// Run `npm run release` on a clean `main` that is equal to `origin/main`. `npm run release -- --dry-run` prints the
// release and changes nothing.
import { execFile, spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const execute = promisify(execFile)

/** The parts of a release version `1.2.3`, else `undefined`. The install line does not select a pre-release. */
function versionParts(version) {
  return /^\d+\.\d+\.\d+$/.test(version) ? version.split('.').map(Number) : undefined
}

function higher(left, right) {
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return left[index] > right[index]
  return false
}

/**
 * Reads what the release of the checkout [root] holds: the version, the tag, the tag of the last release, and the
 * notes. The notes are the subjects of the commits since the last release, because each subject states a new
 * behavior. This throws when the checkout cannot give a release: the reason is the message of the error.
 */
export async function releasePlan(root) {
  const git = async (...args) => (await execute('git', args, { cwd: root, maxBuffer: 16 * 1024 * 1024 })).stdout.trim()
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const parts = versionParts(version)
  if (!parts) throw new Error(`The version ${version} of package.json is not a release version such as 1.2.3.`)
  if (await git('status', '--porcelain') !== '') throw new Error('The checkout has changes. Commit them or remove them.')
  const branch = await git('rev-parse', '--abbrev-ref', 'HEAD')
  if (branch !== 'main') throw new Error(`The branch is ${branch}. A release comes from main.`)
  await git('fetch', '--quiet', '--tags', 'origin', 'main')
  if (await git('rev-parse', 'HEAD') !== await git('rev-parse', 'FETCH_HEAD')) {
    throw new Error('main is not equal to origin/main. Push or pull, then run the release again.')
  }
  const tag = `v${version}`
  const releases = (await git('tag', '--list', 'v*')).split('\n').filter(Boolean)
    .map(name => ({ name, parts: versionParts(name.slice(1)) })).filter(item => item.parts)
  if (releases.some(item => item.name === tag)) throw new Error(`The tag ${tag} exists. Set a higher version in package.json.`)
  const previous = releases.reduce((last, item) => !last || higher(item.parts, last.parts) ? item : last, undefined)
  // The install line takes the highest version, so a lower version would never reach a colleague.
  if (previous && !higher(parts, previous.parts)) {
    throw new Error(`The version ${version} is not higher than the last release ${previous.name}. Set a higher version in package.json.`)
  }
  const subjects = await git('log', '--reverse', '--format=- %s', previous ? `${previous.name}..HEAD` : 'HEAD')
  return { version, tag, previous: previous?.name, notes: `${subjects}\n` }
}

async function run(command, args, root, input) {
  const child = spawn(command, args, { cwd: root, stdio: [input === undefined ? 'ignore' : 'pipe', 'inherit', 'inherit'] })
  child.stdin?.end(input)
  const [code] = await once(child, 'exit')
  if (code !== 0) throw new Error(`${command} ${args.join(' ')} failed with the exit code ${code}.`)
}

/**
 * The commands of the release [plan], in their order, as `[command, args, input]`. The build comes before the tests:
 * `npm test` tests the bundle in `out/bundle/`, and that bundle can come from an earlier version.
 */
export function releaseSteps(plan) {
  return [
    ['npm', ['run', 'build']],
    ['npm', ['test']],
    ['npm', ['run', 'test:package']],
    ['git', ['tag', '--annotate', plan.tag, '--message', `Megachat ${plan.version}`]],
    ['git', ['push', 'origin', plan.tag]],
    ['gh', ['release', 'create', plan.tag, '--verify-tag', '--title', `Megachat ${plan.version}`, '--notes-file', '-'], plan.notes],
  ]
}

async function main() {
  const root = dirname(fileURLToPath(import.meta.url))
  const dryRun = process.argv.includes('--dry-run')
  const plan = await releasePlan(root)
  console.log(`[megachat] The release ${plan.tag}${plan.previous ? `, after ${plan.previous}` : ''}:\n${plan.notes}`)
  if (dryRun) return
  for (const [command, args, input] of releaseSteps(plan)) await run(command, args, root, input)
  console.log(`[megachat] Released ${plan.tag}`)
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { await main() }
  catch (error) {
    console.error(`[megachat] ${error.message}`)
    process.exitCode = 1
  }
}

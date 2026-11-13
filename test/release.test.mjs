import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'
import { releasePlan, releaseSteps } from '../release.mjs'

const execute = promisify(execFile)

/** A checkout on `main` with one pushed commit of the version 0.2.0, and its remote repository. */
async function checkout(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'megachat-release-')))
  t.after(() => rm(directory, { force: true, recursive: true }))
  const root = join(directory, 'checkout')
  // The test must not read the Git configuration of the user: a signing rule or a hook path would change the result.
  const env = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' }
  const git = async (...args) => (await execute('git', args, { cwd: root, env })).stdout.trim()
  const version = async (value, subject) => {
    await writeFile(join(root, 'package.json'), `${JSON.stringify({ name: 'megachat', version: value })}\n`)
    await git('add', 'package.json')
    await git('commit', '--quiet', '--message', subject)
  }
  await execute('git', ['init', '--quiet', '--bare', '--initial-branch=main', join(directory, 'remote.git')], { env })
  await execute('git', ['init', '--quiet', '--initial-branch=main', root], { env })
  await git('remote', 'add', 'origin', join(directory, 'remote.git'))
  await version('0.2.0', 'The first behavior')
  await git('push', '--quiet', 'origin', 'main')
  return { root, git, version }
}

test('a clean main that is equal to origin/main gives the tag of the version and the subjects since the last release', async t => {
  const { root, git, version } = await checkout(t)
  assert.deepEqual(await releasePlan(root), { version: '0.2.0', tag: 'v0.2.0', previous: undefined, notes: '- The first behavior\n' })

  await git('tag', 'v0.2.0')
  await git('tag', 'v0.10.0-rc.1')
  await git('tag', 'vision')
  await git('push', '--quiet', 'origin', 'v0.2.0')
  await assert.rejects(releasePlan(root), /The tag v0\.2\.0 exists\./)

  await writeFile(join(root, 'notes.txt'), 'A change\n')
  await git('add', 'notes.txt')
  await git('commit', '--quiet', '--message', 'The second behavior')
  await version('0.10.0', 'The third behavior')
  await git('push', '--quiet', 'origin', 'main')
  // 0.10.0 is higher than 0.2.0 as a version, not as a text. A pre-release tag and another tag are not releases.
  assert.deepEqual(await releasePlan(root), { version: '0.10.0', tag: 'v0.10.0', previous: 'v0.2.0', notes: '- The second behavior\n- The third behavior\n' })
})

test('a release finds a tag that only the remote repository has', async t => {
  const { root, git } = await checkout(t)
  await git('tag', 'v0.2.0')
  await git('push', '--quiet', 'origin', 'v0.2.0')
  await git('tag', '--delete', 'v0.2.0')
  await assert.rejects(releasePlan(root), /The tag v0\.2\.0 exists\./)
})

test('a checkout that cannot give a release gets the reason', async t => {
  const { root, git, version } = await checkout(t)
  await writeFile(join(root, 'draft.txt'), 'A draft\n')
  await assert.rejects(releasePlan(root), /The checkout has changes\./)
  await rm(join(root, 'draft.txt'))

  await git('tag', 'v0.3.0')
  await version('0.2.5', 'A lower version')
  await assert.rejects(releasePlan(root), /main is not equal to origin\/main\./)
  await git('push', '--quiet', 'origin', 'main')
  await assert.rejects(releasePlan(root), /The version 0\.2\.5 is not higher than the last release v0\.3\.0\./)

  await version('0.4.0-rc.1', 'A pre-release version')
  await assert.rejects(releasePlan(root), /The version 0\.4\.0-rc\.1 of package\.json is not a release version/)

  await version('0.4.0', 'A release version')
  await git('push', '--quiet', 'origin', 'main')
  await git('checkout', '--quiet', '-b', 'topic')
  await assert.rejects(releasePlan(root), /The branch is topic\./)
})

test('the release builds the bundle before the tests, and makes the tag only after the tests', () => {
  const steps = releaseSteps({ version: '0.2.1', tag: 'v0.2.1', notes: '- The first behavior\n' })
  assert.deepEqual(steps.map(([command, args]) => [command, ...args].slice(0, 3).join(' ')),
    ['npm run build', 'npm test', 'npm run test:package', 'git tag --annotate', 'git push origin', 'gh release create'])
  assert.equal(steps.at(-1)[2], '- The first behavior\n')
  // The asset of the setup script is the last argument of gh release create, and the file is in the checkout.
  assert.equal(steps.at(-1)[1].at(-1), 'setup.sh')
  assert.ok(existsSync(fileURLToPath(new URL('../setup.sh', import.meta.url))))
})

test('the release command of this repository names the install line of the documents', async () => {
  const read = path => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const line = 'npx -y "github:ignatov/megachat#semver:x" install'
  for (const path of ['../README.md', '../openspec/specs/install/spec.md', '../release.mjs', '../setup.sh']) assert.ok((await read(path)).includes(line), path)
})

test('the release command and the setup script name the setup line of the documents', async () => {
  const read = path => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
  const line = 'curl -fsSL https://github.com/ignatov/megachat/releases/latest/download/setup.sh | bash'
  for (const path of ['../README.md', '../release.mjs', '../setup.sh']) assert.ok((await read(path)).includes(line), path)
})

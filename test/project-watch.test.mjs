import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ProjectWatchService, projectSourcePath } from '../src/ProjectWatchService.mjs'

test('project event paths exclude generated files and paths outside the workspace', () => {
  for (const path of ['src/Main.kt', 'package.json', 'AGENTS.md', 'BUILD.bazel', 'frontend/app.tsx']) {
    assert.equal(projectSourcePath(path), path)
  }
  for (const path of ['out/generated.kt', '.git/config', 'node_modules/package/index.js', 'src/main.class',
    '../other/Main.kt', '/other/Main.kt', 'bazel-out/generated.kt', '.idea/workspace.xml', null]) {
    assert.equal(projectSourcePath(path), null)
  }
})

test('the daemon observes a saved source file without an IDE', { timeout: 10000 }, async t => {
  const cwd = await mkdtemp(join(tmpdir(), 'megachat-watch-'))
  await mkdir(join(cwd, 'src'))
  await mkdir(join(cwd, 'out'))
  const changed = Promise.withResolvers()
  const service = new ProjectWatchService(new WatchedProjectState(cwd, changed), { debounceMs: 20 })
  t.after(async () => { await service.close(); await rm(cwd, { force: true, recursive: true }) })
  await service.start()
  await writeFile(join(cwd, 'out', 'generated.kt'), 'generated')
  await writeFile(join(cwd, 'src', 'Main.kt'), 'fun main() {}')
  const event = await changed.promise
  assert.equal(event.cwd, cwd)
  assert.deepEqual(event.paths, ['src/Main.kt'])
  assert.ok(event.revision)
})

class WatchedProjectState {
  constructor(cwd, changed) { this.cwd = cwd; this.changed = changed }
  async watch() { return { value: { workspaces: [this.cwd] }, start() {}, async stop() {} } }
  async projectChanged(event) { this.changed.resolve(event) }
}

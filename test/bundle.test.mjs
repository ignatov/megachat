import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import manifest from '../package.json' with { type: 'json' }
import { megachatVersion } from '../src/MegachatBuild.mjs'
import { stopDaemon } from './stop-daemon.mjs'

const bundle = fileURLToPath(new URL('../out/bundle/dist/megachat.mjs', import.meta.url))

/** Sends one JSON-RPC request to `megachat.mjs acp` and returns the first response. */
async function request(directory, body) {
  const child = spawn(process.execPath, [bundle, 'acp', directory], { stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, MEGACHAT_LEGACY_DIRS: '' } })
  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdin.write(`${JSON.stringify(body)}\n`)
  try {
    return await new Promise((resolve, reject) => {
      let buffer = ''
      const timer = setTimeout(() => reject(new Error(`No answer: ${stderr}`)), 30000)
      child.stdout.on('data', chunk => {
        buffer += chunk
        const end = buffer.indexOf('\n')
        if (end >= 0) { clearTimeout(timer); resolve(JSON.parse(buffer.slice(0, end))) }
      })
      child.once('exit', code => { clearTimeout(timer); reject(new Error(`Exited ${code}: ${stderr}`)) })
    })
  }
  finally { child.kill() }
}

test('the bundle answers ACP initialize and its daemon reports the build', { skip: !existsSync(bundle) && 'run npm run build' }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'megachat-bundle-'))
  t.after(async () => {
    try { await stopDaemon(join(directory, 'state')) }
    finally { await rm(directory, { recursive: true, force: true }) }
  })
  const response = await request(join(directory, 'state'), {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} },
  })
  assert.equal(response.id, 1)
  assert.equal(response.error, undefined, JSON.stringify(response.error))
  assert.equal(typeof response.result.protocolVersion, 'number')
  // `npm run test:bundle` builds the bundle first, so the bundle gives the version of this checkout. In `npm test`, the
  // bundle can come from an earlier commit or an earlier change of a file, so the test checks the version of
  // `package.json` and the form of the build metadata.
  const { version } = response.result.agentInfo
  if (process.env.npm_lifecycle_event === 'test:bundle') assert.equal(version, megachatVersion())
  else assert.match(version, new RegExp(`^${manifest.version.replaceAll('.', '\\.')}(\\+(dev|(\\d+\\.)?g[0-9a-f]{7,}(\\.dirty)?))?$`))
  const descriptor = JSON.parse(await readFile(join(directory, 'state', 'daemon', 'connection.json'), 'utf8'))
  const build = (await readFile(new URL('../out/bundle/build-id.txt', import.meta.url), 'utf8')).trim()
  assert.ok(descriptor.build.startsWith(`${build}+`), descriptor.build)
})

test('the bundle holds no agent and no platform binary of an agent', { skip: !existsSync(bundle) && 'run npm run build' }, async () => {
  const output = fileURLToPath(new URL('../out/bundle/', import.meta.url))
  const entries = await readdir(output, { withFileTypes: true, recursive: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name))
  for (const file of files) {
    assert.doesNotMatch(relative(output, file), /@openai[\\/]codex|claude-agent-sdk-|claude-agent-acp|codex-acp/, file)
  }
  // esbuild puts a bundled package into dist, so the text of dist must not hold the code of an agent either.
  for (const file of files.filter(item => item.endsWith('.mjs') || item.endsWith('.js'))) {
    const text = await readFile(file, 'utf8')
    for (const code of ['useBundledClaudeCli', 'PLATFORM_PACKAGE_BY_TARGET', 'codex-acp login --client-name']) {
      assert.ok(!text.includes(code), `${relative(output, file)} holds ${code}`)
    }
  }
})

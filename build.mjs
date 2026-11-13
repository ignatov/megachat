// Bundles Megachat into `out/bundle/`: `dist/`, `resources/`, `bin/`, `build-id.txt` and `THIRD_PARTY_NOTICES.txt`.
// Run `npm run build` after a change of `src`, `bin`, `resources` or the dependencies. Do not commit the output.
import { createHash } from 'node:crypto'
import { chmod, cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { buildVersion } from './src/sourceBuildId.mjs'

const root = dirname(fileURLToPath(import.meta.url))
const output = join(root, 'out', 'bundle')

// The agents and their platform binaries come from the agents that Air installs. Megachat never bundles them.
// `esbuild` is an optional peer of chord's build plugins, which Megachat does not use.
const external = [
  '@anthropic-ai/claude-agent-sdk-*', '@openai/codex', '@openai/codex-*',
  '@agentclientprotocol/claude-agent-acp', '@agentclientprotocol/codex-acp', 'esbuild',
]

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true })
  return entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()
}

/** The build id changes with every input, so the IDE extracts a new copy and replaces a daemon of an older build. */
async function buildId() {
  const hash = createHash('sha256')
  const inputs = [...await files(join(root, 'src')), ...await files(join(root, 'bin')), ...await files(join(root, 'resources')),
    join(root, 'package-lock.json'), fileURLToPath(import.meta.url)]
  for (const file of inputs) hash.update(relative(root, file)).update('\0').update(await readFile(file)).update('\0')
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  return `${version}-${hash.digest('hex').slice(0, 16)}`
}

/** The package directory under `node_modules` that holds [input], or `undefined` for Megachat's own sources. */
function packageDirectory(input) {
  const parts = input.split('/')
  const index = parts.lastIndexOf('node_modules')
  if (index < 0) return undefined
  const length = parts[index + 1].startsWith('@') ? 2 : 1
  return join(root, ...parts.slice(0, index + 1 + length))
}

async function licenseText(directory) {
  const names = (await readdir(directory)).filter(name => /^(licen[cs]e|copying|notice)(\.|$)/i.test(name)).sort()
  return (await Promise.all(names.map(name => readFile(join(directory, name), 'utf8')))).join('\n')
}

/** Lists every npm package that the bundle contains, with its license and its license text. */
async function notices(metafile) {
  const directories = new Set()
  for (const input of Object.keys(metafile.inputs)) {
    const directory = packageDirectory(input.split(sep).join('/'))
    if (directory) directories.add(directory)
  }
  const packages = []
  for (const directory of directories) {
    const manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'))
    const license = typeof manifest.license === 'string' ? manifest.license : manifest.license?.type ?? 'UNKNOWN'
    packages.push({ name: manifest.name, version: manifest.version, license, homepage: manifest.homepage ?? manifest.repository?.url ?? manifest.repository,
      text: await licenseText(directory) })
  }
  packages.sort((left, right) => left.name.localeCompare(right.name))
  const unknown = packages.filter(item => item.license === 'UNKNOWN' && !item.text)
  if (unknown.length) throw new Error(`No license for bundled packages: ${unknown.map(item => item.name).join(', ')}`)
  const header = 'Megachat bundles the following npm packages. Each package keeps its own license.\n\n'
    + packages.map(item => `- ${item.name} ${item.version} (${item.license})`).join('\n') + '\n'
  const bodies = packages.map(item => [
    '-'.repeat(78), `${item.name} ${item.version}`, `License: ${item.license}`, ...(item.homepage ? [`Homepage: ${item.homepage}`] : []), '',
    item.text.trim() || `Licensed under ${item.license}. The package ships no license file.`,
  ].join('\n'))
  return { packages, text: `${header}\n${bodies.join('\n\n')}\n` }
}

const id = await buildId()
// The bundle has no `.git`, so it gets the version of this checkout at the time of the build.
const version = buildVersion(root)
await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
const result = await build({
  absWorkingDir: root,
  entryPoints: { megachat: 'src/main.mjs', 'child-supervisor': 'src/child-supervisor.mjs' },
  outdir: join(output, 'dist'),
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: ['node22'],
  external,
  define: { MEGACHAT_BUILD_ID: JSON.stringify(id), MEGACHAT_VERSION: JSON.stringify(version) },
  // Bundled CommonJS packages call `require` for Node built-ins. esbuild keeps the `#!/usr/bin/env node` line of
  // `src/main.mjs` as line 1 of `dist/megachat.mjs`, and the banner follows it.
  banner: { js: "import { createRequire as __megachatCreateRequire } from 'node:module'; const require = __megachatCreateRequire(import.meta.url);" },
  metafile: true,
  minify: true,
  legalComments: 'none',
  charset: 'utf8',
  logLevel: 'warning',
})
// The bundle reads `../resources` and runs `../bin` exactly as `src` does. The launcher `bin/megachat.mjs` imports
// `../src`, which the bundle does not hold, so the bundle does not get it.
const launcher = join(root, 'bin', 'megachat.mjs')
await cp(join(root, 'resources'), join(output, 'resources'), { recursive: true })
await cp(join(root, 'bin'), join(output, 'bin'), { recursive: true, filter: source => source !== launcher })
for (const file of await files(join(output, 'bin'))) await chmod(file, 0o755)
const { packages, text } = await notices(result.metafile)
await writeFile(join(output, 'THIRD_PARTY_NOTICES.txt'), text)
await writeFile(join(output, 'build-id.txt'), `${id}\n`)
if (!existsSync(join(output, 'dist', 'megachat.mjs'))) throw new Error('The bundle is missing')
console.log(`[megachat] Built ${id} (version ${version}) into ${relative(root, output)} with ${packages.length} bundled packages`)

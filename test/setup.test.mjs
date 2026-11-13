// The setup script `setup.sh` with a temporary HOME and fake commands. The PATH of the script has only the fake
// commands and links to a few tools of the system, so the script reaches no network, no real Central, no real npx and
// no file of the user. The test leaves its temporary directories.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const SCRIPT = fileURLToPath(new URL('../setup.sh', import.meta.url))
const NODE_VERSION = '24.22.3'
const SECRET = 'secret-key-of-the-test'
const GOOD_HASH = 'a'.repeat(64)
/** The tools of the system that the script and the fake commands use. */
const SYSTEM_TOOLS = ['bash', 'tar', 'gzip', 'grep', 'awk', 'mktemp', 'cat', 'cp', 'mkdir', 'chmod', 'dirname', 'touch', 'env', 'tr']

async function executable(path, text) {
  await writeFile(path, text)
  await chmod(path, 0o755)
}

/** Each fake command appends its name and its arguments to the log of the test. */
const logLine = name => `printf '%s\\n' "${name} $*" >>"$FAKE_LOG"\n`

const FAKE_CENTRAL = `#!/bin/bash
${logLine('central')}state="$HOME/.fake-central"
case "$1" in
  status)
    printf 'Version  2.5.0\\n'
    if [ -f "$state/login" ]; then printf 'Auth  JetBrains Team\\n'; else printf 'Auth  not connected\\n'; fi
    printf 'Proxy  http://127.0.0.1:4100/wire/${SECRET}/pi/anthropic\\n' ;;
  login)
    IFS= read -r input || input=''
    printf 'central login read %s\\n' "$input" >>"$FAKE_LOG"
    printf 'Open the address in a browser.\\n'
    if [ -z "\${FAKE_LOGIN_FAILS:-}" ]; then mkdir -p "$state"; touch "$state/login"; fi ;;
  add)
    if [ ! -f "$state/login" ]; then echo "not logged in — run 'central login' first"; exit 1; fi
    if [ -n "\${FAKE_ADD_CODE:-}" ]; then echo "http://127.0.0.1:4100/wire/${SECRET}/claude-code/anthropic"; exit "$FAKE_ADD_CODE"; fi
    mkdir -p "$HOME/.claude"
    printf '{\\n  "apiKeyHelper": "central proxy start --ensure-updated --caller agent --return-key",\\n  "env": {\\n    "ANTHROPIC_BASE_URL": "http://127.0.0.1:4100/wire/${SECRET}/claude-code/anthropic"\\n  }\\n}\\n' >"$HOME/.claude/settings.json"
    echo "Claude Code uses http://127.0.0.1:4100/wire/${SECRET}/claude-code/anthropic" ;;
esac
`

/** The fake npx writes its path, the node of its PATH and the content of acp.json at its start to the log. */
const FAKE_NPX = `#!/bin/bash
${logLine('npx')}printf 'npx-path %s\\n' "$0" >>"$FAKE_LOG"
printf 'npx-node %s\\n' "$(command -v node)" >>"$FAKE_LOG"
printf 'npx-acp %s\\n' "$(cat "$MEGACHAT_ACP_CONFIG" 2>/dev/null | tr -d '\\n')" >>"$FAKE_LOG"
echo "[megachat] The output of the install line."
exit "\${FAKE_NPX_CODE:-0}"
`

const fakeNode = version => `#!/bin/bash\n${logLine('node')}echo v${version}\n`

/**
 * A Mac of the test. [node] is the version of the `node` on the PATH, or undefined for no node. [central] puts the
 * fake Central at ~/.local/bin/central, [login] gives it a login, [claudeEntry] writes its entry of Claude Code, and
 * [acp] is the content of acp.json, or undefined for no file. [installerWorks] makes the installer of Central install
 * the fake Central. [hash] is the hash of the archives in SHASUMS256.txt.
 */
async function machine(t, { node, central = false, login = false, claudeEntry = false, acp, installerWorks = true, hash = GOOD_HASH } = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'megachat-setup-')))
  const home = join(root, 'home')
  const fake = join(root, 'fake-bin')
  const system = join(root, 'system-bin')
  const files = join(root, 'files')
  for (const directory of [home, fake, system, files, join(root, 'tmp'), join(files, 'nodejs')]) await mkdir(directory, { recursive: true })
  for (const tool of SYSTEM_TOOLS) {
    const path = ['/usr/bin', '/bin'].map(directory => join(directory, tool)).find(candidate => existsSync(candidate))
    if (path) await symlink(path, join(system, tool))
  }
  await executable(join(fake, 'uname'), `#!/bin/bash\n${logLine('uname')}case "$1" in -m) echo "\${FAKE_UNAME_M:-arm64}" ;; *) echo "\${FAKE_UNAME_S:-Darwin}" ;; esac\n`)
  await executable(join(fake, 'git'), `#!/bin/bash\n${logLine('git')}[ -n "\${FAKE_GIT_FAILS:-}" ] && exit 1\necho 'git version 2.50.1'\n`)
  await executable(join(fake, 'xcode-select'), `#!/bin/bash\n${logLine('xcode-select')}`)
  await executable(join(fake, 'shasum'), `#!/bin/bash\n${logLine('shasum')}printf '%s  %s\\n' '${GOOD_HASH}' "$3"\n`)
  // The fake curl gives the files of the test for nodejs.org and the installer of Central, and fails for each other address.
  await executable(join(fake, 'curl'), `#!/bin/bash
${logLine('curl')}output=''
while [ $# -gt 1 ]; do
  case "$1" in -o) output="$2"; shift 2 ;; *) shift ;; esac
done
case "$1" in
  https://nodejs.org/dist/v${NODE_VERSION}/*) source="${files}/nodejs/\${1##*/}" ;;
  https://central-cli.labs.jb.gg/install.sh) source="${files}/central-install.sh" ;;
  *) exit 6 ;;
esac
[ -f "$source" ] || exit 22
if [ -n "$output" ]; then cp "$source" "$output"; else cat "$source"; fi
`)
  await writeFile(join(files, 'central.sh'), FAKE_CENTRAL)
  await writeFile(join(files, 'central-install.sh'), installerWorks
    ? `${logLine('installer-of-central')}mkdir -p "$HOME/.local/bin"\ncp "${join(files, 'central.sh')}" "$HOME/.local/bin/central"\nchmod 755 "$HOME/.local/bin/central"\n`
    : `${logLine('installer-of-central')}echo 'The installer failed.'\n`)
  // The archives of Node.js hold a fake node and a fake npx.
  const sums = []
  for (const architecture of ['arm64', 'x64']) {
    const name = `node-v${NODE_VERSION}-darwin-${architecture}`
    const bin = join(root, 'archives', name, 'bin')
    await mkdir(bin, { recursive: true })
    await executable(join(bin, 'node'), fakeNode(NODE_VERSION))
    await executable(join(bin, 'npx'), FAKE_NPX)
    await execute('tar', ['-czf', join(files, 'nodejs', `${name}.tar.gz`), '-C', join(root, 'archives'), name])
    sums.push(`${hash}  ${name}.tar.gz`, `${'c'.repeat(64)}  ${name}.tar.xz`)
  }
  await writeFile(join(files, 'nodejs', 'SHASUMS256.txt'), `${sums.join('\n')}\n`)
  if (node) {
    await executable(join(fake, 'node'), fakeNode(node))
    await executable(join(fake, 'npx'), FAKE_NPX)
  }
  if (central) {
    await mkdir(join(home, '.local', 'bin'), { recursive: true })
    await executable(join(home, '.local', 'bin', 'central'), FAKE_CENTRAL)
  }
  if (login) {
    await mkdir(join(home, '.fake-central'), { recursive: true })
    await writeFile(join(home, '.fake-central', 'login'), '')
  }
  if (claudeEntry) {
    await mkdir(join(home, '.claude'), { recursive: true })
    await writeFile(join(home, '.claude', 'settings.json'), `{"apiKeyHelper":"central proxy start --return-key","env":{"ANTHROPIC_BASE_URL":"http://127.0.0.1:4100/wire/${SECRET}/"}}\n`)
  }
  const acpConfig = join(root, 'acp', 'acp.json')
  await mkdir(join(root, 'acp'))
  if (acp !== undefined) await writeFile(acpConfig, acp)
  const tty = join(root, 'tty')
  await writeFile(tty, 'terminal input\n')
  const log = join(root, 'commands.log')
  await writeFile(log, '')
  const env = { HOME: home, PATH: `${fake}:${system}`, TMPDIR: join(root, 'tmp'), MEGACHAT_ACP_CONFIG: acpConfig, MEGACHAT_SETUP_TTY: tty, FAKE_LOG: log }
  return { root, home, acpConfig, log, env }
}

/** Runs the script as `curl | bash` does: bash reads the script from its standard input. */
async function setup(mac, variables = {}) {
  await writeFile(mac.log, '')
  const child = spawn('/bin/bash', [], { cwd: mac.root, env: { ...mac.env, ...variables }, stdio: ['pipe', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  child.stdin.end(await readFile(SCRIPT))
  const code = await new Promise(resolve => child.on('close', resolve))
  const commands = (await readFile(mac.log, 'utf8')).split('\n').filter(Boolean)
  return { code, output, commands }
}

const ran = (commands, prefix) => commands.filter(line => line.startsWith(prefix))

/** The files under [directory] with their content, so that two runs can be compared. */
async function snapshot(directory) {
  const result = {}
  for (const entry of await readdir(directory, { recursive: true, withFileTypes: true })) {
    const path = join(entry.parentPath, entry.name)
    if (entry.isFile()) result[path] = await readFile(path, 'utf8')
  }
  return result
}

test('a ready machine runs only the checks and the install line, also in a second run', async t => {
  const mac = await machine(t, { node: '22.19.0', central: true, login: true, claudeEntry: true, acp: '{"agent_servers":{}}\n' })
  const before = await snapshot(mac.root)
  for (const run of [1, 2]) {
    const { code, output, commands } = await setup(mac)
    assert.equal(code, 0, `${run}: ${output}`)
    assert.deepEqual(ran(commands, 'curl'), [], `${run}`)
    assert.deepEqual(ran(commands, 'central').filter(line => line !== 'central status'), [], `${run}`)
    assert.deepEqual(ran(commands, 'npx '), ['npx -y github:ignatov/megachat#semver:x install'])
    assert.ok(ran(commands, 'npx-path ')[0].endsWith('/fake-bin/npx'))
    assert.match(output, /Node\.js v22\.19\.0 from the PATH/)
    assert.match(output, /The output of the install line\./)
    assert.match(output, /select Megachat in the agent list of Air/)
    assert.match(output, /30 to 100 seconds/)
    assert.doesNotMatch(output, /restart the IDE/i)
    assert.ok(!output.includes(SECRET))
  }
  delete before[mac.log]
  const after = await snapshot(mac.root)
  delete after[mac.log]
  assert.deepEqual(after, before)
})

test('an empty Mac gets Node.js, Central, the login and the Claude key, and a second run changes nothing', async t => {
  const mac = await machine(t, { node: '22.18.0', acp: '\n   \n' })
  const first = await setup(mac)
  assert.equal(first.code, 0, first.output)
  const curls = ran(first.commands, 'curl').map(line => line.split(' ').at(-1))
  assert.deepEqual(curls, [`https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    `https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, 'https://central-cli.labs.jb.gg/install.sh'])
  assert.match(ran(first.commands, 'shasum')[0], new RegExp(`^shasum -a 256 ${mac.root}/tmp/megachat-node\\.\\w+/node-v${NODE_VERSION}-darwin-arm64\\.tar\\.gz$`))
  assert.deepEqual(ran(first.commands, 'installer-of-central'), ['installer-of-central '])
  assert.deepEqual(ran(first.commands, 'central').filter(line => !line.startsWith('installer-of-central')),
    ['central status', 'central login', 'central login read terminal input', 'central status', 'central add claude-code'])
  const downloaded = `/megachat-node\\.\\w+/node-v${NODE_VERSION}-darwin-arm64/bin/`
  assert.match(ran(first.commands, 'npx-path ')[0], new RegExp(`${downloaded}npx$`))
  assert.match(ran(first.commands, 'npx-node ')[0], new RegExp(`${downloaded}node$`))
  assert.deepEqual(ran(first.commands, 'npx-acp '), ['npx-acp {}'])
  assert.equal(await readFile(mac.acpConfig, 'utf8'), '{}\n')
  assert.match(await readFile(join(mac.home, '.claude', 'settings.json'), 'utf8'), /"apiKeyHelper": "central proxy start/)
  assert.ok(!first.output.includes(SECRET), first.output)
  assert.match(first.output, /select Megachat in the agent list of Air/)

  const settings = await readFile(join(mac.home, '.claude', 'settings.json'), 'utf8')
  const second = await setup(mac)
  assert.equal(second.code, 0, second.output)
  assert.deepEqual(ran(second.commands, 'installer-of-central'), [])
  assert.deepEqual(ran(second.commands, 'central'), ['central status'])
  assert.deepEqual(ran(second.commands, 'npx '), ['npx -y github:ignatov/megachat#semver:x install'])
  assert.equal(await readFile(join(mac.home, '.claude', 'settings.json'), 'utf8'), settings)
  assert.equal(await readFile(mac.acpConfig, 'utf8'), '{}\n')
  // Without a node of 22.19 or later, each run downloads Node.js into a new temporary directory, and leaves it.
  assert.equal((await readdir(join(mac.root, 'tmp'))).filter(name => name.startsWith('megachat-node.')).length, 2)
})

test('an Intel Mac without Node.js downloads the archive for x64', async t => {
  const mac = await machine(t, { central: true, login: true, claudeEntry: true })
  const { code, output, commands } = await setup(mac, { FAKE_UNAME_M: 'x86_64' })
  assert.equal(code, 0, output)
  assert.ok(ran(commands, 'curl')[0].endsWith(`/node-v${NODE_VERSION}-darwin-x64.tar.gz`))
  assert.match(ran(commands, 'npx-path ')[0], new RegExp(`/node-v${NODE_VERSION}-darwin-x64/bin/npx$`))
  assert.equal(existsSync(mac.acpConfig), false)
})

test('a wrong checksum of the Node.js archive stops the setup', async t => {
  const mac = await machine(t, { node: '20.19.0', central: true, login: true, claudeEntry: true, hash: 'b'.repeat(64) })
  const { code, output, commands } = await setup(mac)
  assert.equal(code, 1)
  assert.match(output, /The checksum of node-v24\.22\.3-darwin-arm64\.tar\.gz is wrong/)
  assert.deepEqual(ran(commands, 'npx'), [])
  assert.deepEqual(ran(commands, 'central'), [])
})

test('another platform stops the setup before each other step', async t => {
  const mac = await machine(t, { node: '22.19.0' })
  const { code, output, commands } = await setup(mac, { FAKE_UNAME_S: 'Linux' })
  assert.equal(code, 1)
  assert.match(output, /Megachat supports only macOS\. This platform is Linux\./)
  assert.deepEqual(commands, ['uname -s'])
})

test('without the Command Line Tools the setup starts their install and stops', async t => {
  const mac = await machine(t, { node: '22.19.0' })
  const { code, output, commands } = await setup(mac, { FAKE_GIT_FAILS: '1' })
  assert.equal(code, 1)
  assert.deepEqual(commands, ['uname -s', 'git --version', 'xcode-select --install'])
  assert.match(output, /Install the Command Line Tools in the dialog of macOS, then run the setup line again\./)
})

test('a failed installer of Central stops the setup', async t => {
  const mac = await machine(t, { node: '22.19.0', installerWorks: false })
  const { code, output, commands } = await setup(mac)
  assert.equal(code, 1)
  assert.deepEqual(ran(commands, 'installer-of-central'), ['installer-of-central '])
  assert.match(output, /The installer of Central did not install/)
  assert.deepEqual(ran(commands, 'npx'), [])
})

test('a failed login stops the setup', async t => {
  const mac = await machine(t, { node: '22.19.0', central: true })
  const { code, output, commands } = await setup(mac, { FAKE_LOGIN_FAILS: '1' })
  assert.equal(code, 1)
  assert.deepEqual(ran(commands, 'central'), ['central status', 'central login', 'central login read terminal input', 'central status'])
  assert.match(output, /Central still has no login\./)
  assert.deepEqual(ran(commands, 'npx'), [])
})

test('without a terminal the setup runs no central login and stops', async t => {
  const mac = await machine(t, { node: '22.19.0', central: true })
  const { code, output, commands } = await setup(mac, { MEGACHAT_SETUP_TTY: join(mac.root, 'no-terminal') })
  assert.equal(code, 1)
  assert.deepEqual(ran(commands, 'central'), ['central status'])
  assert.match(output, /Megachat cannot open the terminal/)
})

test('a failed central add claude-code does not stop the setup', async t => {
  const mac = await machine(t, { node: '22.19.0', central: true, login: true, acp: '{}' })
  const { code, output, commands } = await setup(mac, { FAKE_ADD_CODE: '1' })
  assert.equal(code, 0, output)
  assert.deepEqual(ran(commands, 'central add'), ['central add claude-code'])
  assert.match(output, /"central add claude-code" failed with the exit code 1\. A Claude child then uses the pi route of Central\./)
  assert.ok(!output.includes(SECRET))
  assert.deepEqual(ran(commands, 'npx-acp '), ['npx-acp {}'])
})

test('the exit code of a failed install line is the exit code of the setup', async t => {
  const mac = await machine(t, { node: '23.0.0', central: true, login: true, claudeEntry: true })
  const { code, output } = await setup(mac, { FAKE_NPX_CODE: '3' })
  assert.equal(code, 3)
  assert.match(output, /The output of the install line\./)
  assert.match(output, /The install line failed with the exit code 3\./)
  assert.doesNotMatch(output, /agent list of Air/)
})

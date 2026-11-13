# Spec Delta

## Purpose

The setup script `setup.sh` prepares an empty Mac for Megachat with one line in the terminal: it gets git, Node.js,
Central with its login and the Claude key of Central, and then it runs the install line.

## ADDED Requirements

### Requirement: Setup line
The setup line MUST be `curl -fsSL https://github.com/ignatov/megachat/releases/latest/download/setup.sh | bash`. The script MUST start no step before bash read all of it. Its standard input is the pipe, so each step that asks the user MUST read the terminal `/dev/tty`, or the file of `MEGACHAT_SETUP_TTY` when that variable is set. Each other command MUST read no input from the pipe.

Tests: `test/setup.test.mjs`, `test/release.test.mjs`

#### Scenario: The script from a pipe
- **WHEN** bash reads the script from its standard input, as `curl | bash` gives it
- **THEN** the script runs each step, and the install line runs once

#### Scenario: No terminal
- **WHEN** Central shows no login and `MEGACHAT_SETUP_TTY` names a file that does not exist
- **THEN** the script runs no `central login`, says that it needs a terminal, tells the user to run `~/.local/bin/central login` by its full path, and ends with the exit code 1

### Requirement: Platform of the setup
The script MUST stop with the exit code 1 and a message on a platform other than macOS, before each other step.

Tests: `test/setup.test.mjs`

#### Scenario: Linux
- **WHEN** `uname -s` gives `Linux`
- **THEN** the script says that it supports only macOS, runs no other command, and ends with the exit code 1

### Requirement: git of the setup
When `git --version` fails, the script MUST run `xcode-select --install` and stop with the exit code 1 and the message to install the Command Line Tools and run the line again. On macOS, `/usr/bin/git` fails until the Command Line Tools are installed.

Tests: `test/setup.test.mjs`

#### Scenario: No Command Line Tools
- **WHEN** `git --version` exits with the code 1
- **THEN** the script runs `xcode-select --install`, runs no install line, and ends with the exit code 1

### Requirement: Node.js on the PATH
When `node --version` gives 22.19 or later and `npx` is on the `PATH`, the script MUST use them and download nothing. The install line needs Node.js 22.19 or later. The IDE runs Megachat with its own Node.js.

Tests: `test/setup.test.mjs`

#### Scenario: A Node.js that is new enough
- **WHEN** `node --version` gives `v22.19.0`
- **THEN** the script downloads no Node.js, and the `npx` of the `PATH` runs the install line

### Requirement: Download of Node.js
Without them, the script MUST download the archive of Node.js 24.22.3 for `darwin-arm64`, or for `darwin-x64` when `uname -m` gives `x86_64`, and `SHASUMS256.txt` from `https://nodejs.org/dist/v24.22.3/` into a new `mktemp -d` directory. The `shasum -a 256` of the archive MUST be equal to its line in `SHASUMS256.txt`, else the script MUST stop with the exit code 1. Its `npx` runs the install line. The script MUST NOT remove the directory.

Tests: `test/setup.test.mjs`

#### Scenario: An old Node.js on an Apple silicon Mac
- **WHEN** `node --version` gives `v22.18.0` and `uname -m` gives `arm64`
- **THEN** the script downloads `node-v24.22.3-darwin-arm64.tar.gz`, and the `npx` of that archive runs the install line

#### Scenario: An Intel Mac without Node.js
- **WHEN** no `node` is on the `PATH` and `uname -m` gives `x86_64`
- **THEN** the script downloads `node-v24.22.3-darwin-x64.tar.gz`

#### Scenario: A wrong checksum
- **WHEN** the `shasum -a 256` of the archive is not equal to its line in `SHASUMS256.txt`
- **THEN** the script says that the checksum is wrong, runs no install line, and ends with the exit code 1

### Requirement: Central command of the setup
When `~/.local/bin/central` is not an executable file, the script MUST run the official installer of Central, `curl -fsSL https://central-cli.labs.jb.gg/install.sh | bash`. When the file is still missing after the installer, the script MUST stop with the exit code 1.

Tests: `test/setup.test.mjs`

#### Scenario: No Central
- **WHEN** `~/.local/bin/central` does not exist
- **THEN** the script runs the installer of Central once, and the later steps use the `central` that it installed

#### Scenario: A failed installer
- **WHEN** the installer of Central ends and `~/.local/bin/central` does not exist
- **THEN** the script runs no install line, and ends with the exit code 1

### Requirement: Login of the setup
`central status` exits with 0 also without a login. When a line of its output has `Auth` and `not connected`, the script MUST run `central login` with the terminal as its input, and check `central status` again. When the second check shows no login, the script MUST stop with the exit code 1. A message that tells the user to run a Central command MUST give its full path `~/.local/bin/central`, because the installer of Central does not put `~/.local/bin` on the `PATH`.

Tests: `test/setup.test.mjs`

#### Scenario: No login
- **WHEN** `central status` gives `Auth  not connected`
- **THEN** the script runs `central login` once, and goes on when `central status` then gives `Auth  JetBrains Team`

#### Scenario: A failed login
- **WHEN** `central status` gives `Auth  not connected` also after `central login`
- **THEN** the script runs no install line, and ends with the exit code 1

### Requirement: Claude key of the setup
When `~/.claude/settings.json` has no `apiKeyHelper` that calls `central`, or no `ANTHROPIC_BASE_URL`, the script MUST run `central add claude-code`. When that command fails, the script MUST say so and go on, because a Claude child then uses the pi route of Central. The script MUST NOT change a shell file or the `PATH` of the user.

Tests: `test/setup.test.mjs`

#### Scenario: No Central entry of Claude Code
- **WHEN** `~/.claude/settings.json` does not exist
- **THEN** the script runs `central add claude-code` once

#### Scenario: A failed central add claude-code
- **WHEN** `central add claude-code` exits with the code 1
- **THEN** the script says that a Claude child uses the pi route of Central, runs the install line, and ends with its exit code

### Requirement: Empty acp.json of the setup
When the ACP configuration file has only white space or no byte, the script MUST write `{}` to it before the install line, because the install line refuses an empty file. Other content MUST stay. The file is `~/.jetbrains/acp.json`, or the file of `MEGACHAT_ACP_CONFIG` when that variable is set, the same as for the install line.

Tests: `test/setup.test.mjs`

#### Scenario: An acp.json with only white space
- **WHEN** the file of `MEGACHAT_ACP_CONFIG` holds a line break and spaces
- **THEN** the file holds `{}` when the install line starts

### Requirement: Install line of the setup
The script MUST run `npx -y "github:ignatov/megachat#semver:x" install`, show its output, and end with its exit code. Only when that code is 0, the script MUST then tell the user to select Megachat in the agent list of Air, that the IDE build needs the Air support for Megachat, and that the first start takes 30 to 100 seconds and needs the network.

Tests: `test/setup.test.mjs`

#### Scenario: A successful install line
- **WHEN** the install line ends with the exit code 0
- **THEN** the script shows its output, its last lines tell the user to select Megachat in the agent list of Air and do not tell to restart the IDE, and its exit code is 0

#### Scenario: A failed install line
- **WHEN** the install line ends with the exit code 3
- **THEN** the script shows its output, says that the install line failed, and ends with the exit code 3

### Requirement: Second run of the setup
A second run of the script on a ready machine MUST change no file outside a new temporary directory, run no installer, no `central login` and no `central add claude-code`, and end with the exit code 0.

Tests: `test/setup.test.mjs`

#### Scenario: Two runs
- **WHEN** the script ran on an empty machine with the exit code 0, and it runs a second time
- **THEN** the second run runs no installer of Central, no `central login` and no `central add claude-code`, `acp.json` and `~/.claude/settings.json` stay the same, and the exit code is 0

#### Scenario: A second run on a machine with Node.js
- **WHEN** `node --version` gives `v22.19.0`, and Central, its login, its entry of Claude Code and `acp.json` are in place
- **THEN** each of two runs runs only the checks and the install line, no file changes, and the exit code is 0

### Requirement: No secret in the output of the setup
The script MUST NOT show the output of `central status` or of `central add claude-code`, because the base URL of Central holds a key.

Tests: `test/setup.test.mjs`

#### Scenario: A key in the output of Central
- **WHEN** `central status` and `central add claude-code` print a base URL with the key `secret-key-of-the-test`
- **THEN** the output of the script does not have `secret-key-of-the-test`

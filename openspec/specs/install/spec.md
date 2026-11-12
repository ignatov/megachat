# install Specification

## Purpose
One line installs the last release of Megachat and adds its entry to `acp.json` of the IDE. `install` checks the tools that Megachat needs and tells the user what to do when a check fails.

## Requirements

### Requirement: Check of the Node.js version
The command `megachat` MUST check the version of Node.js before it loads Megachat. A Node.js older than the `engines` range MUST get one line with the found and the needed version, and the exit code 1.

Tests: `test/install.test.mjs`

#### Scenario: An old Node.js
- **WHEN** the `engines` range is `>=22.19`, and the command `megachat` runs on Node.js 22.18.3
- **THEN** the command writes only the line "Megachat needs Node.js 22.19 or later. This Node.js is 22.18.3." and exits with the code 1

### Requirement: Install line
One line MUST install the last release of Megachat and update it: `npx -y "github:ignatov/megachat#semver:x" install`.

Tests: `test/package.mjs`

#### Scenario: The install line in a repository with a release tag
- **WHEN** the user runs the install line, and the repository has the tag of the version of `package.json`
- **THEN** `install` writes the entry `Megachat` of the last release, and it says that the IDE starts Megachat with npx and with its own Node.js

### Requirement: Checks of install
`install` MUST check the platform, Central and its login, Claude Code and its key from Central, and the command `codex` on the `PATH`. It MUST use the places that Megachat uses at run time.

Each check MUST print one line. A failed check MUST name what to install or do. A platform other than macOS MUST get a line that nobody tested it there, and the install MUST go on.

`install` MUST NOT print the output of Central or of the key helper of Claude Code.

Tests: `test/install.test.mjs`

#### Scenario: Each check passes
- **WHEN** `install` runs on macOS, Central, Claude Code and `codex` are in their places, and the key helper of Claude Code prints `test-key`
- **THEN** `install` prints "The platform is macOS.", "Central gives a valid configuration.", a line that Claude Code uses Central, and a line with the path of Codex, and it does not print `test-key`

#### Scenario: Missing tools
- **WHEN** the home of the user has no Central and no Claude Code, and only a `node_modules/.bin` directory of npx holds `codex`
- **THEN** `install` prints "Central is not at" with the path, "Claude Code is not at" with the path, and "The command codex is not on the PATH.", it writes the entry, and it exits with the code 1

#### Scenario: Another platform
- **WHEN** `install` runs on Linux
- **THEN** it prints "Nobody tested Megachat on linux.", and it writes the entry

### Requirement: Entry Megachat
`install` MUST add the entry `Megachat` to `agent_servers` of `~/.jetbrains/acp.json`. The entry MUST have no `application_session` key. `MEGACHAT_ACP_CONFIG` MAY replace the path of `acp.json`. The tests set it to a temporary file.

Tests: `test/install.test.mjs`

#### Scenario: The path of acp.json
- **WHEN** `MEGACHAT_ACP_CONFIG` is set, and then it is not set
- **THEN** `install` uses the path of the variable first, and then `~/.jetbrains/acp.json`

#### Scenario: The entry has no application_session key
- **WHEN** `install` writes the entry in a git checkout
- **THEN** the entry `Megachat` has only the keys `command` and `args`

### Requirement: Entry of a copy without .git
In a copy without `.git`, the entry MUST be `{"command":"npx","args":["-y","github:ignatov/megachat#semver:x","acp"]}`. So each start of the agent MUST start the last release.

The next start of the agent after a release MUST install the new release, and its daemon MUST replace the daemon of the earlier release. The entry MUST stay unchanged.

Tests: `test/install.test.mjs`, `test/package.mjs`

#### Scenario: Install in a copy
- **WHEN** `install` runs in a copy without `.git`, and `acp.json` does not exist
- **THEN** `acp.json` is `{"agent_servers":{"Megachat":{"command":"npx","args":["-y","github:ignatov/megachat#semver:x","acp"]}}}`

#### Scenario: A new release tag
- **WHEN** the agent ran from the entry, and then the repository gets the tag of a higher patch version
- **THEN** the next start of the agent gives the higher version in `agentInfo`, the new daemon replaces the earlier daemon, and `acp.json` stays unchanged

### Requirement: Entry of a git checkout
In a git checkout, the entry MUST start `bin/megachat.mjs acp` of the checkout with Node.js directly. The command of the entry MUST be the first `node` on the `PATH` that is the same file as the running Node.js. Without such a `node`, it MUST be the path of the running Node.js.

Tests: `test/install.test.mjs`

#### Scenario: A link to the running Node.js on the PATH
- **WHEN** the `PATH` has a directory with another `node`, and then two directories with a link to the running Node.js
- **THEN** the command of the entry is the link in the first of the two directories, and the arguments are `bin/megachat.mjs` of the checkout and `acp`

#### Scenario: No running Node.js on the PATH
- **WHEN** the `PATH` has only a `node` that is another file
- **THEN** the command of the entry is the path of the running Node.js

### Requirement: Write of acp.json
Without a file, `install` MUST write a file with the one entry and the mode 0600, and make its directory when necessary.

Without the entry, `install` MUST copy the file to `acp.json.before-megachat-<UTC time>`, and then add the entry. It MUST keep each other key, the key order and the mode of the file.

An equal entry MUST stay. `install` MUST then say that Megachat is installed already.

Tests: `test/install.test.mjs`

#### Scenario: No file
- **WHEN** the directory `jetbrains` and its `acp.json` do not exist
- **THEN** `install` makes the directory and writes `acp.json` with only the entry `Megachat` and the mode 0600

#### Scenario: A file without the entry
- **WHEN** `acp.json` has the mode 0640 and the keys `default_mcp_settings`, `agent_servers` with the entry `Other`, and `z`, and `install` runs at 2026-11-11T09:08:07Z
- **THEN** the file `acp.json.before-megachat-20261111T090807Z` holds the earlier text, and `acp.json` keeps its keys in the same order, gets the entry `Megachat` after `Other`, and keeps the mode 0640

#### Scenario: An equal entry
- **WHEN** `install` runs a second time with the same entry
- **THEN** `acp.json` stays unchanged, and `install` prints "Megachat is installed already:" with the path and "holds the same entry Megachat."

### Requirement: Replacement of the entry of install 0.2.0
In a copy without `.git`, `install` MUST replace the entry that `install` 0.2.0 wrote: Node.js starts `bin/megachat.mjs acp` of a copy in an `_npx` directory, and the entry has no other key. `install` MUST first copy the file to `acp.json.before-megachat-<UTC time>`. It MUST keep the place of the entry, each other key and the mode of the file, and print one line about the replacement and the earlier entry.

Tests: `test/install.test.mjs`

#### Scenario: An entry of install 0.2.0 between two entries
- **WHEN** `install` runs in a copy without `.git`, `agent_servers` has the entries `First`, `Megachat` and `Last`, and `Megachat` starts `/Users/me/.npm/_npx/ad3589aca26e8aac/node_modules/megachat/bin/megachat.mjs acp` with `/opt/homebrew/bin/node`
- **THEN** `install` copies the file to `acp.json.before-megachat-<UTC time>`, the new entry `Megachat` stays between `First` and `Last`, the mode stays 0640, and `install` prints "Megachat replaced the earlier entry Megachat" with the earlier entry

#### Scenario: An entry that is not of install 0.2.0
- **WHEN** the entry `Megachat` has the key `application_session`, has a third argument, or starts `bin/megachat.mjs` outside an `_npx` directory
- **THEN** the entry is not the entry of `install` 0.2.0

### Requirement: Different entry
Another different entry `Megachat`, or a file that is not a JSON object, MUST stay unchanged. `install` MUST print the entries and what to do, and exit with 1. There is no option to replace the entry.

Tests: `test/install.test.mjs`

#### Scenario: An entry with an application_session key
- **WHEN** the entry `Megachat` of `acp.json` has `application_session` set to `true`
- **THEN** `acp.json` stays unchanged, `install` prints the two entries and tells the user to remove the entry Megachat, and it exits with 1

#### Scenario: A file that is not JSON
- **WHEN** `acp.json` holds `{ "agent_servers": `
- **THEN** the file stays unchanged, `install` prints the new entry, and it exits with 1

### Requirement: Last lines and exit code of install
The last line of `install` MUST give the version and the directory of the copy. In a copy without `.git`, a line before it MUST say that the IDE starts Megachat with `npx` and its own Node.js. The last line MUST say that the IDE uses a copy of its own.

The exit code MUST be 0 only when the entry is in place and each check passed.

Tests: `test/install.test.mjs`

#### Scenario: Install in a copy
- **WHEN** `install` runs in a copy without `.git` on macOS, and each check passes
- **THEN** `install` prints "The IDE starts Megachat with npx and with its own Node.js, not with the Node.js of this terminal.", the last line is "This install ran Megachat" with the version and the directory, followed by "The IDE uses a copy of its own in its npm cache.", and the exit code is 0

#### Scenario: A failed check
- **WHEN** `install` writes the entry, but `codex` is not on the `PATH`
- **THEN** the exit code is 1

### Requirement: Content of the package
The package MUST hold `bin`, `src`, `resources`, `README.md`, `LICENSE` and `package.json`, and no tests.

Tests: `test/package.mjs`

#### Scenario: A packed and installed copy
- **WHEN** `npm pack` packs Megachat, and npm installs the tarball
- **THEN** the tarball holds only files in `bin`, `src` and `resources`, and `README.md`, `LICENSE` and `package.json`, and the installed copy has no `test` directory and no `.git`

## MODIFIED Requirements

### Requirement: Checks of install
`install` MUST check the platform, Central and its login. It MUST print which Claude Code and which key a Claude child uses and which Codex a Codex child uses, from the places of the run time (see the capabilities `launch` and `claude-child`). Each check MUST print one line, and a failed check MUST name what to do. `install` MUST NOT print the output of Central or of the key helper of Claude Code.

Tests: `test/install.test.mjs`

#### Scenario: Each check passes
- **WHEN** `install` runs on macOS, Central, Claude Code and `codex` are in their places, and the key helper of Claude Code prints `test-key`
- **THEN** `install` prints "The platform is macOS.", "Central gives a valid configuration.", "A Claude child uses Claude Code at" with the path, "A Claude child gets its key from the Central entry in" with the path of the settings, and "A Codex child uses Codex at" with the path, and it does not print `test-key`

#### Scenario: Missing tools
- **WHEN** the home of the user has no Central, no Claude Code and no settings of Claude Code, and only a `node_modules/.bin` directory of npx holds `codex`
- **THEN** `install` prints "Central is not at" with the path, "Claude Code is not at" with the path and "A Claude child uses the Claude Code that npm installed with Megachat.", "A Claude child gets no key from Central. Run "central login"", and "The command codex is not on the PATH. A Codex child uses the Codex that npm installed with Megachat.", it writes the entry, and it exits with the code 1

#### Scenario: No binary of an agent
- **WHEN** Claude Code is not at `~/.local/bin/claude`, the `PATH` has no `codex`, and the module system finds neither the `claude` binary nor the `codex` binary that npm installs with the agents
- **THEN** `install` prints "No Claude Code is available for a Claude child." and "No Codex is available for a Codex child."

#### Scenario: Another platform
- **WHEN** `install` runs on Linux
- **THEN** it prints "Nobody tested Megachat on linux.", and it writes the entry

### Requirement: Last lines and exit code of install
The last line of `install` MUST give the version of the build (see the capability `launch`) and the directory of the copy. In a copy without `.git`, a line before it MUST say that the IDE starts Megachat with `npx` and its own Node.js. The last line MUST say that the IDE uses a copy of its own.

The exit code MUST be 0 only when the entry is in place, the platform and Central passed, and Claude (a binary and a key) or Codex (a binary) is ready.

Tests: `test/install.test.mjs`

#### Scenario: Install in a copy
- **WHEN** `install` runs in a copy without `.git` on macOS, and each check passes
- **THEN** `install` prints "The IDE starts Megachat with npx and with its own Node.js, not with the Node.js of this terminal.", the last line is "This install ran Megachat" with the version and the directory, followed by "The IDE uses a copy of its own in its npm cache.", and the exit code is 0

#### Scenario: Install in a checkout after the release tag
- **WHEN** `install` runs in a temporary git repository with the version `0.3.0`, the tag `v0.3.0` and two commits after it
- **THEN** the last line is "Megachat 0.3.0+2.g" with the first 7 hexadecimal digits of the commit, followed by "runs from" and the directory

#### Scenario: A failed check
- **WHEN** `install` writes the entry, but Central is not at `~/.local/bin/central`
- **THEN** the exit code is 1

#### Scenario: Only Central and the binaries of npm
- **WHEN** `install` writes the entry on macOS, Central gives a valid configuration, Claude Code is not at `~/.local/bin/claude`, the settings of Claude Code do not exist, and `codex` is not on the `PATH`
- **THEN** `install` prints "Claude Code is not at" with the path, "A Claude child uses the Claude Code that npm installed with Megachat.", "A Claude child gets its key from the pi route of Central", "Run "central add claude-code"", and "A Codex child uses the Codex that npm installed with Megachat.", and the exit code is 0

#### Scenario: No child agent is ready
- **WHEN** `install` writes the entry on macOS, Central gives a valid configuration, Claude Code is not at `~/.local/bin/claude`, the `PATH` has no `codex`, and the module system finds neither the `claude` binary nor the `codex` binary
- **THEN** the exit code is 1

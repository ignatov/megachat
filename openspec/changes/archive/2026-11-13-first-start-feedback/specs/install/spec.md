# Spec Delta

## MODIFIED Requirements

### Requirement: Entry of a copy without .git
In a copy without `.git`, the entry MUST start `npx` with the arguments `-y`, `github:ignatov/megachat#semver:x` and `acp`, and it MUST have the `env` of the requirement "Time limits of the network in the entry". So each start of the agent MUST start the last release.

The next start of the agent after a release MUST install the new release, and its daemon MUST replace the daemon of the earlier release. The entry MUST stay unchanged.

Tests: `test/install.test.mjs`, `test/package.mjs`

#### Scenario: Install in a copy
- **WHEN** `install` runs in a copy without `.git`, and `acp.json` does not exist
- **THEN** `acp.json` is `{"agent_servers":{"Megachat":{"command":"npx","args":["-y","github:ignatov/megachat#semver:x","acp"],"env":{"GIT_HTTP_LOW_SPEED_LIMIT":"1000","GIT_HTTP_LOW_SPEED_TIME":"20"}}}}`

#### Scenario: A new release tag
- **WHEN** the agent ran from the entry, and then the repository gets the tag of a higher patch version
- **THEN** the next start of the agent gives the higher version in `agentInfo`, the new daemon replaces the earlier daemon, and `acp.json` stays unchanged

## ADDED Requirements

### Requirement: Time limits of the network in the entry
The `env` of the entry of a copy without `.git` MUST set `GIT_HTTP_LOW_SPEED_LIMIT` to `1000` and `GIT_HTTP_LOW_SPEED_TIME` to `20`. So git MUST end an HTTPS transfer of npx that stays below 1000 bytes per second for 20 seconds. The `env` MUST have no other variable.

Tests: `test/install.test.mjs`

#### Scenario: A server that never answers
- **WHEN** a local server accepts each connection and never answers, and `git ls-remote` asks it for the refs with the `env` of the entry
- **THEN** git ends in less than 30 seconds with the exit code 128, and its error output has "Operation too slow"

### Requirement: Replacement of the entry of install 0.3.0 and 0.4.0
In a copy without `.git`, `install` MUST replace the entry that `install` 0.3.0 and 0.4.0 wrote: exactly the keys `command` `npx` and `args` `-y`, `github:ignatov/megachat#semver:x` and `acp`. It MUST first copy the file to `acp.json.before-megachat-<UTC time>`, keep the place of the entry, each other key and the mode of the file, and print one line about the replacement and the earlier entry.

Tests: `test/install.test.mjs`

#### Scenario: An entry of install 0.3.0 and 0.4.0 between two entries
- **WHEN** `install` runs in a copy without `.git`, and `agent_servers` has the entries `First`, the entry `Megachat` of `install` 0.3.0 and 0.4.0, and `Last`, and the file has the mode 0640
- **THEN** `install` copies the file to `acp.json.before-megachat-<UTC time>`, the new entry `Megachat` with the `env` stays between `First` and `Last`, the mode stays 0640, and `install` prints "Megachat replaced the earlier entry Megachat" with the earlier entry

#### Scenario: An entry of install 0.3.0 and 0.4.0 with an env of the user
- **WHEN** the entry `Megachat` starts `npx` with the arguments of `install` 0.3.0 and 0.4.0, and it has an `env` with `HTTPS_PROXY`
- **THEN** the entry is not the entry of `install` 0.3.0 and 0.4.0, `acp.json` stays unchanged, and `install` exits with 1

### Requirement: Line about the network
In a copy without `.git`, `install` MUST print a line directly before the line about npx, and only with it: each start in the IDE needs the network, because npx asks GitHub for the last release. The line MUST say that without the network the start fails and the IDE can show no reason, that a proxy that does not answer can make the start wait without end, and what the user must do.

Tests: `test/install.test.mjs`

#### Scenario: Install in a copy
- **WHEN** `install` runs in a copy without `.git` on macOS, and each check passes
- **THEN** `install` prints "Each start of Megachat in the IDE needs the network" before "The IDE starts Megachat with npx"

#### Scenario: Install in a checkout
- **WHEN** `install` runs in a git checkout
- **THEN** `install` prints no line about the network

#### Scenario: A different entry
- **WHEN** `install` runs in a copy without `.git`, and `acp.json` holds an entry `Megachat` that starts a checkout
- **THEN** `install` prints neither the line about the network nor the line about npx

### Requirement: Line about the IDE build
`install` MUST print a line before its last line, and in a copy without `.git` also before the line about the network: it cannot check the IDE build, Megachat needs an IDE build with the Air support for Megachat, and another build can close the session when a window releases it. The line MUST NOT change the exit code.

Tests: `test/install.test.mjs`

#### Scenario: Each check passes
- **WHEN** `install` runs in a copy without `.git` on macOS, and each check passes
- **THEN** `install` prints "Megachat cannot check the IDE build.", then "Each start of Megachat in the IDE needs the network", then "The IDE starts Megachat with npx", and the exit code is 0

#### Scenario: Install in a checkout
- **WHEN** `install` runs in a git checkout
- **THEN** the line before the last line starts with "Megachat cannot check the IDE build."

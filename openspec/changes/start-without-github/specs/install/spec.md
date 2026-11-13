# Spec Delta

## MODIFIED Requirements

### Requirement: Entry of a copy without .git
In a copy without `.git`, the entry MUST start `npx` with the arguments `--call` and `"$NODE" '<state directory>/launcher/start.mjs'`, and it MUST have the `env` of the requirement "Time limits of the network in the entry". So each start of the agent MUST start the launcher with the Node.js of the IDE (see the capability `launcher`).

The next start of the agent after a release MUST install the new release, and its daemon MUST replace the daemon of the earlier release. The entry MUST stay unchanged.

Tests: `test/install.test.mjs`, `test/package.mjs`

#### Scenario: Install in a copy
- **WHEN** `install` runs in a copy without `.git` with the state directory `/Users/me/.jetbrains/air/megachat`, and `acp.json` does not exist
- **THEN** `acp.json` is `{"agent_servers":{"Megachat":{"command":"npx","args":["--call","\"$NODE\" '/Users/me/.jetbrains/air/megachat/launcher/start.mjs'"],"env":{"GIT_HTTP_LOW_SPEED_LIMIT":"1000","GIT_HTTP_LOW_SPEED_TIME":"20"}}}}`

#### Scenario: A state directory with a quotation mark
- **WHEN** `install` runs in a copy without `.git` with the state directory `/tmp/it's`
- **THEN** the second argument of the entry is `"$NODE" '/tmp/it'\''s/launcher/start.mjs'`

#### Scenario: A new release tag
- **WHEN** the agent ran from the entry, and then the repository gets the tag of a higher patch version
- **THEN** the next start of the agent gives the higher version in `agentInfo`, the new daemon replaces the earlier daemon, and `acp.json` stays unchanged

### Requirement: Line about the network
In a copy without `.git`, `install` MUST print a line directly before the line about npx, and only with it: each start in the IDE asks GitHub for the last release. The line MUST say that without an answer of GitHub in 10 seconds the IDE starts the installed release, and that the first start in the IDE needs the network.

Tests: `test/install.test.mjs`

#### Scenario: Install in a copy
- **WHEN** `install` runs in a copy without `.git` on macOS, and each check passes
- **THEN** `install` prints "Each start of Megachat in the IDE asks GitHub for the last release" before "The IDE starts Megachat with npx"

#### Scenario: Install in a checkout
- **WHEN** `install` runs in a git checkout
- **THEN** `install` prints no line about the network

#### Scenario: A different entry
- **WHEN** `install` runs in a copy without `.git`, and `acp.json` holds an entry `Megachat` that starts a checkout
- **THEN** `install` prints neither the line about the network nor the line about npx

## ADDED Requirements

### Requirement: Write of the launcher
In a copy without `.git`, `install` MUST write `launcher/start.mjs` in the state directory (see the capability `launcher`) with the mode 0600, in a directory with the mode 0700. It MUST write it also when the entry stays unchanged. It MUST NOT write `launcher/copy.json`. In a git checkout, `install` MUST NOT write the launcher.

Tests: `test/install.test.mjs`

#### Scenario: Install in a copy
- **WHEN** `install` runs in a copy without `.git`, and the state directory has no `launcher/`
- **THEN** the state directory has `launcher/start.mjs` with the mode 0600 and no `launcher/copy.json`

#### Scenario: Install in a checkout
- **WHEN** `install` runs in a git checkout
- **THEN** the state directory has no `launcher/`

### Requirement: Replacement of the npx entry with the time limits
In a copy without `.git`, `install` MUST replace the npx entry that `install` 0.5.0 and later wrote before the launcher: exactly the `command` `npx`, the `args` `-y`, `github:ignatov/megachat#semver:x` and `acp`, and the `env` of "Time limits of the network in the entry". It MUST copy the file to `acp.json.before-megachat-<UTC time>` first, keep the place of the entry, each other key and the mode, and print one line and the earlier entry.

Tests: `test/install.test.mjs`

#### Scenario: An npx entry with the time limits between two entries
- **WHEN** `install` runs in a copy without `.git`, `agent_servers` has the entries `First`, the npx entry with the time limits, and `Last`, and the file has the mode 0640
- **THEN** `install` copies the file to `acp.json.before-megachat-<UTC time>`, the launcher entry stays between `First` and `Last`, the mode stays 0640, and `install` prints "Megachat replaced the earlier entry Megachat" with the earlier entry

#### Scenario: An npx entry with the time limits and a variable of the user
- **WHEN** the entry `Megachat` is the npx entry with the time limits, and its `env` also has `HTTPS_PROXY`
- **THEN** `acp.json` stays unchanged, `install` prints both entries, and it exits with 1

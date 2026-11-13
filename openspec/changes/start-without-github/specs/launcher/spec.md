# Spec Delta

## Purpose

The launcher of the IDE entry starts the last release when GitHub answers, and the installed release when GitHub does
not answer. So a start without the network still reaches the running daemon and the conversation.

## ADDED Requirements

### Requirement: Check of GitHub at a start
The launcher MUST run `git ls-remote --tags --refs` on `https://github.com/ignatov/megachat` with its own environment, so the `env` of the entry applies. It MUST end git after 10 seconds. `MEGACHAT_RELEASE_REPOSITORY` MAY replace the repository, for a test. The launcher MUST NOT read its standard input.

Tests: `test/launcher.test.mjs`

#### Scenario: A repository that never answers
- **WHEN** the repository is a local server that accepts each connection and never answers, and `launcher/copy.json` names a copy of the version `0.6.3`
- **THEN** the launcher ends git after 10 seconds and starts that copy, and the copy reads the `initialize` request that the client sent at the start

### Requirement: Start of the recorded copy
When git gives the tags, and `launcher/copy.json` names a copy whose `package.json` has the version of the highest release tag `v<major>.<minor>.<patch>` or a higher version, the launcher MUST start `bin/megachat.mjs acp` of that copy with its own Node.js. It MUST NOT start npx. A pre-release tag MUST NOT count.

Tests: `test/launcher.test.mjs`

#### Scenario: The recorded copy has the last release
- **WHEN** the repository has the tags `v0.6.2`, `v0.6.3` and `v0.7.0-rc.1`, and the recorded copy has the version `0.6.3`
- **THEN** the launcher starts that copy, `agentInfo` gives `0.6.3`, and no npx process starts

### Requirement: Start through npx
When git gives the tags, and the record is missing, names no directory with `bin/megachat.mjs`, or names an older version than the highest release tag, the launcher MUST run `npx -y github:ignatov/megachat#semver:x acp` with the npx next to its own Node.js. So the next start after a release MUST install the new release.

Tests: `test/launcher.test.mjs`, `test/package.mjs`

#### Scenario: A new release tag
- **WHEN** the repository has the tag `v0.6.4`, and the recorded copy has the version `0.6.3`
- **THEN** the launcher runs npx with the spec of the repository and `#semver:x`, and `agentInfo` gives `0.6.4`

#### Scenario: No record
- **WHEN** the state directory has no `launcher/copy.json`, and the repository answers
- **THEN** the launcher runs npx with the spec of the repository and `#semver:x`

### Requirement: Start without GitHub
When git fails or gives no answer in 10 seconds, the launcher MUST start the recorded copy of any version, as in "Start of the recorded copy". It MUST write one line to its error output with the version of that copy. Without a record of a directory with `bin/megachat.mjs`, it MUST write one line that names the network, and exit with the code 1.

Tests: `test/launcher.test.mjs`

#### Scenario: No network, and a running daemon
- **WHEN** the repository is a path that does not exist, a daemon of the recorded copy `0.6.3` runs, and a client sends `initialize`
- **THEN** the error output has the line "Megachat could not reach GitHub, so it started the installed release 0.6.3.", the client gets `agentInfo` with `0.6.3`, and the same daemon keeps running

#### Scenario: No network, and no record
- **WHEN** the repository is a path that does not exist, and the state directory has no `launcher/copy.json`
- **THEN** the launcher writes the line "Megachat could not reach GitHub, and no release of Megachat is installed." and exits with the code 1

### Requirement: Process of the launcher
The launcher MUST give its standard input, its standard output and its error output to the process that it starts. It MUST pass `SIGTERM`, `SIGINT` and `SIGHUP` to that process, and exit with its exit code. That process MUST get the environment of the launcher, so the rules of a start by npm apply (see the capability `launch`).

Tests: `test/launcher.test.mjs`

#### Scenario: The IDE ends the agent
- **WHEN** the launcher started the recorded copy, and the launcher gets `SIGTERM`
- **THEN** the `acp` process of the copy ends, and the launcher exits

### Requirement: Record of the copy
At each start, the daemon of a copy of npx, in a directory `_npx/<hash>/node_modules/megachat`, MUST write `{"root": "<directory of the copy>"}` to `launcher/copy.json` of its state directory. It MUST write the file to a temporary file first, and then replace it by a rename. A git checkout and another copy MUST NOT write the file.

Tests: `test/launcher.test.mjs`, `test/package.mjs`

#### Scenario: A daemon of a copy of npx
- **WHEN** the daemon of a copy in `_npx/0123456789abcdef/node_modules/megachat` starts
- **THEN** `launcher/copy.json` names that directory, with the mode 0600

#### Scenario: A daemon of a checkout
- **WHEN** the daemon of a git checkout starts
- **THEN** the state directory has no `launcher/copy.json`

### Requirement: Correction of the launcher
At each start, the daemon of a copy of npx MUST write `launcher/start.mjs` again when the file exists and its text differs from the launcher of its own release. It MUST write a temporary file first, and then replace the file by a rename. A missing file MUST stay missing, because only `install` makes the launcher.

Tests: `test/launcher.test.mjs`

#### Scenario: A launcher of an earlier release
- **WHEN** `launcher/start.mjs` holds another text, and the daemon of a copy of npx starts
- **THEN** `launcher/start.mjs` holds the launcher of the release of the daemon, with the mode 0600

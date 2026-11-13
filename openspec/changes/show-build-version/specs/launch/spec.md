# Spec Delta

## MODIFIED Requirements

### Requirement: Version in the agent information
The ACP `agentInfo` MUST give the version of the build (see the requirement "Version of a build"), in a source checkout and in the bundle. The bundle MUST give the version of its checkout at the time of `npm run build`.

Tests: `test/bundle.test.mjs`, `test/recovery.test.mjs`

#### Scenario: The answer to initialize
- **WHEN** a client sends the ACP `initialize` request to `acp` of a source checkout or of the bundle
- **THEN** the `agentInfo` of the answer has the version of the build of the checkout

## ADDED Requirements

### Requirement: Version of a build
A copy without `.git`, and a git checkout at the tag `v<version>` of `package.json` with no change of a tracked file, MUST give the version of `package.json`. Another git checkout MUST add SemVer build metadata: `+<count>.g<commit>` with the count of commits after that tag, `+g<commit>` when that tag is not in its history, and `.dirty` at the end for a change of a tracked file.

Tests: `test/launch.test.mjs`

#### Scenario: A checkout at the release tag
- **WHEN** a temporary repository has the version `0.3.0` in `package.json`, its commit has the tag `v0.3.0`, and no tracked file has a change
- **THEN** the version is `0.3.0`

#### Scenario: Two commits after the release tag
- **WHEN** the same repository gets two commits after the tag `v0.3.0`
- **THEN** the version is `0.3.0+2.g` and the first 7 hexadecimal digits of the commit

#### Scenario: A changed tracked file
- **WHEN** a tracked file of the repository with two commits after the tag gets a change
- **THEN** the version is `0.3.0+2.g` and the first 7 hexadecimal digits of the commit, followed by `.dirty`

#### Scenario: A version without its tag
- **WHEN** a commit sets the version `0.4.0` in `package.json`, and the tag `v0.4.0` does not exist
- **THEN** the version is `0.4.0+g` and the first 7 hexadecimal digits of the commit

#### Scenario: A copy without .git
- **WHEN** a copy without `.git` has the version `0.3.0` in `package.json`
- **THEN** the version is `0.3.0`, and Megachat starts no git command

### Requirement: Version without an answer of git
When git fails or gives no answer in 2 seconds, a git checkout MUST give the version of `package.json` followed by `+dev`. Megachat MUST compute the version at most one time in each process.

Tests: `test/launch.test.mjs`

#### Scenario: A failed git command
- **WHEN** the package root has a `.git` file with `gitdir: /elsewhere`, and the version of `package.json` is `0.3.0`
- **THEN** the version is `0.3.0+dev`

### Requirement: Version of the daemon in status
The command `status` MUST print the version of the running daemon in the key `version`, directly after the key `running`. A daemon that gives no version, such as a daemon of an earlier build, MUST give a line without the key `version`.

Tests: `test/launch.test.mjs`

#### Scenario: The status of a running daemon
- **WHEN** a daemon of a checkout runs, and the user runs `status`
- **THEN** the line has the keys `running`, `version`, `current` and `children` in this order, and `version` is the version of the build of the checkout

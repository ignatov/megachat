# Spec Delta

## MODIFIED Requirements

### Requirement: Place of the state directory
The state of the machine scope MUST live in `~/.jetbrains/air/megachat/` for each user: `%USERPROFILE%\.jetbrains\air\megachat` on Windows. All JetBrains products of the user MUST share this directory, its daemon, and its conversation. `MEGACHAT_HOME` or the final command argument MAY select another directory for a test or development. The state of a project scope MUST live in a directory of its own (see the capability `project-scope`).

Tests: `test/home.test.mjs`

#### Scenario: The directory on macOS
- **WHEN** the home directory of the user is `/Users/me` on macOS and `MEGACHAT_HOME` is not set
- **THEN** the state directory is `/Users/me/.jetbrains/air/megachat`

#### Scenario: The directory on Windows
- **WHEN** `USERPROFILE` is `C:\Users\me` on Windows
- **THEN** the state directory is `C:\Users\me\.jetbrains\air\megachat`

#### Scenario: The variable selects another directory
- **WHEN** `MEGACHAT_HOME` is `/tmp/x`
- **THEN** the state directory is `/tmp/x`

#### Scenario: The directory of a project scope
- **WHEN** the home directory of the user is `/Users/me` on macOS, `MEGACHAT_HOME` is not set, and the project directory is `/work/app`
- **THEN** the state directory is `/Users/me/.jetbrains/air/megachat/projects/app-70467eff2e0a`

### Requirement: State that the copy does not take
The daemon MUST NOT copy state that a running daemon owns. Until that daemon stops, a client MUST use it. A directory with an explicit path MUST NOT receive a copy. The state directory of a project scope MUST NOT receive a copy, and its client MUST NOT use the daemon of an earlier directory.

Tests: `test/home.test.mjs`

#### Scenario: An earlier directory of a running daemon
- **WHEN** a running daemon owns the earlier directory
- **THEN** the copy fails with the code `legacyLocked`, the new directory has no `conversation.sqlite`, and the earlier directory has no `MIGRATED_TO` file
- **AND** after that daemon stops, the copy takes the earlier directory

#### Scenario: A project scope
- **WHEN** the earlier directory holds a conversation with the row "Earlier", and a daemon starts with `MEGACHAT_PROJECT` for `app`
- **THEN** the conversation of the project scope does not hold "Earlier", and the earlier directory has no `MIGRATED_TO` file

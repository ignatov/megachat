# state-directory Specification

## Purpose
The state directory holds the conversation and the state of Megachat for one user. All JetBrains products of the user share this directory and its one daemon.

## Requirements

### Requirement: Place of the state directory
The state MUST live in `~/.jetbrains/air/megachat/` for each user: `%USERPROFILE%\.jetbrains\air\megachat` on Windows. All JetBrains products of the user MUST share this directory, its daemon, and its conversation. `MEGACHAT_HOME` or the final command argument MAY select another directory for a test or development.

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

### Requirement: Content of the state directory
The directory MUST hold `conversation.sqlite`, `owner.sqlite`, `search.sqlite`, `workspace/`, and `daemon/` with the connection file and log. It MAY hold `settings.json` and `spend.json`. It MAY hold `sessions.sqlite`, the index of past sessions and the live table of the session files, only with the consent of the user. The name `memory.md` is reserved for learned memory that the user can edit. Megachat does not read it yet.

#### Scenario: The files of a running daemon
- **WHEN** a daemon runs on a state directory
- **THEN** the directory holds `conversation.sqlite`, `owner.sqlite`, `search.sqlite`, `workspace/`, and `daemon/` with the connection file and the log

### Requirement: Private modes of the state directory
The directories MUST be private to the user: mode 0700 for directories and 0600 for files on macOS and Linux.

Tests: `test/home.test.mjs`

#### Scenario: The modes of the daemon files
- **WHEN** a daemon takes the state directory `.jetbrains/air/megachat` and publishes its connection file on macOS or Linux
- **THEN** the state directory and the directory `daemon` have the mode 0700, and `daemon/connection.json` has the mode 0600

### Requirement: One daemon for one directory
Only one daemon MAY own a storage directory. A second daemon MUST fail at once. A second product MUST connect to the running daemon. A start that loses the race with a concurrent start MUST stop its own daemon.

Tests: `test/home.test.mjs`

#### Scenario: Two concurrent starts
- **WHEN** two starts run at the same time on one state directory, and then a third start runs
- **THEN** each start ends with the exit code 0, and the third start leaves the connection file of the running daemon unchanged

#### Scenario: A start that loses the race
- **WHEN** the daemon of a first start is slow before it takes the lock, and the daemon of a second start takes the directory
- **THEN** both starts end with the exit code 0, and the daemon of the first start ends

### Requirement: Wait of a start for its daemon
A start MUST wait for its daemon while the daemon process lives, at most 2 minutes. It MUST NOT stop after a count of attempts. A start MUST end at once when its daemon ends with an error. A daemon that finds another daemon on its directory MUST end with the exit code 3. When that other daemon does not answer, the start MUST start a daemon again after a delay. One start MUST make at most five daemon processes.

Tests: `test/home.test.mjs`

#### Scenario: A slow daemon
- **WHEN** the daemon of a start needs 11 seconds for its start
- **THEN** the start waits, ends with the exit code 0, and the daemon lives

#### Scenario: A daemon that ends with an error
- **WHEN** the daemon of a start ends with the exit code 1
- **THEN** the start ends with the exit code 1 in less than 5 seconds, says that it could not connect to its local daemon, and made one daemon process

#### Scenario: A second daemon on a directory
- **WHEN** a daemon runs on a state directory and the command `daemon` runs on the same directory
- **THEN** the second daemon ends with the exit code 3 in less than 5 seconds and says "Another Megachat daemon owns this directory"

#### Scenario: A daemon at its end
- **WHEN** another process holds the lock of the directory without a connection file, as a daemon at its end does
- **THEN** the start starts a daemon again, it makes at most five daemon processes, and only the last daemon lives after the lock is free

### Requirement: Copy of the conversation from an earlier directory
When the shared directory has no conversation, the daemon MUST copy the conversation once from an earlier directory: `~/Library/Application Support/JetBrains/AirMegachat` on macOS. `MEGACHAT_LEGACY_DIRS` MAY replace the list of earlier directories. An empty value gives an empty list.

Tests: `test/home.test.mjs`

#### Scenario: The earlier directory on macOS
- **WHEN** the home directory of the user is `/Users/me` on macOS and `MEGACHAT_LEGACY_DIRS` is not set
- **THEN** the list of earlier directories is `/Users/me/Library/Application Support/JetBrains/AirMegachat`

#### Scenario: An empty variable
- **WHEN** `MEGACHAT_LEGACY_DIRS` is an empty value
- **THEN** the list of earlier directories is empty

### Requirement: Content and mark of the copy
The copy MUST include committed WAL content and pass an integrity check before the daemon uses it. The search index MUST be rebuilt from the copy. The earlier files MUST stay in place with a `MIGRATED_TO` file that names the new directory. A marked directory MUST NOT be copied again.

Tests: `test/home.test.mjs`

#### Scenario: A row that is only in the WAL
- **WHEN** the earlier `conversation.sqlite` has the committed row "only in the WAL" only in its WAL file, and the new directory has a `search.sqlite`
- **THEN** the copy holds the row "only in the WAL", the new directory has no `search.sqlite`, the earlier `conversation.sqlite` stays, and the earlier directory has a `MIGRATED_TO` file that names the new directory

#### Scenario: A marked directory
- **WHEN** the daemon copied the conversation from an earlier directory, and the copy runs again with the same earlier directory
- **THEN** the second copy copies nothing

### Requirement: State that the copy does not take
The daemon MUST NOT copy state that a running daemon owns. Until that daemon stops, a client MUST use it. A directory with an explicit path MUST NOT receive a copy.

Tests: `test/home.test.mjs`

#### Scenario: An earlier directory of a running daemon
- **WHEN** a running daemon owns the earlier directory
- **THEN** the copy fails with the code `legacyLocked`, the new directory has no `conversation.sqlite`, and the earlier directory has no `MIGRATED_TO` file
- **AND** after that daemon stops, the copy takes the earlier directory

# Spec Delta

## ADDED Requirements

### Requirement: Check of a release
At its start and then every 24 hours, the daemon MUST run `git ls-remote --tags --refs` on `https://github.com/ignatov/megachat`, or on the value of `MEGACHAT_RELEASE_REPOSITORY`. git MUST get `GIT_HTTP_LOW_SPEED_LIMIT` `1000`, `GIT_HTTP_LOW_SPEED_TIME` `20` and `GIT_TERMINAL_PROMPT` `0`. The daemon MUST end git after 30 seconds.

Tests: `test/update.test.mjs`

#### Scenario: A repository with a higher release
- **WHEN** a daemon of the version `0.4.0` starts, and the repository has the tags `v0.3.0`, `v0.4.0`, `v0.5.0` and `v0.6.0-rc.1`
- **THEN** the daemon finds the release `0.5.0`

#### Scenario: The next check
- **WHEN** the first check found no higher release, and the repository gets the tag `v0.5.0`
- **THEN** the check 24 hours after the first check finds the release `0.5.0`

### Requirement: Release version
Only a tag `v<major>.<minor>.<patch>` MUST count as a release. A release MUST be available only when its version is higher than the version of the daemon. The daemon MUST compare its version without the part from `+`, so a build of a checkout MUST compare as its base version.

Tests: `test/update.test.mjs`

#### Scenario: A build of a checkout
- **WHEN** the daemon has the version `0.4.0+9.geb044cf`, and the highest release is `0.4.0`
- **THEN** no release is available

### Requirement: Failed check of a release
A check that fails, ends after its time limit or finds no release tag MUST write one line to the log of the daemon, and the next check MUST come after 1 hour. The user MUST NOT get a message.

Tests: `test/update.test.mjs`

#### Scenario: No repository
- **WHEN** `MEGACHAT_RELEASE_REPOSITORY` names a directory that does not exist
- **THEN** the log has one line about the failed check, the conversation has no new entry, and the next check comes after 1 hour

### Requirement: Notice of a release
While a higher release is available, `/health` of the daemon MUST give the field `update` with `available` and `notice`. The notice MUST be "A new release is available: <version> → <release>". `status` MUST print it (see the capability `launch`).

Tests: `test/update.test.mjs`, `test/launch.test.mjs`

#### Scenario: The notice
- **WHEN** a daemon of the version `0.4.0` found the release `0.5.0`
- **THEN** `/health` gives `update` `{"available":"0.5.0","notice":"A new release is available: 0.4.0 → 0.5.0"}`

### Requirement: Copy that updates itself
Only a daemon whose package root has no `.git` and is the directory `_npx/<one directory>/node_modules/megachat` MUST stop itself for an update, and only with `update.auto` on. Each other copy and a daemon with `update.auto` off MUST only give the notice.

Tests: `test/update.test.mjs`

#### Scenario: A git checkout
- **WHEN** a daemon of a git checkout found a higher release at 03:00, with `update.auto` on and no work
- **THEN** the daemon keeps running, and `/health` gives the notice

#### Scenario: The setting is off
- **WHEN** a daemon of a copy in `_npx/abc/node_modules/megachat` found a higher release at 03:00 with no work, and `update.auto` is `false`
- **THEN** the daemon keeps running, and `/health` gives the notice

### Requirement: Work at the automatic stop
The daemon MUST stop itself for an update only when no turn runs, no input and no morning report waits for its turn, each child run is in a terminal state, and no permission request and no stop request is open.

Tests: `test/update.test.mjs`

#### Scenario: A child task runs
- **WHEN** a copy of npx found a higher release at 03:00, and a Claude child runs
- **THEN** the daemon keeps running, and after the end of the child the next check 10 minutes later stops it

### Requirement: Time of the automatic stop
With `workday.enabled` on, the daemon MUST stop itself for an update only while the conversation sleeps (see the capability `workday`). With `workday.enabled` off, the local time of `workday.timezone` MUST be from 01:00 to before 05:00, and the last turn of the user MUST have ended 30 minutes or more before.

Tests: `test/update.test.mjs`

#### Scenario: The night window
- **WHEN** `workday.enabled` is off, a copy of npx found a higher release at 23:00, and the last turn of the user ended at 22:00
- **THEN** the daemon keeps running at 00:50, and the check at 01:00 stops it

#### Scenario: The working day
- **WHEN** `workday.enabled` is on with `workday.end` `19:00` and `workday.idleMinutes` `30`, and the last turn of the user ended at 19:10
- **THEN** the daemon keeps running at 19:30, and the check at 19:40 stops it

### Requirement: Checks of the conditions
While a higher release is available and the daemon can stop itself, the daemon MUST check the conditions directly after the check of the release, and then every 10 minutes.

Tests: `test/update.test.mjs`

#### Scenario: A turn at night
- **WHEN** the conditions are true at 01:00 except a turn that runs, and the turn ends at 01:05
- **THEN** the check at 01:40 stops the daemon, after the 30 minutes since the turn

### Requirement: Automatic stop
The automatic stop MUST record the stop in the state, send the event `update` with `from` and `to` on each event stream, and then stop the daemon as the command `stop` does. The admitted work MUST stay. The daemon MUST NOT start a daemon, `npx`, `npm` or a copy of Megachat.

Tests: `test/update.test.mjs`

#### Scenario: The stop
- **WHEN** a copy of npx of the version `0.4.0` stops itself for the release `0.5.0`
- **THEN** each event stream gets `{"type":"update","value":{"from":"0.4.0","to":"0.5.0"}}`, the daemon exits with the code 0, the connection file is gone, and no process of Megachat runs for the state directory

### Requirement: Stop without an update
When the daemon after an automatic stop has a version that is not higher than the version of that stop, it MUST log one line and MUST NOT stop itself again for that release or a lower one. A higher release MUST be able to stop it.

Tests: `test/update.test.mjs`

#### Scenario: The old copy starts again
- **WHEN** a daemon of `0.4.0` stopped itself for `0.5.0`, and the next daemon has the version `0.4.0` again
- **THEN** that daemon keeps running at 03:00 with no work, gives the notice for `0.5.0`, and the log has one line that the update to `0.5.0` did not install it

### Requirement: Recorded version
The state MUST hold the version of the last daemon that opened it. A state without a recorded version MUST get the version of the daemon with no message. A lower version or the same base version MUST give no message.

Tests: `test/update.test.mjs`

#### Scenario: An earlier state
- **WHEN** a daemon of `0.5.0` opens a state of a daemon of `0.4.0` without the field `update`
- **THEN** the state records `0.5.0`, and the next turn of the user gets no message about an update

### Requirement: Message after an update
When the base version of the daemon is higher than the recorded version, the next turn of the user or the next morning report, whichever comes first, MUST start with a fixed message: "Megachat updated from <old> to <new>.", then the release notes. A turn of a child result MUST NOT take it.

Tests: `test/update.test.mjs`

#### Scenario: The next turn of the user
- **WHEN** a daemon of `0.5.0` opens a state that recorded `0.4.0`, and then the user sends "hello"
- **THEN** the chat shows a message of Megachat with "Megachat updated from 0.4.0 to 0.5.0." and the notes of `0.5.0`, then the reply to "hello", and a later turn gets no such message

#### Scenario: The morning report comes first
- **WHEN** a daemon of `0.5.0` opens a state that recorded `0.4.0`, and the morning report is the next turn
- **THEN** the message comes directly before the turn of the report

### Requirement: Source of the release notes
The daemon MUST take the notes from the `body` of each GitHub release after the recorded version up to its own version, the newest first, from `MEGACHAT_RELEASE_NOTES_URL` or the API of the repository, with a time limit of 10 seconds and at most 40 lines and 8000 characters.

Tests: `test/update.test.mjs`

#### Scenario: Two releases
- **WHEN** the recorded version is `0.4.0`, the daemon has `0.6.0`, and the server gives the releases `v0.6.0`, `v0.5.0` and `v0.4.0`
- **THEN** the message has the notes of `0.6.0` and then of `0.5.0`, and no notes of `0.4.0`

### Requirement: Message without release notes
When the server of the notes gives no valid answer in 10 seconds, the message MUST give the address of the release instead of the notes, and the log MUST get one line. The daemon MUST NOT ask again.

Tests: `test/update.test.mjs`

#### Scenario: No answer
- **WHEN** a daemon of `0.5.0` opens a state that recorded `0.4.0`, and the server of the notes does not answer
- **THEN** the message has "Megachat updated from 0.4.0 to 0.5.0." and `https://github.com/ignatov/megachat/releases/tag/v0.5.0`

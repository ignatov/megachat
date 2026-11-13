# Spec Delta

## ADDED Requirements

### Requirement: Note of a new release
When a daemon of a copy of npx with `update.auto` off finds a release that is higher than its version, it MUST write one note of Megachat about the release into the conversation. The note MUST be a note as the capability `session-notes` gives it: a write with no model request, and no turn. A daemon that is no copy of npx, and a daemon with `update.auto` on, MUST NOT write the note.

Tests: `test/update.test.mjs`

#### Scenario: A copy of npx with update.auto off
- **WHEN** a daemon of `0.4.0` in `_npx/0123abcd/node_modules/megachat` with `update.auto` `false` finds the tag `v0.5.0`, and no turn runs
- **THEN** the conversation gets one entry of the kind `air.megachat.note` that starts with "Megachat 0.5.0 is available.", the state has no input, and the model got no request

#### Scenario: A git checkout
- **WHEN** a daemon of `0.4.0` that is no copy of npx finds the release `0.5.0`
- **THEN** the conversation gets no note, and `/health` gives the notice "A new release is available: 0.4.0 → 0.5.0"

#### Scenario: The setting is on
- **WHEN** a copy of npx with `update.auto` `true` finds the release `0.5.0` at 12:00
- **THEN** the conversation gets no note

### Requirement: Text of the note of a release
The note MUST be the fixed text "Megachat <release> is available. This chat runs <version>. To install it, restart the IDE when no task runs. Or ask me to turn on update.auto: then Megachat installs each new release when no work runs. What is new: <address>". The version MUST be the base version of the daemon. The address MUST be the GitHub release of the new release.

Tests: `test/update.test.mjs`

#### Scenario: A build with metadata
- **WHEN** a copy of npx of the version `0.4.0+3.g1a2b3c4` finds the release `0.5.0`
- **THEN** the note has "This chat runs 0.4.0." and ends with "What is new: https://github.com/ignatov/megachat/releases/tag/v0.5.0"

### Requirement: Time of the note of a release
The note MUST go out only when no turn runs, no run of the main conversation is live, no input waits, and the conversation does not sleep (see the capability `workday`). Else the note MUST wait, and the daemon MUST try again at each check of the conditions of the update, every 10 minutes.

Tests: `test/update.test.mjs`

#### Scenario: A turn runs
- **WHEN** the check finds the release `0.5.0` at 10:00 while a turn runs, and the turn ends at 10:03
- **THEN** no note comes during the turn, and the check at 10:10 writes the note after the reply of the turn

#### Scenario: The conversation sleeps
- **WHEN** `workday.enabled` is on, and the check finds the release `0.5.0` at 22:00 while the conversation sleeps
- **THEN** no note comes during the night, and the first check after the start of the working day at 09:00 writes the note

### Requirement: One note for each release
The state MUST record the release of the last note in the field `noted` of `update`. The daemon MUST NOT write a note for that release or a lower one, also after a restart. A higher release MUST get its own note. A state without the field MUST count as a state with no note.

Tests: `test/update.test.mjs`

#### Scenario: The next check and a restart
- **WHEN** a daemon of `0.4.0` wrote the note of `0.5.0`, the check 24 hours later finds `0.5.0` again, and then the next daemon of `0.4.0` finds `0.5.0`
- **THEN** the conversation has one note of `0.5.0`, and the state records `noted` `0.5.0`

#### Scenario: A higher release
- **WHEN** the state records `noted` `0.5.0`, and the check finds the release `0.6.0`
- **THEN** the conversation gets one note that starts with "Megachat 0.6.0 is available.", and the state records `noted` `0.6.0`

#### Scenario: An earlier state
- **WHEN** a daemon of a copy of npx opens a state whose field `update` has no `noted`, and finds the release `0.5.0`
- **THEN** the conversation gets one note of `0.5.0`

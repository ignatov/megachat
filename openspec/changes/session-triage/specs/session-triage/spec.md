# Spec Delta

## ADDED Requirements

### Requirement: Triage tool
The main agent MUST have the read-only tool `agents_triage`. It MUST put each row of `agents_running` into one bucket, in this order: `needs_you` (status `waiting_for_user` or `waiting_for_permission`), `stuck`, `working`, `abandoned`, `quiet`. It MUST change nothing, hold no state and make no model request.

Tests: `test/triage.test.mjs`

#### Scenario: One bucket for each row
- **WHEN** the view has a session that waits for a permission, a session with the status `stuck`, a session with the status `working`, and a session with the status `idle` since 1 hour
- **THEN** the buckets are `needs_you`, `stuck`, `working` and `quiet`, and the result gives a count of 1 for each

### Requirement: Abandoned sessions
A row MUST be `abandoned` when its status is `idle` and its last activity is `ABANDONED_MS` (72 hours) ago or more. A row without a last activity MUST NOT be `abandoned`. A row MUST give `idleMs`, the time since its last activity.

Tests: `test/triage.test.mjs`

#### Scenario: The limit of 72 hours
- **WHEN** two sessions have the status `idle`, one since 72 hours and one since 71 hours 59 minutes
- **THEN** the first is `abandoned` with `idleMs` 259200000, and the second is `quiet`

#### Scenario: A silent session with an open step
- **WHEN** a session has the status `stuck` since 100 hours
- **THEN** its bucket is `stuck`, not `abandoned`

### Requirement: Order of the triage rows
The rows MUST be in the order of the buckets, then the oldest last activity first. The result MUST give the count of each bucket.

Tests: `test/triage.test.mjs`

#### Scenario: Old rows first inside a bucket
- **WHEN** two sessions are `quiet`, with the last activity 2 hours and 10 hours ago
- **THEN** the session of 10 hours is first

### Requirement: Possible duplicates
A row MUST give `possibleDuplicates`, the session IDs of the other rows whose titles share at least 2 words of 4 letters or more, and the shared words are at least half of the shorter set. The directory MUST NOT count. A row without a title MUST have no duplicate. The tool MUST say that the field is a guess.

Tests: `test/triage.test.mjs`

#### Scenario: One topic in two projects
- **WHEN** a session of `/work/json-profiler` has the title "Letter to Mitchell about the podcast", a session of `/work/ultimate` has the title "Mitchell podcast letter draft", and a third session has the title "Fix the build"
- **THEN** the first two list each other in `possibleDuplicates`, and the third has none

### Requirement: Triage without the consent
Without the consent `sessions.index` (see the capability `session-index`), each row MUST be `unread` and the result MUST tell the user to give the consent. The tool MUST NOT change the consent.

Tests: `test/triage.test.mjs`

#### Scenario: No consent
- **WHEN** the setting `sessions.index` is off and Claude Code runs in Terminal
- **THEN** the row is `unread`, the result names the setting `sessions.index`, and the setting is still off

### Requirement: Triage takes no action
The tool MUST NOT stop, resume, or write into a session. The instructions MUST tell the main agent to name no command that closes a session of another CLI, and to offer `agents_stop` only for an orphan (see the capability `stop-sessions`).

Tests: `test/triage.test.mjs`

#### Scenario: A live terminal session
- **WHEN** the triage lists an `abandoned` session in a terminal with the state `active`
- **THEN** no signal goes to it, and the instructions give no stop for it

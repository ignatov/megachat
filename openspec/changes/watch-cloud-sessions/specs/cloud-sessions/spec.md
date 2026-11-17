# Spec Delta

## Purpose

Megachat watches the cloud sessions of the Central login of the user through the plugin `airc` of JetBrains Central.
The main agent lists them with a tool, and the daemon writes a note in the chat when a cloud session finished, failed
or waits for the user.

## ADDED Requirements

### Requirement: Default of the cloud sessions
The setting `cloud.sessions` MUST be off by default. Off MUST run no `central plugins` and no `airc`, MUST give no tool
`agents_cloud`, and MUST start no timer. A `settings.json` without the key MUST open with the default.

Tests: `test/cloud-sessions.test.mjs`, `test/settings.test.mjs`

#### Scenario: The cloud sessions are off by default
- **WHEN** `settings.json` has no key `cloud.sessions`, and 10 minutes go by
- **THEN** `cloud.sessions` is `off`, Megachat looks for `airc` 0 times and reads the list 0 times, the tools of the main agent have no `agents_cloud`, and no timer of the reads runs

#### Scenario: The accepted values
- **WHEN** the agent sets `cloud.sessions` to `true`, or to ` Off `
- **THEN** the value is `on`, or `off`, and the value `soon` is refused

### Requirement: Detection of airc
With `cloud.sessions` on, Megachat MUST run `central plugins` at the start of the daemon and at each set or reset of
`cloud.sessions`. It MUST take the line of the plugin `airc` with the state `active`, and use the `executable` of the
`manifest.json` in the directory of its `source`. Another state, a missing line or a missing executable MUST give no
`airc`.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: An active plugin
- **WHEN** `central plugins` prints the line `airc`, `0.1.3`, `active`, `present=true`, `origin=bundled`, `source=<directory>`, `hooks=plugin-loaded`, separated by tabs, and `<directory>/manifest.json` has the executable `./airc`
- **THEN** Megachat finds `<directory>/airc`

#### Scenario: A plugin that is not active
- **WHEN** the line has the state `disabled`, or `central plugins` prints no line of `airc`, or the executable is missing
- **THEN** Megachat finds no `airc`

### Requirement: Cloud sessions without airc
With `cloud.sessions` on and no `airc`, the main agent MUST get no tool `agents_cloud`, and the daemon MUST read no
list. The output of `agents_settings` with `get`, and of a set or a reset of `cloud.sessions`, MUST give
`cloudSessions` with `on`, and a `note` that names the missing plugin when `on` is false.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: No airc
- **WHEN** `cloud.sessions` is on, Megachat finds no `airc`, and the agent calls `agents_settings` with `get`
- **THEN** the output has `cloudSessions` with `on` `false` and the `note` "The cloud sessions stay off: Megachat found no active plugin airc of JetBrains Central. Run central plugins in a terminal to check it.", the tools have no `agents_cloud`, and the list is read 0 times

#### Scenario: The agent turns the cloud sessions on
- **WHEN** Megachat finds `airc`, and the agent sets `cloud.sessions` to `on`
- **THEN** the output has `cloudSessions` with `on` `true`, and the next turn has the tool `agents_cloud`

### Requirement: Tool of the cloud sessions
With `cloud.sessions` on and `airc` found, the tool `agents_cloud` MUST run `airc sessions --limit 50` and give
`sessions` with the fields that `airc` gives: `id`, `name`, `status`, `statusComment`, `agent`, `repositories`,
`updatedAt` and `taskId`. The tool MUST only read: it MUST NOT start, cancel or continue a cloud session.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: The list
- **WHEN** `airc` gives 3 cloud sessions, and the agent calls `agents_cloud`
- **THEN** the output has `sessions` with the 3 sessions and their fields, and `airc` got the arguments `sessions`, `--limit`, `50`

### Requirement: Filter of the tool
The argument `status` of `agents_cloud` MUST keep the sessions with that status, without regard to the case. `limit`
MUST be 1 to 50, with the default 20. `more` MUST be true when more sessions match than `limit` gives.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: A filter and the default limit
- **WHEN** `airc` gives 25 sessions with the status `RUNNING` and 1 session with the status `FINISHED`, and the agent calls `agents_cloud` with the status `finished`, and then with no argument
- **THEN** the first output has 1 session and `more` `false`, and the second output has 20 sessions and `more` `true`

### Requirement: Failed read of the list
A read MUST fail when `airc` ends with an exit code other than 0, runs for more than 30 seconds, or prints no JSON
array. The tool MUST then give an error with the exit code and the first line of the error output, at most 200
characters. The log MUST get one line without the output of `airc`. The next read MUST try again.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: airc ends with an error
- **WHEN** `airc` prints `no credential` to its error output and ends with the code 1, and the agent calls `agents_cloud`
- **THEN** the tool gives an error with the code 1 and the text `no credential`

#### Scenario: airc prints no list
- **WHEN** `airc` prints `{"error":true}` and ends with the code 0
- **THEN** the read fails, and a later read of a correct list gives the list

### Requirement: Reads of the list
With `cloud.sessions` on and `airc` found, the daemon MUST read the list at once, and then every 2 minutes while the
conversation is awake. While the conversation sleeps (`isSleeping`), the daemon MUST run no `airc`. Off MUST stop the
reads at once, also in the middle of a turn.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: Reads every 2 minutes
- **WHEN** the cloud sessions are on, and 5 minutes go by
- **THEN** the daemon reads the list 3 times

#### Scenario: A night
- **WHEN** `workday.enabled` is on, the working day ends at 19:00, the time is 20:00, and 1 hour goes by
- **THEN** the daemon reads the list 0 times

#### Scenario: Off stops the reads
- **WHEN** the agent sets `cloud.sessions` to `off`, and 5 minutes go by
- **THEN** the daemon reads the list no more

### Requirement: Statuses of a cloud note
A cloud session MUST get a note when its status changes to `FINISHED`, `USER_INPUT_REQUIRED`, `ERROR` or `ABORTED`.
Each other status MUST give no note. A session whose `updatedAt` is before the start of the watch MUST get no note. The
state MUST keep the start of the watch in `cloudSessions.since`, and off MUST remove it.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: The first read of the watch
- **WHEN** the watch starts at 12:00, and `airc` gives a session that finished at 11:00 and a session that runs
- **THEN** no session gets a note

#### Scenario: Changes after the start
- **WHEN** at a later read the running session has the status `FINISHED`, two new sessions have the statuses `USER_INPUT_REQUIRED` and `ERROR`, and three new sessions have the statuses `SUSPENDED`, `CANCELLED` and `ARCHIVED`, each with `updatedAt` after 12:00
- **THEN** one note names the first three sessions only

### Requirement: One note for each status
A cloud session MUST get one note for each status. The state MUST keep a record of each listed session in
`cloudSessions.records`: a hash of the session ID as the key, the status and the time of the read. A record MUST hold
no name and no session ID. Only another status between two notes MUST give a second note, also after a restart.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: No second note for the same status
- **WHEN** a session got a note for `FINISHED`, and two later reads give it with the status `FINISHED`
- **THEN** the session gets no second note

#### Scenario: A session that runs again
- **WHEN** a session got a note for `USER_INPUT_REQUIRED`, then has the status `RUNNING`, and then the status `FINISHED`
- **THEN** the session gets a second note for `FINISHED`

#### Scenario: A restart of the daemon
- **WHEN** a session got a note for `FINISHED`, and the daemon starts again on the same state
- **THEN** the session gets no second note

#### Scenario: A record without private data
- **WHEN** the session `cloud-7` with the name "Fix the parser" in `demo/demo-app` got a note
- **THEN** `cloudSessions` of the state does not hold `Fix the parser`, `cloud-7` or `demo-app`

### Requirement: Limits of the cloud records
The state MUST keep at most 200 records of the cloud sessions, none older than 30 days. A read MUST renew the time of
the record of a listed session after 1 day. A read that changes no record and writes no note MUST commit nothing.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: A read without a change
- **WHEN** a read gives the same sessions with the same statuses 2 minutes after the last read
- **THEN** the read commits nothing to the state

#### Scenario: Old records
- **WHEN** the records hold 210 sessions, and 5 of them were read 31 days ago
- **THEN** a read keeps 200 records, without the 5 old ones

### Requirement: Text of a cloud note
The sessions that need a note at one read MUST get one note, with one line for each session: the agent, the name on one
line, the first repository and the new status. A finished session MUST also give its results branch, and a failed
session its status comment. A note MUST have at most 10 such lines, then one line with the count of the others.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: Two sessions in one note
- **WHEN** the Claude Code session "Fix the parser" in `demo/demo-app` finished with the results branch `fix-parser`, and the Codex session "Add the tests" in `demo/demo-tool` has the status `ERROR` with the comment "The container stopped."
- **THEN** one note starts with "Megachat note: 2 cloud sessions changed their state.", has the line `- Claude Code, "Fix the parser" in demo/demo-app: it finished. The results are in the branch fix-parser.` and the line `- Codex, "Add the tests" in demo/demo-tool: it failed. The cloud says: The container stopped.`, and ends with "Megachat reads this from airc, the list of the cloud sessions of your Central login. Open the session in Air to see its work. Megachat gives one note for each session and status."

#### Scenario: Twelve sessions
- **WHEN** 12 sessions finish before one read
- **THEN** the note has 10 lines of sessions and the line `- 2 more cloud sessions. Ask "what runs in the cloud?" to see each session.`

### Requirement: Delivery of a cloud note
A cloud note MUST go out as a note about the agent sessions goes out (see the capability `session-notes`): with no
model request, never inside a run, and not as a turn. A cloud note that waits for the end of a turn MUST cause a read
at the end of that turn. While the conversation sleeps, no cloud note MUST go out.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: Two notes and the model
- **WHEN** a session finishes, and 2 minutes later another session finishes
- **THEN** the conversation has two entries of the kind `air.megachat.note`, and the model got no request

#### Scenario: A note during a turn
- **WHEN** a session finishes while a turn runs, and a read runs before the turn ends
- **THEN** no note comes during the turn, and the note comes after the reply of the turn

### Requirement: Rules of the cloud sessions
With the tool, the rules of the main agent MUST have one line that names `agents_cloud`, says that a note can tell
about a cloud session, and says that Megachat cannot start, cancel or continue one. With `cloud.sessions` on and no
`airc`, one line MUST say why there is no tool. With `cloud.sessions` off, the rules MUST NOT name the cloud sessions.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: The rules in the three states
- **WHEN** the rules are made with `cloud.sessions` off, on with `airc`, and on without `airc`
- **THEN** the first rules do not have the word `cloud`, the second have the line of `agents_cloud`, and the third have the line that says that Megachat found no `airc`

### Requirement: Private data of the cloud sessions
The names, the IDs and the repositories of the cloud sessions MUST go only into the conversation and into the data of
the morning report. The log of the daemon MUST get the count of the sessions of a note, and no name, no ID and no
repository.

Tests: `test/cloud-sessions.test.mjs`

#### Scenario: The log line of a cloud note
- **WHEN** a note names the session `cloud-7` "Fix the parser" in `demo/demo-app`
- **THEN** the log of the daemon gets one line with the count 1, and no `cloud-7`, no `Fix the parser` and no `demo-app`

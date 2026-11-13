# session-notes Specification

## Purpose
Megachat writes a short note in the chat when an agent session on this machine waits for the user for a long time: a session that is stuck, or a session outside Megachat that waits for a permission. The setting `sessions.notes` turns the notes on, and a note costs no model request.

## Requirements

### Requirement: Default of the notes
The setting `sessions.notes` MUST be off by default. Off MUST read no session file and no process table for the notes, and MUST start no timer. A `settings.json` without the key MUST open with the default.

Tests: `test/session-notes.test.mjs`, `test/settings.test.mjs`

#### Scenario: The notes are off by default
- **WHEN** `settings.json` has no key `sessions.notes`, a session waits for a permission for 1 hour, and 10 minutes go by
- **THEN** `sessions.notes` is `off`, Megachat reads the view of `agents_running` 0 times, no timer of the notes runs, and the chat has no note

#### Scenario: The accepted values
- **WHEN** the agent sets `sessions.notes` to `true`, or to ` Off `
- **THEN** the value is `on`, or `off`, and the value `soon` is refused

### Requirement: Consent of the notes
The notes MUST also need the consent `sessions.index`, because they read the session logs. Without it, they stay off. The output of `agents_settings` with `get`, and of a `set` or a `reset` of `sessions.notes` or `sessions.index`, MUST give `sessionNotes` with `on`, and a `note` that names the missing consent. A change of each of the two settings MUST apply at once, also in the middle of a turn.

Tests: `test/session-notes.test.mjs`

#### Scenario: The notes without the consent
- **WHEN** `sessions.notes` is on, `sessions.index` is off, and the agent calls `agents_settings` with `get`
- **THEN** the output has `sessionNotes` with `on` `false` and the `note` "The notes stay off: they read the session logs, and the consent sessions.index is off. Only the user can turn sessions.index on."

#### Scenario: The consent starts the first check at once
- **WHEN** `sessions.notes` is on, and the agent sets `sessions.index` to `on`
- **THEN** the output has `sessionNotes` with `on` `true`, and the first check reads the view one time at once

#### Scenario: Off stops the checks
- **WHEN** the agent sets `sessions.notes` to `off`, and 5 minutes go by
- **THEN** Megachat reads the view no more, and no timer of the notes runs

### Requirement: Check of the sessions
With both on, the daemon MUST check the view of `agents_running` every minute and at the end of each turn. A session MUST get a note when its status is `stuck`, or when it is a session outside Megachat with the status `waiting_for_permission` for 5 minutes or more (`PERMISSION_NOTE_MS` of `src/SessionNotes.mjs`), from the start of the wait in the process file of Claude Code.

Tests: `test/session-notes.test.mjs`

#### Scenario: A wait for a permission of 6 minutes
- **WHEN** a Claude Code session in a terminal has the status `waiting_for_permission` since 6 minutes ago, and another one since 4 minutes ago
- **THEN** the check gives a note for the first session only

#### Scenario: A stuck session
- **WHEN** a Codex session has the status `stuck` since 25 minutes ago
- **THEN** the check gives a note for the session

### Requirement: Sessions without a note
A child of Megachat that waits for a permission MUST get no note, because the chat shows its dialog. `waiting_for_user` and `idle` MUST give no note, because a finished turn is the usual state of a session.

Tests: `test/session-notes.test.mjs`

#### Scenario: A child of Megachat
- **WHEN** a child of Megachat has the status `waiting_for_permission` since 1 hour ago, and another child has the status `stuck` since 15 minutes ago
- **THEN** only the stuck child gets a note

#### Scenario: A finished turn
- **WHEN** a session has the status `waiting_for_user` since 1 hour ago, and another session has the status `idle` since 2 hours ago
- **THEN** no session gets a note

### Requirement: Start of a status for the notes
The view MUST give the start of the status (`statusSince`) to the notes: the start of the wait in the process file, or the last log write of a stuck session. The output of the tool MUST NOT give it.

Tests: `test/session-logs.test.mjs`

#### Scenario: The start of a wait and of a stuck step
- **WHEN** the process file of a Claude Code session says `permission prompt` since 20 minutes ago, and the log of another session has an open step and its last write 20 minutes ago
- **THEN** the view gives each of the two sessions the `statusSince` of 20 minutes ago, a working session gets null, and no row of the output of `agents_running` has `statusSince`

### Requirement: One note for each state
A session MUST get one note for each state. The state MUST keep a record of each sent note in `sessionNotes.records`: a hash of the agent, the session ID and the process as the key, the status, the start of the status (`since`), `left`, and the time of the note. A record MUST hold no title, no path and no session ID.

Tests: `test/session-notes.test.mjs`

#### Scenario: No second note for the same wait
- **WHEN** a session got a note for a wait for a permission, and it still waits 20 minutes later
- **THEN** the session gets no second note

#### Scenario: A record without private data
- **WHEN** the session `session-10` in `/work/demo-app` with the title "Fix the parser" got a note
- **THEN** `sessionNotes` of the state does not hold `Fix the parser`, `demo-app`, `session-10` or `/work`

### Requirement: A second note after the end of a state
A view that shows the session in another status, or with another start, MUST set `left`. Only a new start after `left` MUST give a second note. So a reading that comes and goes, and a restart of the daemon, give no second note for the same wait.

Tests: `test/session-notes.test.mjs`

#### Scenario: A reading that comes and goes
- **WHEN** a session with a note reads as `working` one time, and then waits again with the same start
- **THEN** the record gets `left`, then loses it, and the session gets no second note

#### Scenario: A restart of the daemon
- **WHEN** the daemon starts again on the same state 30 minutes later, and the session still waits
- **THEN** the session gets no second note

#### Scenario: A new wait after the end of the first one
- **WHEN** the session answers its permission prompt, reads as `working`, and then waits again
- **THEN** the session gets a new note 5 minutes after the start of the new wait

### Requirement: Limits of the records
The state MUST keep at most 200 records, none older than 30 days. A check that changes no record and writes no note MUST commit nothing.

#### Scenario: A check without a change
- **WHEN** a check finds no session that needs a note, and no record changes
- **THEN** the check commits nothing to the state

### Requirement: Text of a note
The sessions that need a note at one check MUST get one note, with one line for each session: the agent, the base name of the project directory, the title on one line, the state and how long. A note MUST have at most 10 such lines, and then one line with the count of the other sessions. The text MUST say that the state is a reading of the logs and of the process files, not a message of the agent.

Tests: `test/session-notes.test.mjs`

#### Scenario: Two sessions in one note
- **WHEN** a Claude Code session in `/work/demo-app` with the title "Fix the parser" waits for a permission for 6 minutes, and a pi session in `/work/demo-notes` with the title "Read the notes" is stuck for 40 minutes
- **THEN** one note starts with "Megachat note: 2 agent sessions on this machine may wait for you.", has the line `- Claude Code in demo-app, "Fix the parser": it seems to wait for a permission, for 6 min.` and a line for the pi session, and ends with "Megachat reads this from the session logs and from the process files of Claude Code. It is not a message of the agent, so look at the session before you act. Megachat gives one note for each session and state."

#### Scenario: Twelve sessions
- **WHEN** 12 sessions are stuck at one check
- **THEN** the note has 10 lines of sessions and the line `- 2 more sessions. Ask "what is running now?" to see each session.`

### Requirement: Note without a model request
A note MUST be a fixed text from `resources/Megachat.properties`, and it MUST cost no model request. The daemon MUST write it as a write submission of Pi Durable (`type: "write"`): an entry of the kind `air.megachat.note` with one message of the assistant, the provider `megachat` and no usage. Pi Durable appends such an entry at once and starts no run.

Tests: `test/session-notes.test.mjs`

#### Scenario: A note and the model
- **WHEN** two sessions get a note, and a third session gets a note 2 minutes later
- **THEN** the conversation has two entries of the kind `air.megachat.note`, and the model got no request

### Requirement: Commit of a note
The commit of the write MUST check that no turn runs, that no run of Pi Durable is live and that its inbox is empty, so the note never lands inside a run. Else the note MUST wait for the next check, and its records MUST NOT change.

Tests: `test/session-notes.test.mjs`

#### Scenario: A note during a turn
- **WHEN** a session becomes stuck while a turn runs, and two checks run before the turn ends
- **THEN** no note comes during the turn, and the note comes after the reply of the turn

### Requirement: A note is not a turn
A note MUST NOT be a turn: it MUST make no input, MUST NOT end the idle time of the working day, MUST start no window of keep-alive requests, and MUST end no prompt suggestion. A keep-alive request MUST hold a note as a turn sends it, and then its own user message. After a restart, a note MUST NOT stand for the last model request, because it is none.

Tests: `test/session-notes.test.mjs`

#### Scenario: A keep-alive request after a note
- **WHEN** the conversation ends with a note, and the daemon sends a keep-alive request
- **THEN** the request ends with the note and then a message of the user, and the time of the last model request is the time of the last message that is not a note

#### Scenario: A note at the start of the working day
- **WHEN** a note comes at the start of the working day
- **THEN** the state has no input and no current turn

### Requirement: Notes while the conversation sleeps
While the conversation sleeps (`isSleeping`), no note MUST go out. The records MUST still follow the states. A session that still waits when the conversation wakes, at the start of the working day or at a turn of the user, MUST get its note then. A wait that ended while the conversation slept MUST give no note.

Tests: `test/session-notes.test.mjs`

#### Scenario: A night and the next working day
- **WHEN** at 22:00 the working day is over, a Claude Code session waits for a permission, and a stuck session ends its step during the night
- **THEN** no note goes out during the night, and at 09:00 one note comes for the session that still waits, without the session that ended its step

### Requirement: Note in the client and in the model request
Each view MUST get a note at once as an `agent_message_chunk` with the message ID `megachat-entry-<entry>`, never in the message of a stream. The replay MUST show it. The next model request of the main agent MUST hold it as a message of the assistant.

Tests: `test/session-notes.test.mjs`

#### Scenario: An open view and a new view
- **WHEN** a client has an open view, and a session gets a note
- **THEN** the open view gets the note at once as an `agent_message_chunk` with a message ID that matches `megachat-entry-<number>`, and the replay of a new view shows it with the same message ID

#### Scenario: The next turn of the user
- **WHEN** a note came after a turn, and the user sends "What now?"
- **THEN** the model request holds the note as a message of the assistant that starts with "Megachat note:", and a message of the user follows it

### Requirement: Rules and setup of the notes
The rules of the main agent MUST say in one line what a note is, that it is no request, and the value of the notes. The setup MUST NOT ask for `sessions.notes`. The offer of `sessions.notes` MUST be open only when `sessions.index` is on (see the capability `setting-offers`).

Tests: `test/session-notes.test.mjs`, `test/setting-offers.test.mjs`

#### Scenario: The rules with the notes off
- **WHEN** `sessions.notes` is off
- **THEN** the rules of the main agent have the line that says what a note is, with the value `off` of the setting

#### Scenario: The order of the setup
- **WHEN** a test reads `resources/instructions-onboarding.md`, and the onboarding is `done` in the mode `ghost`
- **THEN** the setup rules do not name `sessions.notes`, the rules have no line of `sessions.notes` while `sessions.index` is off, and they have it after `sessions.index` is on

### Requirement: Private data of a note
The note MUST go only into the conversation. The log of the daemon MUST get one line with the count of the sessions of a note, and no title and no project.

#### Scenario: The log line of a note
- **WHEN** a note names two sessions
- **THEN** the log of the daemon gets one line with the count 2, and no title and no project of the two sessions

### Requirement: State with a note in v0.3.0
A daemon of v0.3.0 MUST open a state with a note and its records. It shows the note as a reply, sends it to the model as a message of the assistant, and keeps the records, because it keeps each field of the state that it does not know. It keeps `sessions.notes` in `settings.json`. This build MUST then send no second note for the same wait.

Tests: `test/session-notes.test.mjs`

#### Scenario: Back and forth with v0.3.0
- **WHEN** this build writes a note, a daemon of v0.3.0 opens the state, runs a turn and sets `reply.length`, and then this build opens the state again
- **THEN** v0.3.0 shows the note, sends it to the model, and keeps `sessionNotes` and `sessions.notes` `on`, and this build sends no second note

### Requirement: Anthropic request after a note
A turn after a note, a keep-alive request with a note at its end, and a summary request MUST reach the Anthropic provider of pi-ai with a body whose last message other than a system message is a message of the user. A real run through Central on 2026-11-12 with Claude Opus 5.5 answered each of these requests without an error, and the turn after the note read the cached prefix.

Tests: `test/session-notes.test.mjs`

#### Scenario: A keep-alive request after a note
- **WHEN** the conversation ends with a note, and the daemon builds a keep-alive request for Claude Opus 5.5
- **THEN** the roles of the body are `user`, `assistant`, `assistant` and `user`, and the last message is the keep-alive prompt

### Requirement: Form of a note in an Anthropic request
The note MUST reach the Anthropic provider of pi-ai as a message of the assistant with one text block and no thinking block.

Tests: `test/session-notes.test.mjs`

#### Scenario: The next turn after a note
- **WHEN** the conversation has a turn and a note, and the user sends "What now?"
- **THEN** the third message of the body has only the content `{ type: 'text', text }` with the text of the note

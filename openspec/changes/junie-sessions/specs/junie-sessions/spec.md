# Spec Delta

## Purpose

Megachat reads the sessions of Junie from the session folder of Junie, so each action that it has for a session of Claude Code, Codex or pi works for a session of Junie: to find, to read, to list while it runs, to see that it waits for the user, to archive, to restore and to continue.

## ADDED Requirements

### Requirement: Source of the Junie sessions
The sessions of Junie MUST be a source of the index of past sessions and of the live table of the session files (see the capabilities `session-index` and `session-logs`): the file `events.jsonl` in each folder of `~/.junie/sessions`. The session ID MUST be the name of the folder. A folder without `events.jsonl`, and each other file, MUST be no session file. Megachat MUST open each file of Junie read-only.

Tests: `test/junie-sessions.test.mjs`

#### Scenario: The files of the source
- **WHEN** `~/.junie/sessions` holds the folder `session-260101-120000-abcd` with `events.jsonl` and `transcript.md`, the folder `session-260101-130000-efgh` with only `transcript.md`, and the file `index.jsonl`
- **THEN** the source gives one session file, `session-260101-120000-abcd/events.jsonl`, with the session ID `session-260101-120000-abcd`

### Requirement: Project directory and title of a Junie session
The project directory of a session MUST be `projectDir` of `summary.json` in its folder, else `projectDir` of the line of the session in `index.jsonl`. It MUST NOT be the directory of a `CurrentDirectoryUpdatedEvent`. The title MUST be `taskName` of these files, or the name of a later `AgentTaskNameUpdatedEvent`, as a title of the agent. A session without a project directory MUST be a session of no listed directory.

Tests: `test/junie-sessions.test.mjs`

#### Scenario: The directory of the summary
- **WHEN** `summary.json` of a session has the `projectDir` `/work/demo-app` and the `taskName` "Fix the parser", and its event log has a `CurrentDirectoryUpdatedEvent` with the directory `/work`
- **THEN** the session has the `cwd` `/work/demo-app` and the title "Fix the parser"

#### Scenario: The directory of the index of Junie
- **WHEN** a session folder has no `summary.json`, and `index.jsonl` has a line with its session ID and the `projectDir` `/work/demo-notes`
- **THEN** the session has the `cwd` `/work/demo-notes`

#### Scenario: A session without a directory
- **WHEN** `/work/demo-app` is a listed directory, and neither file names the project directory of a session
- **THEN** the index holds no entry of the session, and its row in the live table has no `cwd`

### Requirement: Entries of a Junie session
The event log MUST give a user entry for a `UserPromptEvent` (its `presentablePrompt`, else its `prompt`), for a `UserResponseEvent` and for a `UserAsyncResponseEvent`, an assistant entry for the result of a turn and for a text block, and a tool entry for an ended block of a command, a tool, a file view, a file change or an MCP call. A block that Junie writes again MUST give one entry. A thought, a status line and a token count MUST give no entry.

Tests: `test/junie-sessions.test.mjs`

#### Scenario: A turn with a command
- **WHEN** the log holds a `UserPromptEvent` "Run the tests", three `TerminalBlockUpdatedEvent` lines of one step with the command `npm test` (in work, in work with output, and `COMPLETED`), a thought, and a `ResultBlockUpdatedEvent` "The tests pass." in the state `COMPLETED`
- **THEN** the session has three entries: the user entry "Run the tests", one tool entry with `npm test`, and the assistant entry "The tests pass."

#### Scenario: An answer to a question
- **WHEN** the log holds a `UserAsyncResponseEvent` with the question "Which branch?" and the answer "main"
- **THEN** the session has a user entry that holds "Which branch?" and "main"

### Requirement: Tool entry of a Junie session
A tool entry MUST hold the command or the text of the block, and the output of the block, with the size limit and the secret filter of each entry of the index (see the capability `session-index`). The key of an entry MUST come from the step ID of Junie, so a copy of the block in a fork of the session is the same entry, and a page of a read from the end gives the block one time.

Tests: `test/junie-sessions.test.mjs`

#### Scenario: A long output
- **WHEN** an ended command block has the command `npm test` and an output of 300,000 characters
- **THEN** the tool entry holds `npm test` and the start of the output, and it has the size limit of an entry

#### Scenario: A fork
- **WHEN** two session folders hold the same ended block with the same step ID
- **THEN** the index holds one entry of that block

### Requirement: Step of a Junie session
The event log MUST give the step of a session. A message of the user MUST give `prompt`. An event of the agent in the state `IN_PROGRESS` MUST give an open step, and the result of a turn MUST give `reply`. A `TaskState` (`COMPLETED` or `CANCELED`), a `CancelAgentEvent`, and an event of the agent in each other state but `INPUT_REQUIRED` MUST give `end`.

Tests: `test/junie-sessions.test.mjs`

#### Scenario: The steps of a turn
- **WHEN** the log holds a `UserPromptEvent`, a command block in the state `IN_PROGRESS`, a `ResultBlockUpdatedEvent` in the state `COMPLETED`, and a `TaskState` `COMPLETED`
- **THEN** the steps after these lines are `prompt`, an open step, `reply` and `end`

### Requirement: Step of a wait in a Junie session
In the state `INPUT_REQUIRED`, a command block with an approval request MUST give the step `permission`, and an ask request MUST give the step `question`. Each other event in that state MUST change no step: Junie writes a tip about every 30 seconds while it waits. The step MUST keep the time of its event, which is the start of the wait.

Tests: `test/junie-sessions.test.mjs`

#### Scenario: A permission and its answer
- **WHEN** the log holds a command block in the state `IN_PROGRESS`, the same block in the state `INPUT_REQUIRED` with an approval request, a `TipSuggestionCreatedEvent` in the state `INPUT_REQUIRED`, and the block in the state `IN_PROGRESS` again
- **THEN** the steps after these lines are an open step, `permission`, `permission` and an open step

#### Scenario: A question
- **WHEN** the log holds an `AskAsyncRequestUpdatedEvent` in the state `INPUT_REQUIRED`, and then a `UserAsyncResponseEvent`
- **THEN** the steps after these lines are `question` and `prompt`

### Requirement: Status of a Junie session that waits
A session of Junie with the step `permission` MUST have the status `waiting_for_permission`, and with the step `question` the status `waiting_for_user`, at each age of the last write, so that it does not become `stuck` or `idle`. A child of Megachat MUST keep the rule of the state of Megachat (see the capability `session-logs`).

Tests: `test/junie-sessions.test.mjs`

#### Scenario: A permission for 20 minutes
- **WHEN** the log of a Junie session in a terminal ends with a command block in the state `INPUT_REQUIRED` with an approval request 20 minutes ago
- **THEN** the status is `waiting_for_permission`, not `stuck`

#### Scenario: A question for 40 minutes
- **WHEN** the log of a Junie session in a terminal ends with an ask request in the state `INPUT_REQUIRED` 40 minutes ago
- **THEN** the status is `waiting_for_user`, not `stuck` and not `idle`

#### Scenario: An answered permission
- **WHEN** after the approval request, the log has the same block in the state `IN_PROGRESS` 1 minute ago
- **THEN** the status is `working`

### Requirement: Note of a Junie session that waits
The check of the notes (see the capability `session-notes`) MUST take the time of the event of the wait as the start of the wait of a Junie session outside Megachat, and it MUST give the note of a permission after 5 minutes. A wait for the answer to a question MUST give no note, as `waiting_for_user` gives none for each agent.

Tests: `test/session-notes.test.mjs`

#### Scenario: The note of a permission
- **WHEN** a Junie session in a terminal in `/work/demo-app` with the title "Fix the parser" waits for a permission for 6 minutes, and another Junie session waits for the answer to a question for 6 minutes
- **THEN** one note has the line `- Junie in demo-app, "Fix the parser": it seems to wait for a permission, for 6 min.`, and the other session gets no note

### Requirement: Log of a running Junie session
A process with the program name `junie` MUST be a session of the agent `junie` in `agents_running`, also the ACP process of an IDE or of Megachat. Its row MUST get its log by the rules of the capability `session-logs` for an agent without a process file: the `cwd` and the start time of the process. The row of a Junie child of Megachat MUST get the session of its run. A row without a certain log MUST have no status of a log.

Tests: `test/running.test.mjs`, `test/session-logs.test.mjs`

#### Scenario: A terminal session with its log
- **WHEN** Junie runs in a terminal in `/work/demo-app` since 10:00, and one Junie session with the `cwd` `/work/demo-app` has its first event at 10:00 and its last write 1 minute ago
- **THEN** the row has the `sessionId` and the title of that session, and the status of its log

#### Scenario: A Junie child of Megachat
- **WHEN** a Junie child of Megachat runs with the provider session `session-260101-120000-abcd`
- **THEN** its row has the `sessionId` `session-260101-120000-abcd` and Megachat as its owner

### Requirement: Session tools with the agent junie
`junie` MUST be an agent of `agents_sessions`, `agents_session_history`, `sessions` and `session_history`, and a search without an agent MUST include Junie when the index is on. Junie has no live provider, so each answer comes from the index or from the log. Without the index, a request for Junie MUST fail with a text that says that the index is off and names Junie.

Tests: `test/junie-sessions.test.mjs`, `test/session-index.test.mjs`

#### Scenario: A search for a reply of Junie
- **WHEN** the index holds a Junie session of `/work/demo-app` with the reply "The tests pass.", and the main agent calls `agents_sessions` for `/work/demo-app` with the query `tests pass` and no agent
- **THEN** the result has a page of the agent `junie` with that session and a snippet of the reply

#### Scenario: Junie without the index
- **WHEN** the index is off, and a child calls `sessions` with the agent `junie`
- **THEN** the tool fails with "The index of past sessions is off, so Megachat cannot read Junie sessions. Only the user can turn it on, with the setting sessions.index."

#### Scenario: A read from the end
- **WHEN** the main agent calls `agents_session_history` with the agent `junie` and the session ID `session-260101-120000-abcd`
- **THEN** the result has the last entries of the event log of that session

### Requirement: Continue of a Junie session of the user
`agents_resume` MUST take the agent `junie` for a session that the index holds in the listed directory of the call. A Junie child (see the capability `junie-child`) MUST load that session with `session/load` and get the prompt, and the run MUST NOT be a service session. Without the index, and for a session that the index does not hold in that directory, the call MUST fail and start no run.

Tests: `test/integration.test.mjs`

#### Scenario: An existing Junie session
- **WHEN** the index holds the Junie session `session-260101-120000-abcd` of the project, and the main agent calls `agents_resume` with the agent `junie` and that session ID
- **THEN** the child loads the session `session-260101-120000-abcd`, and the run is not a service session

#### Scenario: A session of another directory
- **WHEN** the index holds the session `session-260101-120000-abcd` only for the directory `/other`, and the call names the project
- **THEN** the call fails with the code `missing`, and no run starts

### Requirement: Archive of a Junie session
`agents_archive` MUST take a session of Junie with the rules of the capability `session-archive`: the card, the stop of an idle process of a terminal or of a multiplexer, the refused rows and the warnings. It MUST refuse a session that waits for a permission, and a session whose run in Megachat did not end. The card MUST give the command `junie --resume --session-id=<session ID>` to continue the session.

Tests: `test/archive.test.mjs`

#### Scenario: The card of a Junie session
- **WHEN** the user archives the Junie session `session-260101-120000-abcd` with the title "Fix the parser", and no process of the session lives
- **THEN** the card has the agent `junie`, the title "Fix the parser" and the command `junie --resume --session-id=session-260101-120000-abcd`

#### Scenario: A session that waits for a permission
- **WHEN** a process of a Junie session lives, and its log ends with an approval request
- **THEN** the archive refuses the session, and no file changes

### Requirement: Hide and restore of a Junie session
When no process of the session lives, Megachat MUST hide a session of Junie with one new line in `agent-workbench-archive-state.jsonl` of `~/.junie/sessions`, the file of Air: `sessionId`, `updatedAt`, `projectDir` and `archived` true. A restore MUST add such a line with `archived` false. The last line of a session MUST tell its state. Megachat MUST change no other line and no other file of Junie, and MUST write nothing when the state already matches.

Tests: `test/archive.test.mjs`

#### Scenario: The line of a hide
- **WHEN** Megachat archives the Junie session `session-260101-120000-abcd` of `/work/demo-app` at the time 1795000000000, and the file holds one line of another session
- **THEN** the file ends with the line `{"sessionId":"session-260101-120000-abcd","updatedAt":1795000000000,"projectDir":"/work/demo-app","archived":true}`, and the line of the other session stays

#### Scenario: Archive twice
- **WHEN** Megachat archives a Junie session whose last line in the file has `archived` true
- **THEN** the file keeps its size, and the answer is `already archived`

#### Scenario: Restore of a Junie session
- **WHEN** the user restores the archived Junie session `session-260101-120000-abcd`
- **THEN** the file ends with a line of that session with `archived` false, the card gets `restoredAt`, and no process starts

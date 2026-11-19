## ADDED Requirements

### Requirement: Idle child sessions in agents_list
`agents_list` MUST give `idleSessions`: one entry for each child session whose last run completed less than 24 hours ago, that is not closed, and whose directory is listed. A session whose last run failed, was cancelled or was interrupted MUST NOT be in it, and a session that works MUST NOT be in it. The entries MUST come the newest first, at most 20. The field `runs` MUST NOT change.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: Sessions of one project
- **WHEN** in the directory `app`, the session `child-a` completed 2 hours ago, `child-b` completed 30 hours ago, the last run of `child-c` failed 1 hour ago, `child-d` works, and `child-e` completed 1 hour ago and is closed
- **THEN** `idleSessions` has only `child-a`, and `runs` has the runs of the five sessions

#### Scenario: A directory that is no longer listed
- **WHEN** the session `child-a` completed in the directory `app` 2 hours ago, and the user removed `app` from the list
- **THEN** `idleSessions` is empty

#### Scenario: Many idle sessions
- **WHEN** 21 sessions in different directories completed in the last 24 hours
- **THEN** `idleSessions` has the 20 newest sessions, the newest first

### Requirement: Entry of an idle child session
An entry of `idleSessions` MUST have `childSessionId`, `agent`, `cwd`, `title` and `endedAt`, the end time of the last run as an ISO 8601 time in UTC. `title` MUST be the title of the oldest retained run of the session, else the first 80 characters of its prompt. The entry MUST have `lastTitle`, the title of the last run, only when it differs from `title`.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: A session with a follow-up
- **WHEN** the Claude session `child-a` in `app` has the run "Fix the login test" and then the follow-up "Add a test for the fix", which completed at `2026-11-19T10:00:00.000Z`
- **THEN** its entry is `childSessionId` `child-a`, `agent` `claude`, `cwd` `app`, `title` "Fix the login test", `lastTitle` "Add a test for the fix" and `endedAt` `2026-11-19T10:00:00.000Z`

#### Scenario: A session of one run
- **WHEN** the Codex session `child-f` has one completed run with the title "Update the README"
- **THEN** its entry has `agent` `codex`, `title` "Update the README", and no `lastTitle`

### Requirement: Continuation before a new session
The rules of the main agent MUST tell it to read `idleSessions` for the directory before `agents_spawn`. When the request continues the topic of one of these sessions, such as a follow-up, a fix of its result or the next step of the same task, the rules MUST tell it to use `agents_send` to that session. They MUST tell it to start a new session for an unrelated task, for a task that needs another agent, or when the user asks for a new session.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: The rules of the main agent
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "Before agents_spawn in a directory, read idleSessions of agents_list for that directory, unless a call in this turn gave it.", "such as a follow-up, a fix of its result or the next step of the same task, send it to that session with agents_send." and "Start a new session with agents_spawn for an unrelated task, for a task that needs another agent than the session has, or when the user asks for a new session."

### Requirement: Name of the continued session
The rules of the main agent MUST tell it to name the title of a continued session to the user in one short phrase, and to start a new session when the user objects. They MUST say that a session that works is not in `idleSessions` and gets a message of the user only with `agents_steer`, and that a session that is not in `idleSessions` gets no `agents_resume` without a request of the user.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: The phrase and the limits
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "When you continue a session, tell the user its title in one short phrase.", "When the user objects, start a new session.", "A child session that works now is not in idleSessions." and "Do not continue a session that is not in idleSessions with agents_resume unless the user asks."

### Requirement: Tool descriptions of a continuation
The description of `agents_spawn` MUST tell the agent to look at `idleSessions` of `agents_list` first and to continue a session of the same topic with `agents_send`. The description of `agents_send` MUST name a follow-up, a fix of the result and the next step of the same task. The description of `agents_list` MUST describe `idleSessions` with the limit of 24 hours. The description of `agents_resume` MUST keep "only when the user asks".

Tests: `test/continue-sessions.test.mjs`

#### Scenario: The descriptions of the tools
- **WHEN** a test reads the descriptions of `agents_spawn`, `agents_send`, `agents_list` and `agents_resume`
- **THEN** the description of `agents_spawn` names `idleSessions` and `agents_send`, the description of `agents_send` holds "a follow-up, a fix of its result or the next step of the same task", the description of `agents_list` holds "less than 24 hours ago", and the description of `agents_resume` holds "only when the user asks"

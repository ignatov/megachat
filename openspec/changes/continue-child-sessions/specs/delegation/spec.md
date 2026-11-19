## ADDED Requirements

### Requirement: Hot child sessions in agents_list
`agents_list` MUST give `hotSessions`: one entry for each child session that is not closed, whose directory is listed, and that works now or whose last run ended less than 24 hours ago, with each status. A session works when its last run did not end. The sessions that work MUST come first, the newest start first, then the idle sessions, the newest end first, at most 20. The field `runs` MUST NOT change.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: Sessions of one project
- **WHEN** in the directory `app`, the session `child-a` completed 2 hours ago, `child-b` completed 30 hours ago, the last run of `child-c` failed 1 hour ago, `child-d` works, and `child-e` completed 1 hour ago and is closed
- **THEN** `hotSessions` has `child-d`, `child-c` and `child-a` in this order, and `runs` has the runs of the five sessions

#### Scenario: A cancelled session and a session that waits
- **WHEN** in the directory `app`, the user stopped the last run of `child-h` 3 hours ago, and the task of `child-i` waits in the queue
- **THEN** `hotSessions` has `child-i` with the state `working` and the status `admitted`, then `child-h` with the state `idle` and the status `cancelled`

#### Scenario: A directory that is no longer listed
- **WHEN** the session `child-a` completed in the directory `app` 2 hours ago, and the user removed `app` from the list
- **THEN** `hotSessions` is empty

#### Scenario: Many idle sessions
- **WHEN** 21 sessions in different directories completed in the last 24 hours
- **THEN** `hotSessions` has the 20 newest sessions, the newest first

### Requirement: Entry of a hot child session
An entry of `hotSessions` MUST have `childSessionId`, `agent`, `cwd`, `title`, `state` (`working` or `idle`) and `status`, the status of the last run. An idle entry MUST have `endedAt`, the end of the last run in ISO 8601 UTC. `title` MUST be the title of the oldest retained run of the session, else the first 80 characters of its prompt. `lastTitle`, the title of the last run in the same form, MUST be there only when it differs from `title`.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: A session with a follow-up
- **WHEN** the Claude session `child-a` in `app` has the run "Fix the login test" and then the follow-up "Add a test for the fix", which completed at `2026-11-19T10:00:00.000Z`
- **THEN** its entry is `childSessionId` `child-a`, `agent` `claude`, `cwd` `app`, `title` "Fix the login test", `lastTitle` "Add a test for the fix", `state` `idle`, `status` `completed` and `endedAt` `2026-11-19T10:00:00.000Z`

#### Scenario: A session of one run
- **WHEN** the Codex session `child-f` has one completed run with the title "Update the README"
- **THEN** its entry has `agent` `codex`, `title` "Update the README", and no `lastTitle`

#### Scenario: A session that works
- **WHEN** the Claude session `child-d` in `app` has the completed run "Task d" and then the run "Next d", which runs
- **THEN** its entry has `title` "Task d", `lastTitle` "Next d", `state` `working`, `status` `running`, and no `endedAt`

### Requirement: Child session of a result
Each result in the report of a child result MUST have `childSessionId`, the child session of its run.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: The report of a completed task
- **WHEN** the task "Fix the login test" of a child session completes, and the daemon reports its result to the main agent
- **THEN** the result in the report has the `childSessionId` of that session

### Requirement: Continuation of a hot session
The rules of the main agent MUST define a hot child session: it works now, or its last run ended less than 24 hours ago. When a request continues the task of a hot session, such as a follow-up, a fix of its result or the next step of the same task, they MUST tell it to continue that session: with `agents_send` when it is idle, with `agents_steer` in the default mode when it works. They MUST NOT ask for a lookup before each `agents_spawn`.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: The rules of the main agent
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "A hot child session works now, or its last run ended less than 24 hours ago.", "such as a follow-up, a fix of its result or the next step of the same task, continue that session.", "Send the request to an idle session with agents_send." and "Give the request to a session that works now with agents_steer in the default mode", and it does not hold "Before agents_spawn in a directory"

### Requirement: Source of the child session
The rules of the main agent MUST name the results of `agents_spawn` and `agents_send` and the child result as the source of the child session ID, and `hotSessions` of `agents_list` when the context does not have it. They MUST tell it to start a new session for an unrelated task, for a task that needs another agent, or when the user asks for a new session.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: The source and the new session
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "The childSessionId of a session is in the result of agents_spawn and agents_send and in its child result. When your context does not have it, read hotSessions of agents_list." and "Start a new session with agents_spawn for an unrelated task, for a task that needs another agent than the session has, or when the user asks for a new session."

### Requirement: Name of the continued session
The rules of the main agent MUST tell it to name the title of a continued session to the user in one short phrase, and to start a new session when the user objects. They MUST say that a session that is not in `hotSessions` gets no `agents_resume` without a request of the user, and that `agents_steer` with the mode `interrupt` is only for a request of the user to stop or to redirect the current step.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: The phrase and the limits
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "When you continue a session, tell the user its title in one short phrase.", "When the user objects, start a new session.", "Do not continue a session that is not in hotSessions with agents_resume unless the user asks." and "Use agents_steer with mode=\"interrupt\" only when the user asks to stop or to redirect the current step"

### Requirement: Tool descriptions of a continuation
The description of `agents_spawn` MUST name the continuation of a hot session with `agents_send` or `agents_steer`. The description of `agents_send` MUST name a follow-up, a fix of the result and the next step. The description of `agents_list` MUST describe `hotSessions` with the limit of 24 hours. `agents_resume` MUST keep "only when the user asks". The error `childBusy` MUST name `agents_steer` for the next step of the task.

Tests: `test/continue-sessions.test.mjs`

#### Scenario: The descriptions of the tools
- **WHEN** a test reads the descriptions of `agents_spawn`, `agents_send`, `agents_list` and `agents_resume`, and the error `childBusy`
- **THEN** the description of `agents_spawn` names a hot child session, `agents_send` and `agents_steer`, the description of `agents_send` holds "a follow-up, a fix of its result or the next step of the same task", the description of `agents_list` holds "less than 24 hours ago", the description of `agents_resume` holds "only when the user asks", and the error holds "the next step of that task, use agents_steer"

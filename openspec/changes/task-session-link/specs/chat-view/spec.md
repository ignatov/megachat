# Spec Delta

## ADDED Requirements

### Requirement: Session of a child task row
When Air sent `asyncTaskSessions`, the row of a Claude or Codex run whose provider session is known MUST hold `session` with `agentId` (`claude` or `codex`), `sessionId` (the session of the provider) and `cwd` (the directory of the run), in each phase. The row of a pi run and the row of the import of past sessions MUST NOT hold it. A client without `asyncTaskSessions` MUST get no `session`.

Tests: `test/transcript.test.mjs`, `test/integration.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: A continued Codex session of the user
- **WHEN** the main agent calls `agents_resume` for the Codex session `active`, and a view with `asyncTasks` and `asyncTaskSessions` shows the chat
- **THEN** each `async_task_spawned` of the run holds `session` with the agent ID `codex`, the session ID `active` and the directory of the project

#### Scenario: A follow-up in a child session
- **WHEN** the main agent calls `agents_send` for the session of a Claude child that ended with the session `fake-session`
- **THEN** each `async_task_spawned` of the new run, also the row of the phase `queued`, holds `session` with the agent ID `claude` and the session ID `fake-session`, and the view gets no `async_task_progress` for the run

#### Scenario: A pi child
- **WHEN** a pi child with the title `README` runs, and a view with `asyncTaskSessions` shows the chat
- **THEN** its row has `outputFilePath` and no `session`, and the view gets no `async_task_progress` for it

#### Scenario: A client without the capability
- **WHEN** a view with `asyncTasks` and without `asyncTaskSessions` shows a running Claude child with the title `First`
- **THEN** its row has `outputFilePath` and no `session`, and the view gets no `async_task_progress`

### Requirement: Session of a new child after its start
When the provider session of a run comes after a view sent the row of the run, the view MUST send one `async_task_progress` that holds only `asyncTaskId` and `session`. The update MUST NOT hold `description`, `summary`, `lastToolName`, `usage` or `outputFilePath`, so the row keeps its look. A view MUST send at most one such update for a row.

Tests: `test/transcript.test.mjs`, `test/integration.test.mjs`

#### Scenario: A new Claude child
- **WHEN** the main agent starts a new Claude child with the title `First` in the project `project`, and a view with `asyncTaskSessions` shows the chat
- **THEN** the row `<run ID>:running` comes with `outputFilePath` and without `session`
- **AND** after the adapter gave the session `fake-session`, the view gets one `async_task_progress` with the ID `<run ID>:running` and `session` with the agent ID `claude`, the session ID `fake-session` and the directory of `project`, and no other field

#### Scenario: A new Codex child in a hidden session
- **WHEN** `children.showInProject` is `false` for the directory of a new Codex child, and a view with `serviceSessions` and `asyncTaskSessions` shows the chat
- **THEN** the view gets the registration of the session, and one `async_task_progress` with `session` with the agent ID `codex` and the provider session ID of the run

### Requirement: Session of a row after an attach
Each attach of a view with `asyncTaskSessions` MUST send each unfinished row again with `session` when the daemon knows it, and then one `async_task_progress` that holds only `asyncTaskId` and `session` for each such row. Air can keep an open task from before the attach and drop the second spawn, and the progress still gives it the session.

Tests: `test/transcript.test.mjs`

#### Scenario: A second load of the view
- **WHEN** a Claude child with the title `First` runs with the session `fake-session`, and the same client loads the session of the view again
- **THEN** the view sends `async_task_spawned` of `<run ID>:running` with `outputFilePath` and `session`, and then one `async_task_progress` with `session`

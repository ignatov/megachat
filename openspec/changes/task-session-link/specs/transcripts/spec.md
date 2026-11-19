# Spec Delta

## MODIFIED Requirements

### Requirement: Transcript file in the row of a run
The row of a run in the phase running or waiting for permission MUST name the file in `outputFilePath`, also when the row names the session of the run, so Air opens the file when it cannot open the session. A queued row MUST name no file. A client without `asyncTasks` MUST get no row.

Megachat MUST send no `async_task_progress` other than the one that gives the session of a row (see the capability `chat-view`): with a file, Air shows the file and not the progress.

Tests: `test/transcript.test.mjs`

#### Scenario: The rows of a running run and of a queued run
- **WHEN** the run `First` runs and the run `Second` is queued in the same project
- **THEN** the row of `First` has `outputFilePath` with the path of the transcript of `First`, and the file holds `Megachat child task: First`
- **AND** the row of `Second` has no `outputFilePath`

#### Scenario: A row with a session keeps its file
- **WHEN** the run `First` runs, and a view with `asyncTaskSessions` shows the chat
- **THEN** the row of `First` has `outputFilePath` with the path of the transcript of `First`, and the only `async_task_progress` of the row holds `session` and no other field than `asyncTaskId`

#### Scenario: A client without asyncTasks
- **WHEN** a client without the capability `asyncTasks` views the chat while a child runs
- **THEN** the client gets no `async_task` update

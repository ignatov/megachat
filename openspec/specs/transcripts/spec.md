# transcripts Specification

## Purpose
The daemon writes a plain text transcript of each child run. The user opens the transcript of a running child task from its row in the chat.

## Requirements

### Requirement: Transcript file of a child run
The daemon MUST write a transcript of each child run, from the start of its execution, to `transcripts/<run ID>.txt` in the state directory. The file MUST be plain text with the mode 0600, in a directory with the mode 0700.

Tests: `test/transcript.test.mjs`

#### Scenario: A private file
- **WHEN** a Claude child runs
- **THEN** its transcript has the mode 0600, and the directory of the transcripts has the mode 0700

### Requirement: Transcript file in the row of a run
The row of a run in the phase running or waiting for permission MUST name the file in `outputFilePath`, so Air opens it from the row. A queued row MUST name no file. A client without `asyncTasks` MUST get no row.

Megachat MUST send no `async_task_progress`: with a file, Air shows the file and not the progress.

Tests: `test/transcript.test.mjs`

#### Scenario: The rows of a running run and of a queued run
- **WHEN** the run `First` runs and the run `Second` is queued in the same project
- **THEN** the row of `First` has `outputFilePath` with the path of the transcript of `First`, and the file holds `Megachat child task: First`
- **AND** the row of `Second` has no `outputFilePath`

#### Scenario: A client without asyncTasks
- **WHEN** a client without the capability `asyncTasks` views the chat while a child runs
- **THEN** the client gets no `async_task` update

### Requirement: Content of a transcript
A transcript MUST hold the title, the agent, the project, the prompt of the task with each message of the user that the prompt holds, the messages of the child, each tool call by its name and title, a changed title and a failure of a tool call, each permission request, each message of the user that a steer added to the turn, and the end of the run with its status. This MUST be so for a Claude, a Codex and a pi child.

Tests: `test/transcript.test.mjs`

#### Scenario: A Claude child with tool calls
- **WHEN** a Claude child with the title `Read the README` reads `README.md`, runs `npm test`, which fails, and writes `The README says hello.`
- **THEN** the transcript starts with `Megachat child task: Read the README`, `Agent: Claude` and the project, and it holds the task, the tool calls `Read README.md` and `npm test`, the failure of `npm test`, the message of the child, and the end with the status `completed`

#### Scenario: A steer of a Codex child
- **WHEN** a steer adds the message `Use the second file too.` to the turn of a Codex child
- **THEN** the transcript holds `Agent: Codex`, the line of the steer with `Use the second file too.`, and the end with the status `completed`

#### Scenario: A permission request
- **WHEN** a child asks for the permission `Write a file`
- **THEN** the transcript holds `Waits for permission: Write a file` before the end of the run

### Requirement: Transcript of a continued pi run
A pi run that the daemon continues after a restart MUST continue its transcript with a note.

#### Scenario: A daemon restart during a pi run
- **WHEN** the daemon starts again during a pi run and continues the run
- **THEN** the transcript of the run gets a note, and the text of the continued run follows in the same file

### Requirement: Secret filter of a transcript
The secret filter of the session index MUST apply to each text. A part of a message MUST wait for the end of its paragraph, at most 16,000 characters, so the filter sees a secret that comes in two parts.

Tests: `test/transcript.test.mjs`

#### Scenario: A message with a secret
- **WHEN** a Claude child writes a message with a secret key
- **THEN** the transcript holds `The key is [secret removed] in the file.`, and it does not hold the key

### Requirement: Size limit of a transcript
A transcript MUST have at most 1,000,000 bytes. At the limit, it MUST end with a note and get no more text.

Tests: `test/transcript.test.mjs`

#### Scenario: A run that writes more than the limit
- **WHEN** the limit of a transcript is 400 bytes, and a child run writes more text
- **THEN** the file has at most 400 bytes, it ends with the note `The transcript reached its limit of 400 bytes. Megachat writes no more of this run to this file.`, and it holds no end of the run

### Requirement: Failure to write a transcript
A failure to write a transcript MUST go to the log one time for the run, without content. The run MUST go on without its transcript. No transcript text may go to the log.

Tests: `test/transcript.test.mjs`

#### Scenario: A file in the place of the directory
- **WHEN** a file is in the place of the directory of the transcripts, and a child reads the README
- **THEN** the run ends with the status `completed`, and the log has one line with the text `Megachat could not write the transcript of the child run <run ID>. The run continues without it:`, without the prompt or the text of the README

### Requirement: Removal of a transcript
The file MUST go away when the state drops its run. The start of the daemon MUST remove each file of a run that the state does not have.

Tests: `test/transcript.test.mjs`

#### Scenario: The state drops a run
- **WHEN** the state drops a run that has a transcript
- **THEN** the transcript file of that run goes away

#### Scenario: A file of an unknown run
- **WHEN** the directory of the transcripts holds the file of the run `00000000-0000-4000-8000-000000000000`, which the state does not have, and the transcripts start
- **THEN** that file goes away

## MODIFIED Requirements

### Requirement: Log of a failure
The log of the daemon MUST name each failure of a child run, of a request, of an automatic turn, and of the Central configuration. A log line about an error MUST NOT contain the message of that error, because the message can hold a credential. A failed Claude or Codex child run is the exception: its log entry holds the filtered answer of the agent and the filtered end of its error output (see the capability `secrets`).

Tests: `test/failure.test.mjs`, `test/error-output.test.mjs`

#### Scenario: A failed Central command
- **WHEN** the Central command prints "apiKey sk-secret-value" and exits with the code 7
- **THEN** the log gets the line "Central gave no configuration to the main agent: name=Error code=7", and no log line contains "sk-secret-value"

#### Scenario: The description of an error
- **WHEN** an error with the message "The key is sk-secret-value", the code `ENOENT` and the signal `SIGTERM` goes to the log
- **THEN** the log text starts with "name=Error code=ENOENT signal=SIGTERM", and it does not contain "sk-secret-value"

## ADDED Requirements

### Requirement: Error output of a child run in the memory
For each Claude or Codex child run, the daemon MUST keep the last 8,000 characters of the error output of the agent, as UTF-8 text, in its memory only. The state, the transcript and the conversation MUST NOT get this text, except the reason in the error of a run. The text MUST go at the end of the run. The limit of 1 MB of error output stays as it is (see the capability `child-scheduling`).

Tests: `test/error-output.test.mjs`, `test/parallel.test.mjs`

#### Scenario: A child that writes more than 1 MB
- **WHEN** the agent of a Claude child writes 1,048,577 bytes of error output and then waits
- **THEN** the run becomes `interrupted` with no continuation and the error "The child agent wrote more than 1 MB of error output", as before

#### Scenario: A long error output
- **WHEN** the agent writes the line `first line`, then 10,000 characters of error output, and exits with the code 3
- **THEN** the log holds at most 4,000 characters of the error output, and it does not hold `first line`

### Requirement: Failures that show the error output
Only a run that ends `interrupted` on a failure MUST show its error output: a request of the run, from `initialize` up to `session/prompt`, got an error answer, or the agent process ended by itself. Before the read, the daemon MUST wait for the end of the error output, at most 2 seconds, then stop the agent and wait at most 0.5 seconds more. The run service takes the wait as an option.

Tests: `test/error-output.test.mjs`

#### Scenario: An error answer of session/new
- **WHEN** the agent writes `Error: The model claude-test-model is not available.` to its error output and answers `session/new` with the error -32603
- **THEN** the run ends `interrupted`, and the log and the error of the run hold that line

#### Scenario: An agent that writes its error after its answer
- **WHEN** the agent answers `session/new` with the error -32603, and then writes `late reason` to its error output and exits
- **THEN** the log holds `late reason`

### Requirement: Runs that show no error output
A run that completes, a run that the agent ends with a stop reason, a cancel, a stop for a message of the user, a deadline, the limit of 1 MB and a stop of the daemon MUST NOT put the error output in the log or in the error of the run. These runs MUST NOT wait for the end of the error output, so they end as fast as before.

Tests: `test/error-output.test.mjs`

#### Scenario: A run that completes
- **WHEN** the agent writes `debug: the session starts` to its error output, and its run completes
- **THEN** no log line holds `debug: the session starts`, and the run has no error

#### Scenario: A cancel, a deadline, the limit and a stop of the daemon
- **WHEN** the user cancels a run, a deadline ends a run, a run writes more than 1 MB of error output, and the daemon stops during a run
- **THEN** no log line holds the error output of these runs, and the daemon does not wait for the end of their error output

### Requirement: Error output in the log
The log entry of a failed run MUST hold the last 4,000 characters of the filtered error output, or a line that says that the agent wrote none. Each line of this text MUST start with `  | `, so no line of the agent looks like a line of the daemon. An ANSI escape sequence and each other control character, except the tab and the line break, MUST go.

Tests: `test/error-output.test.mjs`

#### Scenario: Lines of the agent in the log
- **WHEN** the agent writes `\u001b[31mError: boom\u001b[0m` and a line that starts with a time and "The child run", and then exits with the code 3
- **THEN** the log holds `  | Error: boom` without the escape sequences, and the line of the agent starts with `  | `

#### Scenario: No error output
- **WHEN** the agent answers `session/new` with the error -32603, and it wrote no error output
- **THEN** the log entry of the run says that the child run wrote no error output

### Requirement: Answer of the agent in the log
When a request of the run gets an error answer, the log entry of the failed run MUST hold the method, the code, the filtered message, at most 1,000 characters, and the filtered data as JSON text, at most 2,000 characters. This MUST also apply to a refusal of the mode or of the model, whose error of the run stays a fixed text.

Tests: `test/error-output.test.mjs`, `test/child-settings.test.mjs`

#### Scenario: The answer to session/new
- **WHEN** the agent answers `session/new` with the error -32603, the message `Internal error` and the data `{"details":"Claude Code process exited with code 1"}`
- **THEN** the log entry holds `session/new`, `-32603`, `Internal error` and `Claude Code process exited with code 1`

#### Scenario: A refused mode
- **WHEN** the agent refuses the mode `auto` with the message "Mode auto is not available in this session"
- **THEN** the error of the run is the fixed text of the refused mode, and the log entry holds "Mode auto is not available in this session"

### Requirement: Answer in the error of a run
The error of a failed run MUST hold a reason after its fixed text: the first line of the filtered answer of the agent, which is the message and then the `details` of the data, else the data as JSON text, at most 300 characters. A note MUST follow that the log of the daemon has the details.

Tests: `test/error-output.test.mjs`

#### Scenario: The incident of 2026-11-12
- **WHEN** the agent answers `session/new` with the error -32603 "Internal error" and the data `{"details":"Claude Code process exited with code 1. stderr: Error: The model claude-opus-5-5 is not available. Run /model to choose another model."}`, and it writes no error output
- **THEN** the error of the run is "The agent answered session/new with the error -32603, so Megachat did not send the task to the agent in this run. Its answer: Internal error: Claude Code process exited with code 1. stderr: Error: The model claude-opus-5-5 is not available. Run /model to choose another model. The log of the daemon, daemon/daemon.log in the state directory, has the details."

### Requirement: Line of the error output in the error of a run
The error of a failed run MUST then hold one line, at most 300 characters, of the other lines of the answer and of the error output: the last line with error, fail, denied, refused, invalid, unauthorized, forbidden, cannot, unable or exception in any case, else the last line. It MUST NOT repeat a line that the answer part holds.

Tests: `test/error-output.test.mjs`

#### Scenario: A Node.js crash
- **WHEN** the agent writes a Node.js stack with the line `Error: Cannot find module 'missing'` and the last line `Node.js v22.12.0`, and exits with the code 1 before its answer to `session/new`
- **THEN** the error of the run says that the agent process ended with the exit code 1, and it holds `Error: Cannot find module 'missing'` and not `Node.js v22.12.0`

#### Scenario: A long line
- **WHEN** the last line of the error output has 1,000 characters
- **THEN** the error of the run holds at most 300 characters of that line

### Requirement: Fixed text of a run that failed before its prompt
An error answer before the prompt MUST give the text "The agent answered <method> with the error <code>, so Megachat did not send the task to the agent in this run." An agent process that ended by itself before the prompt MUST give "The agent process ended with <the exit code or the signal> before Megachat sent the task, so the agent did not get the task in this run." Each text MUST stay true when a continuation follows.

Tests: `test/error-output.test.mjs`

#### Scenario: An exit before the prompt
- **WHEN** the agent exits with the code 3 before its answer to `session/new`
- **THEN** the error of the run starts with "The agent process ended with the exit code 3 before Megachat sent the task, so the agent did not get the task in this run."

#### Scenario: A continuation after an error answer of session/new
- **WHEN** each start of the agent answers `session/new` with the error -32603, and the run gets its automatic continuation
- **THEN** the error of the run and of its continuation start with "The agent answered session/new with the error -32603, so Megachat did not send the task to the agent in this run."

### Requirement: Fixed text of a run that failed after its prompt
An error answer of `session/prompt` MUST give the text "The agent answered session/prompt with the error <code> after it got the task, so the task can have run in part." An agent process that ended by itself after the prompt went out MUST give "The agent process ended with <the exit code or the signal> after it got the task, so the task can have run in part."

Tests: `test/error-output.test.mjs`

#### Scenario: An error answer of the prompt
- **WHEN** the agent answers `session/prompt` with the error -32603
- **THEN** the error of the run starts with "The agent answered session/prompt with the error -32603 after it got the task, so the task can have run in part."

#### Scenario: A crash during the prompt
- **WHEN** the agent writes `Error: The adapter crashed.` to its error output and exits with the code 1 during the prompt
- **THEN** the error of the run starts with "The agent process ended with the exit code 1 after it got the task, so the task can have run in part.", and it holds `Error: The adapter crashed.`

### Requirement: Login and fixed texts of Megachat in the error of a run
An error answer with the ACP code `authRequired` MUST put the text "The agent asks for a login." before the fixed text, so the rule of the main agent runs `agents_accounts`. A failure with a fixed text of Megachat, such as a refused mode, MUST keep that text with no reason.

Tests: `test/error-output.test.mjs`, `test/child-settings.test.mjs`

#### Scenario: An agent without a login
- **WHEN** the agent answers `session/new` with the ACP error `authRequired`
- **THEN** the error of the run starts with "The agent asks for a login. The agent answered session/new with the error -32000"

#### Scenario: A refused permission mode
- **WHEN** the agent refuses the permission mode `auto`
- **THEN** the error of the run is the fixed text of the refused mode, with no reason

### Requirement: Private log of the daemon
The start of a daemon MUST open `daemon/daemon.log` with the mode 0600, and it MUST set the mode 0600 also on a log that exists with another mode. The directory `daemon` has the mode 0700 (see the capability `state-directory`).

Tests: `test/launch.test.mjs`

#### Scenario: A log with the mode 0644
- **WHEN** `daemon/daemon.log` exists with the mode 0644, and `start` starts a daemon
- **THEN** `daemon/daemon.log` has the mode 0600

# failure-handling Specification

## Purpose
Megachat keeps the state and the work of the user when an agent, a model, Central, a signal or the storage fails. The log of the daemon names each failure and holds no credential.

## Requirements

### Requirement: End of a turn after a lost wake-up
A turn MUST end when the tool calls of its step ended, also when the end of the last tool task comes while the scheduler of Pi Durable plans a pass. Megachat MUST NOT write a task record of Pi Durable for this. Pi Durable 1.5.0 lost the wake-up of the step in this case (issue #25), and Pi Durable 1.5.1 has the fix.

Tests: `test/scheduler-wake.test.mjs`

#### Scenario: Two tool calls in one reply
- **WHEN** the main agent starts two tasks with `agents_spawn` in one reply, and the end of each tool task comes 0 to 300 microtasks late
- **THEN** each turn ends, the conversation has no current turn, and the next model request of the main agent has the two tool results

#### Scenario: Three tool calls in one reply
- **WHEN** the main agent starts three tasks with `agents_spawn` in one reply, and the end of each tool task comes 0 to 300 microtasks late
- **THEN** each turn ends, the conversation has no current turn, and the next model request of the main agent has the three tool results

### Requirement: Interrupted task after an agent exit
An agent exit MUST mark its running task interrupted before it continues.

#### Scenario: An agent that exits during a task
- **WHEN** the agent of a running task exits
- **THEN** Megachat marks the task interrupted before it continues the task

### Requirement: Schema version of the state
Before it opens the state, Megachat MUST read the Pi Durable schema version. A version newer than this build supports MUST stop the start with "Megachat state was created by a newer Megachat build; update Megachat." It MUST NOT change the state.

Tests: `test/home.test.mjs`

#### Scenario: A state of a newer schema version
- **WHEN** `conversation.sqlite` has a schema version that is one higher than this build supports
- **THEN** the check of the state fails with "Megachat state was created by a newer Megachat build; update Megachat."

#### Scenario: A legacy state of a newer schema version
- **WHEN** a legacy directory holds a `conversation.sqlite` of a newer schema version
- **THEN** the migration fails, and the new state directory gets no `conversation.sqlite`

### Requirement: Write lock at the read of the schema version
The read of the version MUST wait up to 5 seconds for the write lock of another process, as the storage of Pi Durable waits. A daemon holds this lock for a moment while it makes or migrates the state, so a concurrent start MUST NOT fail on it.

Tests: `test/home.test.mjs`

#### Scenario: A lock of another process for 2 seconds
- **WHEN** another process holds an exclusive transaction on `conversation.sqlite` for 2 seconds, and Megachat reads the schema version in this time
- **THEN** the read waits for the lock, and the check of the state does not fail

### Requirement: Failed integrity check
A failed integrity check MUST leave the earlier state unchanged and start no daemon.

#### Scenario: A copy of the state that fails the integrity check
- **WHEN** the integrity check of the state fails
- **THEN** the earlier state stays unchanged, and no daemon starts

### Requirement: Output of an interrupted task
The daemon MUST retain the output of an interrupted task.

#### Scenario: A task that an agent exit interrupts
- **WHEN** a task wrote output and then becomes interrupted
- **THEN** the daemon keeps that output

### Requirement: Central configuration and its credentials
A failed Central configuration MUST start no child agent. Stored conversation data MUST contain no Central credentials.

Tests: `test/integration.test.mjs`

#### Scenario: A failed Central configuration for a Claude child
- **WHEN** Central gives no valid configuration for a Claude child of a new task
- **THEN** the run is interrupted with the error "Central did not supply a valid local provider configuration.", it has no process ID, and the agent gets no session request and no prompt

### Requirement: Failed reply
A reply that fails on a model error MUST tell the user "The model did not answer. Send the message again." The state MUST keep only the reason code of a failed reply, not the error text of the provider.

Tests: `test/integration.test.mjs`

#### Scenario: A reply to the user that fails on a model error
- **WHEN** the model fails on the reply to the message "Hello"
- **THEN** the user sees "The model did not answer. Send the message again.", and the prompt ends with the stop reason `cancelled`

#### Scenario: A result report that fails on a model error
- **WHEN** the model fails on a result report with the error text "The provider is overloaded."
- **THEN** the report has the status `interrupted` and the reason `model_error`, and the state holds no text "overloaded"

### Requirement: Lifetime of a child agent
A child agent MUST NOT stay alive after its daemon, also when it still writes output. A stop and a loss of the daemon MUST send SIGKILL only to the process group of the agent, so a process of the run in a session of its own, such as a shell that restarts the daemon, stays. When the agent ends by itself while the daemon runs, each process of the run MUST end (see the capability `child-processes`).

Tests: `test/recovery.test.mjs`, `test/child-processes.test.mjs`

#### Scenario: A child that writes after the daemon closed the output
- **WHEN** the daemon closes the output of a child, and the child ignores the closed output and writes again
- **THEN** the supervisor stops the child

#### Scenario: A helper of an agent that ends by itself
- **WHEN** an agent starts `sleep 47` in the background in its process group and exits with the code 0
- **THEN** the supervisor stops the `sleep 47` helper

#### Scenario: A shell that stops the daemon
- **WHEN** the shell of the run in a session of its own writes the file `stop`, the daemon stops, and the shell writes the file `marker` 1 second later
- **THEN** the file `marker` exists, and the shell got no signal

#### Scenario: A loss of the daemon
- **WHEN** the stand-in daemon gets SIGKILL while the shell of the run runs `sleep 61` in a session of its own
- **THEN** the agent ends, and the shell and the `sleep 61` still run

#### Scenario: A crash of Claude Code while the daemon runs
- **WHEN** the stand-in of Claude Code gets SIGKILL while its shell runs `sleep 61`, so the shell gets the parent PID 1, and the adapter then exits with the code 1
- **THEN** the shell and the `sleep 61` end

### Requirement: Stop during the start of the daemon
A daemon that gets SIGTERM or SIGINT, or a storage error, during its start MUST end the start and exit. It MUST NOT publish its connection file after it released the lock.

Tests: `test/recovery.test.mjs`

#### Scenario: A signal after the daemon got the lock
- **WHEN** the daemon gets SIGTERM after it got the owner lock and before it opens the conversation
- **THEN** the daemon exits with the code 0, it leaves no `daemon/connection.json`, and a new daemon gets the lock

#### Scenario: A storage error when the daemon listens
- **WHEN** the daemon gets a storage error after it starts to listen and before it publishes the connection file
- **THEN** the daemon exits with the code 1, it leaves no `daemon/connection.json`, and a new daemon gets the lock

### Requirement: Storage error of a running daemon
After a storage error, the daemon MUST write the reason to its log and stop. The next start opens the state again.

Tests: `test/failure.test.mjs`

#### Scenario: A full disk
- **WHEN** a commit of the storage fails with the code `ENOSPC`
- **THEN** the service fails with the code `ENOSPC`, and the log gets a line "Pi Durable reported storage_failed: name=Error code=ENOSPC"

### Requirement: Log of a failure
The log of the daemon MUST name each failure of a child run, of a request, of a turn, and of the Central configuration. A log line about an error MUST NOT contain the message of that error, because it can hold a credential. A failed Claude or Codex child run is the exception: its log entry holds the filtered answer of the agent and the filtered end of its error output (see the capability `secrets`).

Tests: `test/failure.test.mjs`, `test/error-output.test.mjs`, `test/integration.test.mjs`

#### Scenario: A failed Central command
- **WHEN** the Central command prints "apiKey sk-secret-value" and exits with the code 7
- **THEN** the log gets the line "Central gave no configuration to the main agent: name=Error code=7", and no log line contains "sk-secret-value"

#### Scenario: The description of an error
- **WHEN** an error with the message "The key is sk-secret-value", the code `ENOENT` and the signal `SIGTERM` goes to the log
- **THEN** the log text starts with "name=Error code=ENOENT signal=SIGTERM", and it does not contain "sk-secret-value"

#### Scenario: A reply through a Central that refuses the connection
- **WHEN** the configuration of Central gives a local address where nothing listens, and the user sends "Hello"
- **THEN** the log gets the lines "A model request through Central got no response: name=TypeError cause.name=Error cause.code=ECONNREFUSED" and "The turn <ID> of the main agent ended without an answer: kind=user reason=model_error", and no log line contains the key, the address or the error text of the provider

#### Scenario: A result report that fails on a model error
- **WHEN** the model fails on a result report with the error text "The provider is overloaded."
- **THEN** the log gets one line "The turn <ID> of the main agent ended without an answer: kind=report reason=model_error", and no log line contains "overloaded"

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
The error of a failed run MUST then hold one line, at most 300 characters, of the other lines of the answer and of the error output: the last line with a word that names a failure. When no line has such a word, the error of the run MUST NOT hold a line of the error output, and the log keeps the whole end of the error output. It MUST NOT repeat a line that the answer part holds.

Tests: `test/error-output.test.mjs`, `test/child-secrets.test.mjs`

#### Scenario: A Node.js crash
- **WHEN** the agent writes a Node.js stack with the line `Error: Cannot find module 'missing'` and the last line `Node.js v22.12.0`, and exits with the code 1 before its answer to `session/new`
- **THEN** the error of the run says that the agent process ended with the exit code 1, and it holds `Error: Cannot find module 'missing'` and not `Node.js v22.12.0`

#### Scenario: A long line
- **WHEN** the last line of the error output has 1,000 characters and starts with `Error: `
- **THEN** the error of the run holds the first 300 characters of that line

#### Scenario: An agent process killed after its debug lines
- **WHEN** the agent writes `[session/create] sessionId=fake-session phase=settings durationMs=4 totalMs=12` and `[session/create] sessionId=fake-session phase=register durationMs=1 totalMs=2683` during the prompt, and its agent process ends with the signal SIGKILL
- **THEN** the error of the run is "The agent process ended with the signal SIGKILL after it got the task, so the task can have run in part. The log of the daemon, daemon/daemon.log in the state directory, has the details.", and the log holds the two lines

#### Scenario: A secret in the line
- **WHEN** the agent writes `Error: key=` and the key of Central in two chunks, and exits before its answer to `session/new`
- **THEN** the error of the run quotes the line with the key replaced, and it does not hold the key

### Requirement: Words that name a failure
A line MUST name a failure when it holds, in any case: error, fail, denied, refused, invalid, unauthorized, forbidden, cannot, unable, exception, quota, segmentation or unavailable, also in a longer word; or fatal, panic, panicked, abort, aborted, killed, terminated, died, not found, no such, timed out, timeout, missing, expired, not available, log in or rate limit as a whole word; or /login.

Tests: `test/error-output.test.mjs`

#### Scenario: A cause without the word error
- **WHEN** the line between two debug lines is `Segmentation fault: 11`, `thread 'main' panicked at src/main.rs:5:3`, `Killed: 9`, `sh: claude: command not found`, `Not logged in · Please run /login`, `insufficient_quota` or `Rate limit reached for the model`
- **THEN** that line is the reason

### Requirement: Words of the debug lines of the adapter
A word that the adapter of Claude Code writes in a normal debug line MUST NOT name a failure: missing after `=`, as in `resolution=missing`, rate limit in `rate limit status`, login without the slash before it, and permission. A debug field such as `timeoutMs=5` or `permissionMode=default` MUST NOT count.

Tests: `test/error-output.test.mjs`

#### Scenario: The debug lines of the adapter of Claude Code
- **WHEN** the lines are `[session/create] sessionId=0f3e phase=settings durationMs=4 totalMs=12`, `[session/fork] sessionId=0f3e phase=full-history durationMs=3 totalMs=9 resolution=missing`, `[idle-compaction] skip: rate limit status is allowed_warning`, a line with "a probe that found a different login" and a line with "sending the Bash permission request unattributed"
- **THEN** no line is the reason

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

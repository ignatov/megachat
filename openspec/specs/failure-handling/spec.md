# failure-handling Specification

## Purpose
Megachat keeps the state and the work of the user when an agent, a model, Central, a signal or the storage fails. The log of the daemon names each failure and holds no credential.

## Requirements

### Requirement: End of a turn after a lost wake-up
A turn MUST end when the tool calls of its step ended, also when the scheduler of Pi Durable 1.5.0 loses the wake-up of the step that waits for them.

Tests: `test/scheduler-wake.test.mjs`

#### Scenario: Three tool calls in one reply
- **WHEN** the main agent starts three tasks with `agents_spawn` in one reply, and the end of each tool task comes 0 to 48 microtasks late
- **THEN** each turn ends, the conversation has no current turn, and the next model request of the main agent has the three tool results

### Requirement: Guard for a lost wake-up of the scheduler
After each commit that ends a task of Pi Durable with an owner task, the daemon MUST examine the owner in a commit of its own, one macrotask later. When the owner still waits and each task of its wait ended, that commit MUST write the record of the owner again, with no change, so the scheduler runs the step. Limits: the guard has no timer and no time limit of its own.

Tests: `test/scheduler-wake.test.mjs`

#### Scenario: A delay at which the scheduler loses the wake-up
- **WHEN** the end of a tool task comes at a delay at which the scheduler of Pi Durable 1.5.0 keeps the step waiting without the guard
- **THEN** the guard writes the record of the owner again, and the turn ends with the three tool results

### Requirement: Writes of the guard
The guard MUST write nothing for a step that the scheduler already took, so no work starts twice and no tool result is lost. The log of the daemon MUST have one line for each record that the guard wrote. It covers only a task that waits for the tasks that it owns, as each wait of the main agent and of a pi child does. It uses the internal `setTask` of the Pi Durable transaction, so a new version of Pi Durable needs a check of the guard.

Tests: `test/scheduler-wake.test.mjs`

#### Scenario: A step that the scheduler took
- **WHEN** the end of a tool task comes at a delay at which the scheduler does not lose the wake-up
- **THEN** the guard writes no record, and the log has no line of the guard

#### Scenario: A record that the guard wrote
- **WHEN** the guard writes the record of a task again
- **THEN** the log has the line "The task <ID> of Pi Durable waited after the end of each task of its wait. Megachat wrote its record again, so the scheduler runs it."

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
A child agent MUST NOT stay alive after its daemon. This also applies when the agent still writes output. A helper of a child agent in its process group, such as an MCP server or a background shell, MUST NOT stay alive after the agent ends by itself.

Tests: `test/recovery.test.mjs`

#### Scenario: A child that writes after the daemon closed the output
- **WHEN** the daemon closes the output of a child, and the child ignores the closed output and writes again
- **THEN** the supervisor stops the child

#### Scenario: A helper of an agent that ends by itself
- **WHEN** an agent starts `sleep 47` in the background in its process group and exits with the code 0
- **THEN** the supervisor stops the `sleep 47` helper

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
The log of the daemon MUST name each failure of a child run, of a request, of an automatic turn, and of the Central configuration. A log line about an error MUST NOT contain the message of that error, because the message can hold a credential.

Tests: `test/failure.test.mjs`

#### Scenario: A failed Central command
- **WHEN** the Central command prints "apiKey sk-secret-value" and exits with the code 7
- **THEN** the log gets the line "Central gave no configuration to the main agent: name=Error code=7", and no log line contains "sk-secret-value"

#### Scenario: The description of an error
- **WHEN** an error with the message "The key is sk-secret-value", the code `ENOENT` and the signal `SIGTERM` goes to the log
- **THEN** the log text starts with "name=Error code=ENOENT signal=SIGTERM", and it does not contain "sk-secret-value"

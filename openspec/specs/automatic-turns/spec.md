# automatic-turns Specification

## Purpose
Megachat starts automatic turns of the main agent for events, such as a child result or the summary of the past sessions. An automatic turn reports to the user, gives way to a user message, and starts no delegated work by itself.

## Requirements

### Requirement: No delegated work from an event
An event MUST NOT start delegated work without a user request.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`

#### Scenario: An admission in a turn of the summary of the past sessions
- **WHEN** the turn of the summary of the past sessions runs and the main agent tries to admit a child task in `/workspace`
- **THEN** the admission fails with the code `proposalOnly`

#### Scenario: The end of a turn of the summary of the past sessions
- **WHEN** the turn of the summary of the past sessions ends
- **THEN** the state holds no child run

### Requirement: User message during an automatic turn
A user message MUST interrupt an automatic turn, such as the turn of the summary of the past sessions.

Tests: `test/integration.test.mjs`, `test/state.test.mjs`, `test/prompt-wait.test.mjs`

#### Scenario: A user message during the summary of the past sessions
- **WHEN** the turn of the summary of the past sessions runs and the user sends "My task comes first"
- **THEN** the turn of the summary stops, and the turn of the user completes with the reply "User reply."

### Requirement: Second run of the summary of the past sessions
A turn of the summary of the past sessions that a user message interrupted, or that failed for a reason that can go away, MUST run again one time with the same data after the turn of the user, as the morning report does. A stop of the user and a reason that does not go away, such as the limit of tool rounds, MUST end it.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`

#### Scenario: Two interruptions
- **WHEN** a user message interrupts the turn of the summary of the pass `pass-1`, and a second user message interrupts its second run
- **THEN** the second run has the data of `pass-1`, and no third run follows

#### Scenario: Two model errors
- **WHEN** the turn of the summary fails with `model_error` two times
- **THEN** the summary runs one time more after the first failure, and the second failure ends it

#### Scenario: The limit of tool rounds and a stop of the user
- **WHEN** the turn of the summary ends with `turn_limit`, or the user stops it
- **THEN** the summary ends, and it does not run again

### Requirement: Result of a child after the main reply
A child that finishes after the main reply MUST produce a result in the main conversation.

Tests: `test/integration.test.mjs`

#### Scenario: A child that finishes after the reply "Delegated."
- **WHEN** the main agent admits a child task, replies "Delegated.", and the child finishes after that reply
- **THEN** the main conversation gets the result report "The completed task result." one time

### Requirement: Priority of a user message over a result report
A user message MUST take priority over an automatic result report without losing that result.

Tests: `test/integration.test.mjs`

#### Scenario: A user message during a result report
- **WHEN** a result report runs and the user sends "Answer me first"
- **THEN** the history holds the reply "User reply." one time, and later the result report "The completed task result." one time

### Requirement: Event reply in an idle view
An event reply MUST appear in an attached idle view.

Tests: `test/integration.test.mjs`

#### Scenario: A reply of a turn of the summary of the past sessions
- **WHEN** a view is attached and idle, and the turn of the summary of the past sessions replies "Resume the parser session?"
- **THEN** the view gets the reply "Resume the parser session?"

### Requirement: Event prompts in a replay
History replay MUST hide internal event prompts.

Tests: `test/integration.test.mjs`

#### Scenario: A replay after an event turn
- **WHEN** a new view attaches after a turn of the summary of the past sessions
- **THEN** the replay holds the reply "Resume the parser session?" and no `user_message_chunk`

### Requirement: Second send of a failed result report
A result report that fails on a model error or on a daemon stop MUST be sent once more, after a delay.

Tests: `test/integration.test.mjs`, `test/state.test.mjs`, `test/recovery.test.mjs`

#### Scenario: A model error
- **WHEN** a result report fails with `model_error`
- **THEN** a second report of the same result completes, and the history holds "The completed task result." one time

#### Scenario: A daemon stop with SIGKILL
- **WHEN** a SIGKILL of the daemon cuts a result report
- **THEN** after the restart, the report is sent once more and completes

#### Scenario: The delay
- **WHEN** the delay of a repeat is 60000 ms and a result report fails with `model_error`
- **THEN** the result waits for at least 60000 ms before its second report

### Requirement: End of the reports after a second failure
A second failure MUST end the reports of that result. The result MUST stay in the history, and the main agent MUST still be able to read the run.

Tests: `test/integration.test.mjs`, `test/state.test.mjs`

#### Scenario: Two model errors
- **WHEN** a result report fails with `model_error` two times
- **THEN** no third report starts, the run is marked as reported, the history holds two events of the result, and the main agent reads the run with the status `completed`

### Requirement: Reports that are not sent again
A report that the user stopped, or that reached its limit of tool rounds, MUST NOT be sent again.

Tests: `test/state.test.mjs`

#### Scenario: The limit of tool rounds
- **WHEN** a result report ends with `turn_limit`
- **THEN** the run is marked as reported, and no second report starts

#### Scenario: A stop of the user
- **WHEN** the user stops a result report
- **THEN** the report has the status `cancelled`, and no second report starts

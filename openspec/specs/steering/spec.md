# steering Specification

## Purpose
With the tool `agents_steer`, the main agent gives a message of the user to a child session that works, and the user does not wait for the end of the task. This capability gives the record of a message and its delivery to an ACP agent. The capability `pi-child` gives the steering of a pi run.

## Requirements

### Requirement: Tool agents_steer
The tool `agents_steer` of the main agent MUST add a message of the user to the unfinished run of a child session, without a wait for the end of the task. `agents_send` MUST stay a follow-up to an idle child session. Its refusal for a child that works MUST name `agents_steer`.

Tests: `test/integration.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: A message to a child that works
- **WHEN** a child works on the task `steer` and the main agent calls `agents_steer` with the text "Use https://example.com/a"
- **THEN** the outcome is `injected`, the run becomes `completed` with the message in its output, and the main agent gets one report

#### Scenario: A follow-up to a child that works
- **WHEN** the main agent calls `agents_send` for a child that waits for a permission request
- **THEN** the tool gives an error, and the error names `agents_steer`

### Requirement: Steering only by a turn of the user
Only a turn of the user MAY steer. A turn of a child result or of the summary of the past sessions MUST get a refusal.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: A turn of a child result
- **WHEN** the report of a child result starts a turn of the main agent, and the main agent calls `agents_steer` in that turn
- **THEN** the tool refuses the call, and the run of the child records no message

#### Scenario: A turn of the summary of the past sessions
- **WHEN** the summary of the first pass of the session index starts a turn, and the main agent calls `agents_steer` in that turn
- **THEN** the tool refuses the call

### Requirement: Refused child sessions
The tool MUST refuse a child session that the state does not know, a child session without an unfinished run, and a run whose directory is no longer listed, with the error of `agents_send` for that directory.

Tests: `test/state.test.mjs`

#### Scenario: An unknown child session
- **WHEN** the main agent steers the child session `unknown`
- **THEN** the tool refuses the call

#### Scenario: A child session without an unfinished run
- **WHEN** the last run of the child session is `cancelled` and the main agent steers it
- **THEN** the tool refuses the call

#### Scenario: A directory that is no longer listed
- **WHEN** the user removed `/workspace` from the list after the start of the child, and the main agent steers that child
- **THEN** the tool gives the error of `agents_send` for `/workspace`, and the run records no message

### Requirement: No steering from a child
The MCP server of the children MUST NOT have the tool. The rules of the main agent MUST say that a text from a child output or a session history never becomes a message to a child without a request of the user.

Tests: `test/integration.test.mjs`

#### Scenario: The tools of a child
- **WHEN** a client lists the tools of the MCP server of the children
- **THEN** the list is `history`, `sessions` and `session_history`, and it does not have `agents_steer`

### Requirement: Record of a message
The state MUST record each message before a process sends it: an ID, the text, the mode (`queue`, the default, or `interrupt`), the time, and the delivery: `pending`, `delivered` or `fallback`. A repeated tool call MUST give the first record.

Tests: `test/state.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: The record before the send
- **WHEN** the main agent steers a run that works with the text "Use the link"
- **THEN** the state has a record with an ID, the text "Use the link", the mode `queue`, the time and the delivery `pending`

#### Scenario: A repeated tool call
- **WHEN** the tool call `tool:1:steer` comes two times with the same text
- **THEN** the second call gives the record of the first call, and the run has one message

### Requirement: Limits of the messages
A task MUST have at most 16 messages, for its first run and its continuations together. A message MUST have at most 64,000 characters, and the error for a longer message MUST name the limit.

Tests: `test/state.test.mjs`

#### Scenario: A message that is too long
- **WHEN** the main agent steers a run with a message of 64,001 characters
- **THEN** the tool refuses the message, and the error names "64,000 characters"

#### Scenario: One message too many
- **WHEN** a task has 16 messages in its first run and its continuation, and the main agent steers it one more time
- **THEN** the tool refuses the message

### Requirement: Prune of the messages
The prune of a run MUST remove its messages.

Tests: `test/state.test.mjs`

#### Scenario: A pruned run
- **WHEN** the prune removes a completed run that has the message "Added"
- **THEN** the state has no record of the message "Added"

### Requirement: Message for a run that did not send its prompt
A message for a run that did not send its prompt MUST go in that prompt, as a block after the task. The outcome MUST be `queued`, and no agent MUST get a request.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: A queued run
- **WHEN** the run of the task `second` waits in the queue and the main agent steers it with the text "Name it B"
- **THEN** the outcome is `queued`, no agent gets a steering request, and the prompt of the run has the block with "Name it B" after the task `second`

### Requirement: Delivery to an ACP agent
For a run that sent its prompt, the run service that owns the connection to the agent MUST send the message. The state is the channel, as for a cancel. When the `initialize` answer of the agent gave `_meta.steering.supported` and the mode is `queue`, the run service MUST send `_session/steering` with `_meta.steering.idleBehavior: "promptRequired"`, so the adapter starts no turn of its own. The answer `injected` MUST mark the message delivered.

Tests: `test/integration.test.mjs`

#### Scenario: An agent with steering
- **WHEN** the agent supports steering and the main agent steers its run with the mode `queue`
- **THEN** the run service sends `_session/steering` with `_meta` `{ steering: { idleBehavior: "promptRequired" } }`, and after the answer `injected` the delivery of the message is `delivered`

#### Scenario: A message at once after the dispatch
- **WHEN** the state records a message at once after the dispatch of the run, and the run has no later update
- **THEN** the message reaches the turn, and its delivery becomes `delivered`

### Requirement: Follow-up for a message
When the turn ended first (`promptRequired`), or when the agent took the message and the stream started no new part of model work after the answer before the end of the turn, the run MUST get a follow-up in the same provider session with the message.

Tests: `test/integration.test.mjs`, `test/state.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: The turn ended first
- **WHEN** the agent answers `promptRequired` to the message "One more file"
- **THEN** the outcome is `followUp`, the next run continues the same provider session with the message, and the main agent gets one report

#### Scenario: A message after the end of the turn
- **WHEN** a run has the output "Result. ", gets the message "Too late", and its turn ends with `end_turn`
- **THEN** the next run continues the provider session `provider` with the message, and its output starts with "Result. "

### Requirement: Follow-up after the answer injected
The outcome in the record MUST be `followUp`, also when the tool gave `injected`. A new part is an update of another kind than the update before it (a message chunk, a thought chunk, a tool call or its update, a plan), or a new tool call. More chunks of the reply that streamed at the answer are no new part: the Codex adapter can send them after its answer.

Tests: `test/integration.test.mjs`, `test/state.test.mjs`

#### Scenario: A message that the agent took without work after it
- **WHEN** the agent answers `injected` to the message "Also test it", and the turn ends with no new part of model work after the answer
- **THEN** the run gets a follow-up with the message, and the outcome in the record is `followUp`

#### Scenario: The rest of the reply of the Codex adapter
- **WHEN** the Codex adapter answers `injected`, sends more chunks of the reply that streamed at the answer, and ends the turn
- **THEN** the run gets a follow-up with the message "Also test it"

### Requirement: Fallback
The answer `failed`, an error, no answer in 20 seconds, an agent without steering, and the mode `interrupt` MUST use the fallback: `session/cancel`, and after the end of the prompt a continuation in the same provider session. Its prompt MUST say that the user stopped the step, and it MUST hold the message. The outcome MUST be `restarted`.

Tests: `test/integration.test.mjs`, `test/state.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: An agent without steering
- **WHEN** the agent does not support steering and the main agent steers its run with the message "Use the other branch"
- **THEN** the outcome is `restarted`, the run stops with `cancelled`, and the continuation in the same provider session has a prompt that says that the user stopped the step and holds the message

#### Scenario: The mode interrupt
- **WHEN** the agent supports steering and the main agent steers its run with the mode `interrupt`
- **THEN** no agent gets a steering request, the outcome is `restarted`, and the main agent gets one report

### Requirement: End of the turn before the stop
When the turn ends with `end_turn` before the stop, the message MUST go in a follow-up, with the outcome `followUp`.

Tests: `test/state.test.mjs`

#### Scenario: The end of the turn before the stop
- **WHEN** a run gets a stop for the message "Use the other branch", and its turn ends with `end_turn` before the stop
- **THEN** the run gets a follow-up with the message, and the outcome is `followUp`

### Requirement: Other waiting messages after the fallback
After one message used the fallback, each other waiting message of the run MUST go to the same stop without a steering request.

Tests: `test/integration.test.mjs`

#### Scenario: No answer to the first steering request
- **WHEN** the agent gives no answer to the steering request for "First message", and "Second message" waits
- **THEN** the agent gets one steering request, the continuation holds the two messages, and the outcome of each message is `restarted`

### Requirement: Wait for a permission request
While a permission request of the run waits for the user, the fallback MUST wait until the user answered each request of the run. A steer MUST NOT change a permission request. The chat MUST keep the task of the run with its ID and its phase.

Tests: `test/integration.test.mjs`

#### Scenario: Two open permission requests
- **WHEN** an agent without steering has two open permission requests and the main agent steers its run
- **THEN** the run does not stop after the answer to the first request, it stops after the answer to the second request, and the continuation holds the message

#### Scenario: A steer of a run that waits for a permission
- **WHEN** the main agent steers a run whose permission request waits for the user
- **THEN** the permission request stays `pending`, and the chat keeps each task row with its ID and its phase

### Requirement: Start of a follow-up or a continuation
A follow-up or a continuation for a message MUST start at once, also before an older queued task, MUST NOT count as an automatic attempt, and MUST start also after the last attempt. The main agent MUST get one report for the task: the report of the last run, with the output of the earlier run before its own output.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: After the last attempt
- **WHEN** a run used its two automatic continuations, has the output "Partial work. ", and gets a stop for a message
- **THEN** the continuation starts at once with the message, its attempt count stays 2, and its output starts with "Partial work. "

#### Scenario: An older queued task
- **WHEN** the task `second` waits in the queue and the run of the task `steer` gets a stop for a message
- **THEN** the continuation of `steer` starts before the run of `second`

#### Scenario: One report for the task
- **WHEN** the task "Implement it" gets a stop for a message and then a follow-up for another message
- **THEN** the main agent gets one report, and it is the report of the last run

### Requirement: Messages after a daemon restart
After a daemon restart, the continuation of an interrupted run MUST hold each message of the run that the provider session may not have. A message that can have reached the agent MUST say that it can be a repeat. So the delivery is "at least one time".

Tests: `test/state.test.mjs`, `test/recovery.test.mjs`

#### Scenario: Three messages at a restart
- **WHEN** a run has the messages "Delivered", "Sent without an answer" and "Not sent", and the daemon restarts
- **THEN** the continuation holds the three messages, and only "Delivered" and "Sent without an answer" say that they can be a repeat

#### Scenario: A daemon that SIGKILL stops
- **WHEN** the first daemon sent two steering requests, SIGKILL stops it, and the run has a third message
- **THEN** the second daemon sends no steering request, and the continuation prompt holds the three messages with the first two marked as a possible repeat

### Requirement: Wait of the tool
The tool MUST wait at most 30 seconds for the outcome. After that time, its outcome MUST be `pending`, and the message MUST stay in the state.

#### Scenario: No outcome in 30 seconds
- **WHEN** the message has no outcome 30 seconds after the tool call
- **THEN** the tool gives the outcome `pending`, and the record of the message stays in the state

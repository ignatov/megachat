# delegation Specification

## Purpose
The main conversation delegates tasks to child agents and stays free while the children work. The user can stop a turn and its children, and can continue an existing session of an agent.

## Requirements

### Requirement: Pending permission requests
A permission request MUST stay pending without a connected client. Reconnection MUST show the pending request without starting the task again.

Tests: `test/integration.test.mjs`

#### Scenario: A view disconnects while a child waits for permission
- **WHEN** a child waits for a permission request and the only view disconnects
- **THEN** the permission request stays `pending`, and the main conversation is free

#### Scenario: A new view answers the request
- **WHEN** a new view loads the session and approves the pending request
- **THEN** the child completes, and its agent received the prompt `approval` one time

### Requirement: Stop and cancellation
Stop MUST cancel the main task and each child that it owns. Stop MUST cancel only the turn that the view shows. A stop for a turn that ended MUST NOT cancel the next turn. A later user message MAY cancel an earlier background task.

Tests: `test/integration.test.mjs`

#### Scenario: Stop of a restored main turn
- **WHEN** a view loads the session while the main turn and its child run, and the user stops the turn
- **THEN** the main turn and the child become `cancelled`, and the row of the child gets the state `stopped`

#### Scenario: A stop for a turn that ended
- **WHEN** the first turn ended, the second turn runs, and a stop arrives for the first turn
- **THEN** the daemon answers `{ cancelled: false }`, and the second turn continues

#### Scenario: A later message cancels a background task
- **WHEN** a child runs and a later user message asks to cancel the background task
- **THEN** the run of the child becomes `cancelled`

### Requirement: A free main conversation
The main reply MUST finish without waiting for its children. The main conversation MUST accept new messages while a child works or needs permission.

Tests: `test/integration.test.mjs`

#### Scenario: A message while a child waits for permission
- **WHEN** the reply to "Work" delegated a task and the child waits for permission, and the user sends "Can we talk?"
- **THEN** each of the two prompts ends with `end_turn`, the reply "We can talk while it works." appears, and the permission request stays `pending`

### Requirement: Queue of delegated tasks
A new delegated task MUST wait in a durable queue when its directory is busy or when the limit of the children that run at the same time is full.

Tests: `test/integration.test.mjs`

#### Scenario: A second task in a busy directory
- **WHEN** a child waits for permission and a second message delegates a task in the same directory
- **THEN** the second run stays `admitted`, the main conversation is free, and the second run starts after the first run completes

### Requirement: Agent of a delegated task
The user MAY delegate a task to Claude Code or Codex, and a task that only reads files to a pi child. Claude Code MUST remain the default for delegated tasks unless the setting `children.agent` selects Codex.

Tests: `test/integration.test.mjs`

#### Scenario: A task for Codex
- **WHEN** the main agent calls `agents_spawn` with the agent `codex`
- **THEN** the daemon launches a Codex child, and the run has the agent `codex`

#### Scenario: A task without a named agent
- **WHEN** the main agent calls `agents_spawn` without an agent
- **THEN** the child is a Claude Code child, and the description of its row in the chat starts with `Claude · ` and the name of the project

### Requirement: Continued sessions
The user MAY continue an existing session in its registered project. One provider session MUST have at most one unfinished delegated task.

Tests: `test/integration.test.mjs`, `test/state.test.mjs`

#### Scenario: An existing Codex session
- **WHEN** the main agent calls `agents_resume` with the agent `codex` and the session ID `active`
- **THEN** the child loads the session `active`, and the run is not a service session

#### Scenario: A second task for a busy provider session
- **WHEN** a run continues the provider session `existing` and another task asks to continue the same session
- **THEN** the admission fails with the code `busy`

#### Scenario: A session in another project
- **WHEN** a task asks to continue the session in the directory `/other`, which is not a registered project
- **THEN** the admission fails with the code `workspace`

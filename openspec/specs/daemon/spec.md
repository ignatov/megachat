# daemon Specification

## Purpose
The daemon of Megachat keeps the work of the conversation when a client disconnects. It serves its clients through a local HTTP connection that the private connection token protects.

## Requirements

### Requirement: Admitted work after a disconnect
The daemon MUST keep admitted work when the ACP client disconnects.

Tests: `test/recovery.test.mjs`

#### Scenario: The bridge of the client stops
- **WHEN** a child waits for a permission request and the ACP bridge of the client gets `SIGKILL`
- **THEN** the permission request stays `pending`, and the process of the child agent continues to run

### Requirement: Start of the daemon
Opening Megachat MUST start its daemon if it is unavailable.

Tests: `test/recovery.test.mjs`

#### Scenario: Two opens at the same time
- **WHEN** no daemon runs and two ACP clients open Megachat at the same time
- **THEN** one daemon starts without a separate start command, and each client gets the agent title "Megachat"

### Requirement: Open client connections
A large conversation MUST NOT disconnect a client while it receives updates. An idle client connection MUST stay open while the daemon is available. Waiting for a long task MUST keep the connection open until the task ends or the client disconnects.

Tests: `test/transport.test.mjs`

#### Scenario: A large conversation
- **WHEN** the conversation has an entry of 2 MiB and the client is idle for 15 seconds after it received the conversation
- **THEN** the client receives the conversation, the tasks and a heartbeat, and the connection stays open

#### Scenario: A wait for a long task
- **WHEN** a client waits for a running task for 15 seconds, and then the task completes
- **THEN** the response stays open with a heartbeat, and it ends with valid JSON of the completed task

### Requirement: Many connections at a time
The daemon MUST accept 1,024 connections at a time. The event streams of many views MUST NOT block `/health`, a new view or a command.

Tests: `test/transport.test.mjs`

#### Scenario: Many event streams
- **WHEN** 40 views hold an event stream
- **THEN** `/health` answers with the version 1

### Requirement: Connection token
The local HTTP connection MUST require the private connection token.

Tests: `test/integration.test.mjs`

#### Scenario: A request without the token
- **WHEN** a client requests `/state` without the connection token
- **THEN** the daemon answers with the status 401

#### Scenario: The token of the child history
- **WHEN** a client requests `/state` with the headers of the history connection of a child
- **THEN** the daemon answers with the status 401

### Requirement: Size limits of a request
The daemon MUST accept an input of 100,000 characters in each script. It MUST refuse a request body of more than 1,000,000 bytes.

Tests: `test/transport.test.mjs`

#### Scenario: A long input that is not ASCII
- **WHEN** a client sends to `/input` a text of 100,000 characters `ж`
- **THEN** the daemon admits the input with the full text

#### Scenario: A body that is too large
- **WHEN** a client sends to `/input` a text of 1,000,001 characters `x`
- **THEN** the daemon refuses the request and admits no input

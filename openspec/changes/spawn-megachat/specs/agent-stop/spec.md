# Spec Delta

## Purpose

The client can stop a Megachat that the user removed from the IDE. The request ends the daemon only when no work runs, and it keeps the state directory, so the same conversation comes back at the next start.

## ADDED Requirements

### Requirement: Capability agentStop
The answer of `acp` to `initialize` MUST hold the capability `agentStop` in the list `_meta.jetbrains.air.capabilities`, for each client and in each scope. So a client can tell a release that does not know the request `_agent/stop`.

Tests: `test/agent-stop.test.mjs`

#### Scenario: The answer to initialize
- **WHEN** a client sends `initialize` with `_meta.jetbrains.air` `{"version":1,"capabilities":[]}`
- **THEN** the list of the capabilities in the answer holds `persistentSession` and `agentStop`

### Requirement: Stop at the request of the client
On the request `_agent/stop` with the parameters `{}`, when no turn runs and each child run is in a terminal state, `acp` MUST stop its daemon and wait until the daemon process ends. Then it MUST answer `{"stopped":true}`, write one line to its error output, end its ACP connection and exit with the code 0.

Tests: `test/agent-stop.test.mjs`

#### Scenario: A daemon without work
- **WHEN** the daemon has no turn and no child run, and the client sends `_agent/stop`
- **THEN** the answer is `{"stopped":true}`, the daemon process ends, `daemon/connection.json` is gone, the error output of `acp` holds "Megachat stopped its daemon at the request of the IDE", and `acp` exits with the code 0

#### Scenario: A second client of the daemon
- **WHEN** two `acp` processes have a view of one daemon, and the client of the first process sends `_agent/stop`
- **THEN** the second process writes a line about its lost daemon connection, ends its ACP connection and exits, and it starts no daemon

### Requirement: Refusal while work runs
While a turn runs, or a child run is not in a terminal state, `acp` MUST answer `{"stopped":false,"reason":"<text>"}` to `_agent/stop`. The text MUST say whether a turn runs, give the count of the child runs, and tell the user to stop the work or to wait. The daemon and the connection MUST stay as they are.

Tests: `test/agent-stop.test.mjs`

#### Scenario: A child that waits for a permission
- **WHEN** a child run waits for a permission request, and the client sends `_agent/stop`
- **THEN** the answer has `stopped` false and the reason "Megachat has work that runs: 1 child task. Stop the work or wait for its end, then remove Megachat again.", the daemon lives, and the permission request stays `pending`

#### Scenario: A turn that runs
- **WHEN** a turn of the main agent runs, and the client sends `_agent/stop`
- **THEN** the answer has `stopped` false and the reason "Megachat has work that runs: a turn. Stop the work or wait for its end, then remove Megachat again.", and the turn continues to its end

### Requirement: State after the stop
The stop MUST change and delete no file of the state directory other than the connection file of the daemon. The next start MUST open the same conversation, settings and memory.

Tests: `test/agent-stop.test.mjs`

#### Scenario: A start after the stop
- **WHEN** the conversation holds the user message `Work`, the client sends `_agent/stop`, and a new `acp` process starts on the same state directory
- **THEN** the replay of the new view holds the user message `Work` one time, and `settings.json` and `memory.md` are unchanged

### Requirement: Daemon that does not end
When the daemon process lives 30 seconds after the stop, `acp` MUST answer `{"stopped":false,"reason":"<text>"}` with a text that names the process ID of the daemon, and it MUST keep its ACP connection.

Tests: `test/agent-stop.test.mjs`

#### Scenario: A daemon that ignores the stop
- **WHEN** the daemon answers the stop and does not end, and the bridge has a time limit of 200 ms for the test
- **THEN** the answer has `stopped` false, the reason holds the process ID of the daemon, and the ACP connection stays open

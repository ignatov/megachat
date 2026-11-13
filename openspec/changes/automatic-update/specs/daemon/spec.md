# Spec Delta

## ADDED Requirements

### Requirement: End of the bridge after the stop of its daemon
When the event stream of a view gets the event `update`, the bridge MUST write one line about the update to its error output, end its ACP connection and exit with the code 0. A bridge with a view MUST also exit when its event stream ends without that event.

Tests: `test/recovery.test.mjs`

#### Scenario: A stop for an update
- **WHEN** a bridge has a view, and its daemon sends `{"type":"update","value":{"from":"0.4.0","to":"0.5.0"}}`
- **THEN** the error output of the bridge has one line "The Megachat daemon stopped for the update from 0.4.0 to 0.5.0. The next start of Megachat installs it.", and the bridge ends its connection

### Requirement: Bridge without a view after the stop of its daemon
A bridge MUST end its ACP connection with one line and exit with the code 0 when a request finds no process on the port of its daemon, when the daemon refuses its token, or, without an open view, when two `/health` requests in a row fail or `/health` gives another `pid`. It MUST ask `/health` every 60 seconds with a time limit of 2 seconds.

Tests: `test/recovery.test.mjs`

#### Scenario: The daemon is gone
- **WHEN** a bridge got only `initialize`, and then its daemon closes its server
- **THEN** the bridge writes "The Megachat daemon is gone" and ends its connection at its next check of `/health`

#### Scenario: Another daemon
- **WHEN** `/health` gives a `pid` other than the `pid` of the start of the bridge
- **THEN** the bridge writes the same line and ends its connection

### Requirement: No start of a daemon by a running bridge
A bridge MUST start a daemon only in its own start. After its daemon stopped, a request to the bridge MUST NOT start a daemon.

Tests: `test/recovery.test.mjs`

#### Scenario: A request after the stop
- **WHEN** the daemon of an `acp` without a view stops, and the client then sends `session/new`
- **THEN** the answer is an error, `acp` exits with the code 0, and no daemon process and no connection file exist for the state directory

#### Scenario: A view after the stop
- **WHEN** the daemon of an `acp` with a view stops without the event `update`
- **THEN** `acp` exits with the code 0, and no daemon process exists for the state directory

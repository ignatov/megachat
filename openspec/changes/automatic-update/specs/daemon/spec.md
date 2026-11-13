# Spec Delta

## ADDED Requirements

### Requirement: End of the bridge after the stop of its daemon
When the event stream of a view gets the event `update`, the bridge MUST write one line about the update to its error output, end its ACP connection and exit with the code 0. A bridge with a view MUST also exit when its event stream ends without that event.

Tests: `test/recovery.test.mjs`

#### Scenario: A stop for an update
- **WHEN** a bridge has a view, and its daemon sends `{"type":"update","value":{"from":"0.4.0","to":"0.5.0"}}` and stops
- **THEN** the error output of the bridge has "The Megachat daemon stopped for the update from 0.4.0 to 0.5.0.", and the bridge exits with the code 0

### Requirement: Bridge without a view after the stop of its daemon
A bridge without an open view MUST ask `/health` of its daemon every 60 seconds with a time limit of 2 seconds. After two failed requests in a row, or a `/health` with another `pid`, it MUST write one line to its error output and exit with the code 0.

Tests: `test/recovery.test.mjs`

#### Scenario: The daemon is gone
- **WHEN** a bridge got only `initialize`, and then its daemon stops
- **THEN** the bridge exits with the code 0 after the second failed request to `/health`

### Requirement: No start of a daemon by a running bridge
A bridge MUST start a daemon only in its own start. After its daemon stopped, a request to the bridge MUST NOT start a daemon.

Tests: `test/recovery.test.mjs`

#### Scenario: A request after the stop
- **WHEN** the daemon of a bridge without a view stops, and the client sends `session/new` before the bridge exits
- **THEN** the answer is an error, and no daemon process runs for the state directory

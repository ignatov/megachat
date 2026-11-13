# Spec Delta

## ADDED Requirements

### Requirement: Variables of the entry after a start by npm
When npm or npx started Megachat, the daemon and each child MUST NOT get `GIT_HTTP_LOW_SPEED_LIMIT` with the value `1000` and `GIT_HTTP_LOW_SPEED_TIME` with the value `20`, the values of the entry (see the capability `install`). Another value of these variables MUST stay. After a direct start, each value MUST stay.

Tests: `test/environment.test.mjs`, `test/package.mjs`

#### Scenario: The variables of the entry
- **WHEN** npx starts the daemon with `GIT_HTTP_LOW_SPEED_LIMIT` `1000` and `GIT_HTTP_LOW_SPEED_TIME` `20`
- **THEN** the daemon has neither variable

#### Scenario: Values of the user
- **WHEN** the environment of a process that npx started has `GIT_HTTP_LOW_SPEED_LIMIT` `50` and `GIT_HTTP_LOW_SPEED_TIME` `600`
- **THEN** the environment of the daemon and the children keeps both variables with these values

#### Scenario: A direct start
- **WHEN** the environment has `GIT_HTTP_LOW_SPEED_LIMIT` `1000` and `GIT_HTTP_LOW_SPEED_TIME` `20`, but no `npm_execpath`
- **THEN** the environment of the daemon and the children keeps both variables

### Requirement: Line of a client without the Air support
When the ACP `initialize` request has no `_meta.jetbrains.air` with the version 1 or more, `acp` MUST write one line to its error output: the client has no Air support for Megachat, so it can close the session when a window releases it. The answer to `initialize` MUST stay the same. A client with the Air support MUST get no such line.

Tests: `test/recovery.test.mjs`

#### Scenario: A plain ACP client
- **WHEN** a client sends `initialize` with `clientCapabilities` `{}` two times in one connection to `acp` of a source checkout
- **THEN** the error output of `acp` has one line with "has no Air support for Megachat", and each answer has the agent title "Megachat"

#### Scenario: A client of Air
- **WHEN** a client sends `initialize` with `_meta.jetbrains.air` `{"version":1,"capabilities":["asyncTasks"]}`
- **THEN** the error output of `acp` has no such line

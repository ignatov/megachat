# Spec Delta

## ADDED Requirements

### Requirement: Facts for a problem report
The instructions of the main agent MUST have a section `about` of its own with the version of the build of the daemon (see the capability `launch`), the state directory, the path of `daemon/daemon.log` in it, and the address `https://github.com/ignatov/megachat/issues`. The section MUST NOT hold the connection token, the port, the Central base URL or a key. A new version MUST send only this section to the model again.

Tests: `test/settings.test.mjs`

#### Scenario: The section of a daemon
- **WHEN** a daemon of the version `0.6.3` runs on the state directory `/Users/me/.jetbrains/air/megachat`
- **THEN** the section `about` has `0.6.3`, `/Users/me/.jetbrains/air/megachat`, `/Users/me/.jetbrains/air/megachat/daemon/daemon.log` and `https://github.com/ignatov/megachat/issues`, and it does not have the token or the port of `daemon/connection.json`, and no base URL of Central

#### Scenario: A new version
- **WHEN** a daemon of the version `0.6.3` sent a request, and then a daemon of the version `0.6.4` sends the next request of the same conversation
- **THEN** the next request sends again only the section `about`

### Requirement: Answer about a problem
When the user asks for the version, the log, or how to report a problem, the rules MUST tell the main agent to give the facts of the section `about` and the issue address, and to say that the log of the IDE has the error output of the agent process. They MUST tell it to say that the log is a local file that can hold private text, and that the user must read it and remove that text before they share a part of it.

Tests: `test/settings.test.mjs`

#### Scenario: The rules of a question about a problem
- **WHEN** the main agent gets its instructions
- **THEN** the section `about` tells it to give the version, the state directory, the path of the log and the issue address for a question about the version, the log or a problem, and to tell the user to read the log for private text before they share a part of it

### Requirement: Log in a public place
The rules MUST tell the main agent that it MUST NOT put the log, or a part of it, into an issue, a pull request or another public place. They MUST tell it that it MUST NOT give a child a task that does so. A user who wants a report gets the issue address and writes the report.

Tests: `test/settings.test.mjs`

#### Scenario: The rule about a public place
- **WHEN** the main agent gets its instructions
- **THEN** the section `about` says that the agent does not put the log or a part of it into an issue or another public place, and does not give a child a task that does so

## MODIFIED Requirements

### Requirement: Setting of the index
With the setting `sessions.index` on, Megachat MUST keep an index of the past Claude Code, Codex and pi sessions in `sessions.sqlite` in the state directory. The default MUST be on. A stored value MUST win over the default. A file of an earlier build can keep off (see the requirement "Settings file of an earlier build" of the capability `settings`).

Tests: `test/session-index.test.mjs`, `test/settings.test.mjs`

#### Scenario: The default value
- **WHEN** the state directory has no `settings.json`
- **THEN** `sessions.index` is `on` with the source `default`

#### Scenario: A stored off
- **WHEN** `settings.json` holds the onboarding `done`, `defaults` 2 and the value `off` of `sessions.index`
- **THEN** the output of `agents_settings` with `get` gives the state `off` for the index, and Megachat opens no session file

#### Scenario: The setting on
- **WHEN** the setting `sessions.index` is on, and a listed directory has one Claude Code session and one pi session
- **THEN** `sessions.sqlite` is in the state directory, and the output of `agents_settings` with `get` gives 2 sessions for the index

### Requirement: Consent of the user
The setup MUST ask for the consent with "Index past Claude, Codex and pi sessions in your projects, and read the logs of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only when you ask. Everything stays local." It MUST say that the default is on, and that off deletes the index and the table of the running sessions. The agent MUST set on only when the user agrees.

Tests: `test/session-index.test.mjs`

#### Scenario: The question of the setup
- **WHEN** the setup asks the user about the index
- **THEN** the question is "Index past Claude, Codex and pi sessions in your projects, and read the logs of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only when you ask. Everything stays local."

#### Scenario: The default in the setup
- **WHEN** a test reads `resources/instructions-onboarding.md` and `resources/instructions-onboarding-ghost.md`
- **THEN** they hold "The default is on.", "off deletes the index and the table of the running sessions", "Set sessions.index to on only when the user agrees." and the likely answer "Keep the index on"

### Requirement: Summary of the first pass
After the first pass of a new index file, the main agent MUST tell the user a short summary in one event turn: the number of sessions and of projects, and the last unfinished sessions. A first pass that finds no session MUST NOT start an event turn. The summary is data, not instructions.

Tests: `test/session-index.test.mjs`

#### Scenario: The summary
- **WHEN** the first pass of a new index file imports one Claude Code session and one pi session of one project
- **THEN** one event turn gives 2 sessions in 1 project, and the unfinished sessions `one` and `pi-one`

#### Scenario: A later pass
- **WHEN** a later start of the daemon runs a pass of the same index file
- **THEN** the main agent gives no second summary

#### Scenario: A first pass without a session
- **WHEN** the first pass of a new index file finds no session file
- **THEN** the state of the index becomes `ready`, and Megachat gives no summary

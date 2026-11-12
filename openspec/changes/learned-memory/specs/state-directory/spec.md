## MODIFIED Requirements

### Requirement: Content of the state directory
The directory MUST hold `conversation.sqlite`, `owner.sqlite`, `search.sqlite`, `workspace/`, and `daemon/` with the connection file and log. It MAY hold `settings.json` and `spend.json`. It MAY hold `sessions.sqlite`, the index of past sessions and the live table of the session files, only with the consent of the user. It MAY hold `memory.md`, the learned memory that the user can edit, and `memory-versions/` (see the capability `learned-memory`).

Tests: `test/memory.test.mjs`

#### Scenario: The files of a running daemon
- **WHEN** a daemon runs on a state directory
- **THEN** the directory holds `conversation.sqlite`, `owner.sqlite`, `search.sqlite`, `workspace/`, and `daemon/` with the connection file and the log

#### Scenario: A state directory without a memory
- **WHEN** a daemon starts on a state directory without `memory.md`, and no write of the memory occurs
- **THEN** the directory holds no `memory.md` and no `memory-versions/`

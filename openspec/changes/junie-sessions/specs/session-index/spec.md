# Spec Delta

## MODIFIED Requirements

### Requirement: Consent of the user
The setup MUST ask for the consent with "Index past Claude, Codex, Junie and pi sessions in your projects, and read the logs of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only when you ask. Everything stays local." It MUST say that the default is on, and that off deletes the index and the table of the running sessions. The agent MUST set on only when the user agrees.

Tests: `test/session-index.test.mjs`

#### Scenario: The question of the setup
- **WHEN** the setup asks the user about the index
- **THEN** the question is "Index past Claude, Codex, Junie and pi sessions in your projects, and read the logs of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only when you ask. Everything stays local."

#### Scenario: The default in the setup
- **WHEN** a test reads `resources/instructions-onboarding.md` and `resources/instructions-onboarding-ghost.md`
- **THEN** they hold "The default is on.", "off deletes the index and the table of the running sessions", "Set sessions.index to on only when the user agrees." and the likely answer "Keep the index on"

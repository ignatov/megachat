## ADDED Requirements

### Requirement: Child sessions in the session list of the project
The setting `children.showInProject` MUST be `true` or `false`, with the default `false`. A new Claude or Codex child session MUST take the value of its directory at its first run. With `true`, that session MUST be no service session, so that Air shows it in the session list of its project.

Tests: `test/settings.test.mjs`, `test/integration.test.mjs`

#### Scenario: Allowed values
- **WHEN** the main agent sets `children.showInProject` to `true` or `false`
- **THEN** the setting stores the value, and it refuses `sometimes` and `2`

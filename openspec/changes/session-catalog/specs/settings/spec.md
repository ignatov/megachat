# Spec Delta

## MODIFIED Requirements

### Requirement: Settings of the index of past sessions
The settings of the index of past sessions are `sessions.index`, `sessions.days` and `sessions.notes`. Their defaults MUST be `on`, `30` and `off`. `sessions.days` MUST limit only the texts, and not the catalog. They MUST apply at once, also in the middle of a turn, because they change no model request.

Tests: `test/settings.test.mjs`

#### Scenario: The defaults of the index
- **WHEN** no variable is set and no value is stored
- **THEN** `sessions.index` is `on`, `sessions.days` is `30` and `sessions.notes` is `off`

#### Scenario: A stored value
- **WHEN** `settings.json` holds `sessions.days` 180
- **THEN** the value is `180` with the source `stored`

#### Scenario: A setting of the index in a turn
- **WHEN** a tool call in a turn sets `sessions.days` to `30`
- **THEN** the value `30` applies at once, before the turn ends

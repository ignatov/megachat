# Spec Delta

## ADDED Requirements

### Requirement: Setting of the automatic update
The setting `update.auto` MUST be a boolean with the default `true`. It MUST be a global setting without a variable and without a project value. A change MUST apply at the next check of the conditions of the automatic update (see the capability `update`).

Tests: `test/settings.test.mjs`

#### Scenario: The default
- **WHEN** no value is stored
- **THEN** `agents_settings get` gives `update.auto` with the value `true`, the source `default` and the allowed values `true` and `false`

#### Scenario: A change
- **WHEN** the agent sets `update.auto` to `false`
- **THEN** `settings.json` holds `"update.auto": false`, and the answer says that the next check of the update uses the new value

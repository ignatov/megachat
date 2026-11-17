# Spec Delta

## ADDED Requirements

### Requirement: One-time start of the automatic update
The first open of a `settings.json` without `migrations.updateAuto` MUST turn `update.auto` on, also when the file stores `false`, and MUST store `migrations.updateAuto` with the next write. A `false` that the user sets later MUST stay. A new file MUST start with the record. The note after the next update MUST say once that the automatic update is on and how to turn it off.

Tests: `test/settings.test.mjs`, `test/update.test.mjs`

#### Scenario: A stored false
- **WHEN** an earlier file stores `"update.auto": false`
- **THEN** `agents_settings get` gives `true` with the source `default`, and the open does not change the file

#### Scenario: A later false
- **WHEN** the agent sets `update.auto` to `false` after the migration
- **THEN** the file has `"migrations": {"updateAuto": true}`, and each later start gives `false` with the source `setting`

#### Scenario: The note
- **WHEN** the update note has `autoOn`
- **THEN** its last line is "The automatic update is on now. Megachat installs a new release at night, when no work runs. To turn it off, ask me to set update.auto to false.", within 5 lines

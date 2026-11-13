# Spec Delta

## ADDED Requirements

### Requirement: Directory of the launcher
The state directory MAY hold `launcher/` with `start.mjs`, the launcher of the IDE entry, and `copy.json`, the record of the installed copy (see the capability `launcher`). `copy.json` MUST hold only the directory of the copy: no token, no port and no base URL. The private modes of the state directory apply to both files.

Tests: `test/launcher.test.mjs`

#### Scenario: A state directory after install and a start
- **WHEN** `install` ran in a copy without `.git`, and then a daemon of a copy of npx started
- **THEN** `launcher/` has the mode 0700, `start.mjs` and `copy.json` have the mode 0600, and `copy.json` has only the key `root`

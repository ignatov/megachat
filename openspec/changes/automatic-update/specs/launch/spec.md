# Spec Delta

## MODIFIED Requirements

### Requirement: Version of the daemon in status
The command `status` MUST print the version of the running daemon in the key `version`, directly after the key `running`. When the daemon gives a notice of a release (see the capability `update`), `status` MUST print its text in the key `update`, directly after `version`. A daemon that gives no version or no notice MUST give a line without that key.

Tests: `test/launch.test.mjs`

#### Scenario: The status of a running daemon
- **WHEN** a daemon of a checkout runs, and the user runs `status`
- **THEN** the line has the keys `running`, `version`, `current` and `children` in this order, and `version` is the version of the build of the checkout

#### Scenario: The status of a daemon of an earlier build
- **WHEN** the `/health` answer of the daemon has no key `megachatVersion`, and the user runs `status`
- **THEN** the line is `{"running":true,"current":null,"children":[]}`

#### Scenario: The status with a new release
- **WHEN** the `/health` answer has `megachatVersion` `0.4.0` and `update` `{"available":"0.5.0","notice":"A new release is available: 0.4.0 → 0.5.0"}`, and the user runs `status`
- **THEN** the line is `{"running":true,"version":"0.4.0","update":"A new release is available: 0.4.0 → 0.5.0","current":null,"children":[]}`

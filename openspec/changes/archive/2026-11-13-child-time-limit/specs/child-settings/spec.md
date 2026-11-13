## ADDED Requirements

### Requirement: Time limit of a child run
The setting `children.timeoutMinutes` MUST give the time limit of a Claude, Codex or pi child run in minutes, from 0 to 1440, with the default 240. The value 0 MUST give no limit. Each run MUST take the value of its directory at its start, and a change MUST NOT change the limit of a run that runs. A pi run MUST keep its limit through a restart of the daemon.

Tests: `test/settings.test.mjs`, `test/parallel.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: Allowed values
- **WHEN** the main agent sets `children.timeoutMinutes` to `0`, ` 120 ` or `1440`
- **THEN** the setting stores `0`, `120` or `1440`, and it refuses `-1`, `1441` and `1.5`

#### Scenario: The value of the directory
- **WHEN** the value is 0.005 minutes in the directory `a` and 0 in the directory `b`, and a run starts in each directory
- **THEN** the run in `a` becomes `interrupted` with a time limit of 0.005 minutes, and the run in `b` still runs 600 ms later

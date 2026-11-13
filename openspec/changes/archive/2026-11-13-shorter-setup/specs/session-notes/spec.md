## MODIFIED Requirements

### Requirement: Rules and setup of the notes
The rules of the main agent MUST say in one line what a note is, that it is no request, and the value of the notes. The setup MUST NOT ask for `sessions.notes`. The offer of `sessions.notes` MUST be open only when `sessions.index` is on (see the capability `setting-offers`).

Tests: `test/session-notes.test.mjs`, `test/setting-offers.test.mjs`

#### Scenario: The rules with the notes off
- **WHEN** `sessions.notes` is off
- **THEN** the rules of the main agent have the line that says what a note is, with the value `off` of the setting

#### Scenario: The order of the setup
- **WHEN** a test reads `resources/instructions-onboarding.md`, and the onboarding is `done` in the mode `ghost`
- **THEN** the setup rules do not name `sessions.notes`, the rules have no line of `sessions.notes` while `sessions.index` is off, and they have it after `sessions.index` is on

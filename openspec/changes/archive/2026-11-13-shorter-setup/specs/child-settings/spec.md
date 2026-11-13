## MODIFIED Requirements

### Requirement: Parallel runs in the rules
The setup MUST NOT ask for the setting `children.parallel`. The main agent MUST offer it as the offer rules say (see the capability `setting-offers`). The rules of the main agent MUST say that tasks in different directories run at the same time, and that tasks in one directory or in a directory inside it run one after the other.

Tests: `test/settings.test.mjs`, `test/parallel.test.mjs`, `test/setting-offers.test.mjs`

#### Scenario: The rules of the main agent
- **WHEN** the main agent reads its rules
- **THEN** the rules say "Tasks in different directories run at the same time, at most children.parallel of them." and "Tasks in one directory or in a directory inside it run one after the other"

#### Scenario: The rules of the setup
- **WHEN** a test reads `resources/instructions-onboarding.md` and `resources/instructions-offers.md`
- **THEN** the setup rules do not name `children.parallel`, and the list of the offers names it

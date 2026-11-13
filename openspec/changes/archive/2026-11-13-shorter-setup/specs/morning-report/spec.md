## MODIFIED Requirements

### Requirement: Tools of the report turn
The turn of the report MUST refuse each tool that starts or changes something: a child task, a steer, a change of a setting or of the onboarding, a project create or remove, a close of a child, a cancel, and the account check. It MUST allow the record of an offer (see the capability `setting-offers`). Its rules MUST ask for the report, for a list of the next steps for the user to approve, and for no start of work.

Tests: `test/morning-report.test.mjs`

#### Scenario: The report turn calls each tool that changes something
- **WHEN** the turn of the report calls `agents_spawn`, `agents_send`, `agents_steer`, `agents_settings` to set `reply.length` and to set the onboarding, `agents_projects` to create and to remove a project, `agents_close`, `agents_cancel` and `agents_accounts`
- **THEN** each call gives an error, no child run starts, the projects stay, and `settings.json` does not change

#### Scenario: An offer in the report turn
- **WHEN** the mode is `ghost`, the onboarding is `done`, and the turn of the report calls `agents_settings(action="offer", key="budget.dailyUsd")`
- **THEN** the result has `allowed: true` and the value `0`, and `settings.json` does not change

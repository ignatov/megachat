# Spec Delta

## MODIFIED Requirements

### Requirement: Content of the data
The data MUST hold
- the child runs of the period that finished or failed and the child runs that still run, with title, project, agent and status;
- the permission requests that wait;
- the sessions of the period by project from the session index when `sessions.index` is on;
- with the cloud sessions on (see the capability `cloud-sessions`), the cloud sessions that finished or failed in the period, and the ones that run or wait now.

Tests: `test/morning-report.test.mjs`

#### Scenario: Runs and permission requests
- **WHEN** the period has a completed child run, a failed child run and a child run of the agent `pi` that waits for a permission request since 2026-11-15 at 20:00
- **THEN** the data holds the completed run and the failed run with title, project, agent and status, the run that still runs, and the permission request that waits

#### Scenario: Sessions of the period
- **WHEN** `sessions.index` is on, and the index has two sessions of the period in the project `/work/demo-app`
- **THEN** the data gives the project `/work/demo-app` with 2 sessions

#### Scenario: The session index is off
- **WHEN** `sessions.index` is off
- **THEN** the data says that the sessions part is off

#### Scenario: Cloud sessions of the period
- **WHEN** the cloud sessions are on, and `airc` gives a session that finished on 2026-11-13, a session with the status `ERROR` on 2026-11-14, a session that finished on 2026-11-10, a session with the status `USER_INPUT_REQUIRED` and a session with the status `RUNNING`
- **THEN** the part `cloud` of the data has `state` `on`, the first session in `finished`, the second in `failed`, the fourth in `waiting` and the fifth in `running`, and it does not have the third session

#### Scenario: The cloud sessions are off or airc fails
- **WHEN** the cloud sessions are off, or the read of `airc` fails
- **THEN** the data has no part `cloud`, or the part `cloud` has `state` `unavailable`

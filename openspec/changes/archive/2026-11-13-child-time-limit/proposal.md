## Why

A child run stops after a fixed 30 minutes, also when it still works (issue #41). No setting changes the limit. A child that delegates a long task to its own subagents or workers gets the stop before its final report.

## What Changes

- A new setting `children.timeoutMinutes` gives the time limit of a child run in minutes, from 0 to 1440. The default is 240. 0 gives no limit.
- The setting can have a project value, as the other settings of one child run.
- Each new run of a Claude, Codex or pi child takes the value of its directory at its start. A run that runs keeps its limit. A pi run keeps it also through a restart of the daemon.
- The user sees the change in the answers of the settings tool, in the error of a run at its limit, and in the README.

## Capabilities

### New Capabilities

### Modified Capabilities

- `child-settings`: the new setting `children.timeoutMinutes`.
- `project-settings`: the list of the settings that can have a project value.
- `pi-child`: the deadline of a pi run comes from the setting.

## Impact

- `src/Settings.mjs`, `src/AcpRunService.mjs`, `src/PiRunService.mjs`, `src/main.mjs`, `resources/Megachat.properties`, `resources/instructions-onboarding.md`, `README.md`.
- No ACP extension changes, so Air needs no change.
- Out of scope: a limit of inactivity, the report of the partial work of a stopped run, and the status `cancelled` of a stop at the limit.

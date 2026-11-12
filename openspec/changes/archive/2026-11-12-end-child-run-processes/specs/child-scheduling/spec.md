# Spec Delta

## MODIFIED Requirements

### Requirement: One child for one checkout
Two children MUST never run in one checkout at the same time, whatever the limit is, because two agents that change one checkout break the work of each other. A follow-up, a continuation and a continuation for a message of the user MUST keep the rule of their directory. A run MUST keep its place until its supervisor exited, at most 6 seconds after its end (see `child-processes`).

Tests: `test/parallel.test.mjs`, `test/integration.test.mjs`, `test/child-processes.test.mjs`

#### Scenario: Two tasks in one directory
- **WHEN** a task runs in the directory `a`, and a second task in `a` is queued
- **THEN** the second task starts only after the end of the first task, and a task in the directory `b` does not wait

#### Scenario: The next task after the processes of a cancelled run
- **WHEN** the run of the stand-in ACP agent in the directory `a` has a shell that ends 500 ms after SIGTERM, the user cancels the run, and a second task in `a` is queued
- **THEN** the agent of the second task starts only after the shell ended

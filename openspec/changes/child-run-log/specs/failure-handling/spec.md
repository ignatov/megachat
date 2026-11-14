# Spec Delta

## ADDED Requirements

### Requirement: Lines of a child run in the log
The log of the daemon MUST get one line when a child run is admitted, with its kind, and one line when it ends, with its status, its duration and its continuation. A run that ends on an error MUST get an error line before its end line, with the class and the first sentence of the error. A line MUST NOT hold the prompt, the output, a token or a key.

Tests: `test/run-log.test.mjs`

#### Scenario: A follow-up of a child
- **WHEN** a child run completes, and then `agents_send` adds a follow-up to its child session
- **THEN** the log has the lines `started kind=spawn`, `ended status=completed`, `started kind=send` with the provider session ID of the child, and `ended status=completed`, and no line holds the prompt

#### Scenario: A time limit and a login
- **WHEN** a run reaches its time limit, and another run gets the answer that asks for a login
- **THEN** the first run has the line `error class=timeout` and `ended status=timeout`, and the second run has `error class=login` and `ended status=interrupted`

### Requirement: Lines of a restart and of a stop for a message
A restart of the daemon MUST write the error line with the class `daemonRestart` and the end line of each run that it interrupts, and the start line of its continuation with the kind `recovery`. A stop for a message of the user MUST write the end line with `resumedBy` and the start line with the kind `steer-restart`, and no error line.

Tests: `test/run-log.test.mjs`

#### Scenario: A dispatched run at a restart
- **WHEN** a daemon starts and finds a dispatched run
- **THEN** the log has `error class=daemonRestart`, `ended status=interrupted resumedBy=<new run>` and `started kind=recovery resumeOf=<run>`

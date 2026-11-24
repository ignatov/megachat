# Spec Delta

## ADDED Requirements

### Requirement: Line about Junie
`install` MUST print one line about Junie after the line about Codex: the path of the first `junie` on the `PATH` of a child, or that the command is not on the `PATH` and that a Junie child is not available without it. A directory that npm adds MUST NOT count. The line MUST NOT change the exit code, because Junie is optional.

Tests: `test/install.test.mjs`

#### Scenario: Junie on the PATH
- **WHEN** `install` runs, and the directory `/opt/tools` of the `PATH` holds a file `junie` that the user can run
- **THEN** `install` prints "A Junie child uses Junie at /opt/tools/junie."

#### Scenario: No Junie
- **WHEN** `install` runs, the `PATH` holds no `junie`, and each other check passes
- **THEN** `install` prints "The command junie is not on the PATH. A Junie child is not available until you install Junie CLI.", and it exits with the code 0

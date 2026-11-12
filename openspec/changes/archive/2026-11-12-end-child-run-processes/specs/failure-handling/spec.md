# Spec Delta

## MODIFIED Requirements

### Requirement: Lifetime of a child agent
A child agent MUST NOT stay alive after its daemon, also when it still writes output. A stop and a loss of the daemon MUST send SIGKILL only to the process group of the agent, so a process of the run in a session of its own, such as a shell that restarts the daemon, stays. When the agent ends by itself while the daemon runs, each process of the run MUST end (see the capability `child-processes`).

Tests: `test/recovery.test.mjs`, `test/child-processes.test.mjs`

#### Scenario: A child that writes after the daemon closed the output
- **WHEN** the daemon closes the output of a child, and the child ignores the closed output and writes again
- **THEN** the supervisor stops the child

#### Scenario: A helper of an agent that ends by itself
- **WHEN** an agent starts `sleep 47` in the background in its process group and exits with the code 0
- **THEN** the supervisor stops the `sleep 47` helper

#### Scenario: A shell that stops the daemon
- **WHEN** the shell of the run in a session of its own writes the file `stop`, the daemon stops, and the shell writes the file `marker` 1 second later
- **THEN** the file `marker` exists, and the shell got no signal

#### Scenario: A loss of the daemon
- **WHEN** the stand-in daemon gets SIGKILL while the shell of the run runs `sleep 61` in a session of its own
- **THEN** the agent ends, and the shell and the `sleep 61` still run

#### Scenario: A crash of Claude Code while the daemon runs
- **WHEN** the stand-in of Claude Code gets SIGKILL while its shell runs `sleep 61`, so the shell gets the parent PID 1, and the adapter then exits with the code 1
- **THEN** the shell and the `sleep 61` end

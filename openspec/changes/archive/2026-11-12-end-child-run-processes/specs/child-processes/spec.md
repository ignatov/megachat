# Spec Delta

## Purpose

The processes that a Claude or Codex child run starts end when the run stops or fails while the daemon runs, so a
shell, a build or a server of such a run does not stay. Only the processes that the run started get a signal.

## ADDED Requirements

### Requirement: End of the processes of a run
While the daemon runs, a cancel, a Stop of a row or of the turn, a deadline, the limit of the error output, a stop for a message of the user and a failure of a Claude or Codex child run MUST end each process of the run, also a process in a session of its own and a process whose parent ended first. The daemon MUST ask for it with the word `clean` on the lifetime pipe.

Tests: `test/child-processes.test.mjs`

#### Scenario: The word clean
- **WHEN** the stand-in of Claude Code starts `/bin/sh` in a session of its own, the shell runs `sleep 61`, and the daemon ends the lifetime pipe with the word `clean`
- **THEN** the shell and the `sleep 61` end, and the supervisor exits

#### Scenario: A cancel
- **WHEN** the stand-in ACP agent got the prompt `shell`, its shell runs `sleep 61`, and the user cancels the run
- **THEN** the run becomes `cancelled`, and the shell and the `sleep 61` end

### Requirement: Processes of a completed run
When the prompt of a run ends with the stop reason `end_turn`, only the process group of the agent MUST get SIGKILL, as before. A process that the agent left outside that group, such as a server that the task started, MUST stay.

Tests: `test/child-processes.test.mjs`

#### Scenario: A shell after a completed prompt
- **WHEN** the stand-in ACP agent got the prompt `shell-done`, so its shell runs `sleep 61` in a session of its own, and the prompt ends with `end_turn`
- **THEN** the run becomes `completed`, the agent ends, and the `sleep 61` still runs

### Requirement: Record of the processes of a run
On macOS, the supervisor MUST read the process table at the start of the agent and every second while the agent runs, with `LC_ALL=C`. It MUST keep the PID, the start time, the user and the process group of each process of the run. The read MUST NOT get a command line.

Tests: `test/child-processes.test.mjs`

#### Scenario: A shell whose parent ended first
- **WHEN** a read found the shell 41 below the stand-in of Claude Code 40, and then the process 40 ended, so the shell 41 has the parent PID 1
- **THEN** the shell 41 is a process of the run

### Requirement: Selection of the processes of a run
A process MUST be a process of the run only when it is the agent, when the record has it with the same start time and user, when its parent is a process of the run, or when it is in a process group whose ID is a PID of the record and that has a live process of the run. A name, a command line or an environment variable MUST NOT select a process.

Tests: `test/child-processes.test.mjs`

#### Scenario: A process in the group of a shell of the run
- **WHEN** the shell 41 is in the record, and the process 42 with the parent PID 1 is in the process group 41
- **THEN** the process 42 is a process of the run

#### Scenario: A process that the run did not start
- **WHEN** the process 50 is a server that ran before the run, and the agent of the run sends requests to it
- **THEN** the process 50 is not a process of the run

### Requirement: Guards of a signal
The function that sends a signal MUST refuse a PID that is 1 or below, the supervisor, the daemon or a process above them, that the read before the signal does not have, that the record does not have with the same start time and user, that started in an earlier second than the agent, or whose process group ID is no PID of the record. A refusal MUST send no signal and MUST give one log line with numbers only.

Tests: `test/child-processes.test.mjs`

#### Scenario: A PID of another process
- **WHEN** the record has the PID 41 with the start time 10:00:00, and the read before the signal gives the PID 41 with the start time 10:05:00
- **THEN** the PID 41 gets no signal, and the refusal gives the PID 41 and the check 3 to the log line

#### Scenario: A process that is older than the agent
- **WHEN** a defect puts the process 44 in the record, and the process 44 started one second before the agent
- **THEN** the PID 44 gets no signal, and the refusal gives the PID 44 and the check 4 to the log line

#### Scenario: A group that the run did not make
- **WHEN** the record has the process 45 in the process group 30, and the record has no PID 30
- **THEN** the PID 45 gets no signal, and the refusal gives the PID 45 and the check 5 to the log line

#### Scenario: The daemon and a process of another user
- **WHEN** a table has the daemon as the parent of the supervisor, and the process 43 of the run belongs to another user
- **THEN** neither the daemon nor the process 43 gets a signal

### Requirement: Check before a signal
Directly before a signal to a process of the run, the supervisor MUST read the process table again. When the read fails, takes more than 2 seconds, or gives no line for the process, only the process group of the agent MUST get the signal. A line that does not parse MUST give no process.

Tests: `test/child-processes.test.mjs`

#### Scenario: A read that fails
- **WHEN** the read before the signal fails
- **THEN** only the process group of the agent gets SIGTERM, and then SIGKILL

#### Scenario: A process that ended before the parse
- **WHEN** the table has a cut line for the PID 46, and the record has the PID 46
- **THEN** the PID 46 gets no signal

### Requirement: Order of the signals
When the processes of a run end, the process group of the agent MUST get SIGTERM first, then each other process of the run. Each one that still runs after 1 second MUST get SIGKILL. The supervisor MUST read the table at the end only when the record has a process outside the process group of the agent. The end MUST NOT take more than 5 seconds longer than before.

Tests: `test/child-processes.test.mjs`

#### Scenario: A shell that handles SIGTERM
- **WHEN** the shell of the run writes the word `term` to a file when it gets SIGTERM, and the daemon asks for the end of the processes of the run
- **THEN** the file has the word `term`, and the shell ends

#### Scenario: A shell that ignores SIGTERM
- **WHEN** the shell of the run ignores SIGTERM, and the daemon asks for the end of the processes of the run
- **THEN** the shell gets SIGKILL after 1 second, and the supervisor exits less than 5 seconds after the request

### Requirement: Error output of a run with processes
When the agent ends, the supervisor MUST tell the daemon its exit code and the count of the bytes of its error output before it ends the other processes of the run. The wait of a failed run for its error output (see the capability `failure-handling`) MUST end when the daemon has these bytes, so the end of the other processes does not cut the reason of the run.

Tests: `test/child-processes.test.mjs`

#### Scenario: An error answer with a live shell
- **WHEN** the stand-in ACP agent got the prompt `shell-fail`, so its shell ignores SIGTERM, the agent writes `Error: The stand-in agent failed` with no line break to its error output, answers the prompt with the error -32603 and stays alive, and the wait for the error output is 150 ms
- **THEN** the error of the run gives the line `Error: The stand-in agent failed` with its last word, and the shell ends

#### Scenario: A crash with a live shell
- **WHEN** the stand-in ACP agent got the prompt `shell-crash`, so its shell ignores SIGTERM, and the agent writes `Error: The stand-in agent crashed.` to its error output and exits with the code 1
- **THEN** the error of the run gives the exit code 1 and the line `Error: The stand-in agent crashed.`, and the shell ends

### Requirement: Other platforms
On a platform other than macOS, the supervisor MUST NOT read the process table. At each end of a run, it MUST send SIGKILL to the process group of the agent, as before.

Tests: `test/child-processes.test.mjs`

#### Scenario: Linux
- **WHEN** the supervisor runs on `linux`, and the daemon asks for the end of the processes of the run
- **THEN** no read of the process table runs, and the process group of the agent gets SIGKILL

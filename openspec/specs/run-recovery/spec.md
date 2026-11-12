# run-recovery Specification

## Purpose
Megachat recovers the runs that a daemon restart or an exit of an agent interrupts. It does not send an uncertain prompt again as a new task, and it continues an interrupted run automatically a limited number of times.

## Requirements

### Requirement: Repeated request ID
A repeated request ID MUST return the original admission. A repeated request ID with different arguments MUST fail.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`, `test/recovery.test.mjs`

#### Scenario: The same input two times
- **WHEN** a client sends the request ID `request` with the text "Hello" two times
- **THEN** the two answers have the same submission and the same main run

#### Scenario: Different arguments
- **WHEN** a client sends the request ID `request` again with the text "Different"
- **THEN** the input fails with the code `conflict`

#### Scenario: A repeated request ID after a restart
- **WHEN** the daemon gets `SIGKILL` and starts again, and a client sends the request ID `original` again
- **THEN** the answer has the submission of the original admission

### Requirement: Uncertain dispatch
An uncertain dispatch MUST become interrupted after a daemon restart. Recovery MUST NOT send an uncertain prompt again as a new task.

Tests: `test/state.test.mjs`, `test/recovery.test.mjs`

#### Scenario: A dispatch of an earlier process
- **WHEN** a run is `dispatched` in the process generation `old-process` and the recovery runs
- **THEN** the run becomes `interrupted`

#### Scenario: A restart after SIGKILL
- **WHEN** the agent got the prompt `approval`, and the daemon gets `SIGKILL` and starts again
- **THEN** the agent does not get `approval` again as a new task, and it gets the continuation prompt in the same provider session

### Requirement: Automatic continuation
An interrupted run MUST continue automatically unless the user cancelled it or it reached a limit. An agent that cannot use an HTTP MCP server or cannot load a session MUST end its run with that reason, without a continuation.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`

#### Scenario: A cancelled run and a limited run
- **WHEN** the user cancelled one dispatched run, another run is interrupted at a limit, and the recovery runs
- **THEN** the cancelled run stays `cancelled`, the limited run stays `interrupted`, and neither run gets a continuation

#### Scenario: An agent without an HTTP MCP server
- **WHEN** the agent of a child does not accept an HTTP MCP server
- **THEN** the run becomes `interrupted` with the error "The agent does not accept an HTTP MCP server, so it cannot read the Megachat history.", the agent gets no prompt, and no continuation starts

### Requirement: Prompt of a continuation
A continuation of a sent prompt MUST resume the same provider session with a prompt to check the work and continue. That prompt MUST quote the task, because the provider can lose a prompt that it did not store. A run that never sent its prompt MUST send that prompt again.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`, `test/recovery.test.mjs`

#### Scenario: A sent prompt
- **WHEN** the agent exits after it got the prompt `crash`
- **THEN** the continuation loads the same session, and the agent gets the prompt to check the work and continue, followed by "The task was:" and `crash`

#### Scenario: A prompt that was never sent
- **WHEN** a run with the prompt "Implement it" was `launching` in an earlier process, and the recovery runs
- **THEN** the continuation sends the prompt "Implement it" again, without a provider session

### Requirement: Count of continuations
A run MUST receive at most two automatic continuations, each after a longer delay. A continuation after a planned stop of the daemon MUST NOT count as one of the two.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`

#### Scenario: The first continuation
- **WHEN** a dispatched run is interrupted
- **THEN** its continuation has the attempt 1, and it starts at least 5 seconds later

#### Scenario: Planned stops of the daemon
- **WHEN** four planned stops of the daemon interrupt a run, and then an interruption that is not planned occurs
- **THEN** each continuation after a planned stop has the attempt 0, and the next continuation has the attempt 1

### Requirement: Resumed run and its report
The interrupted run MUST become resumed and name its continuation. The main conversation MUST receive one report. A continuation MUST keep the title of the task. Its report MUST give the task of the user and the title, not the prompt of the continuation.

Tests: `test/state.test.mjs`, `test/integration.test.mjs`, `test/recovery.test.mjs`

#### Scenario: The link between the runs
- **WHEN** an interrupted run gets a continuation
- **THEN** the interrupted run is `resumed` and names the continuation, and the continuation names the interrupted run

#### Scenario: The title and the task in the report
- **WHEN** a task "Implement it" with the title "Implement the parser" ends in a continuation
- **THEN** the continuation has the title "Implement the parser", and the one report gives "Implement it" and "Implement the parser"

### Requirement: End of a continuation
Cancelling a resumed run MUST cancel its continuation. A failed final continuation MUST remain interrupted and MUST be reported.

Tests: `test/state.test.mjs`

#### Scenario: Cancel of a resumed run
- **WHEN** the user cancels a run that is `resumed`
- **THEN** its continuation becomes `cancelled`

#### Scenario: A failed final continuation
- **WHEN** the second continuation of a run is interrupted
- **THEN** the continuation stays `interrupted`, and no other continuation starts

### Requirement: Answers from an earlier process generation
An answer from a previous process generation MUST fail.

Tests: `test/state.test.mjs`

#### Scenario: A permission request of an earlier process
- **WHEN** a child of the process generation `old-process` asked for permission, and the recovery runs
- **THEN** the permission request becomes `stale`, and the answer `yes` fails with the code `stale`

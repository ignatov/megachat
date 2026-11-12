# stop-sessions Specification

## Purpose
The tool `agents_stop` of the main agent stops an orphan session that `agents_running` lists (see the capability `running-sessions`). It sends a signal only after an answer of the user in the permission dialog of the client.

## Requirements

### Requirement: Stop tool
The tool `agents_stop` of the main agent MUST stop an orphan session of `agents_running` with a signal, only after an answer of the user in the permission dialog of the client. The MCP server of the children MUST NOT have the tool. A restart of the daemon MUST NOT run a cut-off call again.

Tests: `test/stop.test.mjs`

#### Scenario: The answer of the user
- **WHEN** the main agent calls `agents_stop` with the PIDs 70 and 71 of two orphans, and the user selects `stop` in the dialog
- **THEN** the processes 70 and 71 get `SIGTERM` one time each, and the outcome is `stopped`

#### Scenario: The tools of a child
- **WHEN** a child of Megachat gets the tools of its MCP server
- **THEN** the tools have no `agents_stop`

#### Scenario: A restart of the daemon
- **WHEN** the daemon restarts after a call of `agents_stop` that the restart cut off
- **THEN** Megachat does not run that call again

### Requirement: Stop request
A call MUST send no signal. It MUST make a stop request for its targets and wait in the turn for the answer, at most 5 minutes. A list without a target MUST give the outcome `none` and show no dialog.

Tests: `test/stop.test.mjs`

#### Scenario: A call waits in the turn
- **WHEN** the main agent calls `agents_stop` with the PIDs 70 and 71 of two orphans
- **THEN** no signal goes out, the turn stays open while the dialog shows, and the request expires 5 minutes after the call

#### Scenario: A list without an orphan
- **WHEN** the main agent calls `agents_stop` with the PIDs 20 and 51, and neither is an orphan
- **THEN** the outcome is `none`, the result has no target, and no view shows a dialog

### Requirement: Result of a call
The result MUST give the targets (the PID, the start time, the agent, the program, the project, the owner and the sessions of each process), the refused PIDs with a reason that the model can give to the user, and the outcome: `stopped`, `declined`, `expired`, `changed`, `replaced` or `none`.

Tests: `test/stop.test.mjs`

#### Scenario: A list with orphans and other PIDs
- **WHEN** the main agent calls `agents_stop` with the PIDs 70, 71, 20, 51, 10, 12 and 4242, only 70 and 71 are orphans, and the user selects `stop`
- **THEN** the targets are 70 and 71, each with its agent, program, project and start time, the refused PIDs are 20, 51, 10, 12 and 4242, each with a reason, and the outcome is `stopped`

#### Scenario: The answer keep
- **WHEN** the user selects `keep` in the dialog for the PID 70
- **THEN** no signal goes out, and the outcome is `declined`

### Requirement: No signal through an argument
No argument of a tool call MUST send a signal. The tool MUST take no confirmation. Only the answer `stop` of the user through `/stop/answer` MUST send it.

Tests: `test/stop.test.mjs`

#### Scenario: A confirmation argument
- **WHEN** the main agent calls `agents_stop` with the PID 70 and a `confirmation`, or with `approved` set to true
- **THEN** the call fails, and no signal goes out

#### Scenario: The parameters of the tool
- **WHEN** the main agent gets the tool `agents_stop`
- **THEN** the parameters of the tool are only `pids` and `signal`

### Requirement: Stop dialog
The bridge MUST show each open stop request in each view through `session/request_permission`. The dialog MUST name each PID with its agent and its project. It MUST offer `stop` (`allow_once`) and `keep` (`reject_once`), and no option for always. A view that opens while the request is open MUST show it too.

Tests: `test/stop.test.mjs`

#### Scenario: Two views
- **WHEN** two views are open, and the main agent calls `agents_stop` with the PID 70 of Claude Code in the project `lost` and the PID 71 of Codex in the project `codex`
- **THEN** each view shows the dialog, the dialog has one line for each PID with its agent and its project, and the options are `stop` and `keep`

#### Scenario: The options
- **WHEN** the bridge makes the dialog of a stop request
- **THEN** the dialog offers `stop` with the kind `allow_once` and `keep` with the kind `reject_once`, and no other option

#### Scenario: A view that opens later
- **WHEN** a stop request is open, and a view opens after the call
- **THEN** that view shows the dialog

### Requirement: Answers to a request
Only the first answer to an open request MUST count. An answer to a request that got an answer, that expired, that a newer request replaced, whose turn stopped, or that the daemon does not know MUST be refused, and it MUST send no signal. A new call MUST replace the open request.

Tests: `test/stop.test.mjs`

#### Scenario: The first answer of two views
- **WHEN** two views show the dialog, the first view answers `stop`, and then the other view answers `stop`
- **THEN** the processes get `SIGTERM` one time, and the answer of the other view is refused

#### Scenario: A late or an unknown answer
- **WHEN** an answer comes after the request expired, or names a request that the daemon does not know
- **THEN** the answer is refused, and no signal goes out

#### Scenario: A newer call
- **WHEN** a stop request for the PID 70 is open, and the main agent calls `agents_stop` for the PID 71
- **THEN** the outcome of the first call is `replaced`, the answer `stop` to the first dialog is refused, and the answer `stop` to the second dialog sends `SIGTERM` to the PID 71 only

### Requirement: End of a dialog
When a request closes, each view that showed it MUST end its tool call with a final status, so Air removes the dialog. A cancel of Air MUST send nothing to the daemon.

Tests: `test/stop.test.mjs`

#### Scenario: The other view
- **WHEN** two views show the dialog, and the first view answers `stop`
- **THEN** the other view gets the final status `completed` for the tool call of the dialog

#### Scenario: A cancel of Air
- **WHEN** Air gives the answer `cancelled` to the dialog
- **THEN** the request stays open, and when it expires, the view gets the final status `failed`

### Requirement: Requests in the memory
The requests MUST stay in the memory of the daemon only, not in the state. A restart of the daemon MUST remove each one. Without a client, the request MUST wait and expire. When no client stream got the request, the result MUST tell the main agent to ask the user to open the chat.

Tests: `test/stop.test.mjs`

#### Scenario: A request without a chat
- **WHEN** no chat is open, and the main agent calls `agents_stop` for the PID 70
- **THEN** the request waits, it expires after 5 minutes with the outcome `expired`, and the result tells the main agent to ask the user to open the chat

#### Scenario: A stop of the daemon
- **WHEN** a stop request is open, and the daemon stops
- **THEN** the request closes with the outcome `cancelled`, and no signal goes out

### Requirement: Stop of the turn
A stop of the turn MUST close the request. When the turn of the request does not run any more at the answer, no signal MUST go out.

Tests: `test/stop.test.mjs`

#### Scenario: A stop of the turn while the dialog shows
- **WHEN** the dialog for the PID 70 shows, and the user stops the turn
- **THEN** the turn ends, the view gets the final status `failed` for the dialog, and a later answer `stop` is refused and sends no signal

#### Scenario: Another turn at the answer
- **WHEN** a new turn starts while the request is open, and then the user answers `stop`
- **THEN** no signal goes out

### Requirement: Check before the signal
After the answer, directly before the signal, Megachat MUST read the process table again. Each process MUST have the same PID, the same start time and the same command, and its state MUST still be `orphan`. Else no process of the call MUST get the signal, and the result MUST give the reason for each changed process.

Tests: `test/stop.test.mjs`

#### Scenario: A read of the process table
- **WHEN** the user answers `stop` for the PID 70
- **THEN** Megachat reads the process table one more time before it sends `SIGTERM`

#### Scenario: A changed process
- **WHEN** the dialog is for the PIDs 70 and 71, the process 70 gets another start time, another command, ends, or gets a live owner, and then the user answers `stop`
- **THEN** neither process gets the signal, the outcome is `changed`, and the result gives the reason for the PID 70 only

#### Scenario: A continuation of a Megachat run
- **WHEN** the dialog is for the child 81 of an ended run, a continuation of that run starts, and then the user answers `stop`
- **THEN** the PID 81 gets no signal, and the result gives its owner `Megachat`

### Requirement: Turn of the user
Only a turn of the user MUST call the tool. An automatic turn, a turn that stops and a call without a turn MUST be refused, and they MUST show no dialog.

Tests: `test/stop.test.mjs`

#### Scenario: An automatic turn
- **WHEN** the main agent calls `agents_stop` in a turn of the kind `report`, `event` or `morning`
- **THEN** the call is refused, no view shows a dialog, and no signal goes out

#### Scenario: A turn that stops and no turn
- **WHEN** a call of `agents_stop` comes in a turn that stops, or when no turn runs
- **THEN** the call is refused, no view shows a dialog, and no signal goes out

### Requirement: Only an orphan
Megachat MUST stop only an orphan. A session with a live owner, such as an IDE, a terminal, a multiplexer or a Megachat run, MUST be refused with the name of its owner, so the user stops it through the owner. A session in the state `unknown` and a PID that is no agent session MUST be refused too.

Tests: `test/stop.test.mjs`

#### Scenario: A session with a live owner
- **WHEN** the main agent calls `agents_stop` with the PID 20 of a session in `IntelliJ IDEA 2026.3 EAP`, and the PID 51 of a session in `tmux`
- **THEN** each PID is refused with the name of its owner

#### Scenario: A session in the state unknown and no session
- **WHEN** the main agent calls `agents_stop` with the PID 12 of a session below a `java` process that is no sure IDE, and the PID 4242 that is no agent session
- **THEN** both PIDs are refused

### Requirement: SIGTERM and SIGKILL
The first signal MUST be `SIGTERM`. `SIGKILL` MUST go out only after a second dialog and answer, and only to a process that got `SIGTERM` from this tool and still lives with the same start time and command.

Tests: `test/stop.test.mjs`

#### Scenario: SIGKILL before SIGTERM
- **WHEN** the main agent asks for `SIGKILL` to the PID 70, and the PID 70 got no `SIGTERM` from `agents_stop`
- **THEN** the PID 70 is refused, the outcome is `none`, and no view shows a dialog

#### Scenario: SIGKILL after SIGTERM
- **WHEN** the PID 70 got `SIGTERM` from `agents_stop` and still runs, the main agent asks for `SIGKILL` to it, and the user answers `stop` in the second dialog
- **THEN** the PID 70 gets `SIGKILL`

#### Scenario: A reused PID
- **WHEN** the PID 71 got `SIGTERM` from `agents_stop`, and now another process with another start time has the PID 71
- **THEN** a request for `SIGKILL` to the PID 71 is refused

### Requirement: Protected processes
Before each other check, the tool MUST refuse PID 1 and below, the PID of the daemon, its parent, each process above them, and a process of another user or of an unknown user. Megachat MUST check this again before the signal. On a platform where `agents_running` gives no row, the tool MUST refuse.

Tests: `test/stop.test.mjs`

#### Scenario: The daemon and the processes above it
- **WHEN** the call has the PID 1, 0, the PID of the daemon, the PID of its launcher or the PID of the IDE above them
- **THEN** the tool refuses the call, also in an automatic turn, and no view shows a dialog

#### Scenario: A process of another user
- **WHEN** the call has the PID 72 of a process of another user, or the daemon cannot tell its own user
- **THEN** the tool refuses the call

#### Scenario: Linux
- **WHEN** Megachat runs on `linux`
- **THEN** the tool refuses the call, and no signal goes out

### Requirement: Injected functions
The signal function, the process table and the timer of the expiry MUST come by injection, so a test sends no real signal. The default signal function MUST be `process.kill`.

Tests: `test/stop.test.mjs`

#### Scenario: The default signal function
- **WHEN** Megachat makes the tool without a signal function, and the user answers `stop` for the PID 70
- **THEN** `process.kill` gets the PID 70 and `SIGTERM`

#### Scenario: The timer of the expiry
- **WHEN** a call makes a stop request
- **THEN** the injected timer gets the time of 5 minutes, and the request expires when that timer runs

### Requirement: Result and log
The result, the stop request and the log of the daemon MUST hold no content of a session and no command line. The log MUST hold the PIDs and the outcome (`sent`, `ended`, `denied` or `failed`).

Tests: `test/stop.test.mjs`

#### Scenario: Two sent signals
- **WHEN** the PIDs 70 and 71 get `SIGTERM`, and each command line has the argument `--token sk-marker-0123456789`
- **THEN** the log of the daemon has one line with `70:sent,71:sent`, and the result and the stop request do not have `sk-marker-0123456789`

#### Scenario: Failed signals
- **WHEN** the signal to the PID 70 fails with `ESRCH`, and the signal to the PID 71 fails with `EPERM`
- **THEN** the result gives the outcome `ended` for the PID 70 and `denied` for the PID 71

### Requirement: Instructions of the main agent
The instructions of the main agent MUST tell it to call the tool one time for the PIDs that the user asked for, that only the answer of the user in the dialog sends the signal, and that it cannot answer the dialog.

Tests: `test/stop.test.mjs`

#### Scenario: The instructions
- **WHEN** the main agent gets its instructions
- **THEN** they tell it to call `agents_stop` one time with the PIDs, that only the answer of the user sends the signal, and that it cannot answer the dialog, and they do not have the word "confirmation"

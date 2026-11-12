# Design

## Context

See `proposal.md` for the reason of the change.

### The code today

- `AcpRunService.execute` starts `src/child-supervisor.mjs` with the agent command and four pipes. The fourth pipe is
  the lifetime pipe. The supervisor starts the agent with `detached: true`, so the agent gets a session and a process
  group of its own (setsid). The daemon keeps the PID of the supervisor in the field `pid` of the run.
- `AcpRunService.kill` closes the lifetime pipe and sends SIGTERM to the supervisor. Each end of a run calls it: the
  `finally` of `execute` (a completion too), `limit` (the deadline and the limit of 1 MB of error output), the
  escalation of a cancel after 5 seconds, `errorOutputEnd`, and `close` through `work.lifetime` (a stop of the daemon).
  A cancel before the prompt calls it at once. After the prompt, a cancel first sends `session/cancel`.
- The supervisor sends SIGKILL to the process group of the agent on SIGTERM, on SIGINT, at the end of the lifetime
  pipe (also after a SIGKILL of the daemon), and at an error of a pipe. When the agent exits, the supervisor sends
  SIGKILL to that process group again and exits with the exit code of the agent.

### How the agents start a shell

The places are in `node_modules`, read-only, at the versions of `package-lock.json`.

- `@anthropic-ai/claude-agent-sdk` 0.3.321, `sdk.mjs` (minified), `spawnLocalProcess`: the SDK starts the Claude Code
  binary with `stdio: ["pipe","pipe","pipe"]` and without `detached`. So Claude Code is in the process group of the
  adapter.
- The Claude Code binary `@anthropic-ai/claude-agent-sdk-darwin-arm64/claude` 0.3.321 (a Bun binary with its
  JavaScript inside; read with `strings`): the bash provider of the shell tool returns `{type:"bash", shellPath,
  detached:!0, ...}`, and the spawn of the Bash tool passes `detached:to.detached`. On POSIX that is setsid: the shell
  gets a session and a process group of its own. An abort of a tool call sends `process.kill(-pid,"SIGTERM")` to the
  process group of the shell. An exit handler (`cli_shell_exit_sweep`) does the same for each live shell command, and on
  Linux it also follows the descendants. A shell command leaves this list when its shell exits. SIGKILL runs no
  handler.
- `@agentclientprotocol/codex-acp` 2.6.0, `dist/index.js`: the adapter starts `codex app-server` without `detached`.
  The Codex binary is not in `node_modules`. The installed `codex` 0.167.0 imports `setsid`, `setpgid`, `killpg`,
  `openpty` and `posix_spawnattr_setpgroup` (`nm -u`). So Codex very probably also starts its shell commands in a group
  or a session of their own. This design does not depend on it: it follows the parent of each process, not its group.

### The probe of 2026-11-12

A stand-in tree ran through the real `src/child-supervisor.mjs` of `c40c45e`, with no provider: a stand-in daemon with
the lifetime pipe, a stand-in adapter, a stand-in of Claude Code in the process group of the adapter, and a `/bin/zsh`
with `detached: true` that runs `sleep 300`. Each signal of the probe went to a PID that the probe started and
recorded, after a check of its start time. The probe ended each survivor.

| End of the run | What gets a signal today | What survives |
| --- | --- | --- |
| `AcpRunService.kill`: a deadline, the limit of the error output, the escalation of a cancel, a stop for a message of the user, a completed run, a stop of the daemon (by the code) | SIGKILL to the process group of the agent | the shell (now with the parent PID 1) and its `sleep` |
| A cancel, and the agent ends its tool as Claude Code does (SIGTERM to the group of the shell), then the kill | the shell group from the agent, then SIGKILL to the group of the agent | nothing |
| A cancel, and the agent does not end its tool, then the kill | SIGKILL to the process group of the agent | the shell and its `sleep` |
| A kill of the daemon (SIGKILL): the supervisor sees the end of the lifetime pipe | SIGKILL to the process group of the agent | the shell (parent PID 1) and its `sleep` |
| A crash of the adapter | SIGKILL to the process group of the agent at the exit | the shell and its `sleep` |
| A crash of Claude Code (SIGKILL), the adapter stays, then the kill of the run | SIGKILL to the process group of the agent | the shell (parent PID 1) and its `sleep` |
| A crash of Claude Code, the adapter exits by itself | SIGKILL to the process group of the agent at the exit | the shell and its `sleep` |
| The kill, and an agent that ends its shells on SIGTERM | SIGKILL to the process group of the agent, so the handler does not run | the shell and its `sleep` |

Three more measurements:

- `zsh -c 'sleep 30 >/dev/null 2>&1 & echo $!'` with `detached: true` lived 10.1 ms. Its `sleep` then had the parent
  PID 1 and the process group of the dead shell.
- `ps -E -ww` gave the environment of a Node.js process and of `/usr/bin/python3`, but not of `/bin/zsh` and
  `/bin/sleep`. macOS hides the environment of its own programs.
- Ten reads of `/bin/ps -ax -o pid=,ppid=,pgid=,uid=,lstart=` on a machine with 1,254 processes took 0.41 s and 0.04 s
  of CPU time. One read is about 40 ms and 4 ms of CPU time. `ps -o sess` gives 0 on macOS, so `ps` gives no session ID.

The real Claude Code binary did not run, because it needs a provider. So the behavior of Claude Code in the table comes
from its code and from the stand-in.

## Goals / Non-Goals

**Goals:**
- A cancel, a Stop, a deadline, a limit, a stop for a message of the user and a failure of a run while the daemon runs
  end each process that the run started and that the supervisor can prove.
- No signal to a process that the run did not start, also when the selection has a defect: guards in the signal
  function that do not use the selection.
- A stop and a loss of the daemon and a completed run keep the behavior of today.
- The error of a failed run keeps its complete reason.

**Non-Goals:**
- No new field in the state. The record of the processes of a run is in the memory of the supervisor only.
- No change of the ACP messages, of the statuses of a run, or of the deadline and the limits.
- No change on Linux and on Windows.
- No end of a process of the run at a stop of the daemon (see decision 4).

## Decisions

### 1. Which processes are processes of the run

A process is a process of the run when one of these is true, and the rule repeats until no process joins:

- it is the agent, while the supervisor has not seen its exit;
- the record has it with the same PID, start time and user;
- its parent is a process of the run;
- it is in a process group whose ID is a PID that the record had (a group that a process of the run made), and a live
  process of the run is in that group.

The group rule is safe because of two rules of the kernel. A process can join only a process group of its own session,
and a process cannot change to a session that it did not make. So a process in the same group as a live process of the
run is in a session that the agent or one of its descendants made, and it descends from the run.

The supervisor reads the process table at the start of the agent and every second while the agent runs. Each read adds
each process of the run to the record. The record also keeps each PID that it had, with its start time, as the IDs of
the groups that the run made.

Alternatives:

- **A walk of the parent PIDs at the end only.** Rejected: the probe shows that the shell has the parent PID 1 after
  a crash of the agent, so the walk finds nothing then.
- **A signal to each process group that the supervisor saw.** Rejected: macOS `ps` gives no session ID, and after a
  group ends, its ID can go to a new group of another program. Each signal goes to one PID.
- **A mark in the environment that each descendant inherits.** Rejected: macOS hides the environment of `/bin/zsh`
  and `/bin/sleep`, the shell and the command of the issue. A program can also remove the mark, and the read gets the
  environment of each candidate process, with the secrets of the user in it.
- **A subreaper or a cgroup.** Not on macOS, and Node.js has no interface for them.

Limit: a process that leaves the run between two reads is not found, for example `cmd &` in a shell that lives 10 ms,
or a program that forks two times. The record sees it only when a read comes before the end of its parent.

### 2. The guards of the signal function

`npm test` sends real signals on the machine of the user, so a defect of the selection must not reach a process of
the user. One pure function, `refusal`, gives the number of the first check that fails, or 0. The function that sends a
signal to one PID calls it with the read directly before the signal, and it sends the signal only for 0. The checks:

1. the PID is 1 or below, the supervisor, the daemon (the parent of the supervisor at its start, and its parent now),
   or a process above them in the table;
2. the read does not have the PID: the process ended, or its line did not parse;
3. the record does not have the PID with the same start time and the same user, or the user is not the user of the
   supervisor;
4. the process started in an earlier second than the agent. A process of the run cannot be older than its agent. The
   start time has a resolution of 1 second, so a process in the same second passes this check, and the other checks
   decide;
5. its process group ID is no PID that the record had: the run did not make that group.

A refusal for the checks 1, 3, 4 and 5 sends no signal and sends the line `refused <pid> <check>` to the daemon on the
lifetime pipe. The daemon writes `log.child.refused` with the PID of the supervisor, the PID and the number of the
check: numbers only, no name and no command line. The check 2 writes no line, because a process that ended is the
usual case. The signal to the process group of the agent is the signal of today; its own guard refuses an agent PID
of 1 or below, the supervisor and the daemon.

The guards do not use the selection: they read only the record, the table and the start time of the agent. Unit tests
cover each check with a fake table before a test with a real signal runs.

### 3. A PID that another process got

The start time is the text of `lstart` of `ps` in the locale `C`, so two reads give the same text for one process. The
command line is not compared: a shell that runs `exec` keeps its PID and its start time, and it is still the same
process. macOS gives the PIDs one after the other up to 99,999, so between a read and the signal, a reuse of a PID needs
some ten thousands of new processes in some milliseconds. `AgentStop` takes the same risk.

### 4. The ends of a run

The default of the supervisor is the end of today: SIGKILL to the process group of the agent at once. Only two events
end the processes of the run:

- the word `clean` from the daemon on the lifetime pipe, before the end of the pipe;
- an exit of the agent while the daemon runs: the lifetime pipe is open, and the parent of the supervisor is the
  daemon of its start.

| End | Path | Processes of the run |
| --- | --- | --- |
| A cancel, a Stop of a row or of the turn, `agents_cancel` | `session/cancel`, the end of the prompt, then `AcpRunService.kill` with `clean` (after at most 5 seconds) | end |
| A deadline, the limit of the error output | `limit`, then `kill` with `clean` | end |
| A stop for a message of the user | a cancel with `clean`, then a continuation | end before the continuation starts (decision 8) |
| An error answer of the agent | `errorOutputEnd`, then `kill` with `clean` | end |
| A crash of the agent | the supervisor sees the exit of the agent, and the daemon runs | end |
| A crash of Claude Code under the adapter | the adapter fails the request, then `kill` with `clean` | end, through the record |
| A completed run | `kill` without a word | stay; the group of the agent gets SIGKILL, as today |
| A stop of the daemon (`stop`, `/shutdown`, SIGTERM) | `AcpRunService.close`, then `kill` without a word | stay, as today |
| A loss of the daemon (SIGKILL) | the lifetime pipe ends without a word | stay, as today |
| SIGTERM or SIGINT to the supervisor | as a loss of the daemon | stay, as today |

Reason for the stop of the daemon: a child can restart the daemon from its own shell with `stop` and then `start` (the
setting `children.daemonRestart` allows it). The shell of that command is a process of the run. If the stop ended it,
`start` would never run, and no daemon would stay. So a stop of the daemon keeps the processes of its runs, as today,
and also the SIGKILL at once: a SIGTERM would let Claude Code end its live shell commands, that one too. The case "a
command of a child survives a restart of the daemon" stays open in issue #30. A later change needs a way to know the
process that restarts the daemon.

Reason for a completed run: the agent ended its turn by itself, so a process that it left is its choice, such as a
server that the task was asked to start. And the record sees only the processes that a read saw: a rule for a completed
run would end one server and keep another one by the time of a read.

### 5. The lifetime pipe

The fourth pipe of the supervisor carries lines in both directions. The supervisor opens it with `allowHalfOpen`, so it
can still write after the daemon ended its side.

- From the daemon: `clean`, then the end of the pipe. The run service no longer closes the pipe and no longer sends
  SIGTERM at once: one stream gives the word and its end in order, so a signal cannot come between them. When the
  supervisor still runs 6 seconds later, the run service sends SIGTERM.
- From the supervisor: `ended <code> <bytes>` when the agent exited and its error output ended, and `refused <pid>
  <check>` for each refusal of decision 2.

### 6. The error output of a failed run

`errorOutputEnd` (from commit `b123d21`) waits for the end of the error output, at most 2 seconds, kills the agent, and
waits a quarter of that time more. Today that end is the exit of the supervisor. With the end of the processes of a run,
the supervisor exits up to 5 seconds after the agent, so the error output would look open and its last word, or a
line that the agent writes as it ends, could go.

So the end of the error output is now the line `ended <code> <bytes>`: the run service takes it when it got that count
of bytes of error output. The supervisor sends the line after the exit of the agent and the end of its error output,
and after its last write of that output, before it ends the other processes of the run. The exit code in the line is
the code that the supervisor gives at its exit today, so the texts of the errors do not change. The exit of the
supervisor stays a second way to the same end. A process of the run that holds the error output of the agent delays
the line until that process ends.

The case that needs it is an error answer while the agent stays alive: the first wait ends without an end, the kill
asks for `clean`, and the quarter of the wait is 37 ms in a test with a wait of 150 ms. So the process group of the
agent gets SIGTERM before the read of the table (decision 7): the agent ends at once, and the line `ended` comes before
the end of the shell. A test with a shell that ignores SIGTERM and an error output without a line break proves it: with
the end at the exit of the supervisor, the last word of the reason goes. After a crash of the agent, the prompt fails
only after the exit of the supervisor, because the ACP connection closes then, so this case had no problem.

### 7. The signals and the time

For an end that ends the processes of the run, the supervisor:

1. stops the reads of the record;
2. sends SIGTERM to the process group of the agent, so the agent and its error output end as fast as before;
3. reads the table again, at most 2 seconds, only on macOS and when the record has a process outside the process group
   of the agent, and sends SIGTERM through the guards to each other process of the run;
4. waits until the agent, its process group and each such process ended, at most 1 second, and looks every 50 ms with
   the signal 0;
5. when one still runs: reads the table again, at most 2 seconds, and sends SIGKILL to the process group of the agent and,
   through the guards, to each process of the run;
6. exits with the exit code of the agent.

So such an end takes at most 5 seconds longer than today. When each process ends at SIGTERM, it takes one read
more: the tests measured 70 ms, and 840 ms under a load average of about 100. Without a process outside the group of
the agent, the tests measured 10 to 40 ms. A run without a process outside the process group of the agent, as each test with
`test/fake-acp.mjs`, makes no read at the end. The SIGTERM comes first, so the agent can end its own tool processes, as
the code of Claude Code does. The wait of 1 second keeps a stop in the chat fast. Claude Code itself waits 5 seconds
before its SIGKILL.

### 8. Reads of the process table

`src/RunProcesses.mjs` runs `/bin/ps -A -o pid=,ppid=,pgid=,uid=,lstart=` with `LC_ALL=C`, with a time limit of
5 seconds for a read of the record and of 2 seconds for a read at the end. Under a load average of about 100, one read
took 1.15 seconds. It gets no command line, so `src/AgentProcesses.mjs` stays the only module that reads one. A line that does
not have this form gives no process. A read with an exit code other than 0, an error or a timeout gives no table, and
its output does not count. A read starts only when the one before it ended. The cost is about 4 ms of CPU time each
second for each running child: about 1% of one core with the default of 3 children, about 3% with the limit of 8.

The module exports pure functions (the parse, the selection, the protected PIDs, the guards) and a class with an
injected platform, read, signal function and timer. The supervisor wires the real ones.

### 9. The place of a run in its directory

The `finally` of `execute` waits for the exit of the supervisor, at most 6 seconds, before the run gives its place back.
So a stop for a message of the user, whose continuation starts at once, and each next task in the directory start only
after the processes of the earlier run ended. A stop of the daemon waits for it too, but its supervisors exit at once.

### 10. Platforms

macOS is the only platform that reads the table. On another platform, each end sends SIGKILL to the process group of
the agent at once, as today.

By reading only: on Linux, `ps` of procps-ng gives the same columns. A process whose parent ended goes to the nearest
subreaper, often `systemd --user`, so its parent PID is not always 1; the rules of decision 1 do not use the PID 1.
Linux has better tools: `PR_SET_CHILD_SUBREAPER` and a cgroup. Windows is out of scope.

### 11. State, protocol and compatibility

- No field of `conversation.sqlite`, `settings.json` or another state file is added or read. The field `pid` of a run
  stays the PID of the supervisor.
- No ACP message and no `_meta` key is added or read. A cancel uses `session/cancel` as now.
- The words of the lifetime pipe are between the daemon and the supervisor of one build: the daemon starts the
  supervisor from its own `src`.
- The daemon keeps the admitted work through a disconnect of the ACP client and through a restart as now.
- A state of v0.2.0 or v0.3.0 opens as now. A daemon of v0.3.0 opens the state of this build: nothing in it changed.

### 12. Tests

Each test uses stand-in processes only. A stand-in writes its PID to a file at its start, and the test reads the start
time of each such PID with `ps -o lstart= -p`. Before each signal of the test, it reads the start time again. A
`t.after` hook ends each recorded PID that still runs with the same start time, as `stopStarted` of
`test/home.test.mjs` does, and it asserts that none remains. No test sends a signal to a process group or to a PID
that it did not record. Each stand-in also ends by itself after at most 61 seconds.

## Risks / Trade-offs

- [A process of the run stays after a stop or a restart of the daemon] → As today. Open in issue #30.
- [A process that leaves the run between two reads stays] → The limit of decision 1. The cases of the issue stay for
  more than 1 second, so the record sees them.
- [A shell that starts less than 1 second before the end, while the record has no process outside the process group
  of the agent, is not read at the end] → The agent gets SIGTERM first, and the code of Claude Code then ends each live
  shell command. Else the shell stays.
- [An agent that ends by itself just after the loss of the daemon] → The supervisor looks at the end of the lifetime
  pipe and at its parent PID. A crash at the same moment as the loss of the daemon can end the processes of the run.
- [A read of the process table each second costs CPU time] → About 4 ms for each read. A read starts only after the
  one before it ended.
- [A read that takes too long under a high load gives no table] → The record keeps the last good read. A failed read
  at the end gives the signals to the process group of the agent only.
- [A start time with a resolution of 1 second] → A reuse of a PID in the same second needs a wrap of 99,999 PIDs.
- [A SIGKILL of the supervisor itself] → Nothing ends the processes of the run, as today.

## Migration Plan

No migration. A daemon of this build starts its supervisors from its own `src`. Supervisors of an older daemon end as
before. A rollback to v0.3.0 gives the old behavior back.

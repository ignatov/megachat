# Proposal

## Why

A shell command of a Claude child keeps running after its run ends on a stop or a crash (issue #30). Claude Code starts
the shell of its Bash tool in a session and a process group of its own, and `src/child-supervisor.mjs` sends a signal
only to the process group of the agent. A probe on 2026-11-12 with stand-in processes and the real supervisor showed
that the shell and its command survive each end of a run: a stop, a cancel that the agent does not handle, a deadline,
a crash of the adapter or of Claude Code, a stop and a kill of the daemon, and also a completed run. A build, a test
loop or a server of a child then uses the CPU, and it can hold the files or the ports that the next task in the same
directory needs.

## What Changes

Where it shows: the processes of the machine, and one new kind of line in the log. After a Stop of a row, a Stop of
the turn, `agents_cancel`, a deadline, the limit of the error output, a stop for a message of the user or a failure of
the agent while the daemon runs, no shell, build or server of the run stays. The chat and the task list of Air do not
change. Such a stop takes at most 5 seconds longer than today. The tests measured 10 to 40 ms longer without a shell
and 70 to 840 ms longer with a shell, by the load of the machine.

- **The processes of a run.** A process is a process of the run when it is the agent, when its parent is a process of
  the run, or when it is in a process group that a process of the run made, with a live process of the run in it. On
  macOS, the supervisor reads the process table (the PID, the parent PID, the process group, the user and the start
  time, and no command line) at the start of the agent and every second while the agent runs. It keeps a record of the
  processes of the run. So it finds a shell that left the process group of the agent, and a process whose parent ended
  first and that now has the parent PID 1. No name and no command line select a process.
- **The ends that end the processes of a run:** a cancel, a Stop of a row or of the turn, `agents_cancel`, a deadline,
  the limit of the error output, a stop for a message of the user, and a failure of the run while the daemon runs (an
  error answer of the agent, or an agent that ends by itself). The daemon asks for it with the word `clean` on the
  lifetime pipe. When the agent ends by itself, the supervisor does it when the daemon still runs.
- **The ends that keep the behavior of today:** a completed run (the prompt ends with `end_turn`), a stop of the daemon
  (`stop`, `/shutdown`, SIGTERM), and the loss of the daemon (the lifetime pipe ends, as after a SIGKILL of the daemon).
  Only the process group of the agent gets SIGKILL at once. Reasons: a completed agent ended its turn by itself, so a
  process that it left is its choice; and a child can restart the daemon from its own shell with `stop` and then
  `start` (the setting `children.daemonRestart` allows it), so that shell must survive the stop of the daemon.
- **The guards of the signal function.** Independent of the selection, the function that sends a signal refuses a PID
  that is PID 1 or below, the supervisor, the daemon or a process above them; that is not in the record with the same
  start time and the same user; that started before the agent; or whose process group ID is not a PID that the record
  had. A refusal sends no signal and gives one line with numbers only to the log of the daemon.
- **The check before a signal.** Directly before each signal, the supervisor reads the process table again, with
  `LC_ALL=C`. A process that ended, a read that fails, and a line that does not parse give no signal beyond the process
  group of the agent.
- **The signals.** For an end that ends the processes of a run: SIGTERM first to the process group of the agent, then,
  after a read of the table, to each other process of the run. After at most 1 second, SIGKILL to each one that still
  runs. So the agent can end its own
  tool processes: the code of Claude Code sends SIGTERM to the process group of each shell when it exits through a
  handler.
- **The error output of a failed run.** The supervisor tells the daemon when the agent ended, with its exit code and
  the count of the bytes of its error output, before it ends the other processes of the run. So the wait of a failed
  run for its error output ends with the agent, and the error of the run keeps its complete reason also when a shell of
  the run takes 1 second to end.
- **The place of a run in its directory.** A run keeps its place in its directory until its supervisor exited, at most
  6 seconds after the end of the run. So a continuation, a stop for a message of the user or the next queued task in
  the same directory does not meet a process of the earlier run.
- **Platforms.** macOS gets the change. On another platform, the supervisor does what it does today and reads no
  process table.
- **Compatibility.** No field of the state, of `settings.json` or of another state file changes. A state of v0.2.0 or
  v0.3.0 opens as now, and a daemon of v0.3.0 opens the state of this build. The daemon and its supervisor are of one
  build, so the words on the lifetime pipe need no version check.

## Capabilities

### New Capabilities

- `child-processes`: the processes of a Claude or Codex child run, the ends that end them, the record, the selection,
  the check and the guards before a signal, the order of the signals, the report of the end of the agent for the error
  output, and the other platforms.

### Modified Capabilities

- `failure-handling`: the requirement "Lifetime of a child agent" names only the process group of the agent. It now
  says that a stop and a loss of the daemon signal only that group, and that an agent that ends by itself while the
  daemon runs ends each process of the run.
- `child-scheduling`: the requirement "One child for one checkout" keeps the place of a run in its directory until its
  supervisor exited.

## Impact

- Code: a new `src/RunProcesses.mjs` (the read of the process table, the record, the selection, the guards, the order
  of the signals), `src/child-supervisor.mjs` (the reads, the ends, the words on the lifetime pipe), and
  `src/AcpRunService.mjs` (the word `clean`, the report of the end of the agent for the error output, the log line of a
  refusal, the wait for the end of the supervisor). `resources/Megachat.properties` gets the log line
  `log.child.refused`.
- Tests: a new `test/child-processes.test.mjs` with a new stand-in `test/fake-process-tree.mjs`: a stand-in daemon, an
  adapter, a stand-in of Claude Code and a small ACP agent that start a shell in a session of its own. Each test selects
  a process only by a PID that a stand-in wrote at its start, checks its start time before a signal, and ends each such
  process that still runs, also after a failed assertion or a timeout.
- `README.md`: the row of `src/child-supervisor.mjs`, and a short text about the processes of a child run.
  `docs/manual-checks.md`: the record of the probe of 2026-11-12.
- No ACP extension changes, so `docs/air-contract.md` and Air do not change.
- Out of scope:
  - A command of a child that survives a stop or a restart of the daemon. It stays open in issue #30. A later change
    needs a way to know the process that restarts the daemon, so that a stop of the daemon can end each other process
    of the run and keep that one.
  - Linux and Windows. Linux has better tools for this (a subreaper, a cgroup), and a later change can use them.
  - A process that leaves the run between two reads: a background command `cmd &` of a shell that ends at once, or a
    program that forks two times to run as a daemon. The probe measured a life of 10 ms for such a shell. The record
    does not see such a process, and no rule proves that the run started it.
  - A mark in the environment of each process of the run. macOS hides the environment of `/bin/zsh` and `/bin/sleep`
    from `ps`, so the mark does not find the shell of the issue.
  - A kill of the supervisor itself, a pi child (it has no agent process), a text for the child or the main agent, and
    a stop of such a process through `agents_stop`.
  - No non-goal changes. The non-goal "It does not resume a tool call through a daemon crash" stays.

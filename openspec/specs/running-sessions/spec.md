# running-sessions Specification

## Purpose
The tool `agents_running` of the main agent lists the agent sessions that run on the machine now. Each row gives the owner and the state of a session, so the user can find an orphan session.

## Requirements

### Requirement: List of the running sessions
The tool `agents_running` of the main agent MUST list the agent sessions that run on the machine now: Claude Code, Codex, pi and OpenCode, also below the ACP adapters `claude-agent-acp` and `codex-acp`. It MUST read the process table, and the session logs only with the consent `sessions.index`. It MUST change nothing.

Tests: `test/running.test.mjs`

#### Scenario: A session of each agent
- **WHEN** Claude Code runs in Terminal, Codex runs below `codex-acp` of an IDE, pi runs in a `tmux` and OpenCode runs in Ghostty
- **THEN** `agents_running` gives a row for each session, with the `agent` `claude`, `codex`, `pi` and `opencode`

#### Scenario: The tool of the main agent
- **WHEN** the main agent calls `agents_running` with the `agent` `pi`, and pi runs in a `tmux` in the directory `/work/pi`
- **THEN** the result has one row, with the `cwd` `/work/pi` and the `parent.kind` `multiplexer`

### Requirement: One row for one session
One session MUST give one row. An agent process below a process of the same agent MUST NOT be a row. An adapter MUST be a row only when no agent of its own runs below it. A helper of an agent, such as an MCP server, a shell or a tool, MUST NOT be a row. The background service of an agent (`claude daemon`, `codex app-server daemon`) and the processes of this daemon outside a child run, such as the account check, MUST NOT be rows.

Tests: `test/running.test.mjs`

#### Scenario: The helpers of a session
- **WHEN** Claude Code with the PID 10 has a shell with `npm test`, an MCP server and the process `claude --print` below it
- **THEN** the list has one row for the PID 10, and no row for its helpers

#### Scenario: An adapter with its agent
- **WHEN** the Claude adapter of Zed runs `claude`, and a shell of that Claude session starts `codex exec`
- **THEN** the list has one row with the `agent` `claude` and one row with the `agent` `codex`, and no row for the adapter

#### Scenario: An adapter without an agent
- **WHEN** `codex-acp` of an IDE runs with no agent below it
- **THEN** the list has a row for `codex-acp`, with the `agent` `codex`

#### Scenario: The background service of an agent
- **WHEN** `claude daemon run` runs with its helpers below it
- **THEN** the list has no row for these processes

### Requirement: Fields of a row
Each row MUST have `agent`, `sessionId`, `title`, `cwd`, `state`, `status`, `startedAt`, `lastActivityAt`, `pid` and `parent` with `kind`, `name` and `pid`.

Tests: `test/running.test.mjs`, `test/session-logs.test.mjs`

#### Scenario: The fields of a row
- **WHEN** `agents_running` gives a row
- **THEN** the row has exactly the keys `agent`, `sessionId`, `title`, `cwd`, `state`, `status`, `startedAt`, `lastActivityAt`, `pid` and `parent`, and `parent` has exactly the keys `kind`, `name` and `pid`

### Requirement: Owner of a row
`kind` MUST come from the nearest owner in the parent chain: `megachat`, `ide` for an IDE, an editor or the desktop app of an agent, `terminal` for a terminal app or SSH, `multiplexer` for the server of `tmux`, `screen`, `zellij`, `herdr`, `dtach` or `abduco`, and `unknown` for the service of an agent, another app, or no owner. `name` MUST be the name of the app or of the program, never a command line.

Tests: `test/running.test.mjs`

#### Scenario: A terminal and an IDE
- **WHEN** Claude Code runs in the app Terminal, which has the PID 2, and another Claude session runs below the adapter of the IDE `IntelliJ IDEA 2026.3 EAP`, which has the PID 5
- **THEN** the first row has the `parent` `terminal`, `Terminal`, 2, and the second row has the `parent` `ide`, `IntelliJ IDEA 2026.3 EAP`, 5

### Requirement: IDE that runs from sources
A bare `java` process with the main class `com.intellij.idea.Main` or `org.jetbrains.intellij.build.devServer.DevMainKt` on its command line MUST count as an IDE that runs from sources, with the `kind` `ide` and the `name` `java`. A JetBrains property such as `-Didea.platform.prefix` without such a main class is no sure sign of an IDE.

Tests: `test/running.test.mjs`

#### Scenario: The main class of the IDE
- **WHEN** Claude Code runs below a `java` process with the PID 100 and the main class `com.intellij.idea.Main`
- **THEN** the row has the `parent` `ide`, `java`, 100, and the state `idle`

#### Scenario: A JetBrains property without a main class
- **WHEN** Claude Code runs below a `java` process with the PID 120 that has `-Didea.platform.prefix=idea` and no known main class
- **THEN** the row has the `parent` `unknown`, `java`, 120, and the state `unknown`

### Requirement: Children of Megachat
For a process below this daemon, the state of Megachat MUST be the authority. The run of the supervisor PID MUST give the session ID, the title and the task directory.

Tests: `test/running.test.mjs`

#### Scenario: A child of a live run
- **WHEN** a Claude child runs below the supervisor of a run with the session ID `claude-session-1`, the title "Fix the build" and the directory `/work/megachat-task`
- **THEN** the row has these values in `sessionId`, `title` and `cwd`, and the `parent` `megachat`, `Megachat`

### Requirement: State orphan
An orphan MUST mean: the owner process is gone, and the session process is still alive with the same start time. The state MUST be `orphan` only when the owner is gone for certain: the parent chain reaches launchd without an owner, and each process in it is a shell, `login`, `env`, `nohup`, a helper of Megachat or a process of the same agent; or the run of a Megachat child ended. A shell that stays after its terminal is no owner.

Tests: `test/running.test.mjs`

#### Scenario: The parent PID 1
- **WHEN** Claude Code runs with the parent PID 1, or Codex runs below a `/bin/zsh` with the parent PID 1
- **THEN** the state of each row is `orphan`

#### Scenario: A child of an ended run
- **WHEN** a Claude child runs below the supervisor of a run with the status `interrupted`
- **THEN** the state of the row is `orphan`

#### Scenario: A child of a live run
- **WHEN** a Claude child runs below the supervisor of a run with the status `dispatched`
- **THEN** the state of the row is not `orphan`

### Requirement: State unknown
The state MUST be `unknown` when the parent chain has no owner and has another live process that can own the session, such as a bare `java` process without a sure sign of an IDE or a script that started the agent, or when the chain ends before launchd. `incomplete` MUST give the count of such sessions. A session in the state `unknown` is not an orphan.

Tests: `test/running.test.mjs`

#### Scenario: A script that started the agent
- **WHEN** Codex runs below the script `/usr/bin/python3 /work/scripts/run-agents.py` with the PID 140
- **THEN** the row has the state `unknown` and the `parent` `unknown`, `python3`, 140

#### Scenario: A chain that ends before launchd
- **WHEN** Claude Code has the parent PID 777, and the process table has no process 777
- **THEN** the row has the state `unknown`

#### Scenario: The count of the sessions
- **WHEN** four sessions have the state `unknown`
- **THEN** `incomplete` gives the count 4

### Requirement: States active and idle
Else the state MUST be `active` at a CPU load of 10 percent of one core or more, of the session process with its helpers, now or in a scan of the last 2 minutes, or at a write to its session log in the last 2 minutes. Else the state MUST be `idle`.

Tests: `test/running.test.mjs`, `test/session-logs.test.mjs`

#### Scenario: The load of a helper
- **WHEN** a session process has a CPU load of 0.1 percent and its shell has a CPU load of 30 percent
- **THEN** the state is `active`

#### Scenario: The load in an earlier scan
- **WHEN** a scan saw a CPU load of 40 percent, and the load is 0 now
- **THEN** the state is `active` 90 seconds after that scan, and `idle` 150 seconds after it

#### Scenario: A log write
- **WHEN** a pi session has no CPU load, and its session log got a write 30 seconds ago
- **THEN** the state is `active`

### Requirement: Owner of a multiplexer
The server of a multiplexer MUST own its sessions, also without a client. Thus a session in a detached `tmux` or `screen` is not an orphan, and its `parent.kind` is `multiplexer`.

Tests: `test/running.test.mjs`

#### Scenario: A detached multiplexer
- **WHEN** Claude Code runs in a detached `tmux`, Codex runs in a detached `screen`, and pi runs below a `zellij` server, each with the parent PID 1
- **THEN** each row has the state `idle` and the `parent.kind` `multiplexer`, with the `name` `tmux`, `screen` and `zellij`

### Requirement: Rows without the consent
Without the consent `sessions.index`, `status` and `lastActivityAt` MUST be null, also for a child of Megachat. A session outside Megachat MUST have an empty `sessionId` and `title`, and `incomplete` MUST say that the session logs are off. Megachat MUST then read no session file and no process file of an agent.

Tests: `test/running.test.mjs`, `test/session-logs.test.mjs`

#### Scenario: The consent is off
- **WHEN** the consent `sessions.index` is off, and a Claude Code session has a session log and a process file
- **THEN** the row has an empty `sessionId` and `title`, `status` and `lastActivityAt` are null, `incomplete` says that the session logs are off, and Megachat reads no file

#### Scenario: The consent goes off during a scan
- **WHEN** the consent `sessions.index` goes off while a scan of `agents_running` waits for the working directories
- **THEN** a later call gives an empty `sessionId` and `title`, a null `status`, and says in `incomplete` that the session logs are off

### Requirement: Order of the rows
The order MUST be: orphan, unknown, active, idle, and the newest activity first in each group: the time of the last log write, or the start time for a row without a log.

Tests: `test/running.test.mjs`, `test/session-logs.test.mjs`

#### Scenario: The groups
- **WHEN** the machine has three sessions in the state `orphan`, four in the state `unknown` and two in the state `idle`
- **THEN** the list gives the three orphans first, then the four sessions in the state `unknown`, then the two idle sessions

#### Scenario: A row without a log
- **WHEN** two idle pi sessions have a log with a write 3 minutes and 50 minutes ago, and a third idle pi session has no log and started about 2 hours ago
- **THEN** the order is the session with the write 3 minutes ago, the session with the write 50 minutes ago, and then the session without a log

### Requirement: Pages and selection
`limit` MUST be 1 to 200, and the default MUST be 50. `nextCursor` MUST continue after the last row of the page, and `truncated` MUST be true when more rows exist. `agent`, `project` and `state` MUST select the rows. `project` MUST select each working directory that is that directory or in it.

Tests: `test/running.test.mjs`

#### Scenario: 500 sessions
- **WHEN** 500 sessions run, and the main agent calls `agents_running` without `limit`, and then with the `limit` 200 and each `nextCursor`
- **THEN** the first page has 50 rows and `truncated` is true, and the pages give each of the 500 sessions one time

#### Scenario: A limit that is too high
- **WHEN** the main agent calls `agents_running` with the `limit` 201
- **THEN** the call fails

#### Scenario: A project
- **WHEN** sessions run in `/work/ide`, `/work/ide/module` and `/work/ide-other`, and the `project` is `/work/ide`
- **THEN** the list gives the sessions in `/work/ide` and `/work/ide/module`, and not the session in `/work/ide-other`

### Requirement: View of a cursor
The cursor MUST name the scan time of its view. Megachat MUST keep the view of the last page with a next cursor for 1 minute, one view only, and the next pages of that cursor MUST come from it, so a change of the activity or of the state moves no row across the cursor. When that view is gone, the page MUST come from a new view after the last row of the cursor, and `incomplete` MUST say that a session can be missing or come two times.

Tests: `test/running.test.mjs`

#### Scenario: A change of the activity between two pages
- **WHEN** the first page with the `limit` 1 gives the session 12 of three idle sessions, and then the session 10 at the end of the list becomes active
- **THEN** the next pages of that cursor give the session 11 and then the session 10, with the `scannedAt` of the first page

#### Scenario: A view that is gone
- **WHEN** the main agent uses the cursor of the first page more than 1 minute after the view of that page
- **THEN** the page comes from a new view with a new `scannedAt`, and `incomplete` says that a session can be missing or come two times

### Requirement: View of the processes
Megachat MUST keep the view of the processes for 5 seconds, so two calls in that time make one `ps` call. `scannedAt` MUST give the time of the view. Megachat MUST get the working directory once for each process, and again for a PID with another start time.

Tests: `test/running.test.mjs`

#### Scenario: Calls in 5 seconds
- **WHEN** the main agent calls `agents_running` two times at the same time and one more time after 4999 milliseconds
- **THEN** Megachat makes one `ps` call, and the three results have the same `scannedAt`

#### Scenario: A call after 5 seconds
- **WHEN** the main agent calls `agents_running` 5 seconds after the first call
- **THEN** Megachat makes a new `ps` call

#### Scenario: A reused PID
- **WHEN** the PID 11 gets another start time in a later view, and the PID 10 stays the same
- **THEN** Megachat gets the working directory of the PID 11 again, and not of the PID 10

### Requirement: Text outside ASCII
Megachat MUST read a name and a command line outside ASCII as UTF-8, also an app name such as `Café.app`, and the start time in one fixed format.

Tests: `test/running.test.mjs`

#### Scenario: An app name outside ASCII
- **WHEN** the `ps` output has a process with the name `Café` and the command line `/Applications/Café.app/Contents/MacOS/Café --flag`
- **THEN** Megachat reads the name `Café` and that command line

#### Scenario: A real process of macOS
- **WHEN** a process runs on macOS with the argument `Café-日本-<pid>`
- **THEN** its command line from the process table ends with that argument, and its start time is less than 5 seconds from the real start

### Requirement: Incomplete lists
A working directory that Megachat cannot read MUST give a row with the `cwd` null and an entry in `incomplete`, not an error. A failed `ps` call MUST give an empty list and an entry in `incomplete`. On a platform other than macOS, the list MUST be empty, and `incomplete` MUST name the platform. `incomplete` MUST name the logs of OpenCode when the list has an OpenCode session.

Tests: `test/running.test.mjs`

#### Scenario: An unreadable working directory
- **WHEN** Megachat can read the working directory of the PID 10 and not of the PID 11
- **THEN** the row of the PID 11 has the `cwd` null, and `incomplete` gives the count 1 for the working directories

#### Scenario: A failed ps call
- **WHEN** the `ps` call fails
- **THEN** the list is empty, and `incomplete` says that the command `ps` failed

#### Scenario: Linux
- **WHEN** Megachat runs on `linux`
- **THEN** the list is empty, and `incomplete` names `linux`

#### Scenario: An OpenCode session
- **WHEN** the list has an OpenCode session
- **THEN** `incomplete` names the logs of OpenCode

### Requirement: Private data and the children
The output MUST hold no command-line argument, no message text and no environment. The MCP server of the children MUST NOT have the tool.

Tests: `test/running.test.mjs`, `test/session-logs.test.mjs`

#### Scenario: A command line with a token
- **WHEN** each command line of the process table has the arguments `--token sk-marker-0123456789`
- **THEN** the output of `agents_running` has neither `--token` nor `sk-marker-0123456789`

#### Scenario: The tools of a child
- **WHEN** a child of Megachat gets the tools of its MCP server
- **THEN** the tools have no `agents_running`

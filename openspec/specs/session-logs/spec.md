# session-logs Specification

## Purpose
Megachat keeps a live table of the session files of Claude Code, Codex and pi on the machine, so `agents_running` can show the session ID, the title and the status of each running session. The main agent can read a session log from its end with `agents_session_history`.

## Requirements

### Requirement: Live table of the session files
With the consent `sessions.index`, Megachat MUST keep a live table of each session file of Claude Code, Codex and pi on the machine, also outside the listed directories, without the archived and the compressed Codex session files, in a table of its own in `sessions.sqlite`: the path, the inode, the size, the byte offset, the agent, the session ID, the `cwd`, the title, the start time, the time of the last write and the last step. It MUST hold no message text.

Tests: `test/session-logs.test.mjs`

#### Scenario: The archived and the compressed Codex files stay out
- **WHEN** Codex has the plain session file of `live`, the compressed file of `cold` and the archived file of `archived`
- **THEN** the live table has a row for the file of `live` only

#### Scenario: No message text
- **WHEN** each message text of a log holds the text `textmarker`
- **THEN** the answer of `agents_running` does not hold `textmarker`

### Requirement: Restart and query of the live table
A restart MUST answer from this table before it reads a file again. A query of `agents_running` MUST read the memory, not the session files.

Tests: `test/session-logs.test.mjs`

#### Scenario: A restart answers from the table
- **WHEN** the live table read the pi session `kept` with the title "Kept title", and a new table starts on the same `sessions.sqlite`
- **THEN** `agents_running` gives the session ID `kept`, the title `Kept title` and the status `waiting_for_user` before Megachat opens a session file

### Requirement: First pass of the live table
The first pass MUST read the head and the last 64 KB of each file: the files with a change in the last 24 hours first, the newest first, then the other files. A tail without a step can read more lines backwards, at most 1 MB.

Tests: `test/session-logs.test.mjs`

#### Scenario: The order of the first pass
- **WHEN** five session files have their last change 10 minutes, 1 hour, 23 hours, 30 hours and 5 days ago
- **THEN** the first pass opens them in this order, and it opens the files of 30 hours and of 5 days only after the files of the last 24 hours

#### Scenario: A large last line
- **WHEN** a log of more than 2 MB ends with a tool result of 200 KB in one line
- **THEN** the status of the log is `working`, and the read takes less than 512 KB

### Requirement: Title of a row in the live table
Each title of the table MUST go through the filter of the titles of the index, with the exact values that the daemon knows, and the table MUST keep at most 200 characters of it. See the capability `secrets` for the exact values that the daemon knows.

Tests: `test/session-index.test.mjs`

#### Scenario: A title with a value that the daemon knows
- **WHEN** the daemon knows the value of a gateway key, and a Claude Code session file has the title "Check" followed by that key
- **THEN** the live table keeps the title "Check [secret removed]" in the memory and in `sessions.sqlite`

### Requirement: Watch and size poll of the session files
The table MUST read a file on an event of the watch of the provider roots, the same watch as the index. Each file with a write in the last hour MUST also get a poll of its size every 2 seconds, because macOS reports a write only when a file closes, and Codex keeps its file open.

Tests: `test/session-logs.test.mjs`, `test/session-index.test.mjs`

#### Scenario: The size poll finds a write to an open Codex file
- **WHEN** a Codex process writes a tool result and a reply to its open log, the last write before was 10 minutes ago, and no watch event comes
- **THEN** the next poll of the size reads the new lines, and a file with its last write 2 hours ago gets no stat

#### Scenario: A new provider root
- **WHEN** the directory `~/.claude` appears after the start, and a Claude Code session file is in it
- **THEN** the watch of the new root starts, and the live table reads the session file

### Requirement: Stat of a Codex log at each scan
The log of each Codex row MUST also get a stat at each scan of `agents_running`, whatever the age of its last write, and a read when it changed, because a session can be quiet for more than an hour.

Tests: `test/session-logs.test.mjs`

#### Scenario: A quiet Codex log
- **WHEN** the last write to a Codex log was 2 hours ago, and the process `codex` that keeps the log open writes a tool call
- **THEN** the next scan of `agents_running` reads the new lines and gives the status `working`, and a scan after it gives only one stat of the log and no read

### Requirement: Read of the appended lines
A read MUST take only the appended complete lines. A smaller file or another inode MUST make the table read the file again.

Tests: `test/session-logs.test.mjs`

#### Scenario: A line without a newline
- **WHEN** a writer appends three complete lines and a fourth line without a newline
- **THEN** the read takes only the appended bytes, and the table keeps the fourth line for the next read

#### Scenario: A truncated file
- **WHEN** a session file becomes shorter than the part that the table read
- **THEN** the table reads the file again from its start

#### Scenario: Another inode of the same size
- **WHEN** a new file of the same size replaces a session file
- **THEN** the table reads the new file

### Requirement: Certain link of a row to its session log
Each row MUST get its session log only by a certain link: the session ID of a Megachat run; an open log of the process (Codex keeps its log open, one row for each open log of a `codex app-server`; an open `.jsonl` file of another agent MUST give no link); the process file `~/.claude/sessions/<PID>.json` of Claude Code with the PID and the same start time, a regular file of at most 16 KB and not a symbolic link; else a log by the start of the process.

Tests: `test/session-logs.test.mjs`

#### Scenario: A codex app-server with two open logs
- **WHEN** the process `codex app-server` with the PID 30 keeps open the logs of `thread-one` and `thread-two` and the file `/elsewhere/notes.jsonl`
- **THEN** `agents_running` gives two rows of the PID 30, with the titles `First thread` and `Second thread`

#### Scenario: A process file of a reused PID
- **WHEN** the process file `~/.claude/sessions/11.json` names the session `claude-two`, and its start time is 1 hour before the start of the process 11
- **THEN** the row of the process 11 has an empty session ID and an empty title

### Requirement: Link by the start of the process
When a row has no other certain link, its certain link MUST be the only log of the agent in the `cwd` that began in the first 30 seconds of the process, when no other row of the agent in that directory could have begun it, and when no other log of the agent there, that no other row could have begun, has a later write. Thus a process that moves to another log with `/new` or `/resume` MUST NOT keep the title of its first log.

Tests: `test/session-logs.test.mjs`

#### Scenario: A pi process that moves to another log
- **WHEN** the pi process 80 began the log `new-one` with the title "First", and after `/new` it writes to the log `new-two` that began 20 minutes later
- **THEN** the row of the process 80 has an empty session ID and an empty title

#### Scenario: A log that began long after the process
- **WHEN** the only pi log in `/work/late` began 10 minutes after the start of the pi process in that directory
- **THEN** the row of the process has an empty session ID and an empty title

### Requirement: Processes that start at nearly the same time
Two processes of one agent in one directory that start at nearly the same time MUST NOT get a log, so no row shows the title of another session.

Tests: `test/session-logs.test.mjs`

#### Scenario: Two pi processes 5 seconds apart
- **WHEN** two pi processes in `/work/shared` start 5 seconds apart, and each one begins a log 1 second after its start
- **THEN** the rows of the two processes have an empty session ID and an empty title

#### Scenario: Two pi processes 10 minutes apart
- **WHEN** two pi processes in `/work/apart` start 10 minutes apart, and each one begins a log 1 second after its start
- **THEN** the rows have the titles `Title C` and `Title D` of their own logs

### Requirement: Row without a certain log
A row without a certain log MUST have an empty `title`, a null `status` and `lastActivityAt`, and one entry in `incomplete` MUST give the count of such rows.

Tests: `test/session-logs.test.mjs`

#### Scenario: Three rows without a certain log
- **WHEN** three rows of `agents_running` have no certain log
- **THEN** each of these rows has an empty `title`, and `incomplete` holds the one entry "The session logs of 3 of the sessions: Megachat found no log that belongs to them for certain. Their title, status and lastActivityAt are empty."

#### Scenario: A new Claude Code session without a log
- **WHEN** the process file of the process 12 names the session `claude-three`, and the session has no log yet
- **THEN** the row has the session ID `claude-three`, an empty `title`, and a null `status` and `lastActivityAt`

### Requirement: Status of a row
The log MUST give `sessionId`, `title` (a title of the user or of the agent, never a message text), `lastActivityAt` (the time of the last write) and `status`.

A session in a detached `tmux` keeps its multiplexer owner and gets its status from its log as each other session.

The status is a reading of the log tail, not a fact from the agent, except a status from the state of Megachat or from the process file of Claude Code:

Tests: `test/session-logs.test.mjs`

#### Scenario: The fields of a linked row
- **WHEN** the process file of the process 10 links its row to the Claude Code session `claude-one` with the title "Fix the build"
- **THEN** the row has the `sessionId` `claude-one`, the `title` `Fix the build`, and the time of the last write of the log as `lastActivityAt`

### Requirement: Status of an open step
Megachat MUST read these statuses from the log tail:
- `working`: the tail ends with a tool call, a tool result or a message without a reply, and the last write is less than 10 minutes old. Without a write and a CPU load for 2 to 10 minutes, the status stays `working`.
- `stuck`: such an open step and no write for 10 minutes or more.

Tests: `test/session-logs.test.mjs`

#### Scenario: A tool call without a write for 5 minutes
- **WHEN** the log of a Claude Code session ends with a tool call, and its last write is 5 minutes old
- **THEN** the status is `working`

#### Scenario: A tool call without a write for 10 minutes
- **WHEN** the log of a Claude Code session ends with a tool call, and its last write is 10 minutes old
- **THEN** the status is `stuck`

### Requirement: Status of a finished turn
Megachat MUST also read these statuses from the log tail:
- `waiting_for_user`: the tail ends with a finished turn, an interrupted turn, or a log without a turn. A local command of Claude Code (such as `/model`), a shell line of its bash mode (`!`), a note of its memory mode (`#`) and the output of each one start no turn.
- `idle`: a finished turn and no write for 30 minutes or more.

Tests: `test/session-logs.test.mjs`

#### Scenario: A shell line of the bash mode
- **WHEN** the log of a Claude Code session ends with a finished turn, then a shell line of the bash mode and its output
- **THEN** the status is `waiting_for_user`

#### Scenario: A finished turn 40 minutes ago
- **WHEN** the log of a Codex session ends with a finished turn, and its last write is 40 minutes old
- **THEN** the status is `idle`

### Requirement: Permission status of a child of Megachat
- `waiting_for_permission` for a child of Megachat: the run of the row has a pending permission request of its current generation in the state of Megachat. This MUST hold for a Claude, a Codex and a pi child, whatever the log or a process file says, also without a read log. A child whose run has no pending request MUST get its status from its log. A pending request of a run MUST NOT change the status of a session that is no child of Megachat.

Tests: `test/session-logs.test.mjs`

#### Scenario: A Codex child with a pending permission request
- **WHEN** the run of a Codex child has a pending permission request of its current generation, and the log of the child ends with a tool call 20 minutes ago
- **THEN** the status of the child is `waiting_for_permission`, not `stuck`

#### Scenario: A terminal session in the directory of a waiting child
- **WHEN** the run of a Claude child in `/work/claude` has a pending permission request, and the log of a Claude Code session in a terminal in `/work/claude` ends with a tool call 1 minute ago
- **THEN** the status of the child is `waiting_for_permission`, and the terminal session keeps the status `working` of its log

#### Scenario: A request of an older generation
- **WHEN** the run of a Claude child has the generation 2, and its pending permission request has the generation 1
- **THEN** the child gets the status of its log

### Requirement: Permission status from the process file of Claude Code
- `waiting_for_permission` for another Claude Code session: the process file `~/.claude/sessions/<PID>.json` says that the session waits for a permission: the field `status` is `waiting`, and the field `waitingFor` is `permission prompt`, `sandbox request`, `worker request` or `goal proposal`. Claude Code puts these four values in the group `permission` of its own status line.
- `dialog open` MUST give the status of the log.

Tests: `test/session-logs.test.mjs`

#### Scenario: A wait for a permission in the process file
- **WHEN** the process file `~/.claude/sessions/10.json` has the PID 10 and the start time of the process, the field `status` is `waiting`, the field `waitingFor` is `permission prompt`, the field `statusUpdatedAt` is 20 minutes ago, and the last write to the log is a tool call 20 minutes ago
- **THEN** the status is `waiting_for_permission`, not `stuck`

#### Scenario: An open dialog
- **WHEN** the field `waitingFor` of the process file is `dialog open` for 20 minutes, and the log ends with a tool call 20 minutes ago
- **THEN** the status is `stuck`, the status of the log

### Requirement: User status from the process file of Claude Code
- `waiting_for_user` from the process file: the field `status` is `waiting`, and the field `waitingFor` is `input needed`, a question to the user. Claude Code puts this value in the group `question`.
- A status from the process file MUST replace `working`, `stuck`, `waiting_for_user` and `idle`, so a session that waits for the user does not become `stuck` because its log is silent.

Tests: `test/session-logs.test.mjs`

#### Scenario: A question for 20 minutes
- **WHEN** the field `waitingFor` of the process file is `input needed` for 20 minutes, and the log ends with a tool call 20 minutes ago
- **THEN** the status is `waiting_for_user`, not `stuck`

### Requirement: Sources of a permission status
- The process file is a hint of another program. Each of its statuses MUST count only when the file gives the link of the row, so a file with another PID, another start time, a symbolic link, a file above 16 KB and a file that is not valid JSON give no status.
- Codex and pi write no record of a permission request, and no other file of them tells it. A pending permission prompt of a Codex session shows as `working`, then as `stuck`. pi has no permissions.

Tests: `test/session-logs.test.mjs`

#### Scenario: A process file with another start time
- **WHEN** the process file of the process 31 says `waiting` and `permission prompt`, but its start time is 1 hour before the start of the process 31, and the log has an open step without a write for 20 minutes
- **THEN** the status is `stuck`, the status of the log

#### Scenario: A process file that is not valid JSON
- **WHEN** the process file of the process 40 is not valid JSON, and the log has an open step without a write for 20 minutes
- **THEN** the status is `stuck`, and Megachat gives no error

### Requirement: Age of a status from the process file
- The field `statusUpdatedAt` of the process file MUST be a number and MUST NOT be more than 1 minute in the future. The log MUST have no write more than 10 seconds after `statusUpdatedAt`. A CPU load of the process at the scan MUST cancel a wait that started 2 minutes ago or more, because a process that waits uses no CPU. Else the row MUST get the status of its log, and a file that Megachat cannot read MUST give no error.

Tests: `test/session-logs.test.mjs`

#### Scenario: A CPU load during a wait
- **WHEN** the process file says `permission prompt` since 5 minutes ago, the log ends with a tool call 5 minutes ago, and the process has a CPU load at the scan
- **THEN** the status is `working`, the status of the log

#### Scenario: A later write to the log
- **WHEN** the process file says `permission prompt` since 3 minutes ago, and the log got a tool call 1 minute ago
- **THEN** the status is `working`, the status of the log

#### Scenario: A time in the future
- **WHEN** the field `statusUpdatedAt` of the process file is 1 hour in the future, and the log ends with a tool call 1 minute ago
- **THEN** the status is `working`, the status of the log

### Requirement: Incomplete answer of the live table
`incomplete` MUST name the first pass of the table while it reads the files of the last 24 hours, the count of the rows without a certain log, and the count of the logs that Megachat could not read.

Tests: `test/session-logs.test.mjs`

#### Scenario: Rows without a certain log
- **WHEN** two pi processes move to another log with `/new` and `/resume`
- **THEN** `incomplete` holds the entry "The session logs of 2 of the sessions: Megachat found no log that belongs to them for certain. Their title, status and lastActivityAt are empty."

#### Scenario: The first pass
- **WHEN** the first pass of the table reads the files of the last 24 hours
- **THEN** `incomplete` names the first pass

### Requirement: Read-only access to the provider files
Megachat MUST write to no provider file and open each one read-only.

Tests: `test/session-logs.test.mjs`

#### Scenario: The files keep their size and modification time
- **WHEN** the live table reads a Claude Code, a Codex and a pi log and the process file `~/.claude/sessions/10.json`, a poll and a watch event run, and `agents_session_history` reads the Codex log from its end
- **THEN** each file keeps its size and its modification time, and Megachat opens each file read-only

### Requirement: Consent that goes off during a call
When the consent goes off, a call of `agents_running` or of `agents_session_history` that runs MUST read no more session file, and a call after the change MUST get no data of a log, also from a scan that started before it.

Tests: `test/session-logs.test.mjs`

#### Scenario: A read from the end during the change
- **WHEN** the consent goes off while `agents_session_history` with `order` `newest` opens the log
- **THEN** the call fails with "The index of past sessions is off, so Megachat reads no session log. Only the user can turn it on, with the setting sessions.index."

#### Scenario: A scan of agents_running during the change
- **WHEN** the consent goes off while a scan of `agents_running` waits for the open files of the processes, and a second call starts after the change
- **THEN** the row of the second call has an empty session ID, an empty title and a null status, and `incomplete` names the session logs that are off

### Requirement: Read from the end of a session log
`agents_session_history` of the main agent with `order` `newest` MUST read a session of the live table by its agent and session ID, also outside the listed directories, from the end of its log: the last `limit` entries (20 by default, at most 100) in the order of the log, and a cursor to the older page. `query` MUST select the entries in the session.

Tests: `test/session-logs.test.mjs`

#### Scenario: The last 20 entries
- **WHEN** the log of the Claude Code session `large` in a directory that is not listed ends with the entries `m0` to `m29`, and the main agent reads it with `order` `newest`
- **THEN** the page gives the entries `m10` to `m29` in the order of the log and a cursor, and the cursor with `limit` 10 gives the entries `m0` to `m9`

#### Scenario: A query
- **WHEN** the main agent reads the session `large` with `order` `newest`, the `query` `oak` and the `limit` 3
- **THEN** the page gives the last three entries that hold `oak`: `m21`, `m24` and `m27`

### Requirement: Pages and cursors of a read from the end
A page MUST read at most about 8 MB, so a log of 600 MB opens without a read of the whole file. Each entry MUST come in exactly one page, also an entry whose line crosses the limit of 8 MB of a page. A cursor past the end of a log that became shorter MUST fail with the error of an invalid cursor, and a page that reads no line MUST give no cursor, so a caller that follows the cursor does not loop.

Tests: `test/session-logs.test.mjs`

#### Scenario: A log of 600 MB
- **WHEN** a log of 600 MB ends with 30 short lines
- **THEN** the first page reads only the bytes of its last lines, and a page in the 600 MB line without a newline gives no entry and a cursor further back

#### Scenario: Each entry in exactly one page
- **WHEN** a log of about 30 MB holds 300 messages of about 100 KB each, and the caller follows each cursor with `limit` 100
- **THEN** the pages give each of the 300 entries exactly one time

#### Scenario: A log that became shorter
- **WHEN** a log is cut in place to its first three lines after a page gave a cursor
- **THEN** the read with that cursor fails with the error of an invalid cursor

### Requirement: Entry text and consent of a read from the end
Each text MUST pass the secret filter of the import, with the exact values that the daemon knows, and be cut to about 2 KB. Without the consent, the tool MUST fail with a text that says that the session logs are off. See the capability `secrets` for the exact values that the daemon knows.

Tests: `test/session-logs.test.mjs`, `test/session-index.test.mjs`

#### Scenario: A secret in a long entry
- **WHEN** the entry `m28` holds the API key `sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345` and 5000 more characters
- **THEN** the entry holds `[secret removed]` and not the key, it has at most 2000 characters, and it is marked as truncated

#### Scenario: An address with a value that the daemon knows
- **WHEN** the daemon knows the value of a gateway key and an address that holds it, and the last entry of a log is "juniper the base is" followed by that address and "now"
- **THEN** the read from the end gives the text "juniper the base is [secret removed] now"

#### Scenario: No consent
- **WHEN** `sessions.index` is off, and the main agent calls `agents_session_history` with `order` `newest`
- **THEN** the call fails with "The index of past sessions is off, so Megachat reads no session log. Only the user can turn it on, with the setting sessions.index."

### Requirement: Session history tool of the children
The tool `session_history` of the children MUST keep its limit to the listed directories and MUST NOT have `order`. Its description MUST NOT offer `order` or a read outside the listed directories.

Tests: `test/session-history.test.mjs`, `test/session-logs.test.mjs`

#### Scenario: The inputs of the tool of the children
- **WHEN** a child lists the tools of the history server
- **THEN** `session_history` has only the inputs `agent`, `cursor`, `cwd`, `query` and `sessionId`, and its description has no `order`, no `newest` and no `outside`

#### Scenario: A read outside the listed directories
- **WHEN** the read of the children asks for a session in a directory that is not listed, with `order` `newest`
- **THEN** the read fails

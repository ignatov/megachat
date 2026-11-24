# Design

## Context

See `proposal.md` for the reason. The change `junie-child` gives the Junie child. This change gives the sessions.

A session source (`src/SessionSources.mjs`) names the session files of one agent and parses one JSON line of such a
file into the session data (`meta`), an entry of the index (`entry`) and the step of the session (`step`). Three parts
read the sources: the index of past sessions (`src/SessionIndexService.mjs`), the live table of the session files
(`src/SessionCatalog.mjs`) and the archive (`src/SessionArchive.mjs`). The other parts name the agents by hand:
`PROGRAMS` and `AGENT_NAMES` of `src/AgentProcesses.mjs`, `INDEX_ONLY` of `src/SessionHistoryService.mjs`, the agent
lists of `src/MegachatHistoryServer.mjs`, `agentName` of `src/SessionNotes.mjs`, `sessionAgentName` of
`src/AcpBridge.mjs`, the count of the agents in `src/SessionIndexService.mjs`, and `hide`, `restore`, `record` and
`resumeCommand` of `src/SessionArchive.mjs`.

### The read of the session folder of Junie on 2026-11-23

Junie CLI 26.10.5 on macOS. The read printed the names of the files and of the fields and the counts, and no text of
a session.

- `~/.junie/sessions` held 204 entries: 198 folders `session-<yymmdd>-<hhmmss>-<4 characters>`, two folders
  `aia-chat-<UUID>`, one folder with a UUID as its name, and the files `index.jsonl`,
  `agent-workbench-archive-state.jsonl` and `air-archive-import-v1.done`.
- The files of the session folders, with the count of the folders that have each: `transcript.md` 183,
  `settings.json` 91, `events.jsonl` 83, `state.json` 72, `summary.json` 49, `tasks.json` 40,
  `session_metadata.json` 12. Some folders have `checkpoints`, `subagents`, `turn-starts` and `task-*` folders.
- `index.jsonl` had 82 lines, each `{ sessionId, createdAt, updatedAt, projectDir, taskName }`.
- `summary.json` has `sessionId`, `createdAt`, `updatedAt`, `projectDir`, `taskName`, `lastPromptAt` and the model
  usage of the main agent.
- `events.jsonl` has one JSON object in each line, with `kind` and `timestampMs`.
  - Lines of the user: `UserPromptEvent` (`requestId`, `prompt`, `presentablePrompt`), `UserResponseEvent` (`prompt`)
    and `UserAsyncResponseEvent` (`entries` of `{ question, answer }`).
  - Lines of the turn: `TaskStartedEvent`, `TaskState` (only the state `COMPLETED` was seen) and `CancelAgentEvent`.
  - `SessionA2uxEvent` has `event.state` (`IN_PROGRESS`, `INPUT_REQUIRED`, `COMPLETED`) and `event.agentEvent` with a
    `kind`. The blocks have a `stepId`: `TerminalBlockUpdatedEvent` (`command`, `output`, `status`,
    `approvalRequest`), `ToolBlockUpdatedEvent` (`text`, `details`, `output`, `status`), `ViewFilesBlockUpdatedEvent`,
    `FileChangesBlockUpdatedEvent`, `McpBlockUpdatedEvent` (`toolName`, `input`), `ResultBlockUpdatedEvent` (`result`,
    `title`), `MarkdownBlockUpdatedEvent` (`text`), `AgentThoughtBlockUpdatedEvent` and `AskAsyncRequestUpdatedEvent`
    (`request` with `question`, `options`, `allowMultiple` and `isRequired`). Without a `stepId`:
    `AgentTaskNameUpdatedEvent` (`name`), `CurrentDirectoryUpdatedEvent` (`currentDirectory`), the status lines, the
    token counts and the suggestions.
- In the 40 newest sessions with a `summary.json` (13,806 lines, 12.6 MB):
  - A step ID was a UUID in each of the 2,625 block lines. Junie wrote a block 1 to 10 times, with the statuses
    `IN_PROGRESS`, `COMPLETED`, `FAILED`, `CANCELED` and `REJECTED`. After the end of a turn, it wrote the ended
    blocks again with the state `COMPLETED`.
  - The state `INPUT_REQUIRED` came with an ask request (36 lines), with a command block with `approvalRequest`
    (28 lines), and with 10 lines that tell nothing about the wait: a tip, a token count and a status line.
  - The first `CurrentDirectoryUpdatedEvent` named a directory above `projectDir` of `summary.json` in each session.
  - The last line was a suggestion or a `TaskState` in the state `COMPLETED` in 36 logs, and a line in the state
    `INPUT_REQUIRED` in 3 logs.
  - The longest line had 323,528 bytes. The output of a tool block had up to 318,191 characters.
- One event log of another session has 1.5 GB.
- A process of Junie has the executable
  `~/.local/share/junie/versions/<version>/Applications/junie.app/Contents/MacOS/junie` and the program name `junie`.
  The script `~/.local/bin/junie` replaces itself with it, so there is one process. `~/.junie/processes` and
  `~/.junie/instances` were empty while an ACP process without a session ran.
- Not in the read: the files that a process with a loaded session keeps open, and whether Junie only adds lines to
  `events.jsonl`. The first group of `tasks.md` checks them. "The checks of 2026-11-23" below gives the results.

### The checks of 2026-11-23

The tasks 1.1, 1.3 and 1.4 ran on the same day, with the code. `docs/manual-checks.md` holds the record. What the
checks changed:

- A process of Junie keeps its own log files open, and not `events.jsonl`. `~/.junie/processes` and
  `~/.junie/instances` stay empty, and the log of a process does not name its session. So the source has no
  `keepsOpen` and no `processSession` (decision 5).
- Junie only adds lines to `events.jsonl`: the inode stays, and the bytes from before stay.
  `junie --resume --session-id=<session ID>` continues the session in the same folder.
- A run of `junie --task "<task>"` writes no `UserPromptEvent`, so the index has no prompt entry of such a run.
- `TaskState` has the states `COMPLETED` and `CANCELED`. Both end a turn. The delta of "Step of a Junie session" now
  names both.
- While the terminal UI of Junie waits for the user, it writes a tip to the log about every 30 seconds. So the last
  write of the log is no start of a wait. `parse` now gives the time of a step (`stepAt`), the live table keeps it for
  a step of a wait, and the view gives it to the notes as the start of the wait (decision 4). The table keeps the time
  in the memory only, because `sessions.sqlite` gets no new column: after a restart, it reads the tail of a log with
  a step of a wait one time more.
- Junie writes an ended block two times in most turns: at its end, and again after the end of the turn. The index keeps
  one entry of a key. The read from the end of a log now gives an entry key one time in a page (`newestPage` of
  `src/SessionTail.mjs`), for each agent. A copy of the block in an older page still comes again there.
- An ended result of a turn comes first in the state `IN_PROGRESS`, and in 5 of 107 cases only there. So `parse` gives
  the assistant entry and the step `reply` for a result in each state but `INPUT_REQUIRED`, not only for the state
  `COMPLETED` (decision 3).
- For a client with the capability `elicitation.form`, Junie sends its question as `elicitation/create`. Megachat
  announces no elicitation, so a dialog for a question of a Junie child stays a change of its own, and that change
  has what it needs from Junie.
- `taskName` of `summary.json` and of `index.jsonl` is the first name of the task: in each of the 30 logs with two
  name events or more, it was the first one. A later `AgentTaskNameUpdatedEvent` names a later task of the session.
  It stays the newer title of the agent (decision 2), so Megachat can show a later title than Air shows.
- Not checked: "Done" of Air and a line of Megachat in Air (task 1.2). It needs an Air build and the author.

### The archive of a session of Junie in Air

From the sources of Air on 2026-11-23 (`plugins/air/frontback/providers/junie/threads/src/JunieSessionSource.kt` and
`JunieSessionIndex.kt`, the monorepo at `89f5d8e74d9ca`), and from the files of the author.

- Air lists the sessions of Junie from `index.jsonl`: the newest line of each session by `updatedAt`. A session
  without a line there is not in the list of Air.
- "Done" of Air (`archiveThread`) adds one line to `agent-workbench-archive-state.jsonl` next to `index.jsonl`:
  `{"sessionId":"<ID>","updatedAt":<ms>,"projectDir":"<project directory>","archived":true}`. `updatedAt` is the
  time now, or the `updatedAt` of the index line when that is later. A restore (`unarchiveThread`) adds the same line
  with `archived` false. Air also adds a line with `archived` to `index.jsonl`, and the result of the action does not
  depend on that write.
- The state of a session in Air is the last line of the archive state file for its session ID and its project
  directory. It wins over the `archived` field of the index lines. Without such a line, the session is not archived.
- Air reads the archive state file again when its size or its modification time changes, and then only the new
  lines. So it needs no restart for a line of another program.
- The file of the author had 11 lines, each with `archived` true. In each one, `projectDir` was the `projectDir` of
  the index line of the session. `index.jsonl` held no `archived` field in its 82 lines, so Junie does not keep the
  lines that Air adds there.
- The file `air-archive-import-v1.done` in the same folder is empty. No source of that checkout names it.

## Goals / Non-Goals

**Goals:**

- One source of Junie on the interface of the other sources. No second index, live table or archive.
- The statuses of a wait from the log, because Junie writes them.
- No write to a file of Junie but the archive state, in the format that Air reads.

**Non-Goals:**

- A connection to a Junie process of another program.
- The catalog of `session-catalog`. The source joins it later.

## Decisions

### 1. The session file is `events.jsonl`

`src/JunieSessionSource.mjs` has the agent `junie` and the root `~/.junie/sessions`. `all` and `files` give
`<folder>/events.jsonl` of each folder, `matches` and `relevant` take a path of two parts that ends with
`events.jsonl`, and `nameId` gives the name of the folder. The path names no project, so `files` gives no `directory`,
as the source of Codex does. `sessionSources` adds the source after the source of pi.

- Alternative: `transcript.md`. It is small, but it has no times, no step IDs and no state of a wait.
- Alternative: `state.json`. It holds only the last state.

### 2. The session data from the files next to the log

The log does not hold the project directory (see the read). So a source can have a method `describe(path, fs)` that
gives `meta` (`sessionId`, `cwd`, `startedAt`, `title`, `titleRank`) from other files. For Junie it reads
`summary.json` of the folder, at most 64 KB, and else the line of the session in `index.jsonl`, at most 4 MB, both
read-only and without a follow of a symbolic link. `projectDir` gives `cwd`, `createdAt` gives `startedAt`, and
`taskName` gives a title with the rank `agent`. The live table (`#full`), the import of the index and `inScope` of the
archive call `describe` before the lines of the log. A later `AgentTaskNameUpdatedEvent` gives a newer title of the
same rank. The source keeps no cache between two calls: `index.jsonl` is small.

- Alternative: the `cwd` of `CurrentDirectoryUpdatedEvent`. It is a directory above the project, so each session
  would be a session of the wrong directory.
- Alternative: a second file type in the interface. `describe` is one optional method, and the three readers get two
  lines each.

### 3. The entries come from the end of a block

`parse` gives an entry for a `UserPromptEvent` (key: `requestId`, else the hash of the line), for a
`UserResponseEvent` and a `UserAsyncResponseEvent` (key: the hash of the line, `lineKey`), for a
`ResultBlockUpdatedEvent` and a `MarkdownBlockUpdatedEvent` (role `assistant`, key: the step ID), and for a block of a
tool, a file view, a file change or an MCP call whose `status` is not `IN_PROGRESS` (role `tool`, `tool` `result`,
key: the step ID). The text of a tool entry is the command or the text of the block, a new line, and the output, cut
by `entryOf` to the limit of a source. The index keeps the first entry of a key (`ON CONFLICT DO NOTHING`), so the
lines that Junie writes again for an ended block add nothing, and a fork gives no second entry.

- Alternative: an entry for each line of a block. One command would give up to 10 entries with the same text.
- Alternative: no output in the index. The sources of Claude Code and Codex index the result of a tool.

### 4. The step comes from the state of an event

The rule is the one of the requirement "Step of a Junie session". An open step is `open`, which the interface has.
The new steps are `permission` and `question`. `OPEN_STEPS` of `src/SessionStatus.mjs` does not get them:
`sessionStatus` gives `waiting_for_permission` for `permission` and `waiting_for_user` for `question` before it reads
the age of the last write. Only the source of Junie gives these steps, so the status of each other agent stays.

The archive refuses a session with the status `waiting_for_permission`, as today. The check of the notes takes the
time of the event of the wait as the start of the wait of a Junie session, where it takes the time of the process
file for Claude Code. `parse` gives that time as `stepAt` with the step.

- Alternative: the status `stuck` after 10 minutes, as for Codex. The log says more than that, and the author asked
  for the wait.

### 5. The process rule and the link of a row

`PROGRAMS` gets `{ agent: 'junie', role: 'agent', names: ['junie'] }`, and `AGENT_NAMES` gets `Junie`. The rule comes
before the rule of an app bundle, so the bundle `junie.app` is not the owner of the session. The source has no
`keepsOpen` and no `processSession`, so `linkLogs` of `src/SessionLinks.mjs` links a row by its `cwd` and its start
time, as for pi. A Junie child of Megachat has the session ID of its run. Task 1.1 found that a process does not
keep `events.jsonl` open, so the source has no `keepsOpen`. A process that continues an old session gets no log by
this rule, so its row has no title and no status.

### 6. The archive state of Air for Junie

For the agent `junie`, `hide` adds one line to `~/.junie/sessions/agent-workbench-archive-state.jsonl`, in the format
of Air (see "The archive of a session of Junie in Air"): `sessionId`, `updatedAt`, `projectDir` and `archived` true,
in this order. `projectDir` is the project directory of the session without a separator at its end, as the index line
of Junie gives it. `updatedAt` is the time now, or the `updatedAt` of the session when that is later. `restore` adds
the same line with `archived` false, and `archivedState` reads the last line of the session and its project
directory. Megachat adds one whole line in one write with the append flag, and it changes no other line. It adds no
line to `index.jsonl`, because that file is of Junie. The card names the kind of the hide `junie`. The command that
continues the session is `junie --resume --session-id=<session ID>`. A session without a known project directory
gets no line: the card is saved, and the result names the error `archiveNoDirectory`. `describe` of the source also
gives the `updatedAt` of the session for the line.

Task 1.2 checks the hide and the restore with a real Air build. It is open: it needs the author.

- Alternative: `session/delete` of the ACP of Junie. It deletes the session, and the archive deletes nothing.
- Alternative: a title with the prefix `[archived] `, as for Claude Code. Air does not read such a title for Junie.
- Alternative: a line in `index.jsonl` too, as Air adds. Junie writes that file again without the field.

### 7. The session tools

`INDEX_ONLY` of `src/SessionHistoryService.mjs` becomes the set `pi` and `junie`. The text `error.sessionsIndexOff`
gets the name of the agent as a parameter. `agents_sessions`, `sessions`, `session_history` and
`agents_session_history` take `junie`. The read from the end (`readNewest`) uses the source of the live table, so it
needs no more code than the source. `agents_resume` calls `sessions.read` first, as today: with the index it finds the
session of the directory, and else it fails with `missing` or `sessionsIndexOff`. `agents_stop` and `agents_archive`
name the agent `Junie` in their dialogs.

### 8. The consent

`sessions.index` stays one consent. The question and the text of the setting name Junie. A stored `on` covers Junie:
the consent is to read the session files of the agents on this machine, and the user asked for this change. The
release note of the build says that the index now reads the sessions of Junie.

### 9. The state, the settings file and the ACP messages

- **The admitted work.** The change adds no kind of work. The import of the index and the live table are passes of
  the daemon. A disconnect of the ACP client does not stop them, and a restart starts the catch-up pass, which finds
  the files of Junie as new files. A run of `agents_resume` is a run of `junie-child`.
- **`sessions.sqlite`.** No new table and no new column. The tables `logs`, `files`, `sessions`, `entries` and
  `scopes` get rows with the agent `junie`. The version of the index file stays. An earlier build keeps these rows and
  does not read them: it has no source for the paths.
- **`conversation.sqlite` and `settings.json`.** No new field and no new key. A card of the archive gets the agent
  `junie` and the kind of the hide `junie`.
- **ACP.** No new message and no new `_meta` key.

## Risks / Trade-offs

- [The line of Megachat in the archive state file does not hide the session in Air] → The format comes from the
  sources of Air and from the lines that Air wrote. Nobody saw Air read a line of Megachat. The card stays in each
  case, and the result of the archive tells what Air shows for a session with a thread of Air.
- [The format of `events.jsonl` is not a public contract, and a new Junie can change it] → The parser gives nothing
  for a line that it does not know, as the other parsers do. The fixtures of `test/junie-sessions.test.mjs` hold the
  shapes of the read. `docs/manual-checks.md` names the version of Junie.
- [An event log of 1.5 GB makes the first pass slow] → The index reads a file in batches, and the age limit
  `sessions.days` leaves an old file out. The live table reads only the tail. Task 8.1 measures the first pass on the
  real folder.
- [A line above the limit of the line reader gives no entry] → Such a line is an output of a tool. The command of the
  block is in an earlier line of the same step, so the ended block can lose its entry. Task 2.2 has a fixture with a
  line of 400,000 bytes.
- [Junie does not only add lines to `events.jsonl`] → The live table and the index read a smaller file or a new inode
  from the start. Task 1.3 checks what Junie does.
- [Two sessions in one directory start at nearly the same time, so a row gets no certain log] → The rule of
  `session-logs` gives such a row no log and no status. Task 1.1 can give a certain link.
- [A session without `summary.json` and without a line in `index.jsonl` is in no project] → It stays out of the index.
  The live table still has it, so `agents_running` shows its status.
- [A write to the archive state file while Air writes it] → Each program adds one whole line in one write with the
  append flag. Task 1.2 checks that Air shows a line that Megachat added.
- [Air makes the project directory of its key in another way than Megachat, for example for a linked worktree] → Then
  Air still shows the session. The archive already tells the user what Air shows after a hide, and to press Done in
  Air (see the capability `session-archive`). Task 1.2 has a session of a linked worktree.
- [The step `question` hides a session that is in fact stuck] → A line of the agent in the state `IN_PROGRESS` after
  the ask request gives an open step again, so only a session whose last event is the question keeps the status.
- [The changes `session-archive` and `session-catalog` are not in the archive of OpenSpec yet] → The requirements of
  this change are new requirements of a capability of its own, and they refer to those capabilities by name. Archive
  `session-archive` and `junie-child` before this change.

## Migration Plan

No migration. With the index on, the daemon of this build imports the sessions of Junie in its catch-up pass. To go
back, start an earlier build: it does not read the rows of the agent `junie`.

## Open Questions

- Whether `JUNIE_DATA` or another variable moves `~/.junie`. The read found no such variable for the session folder.
  Until one is known, the root is `~/.junie/sessions`.

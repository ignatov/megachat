# Design

## Context

See `proposal.md`, part "Why". The checks of 2026-11-14 read these sources, read-only: `~/.codex/state_5.sqlite`
(table `threads`, columns `archived` and `archived_at`), `codex archive --help` of codex-cli 0.167.0, `claude rm
--help` and `claude stop --help`, the Air sources in `~/src/ultimate/plugins/air` at `e9de692b3d125`
(`shared/session/src/model/AgentThreadArchiveTitles.kt`, `backend/providers/claude/threads/src/ClaudeSessionSource.kt`,
`ClaudeThreadRenameEngine.kt`, `backend/store/ClaudeStoreThreadBackend.kt`, `ClaudeSessionWorkerStopper.kt`,
`backend/providers/codex/threads/src/CodexSessionSource.kt`, `backend/providers/pi/threads/src/PiSessionSource.kt`),
and `herdr --help`.

## Goals / Non-Goals

**Goals:**

- One confirmation archives many sessions of each owner, and no work is lost.
- The card tells what the session did and how to continue it, with no model request.
- The hide shows in Air and in Codex with no change of these products.

**Non-Goals:**

- A stop of a session that works, waits or runs a tool.
- A close of a terminal tab or a herdr pane. The tab stays with its shell.
- A model summary.

## Decisions

### 1. What "archive" means for each owner

| Owner of the row | Card | Close of the process | Hide |
|---|---|---|---|
| `terminal` (Terminal, Rex, iTerm, SSH) | yes | SIGTERM, then SIGKILL, after the dialog | Codex: `codex archive`; Claude Code: title record |
| `multiplexer` (herdr, tmux) | yes | the same; the pane stays | the same |
| `ide` (IntelliJ IDEA, Air) | yes | no: the answer tells the user to archive it in Air, which stops and marks it | only when no process is live |
| `megachat` (a child run) | yes | no: the user cancels the task with `agents_cancel` first | after the run ends; a pi child gets a card only |
| `unknown` (such as `claude daemon` jobs) | yes | no: the answer gives `claude stop <id>` | only when no process is live |
| no process (a past session of the index) | yes | none | yes |

### 2. The order of the steps

For each row of a confirmed batch: (1) the checks again, (2) the card, appended and flushed, (3) the stop, if the
row allows it, (4) a wait for the exit of up to 10 seconds, (5) the hide, only when no process of the session lives.
A failure of a step stops the steps of that row and the result names it. The card comes first, so a daemon crash
after it loses no context.

### 3. The hide, in the format of Air

Air has no archive store of its own for a session that a CLI owns. Its action "Done" calls `AgentSessionStoreArchiveSource.archiveSession`, and `ClaudeSessionSource` does two steps: it stops the Claude Code workers of the session (`ClaudeSessionWorkerStopper`), then it appends the title records (`ClaudeStoredThreadRenameEngine.archiveThread`). "Reopen" appends the title without the prefix. Air reads the state from the log, with no index: a Claude Code row is archived when its name carries the prefix. The name is the last `agent-name`, else the last `custom-title` of the tail, else the sidecar, else the first `custom-title`. The checks on 2026-11-14 found 16 logs with these records, and each has the two lines at its end in this order: `custom-title`, `agent-name`.

Megachat writes the same bytes:

- Claude Code: append `{"type":"custom-title","customTitle":T,"sessionId":ID}` and `{"type":"agent-name","agentName":T,"sessionId":ID}`, each with a newline, in one `write` with the flag `a`. `T` is `[archived] ` and the normalized title: each run of white space is one space, trimmed, and `Session <first 8 characters of the ID>` when empty. The whole `T` has at most 200 characters (`capClaudeThreadTitleToCliLimit`). The sidecar `<project>/<id>/custom-title.json` (`{"customTitle":T}`, mode 0600, atomic replace) is rewritten only when it exists, as `ClaudeCustomTitleSidecarWrite.WHEN_PRESENT` does.
- Restore: the same two records with `T` without the prefix.
- Idempotence, as in Air: when the state and the title already match, nothing is written.
- pi: a `session_info` line `{"type":"session_info","id":<new 8-character hex>,"parentId":<the last entry ID or null>,"timestamp":<ISO time>,"name":T}`, as `PiSessionStore.archiveThread` of Air does.
- Codex: Air does not read a file. It calls the app-server (`thread/archive`, `thread/unarchive`), and Codex moves the log to `archived_sessions` and sets `threads.archived`. `codex archive <id>` and `codex unarchive <id>` of the CLI do the same, so Megachat runs the CLI. The source `CodexArchiveSource` of Megachat reads that folder already.
- No write when a process of the session lives. Air stops the workers first, and so does the archive of Megachat. A live Claude Code process writes its own title records again, and they would win.
- After the write, Megachat reads the tail again. The state must be as written, else the result says `hidden: pending`.
- No ACP request: the `_session/archive` of Air (the capability `sessionArchive`) is a request from Air to an agent for the sessions that this agent lists, so it does not reach a session of a CLI. The open decision of the proposal is closed: Megachat uses the format of Air. No Air change is needed.

### 4. The card

A card is one JSON line of `session-archive.jsonl` in the state directory, mode 0600. Fields: `agent`, `sessionId`,
`title`, `cwd`, `owner`, `startedAt`, `lastActivityAt`, `archivedAt`, `firstPrompt` (500 characters), `lastPrompt`
(500), `lastReply` (1,000), `branch`, `commits` (the hashes that the output of `git commit` and `git push` in the log
names, at most 20), `tickets` (IDs such as `IJAI-6285`, `ORDER-389`, and GitHub issue and pull request URLs, at
most 20), `files` (the paths of the edit tools, at most 50), `resume` (the arguments of `agents_resume` and the shell
command, such as `claude --resume <id>`), `hidden` (`codex`, `title`, `none` or `pending`), `warnings`, `restoredAt`.
The secret filter of the capability `session-index` runs on each text field. The commits come from the log, not from
`git log`, because one directory can hold 8 live sessions.

No model: the card costs nothing, sends no text out, and a test can check it. Phase 2 of the brief measures whether
the last answer is enough.

### 5. The checks

Refuse the row: the status `working`, `stuck` or `waiting_for_permission`; the process file of Claude Code says
`shell`; a process below the agent that is no MCP server and no helper of the agent (a tool runs); a Megachat run
of the session; a Codex row with an activity in the last 10 minutes, because Codex writes no permission record; no
consent `sessions.index`.

Warn in the dialog: `git status --porcelain` in the `cwd` gives files; the branch is ahead of its upstream; another
live session has the same `cwd`; the last activity is less than 1 hour ago. A warning does not refuse, because the
uncommitted files of a shared checkout can belong to another session.

### 6. The dialog

The present stop dialog of the capability `stop-sessions`: one `session/request_permission` with a line for each row
(agent, project, age, owner, the action, the warnings), and the options `archive` (`allow_once`) and `keep`
(`reject_once`). A batch has at most 50 rows. Requests stay in the memory, as for a stop: after a daemon restart, an
open request is gone, and the main agent asks again.

### 7. Persistence

The card is written before the stop, so a disconnect or a restart after the confirmation loses no card. A row with
`hidden: pending` after a restart gets no automatic hide: `list` shows it, and a new `archive` of the row completes it.
No field of `conversation.sqlite` or `settings.json` changes. No ACP message and no `_meta` key is added.

### 8. Sync with Air in both directions

- Archived in Air, seen in Megachat: the session index sets `archived` on a Claude Code or a pi record when its title carries the prefix, and on a Codex record of the folder `archived_sessions`. `list` marks such a session, `archive` of it answers `already archived` and writes nothing, and `restore` works for it, with or without a card.
- Archived in Megachat, seen in Air: the two records are what Air writes. Air reads the head and the tail of each changed log, and its file watch of `~/.claude/projects` starts that read. The check 3.2 of the tasks measures how fast the row of a running Air moves. A row of Air that has its own state (a replica with an explicit `archived` value, as after a Reopen in Air) can keep its own value: Air then prefers its replica to the provider. Air gives the same value to a later Done.
- A session that a process of Air runs: the owner `ide`. Megachat writes no mark and sends no signal, so it never fights Air. The answer says to use Done in Air.
- Restore in Air of a session that Megachat archived: Air appends the title without the prefix. The card keeps `hidden: title`; `list` reads the current state from the log and shows the session as active.

## Risks / Trade-offs

- The title record couples Megachat to a format of Air. The format is the one that Claude Code writes for `/rename`, it has a spec and tests in Air, and the CLI integration test of Air reads it with a real `claude`. The IJAI ticket (task 1.2) asks to keep it as a contract. A test reads a fixture in that format.
- A replica of Air with an explicit `archived: false` wins over the provider. The row then stays active in Air, and the card of Megachat says `hidden: title`. The user sees it only for a session that Air ran and reopened.
- SIGTERM to an interactive Claude Code or Codex in a terminal: Air does the same for Claude Code. Nobody tested
  what the Codex TUI writes on SIGTERM. Task 1.1 checks it on a copy.
- `codex archive` of a thread that the Codex app shows: not tested.
- The user can type into the tab between the dialog and the signal. The checks run again before the signal.

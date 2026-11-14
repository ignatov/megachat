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

### 3. The hide

- Codex: Megachat runs `codex archive <sessionId>`. Codex then writes its own files. `restore` runs
  `codex unarchive <sessionId>`.
- Claude Code: Megachat appends two lines to the log, `{"type":"custom-title","customTitle":"[archived] <title>",
  "sessionId":...}` and the same with `agent-name` and `agentName`, and writes `custom-title.json` only when it is
  present, as `ClaudeStoreThreadBackend.appendTitleRecords` of Air does. `restore` appends the title without the
  prefix. `claude --resume` still lists the session, with the prefix in its title.
- pi: a `session_info` record with the prefix, as `PiSessionStore.archiveThread` of Air does.
- The prefix is the constant `ARCHIVED_TITLE_PREFIX` = `[archived] ` of `src/SessionArchive.mjs`, the value of
  `AGENT_SESSION_ARCHIVED_THREAD_TITLE_PREFIX` of Air.
- No write when a process of the session lives: two writers on one log is the known hazard.

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

## Risks / Trade-offs

- The title record couples Megachat to a format of Air. The IJAI ticket makes it a contract. A test reads a fixture
  in that format.
- SIGTERM to an interactive Claude Code or Codex in a terminal: Air does the same for Claude Code. Nobody tested
  what the Codex TUI writes on SIGTERM. Task 1.1 checks it on a copy.
- `codex archive` of a thread that the Codex app shows: not tested.
- The user can type into the tab between the dialog and the signal. The checks run again before the signal.

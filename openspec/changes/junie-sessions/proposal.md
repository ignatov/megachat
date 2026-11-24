# Proposal

## Why

The author wrote on 2026-11-23, after the proposal `junie-child`: "не забудь еще что бы я мог выполнять действия с
джуни сессиями - спаунить, архивировать, читать, забирать элиситейшн и так далее, список не конечный" (do not forget
that I must be able to do the actions with the sessions of Junie: to spawn, to archive, to read, to take an
elicitation and so on, and the list is not final). So the rule of this change is: each action that Megachat has for a
session of Claude Code, Codex or pi works for a session of Junie.

The change `junie-child` gives the start of a task in Junie. Each other action reads a session from a session source
(`src/SessionSources.mjs`), and there is a source for Claude Code, Codex and pi only. So Megachat does not find, read,
list, archive or continue a session of Junie, also a session that its own Junie child made.

Junie keeps what a source needs. A read of the session folder of Junie on 2026-11-23 showed an event log
`~/.junie/sessions/<session ID>/events.jsonl` with the prompts, the replies, the tool blocks, the end of a turn, and
a state `INPUT_REQUIRED` for a permission request and for a question to the user. `design.md` has the record.

## What Changes

Where it shows: the chat (the tools `agents_sessions`, `agents_session_history`, `agents_running`, `agents_archive`,
`agents_resume` and `agents_stop`, and the notes about the sessions that wait), the tools `sessions` and
`session_history` of a child, and the first setup question about the index.

- **A source of the sessions of Junie.** Megachat reads `events.jsonl` of each session folder in `~/.junie/sessions`,
  read-only. The session ID is the name of the folder. The project directory and the title come from `summary.json`
  of the folder, else from `index.jsonl` of Junie.
- **To find and to read.** With the consent `sessions.index`, the index holds the sessions of Junie of the listed
  directories. `agents_sessions` and `sessions` take the agent `junie`, and a search without an agent includes Junie.
  `agents_session_history` and `session_history` read a session of Junie. Junie has no live provider, as pi has none:
  without the index, a request for Junie fails with a text that says so.
- **To see what runs.** `agents_running` lists the sessions of Junie, from a terminal, an IDE or Megachat, with the
  session ID, the title and the status of the log.
- **To see a session that waits for the user.** The log of Junie tells it, so a session of Junie that waits for a
  permission has the status `waiting_for_permission`, and one that waits for the answer to a question has
  `waiting_for_user`. These are the statuses that the process file of Claude Code gives. A session outside Megachat
  that waits for a permission for 5 minutes gets the note of the capability `session-notes`.
- **To archive and to restore.** `agents_archive` takes a session of Junie: the card, the stop of an idle terminal
  process, the hide in the format that Air reads for Junie, and the restore. The card gives the command that
  continues the session.
- **To continue.** `agents_resume` takes the agent `junie`: a Junie child loads the session of the user and gets the
  prompt. This part needs the change `junie-child`.
- **To stop.** `agents_stop` stops an orphan session of Junie, by the rules of the capability `stop-sessions`.
- **The consent.** The question of the setup and the text of `sessions.index` name Junie. A stored `on` covers the
  sessions of Junie: it is the same consent to read the session files of the agents on this machine.

ACP extension: none. Megachat is no ACP client of Junie in this change but for `agents_resume`, which uses the run of
`junie-child`. Air needs no change. Megachat writes the archive state of a session of Junie in the file and the format
that Air reads (see `design.md`, decision 6).

Non-goals of the project: the change touches none.

## Capabilities

### New Capabilities

- `junie-sessions`: the source of the sessions of Junie, and what the index, the live table, the status, the archive
  and the continue do with a session of Junie.

### Modified Capabilities

- `session-index`: "Consent of the user" is MODIFIED: the question names Junie.
- `running-sessions`: "List of the running sessions" is MODIFIED: Junie is an agent of the list.

## Out of scope

- An answer to a permission request or to a question of a session that another program runs. Megachat has no
  connection to that process. It shows the wait, and the user answers in the terminal or in the IDE of the session.
- A dialog in the chat for a question of a Junie child. See "Out of scope" of the change `junie-child`.
- A note for a session that waits for the answer to a question. `waiting_for_user` gives no note for each agent (see
  the capability `session-notes`).
- A live provider of Junie: a read without the index, through a Junie process.
- The files of a session folder other than `events.jsonl`, `summary.json` and the file of the archive state:
  `transcript.md`, `state.json`, the checkpoints and the folders of the subagents. A session folder without
  `events.jsonl` is no session of the source.
- The catalog of the change `session-catalog`. The source of Junie has the interface of the other sources, so the
  catalog takes it when that change comes.
- The cost of the sessions of Junie in the morning report.

## Impact

- Code: a new `src/JunieSessionSource.mjs`, `src/SessionSources.mjs` (the source, and a method that gives the session
  data of a file next to the log), `src/SessionCatalog.mjs` and `src/SessionIndexService.mjs` (that method, the count
  of the agents), `src/SessionStatus.mjs` (the two steps of a wait), `src/SessionHistoryService.mjs` and
  `src/MegachatHistoryServer.mjs` (the agent `junie`), `src/AgentProcesses.mjs` (the program `junie`),
  `src/SessionArchive.mjs` (the hide, the restore and the command of Junie), `src/SessionNotes.mjs` and
  `src/AcpBridge.mjs` (the name `Junie`), `src/PiMegachatService.mjs` (`agents_resume`).
- State: `sessions.sqlite` gets rows with the agent `junie`. No new table and no new file.
- Texts: `resources/Megachat.properties`, `resources/instructions.md`, and the question about the index in the four
  onboarding files.
- Documents: `README.md`, `docs/manual-checks.md`.
- Tests: a new `test/junie-sessions.test.mjs` with fixtures of an event log, and cases in
  `test/session-index.test.mjs`, `test/session-logs.test.mjs`, `test/running.test.mjs`, `test/archive.test.mjs`,
  `test/session-notes.test.mjs` and `test/integration.test.mjs`.
- Dependencies: none.

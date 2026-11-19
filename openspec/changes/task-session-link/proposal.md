# Proposal

## Why

A colleague of the author wrote on 2026-11-18: "Нужна возможность переходить из мегачата сразу в заспауненую сессию -
сейчас открывается сессия в txt" (we need a way to go from Megachat directly to the spawned session; now a session in
txt opens). The author answered on 2026-11-19: "если у нас даже есть уже настоящая сессия, которая в проекте крутится,
то просто нужно ее открыть" (when we already have a real session that runs in the project, we must simply open it), and
on the same day he asked to start the Air side in the monorepo.

The code shows the cause. The row of a child run in the Background Tasks tab of Air has only one target for a click:
`outputFilePath` with the plain text transcript `transcripts/<run ID>.txt` (`childRows` in `src/AcpBridge.mjs`, and
"The transcript of a child run" in `docs/air-contract.md`). Air opens that file in an editor. The update
`async_task_spawned` has no field that names the session of the child. But a Claude or Codex child runs in a real
session of Claude Code or Codex: the daemon knows its provider session ID, and it already sends the same address to Air
in `_session/service/record` (`agentId`, `sessionId`, `cwd`).

## What Changes

Where it shows: the task list of Air (the Background Tasks tab of the chat). A click on the title of the row of a
running Claude or Codex child opens the session of that child in Air, and the sessions tree selects it. The chat text,
the commands and the log do not change.

- **A new capability of Air.** Air sends `asyncTaskSessions` in `_meta.jetbrains.air.capabilities` of `initialize`.
  Megachat sends the new field only to a client that sent it.
- **The field `session`.** The row of a Claude or Codex run gets `session`: `{ "agentId", "sessionId", "cwd" }`, the
  same triple as the parameters of `_session/service/record`. `agentId` is `claude` or `codex`, `sessionId` is the
  session of the provider, and `cwd` is the absolute directory of the run. The row holds the field in each phase
  (`queued`, `resuming`, `approval`, `running`) when the daemon knows the session. So the row of a follow-up
  (`agents_send`) and of a continued session of the user (`agents_resume`) holds it from its first update.
- **A new child gets its session later.** The provider session of a new child comes when the adapter answers
  `session/new`, after the row of the phase `running` is in the list. Then Megachat sends one `async_task_progress`
  that holds only `asyncTaskId` and `session`. This is the first `async_task_progress` that Megachat sends. It holds no
  `description`, `summary`, `lastToolName`, `usage` or `outputFilePath`, so the row keeps its look.
- **After an attach.** Megachat sends the rows again on each attach, with `session` when the daemon knows it, and one
  `async_task_progress` with `session` for each such row. Air can keep an open task from before the attach and drop the
  second spawn, and the progress still gives it the session.
- **The transcript stays.** `outputFilePath` stays as it is. Air opens the file when it cannot open the session.
- **Who gets no field.** A pi child: it has no session file of Claude Code or Codex. The row of the import of past
  sessions. A client without `asyncTaskSessions`: its updates do not change.
- **The documents.** `docs/air-contract.md` gets the capability, the field and the progress update, and the section
  "The transcript of a child run" says that the file is the fallback. `README.md` "Read the transcript of a task" says
  that a click opens the session of a Claude or Codex child.

ACP extension: yes. The change adds the capability `asyncTaskSessions` of Air, the field `session` in
`async_task_spawned` and in `async_task_progress`, and the first use of `async_task_progress` by Megachat. Air must:
read `session`, keep the first value of a task as it does for `outputFilePath`, make the title of a row with `session` a
link, open that session on a click and select it in the sessions tree, wait a short time when the session is not in its
list yet, and open `outputFilePath` when the open fails. Another worker makes the Air side in the monorepo now. Open
for Air: the open of a hidden service session (a new child with `children.showInProject` `false`).

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-view`: "Session of a child task row", "Session of a new child after its start" and "Session of a row after an
  attach" are new.
- `transcripts`: "Transcript file in the row of a run" is MODIFIED: the file stays the target of a row without a
  session, and the only `async_task_progress` is the one that gives the session.

## Out of scope

- A link to the session after the run ended. A row ends when its run ends, and Air keeps no ended task in the Background
  Tasks tab. So the link exists only while the run is unfinished, as the link to the transcript does today.
- A link to the session in the reply text of the main agent. It is a later step.
- The mark "created by Megachat" on the session row in the sessions tree. It needs a second contract,
  `_session/delegated/record`, and it is a later step.
- A session for a pi child. Its row keeps only the transcript.
- A change of `_session/service/record`, of `children.showInProject`, or of the hide of a service session.
- No new setting, no new state field and no new user-visible string.

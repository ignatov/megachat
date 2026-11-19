# Design

## Context

See proposal.md, "Why". The code shows this today:

- `taskRows` in `src/AcpBridge.mjs` gives one row for each unfinished run. The ID of a row is `<run ID>:<phase>`, and
  the phase is `queued` (status `admitted`), `resuming` (status `admitted` with `resumeOf`), `approval`, or `running`
  for each other status that is not terminal, also `launching` and `ready`. `rowRunId` gives the run ID of a row ID.
  A change of the phase ends the old row with `completed` and sends a new row with a new ID.
- `childRows` sends `async_task_spawned` one time for each row ID that the view did not send yet (the map
  `childTasks`). It adds `outputFilePath` for the phases `running` and `approval`. A view sends no
  `async_task_progress` today. An attach clears `childTasks`, so the view sends each unfinished row again.
- The provider session of a run is `providerSessionId` in the state. `admitChild` (`src/MegachatState.mjs`) sets it at
  the admission for a follow-up (`agents_send`, the session of the earlier run) and for a continued session of the user
  (`agents_resume`, the argument `sessionId`). A continuation (`addContinuation`, after a crash or a steer) copies it
  from its earlier run. A new child has `null` until the adapter answers `session/new`: `AcpRunService` then moves the
  run from `launching` to `ready` with `providerSessionId` (`src/AcpRunService.mjs`, about line 390). The row of the
  phase `running` is already in the list at `launching`, so a new child sends that row without the session.
- A pi run also gets `providerSessionId`: the ID of its conversation in the harness (`src/PiRunService.mjs`, line
  127). It is not a session of Claude Code or Codex. So the test of "a known session" must also test the agent.
- Each change of the state reaches each view as the event `tasks` of `/events` (`src/DaemonServer.mjs`), and the view
  calls `childRows` with the new state. So a view sees the run at `ready` or at a later status with the session.
- Air (`plugins/air`, read on 2026-11-19, `AcpSessionRuntimeFacts.kt`): `mapAsyncTaskSpawned` drops a spawn for a task
  ID that is open. `mapAsyncTaskProgress` reads only `description`, `summary`, `lastToolName`, `outputFilePath`,
  `toolCallId` and `usage`, and it drops an update without one of them. Air clears its open tasks only when the agent
  process exited, not at a `session/load` in the same process. The guide `docs/guides/acp-async-tasks-guide.md` of Air
  says that a progress update can carry a binding field that the provider finds after the spawn, such as
  `outputFilePath`, and that Air then makes no progress entry for it.

## Goals / Non-Goals

**Goals:**

- A click on the row of a Claude or Codex child opens the session of the child in Air.
- The row of a client without `asyncTaskSessions` stays as it is, update for update.
- One place gives the session of a row, from the state that the view has.

**Non-Goals:**

- A change of the state document, of the daemon routes or of the run services.
- A session for a pi run, and a session after the end of a run.

## Decisions

### 1. The field `session` and its value

`session` is `{ "agentId": run.agent ?? "claude", "sessionId": run.providerSessionId, "cwd": run.cwd }`. It is the same
triple that `tasks` gives to `_session/service/record`, so Air has one address for one session. A run without the field
`agent` is from before the choice of the agent, so it is a Claude run, as in `serviceSessionsOf`. `cwd` is the
directory of the run, an absolute path that the state checked at the admission (`isDirectoryOf`).

A new function of `src/AcpBridge.mjs`, `rowSession(run)`, gives the value, or `null` for a pi run, for a run without
`providerSessionId`, and for an unknown run. `taskRows` does not change, because `test/parallel.test.mjs` and
`test/pi-child.test.mjs` compare its rows. The import of past sessions has no run ID (`rowRunId` gives `null`), so its
row gets no session.

### 2. The capability gate

The bridge reads `asyncTaskSessions` from the capabilities of `initialize`, as it reads `asyncTasks`, and keeps it as
`taskSessions` for each view. Only a view with both `asyncTasks` and `asyncTaskSessions` sends `session`.

The gate is not necessary for the safety of an older Air. An older Air reads the fields of a spawn by name, so it
ignores `session`. It drops a progress update that holds no field that it knows (`mapAsyncTaskProgress`), so the new
progress update makes no entry. Recommended: keep the gate all the same.

- The contract with the Air side names the capability, so each side can tell from the log what the other side does.
- The tests of today compare the full row of a client with `asyncTasks` (`test/transcript.test.mjs`). With the gate,
  such a client gets the same updates, so a regression shows at once.
- An Air build can leave the capability out while its open of a session does not work, for example for a hidden service
  session, and the row then stays a link to the transcript only.
- The cost is one boolean.

Other option: send `session` to each client with `asyncTasks`. Then Air needs no capability, and an older Air gets the
field and ignores it. This saves one line in Air and one row in the contract.

Megachat does not send `asyncTaskSessions` back in its answer of `initialize`. Air sees the field in the row, and an
older Megachat sends no field, so Air can fall back to `outputFilePath` without the echo.

### 3. The rows that hold the session

The spawn of a row holds `session` when `rowSession` gives a value at the time of the spawn, in each phase.

- `queued` and `resuming`: a follow-up, a continued session of the user and a continuation of a run that had its
  session hold it. Recommended: yes. The session exists in the sessions tree, and the user sees its earlier turns. The
  row has no `outputFilePath`, because the transcript of the run does not exist yet. When Air cannot open the session,
  it opens its own transient editor, as for a row without a file today. Other option: no session in a row without a
  file, so the two links come together.
- `running`: a new child sends its first `running` row at `launching`, without the session (decision 4). A follow-up and
  a continued session hold it from the spawn.
- `approval`: the run had its session before its first prompt, so the row holds it. The same holds for the `running`
  row after an approval.
- A new Claude or Codex child with `children.showInProject` `false` is a service session that Air hides. Recommended:
  send `session` all the same, and Air decides how to open a hidden session. Other option: no `session` for a service
  session, so the row of such a child stays a link to the transcript.

### 4. The progress update of a new child

`childTasks` keeps for each sent row ID the run ID and whether the view sent the session of the row. At each `tasks`
event, for each row that the view sent without the session, the view sends one update when `rowSession` gives a value:

```json
{ "sessionUpdate": "async_task_progress", "asyncTaskId": "<run ID>:running",
  "session": { "agentId": "claude", "sessionId": "<provider session>", "cwd": "/abs/project" } }
```

The update holds only `asyncTaskId` and `session`. It holds no `description`, `summary`, `lastToolName` or `usage`,
because Air shows a progress fact in the row and keeps it in its session log, and the row must keep the description of
its spawn. It holds no `outputFilePath`, because the spawn of a `running` row already gave the file, and the first value
of a task stays in Air. The view marks the row and sends no second update for it.

The timing: the session comes at the move to `ready`, after the adapter answered `session/new`, and before the daemon
sends the first prompt (`dispatched`). The bridge can see a later status first, because the event `tasks` gives the
state of the moment. Each case gives one update. A run that fails at `launching` gets no session and no update. A
crash and its continuation give a new run ID, so a new row, and the rule applies to that row again.

### 5. The attach

An attach clears `childTasks`, and the view sends each unfinished row again with `session` when it knows it. Air keeps
its open tasks through a `session/load` in the same agent process, and it drops a second spawn of an open task. So a
session that came while no view was attached, or between the close of the old view and the attach, would not reach
Air. Therefore the view sends one progress update with `session` after each row that it sends at its attach and that
holds the session. The first value of a task stays in Air, so the second value of a task that Air already has changes
nothing. Recommended: this rule. Other option: no progress at an attach. Then the row of such a task stays a link to the
transcript until its phase changes.

### 6. The daemon, the state and a restart

The change reads `agent`, `providerSessionId` and `cwd` of a run in the state document `conversation.sqlite`. These fields
exist in each state of a release, so an older state directory needs no migration. The change adds no field to
`conversation.sqlite` or `settings.json`. A disconnect of the ACP client keeps the admitted work in the daemon, as
before. The next attach sends the rows with their session (decision 5). A restart of the daemon keeps
`providerSessionId` in the state, so the rows after the restart hold the session too. A restart of Air starts a new
agent process, so Air has no open task and takes the spawn.

### 7. ACP messages and `_meta` keys

- Read: `_meta.jetbrains.air.capabilities` of `initialize`, the new value `asyncTaskSessions`.
- Written: the field `session` in `session/update` with `async_task_spawned`, and `session/update` with
  `async_task_progress` with `asyncTaskId` and `session`. No `_meta` key is new.

## Risks / Trade-offs

- [The session file of a new child does not exist yet when the progress update comes, because Claude Code writes the
  file at the first prompt.] → Air waits a short time for a session that is not in its list. The progress comes just
  before the first prompt, and a click comes later.
- [The user opens the session of a running child in Air and sends a prompt there, so two clients write to one
  session.] → This is possible today for a child with `children.showInProject` `true`, from the sessions tree. Open for
  Air: whether the open of a session that a Megachat child runs shows it without a second writer, or warns.
- [Air cannot open a hidden service session.] → Air opens `outputFilePath`. The row of a `queued` or `resuming` phase
  has no file, so Air shows its transient editor.
- [Air reads `session` from a progress update only in a new build.] → The capability gate keeps the field away from an
  older Air.
- [A view sends one more update for each row with a session at each attach.] → The state admits at most 8 unfinished runs
  (`maxUnfinishedRuns`), so an attach sends at most 8 more updates.

## Decisions for the author

Each decision has a recommended option, and the specs and the tasks use it.

1. **The capability gate.** Recommended: keep it (decision 2). Other option: `session` to each client with
   `asyncTasks`.
2. **The session in a `queued` and a `resuming` row.** Recommended: yes, when the daemon knows it (decision 3). Other
   option: only in the rows with `outputFilePath`.
3. **The session of a hidden service session.** Recommended: send it, and Air decides (decision 3). Other option: no
   `session` for a child with `children.showInProject` `false`.
4. **A progress update after each attach.** Recommended: yes (decision 5). Other option: none.

## Open Questions

- Air: the open of a hidden service session, and the open of a session that a Megachat child runs (see the risks).

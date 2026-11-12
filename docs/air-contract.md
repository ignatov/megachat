# The contract with Air

Megachat is an ACP agent. Air is the ACP client in the JetBrains IDEs. This file lists each ACP extension that the two
sides exchange, the side that sends it, and what the other side does. `src/AcpBridge.mjs` holds the Megachat side.

A change of an extension needs the same change in Air. Change this file in the same commit.

## The agent identity

- The `acp.json` entry of the user has the name `Megachat`. Air derives the agent ID `acp.megachat` from that name.
- Air shows the Gothic M icon and the first row of the session list for the agent `acp.megachat`.
- An IDE build without the Air support for Megachat starts it as an ordinary custom ACP agent. That build sends no
  capability, so Megachat sends no `_workspaces/list` and no `_session/service/record`. Nobody tested that case.
- Megachat gives the agent name `air-megachat` in `agentInfo`, and the version of `package.json`.
- Megachat accepts the session IDs `megachat` and `megachat-<UUID>`. `session/new` gives a new `megachat-<UUID>`.

## The capabilities

Both sides put their capabilities in `_meta.jetbrains.air` of `initialize`, as `{ "version": 1, "capabilities": [...] }`.
Megachat reads the list of Air only when `version` is 1 or more.

| Capability | Sender | What the other side does |
|---|---|---|
| `asyncTasks` | Air | Megachat sends its child runs as background tasks. Megachat also sends `asyncTasks` back. |
| `serviceSessions` | Air | Megachat records each delegated session with `_session/service/record`. |
| `workspaces` | Air | Megachat asks for the open projects with `_workspaces/list`. |
| `persistentSession` | Megachat, always | Air sends no `session/cancel` and no `session/close` when it releases the runtime. Air loads the session again on each attach. Air sends `clientMessageId` with each prompt. |
| `asyncTasks` | Megachat, when Air sent it | Air lists the background tasks of the session. |

## The requests

| Method | Sender | Parameters | What the other side does |
|---|---|---|---|
| `_workspaces/list` | Megachat | `{}` | Air returns `directories`: the trusted open project directories. Megachat registers each one in the daemon, and skips a directory that the daemon cannot read. Megachat asks on each attach and every 15 seconds while a view is open. |
| `_session/service/record` | Megachat | `agentId`, `sessionId`, `cwd` | Air hides that session from the session list. `agentId` is `claude` or `codex`. `sessionId` is the session of the provider. A pi child has no session file of Claude Code or Codex, so Megachat sends no record for it. |
| `session/request_permission` | Megachat | `sessionId`, `toolCall`, `options`, `_meta.jetbrains.air.permission` | Air shows the request of a child, and the stop request of the main agent, as a permission dialog. See "The permissions" and "The stop dialog" below. |
| `_session/async_task/stop` | Air | `sessionId`, `asyncTaskId` | Megachat cancels the child run of that row, and no other work. It answers `{ "stopped": true }` when it accepted the stop, and `{ "stopped": false }` for each other case. Then the row ends with its terminal update. See "The Stop of a row" below. |

Megachat sends `_session/service/record` once for each attach, for each address in the `serviceSessions` map of the
daemon state. The daemon adds an address when a delegated run gets its provider session, and it keeps the address
after it drops the run. A run that continues an existing session of the user is not a service session: that session
stays in the session list. The record on each attach lets a second product, or a new Air state, hide the earlier
delegated sessions too.

Megachat sends the records one after the other, before the view is ready. The map keeps at most 5,000 addresses, so
one attach can send 5,000 requests. Nobody measured that time in Air. `docs/roadmap.md` has the change.

## The prompt

- Air sends `clientMessageId` in `_meta.jetbrains.air` of `session/prompt`. Megachat uses it as the request ID of the
  input. A repeated ID returns the first admission, so a retry of Air admits the message once.
- `session/cancel` cancels the current main task and each child that it owns. While no turn runs, it withdraws the
  prompt suggestion that the view showed.
- Megachat accepts the content blocks `text` and `resource_link` in `session/prompt`. This is the base protocol: ACP
  requires these two types of each agent, and Megachat announces no other prompt capability. The main agent gets each
  link as the Markdown link `[name](uri)` on a line of its own, in the order of the blocks. Megachat refuses each other
  block type. The input of the main agent has at most 100,000 characters, with the links.

## The prompt suggestion

In the mode `ghost` of the setting `reply.suggestions`, the main agent gives one next step as a prompt of the user.
The carrier is the key `promptSuggestions` at the top level of `_meta` of a `session_info_update` without a title.
This is a key that Air reads already (`SessionMetadataMapper.kt` of Air and its spec
`plugins/air/spec/session-view/prompt-suggestions.spec.md`). It is not an extension of Megachat, so it needs no
change in Air, and it has no capability. Megachat sends it to each client. A client that does not know the key ignores
it by the rules of ACP. `promptSuggestionUpdate` in `src/Suggestions.mjs` is the only code that builds it.

```json
{
  "sessionId": "megachat-<UUID>",
  "update": {
    "sessionUpdate": "session_info_update",
    "_meta": { "promptSuggestions": { "suggestions": [{ "text": "Run the tests and fix the failures" }] } }
  }
}
```

- Air shows the first text that is not blank as grey text in the empty prompt input of the session. Tab puts the text
  into the input. Typing hides it. Air does not show it while a turn runs.
- A withdrawal is the same update with an empty list, `{ "suggestions": [] }`. Air then removes the stored text.
- The wire has no ID, no turn and no expiry time. The daemon keeps them, for the withdrawal and the expiry timer.
- Air reports no accept. Each prompt of the user while a suggestion is live records `ignored` in the daemon, and
  `ignored` changes no counter.
- Megachat sends the suggestion after the last `agent_message_chunk` of its turn and before the response of
  `session/prompt`. A suggestion of an automatic turn arrives without a prompt of the view.
- Each turn has at most one suggestion. A delegation acknowledgment, a stopped turn and a failed turn have none.
- Megachat withdraws a sent suggestion at the start of the next turn, at a `session/cancel` while no turn runs, and at
  the expiry time, one hour after the proposal. After a request for silence, the agent gives no new suggestion.
- A transcript replace in Air removes the stored text. So `session/new` and `session/load` send a live suggestion again
  after the replay and the title. They send no old one.
- Megachat sends no `pending` flag. Air then shows its idle hint until the suggestion arrives.
- A suggestion is not permission. Megachat starts the work only when the prompt arrives.

## The background tasks

Megachat sends these updates through `session/update` only when Air sent `asyncTasks`.

| Update | Fields | What Air does |
|---|---|---|
| `async_task_spawned` | `asyncTaskId`, `name`, `taskType`, `showInTranscript`, `description`, `canStop`, `outputFilePath` | Air lists the task in the Background Tasks tab of the chat. The session row shows work until the last task ends. |
| `async_task_state_update` | `asyncTaskId`, `state` | Air ends the task. `state` is `completed`, `failed` or `stopped`. |

- `asyncTaskId`, `name`, `taskType` and `showInTranscript` are required.
- Megachat sends one task for each unfinished child run. `name` is the title of the task. `description` gives the
  agent (`Claude`, `Codex` or `Pi`), the project and the phase. `taskType` is `agent`, `showInTranscript` is `false`, and `canStop` is `true`.
- The ID is `<run ID>:<phase>`. The phase is `queued`, `resuming`, `approval` or `running`. A change of the phase ends
  the task of the old phase with `completed` and sends a new task.
- A run that ends gives `completed` when it completed, `stopped` when the user cancelled it, and `failed` otherwise.
- Megachat also sends a task for a pass of the import of past sessions, with the same updates and fields. This is a
  second use of the updates, and Air needs no change for it. `name` is "Index of past sessions", and `description`
  gives the count of the imported files and of all the files of the pass. `canStop` is `false`. The other fields are as
  for a child run.
- The ID of that task is `sessions:<pass>:<step>`. The step is the tenth of the files that the pass imported. A new
  step ends the task of the old step with `completed` and sends a new task, as a change of the phase does. So the chat
  shows the progress, and one pass gives at most eleven tasks. The end of the pass ends its last task with `completed`.
- Air treats a task type other than `turn` as ordinary background work. Air accepts a task while no prompt runs.
- Air drops a second `async_task_spawned` with the ID of an open task. Air fails each open task when a new agent
  process connects. So Megachat forgets its sent tasks on each attach and sends them again.

## The transcript of a child run

This is a field that Air of today reads. It is not an extension of Megachat, and it needs no change in Air.

- Air reads `outputFilePath` in `async_task_spawned`, `async_task_progress` and `async_task_state_update`, and the
  first value of a task stays (`AcpSessionRuntimeFacts.kt`, `SessionAsyncTaskReducer.kt`). A task with the field has
  a title that is a link (`AsyncTaskOutputEditorSync.kt`, `hasInspectableOutput`).
- A click on the title opens the file in an editor of the IDE, through the file open service of Air, when the path
  resolves to a local file (`AsyncTaskOutputEditorSync.kt`, `findAttachedAsyncTaskOutputFile`). Air does not limit the
  path to the project. When the file does not resolve, Air opens its own transient editor with the name, the state and
  the description of the task.
- The editor of the file depends on the extension. Air opens a `.md` file in the rendered Markdown preview by default.
  So Megachat writes plain text with the extension `.txt`: a preview could load an image from an address in the text
  of a child. The transient editor of Air is plain text too.
- Air refreshes the file one time when it opens it. Air does not follow the file while it grows. The IDE reloads an
  open file at its own refresh of the file system, for example when its window gets the focus again.
- Megachat sends `outputFilePath` in the row of a run in the phase `running` or `approval`. The path is
  `transcripts/<run ID>.txt` in the state directory. A queued row has no file yet, so it sends none. A row ends when
  its run ends, and Air keeps no ended task in the Background Tasks tab. So the transcript opens from the chat only
  while the run is unfinished.
- Megachat sends no `async_task_progress`. With an attached file, Air shows the file and not the progress. The row
  shows the `description` of the spawn, and Air keeps each progress update in its session log.

## The Stop of a row

This is a request that Air of today sends. It is not an extension of Megachat, and it needs no change in Air. The
guide `plugins/air/docs/guides/acp-async-tasks-guide.md` of Air describes it.

- Air reads `canStop` only in `async_task_spawned`, and only the value `true` gives the task a Stop
  (`AcpSessionRuntimeFacts.kt`, `mapAsyncTaskSpawned`). The row shows Stop while the task is `running` or `paused`
  (`AsyncTaskListRow.kt`).
- A click sends `_session/async_task/stop` with the session ID of the view and the ID of the row
  (`AcpProtocolSession.kt`, `stopAsyncTask`). Air accepts the stop only for a result with `stopped: true`. A result
  `false`, and an error answer, restore Stop and show a status message. After an accepted stop, the row shows
  "Stopping…" until the terminal update of the task arrives. Air does not end the task by itself.
- Megachat takes the run ID from the ID of the row, `<run ID>:<phase>`, so a stop that comes during a change of the
  phase stops the same run. The daemon cancels the run through `/child/stop`, as `agents_cancel` cancels it, also while
  no turn runs. A queued run ends at once. A run that runs gets a cancel of its turn, and its pending permission
  requests become stale. The run gets no continuation. Then the row ends with `stopped`, and the main agent gets the
  result `cancelled` in a turn of its own.
- The answer is `{ "stopped": false }`, and nothing changes, for a run that ended, an unknown run, a row of another
  kind (the import of past sessions), an unknown session, a client that did not send `asyncTasks`, and a daemon of an
  earlier build without the route.
- Air hides the Background Tasks tab while a permission request shows in the composer
  (`AirFollowUpQueueTabbedPanel.kt`, `setHiddenForSecurityApproval`). So a view that shows the permission request of a
  child shows no Stop until the request closes. Megachat handles the stop of such a run all the same, for example from
  another view.

## The replay

Megachat replays the conversation on `session/new` and on `session/load`. Each replayed update has
`loadSessionReplayIndex` in its `_meta`. The last update of the replay also has `loadSessionReplaySize` and
`loadSessionEndOfRecordedHistory: true`. After the replay, Megachat sends `session_info_update` with the title.

## The reply stream

Megachat sends the text of the main agent as `agent_message_chunk` with the ACP field `messageId`. Air appends a chunk
to the message with the same ID, and a new ID starts a new message. This needs no change in Air.

| Message ID | Chunks |
|---|---|
| `megachat-reply-<task>-<attempt>` | The text of one model request while the model writes it, in parts. The entry of that reply then adds only the text that the parts did not hold. |
| `megachat-entry-<entry>` | The text of an entry that the view did not get as a stream: each replayed entry, and each reply with `MEGACHAT_STREAM=0`. |
| `megachat-notice-<turn>` | The notice of a reply that failed. |

- A chunk of a stream has no `loadSessionReplayIndex`. It can arrive without a prompt of the view: for a turn of another
  view, for an automatic turn, and after a replay for a view that connects in the middle of a reply.
- Air has no update that replaces or removes a sent chunk. So Megachat only appends. A reply that stops in the middle
  keeps its partial text, and the same text is in its entry. When an entry does not start with the sent text, Megachat
  sends the entry as a second message with the ID `megachat-entry-<entry>`.
- A partial text without an entry stays in the open chat, and the next replay does not show it. This can occur when the
  daemon stops in the middle of a reply.
- Megachat sends no `agent_thought_chunk`.
- Megachat sends at most 20 chunks of a stream in a second.

## The permissions

Megachat sends each pending permission request of a child through `session/request_permission` in the main session.
The `toolCallId` is the ID of the permission record. The title names the agent. Megachat gives the selected option
to the daemon. A request stays pending in the daemon when no client is connected.

## The stop dialog

The tool `agents_stop` of the main agent sends a signal only after an answer of the user in this dialog. The main agent
cannot answer it. Megachat uses the base request `session/request_permission` and the presentation key
`_meta.jetbrains.air.permission` (version 1) that Air of today reads. It needs no change in Air.

```json
{
  "sessionId": "megachat-<UUID>",
  "toolCall": { "toolCallId": "megachat-stop-<request ID>", "title": "Stop 2 agent processes with SIGTERM?",
    "kind": "execute", "status": "pending", "rawInput": { "command": "PID 4242: Claude Code, project demo-app\nPID 4243: Codex, project demo-tool" } },
  "options": [
    { "optionId": "stop", "kind": "allow_once", "name": "Stop these processes", "_meta": { "jetbrains": { "air": { "permission": { "version": 1, "description": "..." } } } } },
    { "optionId": "keep", "kind": "reject_once", "name": "Do not stop", "_meta": { "jetbrains": { "air": { "permission": { "version": 1, "description": "No signal goes out." } } } } }
  ],
  "_meta": { "jetbrains": { "air": { "permission": { "version": 1, "title": "Stop 2 agent processes with SIGTERM?", "description": "..." } } } }
}
```

What Megachat builds on, from the code of Air:

- Air takes the title and the description of the dialog from `_meta.jetbrains.air.permission` of the request, only
  with `version` 1 (`AcpPermissionPresentation.kt`). The title is one line, and Air cuts it at 240 characters. The
  description can have lines, and Air cuts it at 240 characters too. A tooltip shows the full text
  (`AirConfirmationHeaderView.kt`). The description of an option is the second line of that option.
- Air shows `rawInput.command` in a code viewer of the dialog: 5 rows, then a scroll and an expand action
  (`ToolRepresentationSelector.kt`, `AirConfirmationContentView.kt`). So the list of the processes is there, one line
  for each process: the PID, the agent and the base name of the project directory. A tool call without a command and
  with the kind `other` would show no body.
- Air sorts the options by kind and selects the first `allow_once`. Esc selects the first `reject_once`
  (`AirConfirmationActionsView.kt`). So Enter selects the stop. The only code of Air that selects an option is the
  answer of the user in the dialog, or in a mobile client (`respondApproval` in `AcpSessionRuntimeOwner.kt`). Air keeps
  no `allow_always` decision for a later request.
- A request of the turn that the view runs belongs to that turn. Air closes it with `cancelled` at the end of the turn
  and at a Stop of the user. A request that arrives while the view runs no turn belongs to the connection, and it stays
  until an answer (`AcpSessionRuntimeOwner.kt`).
- Air closes a dialog with `cancelled` when the agent sends a final `tool_call_update` (`completed` or `failed`) for
  its `toolCallId` (`AcpSessionRuntimeOwner.kt`, "Tool call finished before user decision").

What Megachat does:

- The daemon keeps each stop request in its memory, not in the state, and sends the open requests and the status of
  the last closed requests to each client in the event `stops` of `/events`. A client of an earlier build ignores the
  event, so it shows no dialog, and the request expires.
- The bridge sends the request to each view. The answer `selected` goes to the daemon through `/stop/answer`. The
  answer `cancelled` sends nothing.
- Only the first answer counts. When a request closes, the bridge sends a final `tool_call_update` for it to each view
  that showed it: `completed` after the answer `stop`, `failed` else. So Air removes the dialog of the other views.
  The daemon refuses each later answer, also one that comes before that update, and it sends no signal.
- The main agent waits in the turn for the answer, at most 5 minutes. In the view that sent the prompt, the dialog
  belongs to the turn, so a Stop of the turn closes it, and the daemon closes the request.

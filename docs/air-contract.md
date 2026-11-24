# The contract with Air

Megachat is an ACP agent. Air is the ACP client in the JetBrains IDEs. This file lists each ACP extension that the two
sides exchange, the side that sends it, and what the other side does. `src/AcpBridge.mjs` holds the Megachat side.

A change of an extension needs the same change in Air. Change this file in the same commit.

## The agent identity

- The `acp.json` entry of the user has the name `Megachat`. Air derives the agent ID `acp.megachat` from that name.
- Air shows the Gothic M icon for the agent `acp.megachat`. Before the user adds a Megachat, Air shows the button
  "Spawn Megachat" in the place of the first row of the session list, and it starts no command of the entry. After the
  add, the session of the Megachat of the IDE is the first row of the session list. See "The scopes of Megachat" below.
- An IDE build without the Air support for Megachat starts it as an ordinary custom ACP agent. That build sends no
  capability, so Megachat sends no `_workspaces/list` and no `_session/service/record`. Nobody tested that case.
- Megachat gives the agent name `air-megachat` in `agentInfo`, and the version of the build. A release copy gives the
  version of `package.json`, such as `0.4.0`. A git checkout after a release tag adds SemVer build metadata, such as
  `0.4.0+3.g1a2b3c4`. The field stays a free string for Air to show or log.
- Megachat accepts the session IDs `megachat` and `megachat-<UUID>`. `session/new` gives a new `megachat-<UUID>`.

## The capabilities

Both sides put their capabilities in `_meta.jetbrains.air` of `initialize`, as `{ "version": 1, "capabilities": [...] }`.
Megachat reads the list of Air only when `version` is 1 or more.

| Capability | Sender | What the other side does |
|---|---|---|
| `asyncTasks` | Air | Megachat sends its child runs as background tasks. Megachat also sends `asyncTasks` back. |
| `asyncTaskSessions` | Air | With `asyncTasks`, Megachat sends `session` in the rows of the Claude, Codex and Junie runs. Megachat does not send it back. See "The session of a child run" below. |
| `serviceSessions` | Air | Megachat records each delegated session with `_session/service/record`. |
| `workspaces` | Air | Megachat asks for the open projects with `_workspaces/list`. |
| `persistentSession` | Megachat, always | Air sends no `session/cancel` and no `session/close` when it releases the runtime. Air loads the session again on each attach. Air sends `clientMessageId` with each prompt. |
| `htmlFence` | Air (read only, no Air release sends it yet) | Air draws an `air-html` code fence of a reply as a page. Megachat gives the page rules to the main agent (setting `chat.html`). Until Air sends the name, `auto` takes each client with `version` 1 or more. The daemon keeps the answer of the last view that attached. See "The pages in the chat" below. |
| `asyncTasks` | Megachat, when Air sent it | Air lists the background tasks of the session. |
| `agentStop` | Megachat, always | Air can send `_agent/stop` for the action "Remove Megachat". A release without the capability does not know the request. See "The removal of a Megachat" below. |
| `projectScope` | Megachat, only in a project scope | This Megachat belongs to the project of `MEGACHAT_PROJECT`. Air checks it for each process that it started with the variable. See "The scopes of Megachat" below. |

## The requests

| Method | Sender | Parameters | What the other side does |
|---|---|---|---|
| `_workspaces/list` | Megachat | `{}` | Air returns `directories`: the trusted open project directories. Megachat registers each one in the daemon, and skips a directory that the daemon cannot read. Megachat asks on each attach and every 15 seconds while a view is open. |
| `_session/service/record` | Megachat | `agentId`, `sessionId`, `cwd` | Air hides that session from the session list. `agentId` is `claude`, `codex` or `junie`. `sessionId` is the session of the provider. A pi child has no session file of Claude Code, Codex or Junie, so Megachat sends no record for it. |
| `session/request_permission` | Megachat | `sessionId`, `toolCall`, `options`, `_meta.jetbrains.air.permission` | Air shows the request of a child, and the stop request of the main agent, as a permission dialog. See "The permissions" and "The stop dialog" below. |
| `_session/async_task/stop` | Air | `sessionId`, `asyncTaskId` | Megachat cancels the child run of that row, and no other work. It answers `{ "stopped": true }` when it accepted the stop, and `{ "stopped": false }` for each other case. Then the row ends with its terminal update. See "The Stop of a row" below. |
| `_agent/stop` | Air | `{}` | Megachat stops its daemon when no turn and no child run is in work, answers `{ "stopped": true }`, and ends the ACP connection. Else it answers `{ "stopped": false, "reason": "<text>" }`, and nothing changes. See "The removal of a Megachat" below. |
| `session/set_config_option` | Air | `sessionId`, `configId`, `value` | Megachat stores the choice of the model (`configId` `model`) or of the reasoning level (`thought_level`) of the main agent. It answers with the full `configOptions`. A value that is not in the list, and each other `configId`, get the error `-32602` with a text. See "The model and the reasoning level" below. |

Megachat sends `_session/service/record` once for each attach, for each address in the `serviceSessions` map of the
daemon state. The daemon adds an address when a delegated run gets its provider session, and it keeps the address
after it drops the run. A run that continues an existing session of the user is not a service session: that session
stays in the session list. A new child session in a directory where `children.showInProject` is `true` (the default) is not a
service session either. Megachat records no address of it, so Air shows it in the session list of its project. Air
keeps the service origin of a session that Megachat recorded before, so the setting does not show that session. The record on each attach lets a second product, or a new Air state, hide the earlier
delegated sessions too.

Megachat sends the records one after the other, before the view is ready. The map keeps at most 5,000 addresses, so
one attach can send 5,000 requests. Nobody measured that time in Air. `docs/roadmap.md` has the change.

## The scopes of Megachat

A Megachat has the machine scope or a project scope (see the capability `project-scope`). The entry `Megachat` of
`acp.json` is the same for both. The scope is a property of the process that Air starts.

- **No Megachat before the user adds one.** Megachat starts nothing by itself. Air starts no command of the entry, and
  shows no session row of Megachat, before the user adds a Megachat with "Spawn Megachat". Air keeps the record of the
  added Megachats in its own state. A stored application session of a present user counts as an added Megachat.
- **The Megachat of the IDE.** The button "Spawn Megachat" in the place of the first row adds it. Air starts the command
  of the entry as it is, and it creates the application session in the workspace of Megachat, as before.
- **The Megachat of a project.** The action "Spawn Megachat" in the menu of a project row or of a folder row of Agent
  Sessions adds it. Air starts the command of the entry with the variable `MEGACHAT_PROJECT` set to the absolute path
  of the directory, added to the environment of the entry. Each project needs a process of its own, because one `acp`
  process has one daemon and one conversation. Air sends `session/new` with that directory as `cwd`, and it shows the
  session as the first row of that project.
- **The check of the scope.** A release of Megachat before this contract ignores the variable and opens the
  conversation of the machine. So Air reads `projectScope` in the answer of `initialize` of each process that it
  started with the variable. Without the capability, Air closes the connection and tells the user to update Megachat.
- **A refused directory.** For a value that names no project directory, `acp` writes one line to its error output,
  "MEGACHAT_PROJECT names no project directory: <value>. ...", and exits with the code 1 before it answers
  `initialize`. Megachat refuses a relative path, a file, the root, the home directory and each directory that holds
  it, the application data and the hidden directories directly in the home directory, and the state directory of
  Megachat.
- **What changes in a project scope.** The session IDs, the title "Megachat", the replay, the background tasks and the
  permissions are the same. Megachat registers only the `cwd` of `session/new` and the directories of
  `_workspaces/list` that are the project directory, a directory in it, or a linked git worktree of it. It ignores
  each other directory. So the rows of the background tasks name only a `cwd` of the project.
- **The state.** Megachat keeps the state of a project scope in `projects/<name>-<digest>` in its state directory.
  Air does not read or write it. `application_workspace` of the entry has no effect on a project scope.

## The removal of a Megachat

The action "Remove Megachat" of Air, for the Megachat of the IDE and for the Megachat of a project. Megachat announces
`agentStop`, and Air sends `_agent/stop` with the parameters `{}` on the connection of that Megachat. The request names
no session: one `acp` process has one daemon. When Air has no connection to that Megachat, it starts the command of the
entry first (with `MEGACHAT_PROJECT` for a project), and then sends the request.

- **Without work.** When no turn runs and each child run is in a terminal state, the bridge stops its daemon and waits
  for the end of the daemon process, at most 30 seconds. Then it answers `{ "stopped": true }`, writes the line
  "Megachat stopped its daemon at the request of the IDE, ..." to its error output, ends the ACP connection about 100 ms
  after the answer, and exits with the code 0. Air then removes the row and shows "Spawn Megachat" again.
- **With work.** The answer is `{ "stopped": false, "reason": "<text>" }`, for example "Megachat has work that runs: a
  turn and 2 child tasks. Stop the work or wait for its end, then remove Megachat again." The daemon and the connection
  stay as they are. Air shows `reason` and keeps the row. Air can first send `session/cancel` and
  `_session/async_task/stop` for each row, behind a question to the user, and then send `_agent/stop` again.
- **A daemon that does not end.** After 30 seconds, the answer is `{ "stopped": false, "reason": "<text>" }` with the
  process ID of the daemon, and the connection stays open.
- **The state stays.** Megachat changes and deletes no file of the state directory but the connection file of the
  daemon. A new "Spawn Megachat" starts a daemon on the same state directory, so the user gets the same conversation,
  settings and memory. Megachat keeps no record of the removal.
- **The other clients.** Each other `acp` process of that daemon ends when its daemon is gone, as after each other stop
  of the daemon. So a second window or a second IDE loses its connection. An IDE that still has the Megachat in its
  record starts the command again at its next attach, and that start starts a daemon again. The removal is a state of
  one IDE.
- **A release without `agentStop`.** Air sends no `_agent/stop`. It removes only the row, and it tells the user that
  the daemon continues to run until the command `stop`.

## The prompt

- Air sends `clientMessageId` in `_meta.jetbrains.air` of `session/prompt`. Megachat uses it as the request ID of the
  input. A repeated ID returns the first admission, so a retry of Air admits the message once.
- `session/cancel` cancels the current main task and each child that it owns. While no turn runs, it withdraws the
  prompt suggestion that the view showed.
- Megachat announces `agentCapabilities.promptCapabilities.image: true` in the answer of `initialize`. It accepts the
  content blocks `text`, `resource_link` and `image` in `session/prompt`. The main agent gets each link as the Markdown
  link `[name](uri)` on a line of its own, in the order of the blocks, and each `image` block (PNG, JPEG, GIF or WebP)
  as an image. Megachat refuses each other block type. The input of the main agent has at most 100,000 characters of
  text, with the links.
- A client that announces no image support, or an older Air, writes the attachment into the text, as `@path` and as
  `![Image](<path>)`. Megachat reads an existing image file from such a path under the home directory of the user, and
  gives it to the main agent as an image. The text stays as it is.
- At most 4 images go with one prompt, and one image has at most 4.5 MB of base64. Megachat skips a larger or
  unreadable image and adds a note line to the text. A request to the model holds only the images of the last 3
  messages that have images.

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
| `async_task_spawned` | `asyncTaskId`, `name`, `taskType`, `showInTranscript`, `description`, `canStop`, `outputFilePath`, `session` | Air lists the task in the Background Tasks tab of the chat. The session row shows work until the last task ends. |
| `async_task_progress` | `asyncTaskId`, `session` | Air keeps the session of the task. Only a client with `asyncTaskSessions` gets it. See "The session of a child run" below. |
| `async_task_state_update` | `asyncTaskId`, `state` | Air ends the task. `state` is `completed`, `failed` or `stopped`. |

- `asyncTaskId`, `name`, `taskType` and `showInTranscript` are required.
- Megachat sends one task for each unfinished child run. `name` is the title of the task. `description` gives the
  agent (`Claude`, `Codex`, `Junie` or `Pi`), the project and the phase. `taskType` is `agent`, `showInTranscript` is `false`, and `canStop` is `true`.
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
- A click on the title opens the file only for a row without `session`, or when Air cannot open the session (see "The
  session of a child run" below).
- Megachat sends no `async_task_progress` other than the one that gives the session of a row. That update holds only
  `asyncTaskId` and `session`. With an attached file, Air shows the file and not the progress. The row shows the
  `description` of the spawn, and Air keeps each progress update in its session log.

## The session of a child run

This is an extension of Megachat. Megachat sends it only when Air sent `asyncTasks` and `asyncTaskSessions`.

- The field `session` is `{ "agentId", "sessionId", "cwd" }`, the same address as the parameters of
  `_session/service/record`. `agentId` is `claude`, `codex` or `junie`, `sessionId` is the session of the provider, and
  `cwd` is the absolute directory of the run. `junie` is the agent ID of Junie in Air (`ProductDefaultAgents.kt`).
- A Junie run has a session of Junie: Junie keeps it in `~/.junie/sessions/<session ID>`, and Air lists it as a Junie
  session of the project. With the consent `sessions.index`, the session tools of Megachat read it from its event log.
- The row of a Claude, Codex or Junie run holds `session` in each phase (`queued`, `resuming`, `approval`, `running`) when the
  daemon knows the session at the spawn of the row. So the row of a follow-up (`agents_send`) and of a continued
  session of the user (`agents_resume`) holds it from its first update. A queued row holds `session` and no
  `outputFilePath`.
- A new child gets its provider session when the adapter answers `session/new`, after the spawn of its row `running`.
  Then Megachat sends one update:

  ```json
  { "sessionUpdate": "async_task_progress", "asyncTaskId": "<run ID>:running",
    "session": { "agentId": "claude", "sessionId": "<provider session>", "cwd": "/abs/project" } }
  ```

  The update holds no `description`, `summary`, `lastToolName`, `usage` or `outputFilePath`, so the row keeps its look.
  Megachat sends at most one such update for a row.
- On each attach, Megachat sends each unfinished row again, with `session` when the daemon knows it, and then one
  `async_task_progress` with `session` for each such row. Air can keep an open task from before the attach and drop the
  second spawn, and the progress still gives it the session. Air keeps the first value of a task.
- A pi run gets no `session`: its provider session is a conversation of the harness, not a session of Claude Code,
  Codex or Junie. The row of the import of past sessions gets no `session`. A client without `asyncTaskSessions` gets no
  `session` and no `async_task_progress`.
- A new child with `children.showInProject` `false` runs in a service session that Air hides. Its row holds `session`
  all the same, and Air decides how to open it.
- What Air does: it reads `session` in `async_task_spawned` and `async_task_progress`, and it keeps the first value of a
  task, as for `outputFilePath`. The title of a row with `session` is a link. A click opens that session in Air and
  selects it in the sessions tree. When the session is not in the list of Air yet, Air waits a short time, because
  Claude Code writes the session file at the first prompt. When the open fails, Air opens `outputFilePath`.
- Open for Air: the open of a hidden service session.

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
  result `cancelled` in a turn of its own. The stop closes the permission requests of the run at once: each view that
  shows the dialog of such a request gets the final `tool_call_update` with `failed`, and Air removes the dialog. See
  "The permissions".
- The answer is `{ "stopped": false }`, and nothing changes, for a run that ended, an unknown run, a row of another
  kind (the import of past sessions), an unknown session, a client that did not send `asyncTasks`, and a daemon of an
  earlier build without the route.
- Air hides the Background Tasks tab while a permission request shows in the composer
  (`AirFollowUpQueueTabbedPanel.kt`, `setHiddenForSecurityApproval`). So a view that shows the permission request of a
  child shows no Stop until the request closes. Megachat handles the stop of such a run all the same, for example from
  another view or through `agents_cancel`. Then Megachat closes the dialog of the request in each view.

## The replay

Megachat replays the conversation on `session/new` and on `session/load`. Each replayed update has
`loadSessionReplayIndex` in its `_meta`. The last update of the replay also has `loadSessionReplaySize` and
`loadSessionEndOfRecordedHistory: true`. After the replay, Megachat sends `session_info_update` with the title.

## The reply stream

Megachat sends the text of the main agent as `agent_message_chunk` with the ACP field `messageId`. Air appends a chunk
to the message with the same ID, and a new ID starts a new message. Air reads each key of this section today, so it
needs no change.

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
- Each `agent_message_chunk` of the main session has `_meta.jetbrains.air.phase` with the value `final_answer` on the
  update object, live and in the replay: each message ID of the table above, and each note. The `_meta` of the
  `session/update` parameters gets no phase. At the end of a completed turn, Air folds each message before the last
  agent text into a closed block "Worked for", but not in a turn with a message that has a phase
  (`InferredWorkingGroupReducer.kt`, line 60, "An agent that sends phases groups its own work"). So no turn of Megachat
  folds, also in the replay, where Air ends each replayed turn as completed. Air ignores the phase of a live chunk after
  the end of the last prompt turn, such as the reply of an automatic turn, and it folds no such chunk.
- Megachat sends no phase `commentary`, because Air puts a message with that phase into an explicit block "Worked for".
- Megachat sends no `agent_thought_chunk`.
- Megachat sends at most 20 chunks of a stream in a second.

## The notes about the sessions that wait

This uses the updates of the reply stream above. It is not an extension of Megachat, and it needs no change in Air.

- With the setting `sessions.notes`, the daemon writes a note into the conversation when an agent session on the
  machine waits for the user for a long time. A note is an entry of the conversation with one message of the
  assistant, and no model request and no turn makes it.
- Megachat sends the note to each view at once as an `agent_message_chunk` with the message ID `megachat-entry-<entry>`,
  so it is a message of its own and never continues the message of a stream. The note has the phase `final_answer` of
  the reply stream above, so a turn with a note shows open, live and in the replay. No prompt of the view and no
  background task goes with it. The replay sends it again, as each other entry.
- Air takes a live update outside a prompt turn (`AcpSessionRuntimeOwner.kt`, `followBackgroundWorkEnd`), and the
  reply of an automatic turn of Megachat, such as a child result, comes to Air in the same way. Megachat sends no task
  of the type `turn` for a note.

## The model and the reasoning level

This uses the standard `configOptions` of ACP. It is no extension, and Air needs no change. Air finds the chooser of the
model by the category `model`, and the chooser of the reasoning level by the category `thought_level`. Air reads no
older `models` field and sends no `session/set_model`, so Megachat gives neither.

- `session/new` and `session/load` answer with `configOptions`, two `select` options. `model` has the category `model`,
  the value `provider/model ID` (such as `anthropic/claude-opus-5-5`) and the models Claude Fable, Opus and Sonnet of
  the registry without a date suffix, and the current model. `thought_level` has the category `thought_level` and the
  levels that the current model supports (for Claude Opus 5.5: `low`, `medium`, `high`, `xhigh`, `max`).
- `session/set_config_option` stores the value in the setting `coordinator.model` or `coordinator.thinking`, so the choice stays
  after a restart. The main agent uses it from its next turn (at the end of a turn that runs). The answer holds the full
  `configOptions`. A model that does not support the stored level gets the next level that it supports.
- Megachat sends `config_option_update` with the full `configOptions` to each open view after each change of the model or the
  level. This includes a change by the main agent with `agents_settings`, and an edit of `settings.json`.
- The settings of the children do not change.
- An older daemon has no route for the choice: the view then answers with no `configOptions`, and Air shows no chooser.

## The end of the agent for an update

This is no extension of Megachat, and no ACP message changes. It describes what Megachat expects from Air.

- With the setting `update.auto` on (the default), or at the request of the user to the main agent (the tool
  `agents_update`, after the reply of that turn), the daemon of a copy of the install line stops itself for a new
  release when no turn, no child task and no request waits. Each `acp` process then writes one line to its error output, "The Megachat
  daemon stopped for the update from <old> to <new>. The next start of Megachat installs it.", and exits with the code
  0. An `acp` process without an open view exits within about 1 minute after its daemon is gone, with the line "The
  Megachat daemon is gone".
- Each Megachat has its own daemon, and the daemons of one IDE run from one copy. They stop for an update together,
  and only when each of them has no work (see the capability `project-scope`). So the `acp` processes of the Megachat of
  the IDE and of each Megachat of a project end at the same time, each with the line above.
- An `acp` process never starts a daemon after its own start. So only the next start of the command of the entry,
  `npx -y github:ignatov/megachat#semver:x acp`, starts a daemon, and npx installs the new release first.
- Megachat expects Air to start the agent command again at the next attach or the next prompt, and to load the
  persistent session (`persistentSession`) again. Nobody checked this on an IDE build yet (`docs/manual-checks.md`,
  open checks). If Air does not start the agent again, that is a request to Air.
- After the update, the new daemon writes a note of Megachat on its own, with no prompt of the user: "Megachat updated
  from <old> to <new>.", and at most 4 lines of release notes (5 lines in all). It is a message of its own, as the notes
  about the sessions that wait, and it goes out when no turn runs. A view that is not connected gets it with the replay.
- On a fresh conversation with a pending setup, the daemon writes one note of Megachat on its own: "Welcome to Megachat." It
  offers the setup. The note of a project scope starts with "Welcome to Megachat for the project <name>.", and it says
  that this Megachat works only in that project. It is the same kind of note, and it comes once. The first prompt of the user drops it.
- Each of these notes has the phase `final_answer` of the reply stream above. A live note that comes when no prompt
  turn runs shows open as before. In the replay, the note joins the turn before it, and the phase keeps that turn open,
  outside a block "Worked for".

## The permissions

Megachat sends each open permission request of a child through `session/request_permission` in the main session.
The `toolCallId` is the ID of the permission record. The title names the agent. Megachat gives the selected option
to the daemon. A request stays pending in the daemon when no client is connected. This needs no change in Air.

A request is open while the daemon takes a new answer for it: the request is pending, and its run exists, has the
generation of the request, has no stop request, and is not in a terminal state (`permissionOpen` in
`src/MegachatState.mjs`). When a request that a view showed is no longer open, the bridge sends one final
`tool_call_update` for its `toolCallId` to that view:

```json
{ "sessionUpdate": "tool_call_update", "toolCallId": "<permission ID>", "status": "completed" }
```

The status is `completed` after an answer, when the user of this view gave no answer or gave the answer that counts.
It is `failed` when the run stopped, ended or changed its generation before an answer, when the state dropped the
request, and when the user of this view gave an answer that did not count. A view that attaches after the request
closed gets no dialog and no update of the request.

When Air answers `cancelled` to a request that is still open, the bridge sends nothing to the daemon, and it sends the
same `session/request_permission` again, with the same `toolCallId`, to that view. It sends it 2 seconds after the
answer, and only when no prompt of the view runs. The bridge first reads the last state: when a Stop of the child or an
answer in another view closed the request, it does not send the request again. After its final `tool_call_update`,
the bridge never sends the request again. When Air answers `cancelled` again sooner than 2 seconds after the request,
the bridge doubles the wait for that request, up to 60 seconds.

What Megachat builds on, from the code of Air:

- Air puts the `toolCall` of the request in the chat as a tool call entry, with the approval on it
  (`AcpSessionRuntimeFacts.kt`, `PermissionRequested`). So the entry stays after the dialog closes.
- Air closes a dialog that waits for the user when a final `tool_call_update` (`completed` or `failed`) for its
  `toolCallId` arrives. It records the approval as expired with the reason "Tool call finished before user decision",
  and it answers the request with `cancelled` (`AcpSessionRuntimeOwner.kt`, `admitProtocolNotification`;
  `AcpClientOperations.kt`, `resolvePendingPermissionForTerminalToolUpdate`). The bridge does not send the request
  again after this `cancelled`.
- Air binds a request that arrives during the prompt turn of the view to that turn. When the turn ends, Air expires
  the request and answers it with `cancelled` ("Prompt turn ended before user decision",
  `AcpSessionPromptTurnExecutor.kt`, `finishPromptInput`; `AcpSessionRuntimeOwner.kt`, `ExpirePendingPermissions`).
  A Stop of the user cancels each pending request, also a request of the connection (`cancelPendingPermissions`).
  But the child still waits. So the bridge sends the request again after the prompt response. Air binds a request that
  arrives while no prompt runs to the connection, and the end of a later turn does not expire it.
- Air refuses a request at once with `cancelled` while the end of its turn runs, and it then shows a warning row
  about the cancelled request (`AcpSessionLiveState.kt`, `acceptsRootConnectionInput`;
  `AcpPromptInputRefusalNotices.kt`). The wait of 2 seconds lets Air complete the end of the turn first, and the
  doubled wait keeps a refused request from a loop.
- The step status of the entry follows the approval first (`ThreadGuiSnapshotMapper.kt`, `toThreadGuiStepStatus`). An
  expired approval shows as cancelled, and a refused approval shows as rejected, whatever the status of the tool call
  is. Only an allowed approval, or an option of an unknown kind, shows the status of the tool call. So the status of
  the update matters only in a view where the user answered: `completed` for the answer that counts, and `failed` for
  an answer that came too late. The other views show the entry as cancelled.
- Air ends a pending approval one time only, in its actor: by the answer of the user, or by the update. An update
  that arrives after the answer finds no pending approval, so it only sets the status of the entry
  (`AcpSessionRuntimeOwner.kt`, `resolvePermission`, `abandonPermission`).
- The replay of Megachat holds no tool call. So a view that attaches later has no entry of a closed request.

The daemon stays the judge. When the answer and the update race, Air gives one of them the dialog. An answer that
wins in Air still goes to the daemon, and the daemon refuses it when the request is no longer open. The view then
shows `failed` for it. When the answer of the view reaches the bridge only after the bridge sent `completed`, the
entry of that view shows `completed` all the same.

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

## The pages in the chat

This is no extension. Air draws a code fence with the language `air-html` in the text of a reply as a page in a sandboxed
frame: no network, the colors of the IDE, a switch to the code, and an open in an editor tab. No ACP content type and no
tool belong to it. Megachat sends the fence as plain text in `agent_message_chunk`, also in the replay.

- The skill `air-html` of Air describes the fence. Megachat has a short copy of the rules in `resources/air-html.md`. It
  does not read the cache of Air at run time.
- Each view tells the daemon with its attach (`POST /client`) whether the client has the Air support. The daemon adds the
  rules to the instructions of the main agent when `chat.html` is `on`, or is `auto` and the last view that attached has
  the support. A child never gets the rules.
- Open for Air (the three points of the IJAI ticket): a capability `htmlFence` in `initialize`, whether a custom ACP agent
  gets `additionalDirectories` with the skill directory, and a public contract of the fence.

## The archive of a Junie session

- Air keeps the Done state of the Junie sessions in `~/.junie/sessions/agent-workbench-archive-state.jsonl`, next to
  `index.jsonl` of Junie (`JunieSessionSource.kt` and `JunieSessionIndex.kt` of Air). "Done" adds one line
  `{"sessionId","updatedAt","projectDir","archived":true}`, and a restore adds the same line with `archived` false.
  The state of a session is its last line for its session ID and its project directory. Air reads the new lines of
  the file when its size or its modification time changes.
- That file is the store of the native provider of the Junie rows, which reads `index.jsonl`. Air also has a provider
  of the ACP list, which reads `session/list` of the Junie of its ACP registry, and it prefers that provider when it
  knows the capabilities of that agent (`AgentSessionProviderRank.INDEXED_ACP`). For those rows, "Done" sends
  `_session/archive` (`AcpSessionIndexMutations.kt`), and Junie 4171 writes `{"archived":true}` to
  `session_metadata.json` of the session folder. Reopen sends `_session/unarchive`, and Junie writes `archived` false.
  Junie read the archive state file of Air only one time, for an import, and then wrote `air-archive-import-v1.done`.
  So the two providers can show one session in two states.
- `agents_archive` of Megachat writes both stores for a Junie session that no process runs, each one only when it does
  not tell the state already. The archive state file gets one whole line in one write with the append flag.
  `updatedAt` is the time of the write, or the `updatedAt` of the session when that is later. `projectDir` is the
  project directory of `summary.json` of the session folder, else of its line in `index.jsonl`, without a separator at
  its end. `session_metadata.json` gets the field `archived`, and its other fields stay: Megachat writes a temporary
  file and renames it, as Junie does. Megachat cannot take the lock of Junie on `session_metadata.json.lock`. Megachat
  adds no line to `index.jsonl`, and it changes no other line and no other file of Junie. A session counts as archived
  in Megachat when both stores tell `archived` true, also when Air wrote them.
- A Junie process of the ACP list reads `session_metadata.json` again at each `session/list`, and Air reads each list
  of a shown project again every 60 seconds (checked on 2026-11-24, see `docs/manual-checks.md`).
- Not checked in Air: whether Air hides and shows a session after a write of Megachat with each provider, and what Air
  does for a session of a linked git worktree (see the open checks of `junie-sessions` in `docs/manual-checks.md`).
- For Air: the native provider does not read `session_metadata.json`, and the Junie of the ACP list does not read the
  archive state file after its import. So "Done" in one provider does not hide the session in the other one.

## The archive of a session that has a thread of Air
Checked against the Air sources at `b819bcfd4b452` (`plugins/air`) on 2026-11-15.

- Megachat archives a Claude Code or pi session with the title records `[archived] ` in the log of the agent, and Air
  reads them (see "The hide, in the format of Air" in the change `session-archive`). A session that Air imported or
  started has its own thread in `<caches>/<IDE>/acp/projects/<hash>/threads/local%3A<id>/`, with `summary.json` and
  `events.jsonl`. `store.json` of the project holds the `projectDirectory`, and the hash can collide, so a reader matches
  `projectDirectory`. The thread names the agent session in `association.agentSessionId`.
- The archive state of such a thread is `summary.archived` when it exists, and else the state of the log of the agent
  (`AgentSessionCatalogEnrichment.kt`: `summary.archived ?: archived`). The summary mirrors the last event of
  `ThreadArchived`, `ThreadUnarchived` and `ThreadArchiveStateChanged` (`payload.archived`).
- Done in Air for such a thread is `StructuredSessionReplicaServiceImpl.setArchived`
  (`backend/session/catalog`): it waits for the projection, then calls `sessionLog.recordEvent` with the source `Ide` and
  the type `ThreadArchived` (`ThreadUnarchived` for a Reopen) and an empty payload, then waits for the projection of
  that sequence number and reports the change to the runtime.
- Megachat does NOT write that event, because it is not safe while the IDE runs:
  - The store has no lock, and Megachat found no file watch for the events file. It holds the next
    sequence number in memory (`StorageSessionState.nextSeq`, `SessionLogState.lastSeq`). A line that Megachat appends
    has a sequence number of the file, and the next event of Air takes the same number again. The log then has two events
    with one `seq`. A reader that sees a journal out of order folds it again in `seq` order, so the order of the events
    is wrong, and the tail reads of Air use offsets that it recorded itself.
  - Air keeps the projection of a thread in memory (`cachedProjection`) and does not read the file again. So it does
    not see an event that came from outside, and the next write of its own summary overwrites a `summary.archived` that
    Megachat wrote.
  - `StoredSessionLogImpl.eventsFileModified` is a cache too: the catalog does not see a file that changed outside.
- So Megachat hides such a session only through the log of the agent. Air takes that state on its next refresh of the
  list, only for a thread without its own `summary.archived`. The result of `agents_archive` has `air`
  (`hidden`, `still shown`, `no Air thread` or `unknown`) and `airHint`. A thread with `summary.archived: false` (the user
  reopened it in Air) or with a last event `ThreadUnarchived` shows `still shown`, and the hint says: press Done in Air.
  Megachat reads the store of Air to tell this, and it never writes it.
- Open for Air: a public way to archive a thread from outside, for example a command of the ACP extension or an event
  file that Air reads again. The text of the ticket is in `openspec/changes/session-archive/air-ticket.md` (not filed).

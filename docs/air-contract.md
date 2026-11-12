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
| `promptSuggestion` | Air | Air can show a prompt suggestion in the empty prompt input. Megachat sends the suggestions of the mode `ghost` of `reply.suggestions`. |
| `promptSuggestion` | Megachat, when Air sent it | Air reads the prompt suggestions of the session. |

## The requests

| Method | Sender | Parameters | What the other side does |
|---|---|---|---|
| `_workspaces/list` | Megachat | `{}` | Air returns `directories`: the trusted open project directories. Megachat registers each one in the daemon, and skips a directory that the daemon cannot read. Megachat asks on each attach and every 15 seconds while a view is open. |
| `_session/service/record` | Megachat | `agentId`, `sessionId`, `cwd` | Air hides that session from the session list. `agentId` is `claude` or `codex`. `sessionId` is the session of the provider. A pi child has no session file of Claude Code or Codex, so Megachat sends no record for it. |
| `_session/async_task/stop` | Air | `sessionId`, `asyncTaskId` | Megachat has no handler today, so it sends `canStop: false`. Air expects `{ "stopped": true }`. The task stays active until its terminal update. `docs/roadmap.md` has the change. |

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
- Air sends `acceptedPromptSuggestionId` in `_meta.jetbrains.air` of `session/prompt` when the user accepted a prompt
  suggestion. The value is the `id` of the suggestion. Megachat then records `accepted` without a model call. A prompt
  without the field, while a suggestion is live, records `ignored`. `ignored` does not count as a decline.
- Megachat accepts the content blocks `text` and `resource_link` in `session/prompt`. This is the base protocol: ACP
  requires these two types of each agent, and Megachat announces no other prompt capability. The main agent gets each
  link as the Markdown link `[name](uri)` on a line of its own, in the order of the blocks. Megachat refuses each other
  block type. The input of the main agent has at most 100,000 characters, with the links.

## The prompt suggestion

In the mode `ghost` of the setting `reply.suggestions`, the main agent gives one next step as a prompt of the user.
Megachat sends it only to a client that sent the capability `promptSuggestion`. The carrier is a hidden
`session_info_update` without a title. A client that does not know the extension ignores it by the rules of ACP.
`promptSuggestionUpdate` in `src/Suggestions.mjs` is the only code that builds it.

```json
{
  "sessionId": "megachat-<UUID>",
  "update": {
    "sessionUpdate": "session_info_update",
    "_meta": { "jetbrains": { "air": { "promptSuggestion": {
      "version": 1,
      "id": "suggestion-<UUID>",
      "turnId": "<request ID of the finished turn>",
      "text": "Run the tests and fix the failures",
      "expiresAt": "2026-11-12T12:00:00.000Z"
    } } } }
  }
}
```

| Field | Value |
|---|---|
| `version` | The version of the payload, 1. A change that an old client cannot read gets a new version. |
| `id` | The ID of the suggestion. The accepted prompt names it in `acceptedPromptSuggestionId`. |
| `turnId` | The request ID of the turn that made the suggestion: the `clientMessageId` of the prompt, or the ID of an automatic turn. |
| `text` | One line in the language of the user, about 80 characters at most. `null` withdraws the suggestion with this `id`. |
| `expiresAt` | The UTC time after which the suggestion is old: one hour after the proposal. |

- Megachat sends the suggestion after the last `agent_message_chunk` of its turn and before the response of
  `session/prompt`. A suggestion of an automatic turn arrives without a prompt of the view.
- Each turn has at most one suggestion. A delegation acknowledgment, a stopped turn and a failed turn have none.
- Megachat withdraws a sent suggestion at the start of the next turn, at a `session/cancel` while no turn runs, and at
  `expiresAt`. The withdrawal has the same `id` and the same fields, with `text: null`.
- `session/new` and `session/load` send a live suggestion again after the replay and the title. They send no old one.
- A suggestion is not permission. Megachat starts the work only when the prompt arrives.
- Air shows `text` as grey text in the empty prompt input of that session. Air does not show it while the input has
  text or while a turn runs. Which key accepts the text is a matter of Air.

## The background tasks

Megachat sends these updates through `session/update` only when Air sent `asyncTasks`.

| Update | Fields | What Air does |
|---|---|---|
| `async_task_spawned` | `asyncTaskId`, `name`, `taskType`, `showInTranscript`, `description`, `canStop` | Air lists the task in the Background Tasks tab of the chat. The session row shows work until the last task ends. |
| `async_task_state_update` | `asyncTaskId`, `state` | Air ends the task. `state` is `completed`, `failed` or `stopped`. |

- `asyncTaskId`, `name`, `taskType` and `showInTranscript` are required.
- Megachat sends one task for each unfinished child run. `name` is the title of the task. `description` gives the
  agent (`Claude`, `Codex` or `Pi`), the project and the phase. `taskType` is `agent`, `showInTranscript` is `false`, and `canStop` is `false`.
- The ID is `<run ID>:<phase>`. The phase is `queued`, `resuming`, `approval` or `running`. A change of the phase ends
  the task of the old phase with `completed` and sends a new task.
- A run that ends gives `completed` when it completed, `stopped` when the user cancelled it, and `failed` otherwise.
- Megachat also sends a task for a pass of the import of past sessions, with the same updates and fields. This is a
  second use of the updates, and Air needs no change for it. `name` is "Index of past sessions", and `description`
  gives the count of the imported files and of all the files of the pass. The other fields are as for a child run.
- The ID of that task is `sessions:<pass>:<step>`. The step is the tenth of the files that the pass imported. A new
  step ends the task of the old step with `completed` and sends a new task, as a change of the phase does. So the chat
  shows the progress, and one pass gives at most eleven tasks. The end of the pass ends its last task with `completed`.
- Air treats a task type other than `turn` as ordinary background work. Air accepts a task while no prompt runs.
- Air drops a second `async_task_spawned` with the ID of an open task. Air fails each open task when a new agent
  process connects. So Megachat forgets its sent tasks on each attach and sends them again.

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

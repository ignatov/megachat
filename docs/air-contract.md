# The contract with Air

Megachat is an ACP agent. Air is the ACP client in the JetBrains IDEs. This file lists each ACP extension that the two
sides exchange, the side that sends it, and what the other side does. `src/AcpBridge.mjs` holds the Megachat side.

A change of an extension needs the same change in Air. Change this file in the same commit.

## The agent identity

- The `acp.json` entry of the user has the name `Megachat`. Air derives the agent ID `acp.megachat` from that name.
- Air shows the Gothic M icon and the first row of the session list for the agent `acp.megachat`.
- An IDE build without that derivation reads `"application_session": true` in the entry instead.
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
| `_workspaces/list` | Megachat | `{}` | Air returns `directories`: the trusted open project directories. Megachat registers each one in the daemon. Megachat asks on each attach and every 15 seconds while a view is open. |
| `_session/service/record` | Megachat | `agentId`, `sessionId`, `cwd` | Air hides that session from the session list. `agentId` is `claude` or `codex`. `sessionId` is the session of the provider. |
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
- `session/cancel` cancels the current main task and each child that it owns.

## The background tasks

Megachat sends these updates through `session/update` only when Air sent `asyncTasks`.

| Update | Fields | What Air does |
|---|---|---|
| `async_task_spawned` | `asyncTaskId`, `name`, `taskType`, `showInTranscript`, `description`, `canStop` | Air lists the task in the Background Tasks tab of the chat. The session row shows work until the last task ends. |
| `async_task_state_update` | `asyncTaskId`, `state` | Air ends the task. `state` is `completed`, `failed` or `stopped`. |

- `asyncTaskId`, `name`, `taskType` and `showInTranscript` are required.
- Megachat sends one task for each unfinished child run. `name` is the title of the task. `description` gives the
  agent, the project and the phase. `taskType` is `agent`, `showInTranscript` is `false`, and `canStop` is `false`.
- The ID is `<run ID>:<phase>`. The phase is `queued`, `resuming`, `approval` or `running`. A change of the phase ends
  the task of the old phase with `completed` and sends a new task.
- A run that ends gives `completed` when it completed, `stopped` when the user cancelled it, and `failed` otherwise.
- Air treats a task type other than `turn` as ordinary background work. Air accepts a task while no prompt runs.
- Air drops a second `async_task_spawned` with the ID of an open task. Air fails each open task when a new agent
  process connects. So Megachat forgets its sent tasks on each attach and sends them again.

## The replay

Megachat replays the conversation on `session/new` and on `session/load`. Each replayed update has
`loadSessionReplayIndex` in its `_meta`. The last update of the replay also has `loadSessionReplaySize` and
`loadSessionEndOfRecordedHistory: true`. After the replay, Megachat sends `session_info_update` with the title.

## The permissions

Megachat sends each pending permission request of a child through `session/request_permission` in the main session.
The `toolCallId` is the ID of the permission record. The title names the agent. Megachat gives the selected option
to the daemon. A request stays pending in the daemon when no client is connected.

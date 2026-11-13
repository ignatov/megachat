# Design

## Context

See proposal.md, "Why". The present code of Megachat:

- `ReplyStream.observe()` in `src/ReplyStream.mjs` reads each view of the root conversation and sends the partial reply
  from `pi.live.generation.message` as the event `stream`. `DaemonServer` makes one `ReplyStream` for each event
  stream of a bridge.
- Pi Durable 1.5.1 keeps the current tool round in `pi.live.tools`: one slot for each call, in call order, from the
  tool-calling answer until the `tools` phase of the generation ends it (`LiveState.tools` in
  `@earendil-works/pi-durable/dist/harness/live.d.ts`). Each slot has `callId`, `name` and `status`.
- `AcpBridge` sends `agent_message_chunk` with the message ID `megachat-reply-<task>-<attempt>` for a stream, and
  `megachat-entry-<entry>` for an entry. Each model request has its own task, so the text after a tool round has a new
  message ID. The bridge knows its own prompt: `promptInFlight`, `promptRunId`, and `currentRunId` from the event
  `tasks`. It ignores an event type that it does not know.

What Air of today does with a `tool_call` of an agent with the ACP v1 (read-only, `plugins/air` of the IntelliJ monorepo, HEAD
`e9de692b3d125`):

- `tool_call` and `tool_call_update` become one event, merged by `toolCallId`
  (`backend/acp/src/events/AcpV1SessionUpdateConverter.kt:138-139, 234-268`). A call with a title or a kind shows,
  also with no content, no locations and no raw input (`shared/session.core/src/reducer/tool/ToolRepresentationSelector.kt:221-225`).
- The row is a generic tool row with the title as its text (`backend/session/view.gui/src/mapping/ThreadGuiSnapshotMapper.kt:1076-1094, 1562-1574`).
  `pending` and `in_progress` show as a running row with a shimmer (`ThreadGuiSnapshotMapper.kt:1606`). The kind
  `other` gives the generic icon. A kind `read` or `search` with locations becomes a row of viewed files, so the row has
  no locations.
- At the end of a prompt turn, Air gives each open call a final status: `end_turn` gives completed, a stop of the user
  gives canceled (`shared/session.core/src/reducer/tool/SessionTurnEndReducer.kt:127-128, 151-164`). A final status does not
  go back to running.
- After a completed turn, Air puts each entry of the turn before the last text after the last tool call into a
  collapsed "Worked for" block (`shared/session.core/src/reducer/tool/InferredWorkingGroupReducer.kt:22-89`). Today a
  turn with text before a tool call already gets that block, because the text before the tool call is a message of its
  own. A turn that ends on a tool call gets no block.
- The first tool event of a turn is a border of a message: a chunk with a new message ID after it opens a new message
  below the row, and a chunk with an earlier message ID goes back into the earlier message
  (`spec/core/session-projection-raw-tool-calls.spec.md:455-477`).
- Air keeps its own copy of each event. A `session/load` replay is used only for an import or a rebuild of a stale
  history (`backend/session/acp/src/AcpHistoryReplayMaterialization.kt:224-269`). So a row that Megachat does not replay
  stays in the chat of Air, and a rebuild removes it with no harm.
- `_meta.claudeCode.toolName` and `_meta.jetbrains.air` change the kind of a row
  (`backend/acp/claude/src/ClaudeProviderMetadataDecoder.kt:42, 54`), so the row has no `_meta`.
- An `agent_thought_chunk` shows as a "Thinking" row that does not end at the next text, only at a tool event or the end
  of the turn (`shared/session.core/src/reducer/tool/SessionStreamReducer.kt:30-35, 72-78`). A `plan` is no row of the chat.

## Goals / Non-Goals

**Goals:**

- A visible sign of work in the view that waits, from the start of a tool round to the next text of the reply.
- No change of the reply text, of its message IDs, of the entries, of the replay or of the state.

**Non-Goals:**

- A sign before the first tool round.
- A row in a view that does not wait for the turn.

## Decisions

### D1. The carrier is one ACP `tool_call` with a fixed title

The row is `{ sessionUpdate: "tool_call", toolCallId, title, kind: "other", status: "in_progress" }`, and its end is
`{ sessionUpdate: "tool_call_update", toolCallId, status }`. The title is the key `progress.tools` of
`resources/Megachat.properties`, "Megachat works with its tools".

Alternatives:

- `agent_thought_chunk`: Air shows "Thinking" and keeps it running until the end of the turn, also while the reply
  text streams. That is a wrong sign, and docs/air-contract.md says that Megachat sends none.
- `plan`: no row of the chat.
- One row for each tool with its name: the rows would show the names of the internal tools, which the chat hides on
  purpose, and a search tool can show the words of the user in its input.

### D2. The daemon sends the event `tools`

`ReplyStream.observe()` also reads `pi.live.tools`. When the list goes from empty to not empty, and at least one slot
has a name other than `agents_suggest` and `agents_feedback`, the stream publishes `{ type: "tools", value: { callId } }`
with the `callId` of the first slot. The two names are the tools that end a turn in the mode `ghost`
(`REPLY_RECORD_TOOLS` and `replyEnd()` in `src/PiMegachatService.mjs`, from b425557). In that mode, nearly each turn ends
with a round of `agents_suggest` after the reply text. A row in that round would come after the reply. Air then makes no
"Worked for" block, because the turn ends on a tool call, and the chat shows each earlier message of the turn and the
row below the reply. One exported constant holds the two names, so the filter and the end of the turn use one list. It publishes one event for each round and
no event for the end of a round: the bridge ends the row at the next text or at the end of the prompt. A bridge of an
earlier build ignores the event. A daemon of an earlier build sends no event, so a newer bridge shows no row.

With `MEGACHAT_STREAM=0`, `DaemonServer` makes no `ReplyStream`. Then the daemon sends no event `tools`, and the view
gets no row. This keeps the switch of the stream one switch.

### D3. The bridge owns the row

`AcpBridge` keeps `this.progress`, the ID of the open row, or `null`.

- On the event `tools`: when `promptInFlight`, `promptRunId` equals `currentRunId`, and `this.progress` is `null`, the
  bridge sends the row with the ID `megachat-tools-<callId>` and sets `this.progress`.
- Before each `agent_message_chunk` that it sends live (not in the replay), and before a notice of a failed reply, the
  bridge ends an open row with `completed` and sets `this.progress` to `null`. The change is in `notify()`, so each path
  of the text goes through it: a stream chunk, the rest of an entry, an entry as a message of its own.
- In `prompt()`, after `/wait` and the last `conversation()`, an open row ends with `completed` when the status is
  `completed`, and with `failed` for each other status. The `finally` block sets `this.progress` to `null`.

The events of the daemon go through `enqueue()`, so the row and the chunks keep the order of the events.

### D4. Disconnects, restarts and replay

The row is not in the state and not in the conversation, so the replay never sends it. A bridge that loses its daemon
ends the prompt with `cancelled`, and Air ends each open call of that turn. A daemon restart during a turn continues the
turn without a prompt of the view (run recovery). The new bridge then has no prompt, so it shows no row. The daemon
keeps the admitted work as today: this change adds no state.

### D5. No new field of a state file

The change reads `pi.live.tools`, which Pi Durable writes. It adds no field to `conversation.sqlite`, to
`settings.json` or to another state file.

## Risks / Trade-offs

- [Air groups the row with the text before the last reply into "Worked for"] → Air does that already for a turn with
  text before a tool call. The last reply stays visible. A turn whose only text comes after the tools gets a "Worked
  for" block with the row in it. That is new, and it holds no text.
- [A row stays running when the bridge cannot send its end] → Air ends each open call at the end of the prompt turn,
  and a lost daemon ends the prompt.
- [A turn that ends on a tool round of another tool, with no text after it] → The prompt response ends the row with
  `completed`. The row then stays below the reply, and Air makes no "Worked for" block for that turn. This is rare: a
  round of another tool continues the turn, and the model writes a text after its results.
- [A new tool that ends a turn in the mode `ghost`] → The filter and `replyEnd()` read one constant.
- [The title is in English only] → Each user-visible string is in `resources/Megachat.properties`, as today.
- [A later Air changes the look of a generic tool row] → The row has no content, so it stays a one-line row.

## Migration Plan

No migration. A rollback removes the row and keeps each other behavior.

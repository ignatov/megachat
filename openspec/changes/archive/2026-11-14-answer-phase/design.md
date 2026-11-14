# Design

## Context

The Air source is the IntelliJ monorepo at `e9de692b3d125` (2026-11-13). The paths are below `plugins/air/`.

- **The phase values.** `backend/acp/src/AcpAgentMessagePhaseDecoder.kt:25-36` reads
  `_meta.jetbrains.air.phase` from an `agent_message_chunk`. `commentary` is `Working`, `final_answer` is `Final`, and
  each other value is no phase. `AcpProtocolExtensions.kt:1025-1031` (`PHASE_KEY`): "`commentary` puts the chunk in a
  collapsible working group. `final_answer` closes that group and renders the chunk as the answer."
- **The explicit group.** `shared/session.core/src/reducer/tool/SessionStreamReducer.kt:160-181` (`messageGroup`): a
  `Working` message opens a group or joins the open group. A `Final` message takes the ID of the open group, or no ID
  when no group is open. A message with no group shows as a usual message. The UI treats a `Final` message specially
  only when it has the ID of the current group (`frontend/session/view.gui/src/ui/messages/MessageBlocksRouter.kt:235`).
- **The inferred group.** `shared/session.core/src/reducer/tool/InferredWorkingGroupReducer.kt:43-89` runs at the end
  of a turn. It makes no group when the turn is not finished (line 49), when the outcome is not `Completed` (line 50),
  when the turn has an explicit group (line 51), when **any** message of the turn has a phase or a group ID (line 60,
  "An agent that sends phases groups its own work, also in a turn without a working message"), when the last agent
  text comes before the last tool call (line 67), or when the turn has no work before its last agent text (line 68).
  The turn starts after the last user message (line 53).
- **The phase of a message.** `SessionStreamReducer.kt:117-127`: the message of a chunk gets the phase of the chunk,
  also with an ACP `messageId`. A late live chunk, after the end of the last prompt turn, does not set a phase
  (lines 135-142, 215-218). A chunk of a replay is never late.
- **The replay.** `backend/session/acp/src/AcpHistoryReplayMaterialization.kt:308-334`: a replay starts a turn only at
  a `user_message_chunk`, and it ends each replayed turn with the outcome `Completed`. So the inferred group applies to
  each replayed turn.
- **A stopped turn.** `backend/session/acp/src/AcpProtocolSession.kt:1692-1693`: `end_turn` is `Completed`, and
  `cancelled` is `Stopped` or `UserStopped`. So a turn that ends with a notice of Megachat never folds.
- **The outline.** `backend/session/catalog/src/StructuredSessionOutlineMapper.kt:64` marks each agent message with
  the phase `Final` as a final response. `frontend/session/view/src/outline/AgentThreadViewThreadOutlineModel.kt:364`
  then shows a green check icon for it.

The bridge sends an `agent_message_chunk` of the main session at these places in `src/AcpBridge.mjs`:

| Place | Message ID | What |
|---|---|---|
| `stream` (line 504) | `megachat-reply-<task>-<attempt>` | The live text of a model request. |
| `replyChunks` (line 512) | `megachat-reply-...` or `megachat-entry-<entry>` | The rest of a streamed reply, a reply without a stream, each replayed reply, and the reply of the morning report and of a child result. |
| `conversation` (line 543) | `megachat-entry-<entry>` | A note of the kind `air.megachat.note`: a note about a session that waits, and the message after an update. |
| `prompt` (lines 344 and 353) | `megachat-notice-<turn>` | The notice of a failed turn and of a lost daemon. |

No other file of `src/` sends an `agent_message_chunk` to the main session. `PiRunService.mjs`, `MegachatState.mjs`
and `ChildTranscript.mjs` read or record the chunks of a child run, which Air shows in the session of the child. The
setup and the morning report are replies of the main agent, so they go through `stream` and `replyChunks`.

## Goals / Non-Goals

Goals:

- No turn of the main agent folds into a block "Worked for", live and in a replay.
- A note and the message after an update show as messages of their own, open.
- No change in Air.

Non-goals:

- A change of the message IDs, of the order of the conversation, or of the place of a note.
- A change of the end of the turn in the mode `ghost`.

## Decisions

### 1. Each chunk of the main session has the phase `final_answer`

One helper of the bridge makes each `agent_message_chunk` of the main session. It adds
`_meta: { jetbrains: { air: { phase: "final_answer" } } }` to the update object, not to the `_meta` of the
`session/update` parameters, which holds `loadSessionReplayIndex`. All four places of the table use it. One rule for
each chunk is simpler than a list of kinds, and a new place cannot forget the key.

What Air does with it:

- A live chunk in a prompt turn: the message gets the phase `Final` and no group ID, because no group is open. At the
  end of the turn, line 60 of `InferredWorkingGroupReducer` finds the phase and makes no group.
- A replayed chunk: the same, for each replayed turn.
- A live chunk outside a prompt turn, for example of the morning report or of a child result: Air ignores the phase of
  a late chunk, and it infers no group for such a chunk today. So nothing changes live. In a replay, the same messages
  join the turn before them, and the phase stops the fold there.
- A notice: its turn ends with `cancelled`, so Air does not fold it anyway. The notice gets the key only for the one
  rule. The replay does not hold a notice.

### 2. No phase `commentary`

The text of a model request that ends with a tool call is work in the sense of Air. With `commentary`, Air puts it in
an explicit collapsible group that the next `final_answer` closes. That is the block that the user does not want. So
no message gets `commentary`.

Trade-off of `final_answer` on each message:

- **Each message as an answer (selected).** No turn folds. The outline of Air shows each message of Megachat with the
  icon of a final response. The bridge needs no knowledge of the tool calls.
- **No key on the text before a tool call.** The turn still has a message with a phase (the last reply), so line 60
  still stops the fold, and the outline marks only the reply. But the bridge must know if a model request ended with a
  tool call, and the stream sends the first chunks before it knows that. A turn where only the text before a tool call
  is in the chat, for example a stopped turn, would have no phase and could fold in a replay. Refused: the user
  accepted the icon (decision 3 of `proposal.md`).
- **`commentary` on the text before a tool call.** This makes the block explicit. Refused, see above.

### 3. The note joins the rule

The draft change `update-note-own-message` gave the key only to a note. This change replaces it. A note gets the key
from the same helper, so the requirement of `session-notes` refers to the capability `reply-stream`. The message
after an update is a note, so it needs no requirement of its own. The requirement "Message after an update" of the
open change `automatic-update` stays true, and this change does not depend on the archive of that change.

### 4. The order of the replay stays

Since commit 833748e, the daemon writes the message after an update on its own, when no turn runs. The replay keeps
the order of the conversation, so in a replay the note is the last message of the turn before it. With the key, that
turn does not fold, so the note shows open. A live note outside a prompt turn is late for Air, and it shows open as
before. The user decided to keep this order (decision 1 of `proposal.md`).

### 5. The end of the turn in the mode `ghost` stays

The hook of b425557 ends the turn after a message with reply text and a call of `agents_suggest` or
`agents_feedback`. It was a fix for the fold. With this change, the fold is gone without it. But the hook still saves
one model request and a short second message after the reply, so it is not dead. Its removal is out of scope.

## The daemon, the state and the ACP messages

- The bridge adds the key when it sends a chunk. No entry of the state gets a new field. So an entry that an older
  daemon wrote also gets the key in the next replay. A disconnect of the ACP client and a restart of the daemon do not
  change this, because the daemon keeps the admitted work as before and the bridge adds the key at each send.
- No field of `conversation.sqlite` or `settings.json` changes.
- ACP: each `agent_message_chunk` of the main session gets `_meta.jetbrains.air.phase` with the value `final_answer`.
  No other message and no other `_meta` key changes.

## Risks / Trade-offs

- [Air changes the rule of line 60] → The blocks come back, as today. Nothing else gets worse. A comment in IJAI-6285
  asks Air to keep the rule (decision 2 of `proposal.md`).
- [Air later gives `final_answer` more effect, for example a notification at each final answer] → Each message of
  Megachat would get it. Today `SessionProjectionChangeRecorder.kt:147` reacts to a complete `Final` message only when
  it has a group ID, and a message of Megachat has none.
- [The outline shows each message with the icon of a final response] → Small. The user accepted it (decision 3 of `proposal.md`).

## Migration Plan

No migration. A rollback is a revert of the bridge change.

## Open Questions

None. The section "Decisions of the user" of `proposal.md` gives the answers of the user.

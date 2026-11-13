# Proposal

## Why

After a Stop of the main turn, the next message of the user first finishes the stopped request. A live run on
2026-11-13 showed it: the user sent "Write a 600-word essay about queues. No tools.", stopped the reply after about
6 seconds, and then sent "Count from 1 to 5 in words." The reply was the whole essay (3,600 characters), and then
"One, two, three, four, five."

The cause is in the model context. Pi Durable keeps the partial reply of a stopped request as an entry with the stop
reason `aborted`, and it leaves such a message out of the model context. So the next request has two messages of the
user one after the other, and nothing tells the model that the user stopped the first request. The model answers both.
No requirement covers what the model sees after a stopped turn.

## What Changes

Where it shows: the chat, through the next reply of the main agent. The chat view, the replay, the task list of Air and
the log do not change.

- **The stopped turn in the model context.** When the user stops a turn of the main agent, Megachat adds an entry for
  the model only to the conversation, before the next turn can start. The entry holds a message of the assistant: the
  partial text of the stopped reply, then the marker "[Megachat: the user stopped this reply here. Do not continue it
  unless the user asks for it.]". A turn that the user stopped before the first text, or during a tool call, gets the
  marker only. So the next request has the stopped request, the partial reply with the marker, and the new message.
  The model does not continue the stopped request unless the user asks for it, and it still knows what the user saw.
- **No second text in the chat.** The chat and a replay do not show the new entry. They show the partial text one
  time, from the entry of the stopped request, as now.
- **No second text in the history.** `agents_history` and the search index of the conversation leave the new entry
  out, so they give the partial text one time.
- A turn that the user stopped after its full reply gets no entry, because the model already sees that reply.
- The same rule applies to an automatic turn that the user stopped or that a message of the user interrupted, such as
  a result report or the morning report.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reply-stream`: the new requirement "Stopped reply in the model context". The requirement "Partial text of a reply"
  does not change.

## Impact

- `src/ReplyStream.mjs`: the kind `air.megachat.stopped` of the new entry, and the text of a stopped turn.
- `src/PiMegachatService.mjs`: the end of a turn reads the newest entries of a stopped turn. `agents_history` leaves
  the new entry out.
- `src/MegachatState.mjs`: the end of a stopped turn writes the entry in the same commit as the end of the turn.
- `src/AcpBridge.mjs` and `src/MegachatSearchIndex.mjs`: the chat and the index leave the new entry out.
- `resources/Megachat.properties`: the marker `reply.stopped`.
- `test/stream.test.mjs` and `test/search-index.test.mjs`: the new cases.
- The change does not modify an ACP extension, so Air does not change.

## Out of scope

- A turn that failed, for example on an error of the provider, also leaves its partial reply out of the model context.
  The chat then shows "The model did not answer. Send the message again.", so the user sends the message again. This
  change does not mark a failed turn.
- A turn that a stop of the daemon interrupted does not change.
- A Stop of a child row and `agents_cancel` do not change: the main agent gets the result `cancelled` of the child, as
  now (see the capability `chat-view`).
- The change touches no non-goal.

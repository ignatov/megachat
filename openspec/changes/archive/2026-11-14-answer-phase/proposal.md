# Proposal

## Why

The user does not want the block "Worked for N sec" of Air around the work of the main agent. The main agent answers
fast, so the block only hides text.

The cause is a rule of Air (`InferredWorkingGroupReducer.kt`, IJAI-5915). At the end of a completed turn, Air folds
each top-level message of the turn before the last agent text into a closed block "Worked for". The bridge sends each
model request of the main agent as a message of its own (see the capability `reply-stream`), and it does not send the
tool calls of the main agent. So the text before a tool call whose result the model must read, for example before
`agents_list` or `agents_spawn`, goes into the block, and only the last text stays open. A note before the reply, such
as the message after an update, also goes into the block: the user saw this in the dev chat on 2026-11-13 at 22:53,
with the Air log line `[AIR_WORKING_GROUP] ... messages=[megachat-entry-3516, megachat-entry-3534]`.

The earlier fixes b425557 and b242609 cover only the mode `ghost` with `agents_suggest`.

## What Changes

Where it shows: the chat in Air. The task list of Air, the commands and the log do not change.

- **Each message of the main agent has the phase of an answer.** The bridge sends each `agent_message_chunk` of the
  main session with `_meta.jetbrains.air.phase` `final_answer` on the update object, live and in the replay. This
  covers each message ID: `megachat-reply-<task>-<attempt>`, `megachat-entry-<entry>` (a reply entry and a note) and
  `megachat-notice-<turn>`. The message IDs do not change.
- **Air folds no turn of Megachat.** Air does not infer a block "Worked for" for a turn with a message that has a
  phase. So each message of a turn shows open, as before IJAI-5915. This includes the text before a tool call, a note,
  the message after an update, and the turn of the morning report in a replay.
- **No message has the phase `commentary`.** That value makes an explicit block "Worked for" in Air.
- **The place of a note stays.** The daemon writes the message after an update on its own when no turn runs (commit
  833748e), and the replay keeps the order of the conversation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `reply-stream`: the requirement "Message IDs of the chunks" gets the key `_meta.jetbrains.air.phase` with the value
  `final_answer` on each `agent_message_chunk`.
- `session-notes`: the requirement "Note in the client and in the model request" says that a note has the same key.

## ACP and Air

No new ACP message. Megachat starts to send a `_meta` key that Air defines and reads today:
`agentMessageChunk._meta.jetbrains.air.phase` (`AcpProtocolExtensions.PHASE_KEY`). Air needs no change.
`docs/air-contract.md` gets the key in the section "The reply stream".

The change uses a rule of Air that is not a promise of the contract: an agent that sends a phase groups its own work,
so Air infers no group for its turn. When Air changes this rule, the blocks come back. The manual check of task 4.2
records the result on the build of the user. Decision 2 asks Air to keep the rule.

## Decisions of the user

The user approved the change on 2026-11-14 with these decisions:

1. **The replay position of the message after an update stays.** In the replay, the note keeps its place in the
   conversation, so it is the last message of the turn before it. With this change, no turn folds, so the position does
   not hide the note.
2. **A comment goes to IJAI-6285.** The comment asks Air to keep the rule that a message with a phase stops the
   inferred block "Worked for", or to give an agent an explicit way to turn the block off. The author posts it.
3. **The outline of Air shows each message as a final response.** Air marks each agent message with the phase
   `final_answer` as a final response in the outline of the session, with a green check icon. With this change, each
   message of Megachat gets that icon, not only the last message of a turn. The user accepts this. The other choice,
   no key on the text before a tool call, is refused (see `design.md`, decision 2).

## Impact

- Code: `src/AcpBridge.mjs` (one helper for each `agent_message_chunk` of the main session).
- Tests: cases in `test/stream.test.mjs`, `test/session-notes.test.mjs` and `test/update.test.mjs`.
- Documents: `docs/air-contract.md`, `docs/manual-checks.md`.
- The state: no change. No field of `conversation.sqlite` or `settings.json` changes.
- Strings: no new user-visible string.
- Out of scope:
  - The removal of the end of the turn in the mode `ghost` (b425557, requirement "End of the turn after the reply in
    the mode ghost" of `suggestions`). It still saves a model request and a short second message after the reply, so it
    is not dead code.
  - One message ID for each turn. The requirement "A reply after a tool call MUST be a new message" stays.
  - A change of the time or the place of the message after an update in the conversation.
  - The output of a child run. Air shows it in the session of the child, not in the main session.
  - No non-goal changes.

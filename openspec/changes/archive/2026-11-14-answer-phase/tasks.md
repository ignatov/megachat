# Tasks

## 1. The tests

- [x] 1.1 In `test/stream.test.mjs`, extend the case "the text before a tool call is a stream, and the tool call stays
      hidden": each chunk of the two messages has `update._meta.jetbrains.air.phase` `final_answer`, and the params
      `_meta` of a live chunk has no phase. Attach a new view after the turn: each replayed chunk has the same key.
      Verify: the case fails before task 2.1.
- [x] 1.2 In `test/stream.test.mjs`, extend the case "a reply that fails in the middle keeps its partial text one
      time, and the notice is another message": the notice has the key. Verify: the case fails before task 2.1.
- [x] 1.3 In `test/session-notes.test.mjs`, extend the case "a note reaches an open view at once and the replay of a
      new view, as a message of its own": the live chunk and the replayed chunk have the key. Verify: the case fails
      before task 2.1.
- [x] 1.4 In `test/update.test.mjs`, add a case with a bridge, as in `test/session-notes.test.mjs`: a view is open,
      and a daemon of `0.5.0` opens a state that recorded `0.4.0`. The view gets the note "Megachat updated from 0.4.0
      to 0.5.0." on its own with a message ID that matches `megachat-entry-<number>`. Then the user sends "hello", and
      the reply has another message ID. Each chunk of both has the key, live and in the replay of a new view. Verify:
      the case fails before task 2.1. (After the rebase onto 833748e, the daemon writes the note on its own, so the
      case follows that behavior.)

## 2. The bridge

- [x] 2.1 In `src/AcpBridge.mjs`, add one helper that makes an `agent_message_chunk` of the main session with
      `_meta: { jetbrains: { air: { phase: 'final_answer' } } }` on the update object. Use it in `stream`, in
      `replyChunks`, for a note in `conversation`, and for the two notices in `prompt`. Verify: the cases of tasks
      1.1 to 1.4 pass.
- [x] 2.2 Check the `Tests:` lines: `test/stream.test.mjs` for "Message IDs of the chunks" of `reply-stream`, and
      `test/session-notes.test.mjs` and `test/update.test.mjs` for "Note in the client and in the model request" of
      `session-notes`.
- [x] 2.3 Run `npm test`. Verify: all tests pass.
- [x] 2.4 Run `npm run test:bundle`, because the bundle holds `src/AcpBridge.mjs`. Verify: it passes.

## 3. The documents

- [x] 3.1 In `docs/air-contract.md`, section "The reply stream", add the key `_meta.jetbrains.air.phase`
      `final_answer` on each `agent_message_chunk`, the reason (line 60 of `InferredWorkingGroupReducer.kt` of Air), and
      that Megachat sends no `commentary`. Change the sentence "This needs no change in Air" so that it says that Air
      reads the key today. In the section "The notes about the sessions that wait", say that a note has the same key.
      In the section "The end of the agent for an update", say that the message after an update shows outside a block
      "Worked for".
- [x] 3.2 Run `openspec validate --all --strict`. Verify: it passes.

No new user-visible string, so `resources/Megachat.properties` does not change. No command, setting or state file
changes, so `README.md` does not change. No `npm run test:package`: no change of `package.json`, of the launcher, of
`install` or of a path into `node_modules`. This change files no IJAI ticket and no comment: Air needs no change, and
the author posts the comment in IJAI-6285 (decision 2 of the proposal).

## 4. The manual check in Air

- [ ] 4.1 Build a daemon with this change, and run it with a temporary `MEGACHAT_HOME`. Never use
      `~/.jetbrains/air/megachat`. For the message after an update, record an earlier version in the state, for example
      the field `update.version` set to `0.6.1`.
- [ ] 4.2 Manual check of the author on a real IDE build: attach Air, and send a message that makes the main agent
      write text, call `agents_list`, and then reply. Record in `docs/manual-checks.md` whether the chat shows both
      messages open with no block "Worked for", what the log line `[AIR_WORKING_GROUP]` gives, and what the replay of a
      new view shows. Check the message after an update and the turn of the morning report the same way.

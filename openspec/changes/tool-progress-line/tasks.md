# Tasks

Rules for each task: never start `src/main.mjs` without a temporary state directory, never run `install` without
`MEGACHAT_ACP_CONFIG` set to a temporary file, and use no recursive delete.

## 1. The event of a tool round

- [ ] 1.1 Export one constant with the names `agents_suggest` and `agents_feedback` from `src/PiMegachatService.mjs`, and
  use it in `replyEnd()` (design D2). Verify with `npm test`: the cases of the mode `ghost` still pass.
- [ ] 1.2 In `ReplyStream.observe()`, publish the event `tools` with the `callId` of the first slot when `pi.live.tools`
  goes from empty to not empty and a slot has a name that is not in that constant (design D2). Add a case to
  `test/stream.test.mjs` with the fake clock: a round of `agents_list` gives one event, a round of `agents_suggest` gives
  none. Verify with `npm test`.

## 2. The row in the bridge

- [ ] 2.1 Add the key `progress.tools` "Megachat works with its tools" to `resources/Megachat.properties`. Verify with
  `npm test`.
- [ ] 2.2 In `AcpBridge`, keep the open row, send the `tool_call` on the event `tools` only for the turn of the prompt
  of the view, end the row with `completed` before each live `agent_message_chunk`, and end it in `prompt()` before the
  prompt response with `completed` or `failed` (design D3). Verify with `npm test`.
- [ ] 2.3 Add cases to `test/stream.test.mjs` for "Progress row of the tools" ("A tool round" with the call ID
  `call-1`, "Two rounds with no text between them"), "Rounds without a progress row" ("A reply with agents_suggest" in
  the mode `ghost`), "End of the progress row" ("A reply in one chunk after a tool result" with a fake model that sends
  the reply after 2 seconds, "A stop during a tool round") and "Views with the progress row" ("A second view", "The
  replay after the turn"). Verify with `npm test`.
- [ ] 2.4 Change the case "the text before a tool call is a stream, and the tool call stays hidden" of
  `test/stream.test.mjs` to expect the updates of the modified scenario "A text and a call of agents_list" of
  `reply-stream`. Verify with `npm test`.
- [ ] 2.5 Change the case "the chat lists running children instead of coordinator tool calls" of
  `test/integration.test.mjs` to expect the progress row next to the end of the tool call of the permission request,
  and no `tool_call` with the name or the input of `agents_spawn`. Add a case for the scenario "A child result" of
  "Views with the progress row". Verify with `npm test`.
- [ ] 2.6 Check the `Tests:` lines of the modified and new requirements of `chat-view` and `reply-stream`. Verify with
  `openspec validate --all --strict`.

## 3. Documents and a check in the IDE

- [ ] 3.1 In `docs/air-contract.md`, add a part "The progress row of the tools" with the updates, the ID, the end of the
  row, the views that get it, and the facts of Air of design.md, "Context". Change the sentences that say that the chat
  gets no tool call of the main agent. Verify by reading it against the requirements.
- [ ] 3.2 In `README.md`, add one sentence where it says what the chat shows: the view that waits shows a row "Megachat
  works with its tools" while the main agent works with its tools. Verify by reading it.
- [ ] 3.3 Manual check of the author in Air with Claude Opus 5.5 through Central: ask "What is running now?" and
  record in `docs/manual-checks.md` what the chat shows during the tool round, after the reply, and after a restart of
  the IDE. Verify that the record exists.

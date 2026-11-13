# Proposal

## Why

With Claude Opus 5.5 and Claude Sonnet 5.5 through Central, the reply that follows a tool result arrives as one chunk
at the end of the response (issue #19). The provider causes it, and Megachat cannot change it. The chat hides each tool
call of the main agent, so during a tool round and the model request after it the chat shows nothing for seconds. A
colleague sees a chat that looks hung, and sends the message again or stops the turn.

## What Changes

Where it shows: the chat of the view that sent the prompt, as one tool-call row of Air.

- **A progress row of the tools.** When the main agent starts a tool round in a turn that answers a prompt of the
  view, the view gets one row with the fixed title "Megachat works with its tools". Air shows the row as a running
  tool call. The row has no tool name, no input and no output, so the chat still shows no tool call of the main agent.
- **One row for each silent stretch.** The row stays open through each later tool round and model request until the
  next text of the reply reaches the view. Then the row ends as completed, and the text follows below it. A reply
  with text, a tool round, text, a tool round and text gives two rows.
- **No row after the reply.** A tool round of only `agents_suggest` or `agents_feedback` opens no row. In the mode
  `ghost` (the default), such a round follows the reply text and ends the turn. A row there would come after the
  reply, and Air would then not show the reply as one open message.
- **The end of the row.** A turn that completes ends an open row as completed before the prompt response. A turn that
  the user stops, or that fails, ends it as failed.
- **No replay and no change of the text.** The replay of the conversation sends no row. The reply text, its message
  IDs and its entries do not change. The retained conversation keeps each tool call as today.
- **Only the view that waits.** A view without a prompt, a view that shows the turn of another view, and an automatic
  turn, such as a child result or the morning report, get no row, as today.

After the turn, Air puts the row with the text before the last reply into its collapsed "Worked for" block, as Air
already does with the text of each earlier model request of a turn. The last reply stays visible.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-view`: "Hidden work in the chat" is modified: the chat shows the progress row, and still no name, input or
  output of a tool call of the main agent. New requirements give the start, the end and the views of the row.
- `reply-stream`: "Text before a tool call" is modified, because its scenario says that the view gets only
  `agent_message_chunk` and `session_info_update`.

## ACP and Air

No ACP extension changes. The row is a standard ACP `tool_call` with a `tool_call_update`. Air of today shows such a
call as a tool row with its title, shows `in_progress` as a running row, and ends each open call at the end of the
prompt turn (design.md, "Context"). Air needs no change. `docs/air-contract.md` gets a part about the row, because it
says today that the chat gets no tool call of the main agent.

## Impact

- Code: `src/ReplyStream.mjs` (the start of a tool round from `pi.live.tools`), `src/DaemonServer.mjs` (the event
  `tools` on the event stream), `src/AcpBridge.mjs` (the row, its end before a text chunk and before the prompt
  response), `resources/Megachat.properties` (the title of the row).
- Tests: cases in `test/stream.test.mjs` and `test/integration.test.mjs`.
- Documents: `docs/air-contract.md`, `README.md` (one sentence about what the chat shows).
- The state: no change. The row lives only in the bridge and in the chat of Air.
- Out of scope:
  - The cause of the reply in one chunk. That goes to the provider or to Central with the probe of issue #19.
  - The silence before the first tool round, while the model thinks.
  - A row for each tool with its name, a count of the calls, or the output of a tool.
  - A row in an automatic turn or in the view of another client.
  - `agent_thought_chunk`: Megachat still sends none.
  - No non-goal changes.

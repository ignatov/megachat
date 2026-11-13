# reply-stream Specification

## Purpose
The chat shows the text of a reply of the main agent while the model writes it. Each view gets each text one time, and the stream shows no thinking and no tool call of the model.

## Requirements

### Requirement: Live text of a reply
The chat MUST show the text of a reply of the main agent while the model writes it. The first text MUST NOT wait for the entry of the reply.

Tests: `test/stream.test.mjs`

#### Scenario: Chunks before the entry
- **WHEN** the model writes a reply of 60 words
- **THEN** the view gets two chunks or more before the conversation has the entry of the reply

### Requirement: Message IDs of the chunks
The chunks of one model request MUST have one message ID. A reply after a tool call MUST be a new message.

Tests: `test/stream.test.mjs`

#### Scenario: One model request
- **WHEN** the model writes a reply of 60 words in one model request
- **THEN** the chunks make one message, and its ID matches `megachat-reply-<number>-1`

#### Scenario: A reply after a tool call
- **WHEN** the model writes `I look at the list of the tasks now, one moment.`, calls `agents_list`, and then writes a reply
- **THEN** the chat has two messages: the text before the call and the reply

### Requirement: Entry of a streamed reply
The entry of a reply MUST add only the text that the stream did not send. The chat MUST NOT show a text two times.

When the entry of a reply does not start with the sent text, the entry MUST be a second message, because Air cannot replace a sent chunk.

Tests: `test/stream.test.mjs`

#### Scenario: The entry after the chunks
- **WHEN** the chunks of a reply of 60 words arrived, and the entry of the reply is written
- **THEN** the chat has the text of the reply one time

### Requirement: Partial text of a reply
A reply that the user stopped, or that failed, MUST keep its partial text in the chat one time. That text MUST be an entry, so a replay shows it too. The notice of a failed reply MUST be a message of its own.

Tests: `test/stream.test.mjs`

#### Scenario: A stopped reply
- **WHEN** the user stops a reply after two chunks
- **THEN** the chat has one message with the partial text, the conversation has an entry with the same text, and a later view shows the same text

#### Scenario: A failed reply
- **WHEN** the model fails in the middle of a reply with the error `The provider is overloaded.`
- **THEN** the chat has the partial text one time, and then the message `The model did not answer. Send the message again.`

### Requirement: Replay and a view in the middle of a reply
A replay MUST hold only entries. A view that connects in the middle of a reply MUST get the text so far as a live chunk after the replay, and then the text that follows. Each connected view MUST get each text one time.

Tests: `test/stream.test.mjs`

#### Scenario: A second view during a reply
- **WHEN** a second view attaches after the first view got three chunks of a reply
- **THEN** the replay of the second view holds no chunk of the reply, its first chunk holds the text so far, and each of the two views has the full reply one time

#### Scenario: A view after the reply
- **WHEN** a view attaches after the entry of a reply is written
- **THEN** the view gets the reply one time, as a replay of the entry

### Requirement: Text before a tool call
The text before a call of a tool of the main agent MUST be a stream. The call MUST stay hidden.

Tests: `test/stream.test.mjs`

#### Scenario: A text and a call of agents_list
- **WHEN** the model writes `I look at the list of the tasks now, one moment.` and calls `agents_list`
- **THEN** the text arrives in parts, and the view gets only the updates `agent_message_chunk` and `session_info_update`

### Requirement: No thinking in the stream
The stream MUST NOT hold the thinking of the model.

Each model request through Central MUST ask for thinking blocks without text (the display `omitted`). With a summary of the thinking, the API sends the text of a reply only after the summary. Then the first part of a reply arrives as one chunk, and a short reply arrives whole at its end.

Tests: `test/stream.test.mjs`

#### Scenario: A reply with a thought
- **WHEN** the model writes the thought `A hidden thought.` and then a reply
- **THEN** the view gets no `agent_thought_chunk`

#### Scenario: A short reply through Central
- **WHEN** the model `claude-opus-5-5` thinks for 400 ms and then writes a reply of about one hundred characters
- **THEN** each model request has the thinking display `omitted`, and the view gets the reply in two chunks or more before its entry

### Requirement: Rate of the stream events
The daemon MUST send at most 20 stream events in a second to one client. A partial reply MUST NOT send the conversation again.

Tests: `test/stream.test.mjs`

#### Scenario: A long reply
- **WHEN** the model writes a reply of 180 words
- **THEN** the client gets at most 20 stream events in a second, the events join into the text without a gap, and the client gets no view of the conversation for the partial reply

#### Scenario: A text that arrives faster than the interval
- **WHEN** 40 parts of a text arrive 2 ms apart
- **THEN** the stream joins them into five events or fewer, and it keeps a character of two units whole

### Requirement: Switch of the stream
`MEGACHAT_STREAM=0` MUST stop the stream. Then the chat gets a reply when its entry is written. A daemon restart applies a changed value.

Tests: `test/stream.test.mjs`

#### Scenario: The stream is off
- **WHEN** `MEGACHAT_STREAM` is `0`, and the model writes a reply
- **THEN** the daemon sends no stream event, and the chat gets the reply as one message with an ID that matches `megachat-entry-<number>`

### Requirement: Log of the time to the first text
The log of the daemon MUST get one line with the time from the start of a model request to its first text. The line MUST hold no content of the conversation.

Tests: `test/stream.test.mjs`

#### Scenario: The first text of a reply
- **WHEN** a stream sends 40 parts of a reply
- **THEN** the stream reports the time to the first text one time

### Requirement: Stopped reply in the model context
After the user stops a turn, the next model request MUST hold, after the stopped request, one assistant message: the partial text, a blank line, and the marker `reply.stopped`. A turn with no partial text MUST give the marker only. A turn with its full reply MUST give no message. The chat, a replay, `agents_history` and the search index MUST show the partial text one time and no marker.

Tests: `test/stream.test.mjs`, `test/search-index.test.mjs`

#### Scenario: A stopped reply and the next message
- **WHEN** the user sends "Write an essay", stops the reply after two chunks, and sends "Count from 1 to 5"
- **THEN** the second model request holds "Write an essay", the partial text with the marker "[Megachat: the user stopped this reply here. Do not continue it unless the user asks for it.]", and "Count from 1 to 5", and the chat, a later view and `agents_history` have the partial text one time and "One, two, three, four, five."

#### Scenario: A stop before the first text
- **WHEN** the user stops the turn of "Hello" before the model sends text, and sends "Again"
- **THEN** the second model request holds "Hello", the marker only, and "Again", and the chat has only the reply "Done."

#### Scenario: The text of a stopped turn
- **WHEN** the newest model message of the stopped turn is an `aborted` reply "Queues hold items. ", a tool result, or a full reply "Done."
- **THEN** the text is "Queues hold items." with the marker, the marker only, or no text

#### Scenario: The search index
- **WHEN** the index reads the entry of a stopped turn
- **THEN** the entry has no text in the index

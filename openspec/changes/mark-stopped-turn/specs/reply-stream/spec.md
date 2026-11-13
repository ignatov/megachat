## ADDED Requirements

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

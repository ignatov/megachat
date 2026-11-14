## MODIFIED Requirements

### Requirement: Message IDs of the chunks
The chunks of one model request MUST have one message ID. A reply after a tool call MUST be a new message. Each `agent_message_chunk` of the main session MUST have `_meta.jetbrains.air.phase` `final_answer` on the update, live and in the replay: a reply, a note and a notice. A chunk MUST NOT have the phase `commentary`. Air infers no block "Worked for" for a turn with a message that has a phase.

Tests: `test/stream.test.mjs`

#### Scenario: One model request
- **WHEN** the model writes a reply of 60 words in one model request
- **THEN** the chunks make one message, and its ID matches `megachat-reply-<number>-1`

#### Scenario: A reply after a tool call
- **WHEN** the model writes `I look at the list of the tasks now, one moment.`, calls `agents_list`, and then writes a reply
- **THEN** the chat has two messages: the text before the call and the reply

#### Scenario: The phase of each message
- **WHEN** the model writes `I look at the list of the tasks now, one moment.`, calls `agents_list`, and then writes a reply, and a new view attaches after the turn
- **THEN** each chunk of the two messages has `update._meta.jetbrains.air.phase` `final_answer`, live and in the replay of the new view

#### Scenario: The notice of a failed reply
- **WHEN** the model fails in the middle of a reply with the error `The provider is overloaded.`
- **THEN** the notice `The model did not answer. Send the message again.` has `update._meta.jetbrains.air.phase` `final_answer`

## MODIFIED Requirements

### Requirement: Note in the client and in the model request
Each view MUST get a note at once as an `agent_message_chunk` with the message ID `megachat-entry-<entry>` and the phase `final_answer` (see the capability `reply-stream`), never in the message of a stream. The replay MUST show it with the same message ID and the same phase. The next model request of the main agent MUST hold it as a message of the assistant.

Tests: `test/session-notes.test.mjs`, `test/update.test.mjs`

#### Scenario: An open view and a new view
- **WHEN** a client has an open view, and a session gets a note
- **THEN** the open view gets the note at once as an `agent_message_chunk` with a message ID that matches `megachat-entry-<number>` and `update._meta.jetbrains.air.phase` `final_answer`, and the replay of a new view shows it with the same message ID and the same phase

#### Scenario: The next turn of the user
- **WHEN** a note came after a turn, and the user sends "What now?"
- **THEN** the model request holds the note as a message of the assistant that starts with "Megachat note:", and a message of the user follows it

#### Scenario: The message after an update
- **WHEN** a view is open, a daemon of `0.5.0` opens a state that recorded `0.4.0` with the release notes "- Five", and then the user sends "hello"
- **THEN** the view gets the note "Megachat updated from 0.4.0 to 0.5.0.\n- Five" on its own with a message ID that matches `megachat-entry-<number>`, then the reply "Answer 1." with another message ID, each chunk of both has `update._meta.jetbrains.air.phase` `final_answer`, and a new view replays both with the same key

# Spec Delta

## ADDED Requirements

### Requirement: Pages in the chat
The main agent MUST get the rules of the `air-html` fence in its instructions when `chat.html` is `on`, or is `auto` and the client has the Air support. It MUST NOT get them when `chat.html` is `off`, or is `auto` and the client has no Air support. A child MUST NOT get them. The default is `auto`.

Tests: `test/chat-html.test.mjs`

#### Scenario: A client with the Air support
- **WHEN** a view attaches with `_meta.jetbrains.air.version` 1, and `chat.html` is `auto`
- **THEN** the instructions of the next turn of the main agent hold the section `air-html`

#### Scenario: A client without the Air support
- **WHEN** a view attaches with no `_meta.jetbrains.air`, and `chat.html` is `auto`
- **THEN** the instructions hold no section `air-html`

#### Scenario: The setting off
- **WHEN** `chat.html` is `off` and a view with the Air support attaches
- **THEN** the instructions hold no section `air-html`

### Requirement: The fence stays whole
Megachat MUST NOT change the text of a reply that holds an `air-html` fence. The stream, the replay and the stored entry MUST keep the fence, also when a chunk ends inside it.

Tests: `test/chat-html.test.mjs`

#### Scenario: A fence in three chunks
- **WHEN** the model streams a fence in three chunks and the view replays the entry
- **THEN** the replay holds the same text as the three chunks together

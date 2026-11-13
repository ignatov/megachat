# Spec Delta

## MODIFIED Requirements

### Requirement: Hidden work in the chat
The main conversation MUST show no child lifecycle rows, tool calls, or child output. The chat MUST NOT show the name, the input or the output of the main agent's own tool calls. It shows only the progress row of the tools (see "Progress row of the tools"). The retained conversation MUST keep the calls. The chat MUST NOT show a task row for the main agent's own turn.

Tests: `test/integration.test.mjs`

#### Scenario: The output of a child
- **WHEN** a child writes `hello` and ends
- **THEN** the view gets no `subagent_spawned`, no `subagent_state_update`, no `tool_call` and no text `hello`

#### Scenario: A tool call of the main agent
- **WHEN** the main agent calls `agents_spawn` in a turn that answers a prompt of the view, and then writes `Started.`
- **THEN** the view gets the text `Started.`, its only `tool_call` is the progress row with the title "Megachat works with its tools" and no name and no input of `agents_spawn`, and the retained conversation keeps the call of `agents_spawn`

#### Scenario: The turn of the main agent
- **WHEN** a view attaches while a turn of the main agent runs
- **THEN** the view gets no row with the task type `turn`

## ADDED Requirements

### Requirement: Progress row of the tools
When a tool round of the main agent starts in a turn that answers a prompt of the view, and no progress row is open, the view MUST get one `tool_call` with the status `in_progress`, the kind `other`, the title "Megachat works with its tools" from `resources/Megachat.properties`, and the ID `megachat-tools-<ID of the first call of the round>`. The row MUST have no content, no locations and no raw input.

Tests: `test/stream.test.mjs`

#### Scenario: A tool round
- **WHEN** the view sends "Hello", and the model calls `agents_list` with the call ID `call-1`
- **THEN** the view gets `{"sessionUpdate":"tool_call","toolCallId":"megachat-tools-call-1","title":"Megachat works with its tools","kind":"other","status":"in_progress"}` before the tool result

#### Scenario: Two rounds with no text between them
- **WHEN** the model calls `agents_list`, then `agents_running` with no text, and then writes the reply
- **THEN** the view gets one progress row for the two rounds

### Requirement: Rounds without a progress row
A tool round whose calls are each `agents_suggest` or `agents_feedback` MUST NOT open a progress row. In the mode `ghost`, such a round follows the reply text and ends the turn, so a row there would come after the reply and keep Air from showing the reply as one open message.

Tests: `test/stream.test.mjs`

#### Scenario: A reply with agents_suggest
- **WHEN** the mode is `ghost`, the model calls `agents_list`, and then writes the reply and calls `agents_suggest` in the same message
- **THEN** the view gets one progress row, which ends before the reply, and no row after the reply

### Requirement: End of the progress row
The bridge MUST end an open progress row with a `tool_call_update` with the status `completed` before the next text of the turn reaches the view, and before the prompt response of a completed turn. A turn that ends with another status MUST end the row with `failed` before its prompt response. A text after the row MUST have a message ID that differs from each message ID before the row.

Tests: `test/stream.test.mjs`

#### Scenario: A reply in one chunk after a tool result
- **WHEN** the model calls `agents_list`, and the model request after the tool result sends the whole reply in one chunk after 2 seconds
- **THEN** the row is open for those 2 seconds, and the view gets the `tool_call_update` with `completed` directly before the chunk of the reply

#### Scenario: A stop during a tool round
- **WHEN** the user stops the turn while the progress row is open
- **THEN** the view gets the `tool_call_update` with `failed`, and then the prompt response with `cancelled`

### Requirement: Views with the progress row
Only the view whose prompt the turn answers MUST get a progress row. A view without a prompt, a view that shows the turn of another view, and an automatic turn MUST get no row. The replay of the conversation MUST NOT send a row.

Tests: `test/stream.test.mjs`, `test/integration.test.mjs`

#### Scenario: A second view
- **WHEN** two views are attached, the first view sends "Hello", and the model calls `agents_list`
- **THEN** the first view gets the progress row, and the second view gets the text of the reply and no `tool_call`

#### Scenario: A child result
- **WHEN** the turn of a child result calls `agents_list` and then reports the result
- **THEN** the view gets the report and no `tool_call`

#### Scenario: The replay after the turn
- **WHEN** a new view attaches after a turn with a progress row
- **THEN** the replay holds the text of the turn and no `tool_call`

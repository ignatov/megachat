# Spec Delta

## MODIFIED Requirements

### Requirement: Text before a tool call
The text before a call of a tool of the main agent MUST be a stream. The call MUST stay hidden: the view MUST get no name, no input and no output of the call, only the progress row of the tools (see the capability `chat-view`).

Tests: `test/stream.test.mjs`

#### Scenario: A text and a call of agents_list
- **WHEN** the model writes `I look at the list of the tasks now, one moment.` and calls `agents_list`
- **THEN** the text arrives in parts, and the view gets only the updates `agent_message_chunk`, `session_info_update`, and one `tool_call` and one `tool_call_update` of the progress row

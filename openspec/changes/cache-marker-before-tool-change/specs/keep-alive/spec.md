# Spec Delta

## ADDED Requirements

### Requirement: Cache marker before a change of the tools
An Anthropic request through Central MUST NOT have a cache marker on a `tool_addition` or `tool_removal` block. When pi-ai puts the marker of the messages on such a block, the marker MUST move to the last block of the last user message before it. The request MUST keep each other cache marker. A request without a change of the tools MUST keep the markers that pi-ai gives.

Tests: `test/keepalive.test.mjs`

#### Scenario: A turn after a change of the tools
- **WHEN** a turn ends, `reply.suggestions` changes from `off` to `reply`, and the user sends the next message
- **THEN** the body of the next request has the cache marker on the last block of that user message, no cache marker on a `tool_addition` block, and the same markers on the tools and on the system prompt

#### Scenario: A turn without a change of the tools
- **WHEN** the user sends a second message and the tools do not change
- **THEN** the body of the request has the cache marker on the last block of that user message, as pi-ai gives it

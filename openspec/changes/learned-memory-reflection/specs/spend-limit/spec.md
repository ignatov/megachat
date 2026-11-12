## MODIFIED Requirements

### Requirement: Count of the spend
Megachat MUST count the cost of each model request of the main agent and of each pi child on the local day: each reply, also a reply with tool calls, each summary, each keep-alive request and each reflection request of the memory. A request without a cost from its provider MUST get the cost from the prices of its model data. The cost of the Claude and Codex children MUST NOT be in the count.

Tests: `test/spend.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: The cost from the provider
- **WHEN** the provider gives a request the total cost 0.25 USD
- **THEN** the count gets 0.25 USD

#### Scenario: The cost from the prices of the model data
- **WHEN** the provider gives no cost, the request has 1,000,000 input tokens and 100,000 output tokens, and the model data give 2 USD for one million input tokens and 10 USD for one million output tokens
- **THEN** the count gets 3 USD

#### Scenario: A summary, a keep-alive request and a pi child
- **WHEN** a compaction makes a summary, a keep-alive request goes out, or a pi child with a priced model replies
- **THEN** the count of the day becomes higher

#### Scenario: A reflection request
- **WHEN** a reflection pass sends a request with the total cost 0.05 USD
- **THEN** the count of the day gets 0.05 USD

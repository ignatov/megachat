# spend-limit Specification

## Purpose
The user can set a daily spend limit in USD for the model requests of the main agent and of the pi children. Megachat counts the spend of each local day and gives one warning on a day when the spend passes the limit.

## Requirements

### Requirement: Daily spend limit
The setting `budget.dailyUsd` MUST be a daily spend limit of the main agent and the pi children in USD, from 0 to 100,000. The default 0 means no limit.

Tests: `test/spend.test.mjs`

#### Scenario: A limit of 0
- **WHEN** the limit is 0 and the count of the day gets 1000 USD
- **THEN** Megachat gives no warning

### Requirement: Count of the spend
Megachat MUST count the cost of each model request of the main agent and of each pi child on the local day: each reply, also a reply with tool calls, each summary and each keep-alive request. A request without a cost from its provider MUST get the cost from the prices of its model data. The cost of the Claude and Codex children MUST NOT be in the count.

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

### Requirement: Stored count
The count MUST stay in `spend.json` in the state directory with the mode 0600, so a daemon restart keeps it. The count MUST start again at the local midnight.

Tests: `test/spend.test.mjs`

#### Scenario: A restart keeps the count
- **WHEN** two requests of 0.4 USD go into the count and the daemon restarts
- **THEN** the count of the day is 0.8 USD, and `spend.json` has the mode 0600

#### Scenario: The local midnight
- **WHEN** the count has a value at 22:00 local time and the clock moves on by three hours
- **THEN** the count of the new day is 0 USD

### Requirement: Spend warning
When the count passes the limit, the rules of the next turn MUST hold one line with the spend and the limit, which asks for one short warning. The line MUST go away after a completed turn that had it. The user MUST get at most one warning on each day. Megachat MUST NOT stop the work.

A warning that waits at the local midnight MUST NOT go into a turn of the next day, and it MUST NOT mark the warning of the next day as shown.

Tests: `test/spend.test.mjs`

#### Scenario: One warning on a day
- **WHEN** the limit is 0.000001 USD and the user sends three prompts
- **THEN** the rules of the second turn hold the line with the limit of 0.000001 USD, and the rules of the first turn and of the third turn do not hold it

#### Scenario: A warning that waits at the midnight
- **WHEN** a late turn passes the limit and the local midnight comes before the next turn
- **THEN** the first turn of the next day has no warning, and the turn after it has the warning of the new day

### Requirement: Spend in agents_settings get
`agents_settings get` MUST give the spend of the day, the limit, whether the warning went out in a completed turn (`warned`), whether a warning waits (`warningPending`), and a note that the Claude and Codex children are not in the count.

Tests: `test/spend.test.mjs`

#### Scenario: The spend after a warning
- **WHEN** the limit is 0.000001 USD and a completed turn had the warning
- **THEN** `agents_settings get` gives a spend above 0, the limit 0.000001, `warned` with the value `true`, and the note that the count does not count the Claude and Codex children

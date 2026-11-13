## Purpose
After the short setup, many settings keep their defaults. The main agent offers such a setting one time, in the reply, when a report or a tool result shows that the setting helps. The conversation state keeps each offer, so no setting gets a second offer.

## ADDED Requirements

### Requirement: List of the offers
The file `resources/instructions-offers.md` MUST hold the offer rules and the list of the offers: one line for each setting that the main agent can offer, with its trigger. The list MUST name only settings of this build that the setup does not ask for. The list is `children.push`, `children.daemonRestart`, `children.parallel`, `children.timeoutMinutes`, `children.permissionMode`, `budget.dailyUsd`, `sessions.notes`, `workday.enabled` and `report.morning`.

Tests: `test/setting-offers.test.mjs`

#### Scenario: The keys of the list
- **WHEN** a test reads `resources/instructions-offers.md`
- **THEN** the keys of its list are the nine keys above, each one is a key of the settings of this build, and `resources/instructions-onboarding.md` names none of them

#### Scenario: The trigger of children.push
- **WHEN** a test reads `resources/instructions-offers.md`
- **THEN** the line of `children.push` holds "A child result says that a push is necessary."

### Requirement: Offer rules in the rules of the main agent
In the modes `reply` and `ghost`, after the status `done` or `skipped` of the onboarding, the rules section `settings` MUST hold the offer rules and one line for each open offer, with its current value. An offer is open when it has no record, no stored value and no variable. In the mode `off`, while the onboarding is pending, and without an open offer, the rules MUST NOT hold the offer rules.

Tests: `test/setting-offers.test.mjs`

#### Scenario: The open offers after the setup
- **WHEN** the mode is `ghost`, the onboarding is `done`, and no value is stored
- **THEN** the rules hold "children.push (ask): A child result says that a push is necessary." and a line for each other key of the list but `sessions.notes`, which waits for `sessions.index`

#### Scenario: A stored value
- **WHEN** the onboarding is `done` and `settings.json` holds `children.push` `allow`
- **THEN** the rules have no line of `children.push`

#### Scenario: The mode off and a pending setup
- **WHEN** the mode is `off` and the onboarding is `done`, or the mode is `ghost` and the onboarding is pending
- **THEN** the rules do not hold "Offer a setting in one sentence of the reply text"

#### Scenario: A recorded offer
- **WHEN** the agent records the offer of `children.push` in a turn
- **THEN** the rules of the next turn have no line of `children.push`

### Requirement: Record of an offer
`agents_settings(action="offer", key)` MUST give `allowed: true` and the current value only for an open offer, in the modes `reply` and `ghost`, after the setup, without a request for silence, and as the first allowed offer of the turn. Else it MUST give `allowed: false`. The conversation state MUST keep each allowed offer in `initiative.offers` through a restart and a compaction. A repeated tool call MUST give the same result.

Tests: `test/setting-offers.test.mjs`

#### Scenario: The first offer
- **WHEN** the mode is `ghost`, the onboarding is `done`, and the agent calls `agents_settings(action="offer", key="children.push")`
- **THEN** the result is `{ "allowed": true, "key": "children.push", "value": "ask" }`, and the state holds the offer

#### Scenario: A second offer after a restart
- **WHEN** the agent recorded the offer of `children.push`, the daemon restarts, and the agent calls the offer of `children.push` again
- **THEN** the result has `allowed: false`

#### Scenario: Two offers in one turn
- **WHEN** a turn calls the offer of `children.push` and then the offer of `children.parallel`
- **THEN** the second result has `allowed: false`, and the state holds only the offer of `children.push`

#### Scenario: Silence, the mode off and a key out of the list
- **WHEN** the agent called `agents_feedback(decision="silence")`, or the mode is `off`, or the key is `cache.ttl`
- **THEN** the offer gets `allowed: false`, and the state holds no offer

### Requirement: Text of an offer
The offer rules MUST ask for an offer only after the call gives `allowed: true`, in one sentence of the reply text with the current value, also in the mode `ghost`. In the mode `ghost`, the acceptance MAY be the prompt suggestion of the turn. The agent MUST change the setting only after the user agrees. A refusal needs no record.

Tests: `test/setting-offers.test.mjs`

#### Scenario: The rules of the text
- **WHEN** the mode is `ghost` and an offer is open
- **THEN** the rules hold "Offer a setting in one sentence of the reply text, with its current value." and "An offer of a setting is not a next step of the work."

#### Scenario: An offer in a turn of a child result
- **WHEN** the mode is `ghost`, a turn of a child result calls the offer of `children.push`, replies "The child did not push. children.push is ask, so each push waits for your yes. I can set it to allow.", and calls `agents_suggest` with "Let child tasks push without a question"
- **THEN** the view gets the reply text in an `agent_message_chunk` and the prompt suggestion "Let child tasks push without a question", and `children.push` stays `ask`

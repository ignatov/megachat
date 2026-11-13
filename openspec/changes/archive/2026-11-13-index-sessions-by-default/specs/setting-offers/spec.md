## MODIFIED Requirements

### Requirement: Offer rules in the rules of the main agent
In the modes `reply` and `ghost`, after the status `done` or `skipped` of the onboarding, the rules section `settings` MUST hold the offer rules and one line for each open offer, with its current value. An offer is open when it has no record, no stored value and no variable. In the mode `off`, while the onboarding is pending, and without an open offer, the rules MUST NOT hold the offer rules.

Tests: `test/setting-offers.test.mjs`

#### Scenario: The open offers after the setup
- **WHEN** the mode is `ghost`, the onboarding is `done`, `settings.json` holds `defaults` 2, and no value is stored
- **THEN** the rules hold "children.push (ask): A child result says that a push is necessary." and a line for each other key of the list, also `sessions.notes`, because `sessions.index` is on by default

#### Scenario: A stored value
- **WHEN** the onboarding is `done` and `settings.json` holds `children.push` `allow`
- **THEN** the rules have no line of `children.push`

#### Scenario: The mode off and a pending setup
- **WHEN** the mode is `off` and the onboarding is `done`, or the mode is `ghost` and the onboarding is pending
- **THEN** the rules do not hold "Offer a setting in one sentence of the reply text"

#### Scenario: A recorded offer
- **WHEN** the agent records the offer of `children.push` in a turn
- **THEN** the rules of the next turn have no line of `children.push`

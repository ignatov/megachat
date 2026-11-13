## MODIFIED Requirements

### Requirement: Cancel and deadline of a pi run
`agents_cancel` and the deadline of `children.timeoutMinutes` (see the capability `child-settings`) MUST abort the conversation of the child. The main conversation MUST continue. A run at the deadline MUST become interrupted with no continuation. Before the dispatch, in `launching` and `ready`, `agents_cancel`, the deadline and a daemon stop MUST also end a run whose step waits, so the run cannot hold the place of a child.

Tests: `test/pi-child.test.mjs`

#### Scenario: A cancel
- **WHEN** the main agent calls `agents_cancel` for a pi child that waits for its model
- **THEN** the run becomes `cancelled`, and the next message of the user completes

#### Scenario: The deadline
- **WHEN** the deadline ends a pi child
- **THEN** the run becomes `interrupted` with no continuation, and the next message of the user completes

#### Scenario: A run whose start waits
- **WHEN** a pi run waits in `launching`, and the main agent cancels it
- **THEN** the run becomes `cancelled`

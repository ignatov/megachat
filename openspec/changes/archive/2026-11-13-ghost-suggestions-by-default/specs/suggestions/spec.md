## MODIFIED Requirements

### Requirement: Modes of the setting reply.suggestions
The setting `reply.suggestions` MUST have the modes `off`, `reply` and `ghost` (the default). Without a stored value, the mode MUST be `ghost`. A stored value MUST keep its mode. `MEGACHAT_SUGGESTIONS=0`, `1` and `ghost` MUST select `off`, `reply` and `ghost`, also over a stored value.

The stored values `false` and `true` of v0.3.0 MUST give `off` and `reply`, and the open MUST NOT change the file.

Tests: `test/suggestions.test.mjs`, `test/settings.test.mjs`, `test/upgrade.test.mjs`

#### Scenario: No stored value
- **WHEN** `settings.json` holds no value of `reply.suggestions` and no variable is set
- **THEN** the mode is `ghost`, the main agent has the tools `agents_suggest` and `agents_feedback`, and its rules hold "Do not propose a next step in the reply text unless the user asks for one."

#### Scenario: A stored value off
- **WHEN** `settings.json` holds the value `off` of `reply.suggestions`
- **THEN** the mode is `off`, and the rules hold "Do not propose a next step unless the user asks for one."

#### Scenario: The values of the variable
- **WHEN** `MEGACHAT_SUGGESTIONS` is `0`, `1` or `ghost`
- **THEN** the mode is `off`, `reply` or `ghost`

#### Scenario: The variable wins over a stored value
- **WHEN** `settings.json` holds the value `reply` of `reply.suggestions` and `MEGACHAT_SUGGESTIONS` is `0`
- **THEN** the mode is `off`

#### Scenario: A stored value of v0.3.0
- **WHEN** `settings.json` holds the value `true` of `reply.suggestions`, as v0.3.0 stored it
- **THEN** the mode is `reply`, and the file has the same text after the open

### Requirement: The mode off
In the mode `off`, Megachat MUST NOT offer a next step by itself. It MAY offer one when the user asks. The main agent MUST have no suggestion rules and no `agents_suggest` and `agents_feedback` tools. The stored proposal decisions MUST stay.

Tests: `test/suggestions.test.mjs`, `test/settings.test.mjs`

#### Scenario: The rules of the mode off
- **WHEN** the mode is `off`
- **THEN** the rules of the main agent hold "Do not propose a next step unless the user asks for one."

#### Scenario: The tools in the mode off
- **WHEN** the mode is `off`
- **THEN** the main agent has the tool `agents_spawn`, and it does not have the tools `agents_suggest` and `agents_feedback`

#### Scenario: The stored decisions in the mode off
- **WHEN** the mode is `off`
- **THEN** the state still holds the proposal decisions, and it can read and write them

### Requirement: Rules of the mode ghost
The mode `ghost` MUST give the rules of `resources/instructions-suggestions-ghost.md` and the two tools. The rules MUST forbid a proposal in the reply text that the user did not ask for. They MUST ask for at most one call of `agents_suggest` in a turn, with one short prompt in the voice and the language of the user, and for no call when no next step is clearly useful.

Tests: `test/suggestions.test.mjs`

#### Scenario: The rules of the mode ghost
- **WHEN** the mode is `ghost`
- **THEN** the rules of the main agent hold "Do not propose a next step in the reply text unless the user asks for one." and "Write the suggestion as a prompt of the user"

## REMOVED Requirements

### Requirement: No next step by default
**Reason**: The default of `reply.suggestions` becomes `ghost`. The rule "Do not propose a next step unless the user asks for one." now applies only in the mode `off`.
**Migration**: None. The requirement "The mode off" holds the rule and its scenario.

## ADDED Requirements

### Requirement: Next step that the user asks for in the mode ghost
In the mode `ghost`, when the user asks for a next step, the rules MUST ask for the answer in the reply text, as for each other question. A prompt suggestion MAY follow the answer.

Tests: `test/suggestions.test.mjs`

#### Scenario: A request for a next step
- **WHEN** the mode is `ghost`
- **THEN** the rules of the main agent hold "When the user asks for a next step, such as \"what next?\", answer in the reply text." and "You can also give a suggestion after that answer."

### Requirement: Setup rules of the mode ghost
In the mode `ghost`, while the onboarding is pending, the rules of the main agent MUST hold the rules of `resources/instructions-onboarding-ghost.md` after the setup rules (see the capability `settings`). The tool result of the status `pending` MUST hold them too. In the modes `off` and `reply`, and after the status `done` or `skipped`, the rules MUST NOT hold them.

Tests: `test/suggestions.test.mjs`

#### Scenario: A first start
- **WHEN** the state directory has no `settings.json` and no variable is set
- **THEN** the rules hold "The setup of Megachat is pending." and "While a setup question waits for an answer, give the likely answer as a prompt suggestion."

#### Scenario: A pending onboarding in the mode reply
- **WHEN** the onboarding is pending and the mode is `reply`
- **THEN** the rules hold "The setup of Megachat is pending.", and they do not hold "While a setup question waits for an answer"

#### Scenario: The end of the setup
- **WHEN** the mode is `ghost` and the agent sets the status of the onboarding to `done`
- **THEN** the next turn has no rule "While a setup question waits for an answer"

#### Scenario: A new setup
- **WHEN** the mode is `ghost` and the agent sets the status of the onboarding to `pending`
- **THEN** the tool result holds "The setup of Megachat is pending." and "While a setup question waits for an answer"

### Requirement: Prompt suggestion of a setup question
The added setup rules MUST ask for one call of `agents_suggest` in the reply that offers the setup and in each reply that ends with a setup question. The text MUST be the likely answer as a prompt of the user, in the language of the user. It MUST keep the current values, and it MUST NOT turn on a setting that the setup turns on only when the user agrees. The gate of `agents_suggest` MUST stay as in each other turn.

Tests: `test/suggestions.test.mjs`

#### Scenario: The text of the rules
- **WHEN** a test reads `resources/instructions-onboarding-ghost.md`
- **THEN** it holds "call agents_suggest one time with the likely answer" and "Keep the current values", and it names no setting key

#### Scenario: A setup question
- **WHEN** the onboarding is pending, the mode is `ghost`, and the main agent replies "Which agent runs a new child task? The current value is claude." and calls `agents_suggest` with "Keep the current values"
- **THEN** the view gets the prompt suggestion "Keep the current values", and no `agent_message_chunk` holds that text

#### Scenario: A setup question after a request for silence
- **WHEN** the onboarding is pending, the mode is `ghost`, the main agent called `agents_feedback(decision="silence")`, and a later setup turn calls `agents_suggest` with "Keep the current values"
- **THEN** the call gets `allowed=false`, and the turn sends no prompt suggestion

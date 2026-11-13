## MODIFIED Requirements

### Requirement: Prompt suggestion of a setup question
The added setup rules MUST ask for one call of `agents_suggest` in the reply that offers the setup and in each reply that ends with a setup question. The text MUST be the likely answer as a prompt of the user, in the language of the user. It MUST keep the current values: for the pair of agents, the current pair. It MUST NOT turn on a setting that the setup turns on only when the user agrees. The gate of `agents_suggest` MUST stay as in each other turn.

Tests: `test/suggestions.test.mjs`

#### Scenario: The text of the rules
- **WHEN** a test reads `resources/instructions-onboarding-ghost.md`
- **THEN** it holds "call agents_suggest one time with the likely answer", "Keep the current values" and "For the pair of agents, the likely answer is the current pair", and it names no setting key

#### Scenario: A setup question
- **WHEN** the onboarding is pending, the mode is `ghost`, and the main agent replies "Which agents do you want: Opus + Claude, or Opus + Codex on GPT-6 Astra? Now it is Opus + Claude." and calls `agents_suggest` with "Opus + Claude"
- **THEN** the view gets the prompt suggestion "Opus + Claude", and no `agent_message_chunk` holds only that text

#### Scenario: A setup question after a request for silence
- **WHEN** the onboarding is pending, the mode is `ghost`, the main agent called `agents_feedback(decision="silence")`, and a later setup turn calls `agents_suggest` with "Keep the current values"
- **THEN** the call gets `allowed=false`, and the turn sends no prompt suggestion

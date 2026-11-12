# Spec Delta

## ADDED Requirements

### Requirement: Reflection
A reflection pass MUST read the retained conversation after the last pass, at most the newest 60,000 characters, with its own prompt and no prompt cache, and MUST only add entries, at most 5 for each pass. Each add MUST go through the checks and the cap of a write of the tool. A change or a removal MUST be a proposal in the next reply, at most 3. With `memory.reflection` `false`, a pass MUST NOT run.

Tests: `test/memory-reflection.test.mjs`, `test/settings.test.mjs`

#### Scenario: A pass that adds and proposes
- **WHEN** the user said "From now on, answer in German." and the model of the reflection answers `add user: The user wants answers in German.` and `propose: Remove "The user wants answers in English."`
- **THEN** `memory.md` gets the German entry, it keeps the English entry, and the next turn gets the line of the add and the proposal

### Requirement: Time of a reflection pass
A pass MUST start only when no turn runs and the last turn ended 60 seconds ago: after a summary, and after 10 user turns since the last pass. A turn of the user MUST stop a pass that runs, and that pass MUST stay due. A pass that fails MUST wait for 10 more user turns. The position of the last pass MUST stay in the state.

Tests: `test/memory-reflection.test.mjs`, `test/upgrade.test.mjs`

#### Scenario: A user message during a pass
- **WHEN** a pass runs after 10 user turns, and the user sends a message
- **THEN** the reflection request stops, the turn of the user starts at once, and the pass runs again after the end of that turn and 60 seconds

### Requirement: Notice of the reflection in the next reply
The rules of the next turn MUST hold the line of each add of a pass and each proposal, and ask the agent to tell them in its reply. The lines MUST go away after a completed turn that had them.

Tests: `test/memory-reflection.test.mjs`

#### Scenario: The notice goes away
- **WHEN** a pass added an entry, and then two turns complete
- **THEN** the prompt section of the first turn holds the line of the add, and the second turn does not hold it

### Requirement: Reflection and the daily spend
Each reflection request MUST count in the daily spend of the main agent. A pass MUST NOT start when the spend of the day is above a daily limit that is not 0.

Tests: `test/memory-reflection.test.mjs`, `test/spend.test.mjs`

#### Scenario: A pass above the limit
- **WHEN** `budget.dailyUsd` is `1`, the spend of the day is 1.5 USD, and 10 user turns ended
- **THEN** no reflection request goes out

## MODIFIED Requirements

### Requirement: List of the settings of the reply
The settings of the reply MUST be these, with the variable of a setting in brackets:
- `reply.suggestions` (`MEGACHAT_SUGGESTIONS`)
- `reply.language`
- `reply.length`
- `reply.quoteRequest`

The capabilities `child-settings` (`children.*`), `project-settings`, `spend-limit` (`budget.dailyUsd`), `projects` (`projects.newRoot`) and `learned-memory` (`memory.characters`, `memory.reflection`) and the requirement "Settings of the index of past sessions" give the other settings.

Tests: `test/settings.test.mjs`

#### Scenario: The defaults of the reply
- **WHEN** no variable is set and no value is stored
- **THEN** `reply.suggestions` is `off`, `reply.language` is `auto`, `reply.length` is `short` and `reply.quoteRequest` is `false`

#### Scenario: The variable of the suggestions
- **WHEN** `MEGACHAT_SUGGESTIONS` is `ghost`
- **THEN** `reply.suggestions` is `ghost`

#### Scenario: The defaults of the memory
- **WHEN** no value is stored
- **THEN** `memory.characters` is `4000` and `memory.reflection` is `true`, and a value of `999` for `memory.characters` is refused with the code `settingValue`

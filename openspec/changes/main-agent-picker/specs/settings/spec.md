# Spec Delta

## ADDED Requirements

### Requirement: Choice of the main agent in Air
Megachat MUST answer `session/new` and `session/load` with `configOptions`: `model` with the category `model` and `thought_level` with the category `thought_level`, each with its current value. The models are the Claude Fable, Opus and Sonnet models of the registry without a date suffix, and the current model. The levels are those that the current model supports.

Tests: `test/main-agent-picker.test.mjs`

#### Scenario: The options of a new session
- **WHEN** Air opens a session, and the main agent is Claude Opus 5.5 with the level `low`
- **THEN** `configOptions` holds `model` with the value `anthropic/claude-opus-5-5`, and `thought_level` with the value `low` and the levels `low`, `medium`, `high`, `xhigh` and `max`

### Requirement: A choice stores the setting
`session/set_config_option` for `model` or `thought_level` MUST store the value in `coordinator.model` or `coordinator.thinking`, and answer with the full `configOptions`. Each open view MUST get `config_option_update` with the new options, also after a change by `agents_settings`. A model that does not support the stored level MUST get the next level that the new model supports. Children settings MUST NOT change.

Tests: `test/main-agent-picker.test.mjs`

#### Scenario: A level is stored
- **WHEN** Air sets `thought_level` to `high`
- **THEN** `settings.json` holds `coordinator.thinking` `high`, the answer holds `high`, and a second view gets `config_option_update`

#### Scenario: A model with fewer levels
- **WHEN** the level is `xhigh` and Air sets `model` to `anthropic/claude-opus-4-6`
- **THEN** the stored level is `max`, the next level that Claude Opus 4.6 supports (it has no `xhigh`)

### Requirement: Refusal of an invalid choice
Megachat MUST refuse `session/set_config_option` with a JSON-RPC error `-32602` and a clear text when the option is unknown, or when the value is not in the list of the option. A refusal MUST NOT change a setting.

Tests: `test/main-agent-picker.test.mjs`

#### Scenario: A model outside the list
- **WHEN** Air sets `model` to `anthropic/claude-haiku-5-5`, or `thought_level` to `off` for Claude Opus 5.5
- **THEN** Megachat answers with the error `-32602` and `settings.json` is unchanged

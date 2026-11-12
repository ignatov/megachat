# settings Specification

## Purpose
Megachat keeps its settings in a file of its own in the state directory. The user reads and changes the settings through the main agent with the tool `agents_settings`, and a setup asks for them at the first start.

## Requirements

### Requirement: Settings file
Megachat MUST keep its settings in `settings.json` in the state directory, apart from the conversation. A daemon restart and a compaction MUST NOT lose a setting.

The file MUST have the mode 0600. The daemon MUST write it to a temporary file and rename that file, so a crash cannot leave a partial file.

Tests: `test/settings.test.mjs`

#### Scenario: The first answer writes a private file
- **WHEN** the state directory has no `settings.json` and the agent sets `reply.length` to `detailed`
- **THEN** `settings.json` has the mode 0600

#### Scenario: A compaction keeps a setting
- **WHEN** the agent sets `reply.language` to `Deutsch` and a compaction of the conversation runs
- **THEN** the next request has the rule "Write each answer in Deutsch", and `settings.json` keeps the value `Deutsch`

### Requirement: Content of the settings file
The file `settings.json` MUST hold the schema 1, the status of the onboarding, and the stored values. It can hold the project values under the key `projects`. A stored key that this build does not know MUST stay in the file.

Tests: `test/settings.test.mjs`

#### Scenario: The first answer
- **WHEN** the state directory has no `settings.json` and the agent sets `reply.length` to `detailed`
- **THEN** `settings.json` holds `{ "schema": 1, "onboarding": "pending", "values": { "reply.length": "detailed" } }`

#### Scenario: An unknown key stays in the file
- **WHEN** `settings.json` holds the key `future.key` and the agent sets `reply.length` to `normal`
- **THEN** `settings.json` holds `future.key` and `reply.length`

### Requirement: Unreadable settings file
A file that the daemon cannot read MUST stay next to it as `settings.json.unreadable-<UTC time>`. The log MUST give the reason without the content, and the defaults MUST apply.

Tests: `test/settings.test.mjs`

#### Scenario: A file with incomplete JSON
- **WHEN** `settings.json` holds `{ "schema": 1, "onboarding": `
- **THEN** the file moves to `settings.json.unreadable-<UTC time>` with the same content, the log has one line "Megachat cannot read settings.json (json). The file is now settings.json.unreadable-...", the onboarding is pending and the defaults apply

#### Scenario: A file with another schema
- **WHEN** `settings.json` holds the schema 2
- **THEN** the file moves to `settings.json.unreadable-<UTC time>`, and the log gives the reason `schema`

### Requirement: Stored value that this build does not accept
A stored value that this build does not accept MUST give the default. The file MUST keep that value.

Tests: `test/settings.test.mjs`

#### Scenario: An invalid cache lifetime
- **WHEN** `settings.json` holds the value `1d` for `cache.ttl`
- **THEN** `agents_settings get` gives `cache.ttl` with the value `1h` and the source `default`, and the file keeps `1d`

### Requirement: Effective value
The effective value of a setting MUST be the environment variable, else the project value for a child run, else the stored value, else the default. A variable that the daemon cannot read MUST have no effect.

Tests: `test/settings.test.mjs`

#### Scenario: A variable wins over the stored value
- **WHEN** `MEGACHAT_KEEPALIVE` is `0` and the agent sets `keepAlive.enabled` to `true`
- **THEN** the value is `false` with the source `environment`, the stored value is `true`, and the keep-alive does not run

#### Scenario: A variable that the daemon cannot read
- **WHEN** `MEGACHAT_KEEPALIVE_HOURS` is `many` and no value is stored
- **THEN** `keepAlive.hours` is `6` with the source `default`

### Requirement: Description of the settings
The tool `agents_settings` MUST give each setting with its value, its source (`environment`, `project`, `setting` or `default`), its default, its variable, the allowed values or the range, a description, and when a change applies.

It MUST say when a variable hides a stored value. A caller of the service MAY give an explicit value for a test, with the source `option`.

Tests: `test/settings.test.mjs`

#### Scenario: A variable hides a stored value
- **WHEN** `MEGACHAT_CACHE_TTL` is `5m` and the agent sets `cache.ttl` to `1h`
- **THEN** the result has the value `5m`, the source `environment` and a note that the environment variable `MEGACHAT_CACHE_TTL` wins over the stored value

#### Scenario: A value for a test
- **WHEN** a caller of the service gives the value `1h` for `cache.ttl` and `MEGACHAT_CACHE_TTL` is `5m`
- **THEN** `cache.ttl` has the source `option`

#### Scenario: A description and the time of a change for each setting
- **WHEN** the agent calls `agents_settings get`
- **THEN** each setting has its description and its `applies` text, and its allowed values or its range

### Requirement: Change of a setting
The tool `agents_settings` MUST store a valid value at once, remove a stored value, and set the status of the onboarding. It MUST refuse an unknown key and an invalid value as each other tool refuses an invalid request.

Tests: `test/settings.test.mjs`

#### Scenario: Store and remove a value
- **WHEN** the agent sets `keepAlive.hours` to `2` and then removes the stored value
- **THEN** the first result has the value `2` with the source `setting`, and the second result has the value `6` with the source `default`

#### Scenario: An unknown key and an invalid value
- **WHEN** the agent sets `coordinator.color` to `red`, or `keepAlive.hours` to `169`
- **THEN** the tool refuses the key with the code `settingKey`, and the value with the code `settingValue`

### Requirement: No change from an automatic turn
A turn of a child result or of the summary of the past sessions MUST NOT change a setting or the status of the onboarding.

Tests: `test/settings.test.mjs`

#### Scenario: A turn of a child result
- **WHEN** the turn of a child result calls `agents_settings` to set `reply.length` to `detailed`
- **THEN** `settings.json` has no value for `reply.length`, and the tool result says that an automatic turn cannot change a setting

### Requirement: List of the settings of the main agent
The settings of the main agent, of the keep-alive, of the cache and of the summary MUST be these, with the variable of a setting in brackets:
- `coordinator.model`
- `coordinator.thinking`
- `keepAlive.enabled` (`MEGACHAT_KEEPALIVE`)
- `keepAlive.hours` (`MEGACHAT_KEEPALIVE_HOURS`)
- `cache.ttl` (`MEGACHAT_CACHE_TTL`)
- `compaction.tokens` (`MEGACHAT_COMPACT_TOKENS`)

Tests: `test/settings.test.mjs`

#### Scenario: The defaults of the main agent
- **WHEN** no variable is set and no value is stored
- **THEN** `coordinator.model` is `anthropic/claude-opus-5-5`, `coordinator.thinking` is `low`, `keepAlive.enabled` is `true`, `keepAlive.hours` is `6` and `compaction.tokens` is `100000`

#### Scenario: A variable of a setting
- **WHEN** `MEGACHAT_COMPACT_TOKENS` is `40000`
- **THEN** `agents_settings get` gives `compaction.tokens` with the value `40000`, the source `environment` and the variable `MEGACHAT_COMPACT_TOKENS`

### Requirement: List of the settings of the working day and the morning report
The settings of the working day and of the morning report MUST be these:
- `workday.enabled`
- `workday.start`
- `workday.end`
- `workday.days`
- `workday.timezone`
- `workday.idleMinutes`
- `report.morning`

Tests: `test/settings.test.mjs`

#### Scenario: The defaults of the working day and the morning report
- **WHEN** no variable is set and no value is stored
- **THEN** `workday.enabled` is `false`, `workday.start` is `09:00`, `workday.end` is `19:00`, `workday.days` is `mon` to `fri`, `workday.idleMinutes` is `30` and `report.morning` is `false`

### Requirement: List of the settings of the reply
The settings of the reply MUST be these, with the variable of a setting in brackets:
- `reply.suggestions` (`MEGACHAT_SUGGESTIONS`)
- `reply.language`
- `reply.length`
- `reply.quoteRequest`

The capabilities `child-settings` (`children.*`), `project-settings`, `spend-limit` (`budget.dailyUsd`), `projects` (`projects.newRoot`) and `learned-memory` (`memory.characters`) and the requirement "Settings of the index of past sessions" give the other settings.

Tests: `test/settings.test.mjs`

#### Scenario: The defaults of the reply
- **WHEN** no variable is set and no value is stored
- **THEN** `reply.suggestions` is `off`, `reply.language` is `auto`, `reply.length` is `short` and `reply.quoteRequest` is `false`

#### Scenario: The variable of the suggestions
- **WHEN** `MEGACHAT_SUGGESTIONS` is `ghost`
- **THEN** `reply.suggestions` is `ghost`

#### Scenario: The defaults of the memory
- **WHEN** no value is stored
- **THEN** `memory.characters` is `4000`, and a value of `999` for `memory.characters` is refused with the code `settingValue`

### Requirement: Settings of the index of past sessions
The settings of the index of past sessions are `sessions.index`, `sessions.days` and `sessions.notes`. They MUST apply at once, also in the middle of a turn, because they change no model request.

Tests: `test/settings.test.mjs`

#### Scenario: The defaults of the index
- **WHEN** no variable is set and no value is stored
- **THEN** `sessions.index` is `off`, `sessions.days` is `180` and `sessions.notes` is `off`

#### Scenario: A setting of the index in a turn
- **WHEN** a tool call in a turn sets `sessions.days` to `30`
- **THEN** the value `30` applies at once, before the turn ends

### Requirement: Model and reasoning level
A model MUST be valid only when the model registry knows it, except a model of `children.claudeModel` or of `children.codexModel`. A reasoning level MUST be a level of pi-ai that the model supports.

The output of `get` MUST list each model of the registry with the prices of its model data, and one note with the measurement of Claude Opus 5.5. It MUST give no measurement of another model.

Tests: `test/settings.test.mjs`

#### Scenario: A model that the registry does not know
- **WHEN** the registry has only the models `faux/fast` and `faux/deep`, and the agent sets `coordinator.model` to `anthropic/claude-opus-5-5`
- **THEN** the tool refuses the value

#### Scenario: A model of a child that the registry does not know
- **WHEN** the registry does not know `anthropic/claude-unknown-9` and `openai/gpt-unknown-9`, and the agent sets `children.claudeModel` and `children.codexModel` to them
- **THEN** the tool stores each value

#### Scenario: A level that the model does not support
- **WHEN** the model is Claude Opus 5.5 and the agent sets `coordinator.thinking` to `off`
- **THEN** the tool refuses the value, and `get` gives the levels `low`, `medium`, `high`, `xhigh` and `max`

#### Scenario: The models with their prices
- **WHEN** the agent calls `agents_settings get`
- **THEN** `coordinator.model` lists `faux/fast` and `faux/deep`, `faux/deep` has the prices `input` 4, `output` 20, `cacheRead` 0.2 and `cacheWrite` 5, and the note says that the median turn of `anthropic/claude-opus-5-5` took 2.8 s and cost about 0.013 USD

### Requirement: Time of a change
A changed setting MUST apply at once when no turn runs, else at the end of the current turn, before the next turn starts. A change MUST NOT apply in the middle of a turn. A setting with another time in its `applies` text, such as a setting of the children, MUST apply at that time.

Tests: `test/settings.test.mjs`

#### Scenario: A change in a turn waits for its end
- **WHEN** a turn with the model `faux/fast` and the level `low` sets `coordinator.model` to `faux/deep` and `coordinator.thinking` to `high`
- **THEN** the next request of that turn uses `faux/fast` and `low`, and the first request of the next turn uses `faux/deep` and `high`

### Requirement: Changes without a restart
The model and the reasoning level MUST reach the next model request without a restart. A keep-alive request MUST use the same model and level as the turns.

The keep-alive, the cache lifetime, the limit of a summary and the working day MUST take the stored value without a restart.

The setting `reply.suggestions` MUST change the rules and the suggestion tools of the running main agent.

Tests: `test/settings.test.mjs`

#### Scenario: A keep-alive request uses the model of the turns
- **WHEN** the stored model is `faux/deep` with the level `medium`, and a keep-alive request goes out after a turn
- **THEN** the keep-alive request uses `faux/deep` and `medium`

#### Scenario: A new cache lifetime in a running daemon
- **WHEN** the stored `cache.ttl` is `5m` and the agent sets it to `1h`
- **THEN** the next request has the cache retention `long`

#### Scenario: Suggestions on and off
- **WHEN** the agent sets `reply.suggestions` to `on`, and later to `off`
- **THEN** the main agent first has the tool `agents_suggest`, and then it does not have it

### Requirement: Reply style
The reply style MUST give lines of the rules of the main agent: the language, the length, and a quote of the original request in a report of a child result. The defaults MUST give the rules from before the settings.

The rules that the settings give MUST be a section of their own, so a change sends only that section to the model again.

Tests: `test/settings.test.mjs`

#### Scenario: The defaults
- **WHEN** no reply style is stored
- **THEN** the rules have "Keep answers short." and "Use the user's language.", and no quote of the original request

#### Scenario: A changed reply style
- **WHEN** the agent sets `reply.language` to `Deutsch`, `reply.length` to `normal` and `reply.quoteRequest` to `true`
- **THEN** the rules have "Write each answer in Deutsch, unless the user asks for another language.", "Give complete answers of a usual length." and a line that quotes the original request of the user, and they do not have "Keep answers short."

#### Scenario: Only the section of the settings goes again
- **WHEN** the agent sets the status of the onboarding to `done`
- **THEN** the next request sends again only the section `settings`

### Requirement: Pending onboarding
Without `settings.json`, the onboarding MUST be pending. The rules of the main agent MUST then hold the setup rules of `resources/instructions-onboarding.md`.

Tests: `test/settings.test.mjs`

#### Scenario: No settings file
- **WHEN** the state directory has no `settings.json`
- **THEN** `agents_settings get` gives the onboarding `pending`, and the rules hold "The setup of Megachat is pending."

### Requirement: Content of the setup rules
The setup rules MUST tell the agent to answer the user first and then offer the setup one time, to ask one question at a time with its default, to let the user skip one question or the setup, to store each answer at once, and to mark the onboarding done at the end. They MUST name only the settings of this build.

Tests: `test/settings.test.mjs`

#### Scenario: The settings in the setup rules
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** the setting keys that it names are the keys of the settings of this build

### Requirement: End of the onboarding
After the status `done` or `skipped`, the setup rules MUST NOT come back by themselves, also after a restart. The rules MUST then say that the agent changes a setting or runs the setup again when the user asks.

The status `pending` MUST bring the setup rules back. The tool result MUST hold them, so the setup can start in the same turn.

Tests: `test/settings.test.mjs`

#### Scenario: Done stays after a restart
- **WHEN** the agent sets the status of the onboarding to `done` and the daemon restarts
- **THEN** the rules do not hold the setup rules, and they hold "Read or change a setting of Megachat with agents_settings only when the user asks."

#### Scenario: Pending brings the setup back
- **WHEN** the agent sets the status of the onboarding to `pending`
- **THEN** the tool result holds the setup rules, and the next turn has the setup rules

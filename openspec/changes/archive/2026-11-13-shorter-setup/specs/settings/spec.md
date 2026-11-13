## MODIFIED Requirements

### Requirement: Change of a setting
The tool `agents_settings` MUST store a valid value at once, remove a stored value, set the status of the onboarding, and record an offer of a setting (see the capability `setting-offers`). It MUST refuse an unknown key and an invalid value as each other tool refuses an invalid request.

Tests: `test/settings.test.mjs`, `test/setting-offers.test.mjs`

#### Scenario: Store and remove a value
- **WHEN** the agent sets `keepAlive.hours` to `2` and then removes the stored value
- **THEN** the first result has the value `2` with the source `setting`, and the second result has the value `6` with the source `default`

#### Scenario: An unknown key and an invalid value
- **WHEN** the agent sets `coordinator.color` to `red`, or `keepAlive.hours` to `169`
- **THEN** the tool refuses the key with the code `settingKey`, and the value with the code `settingValue`

### Requirement: No change from an automatic turn
A turn of a child result or of the summary of the past sessions MUST NOT change a setting or the status of the onboarding. The record of an offer MUST work in such a turn, because it changes no setting.

Tests: `test/settings.test.mjs`, `test/setting-offers.test.mjs`

#### Scenario: A turn of a child result
- **WHEN** the turn of a child result calls `agents_settings` to set `reply.length` to `detailed`
- **THEN** `settings.json` has no value for `reply.length`, and the tool result says that an automatic turn cannot change a setting

#### Scenario: An offer in a turn of a child result
- **WHEN** the turn of a child result calls `agents_settings(action="offer", key="children.push")`
- **THEN** the result has `allowed: true` and the value `ask`, and `settings.json` does not change

### Requirement: Content of the setup rules
The setup rules MUST tell the agent to answer the user first and then offer the setup one time, to ask one question at a time with its default, to let the user skip one question or the setup, to store each answer at once, and to mark the onboarding done at the end. They MUST ask only for the pair of agents, which changes only the children, the index of past sessions and the known repositories. The end MUST say that each setting can change later in the chat.

Tests: `test/settings.test.mjs`

#### Scenario: The settings in the setup rules
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** the setting keys that it names are `coordinator.model`, `children.agent`, `children.codexModel` and `sessions.index`

#### Scenario: The pairs of agents
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "+ Claude" with `children.agent` `claude`, "+ Codex on GPT-6 Astra" with `children.agent` `codex` and `children.codexModel` `openai/gpt-6-astra`, and "Do not change coordinator.model"

#### Scenario: The values of the pair with Codex
- **WHEN** `coordinator.model` is `faux/deep`, and the agent stores the answers of the pair with Codex: `children.agent` `codex` and `children.codexModel` `openai/gpt-6-astra`
- **THEN** `children.agent` is `codex`, `children.codexModel` is `openai/gpt-6-astra`, and `coordinator.model` stays `faux/deep`

#### Scenario: The closing text
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "tell the user that each setting can change later in the chat"

### Requirement: End of the onboarding
After the status `done` or `skipped`, the setup rules MUST NOT come back by themselves, also after a restart. The rules MUST then say that the agent changes a setting or runs the setup again when the user asks, and that it offers a setting only as the offer rules say.

The status `pending` MUST bring the setup rules back. The tool result MUST hold them, so the setup can start in the same turn.

Tests: `test/settings.test.mjs`

#### Scenario: Done stays after a restart
- **WHEN** the agent sets the status of the onboarding to `done` and the daemon restarts
- **THEN** the rules do not hold the setup rules, and they hold "Read or change a setting of Megachat with agents_settings only when the user asks, or for an offer of the offer rules."

#### Scenario: Skipped stays after a restart
- **WHEN** `settings.json` holds the onboarding `skipped` and the daemon starts
- **THEN** the rules do not hold the setup rules

#### Scenario: Pending brings the setup back
- **WHEN** the agent sets the status of the onboarding to `pending`
- **THEN** the tool result holds the setup rules, and the next turn has the setup rules

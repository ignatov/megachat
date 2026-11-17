## MODIFIED Requirements

### Requirement: Content of the setup rules
The setup rules MUST tell the agent to answer the user first and then offer the setup one time, unless the conversation holds the setup note of Megachat, which is the offer. They MUST tell it to ask one question at a time with its default, let the user skip, store each answer at once, and mark the onboarding done at the end. They MUST ask only for the pair of agents, the index of past sessions, the known repositories and the folder of new projects. The end MUST say that each setting can change later in the chat.

Tests: `test/settings.test.mjs`, `test/onboarding.test.mjs`

#### Scenario: The settings in the setup rules
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** the setting keys that it names are `coordinator.model`, `children.agent`, `children.codexModel`, `sessions.index` and `projects.newRoot`

#### Scenario: The pairs of agents
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "+ Claude" with `children.agent` `claude`, "+ Codex on GPT-6 Astra" with `children.agent` `codex` and `children.codexModel` `openai/gpt-6-astra`, and "Do not change coordinator.model"

#### Scenario: The values of the pair with Codex
- **WHEN** `coordinator.model` is `faux/deep`, and the agent stores the answers of the pair with Codex: `children.agent` `codex` and `children.codexModel` `openai/gpt-6-astra`
- **THEN** `children.agent` is `codex`, `children.codexModel` is `openai/gpt-6-astra`, and `coordinator.model` stays `faux/deep`

#### Scenario: The closing text
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "tell the user that each setting can change later in the chat"

#### Scenario: The note is the offer
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "Do not offer the setup again when the conversation holds the note that starts with Welcome to Megachat."

#### Scenario: The folder of new projects
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** question 4 asks for `projects.newRoot` with a numbered list, proposes the folder that the user named in question 3, takes an absolute path or a path that starts with `~/`, and stores nothing when the user skips it or keeps the current value

#### Scenario: A stored folder of new projects
- **WHEN** the agent stores `~/dev` for `projects.newRoot`
- **THEN** `agents_settings get` gives `~/dev` with the source `setting`, and the value stays after a restart

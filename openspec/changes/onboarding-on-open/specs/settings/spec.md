# Spec Delta

## ADDED Requirements

### Requirement: Setup note on its own
A daemon with the onboarding `pending` and a conversation with no entry and no input MUST write one note of Megachat on its own, with no model request. The note MUST offer the setup with its three questions, the skip and the defaults. It MUST go out only when no turn runs, no run is live and the inbox is empty, else the daemon MUST try again each 10 seconds. The note MUST come once, also after a restart or a reconnect.

Tests: `test/onboarding.test.mjs`

#### Scenario: A fresh install
- **WHEN** the daemon starts with no state and no `settings.json`
- **THEN** the conversation holds one note that starts with "Welcome to Megachat", with no model request, and a second start adds no note

#### Scenario: A running turn
- **WHEN** a turn runs at the start of the daemon
- **THEN** the note waits, and it comes when the turn ends

#### Scenario: The user writes first
- **WHEN** the user sends a message before the note
- **THEN** the note never comes, and the main agent offers the setup in its reply as before

#### Scenario: Done, skipped and an old conversation
- **WHEN** the onboarding is `done` or `skipped`, or the conversation has an entry at the first start of this build
- **THEN** the daemon writes no note

## MODIFIED Requirements

### Requirement: Content of the setup rules
The setup rules MUST tell the agent to answer the user first and then offer the setup one time, unless the conversation holds the setup note of Megachat, which is the offer. They MUST tell it to ask one question at a time with its default, let the user skip, store each answer at once, and mark the onboarding done at the end. They MUST ask only for the pair of agents, the index of past sessions and the known repositories. The end MUST say that each setting can change later in the chat.

Tests: `test/settings.test.mjs`, `test/onboarding.test.mjs`

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

#### Scenario: The note is the offer
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "Do not offer the setup again when the conversation holds the note that starts with Welcome to Megachat."

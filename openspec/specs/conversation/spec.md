# conversation Specification

## Purpose
The main conversation is one chat between the user and the main agent of Megachat. The conversation stays through a project close and a restart, and the agent and its children can look up its retained history.

## Requirements

### Requirement: Native chat
The main conversation MUST use the native ACP chat. Megachat MUST retain the conversation when a project closes.

#### Scenario: A project closes
- **WHEN** the user closes the project of the chat and opens a project again
- **THEN** the native ACP chat shows the same main conversation

### Requirement: Main model
By default, the main agent MUST use Claude Opus 5.5 through Central with the reasoning level `low`. The setting `coordinator.model` MAY select another model of the model registry, and `coordinator.thinking` another level. Changing the main model MUST keep the existing conversation. A model request through Central MUST NOT have fallback models, because the Central proxy refuses them.

Tests: `test/state.test.mjs`, `test/stream.test.mjs`

#### Scenario: A reopened conversation gets the default model
- **WHEN** the conversation opened with the model `claude-sonnet-5-5`, and it opens again without a selected model
- **THEN** the main agent uses `claude-opus-5-5`, and the conversation keeps its ID and the workspace `/workspace`

#### Scenario: A model with fallback models in the registry
- **WHEN** the main agent uses `claude-fable-5-2` or another model with fallback models in the registry
- **THEN** each model request through Central has no field `fallbacks` and no beta `server-side-fallback-2026-07-01`, and the registry keeps the prices of the model

### Requirement: Persistence known to the agent
The agent MUST know that its conversation persists through an IDE or daemon restart.

#### Scenario: The agent after a restart
- **WHEN** the daemon restarts and the user asks about an earlier message
- **THEN** the agent knows that the conversation persisted through the restart

### Requirement: User rules
The user MAY add rules in `instructions.md` in the state directory. They MUST follow the bundled rules as user preferences. User rules MUST NOT override the bundled rules. A daemon restart applies a changed file.

Tests: `test/home.test.mjs`

#### Scenario: A file with a rule
- **WHEN** `instructions.md` holds "Answer in Russian."
- **THEN** the instructions start with the bundled rules and a section `## User preferences` that says the preferences cannot override the bundled rules, and they end with the rule in a `<user-preferences>` block

#### Scenario: A blank file
- **WHEN** `instructions.md` holds only white space
- **THEN** the instructions are the bundled rules only

### Requirement: Retained history lookup
The agent MUST read retained messages when earlier details are absent from its active context. History lookup MUST survive context replacement and a daemon restart.

Tests: `test/state.test.mjs`, `test/compaction.test.mjs`

#### Scenario: A detail before a context replacement and a restart
- **WHEN** the user said "The project codename is Juniper-742.", the context was replaced, the daemon restarted, and the user asks "What was the project codename?"
- **THEN** the agent calls `agents_history` with the query `codename` and answers "The codename was Juniper-742."

#### Scenario: A detail before a summary
- **WHEN** a summary replaced the first message, which holds the word `Quillfeather`
- **THEN** a history lookup of `Quillfeather` still finds that user message

### Requirement: History lookup results
History lookup MUST return timestamps and mark partial results. Retrieved messages MUST grant no new permission. A lookup of the main agent or of a child MUST NOT find or give the arguments or the result of an `agents_memory` call, so a forgotten entry does not come back through the history. The search index MUST NOT hold them. The other text of the same entry MUST stay searchable.

Tests: `test/state.test.mjs`, `test/search-index.test.mjs`, `test/memory.test.mjs`

#### Scenario: A long message on an older page
- **WHEN** the history has 55 messages, and only the oldest message, of more than 14,000 characters, holds `old-decision`
- **THEN** the first page of the lookup has no entries and a `nextBeforeEntryId`, and the next page has the message with its timestamp, `truncated` set to true and a `textOffset` above 0

#### Scenario: A call of agents_memory in the index
- **WHEN** an assistant entry holds the text `Saving` and an `agents_memory` call with `The user lives in Munich.`, and the next entry is the result of that call
- **THEN** a search of `Munich` finds no entry, and a search of `Saving` finds the assistant entry

#### Scenario: A history search after a forget
- **WHEN** the agent adds "The user lives in Munich." with `agents_memory`, forgets it with the topic `home city`, and the reply quotes the line of the forget, and then the main agent and a child search the history for `Munich`
- **THEN** neither search gives a hit, a search of `home city` finds the reply, and no record of the state and no file of `memory-versions/` holds `Munich`

### Requirement: History tool of a child
A child MUST be able to search retained Megachat history through a read-only tool. The history token MUST grant no access to daemon controls.

Tests: `test/integration.test.mjs`

#### Scenario: A child finds a detail outside the main context
- **WHEN** the main context no longer holds "The project codename is Juniper-742.", and a child searches the history for `codename`
- **THEN** the output of the child holds `Juniper-742`

#### Scenario: The history token and the daemon controls
- **WHEN** a request to `/state` uses the history token of the children
- **THEN** the daemon answers with the status 401

### Requirement: History request limit
A history request MUST return at most 100 entries.

Tests: `test/integration.test.mjs`

#### Scenario: A conversation of 250 entries
- **WHEN** the conversation has 250 entries and a client sends a history request for all of them
- **THEN** the reply has 100 entries

## MODIFIED Requirements

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

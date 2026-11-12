# session-history Specification

## Purpose
The main agent and the children can search and read the stored Claude Code and Codex sessions of a project. A read changes no session, and the results tell the caller when they are not complete.

## Requirements

### Requirement: Session search
Session search MUST include Claude Code and Codex unless the caller selects one provider. Search MUST match session titles and message text in the selected project.

Tests: `test/session-history.test.mjs`

#### Scenario: A search of both providers
- **WHEN** a caller searches for `Juniper` in a listed directory and selects no provider
- **THEN** the result has one page for `claude` and one page for `codex`

#### Scenario: A match in the message text
- **WHEN** a stored message of a session has the text "The old Juniper decision."
- **THEN** a search for `Juniper` gives a match with this text

#### Scenario: A directory that is not a project
- **WHEN** a caller searches in a directory that is not a listed directory
- **THEN** the search fails

### Requirement: Read-only access
Reading a stored session MUST start no model turn and MUST NOT resume that session. A child MUST be able to search both providers through read-only tools.

Tests: `test/session-history.test.mjs`

#### Scenario: The tools of a child
- **WHEN** a child lists the tools of the history server of the daemon
- **THEN** the tools are `history`, `sessions` and `session_history`, and each tool has the read-only hint

#### Scenario: A search of a child
- **WHEN** a child calls `sessions` for a listed directory
- **THEN** the result has a page for each of the two providers

### Requirement: Continuation cursors
Long histories MUST provide continuation cursors, including pages without matches. Cursors MUST remain bound to their project, provider, query, and session where applicable.

Tests: `test/session-history.test.mjs`

#### Scenario: A page without matches
- **WHEN** the match for `Juniper` is after the first page of each session
- **THEN** the first page has no match and a cursor, and the page of the cursor has the match

#### Scenario: A cursor of another provider
- **WHEN** a caller gives the cursor of a `claude` search to a `codex` search
- **THEN** the search fails with an invalid cursor

#### Scenario: A long Codex turn
- **WHEN** a Codex session has 25 messages in one turn
- **THEN** the first page has 20 entries, and the page of its cursor has the last 5 entries

### Requirement: Incomplete results
Unavailable histories MUST mark the search incomplete and preserve other matches.

Tests: `test/session-history.test.mjs`

#### Scenario: One unavailable session
- **WHEN** one of two sessions of a search for `Juniper` cannot be read, and the other session has "Juniper decision"
- **THEN** the page has the match of the available session, it is not complete, and it counts 1 unreadable session

### Requirement: Truncated excerpts
Excerpts MUST identify truncated text.

Tests: `test/session-history.test.mjs`

#### Scenario: A match after a long text
- **WHEN** the text "The old Juniper decision." comes after 5000 other characters in a message
- **THEN** the match marks its text as truncated, and it gives an offset of the text that is more than 0

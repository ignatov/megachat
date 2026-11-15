# Spec Delta

## MODIFIED Requirements

### Requirement: Age limit
The import of the texts MUST take the sessions with activity in the last `sessions.days` days, 30 by default. The value 0 MUST take all sessions. A session that becomes older MUST lose its texts at the next pass, and MUST keep its row in the catalog (see the capability `session-catalog`).

Tests: `test/session-index.test.mjs`

#### Scenario: A session older than the limit
- **WHEN** `sessions.days` is 30, and two sessions have their last activity 40 days ago and 20 days ago
- **THEN** only the session of 20 days ago has texts, the import does not read the file of 40 days ago, and the catalog has both

#### Scenario: A session that becomes older
- **WHEN** 15 more days go by, and the next pass runs with `sessions.days` 30
- **THEN** the session, now 35 days old, has no texts and stays in the catalog

#### Scenario: The value 0
- **WHEN** `sessions.days` changes to 0
- **THEN** both sessions have texts

### Requirement: Files that hold no running session
An archived file and a compressed file hold no running session: the size poll and the enrichment of `agents_running` MUST NOT use them. The catalog MUST list them (see the capability `session-catalog`).

Tests: `test/session-index.test.mjs`

#### Scenario: Plain, compressed and archived Codex files
- **WHEN** the catalog holds a plain Codex file, a compressed Codex file and an archived Codex file
- **THEN** `agents_running` uses only the plain file

### Requirement: Version of the index file
An index file of another `VERSION` MUST be made again from the session files. The catalog in the same file MUST be made again too, so each table of the file has the same version. A file of the same version that has the table `logs` MUST keep its texts, and MUST get its rows in the table `catalog`.

Tests: `test/session-index.test.mjs`

#### Scenario: An index file of the version 0
- **WHEN** an index file of the version 0 holds an entry that no session file has
- **THEN** the next start makes the index again, and the index holds only the entry of the session file

#### Scenario: An index file of the version 1
- **WHEN** an index file of the version 1 has a row of the catalog for a file that does not exist
- **THEN** the next start makes both tables again, and the catalog has only the row of the session file that exists

#### Scenario: A file with the table logs
- **WHEN** an index file of the current version has the table `logs` with 5 rows and 3 sessions with texts
- **THEN** the next start gives `catalog` the 5 rows, drops `logs`, and keeps the 3 sessions with their texts

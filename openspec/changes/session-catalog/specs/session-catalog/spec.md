# Spec Delta

## ADDED Requirements

### Requirement: Catalog of the sessions
With the setting `sessions.index` on, Megachat MUST keep a catalog of each session on the machine in the table `catalog` of `sessions.sqlite`, with no age limit. A row MUST have the agent, the session ID, the source, the file path, the project directory, the title, the start and update times, the archive state, and the Air thread and its state.

Tests: `test/session-catalog.test.mjs`

#### Scenario: A session older than the text window
- **WHEN** `sessions.days` is 30, and a Claude Code log has its last write 90 days ago
- **THEN** the catalog has a row of the session with its title and project, and the index has no text of it

#### Scenario: The index is off
- **WHEN** `sessions.index` is `off`
- **THEN** Megachat opens no session file and the catalog has no row

### Requirement: Scan of the catalog
The catalog MUST read a file again only when its inode, size or modification time changed. The first pass MUST read the newest files first, and a result that depends on the whole catalog MUST tell the user while the pass is not complete. A file that cannot be read MUST NOT stop the pass.

Tests: `test/session-catalog.test.mjs`

#### Scenario: An unchanged file
- **WHEN** a second pass runs and no file changed
- **THEN** the pass reads no head and no tail of a file

#### Scenario: A pass that is not complete
- **WHEN** 40 of 55 files are read, and the user asks for the sessions of the project
- **THEN** the result lists the rows that exist and says that the catalog is not complete

#### Scenario: A restart in the middle of the first pass
- **WHEN** the daemon stops after the first pass read 1200 of 2800 files, and starts again with no file changed
- **THEN** the catalog keeps the 1200 rows, the pass reads only the other 1600 files, and `complete` is false until it reads them

### Requirement: Scan of one project
Before an archive by project, the catalog MUST finish the scan of that `cwd` only. For Codex it MUST read `state_5.sqlite` of Codex only as a read-only hint, and MUST check each file by its first `session_meta` line. It MUST read the first line of each Codex file without a row that the hint does not name. Without a usable hint, it MUST read the first line of each Codex file without a row.

Tests: `test/session-catalog.test.mjs`

#### Scenario: A hint with a compressed file
- **WHEN** `state_5.sqlite` names `rollout-a.jsonl` for `/p/air-audit`, and only `rollout-a.jsonl.zst` exists
- **THEN** the scan takes the `.zst` file after its first line gives the ID and `/p/air-audit`

#### Scenario: A session that the hint does not name
- **WHEN** a Codex file of `/p/air-audit` has no catalog row and no row in `state_5.sqlite`
- **THEN** the scan reads its first line and adds it to the project

#### Scenario: No hint
- **WHEN** `state_5.sqlite` does not exist
- **THEN** the scan reads the first line of each Codex file without a row, and the project has the same sessions

#### Scenario: A long project path
- **WHEN** the Claude Code directory of the project ends with a hash, and another directory has the same prefix
- **THEN** the scan keeps only the files whose `cwd` is the project

### Requirement: Sources of the catalog
Each source MUST list its files with one interface and MUST give the metadata of a session from them. The sources MUST be Claude Code, Codex (`sessions` and `archived_sessions`, plain files and `rollout-*.jsonl.zst` files), pi and the Air-only threads. A Codex session with a plain file and a compressed file MUST be one row.

Tests: `test/session-catalog.test.mjs`

#### Scenario: A compressed Codex session
- **WHEN** `sessions` has a `rollout-*.jsonl.zst` file and `archived_sessions` has another
- **THEN** the catalog has a row for each, with the form `zst`, and the second row is archived

#### Scenario: A plain and a compressed file
- **WHEN** one Codex session has a plain file and a compressed file
- **THEN** the catalog has one row of the session, with the plain file

### Requirement: Air threads in the catalog
The catalog MUST read the `summary.json` of each Air thread of the store of Air. A thread whose `association` names a session of the catalog MUST be the link of that row, with its archive state. A thread with no such session MUST be an Air-only row with the source `air`. Megachat MUST NOT write the store of Air.

Tests: `test/session-catalog.test.mjs`

#### Scenario: A linked thread
- **WHEN** a thread has `association.agentSessionId` of a Claude Code log of the project, and `summary.archived` is `false`
- **THEN** the row of the log has the thread and `air_archived` 0

#### Scenario: An Air-only thread
- **WHEN** a thread has no log of an agent
- **THEN** the catalog has a row with the source `air`, and no path

### Requirement: One catalog for all tools
`agents_archive`, `agents_sessions`, the tool `sessions` of a child, `agents_session_history`, `session_history` and the enrichment of `agents_running` MUST find a session in the catalog and in no other list. A session outside the text window MUST be found by its title, ID or project, and its history MUST be read from its file.

Tests: `test/session-catalog.test.mjs`, `test/running.test.mjs`

#### Scenario: A search for an old title
- **WHEN** `sessions.days` is 30, and the session of 90 days ago has the title `Fix the login`
- **THEN** `agents_sessions` with the query `login` gives the session, and says that the texts cover the last 30 days

#### Scenario: The history of an old session
- **WHEN** `agents_session_history` gets the ID of the session of 90 days ago
- **THEN** it reads the entries from the file of the session

### Requirement: Archive by project
`agents_archive` with `archive` MUST take `project`, or `sessions` (at most 50), and not both. With `project` it MUST take each session of the directory that is not archived, except the IDs of `exclude` and the sessions with an activity in the last `updatedWithinHours` hours. It MUST keep the rule of the capability `session-archive` that only a turn of the user archives.

Tests: `test/archive.test.mjs`

#### Scenario: A project with exclusions
- **WHEN** `/p/air-audit` has 55 sessions, `exclude` has 2 IDs, and 3 sessions have an activity 1 hour ago with `updatedWithinHours` 2
- **THEN** the dialog is for 50 sessions

#### Scenario: Sessions and a project together
- **WHEN** a call has `project` and `sessions`
- **THEN** the tool refuses the call and changes nothing

### Requirement: Dialog of a project batch
A project batch MUST have one dialog with the options `archive` and `keep`. It MUST give the count, the count of each agent, the count of warnings, and the first 50 sessions, the newest first, with "and N more" for the rest. The sessions of the confirmed list MUST be the sessions that the tool archives. A batch of more than 500 sessions MUST be refused.

Tests: `test/archive.test.mjs`

#### Scenario: A batch of 120
- **WHEN** a project has 120 sessions to archive
- **THEN** the dialog has 50 lines and "and 70 more", and a session that appears after the answer is not archived

#### Scenario: A batch of 501
- **WHEN** a project has 501 sessions to archive
- **THEN** the tool refuses it before the dialog, and says to use `exclude` or `updatedWithinHours`

### Requirement: Catalog state in the dialog
The dialog of a project batch MUST say that the catalog of the project is complete, or MUST give the count of the files that the scan did not read and their reasons. When the turn stops the scan, the tool MUST build no batch and show no dialog, and the result MUST give the counts that it read.

Tests: `test/archive.test.mjs`

#### Scenario: An unreadable file
- **WHEN** one Claude Code file of the project has no read permission
- **THEN** the dialog says that 1 file was not read, with the reason `unreadable`

#### Scenario: A stopped scan
- **WHEN** the user stops the turn while the scan read 300 of 830 Codex files
- **THEN** no dialog shows, nothing is archived, and the result gives `codex: 300/830`

### Requirement: Report of an archive by project
After a project batch, the result MUST read the store of Air again, and MUST give each remaining session with its reason: `Done in Air` for an Air thread that still shows or an Air-only thread, `live process`, `refused` with the status, or `failed` with the step. Megachat MUST NOT hide an Air-only thread.

Tests: `test/archive.test.mjs`

#### Scenario: Remaining sessions
- **WHEN** a batch has one Air-only thread, one session that works, and 8 other sessions
- **THEN** 8 sessions are archived, the Air-only thread has the reason `Done in Air`, and the session that works has the reason `refused`

#### Scenario: Nothing remains
- **WHEN** each session of the batch is hidden and Air shows none
- **THEN** the result says that no session of the project remains

### Requirement: Codex compressed log in the archive
The archive of a Codex session whose log is a `rollout-*.jsonl.zst` file MUST take the path from the catalog, and MUST hide the session with `codex archive <id>`. It MUST NOT refuse such a session as unknown.

Tests: `test/archive.test.mjs`

#### Scenario: A compressed rollout
- **WHEN** the session `019a` of Codex has only a `.jsonl.zst` file in `sessions`
- **THEN** `archive` writes its card and runs `codex archive 019a`

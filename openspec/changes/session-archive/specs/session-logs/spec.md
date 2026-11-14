# Spec Delta

## MODIFIED Requirements

### Requirement: Read-only access to the provider files
Megachat MUST open each provider file read-only, and MUST write to no provider file. The only exception is the title records of an archive and a restore (see the capability `session-archive`), for a session with no live process.

Tests: `test/session-logs.test.mjs`, `test/archive.test.mjs`

#### Scenario: The files keep their size and modification time
- **WHEN** the live table reads a Claude Code, a Codex and a pi log and the process file `~/.claude/sessions/10.json`, a poll and a watch event run, and `agents_session_history` reads the Codex log from its end
- **THEN** each file keeps its size and its modification time, and Megachat opens each file read-only

#### Scenario: The archive of a session with no process
- **WHEN** the user archives a Claude Code session with no live process
- **THEN** its log gets two title records with the prefix `[archived] `, and no other provider file changes

# Spec Delta

## ADDED Requirements

### Requirement: Archive tool
The main agent MUST have the tool `agents_archive` with the actions `archive`, `restore`, `list` and `search`. `archive` MUST take one session or up to 50, and MUST ask the user once for the whole batch. The tool MUST NOT archive a session without the answer `archive` of the user, also in an automatic turn.

Tests: `test/archive.test.mjs`

#### Scenario: A batch of three
- **WHEN** the main agent calls `agents_archive` with `archive` and three sessions of the bucket `abandoned`
- **THEN** one dialog shows three lines, and nothing changes before the answer

### Requirement: Card of an archived session
Before each other step, Megachat MUST append a card to `session-archive.jsonl` in the state directory, with mode 0600. The card MUST have the title, the project, the dates, the first and the last prompt, the last answer, the commits and the tickets that the log names, the changed files, and the command to continue. No model request MUST make the card.

Tests: `test/archive.test.mjs`

#### Scenario: The card of a Claude Code session
- **WHEN** the log of a session has the prompt "Fix IJAI-6285", a `git commit` output `[main 1a2b3c4]`, and an edit of `src/a.mjs`
- **THEN** the card has the ticket `IJAI-6285`, the commit `1a2b3c4`, the file `src/a.mjs`, and `claude --resume <id>`

### Requirement: Secret filter of a card
Each text field of a card MUST pass the secret filter of the capability `session-index` before the write.

Tests: `test/archive.test.mjs`

#### Scenario: A key in the last prompt
- **WHEN** the last prompt of a session has an API key
- **THEN** the card has the masked text, and the file has no key

### Requirement: Close of an archived session
After the answer `archive`, a live session with the owner `terminal` or `multiplexer` MUST get SIGTERM, then SIGKILL (see the capability `stop-sessions`). A session of an IDE, of a Megachat run or of an unknown owner MUST NOT get a signal: it MUST get its card, and the result MUST name its owner and tell the user to close it there.

Tests: `test/archive.test.mjs`, `test/stop.test.mjs`

#### Scenario: A terminal session and an IDE session
- **WHEN** the user archives a Claude Code session in Terminal and a Claude Code session in `IntelliJ IDEA 2026.3 EAP`
- **THEN** the first gets SIGTERM, and the second gets a card, no signal, and the result names the IDE

### Requirement: Hide of an archived session
When no process of the session lives, Megachat MUST hide it: `codex archive <id>` for Codex, and a title record `[archived] <title>` (`ARCHIVED_TITLE_PREFIX`) for Claude Code and pi, in the format that Air reads. Megachat MUST NOT write a mark while a process of the session lives, and MUST NOT delete or move a file.

Tests: `test/archive.test.mjs`, `test/session-logs.test.mjs`

#### Scenario: A process that does not end
- **WHEN** a session gets SIGTERM and SIGKILL, and its process still lives after 10 seconds
- **THEN** the card has `hidden` `pending`, and the log of the session keeps its size

### Requirement: Restore of an archived session
`restore` MUST reverse the hide: `codex unarchive <id>`, or a title record without the prefix. It MUST keep the card with `restoredAt`, and MUST start no process. The result MUST give the command to continue.

Tests: `test/archive.test.mjs`

#### Scenario: Restore of a Claude Code session
- **WHEN** the user restores a Claude Code session with the title `[archived] Fix the build`
- **THEN** the log gets the title `Fix the build`, the card gets `restoredAt`, and no process starts

### Requirement: Refused rows of an archive
`archive` MUST refuse a row before the dialog when its status is `working`, `stuck` or `waiting_for_permission`, when a tool runs below it, when a Megachat run has it, when a Codex row has an activity in the last 10 minutes, or without the consent `sessions.index`. The result MUST give the reason of each refused row.

Tests: `test/archive.test.mjs`

#### Scenario: A session that runs a tool
- **WHEN** a batch has an idle session and a session whose process file says `shell`
- **THEN** the dialog has one line, and the result refuses the second with the reason

### Requirement: Warnings of an archive
The dialog MUST warn on a row when its directory has uncommitted files, when its branch is ahead of its upstream, when another live session has the same directory, or when its last activity is less than 1 hour ago. A warning MUST NOT refuse the row. The card MUST keep the warnings.

Tests: `test/archive.test.mjs`

#### Scenario: A shared checkout with changes
- **WHEN** a session of `/work/json-profiler` is archived, `git status --porcelain` gives 3 files, and another session runs in the same directory
- **THEN** the line of the row has both warnings, and the card has them

### Requirement: Search of the archive
`list` MUST give the cards, the newest first, with a cursor. `search` MUST find a card by a word of its title, prompts, last answer, tickets or files.

Tests: `test/archive.test.mjs`

#### Scenario: A search by a ticket
- **WHEN** two cards exist, and one names `ORDER-389`
- **THEN** `search` with `ORDER-389` gives that card only

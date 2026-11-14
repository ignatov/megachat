# Spec Delta

## ADDED Requirements

### Requirement: Assignments tool
The main agent MUST have the tool `agents_assignments` with the actions `add`, `update`, `close`, `drop` and `list`. A child MUST NOT have it. An automatic turn MUST NOT call `close` or `drop`.

Tests: `test/assignments.test.mjs`

#### Scenario: A child and an automatic turn
- **WHEN** a Claude child lists its tools, and a morning turn calls `drop`
- **THEN** the child has no `agents_assignments`, and the call of the morning turn is refused with no change

### Requirement: Row of an assignment
A row MUST have the id (`a1`, `a2`, never reused), the text, the state (`open`, `running`, `waiting`, `later`, `done` or `dropped`), the owner (`user`, `coordinator`, `child` or `external`), the links and the times. The text MUST have 300 characters at most and MUST pass the secret filter of the capability `session-index`.

Tests: `test/assignments.test.mjs`

#### Scenario: A long text with a key
- **WHEN** `add` gets 400 characters that include an API key
- **THEN** the row keeps 300 characters, and the file has the masked key only

### Requirement: File of the ledger
Each change MUST append one JSON line to `assignments.jsonl` in the state directory, with mode 0600. Megachat MUST NOT rewrite a line and MUST NOT use a SQLite table. A read MUST fold the lines in order, MUST skip a line that is not valid JSON, and MUST give the count of the skipped lines.

Tests: `test/assignments.test.mjs`, `test/state.test.mjs`

#### Scenario: A broken last line
- **WHEN** the file has 3 valid lines and a last line that stops in the middle
- **THEN** `list` gives the rows of the 3 lines and `skipped` 1

#### Scenario: An older state directory
- **WHEN** the state directory has no `assignments.jsonl`
- **THEN** `list` gives no row, and the first `add` creates the file with mode 0600

### Requirement: Close with evidence
`close` MUST need a non-empty `evidence` text and MUST set the state `done`. `drop` MUST need a non-empty `reason` and MUST set `dropped`. `update` MUST NOT set `done` or `dropped`. Megachat MUST NOT close or drop a row on its own.

Tests: `test/assignments.test.mjs`

#### Scenario: A close with no evidence
- **WHEN** `close` has no `evidence`
- **THEN** the tool refuses, and the row keeps its state

#### Scenario: A completed run
- **WHEN** a linked run completes
- **THEN** the row keeps its state and gets the flag `result_ready` at the next `list`

### Requirement: Flags of a row
At each `list`, a row with a linked run that is cancelled, interrupted or failed MUST get the flag `lost`. A row with no update for 7 days (`STALE_MS`) MUST get the flag `stale`. A flag MUST NOT change the state.

Tests: `test/assignments.test.mjs`

#### Scenario: A cancelled run and a quiet row
- **WHEN** row `a1` links a cancelled run, and row `a2` was updated 8 days ago
- **THEN** `list` gives `a1` with `lost` and `a2` with `stale`, and both keep the state `open`

### Requirement: Order and limits of the list
`list` MUST sort the open rows: the rows with the owner `user`, then `lost`, then `stale`, then `later`, then the rest, each group with the oldest update first. `add` MUST return the existing open row for the same text, and MUST refuse a new row when 200 rows are open.

Tests: `test/assignments.test.mjs`

#### Scenario: The same text twice
- **WHEN** `add` gets "Approve session-triage" and then " approve SESSION-triage "
- **THEN** the second call returns the row `a1`, and the file has one `add` line

### Requirement: Rule of the instructions
The instructions MUST tell the main agent to add a row for an ask that outlasts the turn and for each proposal that waits for the approval of the author. They MUST tell it to add no row for a question that it answers in the turn. They MUST tell it to call `list` when the user asks what is open.

Tests: `test/assignments.test.mjs`

#### Scenario: The text of the rule
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds the three rules and the words "never close a row without evidence"

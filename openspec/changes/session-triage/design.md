# Design

## Context

See `proposal.md`, part "Why". `RunningAgents` gives rows with `agent`, `sessionId`, `title`, `cwd`, `state`, `status`,
`startedAt`, `lastActivityAt`, `pid` and `parent`. It already reads only with the consent `sessions.index`, and it
changes nothing. The data of 2026-11-14 is in `docs/session-orchestrator-brief.md`.

## Goals / Non-Goals

**Goals:**

- One call sorts the sessions by who must act next.
- The tool is read-only, has no state, and needs no model call.

**Non-Goals:**

- An action on a session. The tool names a bucket, and the user decides.
- A guess of "done". The log cannot say whether the last answer of a session waits for the user. Phase 3 of the brief
  decides if a reading of the last message is worth its cost.

## Decisions

### 1. A pure function over the rows, not a new reader

`src/SessionTriage.mjs` exports `triage(rows, now)`. It gets the rows of `RunningAgents` and does no I/O. So a test
needs no process table, and the tool cannot read more than `agents_running` reads. The tool uses the view of
`agents_running` with no row limit, and follows its cursors; an incomplete list gives an incomplete triage with the
same note as `agents_running` (capability `running-sessions`, requirement "Incomplete lists").

### 2. The bucket order

A row takes the first match: `needs_you`, `stuck`, `working`, `abandoned`, `quiet`. A session that waits for the user
must show before all, even when it is old. `abandoned` needs the status `idle`, so a silent session with an open
step stays `stuck`. The constant `ABANDONED_MS` is 72 hours, a first guess from the data of 2026-11-14 (9 of 18 Claude
sessions were past it). It is not a setting: the author tunes it after one week, with the measure of task 3.1.

### 3. The age

`idleMs` is `now - lastActivityAt`. A row without `lastActivityAt` has no `idleMs` and cannot be `abandoned`.

### 4. The duplicate hint

The words of a title are lower-cased, split on non-letters, and words of fewer than 4 letters are dropped. Two rows are
similar when they share at least 2 words and the shared words are at least half of the shorter set. The directory is
not compared, because the known duplicates cross projects. A row with no title gets no hint. The hint is a guess with
no proven precision, so the tool puts the word `possible` in the field name: `possibleDuplicates`. Task 3.1 measures it.

### 5. Private data

A title and a `cwd` are private text, as in `agents_running`. The tool gives the same fields, and no log text. It
writes nothing to a state file or to the log.

### 6. Persistence

The tool has no state, so a disconnect of the ACP client or a restart of the daemon loses nothing. An older state
directory needs no change. No ACP message and no `_meta` key is added.

## Risks / Trade-offs

- `abandoned` can mark a session that the user wants to keep. The tool shows the age and no action, so the cost is one
  wrong line.
- The status of a Codex row comes from the log only, and Codex writes no permission record (capability
  `session-logs`). A Codex session that waits for a permission shows as `working`, then `stuck`. The result marks
  `needs_you` as incomplete for Codex.

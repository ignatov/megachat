# Design

## Context

See `proposal.md` and `docs/assignments-brief.md`. The data of 2026-11-14 is a read-only reading of
`conversation.sqlite` for 3 days: 148 messages, 64 asks, 55 with a clear end, 9 that wait for a human, a bot or a date.

## Goals / Non-Goals

**Goals:**

- The user can ask "what is open" and gets one exact answer.
- A commitment survives a restart, a summary and a daemon crash.
- A row never says "open" for a thing that is done, and it never says "done" with no evidence.

**Non-Goals:**

- A tracker, a board, or a copy of the state of a run, a session, an issue or a pull request.
- A model call to find assignments.

## Decisions

### 1. A file, not a table

The ledger is `assignments.jsonl` in the state directory, with mode 0600, as `session-archive.jsonl` is. One event is
one line: `{"type":"add"|"update"|"close"|"drop","id":"a1","at":<ms>,...fields}`. A read folds the lines in order.
Reason: Pi Durable has no cross-process lock, the daemon is the only writer, and the user can read and repair a text
file. A line that is not valid JSON is skipped and counted in the answer of `list`. An older state directory has no
file, and `list` returns no row.

### 2. The row

| Field | Meaning |
|---|---|
| `id` | `a` and a counter, never reused |
| `text` | the words of the user, 300 characters at most, after the secret filter of `session-index` |
| `state` | `open`, `running`, `waiting`, `later`, `done`, `dropped` |
| `owner` | who moves next: `user`, `coordinator`, `child`, `external` |
| `refs` | `runIds`, `change`, `issues`, `prs`, `commits`, `sessionIds`: links only |
| `due` | a date, only for `later` |
| `evidence` | a text, required for `done` |
| `reason` | a text, required for `dropped` |
| `createdAt`, `updatedAt` | milliseconds |

`update` changes `state`, `owner`, `refs`, `due` and `text`. It cannot set `done` or `dropped`.

### 3. Flags are facts, not states

At each `list`, the tool reads the status of each linked run from the conversation store. `lost`: the run is
cancelled, interrupted or failed. `result_ready`: the run completed. `stale`: `updatedAt` is 7 days ago or more
(constant `STALE_MS`). A flag appears in the answer and changes no row. The coordinator then closes or updates the row
with the user. Reason: a wrong auto-close ends the trust in the list.

### 4. Who may write

The tool is registered for the main agent only. It is not in the tool set of a child. An automatic turn (the morning
report, a continuation after a run) may call `list`, and may call `add` and `update`. Only a turn that the user
started may call `close` and `drop`. A child reports in its result, and the coordinator writes.

### 5. A duplicate

`add` with a `text` that equals the text of an open row (after trim and lower case) returns that row and adds none.
The limit is 200 open rows. Over it, `add` refuses and tells the user to close rows.

### 6. The rule in the instructions

The rule says when to add (an ask that outlasts the turn, a proposal that waits for approval, a "later", a wait for an
external merge) and when not (a question answered in the turn, an ask that ends in the turn with its run and commit).
It says: never call `done` without the evidence text, and never drop a row without the word of the user.

### 7. Durability

The daemon appends one line with a single write and `fsync`. A crash in the middle leaves at most one broken last
line, which a read skips. The file is not in the context of the model, so a summary of the conversation cannot lose a
row. A restart reads the file at the next call.

## Risks / Trade-offs

- The coordinator can forget to add a row. The coverage metric of the brief measures it. If it is below 90%, the next
  step adds rows derived from git and from the trackers.
- A stale row can still mislead for 7 days. The flag `stale` is the first answer. The counter-metric of the brief
  watches it.
- The text of a row is the user's words. The filter, the limit of 300 characters and the mode 0600 cover the risk.

## Migration

None. There is no file in an older state directory. The first `add` creates it. No setting changes, and a rollback is
to delete the file and the tool.

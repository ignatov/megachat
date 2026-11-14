# Proposal

## Why

The author asked on 2026-11-14 for one more store with all the assignments and tasks, so that he knows what goes on
(see `docs/assignments-brief.md`). A read-only sample of 148 messages from 2026-11-12 to 2026-11-14 shows 64 asks.
55 of them (86%) ended with a clear result, with a run, a commit, a ticket or an answer. The 9 others each wait for a
human, a bot or a date: 4 items wait for a decision of the user, 3 wait for a date or a bot, and 1 has an unclear end.
Child runs are not the gap. They have a status and a transcript. The gap is the commitment that no store holds. Today
it lives in the chat and in the summary of the coordinator, and the state of a proposal ("approved" or "waits for
the author") is written nowhere.

## What Changes

Where it shows: the chat. One new tool of the main agent, one new file in the state directory, one rule in its
instructions.

- **A tool `agents_assignments`** with the actions `add`, `update`, `close`, `drop` and `list`. Only the main agent
  has it. A child has no such tool.
- **An assignment** is an outcome that the user wants and that lasts longer than one turn. A row has an id, the text
  (the words of the user, 300 characters at most), a state (`open`, `running`, `waiting`, `later`, `done`,
  `dropped`), the owner of the next move (`user`, `coordinator`, `child` or `external`), links to runs, changes,
  issues, pull requests, commits and sessions, a date for `later`, and the times.
- **A file `assignments.jsonl`** in the state directory, with mode 0600. It is append-only. The tool folds the events
  into the rows at each read. No SQLite table. An older state directory has no file, and it opens as it is.
- **Close with evidence.** `close` with `done` needs a non-empty evidence text, such as a pushed commit or a
  completed run. `drop` needs a reason. The tool never closes or drops a row on its own.
- **Facts at each `list`.** A row with a linked run gets the flag `lost` when the run was cancelled, interrupted or
  failed, and `result_ready` when it completed. A row with no update for 7 days gets the flag `stale`. A flag changes
  no state.
- **The answer of `list`.** The rows are sorted: the rows that wait for the user, then `lost`, then `stale`, then
  `later`, then the rest. Each group is sorted by the oldest update first.
- **The instructions.** The main agent adds a row when it takes an ask that outlasts the turn, and for each proposal
  that waits for the approval of the author. It adds no row for a question that it answers in the same turn. When the
  user asks what is open, it calls `list` and answers in one message: a count line, the rows that wait for the user,
  the lost rows, the later rows and the stale rows.

## Capabilities

### New Capabilities

- `assignments`: the tool, the row, the file, the rules of the close and the flags.

### Modified Capabilities

None. `morning-report`, `session-notes`, `session-archive` and `session-triage` do not change in this step.

## ACP and Air

No ACP extension changes, and `docs/air-contract.md` does not change. Air needs no change.

## Impact

- Code: a new `src/Assignments.mjs` with the pure fold and the flags, the tool registration in
  `src/PiMegachatService.mjs`, and the rule in `resources/instructions.md`.
- Strings: the texts of the tool and of the flags in `resources/Megachat.properties`.
- Tests: a new `test/assignments.test.mjs`.
- Documents: `README.md` (the tool and the file in "The state directory"), `docs/manual-checks.md` (one live run in a
  temporary `MEGACHAT_HOME`).
- No field of `conversation.sqlite` or `settings.json` changes. No new setting. The tool is on for the main agent.
- Out of scope, and not planned:
  - A tracker: no priority, label, estimate, assignee, board or sub-task.
  - A copy of a run, a session, an issue or a pull request.
  - A model call that finds assignments in the history.
  - An automatic close, drop or hide of a row.
  - A block in the morning report, a note for a lost row, a join with `agents_triage` and `agents_archive`, rows
    derived from git and from the trackers, a view in Air. These are the next steps of the brief, after its gate.
  - No non-goal of `openspec/config.yaml` changes.

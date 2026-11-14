# Proposal

## Why

The author runs about 20 agent sessions at once: 20 on 2026-11-14, in terminals, a multiplexer, IDEs and Megachat (see
`docs/session-orchestrator-brief.md`). 16 of 18 Claude Code sessions had no activity for more than 24 hours, and 4
for more than 7 days. The session that looked "stuck" in gitbob was idle for 232 hours. The present status `stuck`
cannot name it, and `agents_running` gives a flat list that the user must sort by hand. The user cannot tell in one
step which sessions wait for them, which are stuck, and which are abandoned.

## What Changes

Where it shows: the chat. One new read-only tool of the main agent, and one rule in its instructions.

- **A tool `agents_triage`.** It reads the view of `agents_running` and puts each row into one bucket, in this order:
  `needs_you` (the status is `waiting_for_user` or `waiting_for_permission`), `stuck` (the status is `stuck`),
  `working` (the status is `working`), `abandoned` (the status is `idle` and the last activity is 72 hours ago or more),
  and `quiet` (all other rows). The result gives the count of each bucket, and the rows sorted by bucket, then by the
  oldest activity first. A row has its fields from `agents_running`, the bucket, and `idleMs`.
- **A duplicate hint.** A row gets `similarTo`, the session IDs of other rows with a similar title. The hint is a
  guess, and the tool says so. It is the first thing to cut if the measure in task 3.1 is below 30% precision.
- **Without the consent.** The tool reads the logs only with the consent `sessions.index` (capability `session-index`).
  Without it, each row gets the bucket `unread` and the result tells the user to give the consent. The tool never
  changes the consent.
- **The instructions.** When the user asks what waits for them, what is stuck or what can close, the main agent calls
  `agents_triage` and answers with the buckets. It names no command to close a session. For an orphan it may offer
  `agents_stop`, which asks the user as before.

## Capabilities

### New Capabilities

- `session-triage`: the tool `agents_triage`, its buckets, its limits and its private-data rule.

### Modified Capabilities

None. `running-sessions`, `session-logs` and `stop-sessions` do not change.

## ACP and Air

No ACP extension changes, and `docs/air-contract.md` does not change. Air needs no change.

## Impact

- Code: a new `src/SessionTriage.mjs` with a pure function over the rows of `RunningAgents`; the tool registration
  in `src/PiMegachatService.mjs`; the rule in `resources/instructions.md`.
- Strings: `instructions.triage` and the texts of the tool in `resources/Megachat.properties`.
- Tests: a new `test/triage.test.mjs`.
- Documents: `README.md` (the tool and the buckets), `docs/manual-checks.md` (one live run on a copy of the real
  process table, in a temporary `MEGACHAT_HOME`).
- No field of `conversation.sqlite`, `settings.json` or another state file changes. No new setting.
- Out of scope, and not planned:
  - A write into a live session of another CLI, an automatic stop, close or archive of a session.
  - A model call for the triage, a store of its result, a board in Air.
  - A morning-report line, a note for `needs_you`, a resume in one step. Later phases of the brief.
  - No non-goal of `openspec/config.yaml` changes.

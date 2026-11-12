# Proposal

## Why

Pi Durable 1.5.0 can lose the wake-up of a task that waits for two or more tool tasks, so a turn of the main agent
never ends (issue #25). Megachat has a guard for this defect in `src/SchedulerWake.mjs`. The guard uses the internal
`tx.setTask` of the Pi Durable transaction, so each new version of Pi Durable needs a check of the guard. Pi Durable
1.5.1 of 2026-11-09 has the fix (upstream issue 11892): "Fixed a task staying `waiting`, or `completing` with idle waits
never resolving, when the last task it waited for or held ended while a scheduler pass was planning". With 1.5.1, the
guard has no work, and it is a dependency on an internal call for no use.

The facts with 1.5.1 in this checkout:

- The scan of `test/scheduler-wake.test.mjs` without the guard: each turn ends at each delay 0 to 300, with two, three
  and five `agents_spawn` calls in one reply, and the next model request has all the tool results. The same scan with
  Pi Durable 1.5.0 hangs at the delay 24, with two and with three calls. With the guard on 1.5.1, the guard writes no
  record at the delays 0 to 48.
- The minimal reproduction of issue #25, which uses only Pi Durable: on a clean install of 1.5.0 it hangs at the delay
  24 of 0 to 300, with two and with three calls. On a clean install of 1.5.1 and on this checkout it hangs at no delay.
- `npm test` with 1.5.1 and the guard, after the change of the import of `Watch` below: 572 tests, 571 pass. The one
  failure is the assertion "Pi Durable lost no wake-up" of `test/scheduler-wake.test.mjs`. The state of v0.2.0, at a
  stop and at a kill, opens with this code.

The user asked for 1.5.1, not for the newest version 1.5.2.

## What Changes

Where it shows: the log of the daemon. The guard wrote the line "The task <ID> of Pi Durable waited after the end of
each task of its wait. Megachat wrote its record again, so the scheduler runs it." That line goes. The chat, the task
list of Air and the commands do not change: a turn with two or more tool calls in one reply ends, as before.

- **Dependency update.** `@earendil-works/pi-durable` goes from 1.5.0 to 1.5.1. Pi Durable 1.5.1 needs exactly
  `@earendil-works/chord`, `pi-ai` and `pi-schema` 1.5.1, so these three direct dependencies go to 1.5.1 too, with the
  same exact pin. In the lock, also `@earendil-works/pi-codemode` and `pi-telemetry` go to 1.5.1. No other package
  changes. Chord 1.5.1 has a new optional peer `react`. npm does not install it.
- **Chord 1.5.1 moves `Watch` out of its root.** The root of `@earendil-works/chord` now exports Chord v2, and `Watch`
  is in `@earendil-works/chord/watch`. Only `test/transport.test.mjs` imported `Watch` from the root. The source of
  Megachat imports only `@earendil-works/chord/context` and `@earendil-works/chord/sqlite/node`, which do not change.
- **Removal of the guard.** `src/SchedulerWake.mjs`, the option `schedulerWake` of `PiMegachatService.open`, and the log
  strings `log.schedulerWake` and `log.schedulerWake.write` go.
- **The test stays as a regression test.** `test/scheduler-wake.test.mjs` no longer asserts that the defect exists. It
  asserts that a turn with two and with three tool calls in one reply ends at each delay 0 to 300, with no guard. A later
  version of Pi Durable with the defect again fails this test.
- **The live scenario `twotools`** no longer counts the writes of the guard.
- **The version in the texts.** The two requirements of `pi-child` and the roadmap item that name Pi Durable 1.5.0 name
  1.5.1. Pi Durable 1.5.1 still reads the stream options of the harness without the conversation, and it still cannot
  delete or archive a conversation.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `failure-handling`: the requirement "End of a turn after a lost wake-up" no longer depends on a guard, and it has a
  scenario with two tool calls. The requirements "Guard for a lost wake-up of the scheduler" and "Writes of the guard"
  go.
- `pi-child`: the requirements "Model of a pi child" and "Conversation of a pi child after the prune" name Pi Durable
  1.5.1. Their behavior does not change.

## Impact

- `package.json`, `package-lock.json`: the six packages of `@earendil-works` above.
- `src/SchedulerWake.mjs` (removed), `src/PiMegachatService.mjs`, `resources/Megachat.properties`.
- `test/scheduler-wake.test.mjs`, `test/transport.test.mjs`, `test/live/smoke.mjs`.
- `README.md` (the code map), `docs/roadmap.md`.
- The state: the SQLite schema version of Pi Durable stays 2 in 1.5.1. So this build does not refuse a state of v0.3.0,
  which uses Pi Durable 1.5.0, and v0.3.0 does not refuse a state of this build. No field of `conversation.sqlite`,
  `settings.json` or another state file changes. No test opens a state of this build with v0.3.0.
- The change does not modify an ACP extension, so Air does not change.
- Other entries of the changelog of Pi Durable 1.5.1, and why they do not change a behavior of Megachat:
  - `SqliteStorage.commit()` uses fewer SQL statements. A stored document record that cannot be parsed now rejects the
    call as a storage failure, not as a refused batch. Megachat uses this storage. Only a damaged database shows the
    difference, and the daemon logs a storage failure, as for each other storage failure.
  - Compaction settings for each conversation (`configure({ compaction })`). Megachat gives the compaction settings
    only to the harness, through `modelOverrides` of the main model, and it gives no compaction to a conversation. So
    the harness settings apply, as before.
  - JSONL storage opens read-only, and `Tx.submission(id)` is new. Megachat uses neither.
  - `tool_search` finds a deferred tool through a local `$ref`, and code mode accepts a malformed `$ref`. Megachat has
    no deferred tool and no code mode.
  - Pi Schema 1.5.1: a `num()` refuses `NaN` and `Infinity`. The arguments of a tool call come from JSON, which has
    neither.

## Out of scope

- Pi Durable 1.5.2 and later versions.
- The other dependencies.
- A live run of the scenario `twotools` with the real provider. The facts above come from the tests without the network.
- The change touches no non-goal.

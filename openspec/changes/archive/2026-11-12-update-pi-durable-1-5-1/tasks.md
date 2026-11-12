# Tasks

## 1. The update of Pi Durable

- [x] 1.1 Pin `@earendil-works/chord`, `pi-ai`, `pi-durable` and `pi-schema` to exactly 1.5.1 in `package.json`, and
      update `package-lock.json` with `npm install`. Verify: `npm ls --all` shows each package of `@earendil-works` at
      1.5.1 one time, and `git diff package-lock.json` changes only `chord`, `pi-ai`, `pi-codemode`, `pi-durable`,
      `pi-schema`, `pi-telemetry` and the optional peer `react` of `chord`.
- [x] 1.2 In `test/transport.test.mjs`, import `Watch` from `@earendil-works/chord/watch`. Verify:
      `test/transport.test.mjs` passes.

## 2. The removal of the guard

- [x] 2.1 Remove `src/SchedulerWake.mjs`. In `src/PiMegachatService.mjs`, remove its import, the option
      `schedulerWake` with its text in the comment of `open`, the start of the guard, `stopWake` and its call in
      `close`. Verify: `grep -rn "SchedulerWake\|schedulerWake\|stopWake\|wakeFinishedWaits" src test` finds nothing.
- [x] 2.2 Remove `log.schedulerWake` and `log.schedulerWake.write` from `resources/Megachat.properties`. Verify: no
      file of `src` or `test` names the two keys.
- [x] 2.3 Change `test/scheduler-wake.test.mjs` into the regression test of the requirement "End of a turn after a lost
      wake-up": no option `schedulerWake`, no check of the log of the guard, and no assertion that the defect exists.
      For two and for three `agents_spawn` calls in one reply, at each delay 0 to 300, the turn ends, the conversation
      has no current turn, and the next model request has two or three tool results. The comments tell that Pi Durable
      1.5.0 lost the wake-up at one delay of this scan and that 1.5.1 has the fix. Verify: the test passes.
- [x] 2.4 In `test/live/smoke.mjs`, remove `wakeWrites` and the field `guardWrites` of the item 11, and change the
      comment of the item 11 so that it does not name the guard. Verify: `node --check test/live/smoke.mjs` passes. Do
      not run the live scenario.
- [x] 2.5 Remove the line of `src/SchedulerWake.mjs` from the code map of `README.md`. Verify:
      `grep -n "SchedulerWake" README.md` finds nothing.
- [x] 2.6 Give the requirement "End of a turn after a lost wake-up" its `Tests:` line `test/scheduler-wake.test.mjs`.
      Verify: `openspec validate update-pi-durable-1-5-1 --strict` passes.

## 3. The version in the texts

- [x] 3.1 Name Pi Durable 1.5.1 in the item 9 of `docs/roadmap.md`, as the delta of `pi-child` does. Verify:
      `grep -rn "1\.5\.0" docs openspec/specs README.md` finds no line about Pi Durable after the archive.

## 4. The checks

- [x] 4.1 Run `npm test`. Verify: all tests pass, also the tests that open a state of v0.2.0 at a stop and at a kill in
      `test/upgrade.test.mjs`.
- [x] 4.2 Run `npm run test:bundle`, because a dependency changes. Verify: the test passes.
- [x] 4.3 Run `npm run test:package`, because `package.json` changes. Verify: the test passes. Run it again only when
      `package.json` or `package-lock.json` changes after this run. Result: the run before the removal of the guard
      passed, and `package.json` and `package-lock.json` did not change after it.

No new user-visible string: the change only removes the two log strings of the guard.

## Workflow follow-up

- Archive the change, so its deltas go into `openspec/specs/failure-handling/spec.md` and
  `openspec/specs/pi-child/spec.md`.
- Run `openspec validate --all --strict` after the archive.

# Tasks

This change depends on the change `learned-memory`. Start it after `learned-memory` is archived.

## 1. The reflection pass

- [ ] 1.1 Add `resources/reflection.md`: a first paragraph for the system prompt, then the grounding rule, the rule of the topics, the rule "only add", and the answer format `add user:`, `add notes:`, `propose:`. Verify in `test/memory-reflection.test.mjs` that the request holds the system prompt, the transcript, the current file and the topics.
- [ ] 1.2 Add the pass to `src/PiMegachatService.mjs`: the entries after the cursor through `root.entries`, without `air.megachat.event` and notes, the newest 60,000 characters in the format of `transcript()`, the request with `cacheRetention: 'none'`, `maxTokens` 1,000 and 120 seconds, the parse of at most 5 adds and 3 proposals, and each add through the write of the tool. Verify "A pass that adds and proposes" with the faux model.
- [ ] 1.3 Add the setting `memory.reflection` (boolean, default `true`, `nextTurn`) and name it in `resources/instructions-onboarding.md`. Verify the second part of "The defaults of the memory" in `test/settings.test.mjs`, and that a pass does not run with `false`. Run `npm test`.

## 2. The schedule and the notice

- [ ] 2.1 Add the state field `memoryReflection` with its default for an older state (the newest entry ID, 0, `false`, `null`). Count each completed turn of the user. Set `due` at 10 turns and after a completed summary. Verify the default in `test/upgrade.test.mjs`.
- [ ] 2.2 Start a due pass with the clock of the service, 60 seconds after the end of the last turn and when no turn runs. Abort it in `submit`, and keep it due. Set `userTurns` to 0 after a failure. Verify "A user message during a pass" in `test/memory-reflection.test.mjs` with `test/fake-clock.mjs`, and a failed pass.
- [ ] 2.3 Count each request with `countSpend`, and start no pass above a daily limit that is not 0. Verify "A pass above the limit" in `test/memory-reflection.test.mjs` and "A reflection request" in `test/spend.test.mjs`.
- [ ] 2.4 Add the notice to the section `memory` and clear it after a completed turn that had it. Verify "The notice goes away" in `test/memory-reflection.test.mjs`. Put each new text in `resources/Megachat.properties`, also `log.reflection`. Run `npm test`.

## 3. Documents and checks

- [ ] 3.1 Update `README.md`: the row of `memory.reflection` and a short paragraph about the reflection, its triggers, its cost and the setting.
- [ ] 3.2 Check that the `Tests:` lines of the reflection requirements and of the deltas of `settings` and `spend-limit` name the files of groups 1 and 2, and that each scenario matches a test case with its values.
- [ ] 3.3 Run `npm test` and `openspec validate --all --strict`. The new file `resources/reflection.md` reaches the bundle through the copy of `resources/` in `build.mjs`, with no change of `build.mjs`. Run `npm run test:bundle` one time to see that the bundle reads it. `npm run test:package` is not necessary.

## Workflow follow-up

- Archive the change: the deltas merge into `openspec/specs/learned-memory/spec.md`, `settings` and `spend-limit`.
- Run `openspec validate --all --strict` after the merge.
- Close issue #31 with the commit of this change.

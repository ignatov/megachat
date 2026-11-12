# Tasks

This change builds on the capability `learned-memory`. Its first slice is the archived change
`archive/2026-11-12-learned-memory`.

## 1. The reflection pass

- [x] 1.1 Add `resources/reflection.md`: a first paragraph for the system prompt, then the grounding rule, the rule of the topics, the rule "only add", and the answer format `add user:`, `add notes:`, `propose:`. Verify in `test/memory-reflection.test.mjs` that the request holds the system prompt, the transcript, the current file and the topics without a blocked topic ("The request of a pass").
- [x] 1.2 Add `src/MemoryReflection.mjs`: the entries after the position through `root.entries`, only the messages of the user and the text replies of a turn of the user, the newest 60,000 characters in the format of `transcript()`, and the parse of at most 5 adds and 3 proposals. Verify the transcript and the parse with unit cases, and "A pass that reads no tool result and no child output" with the faux model.
- [x] 1.5 Send the transcript as a JSON array of items `{ role, text }` that `JSON.stringify` makes, with the limit on whole items and a cut that is never in an escape. Add the grounding rule for the roles, for pasted text and for an instruction in the transcript to `resources/reflection.md`. Verify "A spoofed user message", "A long item" and "A reply that tells the notice".
- [x] 1.3 Add the request to `src/PiMegachatService.mjs` with the model of the main agent, `cacheRetention: 'none'`, `maxTokens` 1,000 and 120 seconds, and each add through `MegachatMemory.change` with the request ID `reflection:<pass>:<index>`. Drop a refused add and a refused proposal with a log line. Verify "A pass that adds and proposes" and "An add of a forgotten topic".
- [x] 1.4 Add the setting `memory.reflection` (boolean, default `true`, `nextTurn`) and name it in `resources/instructions-onboarding.md`. Verify the second part of "The defaults of the memory" in `test/settings.test.mjs`, and "No pass with the setting off". Run `npm test`.

## 2. The schedule and the notice

- [x] 2.1 Add the state field `memoryReflection` with its default for an older state (the newest entry ID, 0, `false`, `null`, `null`). Count each completed turn of the user in `settleInput`. Set `due` at 10 turns and after a completed summary. Verify the default in `test/upgrade.test.mjs`.
- [x] 2.2 Start a due pass with the clock of the service, 60 seconds after the end of the last turn, when no turn runs and the conversation does not sleep. Stop the timer in `submit` and at the start of each turn, and do not stop a request that runs. Look at the state again at the end of a pass and after a message that starts no turn. Clear `userTurns` and `due` after a failure, also for an answer that ends as `aborted` while Megachat did not stop it. Verify "A user message during a pass", "A summary during a pass", "A message that starts no turn", "A summary at night", "A failed request" and "A request that ends as aborted" in `test/memory-reflection.test.mjs` with `test/fake-clock.mjs`.
- [x] 2.3 Store the answer of a pass before its first write and the line of each add after it. Finish a stored answer in `resume`. Verify "A restart during the writes" and "A restart during the request".
- [x] 2.4 Count each request with `countSpend`, and start no pass above a daily limit that is not 0. Verify "A pass above the limit" in `test/memory-reflection.test.mjs` and "A reflection request" in `test/spend.test.mjs`.
- [x] 2.5 Add the notice to the section `memory`, and remove the lines that a completed turn had. Tell the agent in the notice and in `resources/instructions.md` to take back an entry of the reflection with `remove`. Verify "The notice goes away" in `test/memory-reflection.test.mjs`.
- [x] 2.6 At a forget, move the position to the newest entry, stop the request that runs, drop the adds that are not written and the proposals of a stored answer, and remove the lines of the notice of the removed entry and of its topic. Verify "A statement before a forget", "A forget during a request", "A forget during the writes" and "A forget with a notice of two adds and a proposal". Put each new text in `resources/Megachat.properties`, also the log lines `log.reflection.*`. Run `npm test`.

## 3. Documents and checks

- [x] 3.1 Update `README.md`: the row of `memory.reflection`, the row of `src/MemoryReflection.mjs`, and a short paragraph about the reflection, its input, its triggers, its cost and the setting.
- [x] 3.2 Check that the `Tests:` lines of the reflection requirements and of the deltas of `settings` and `spend-limit` name the files of groups 1 and 2, and that each scenario matches a test case with its values.
- [x] 3.3 Run `npm test` and `openspec validate --all --strict`. The new file `resources/reflection.md` reaches the bundle through the copy of `resources/` in `build.mjs`, with no change of `build.mjs`. Run `npm run test:bundle` one time to see that the bundle reads it. `npm run test:package` is not necessary.

## Workflow follow-up

- Archive the change: the deltas merge into `openspec/specs/learned-memory/spec.md`, `settings` and `spend-limit`.
- Run `openspec validate --all --strict` after the merge.
- Close issue #31 with the commit that archives this change.

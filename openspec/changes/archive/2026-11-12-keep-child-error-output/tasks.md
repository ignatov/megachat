# Tasks

## 1. Filter and cut of the error output

- [x] 1.1 Add to `src/SessionText.mjs` the function `errorOutputText` (the drop of the cut start, the drop of the open end, `redactSecrets` with the known values, the removal of ANSI escape sequences and control characters, the cut after the filter) and the function `reasonLine` that picks the line of the reason. Verify with unit cases in `test/child-secrets.test.mjs` and `test/error-output.test.mjs`: a key in two chunks, a cut in a key, the start of a key at an open end, a surrogate pair at the cut, the word list, and a long line.
- [x] 1.2 Check that the `Tests:` lines of the delta of `secrets` name `test/child-secrets.test.mjs`, and that each scenario matches a test case with its values. Run `npm test`.

## 2. Error output and answer in the run service

- [x] 2.1 Extend `test/fake-acp.mjs` with the shapes of `design.md`: an error output in chunks from `FAKE_ACP_STDERR` with a delay between the chunks; a `session/new` that throws a plain `Error` (the SDK makes -32603 with `details`), that answers `authRequired`, or that exits with a code; an error output after the answer; a `session/prompt` that answers -32603; a crash during the prompt with error output; and a prompt that writes error output and completes. Keep the prompts `noisy` and `crash` as they are.
- [x] 2.2 In `src/AcpRunService.mjs`, keep the last 8,000 characters of `child.stderr` with a UTF-8 decoder, next to the count for the limit of 1 MB. Mark each kill of Megachat. Add the option `errorOutputWaitMs` (2,000 by default) and the method `errorOutputEnd`, which waits for the end of the agent, kills it and waits a quarter of the time more. Call it only for a failure that shows the error output.
- [x] 2.3 Keep the answer of the agent, the method of its request and the flag of the prompt. `refused(...)` keeps the answer as the `cause` of its `MegachatError`.
- [x] 2.4 Write the log entry: the line of `log.child`, the answer with `log.child.answer`, and the filtered end of the error output with `log.child.output` and the prefix `  | `, or `log.child.noOutput`. Verify in `test/error-output.test.mjs`: the answer to `session/new`, an error after the answer, a long error output, the lines of the agent with escape sequences and a forged log line, and no error output.
- [x] 2.5 Give the error of the run its fixed text and its reason: `error.child.answer.before`, `error.child.answer.after`, `error.child.exit.before`, `error.child.exit.after`, `error.child.exitCode`, `error.child.signal`, `error.child.login`, `error.child.reply`, `error.child.line` and `error.child.log`. A `MegachatError` keeps its text. Verify in `test/error-output.test.mjs`: the exact text of the incident of 2026-11-12, a Node.js crash before the answer, a long line, an exit before the prompt, an error answer of the prompt, a crash during the prompt, `authRequired`, and the text of a continuation after an error answer of `session/new`.
- [x] 2.6 Add the term "no `authRequired` answer" to `autoResume`. Verify in `test/error-output.test.mjs` that an `authRequired` run gets no continuation and that an error answer -32603 of `session/new` still gets one.
- [x] 2.7 Verify in `test/error-output.test.mjs` that a completed run puts no error output in the log, and that a cancel, a deadline, the limit of 1 MB and a stop of the daemon put no error output in the log and do not call `errorOutputEnd`. Verify in `test/child-secrets.test.mjs` that the log and the error of a run hold no part of the known key, no base URL and no `sk-` key. Verify in `test/child-settings.test.mjs`, with a short `errorOutputWaitMs`, that the log of a refused mode holds the answer and that the error of the run stays the fixed text. Verify that the `noisy` case of `test/parallel.test.mjs` passes with no change.
- [x] 2.8 Add each new text to `resources/Megachat.properties`, also `log.child.answer`, `log.child.output` and `log.child.noOutput`.
- [x] 2.9 Check that the `Tests:` lines of the deltas of `failure-handling` and `run-recovery` name the files of 2.4 to 2.7, and that each scenario matches a test case with its values. Run `npm test`.

## 3. Log of the daemon

- [x] 3.1 In `spawnDaemon` of `src/main.mjs`, set the mode 0600 on the open log before the start of the daemon, except on Windows. Verify in `test/launch.test.mjs`: a `daemon/daemon.log` with the mode 0644 has the mode 0600 after `start`.
- [x] 3.2 In `test/live/smoke.mjs`, skip a line that starts with `  | ` in the count of the lines of the guard. Verify with `node --check test/live/smoke.mjs`; the live test needs a real provider, so it does not run here. Run `npm test`.

## 4. Documents and checks

- [x] 4.1 Update the row of `daemon/daemon.log` in `README.md`: the file has the mode 0600, and it holds the filtered end of the error output of a failed child run.
- [x] 4.2 Run `npm test` and `openspec validate keep-child-error-output --strict`. No change of `build.mjs`, of a dependency, of `package.json`, of the launcher or of `install`, so `npm run test:bundle` and `npm run test:package` are not necessary. No ACP extension changes, so `docs/air-contract.md` and Air do not change.

## Workflow follow-up

- Archive the change: the deltas merge into `openspec/specs/failure-handling/spec.md`, `openspec/specs/secrets/spec.md` and `openspec/specs/run-recovery/spec.md`.
- Run `openspec validate --all --strict` after the merge.
- Commit in one commit with `Fixes #28`.

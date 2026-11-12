# Tasks

## 1. The line of the reason

- [x] 1.1 In `src/SessionText.mjs`, add the new words to `REASON_WORDS`, with whole words for the short words, and the
      narrow forms of missing, rate limit and login. Leave out permission. Verify: the new cases "a line with a word for
      a failure other than error is the reason" and "the debug lines of the adapter of Claude Code match no word for a
      failure" in `test/error-output.test.mjs` pass.
- [x] 1.2 In `src/SessionText.mjs`, make `reasonLine` give an empty text when no line names a failure. Verify: the case
      of `reasonLine` in `test/error-output.test.mjs` expects an empty text for `one\ntwo`.
- [x] 1.3 Change the cases that used the last line: the late line and the long line in `test/error-output.test.mjs`
      start with `Error: `, and the line with the secret in `test/child-secrets.test.mjs` starts with `Error: `. Verify:
      both files pass.
- [x] 1.4 Add the prompt `killed` to `test/fake-acp.mjs` and the case of an agent process that SIGKILL ends after its
      debug lines to `test/error-output.test.mjs`, with the exact error of the run. Verify: the case passes.
- [x] 1.5 Make the check of the case 14.3 in `test/live/smoke.mjs` expect the error with no line of the error output.
      Verify: `node --check test/live/smoke.mjs` passes. Do not run the live scenario.
- [x] 1.6 Give the requirements of the delta their `Tests:` lines: `test/error-output.test.mjs` and
      `test/child-secrets.test.mjs`. Verify: `openspec validate quote-only-failure-lines --strict` passes.
- [x] 1.7 Run `npm test`. Verify: all tests pass.

No new user-visible string and no change of `README.md`: the texts of the error of a run do not change, and the log
keeps its text.

## Workflow follow-up

- Archive the change, so its delta goes into `openspec/specs/failure-handling/spec.md`.
- Run `openspec validate --all --strict` after the archive.

# Tasks

## 1. The lines

- [x] 1.1 Add `src/RunLog.mjs` and the strings `log.run.*`.
- [x] 1.2 Write the lines from `admitChild`, `transition`, `cancel`, `stopChild` and `recover` of `src/MegachatState.mjs`, after the commit.
- [x] 1.3 Pass the error class from `src/AcpRunService.mjs` and `src/PiRunService.mjs`.

## 2. Tests and documents

- [x] 2.1 Add `test/run-log.test.mjs` and the `Tests:` line of the new requirement.
- [x] 2.2 Update the row of `daemon/daemon.log` in `README.md`.
- [x] 2.3 Run `npm test` and `openspec validate child-run-log --strict`.

## Workflow follow-up

- Archive the change: the delta of `failure-handling` merges into its spec.
- Run `openspec validate --all --strict` after the merge.

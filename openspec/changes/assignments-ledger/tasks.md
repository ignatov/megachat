# Tasks

## 1. Checks before the code

- [ ] 1.1 On a copy of `conversation.sqlite`, in a temporary `MEGACHAT_HOME`: read the status of a run by its id with the same call that `agents_list` uses. Write the call in `docs/manual-checks.md`. Stop and report if a run has no status after a restart.

## 2. The ledger

- [ ] 2.1 Add `src/Assignments.mjs`: the append of an event, the fold of the file into rows, the flags `lost`, `result_ready` and `stale` (`STALE_MS`), the sort, the duplicate check and the limit of 200 rows (decisions 1 to 5 of `design.md`).
- [ ] 2.2 Register `agents_assignments` in `src/PiMegachatService.mjs` for the main agent only, with the turn rules of decision 4. Add the strings to `resources/Megachat.properties`.
- [ ] 2.3 Add the rule of decision 6 to `resources/instructions.md`.
- [ ] 2.4 Add `test/assignments.test.mjs` with a case for each scenario of the capability `assignments`. Check the `Tests:` lines. Run `npm test`.

## 3. Documents

- [ ] 3.1 Add the section "Assignments" to `README.md`, with the file `assignments.jsonl` in "The state directory".
- [ ] 3.2 Live check in a temporary `MEGACHAT_HOME`: add 3 rows, link one to a cancelled run, restart the daemon, call `list`. Record it in `docs/manual-checks.md`.
- [ ] 3.3 Run `npm test` and `openspec validate assignments-ledger --strict`.

## Workflow follow-up

- After one week of use, the author marks the rows and the asks. The gate of step 2 is in `docs/assignments-brief.md`.
- Run `openspec validate --all --strict` after the merge.

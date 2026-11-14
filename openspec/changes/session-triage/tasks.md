# Tasks

## 1. Measure first

- [ ] 1.1 On a copy of the process table and with a temporary `MEGACHAT_HOME` and `sessions.index` on, list the buckets for the real sessions of the author. Record the counts, with the hand check of the author for 20 `abandoned` rows, in `docs/manual-checks.md`. Do not start the daemon on the real state directory. Stop and report if precision is below 90%.

## 2. The function and the tool

- [ ] 2.1 Add `src/SessionTriage.mjs` with `triage(rows, now)`, `ABANDONED_MS` and the title match of decision 4 of `design.md`.
- [ ] 2.1a Read the column `tty=` in `src/ProcessTable.mjs`, and keep the tty of each row inside the view of `RunningAgents` for the triage only (decision 1a of `design.md`). Add a case to `test/running.test.mjs` that the rows of `agents_running` keep exactly their present keys.
- [ ] 2.2 Register `agents_triage` in `src/PiMegachatService.mjs` over the view of `RunningAgents`, with the note of an incomplete list and the `unread` answer. Add the texts to `resources/Megachat.properties`.
- [ ] 2.3 Add the rule `instructions.triage` to `resources/instructions.md`: call the tool for "what waits for me", "what is stuck" and "what can I close"; give the count line, the `needs_you` rows and the close list with the age, the project and the `tty`; say that the log stays and that `agents_resume` can continue a session; name no close command; offer `agents_stop` for an orphan only. Add a case to `test/settings.test.mjs` for the rendered rule.
- [ ] 2.4 Add `test/triage.test.mjs` with a case for each scenario of the delta, with its values. Check the `Tests:` lines. Run `npm test`.

## 3. Measure and document

- [ ] 3.1 Hand-check the `possibleDuplicates` of one week. Cut the field, and its requirement, if precision is below 30%.
- [ ] 3.2 Update `README.md` with the tool and the buckets. Run `npm test` and `openspec validate session-triage --strict`.

## Workflow follow-up

- Archive the change: the capability `session-triage` joins `openspec/specs/`.
- Run `openspec validate --all --strict` after the merge.

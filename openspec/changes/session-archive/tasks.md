# Tasks

## 1. Checks before the code

- [x] 1.0 Study how Air archives (decision 3 and 8 of `design.md`). Done on 2026-11-14 with the Air sources at `e9de692b3d125` and the 16 real logs.
- [ ] 1.1 On copies of the logs, in a temporary `MEGACHAT_HOME`: check what Claude Code and the Codex TUI write on SIGTERM in a terminal, and whether `codex archive <id>` hides a thread in the Codex app and in Air. Record the results in `docs/manual-checks.md`. Stop and report if a log is broken.
- [ ] 1.2 File the IJAI ticket on `ignatov` only after the author says "да": Air keeps `[archived] ` as a contract for an ACP agent, and refreshes its list on that record.

## 2. The archive

- [x] 2.1 Add `src/SessionArchive.mjs`: the card (decision 4 of `design.md`), the checks and warnings (decision 5), the hide and restore in the format of Air (decision 3), with `ARCHIVED_TITLE_PREFIX`. Give `archived` to the records of Claude Code, pi and the Codex folder, and show it in `agents_sessions` and `list` (decision 8).
- [x] 2.2 Register `agents_archive` in `src/PiMegachatService.mjs` with the dialog of decision 6. Let `src/AgentStop.mjs` stop a session of a terminal or a multiplexer only on the archive route.
- [x] 2.3 Add the rule to `resources/instructions.md`: offer an archive of the close list of `agents_triage`; never archive without the dialog; give the command to continue. Add the strings to `resources/Megachat.properties`.
- [x] 2.4 Add `test/archive.test.mjs` with a case for each scenario of the delta of `session-archive`, with a fixture of the Air title format. Add the cases of the modified requirements to `test/stop.test.mjs` and `test/session-logs.test.mjs`. Check the `Tests:` lines. Run `npm test`.

## 3. Documents

- [x] 3.1 Add the section "Archive a session" to `README.md`, with the file `session-archive.jsonl` in "The state directory".
- [ ] 3.2 Live check in a temporary `MEGACHAT_HOME` on copies of 3 logs: archive a batch, restore one, search a ticket. Record it in `docs/manual-checks.md`.
- [ ] 3.3 Run `npm test` and `openspec validate session-archive --strict`.

## Workflow follow-up

- Archive this change after `session-triage`.
- Run `openspec validate --all --strict` after the merge.

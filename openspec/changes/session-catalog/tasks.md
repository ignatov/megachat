# Tasks

## 1. Checks before the code

- [ ] 1.1 In a temporary `MEGACHAT_HOME` with `HOME` copies of 3 logs of each agent and 20 `.zst` files, measure the first pass of the catalog: time, bytes read, memory. Record it in `docs/manual-checks.md`. Stop and report if the pass needs more than 60 seconds on 2800 files.
- [ ] 1.2 Read 20 real `summary.json` files of Air (read only): record which fields give the agent, the project and the archive state for an Air-only thread. Record it in `docs/manual-checks.md`.

## 2. The catalog

- [ ] 2.1 Add the table `catalog` and the migration of `logs` in `src/SessionIndex.mjs` (decision 8). Add the cases to `test/session-index.test.mjs`.
- [ ] 2.2 Add `describe`, the `.zst` and archived files in `all()`, and `hide`/`show` to the sources in `src/SessionSources.mjs`, `src/CodexSessionSource.mjs`, `src/ClaudeSessionSource.mjs` and `src/PiSessionSource.mjs`.
- [ ] 2.3 Add `src/AirThreadSource.mjs` and the Air link in the pass (decision 3).
- [ ] 2.4 Change `src/SessionCatalog.mjs` and `src/SessionIndexService.mjs`: the catalog has no age limit, and the window of `sessions.days` applies to `indexed` and the texts. Add `test/session-catalog.test.mjs` with a case for each scenario of `session-catalog` and `session-index`.
- [ ] 2.5 Change the default of `sessions.days` to 30 in `src/Settings.mjs`. Add the case to `test/settings.test.mjs`.

## 3. The consumers

- [ ] 3.1 Move `agents_sessions`, `agents_session_history`, `session_history` and `agents_running` to the catalog (decision 5). Add the cases to `test/running.test.mjs` and `test/session-index.test.mjs`.
- [ ] 3.2 Remove the own Codex lookup of `SessionArchive.record()` (decision 7). Keep the compressed-fixture test of `c3ff63d`, and make it pass through the catalog.
- [ ] 3.3 Add the project mode to `agents_archive`: `project`, `exclude`, `updatedWithinHours`, the frozen batch, the dialog, the 500 limit, the report check (decision 6). Add the strings to `resources/Megachat.properties`. Update `resources/instructions.md`.
- [ ] 3.4 Add the cases to `test/archive.test.mjs` for each scenario of the project mode, with copies of a store of Air.

## 4. Documents and checks

- [ ] 4.1 Update `README.md`: `sessions.days` (default 30, texts only), the catalog, and the archive by project.
- [ ] 4.2 Live check in a temporary `MEGACHAT_HOME` on copies of the logs: archive a project with an old Claude Code log, a Codex `.zst` log and an Air-only thread. Record the result in `docs/manual-checks.md`.
- [ ] 4.3 Check the `Tests:` lines. Run `npm test` and `openspec validate --all --strict`.

## Workflow follow-up

- Archive `session-archive` and `session-triage` first. Then archive this change.
- Run `openspec validate --all --strict` after the merge.

# Tasks

## 1. The settings

- [x] 1.1 In `src/Settings.mjs`, set the default of `sessions.index` to `on`, add `DEFAULTS` 2 and the key `defaults`
      of a new file, `SettingsStore.defaultOf`, the store of the earlier default at the first write, and the new file
      with `sessions.index` `off` after an unreadable file. Verify: the new case "the index is on by default, and a
      file of v0.6.3 or older after its setup keeps it off" of `test/settings.test.mjs` passes.
- [x] 1.2 Update the cases of `test/settings.test.mjs`, `test/project-settings.test.mjs` and `test/workday.test.mjs`
      that compare `settings.json`: the key `defaults` 2, and `sessions.index` `off` in a file of an earlier build.
      Verify: the cases pass, and the case of the unreadable file finds the new file with `sessions.index` `off`.

## 2. The index

- [x] 2.1 In `src/SessionIndexService.mjs`, start no event turn after a first pass without a session. Verify: the new
      case "a first pass that finds no session gives no summary" of `test/session-index.test.mjs` passes.
- [x] 2.2 Store `sessions.index` `off` in the cases "with the consent off" of `test/session-index.test.mjs` and
      `test/session-logs.test.mjs`. Verify: both cases pass.
- [x] 2.3 In `test/state-guard.mjs`, set `CODEX_HOME` and `PI_CODING_AGENT_SESSION_DIR` to empty temporary
      directories. In `test/live/smoke.mjs`, store `sessions.index` `off` in each home.

## 3. The setup and the offers

- [x] 3.1 In `resources/instructions-onboarding.md`, question 2 says that the default is on and that off deletes the
      index and the table of the running sessions. In `resources/instructions-onboarding-ghost.md`, the likely answer
      keeps the current value of the index. Verify: the checks of the text in `test/session-index.test.mjs` pass.
- [x] 3.2 In `test/setting-offers.test.mjs`, the fixture writes a file of this build, the rules after the setup hold
      the offer of `sessions.notes`, and the case of the notes stores `sessions.index` `off` first.

No new user-visible string goes to `resources/Megachat.properties`: the changed texts are in the setup rules.

## 4. Documents and specs

- [x] 4.1 Update `README.md`: the default `on` in the table of the settings, question 2 of the setup, the section of
      the index (the start before the setup, the answer off, a file of v0.6.3 or older, no summary without a
      session), and the live smoke run.
- [x] 4.2 Give each modified and new requirement its `Tests:` line. Verify: `openspec validate --all --strict` passes,
      and each requirement text has at most 500 characters.

No change of `docs/air-contract.md`: no ACP message changes.

## 5. Checks

- [x] 5.1 Run `npm test`. Verify: all tests pass.
- [x] 5.2 Run `npm run test:bundle`. The bundle of the lease is stale, and the run makes it again. Verify: all tests
      pass.
- [x] 5.3 Run `openspec validate --all --strict`. Verify: it passes.
- [ ] 5.4 Manual check in Air with a temporary `MEGACHAT_HOME`: a first start shows the import as a background task and
      question 2 with the default on; a copy of a `settings.json` of v0.6.3 with the onboarding `done` keeps the index
      off. Record the result in `docs/manual-checks.md`.

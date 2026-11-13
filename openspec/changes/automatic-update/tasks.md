# Tasks

## 1. The entry and the npx cache

- [x] 1.1 Take the result of the measurement of the npx cache: does `npx -y github:ignatov/megachat#semver:x acp` with the npm of the IDE select a new tag at the next start, with and without `--prefer-online`? Record it in `docs/manual-checks.md`. When the entry must change, add a delta of `install` that modifies "Entry of a copy without .git", replace the entry of this release in `install`, and update the cases of `test/install.test.mjs` and `test/package.mjs`. Run `npm test` and `npm run test:package`. Result: npx takes the new tag at each next start, so the entry and `install` stay unchanged.

## 2. The check of a release

- [x] 2.1 Add `src/MegachatUpdate.mjs`: the parse of the output of `git ls-remote --tags --refs`, the comparison by the base version, the command with `ENTRY_GIT_VARIABLES`, `GIT_TERMINAL_PROMPT=0` and the kill after 30 seconds, and `MEGACHAT_RELEASE_REPOSITORY`. Use a clock object as `src/MorningReport.mjs` does.
- [x] 2.2 In `test/state-guard.mjs`, set `MEGACHAT_RELEASE_REPOSITORY` to a path that does not exist and `MEGACHAT_RELEASE_NOTES_URL` to a local address that gives no answer, so no test uses the network.
- [x] 2.3 Add `test/update.test.mjs` with a local bare repository and a fake clock: the scenarios of "Check of a release", "Release version" and "Failed check of a release". Add the log line to `resources/Megachat.properties`. Run `npm test`.

## 3. The notice

- [x] 3.1 Give the field `update` in `/health` of `src/DaemonServer.mjs`, and the key `update` in `status` of `src/main.mjs`. Add `update.available` to `resources/Megachat.properties`.
- [x] 3.2 Cover "Notice of a release" in `test/update.test.mjs` and the modified "Version of the daemon in status" in `test/launch.test.mjs`. Run `npm test`.

## 4. The setting and the automatic stop

- [x] 4.1 Add `update.auto` to `SETTINGS` in `src/Settings.mjs` with the default `false` and `applies: 'update'`. Add its description and `settings.applies.update` to `resources/Megachat.properties`. Cover "Setting of the automatic update" in `test/settings.test.mjs`.
- [x] 4.2 Add the rule of the copy of npx to `src/MegachatUpdate.mjs`, and the conditions of decision 4 of `design.md` as a method of `PiMegachatService`. Add the checks every 10 minutes.
- [x] 4.3 In `src/main.mjs`, start the check after the publish of the connection file, stop it in `shutdown()`, and give the stop the same `shutdown()` as `/shutdown`. Send the event `update` on each event stream first. Add the log line of the stop to `resources/Megachat.properties`.
- [x] 4.4 Cover "Copy that updates itself", "Work at the automatic stop", "Time of the automatic stop", "Checks of the conditions" and "Automatic stop" in `test/update.test.mjs`. Verify that the daemon starts no process other than `git`. Run `npm test`.

## 5. The bridge

- [x] 5.1 In `src/AcpBridge.mjs`, end the connection at the event `update` with the line `log.update.bridge`. Without a view, ask `/health` every 60 seconds and end the connection after two failures or another `pid`, with the line `log.daemonGone`. Add both lines to `resources/Megachat.properties`.
- [x] 5.2 Cover the three requirements of the `daemon` delta in `test/recovery.test.mjs`, with a short interval of `/health` for the test. Verify that no daemon process runs after a request to the old bridge. Run `npm test`.

## 6. The state and the message after an update

- [x] 6.1 In `src/MegachatState.mjs`, add the field `update` with the migration of decision 6, the steps at the start, and the note before the input of a turn of the user and of the morning report.
- [ ] 6.2 Manual check of the author on a real IDE build: with a copy of npx and a temporary new tag, let the daemon stop itself, then send a message in Air. Record what Air shows at the exit of the agent, whether it starts `npx` again at the next message or attach, and whether it loads the session. Record the result in `docs/manual-checks.md`. When Air does not start the agent again, the author files the Air side as an IJAI ticket.
- [x] 6.3 In `src/MegachatUpdate.mjs`, get the notes with `fetch`, `MEGACHAT_RELEASE_NOTES_URL`, the time limit of 10 seconds and the limits of 40 lines and 8000 characters. Add `update.done`, `update.more` and `update.noNotes` and the log line to `resources/Megachat.properties`.
- [x] 6.4 Cover "Stop without an update", "Recorded version", "Message after an update", "Source of the release notes" and "Message without release notes" in `test/update.test.mjs`, with a local HTTP server. Run `npm test`.

## 7. Documents and the end

- [x] 7.1 Update `README.md`: "Update" in "Install for a colleague", the key `update` of `status` in "Commands", `update.auto` in "Settings and the first run", the variables of the tests in "Tests", and the field `update` of the state.
- [x] 7.2 Add the end of the agent process for an update and the expectation of Air to `docs/air-contract.md`. No ACP extension changes.
- [x] 7.3 Check each `Tests:` line of the deltas. Run `npm test`, `npm run test:bundle` and `openspec validate --all --strict`. Run `npm run test:package` when task 1.1 changed the entry or the launcher.

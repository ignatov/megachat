# Tasks

## 1. The removal of the entry

- [x] 1.1 Add `checkoutEntry()` and `removeEntry(path, now, ours)` to `src/MegachatInstall.mjs` (design, decisions 2 and 3). Cover "Entries that uninstall removes", "Write of acp.json at the removal", "Entry of another program" and "Nothing to uninstall" in the new `test/uninstall.test.mjs`, with `MEGACHAT_ACP_CONFIG` set to a temporary file by `test/state-guard.mjs` and by each case. Verify with `npm test`.
- [x] 1.2 Check that the `Tests:` lines of these requirements name `test/uninstall.test.mjs`, and that each scenario has its case with the same values.

## 2. The command uninstall

- [x] 2.1 Move the wait of `stopOtherBuild()` in `src/main.mjs` to a shared function with the time limit as an argument (30 seconds by default), and keep the behavior of `stopOtherBuild()`. Verify with `npm test`.
- [x] 2.2 Add `uninstall()` to `src/MegachatInstall.mjs` and the case `uninstall` to `src/main.mjs` in the order of design decision 5: read `acp.json`, check the daemon for work through `/health` and `/state`, remove the entry, send `/shutdown` and wait. It never calls `start()`. An unexpected error prints `uninstall.crashed`, as `install` prints `install.crashed`.
- [x] 2.3 Add each key of design decision 8 to `resources/Megachat.properties`, and print the lines in the order of that decision.
- [x] 2.4 Cover "Command uninstall", "Work that runs", "Stop of the daemon at uninstall", "State after uninstall", "Line about the switch of Air", "Last lines and exit code of uninstall" and "An error of uninstall has a reason" in `test/uninstall.test.mjs`. Run the launcher `bin/megachat.mjs` with a temporary state directory and a temporary `acp.json`. A daemon that does not end comes from a fake daemon such as `test/fake-daemon.mjs`. Verify with `npm test`.

## 3. The request in the chat

- [x] 3.1 Add `instructions.uninstall` to `resources/Megachat.properties` and to the settings section after `instructions.update` in `src/PiMegachatService.mjs` (design, decision 7). Cover "Request to remove Megachat in the chat" in `test/uninstall.test.mjs`, as `test/update.test.mjs` covers `instructions.update`. Verify with `npm test`.

## 4. The installed copy

- [x] 4.1 Add to `test/package.mjs` a step after `install`: `uninstall` of the installed copy with the same temporary `acp.json` and state directory removes the entry and exits with 0, and a second `uninstall` exits with 0. Run `npm run test:package`, because the change adds a command of the launcher and changes the code of `install`.

## 5. Documents

- [x] 5.1 Replace the paragraph "Removal" of `README.md`: the line of `uninstall`, the direct line of the copy without the network, the refusal while work runs, the switch of Air and that the daemon continues to run with it, the state directory that stays, the return with the install line, a hint to close the Megachat sessions in the IDE first, and the copies in the npm caches that stay. Add `uninstall` to the table "Commands".
- [x] 5.2 Add an open manual check to `docs/manual-checks.md`: with a Megachat session open in Air, run `uninstall`, then send a message in that session, and record whether Air starts `acp` again and so a new daemon.

## 6. Checks

- [ ] 6.1 Run `npm test`, `npm run test:package` and `openspec validate --all --strict`.
- [ ] 6.2 Manual check of the author, with `MEGACHAT_ACP_CONFIG` set to a temporary copy of `acp.json` and `MEGACHAT_HOME` set to a temporary directory: `install`, `start`, `uninstall`, `install` and `start` again, and the conversation is the same.

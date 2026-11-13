# Tasks

## 1. The entry and its time limits

- [ ] 1.1 In `src/MegachatInstall.mjs`, add the `env` of decision 1 of `design.md` to `RELEASE_ENTRY`, and export the two values for `src/npmEnvironment.mjs`. Change the case "Install in a copy" of `test/install.test.mjs` to the new JSON of the scenario. Verify that the checkout entry still has only the keys `command` and `args`.
- [ ] 1.2 Add a case to `test/install.test.mjs`: a local server on `127.0.0.1` that accepts each connection and never answers, and `git ls-remote http://127.0.0.1:<port>/megachat.git` with the `env` of `RELEASE_ENTRY` and `GIT_TERMINAL_PROMPT=0`. Verify that git ends in less than 30 seconds with the exit code 128 and "Operation too slow". The case ends git with SIGKILL after 40 seconds, so it cannot hang.
- [ ] 1.3 Check the `Tests:` lines of the delta of "Entry of a copy without .git" and of "Time limits of the network in the entry". Run `npm test`.

## 2. The replacement of the entry of install 0.3.0

- [ ] 2.1 Add the check of the entry of `install` 0.3.0 next to `earlierEntry`, and accept both in a copy without `.git`. Add the message `install.replacedEarlier` to `resources/Megachat.properties` and print it with the earlier entry. Verify with the two scenarios of "Replacement of the entry of install 0.3.0" in `test/install.test.mjs`: the entries `First`, `Megachat` of 0.3.0 and `Last` with the mode 0640, and an entry of 0.3.0 with an `env` with `HTTPS_PROXY` that stays unchanged with the exit code 1.
- [ ] 2.2 Verify that the cases of the entry of 0.2.0 and of "Different entry" pass with no change. Check the `Tests:` line. Run `npm test`.

## 3. The lines of install

- [ ] 3.1 Add `install.network` and `install.air` to `resources/Megachat.properties`, with the texts of decision 4 and of the scenarios: "Each start of Megachat in the IDE needs the network ..." and "Megachat cannot check the IDE build. ...". Print them in the order of decision 4.
- [ ] 3.2 Verify in `test/install.test.mjs`: in a copy, both lines come before "The IDE starts Megachat with npx", and the exit code stays 0 when each check passes; in a checkout, only `install.air` comes, before the last line. Verify that the case "Install in a copy" of "Last lines and exit code of install" passes with no change.
- [ ] 3.3 Check the `Tests:` lines of "Line about the network" and "Line about the IDE build". Run `npm test`.

## 4. The daemon and the client

- [ ] 4.1 In `withoutNpm` of `src/npmEnvironment.mjs`, remove the two variables when each has the value of the entry. Verify with the two scenarios of "Variables of the entry after a start by npm" in `test/environment.test.mjs`, and with a direct start that keeps the values.
- [ ] 4.2 In `src/AcpBridge.mjs`, write `log.noAir` to the error output one time for each connection when `initialize` has no `_meta.jetbrains.air` with the version 1 or more. Add `log.noAir` to `resources/Megachat.properties`. Verify with the two scenarios of "Line of a client without the Air support" in `test/recovery.test.mjs`.
- [ ] 4.3 In `test/package.mjs`, start the npx entry with the `env` of `RELEASE_ENTRY` added to the environment of the IDE. Verify that the daemon has neither variable and that `install` of the copy writes the entry with the `env`. Run `npm run test:package`, because `install` and the entry change.
- [ ] 4.4 Check the `Tests:` lines. Run `npm test`.

## 5. Documents and manual checks

- [ ] 5.1 Update `README.md`: the entry with its `env` in "Install for a colleague", what the two variables do and what they do not end, the proxy case and the request to Air in "The start in the IDE", and the replacement of the entry of 0.3.0.
- [ ] 5.2 Add the local probe of 2026-11-13 (the table of `design.md`) to `docs/manual-checks.md`.
- [ ] 5.3 Manual check of the author, with a real network cut: turn off Wi-Fi and each other network, with a warm npm cache of the IDE. Open Megachat in the IDE. Record the time to the end, the exit code, the error output of npx in the log of the IDE (`idea.log` or the log of the ACP agent), and what the IDE shows. Repeat with an empty npm cache of the IDE. Record whether the SSH fallback of npm waits, and how long.
- [ ] 5.4 Manual check of the author: with the network on, start a local server that accepts each connection and never answers (for example the probe server of 5.2), and set `HTTPS_PROXY` to it in the `env` of the entry `Megachat` next to the two variables. Open Megachat in the IDE. Verify that the IDE passes the `env` (the start goes to the proxy), and record how long the start waits before the IDE or npx ends it. Remove the proxy from the entry after the check.
- [ ] 5.5 Manual check of the author, with a real network cut of the connection only: block the packets to port 443 of `github.com` with `pfctl` (a rule `block drop`), and open Megachat in the IDE. Record the time to the end and the output. Remove the rule after the check.
- [ ] 5.6 Manual check of the author: open Megachat in an IDE build without the Air support. Record where the IDE shows the line `log.noAir`, and whether the IDE cancels or closes the session when a window releases it.
- [ ] 5.7 Manual check of the author: run the npx entry two times in a row in a terminal with the network on and `--loglevel silly`, as after the first start. Record the reason when a start ends at once with the exit code 128.
- [ ] 5.8 The author files one IJAI ticket for the Air side of `proposal.md`: a time limit for the first answer of an npx agent, the exit code and the error output of an agent that ends before its first answer, and a sign of progress during the first start. No ACP extension changes, so `docs/air-contract.md` does not change.
- [ ] 5.9 Record the results of 5.3 to 5.7 in `docs/manual-checks.md` and in `README.md`, part "The start in the IDE". Run `npm test`, `npm run test:package` and `openspec validate first-start-feedback --strict`.

## Workflow follow-up

- Archive the change: the deltas of `install` and `launch` merge into their specs.
- Run `openspec validate --all --strict` after the merge.
- Commit with `Part of #38`: the other risks of the issue stay open.

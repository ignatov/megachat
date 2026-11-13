# Tasks

## 1. The launcher

- [ ] 1.1 Add `src/MegachatLauncher.mjs` with the text of the launcher (decisions 2, 3 and 5 of `design.md`): only `node:` imports, the state directory from its own path, `git ls-remote --tags --refs` with the time limit of 10 seconds and `SIGKILL`, the direct start of the recorded copy, the npx run, and the start without GitHub. Add `launcher.offline` ("Megachat could not reach GitHub, so it started the installed release {0}.") and `launcher.noCopy` ("Megachat could not reach GitHub, and no release of Megachat is installed. Connect to the network, and open Megachat again.") to `resources/Megachat.properties`, and put them into the text at the time of the write.
- [ ] 1.2 Add `test/launcher.test.mjs` with a local bare git repository with tags, a fake copy in `_npx/<hash>/node_modules/megachat` and a fake npx. Verify each scenario of "Check of GitHub at a start", "Start of the recorded copy", "Start through npx", "Start without GitHub" and "Process of the launcher" of the capability `launcher`, with the values of the scenarios. The case of the server that never answers ends the launcher with `SIGKILL` after 30 seconds, so it cannot hang. Add a case that compares the highest tag of the launcher with `releaseParts` of `src/MegachatUpdate.mjs` on the same list of tags.
- [ ] 1.3 Check the `Tests:` lines of the capability `launcher`. Run `npm test`.

## 2. The record of the copy and the correction of the launcher

- [ ] 2.1 In `src/main.mjs`, at the start of the daemon of a copy of npx (`npxCopy`), write `launcher/copy.json`, and write `launcher/start.mjs` again when it exists and differs, with a temporary file and a rename, the mode 0600 and the directory mode 0700. Verify with the scenarios of "Record of the copy", "Correction of the launcher" and "Directory of the launcher" in `test/launcher.test.mjs`, and with a daemon of a checkout that writes no `launcher/` (`test/home.test.mjs`).
- [ ] 2.2 Update the table "The state directory" of `README.md` with `launcher/start.mjs` and `launcher/copy.json`. Check the `Tests:` lines. Run `npm test`.

## 3. The entry and install

- [ ] 3.1 In `src/MegachatInstall.mjs`, make the entry of a copy without `.git` the launcher entry of decision 1, with the quotation of the path for `sh`, and write `launcher/start.mjs` in each run in a copy without `.git`. Change the case "Install in a copy" of `test/install.test.mjs` to the JSON of the scenario, and add the case of the state directory `/tmp/it's` and the cases of "Write of the launcher".
- [ ] 3.2 Replace the npx entry with the time limits (decision 6). Add `install.replacedLauncher` to `resources/Megachat.properties`. Verify both scenarios of "Replacement of the npx entry with the time limits" in `test/install.test.mjs`, and that the cases of the entries of 0.2.0, 0.3.0 and 0.4.0 still pass and give the launcher entry.
- [ ] 3.3 Change `install.network` to the text of the modified "Line about the network": "Each start of Megachat in the IDE asks GitHub for the last release. Without an answer in 10 seconds, the IDE starts the installed release. Only the first start in the IDE needs the network." Verify the three scenarios in `test/install.test.mjs`.
- [ ] 3.4 In `test/package.mjs`, start the launcher entry with the environment of the IDE, the npx of the test Node.js and `MEGACHAT_RELEASE_REPOSITORY` set to the local repository. Verify that the first start installs the highest tag through npx, the daemon records its copy, a second start starts the copy directly, a higher tag gives the new release, a removed repository starts the recorded copy with the line `launcher.offline`, and the daemon has no variable of npm. Run `npm run test:package` once, because the entry and `install` change.
- [ ] 3.5 Check the `Tests:` lines of the capability `install`. Run `npm test`.

## 4. Documents and manual checks

- [ ] 4.1 Update `README.md`: the entry in "Install without the setup line", the start without the network and the 10 seconds in "The start, the update and the removal", the replacement of the npx entry with the time limits, and a line for existing colleagues to run the setup line again. Update the command of the entry in "The end of the agent for an update" of `docs/air-contract.md`.
- [ ] 4.2 Add the probe of `design.md`, part "Context", to `docs/manual-checks.md`.
- [ ] 4.3 Manual check of the author: run `install` of the release in a VM with a temporary `acp.json`, and record the entry and the backup of an earlier npx entry with the time limits.
- [ ] 4.4 Manual check of the author: open Megachat in Air with the new entry, with the network on. Record the time to the first answer of a warm start and of a start after a new release, and compare them with the median of 3.1 seconds of the entry of today.
- [ ] 4.5 Manual check of the author: with a running daemon, turn off the network, and open Megachat in a new window. Then block only the packets to `github.com` with `pfctl`. Record the time to the first answer, whether the window shows the same conversation, and where Air shows the line `launcher.offline`.
- [ ] 4.6 Manual check of the author: run the setup line again while a window of Megachat is open. Record what Air does with the open window after the change of `acp.json`.
- [ ] 4.7 The author files one IJAI ticket for the Air side: a time limit for the first answer of an agent, and a progress state while the agent process starts.
- [ ] 4.8 Record the results of 4.3 to 4.6 in `docs/manual-checks.md` and in `README.md`. Run `npm test`, `npm run test:package` and `openspec validate start-without-github --strict`.

## Workflow follow-up

- Archive the change: the deltas of `install`, `state-directory` and the new capability `launcher` merge into the
  specs.
- Run `openspec validate --all --strict` after the merge.

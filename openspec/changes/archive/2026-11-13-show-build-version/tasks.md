# Tasks

## 1. The version of a build

- [x] 1.1 Add to `src/sourceBuildId.mjs` the function of decision 2 of `design.md`: the version of `package.json` for a root without `.git`, else one `git describe` with a time limit of 2 seconds and the form of decision 1, else `<version>+dev`. Verify with new cases in `test/launch.test.mjs` on a temporary repository with the values of the scenarios of "Version of a build" and "Version without an answer of git": the tag `v0.3.0` gives `0.3.0`, two commits give `0.3.0+2.g<7 digits>`, a change of a tracked file adds `.dirty`, the version `0.4.0` without its tag gives `0.4.0+g<7 digits>`, a copy without `.git` gives `0.3.0` and starts no git command, and a `.git` file with `gitdir: /elsewhere` gives `0.3.0+dev`.
- [x] 1.2 In `src/MegachatBuild.mjs`, replace the constant `VERSION` with a function that computes the version one time in each process at the first use, and that gives the define `MEGACHAT_VERSION` in the bundle. Change each use: `src/AcpBridge.mjs`, `src/MegachatInstall.mjs`, `src/AcpRunService.mjs`, `src/AgentAccountCheck.mjs`, `src/CodexAppServerClient.mjs`, `src/MegachatHistoryServer.mjs`. Verify that `test/recovery.test.mjs` compares `agentInfo.version` with the computed version of the checkout and passes. Run `npm test`.
- [x] 1.3 Check that the `Tests:` lines of "Version of a build" and "Version without an answer of git" name `test/launch.test.mjs`, and that each scenario matches a test case with its values.

## 2. The bundle

- [x] 2.1 In `build.mjs`, compute the version with the function of 1.1 and add the define `MEGACHAT_VERSION`. Change `test/bundle.test.mjs`: `agentInfo.version` of the bundle is the computed version of the checkout. Run `npm run test:bundle`, because `build.mjs` changes.
- [x] 2.2 Check the `Tests:` line of the delta of "Version in the agent information". Run `npm test`.

## 3. The daemon and status

- [x] 3.1 In `src/DaemonServer.mjs`, add the key `megachatVersion` to the answer of `/health`. In `src/main.mjs`, make `status` print `version` from `/health` directly after `running`, and no key when the daemon gives none. Verify with a new case in `test/launch.test.mjs`: the keys `running`, `version`, `current` and `children` in this order, with the computed version of the checkout; and a stand-in `/health` without the key gives a line without `version`.
- [x] 3.2 Check the `Tests:` line of "Version of the daemon in status". Run `npm test`.

## 4. install

- [x] 4.1 Verify with a new case in `test/install.test.mjs`: `install` in a temporary git repository with the version `0.3.0`, the tag `v0.3.0` and two commits prints the last line "Megachat 0.3.0+2.g<7 digits> runs from <directory>.". The case "Install in a copy" keeps its text. No new string goes to `resources/Megachat.properties`: the messages `install.copy` and `install.release` keep their text and get the new value.
- [x] 4.2 Run `npm run test:package`, because `install` and the launcher path of the version change. Verify that the packed copy still gives the version of `package.json` in `agentInfo`.
- [x] 4.3 Check the `Tests:` line of the delta of "Last lines and exit code of install". Run `npm test`.

## 5. Documents

- [x] 5.1 Update `README.md`: in "Install from a checkout", the version of a checkout with an example; in "Commands", the key `version` of `status`; in "Releases", that a copy of the install line gives the release form and that the build and the tests of a release run give `<version>+g<commit>`; the row of `src/MegachatBuild.mjs`, `src/sourceBuildId.mjs`.
- [x] 5.2 Update the line about `agentInfo` in `docs/air-contract.md`: the version of the build, not the version of `package.json`. No ACP extension changes, so Air needs no change and no IJAI ticket.
- [x] 5.3 Run `npm test`, `npm run test:bundle`, `npm run test:package` and `openspec validate show-build-version --strict`.

## 6. Manual checks of the author

- [ ] 6.1 Start Megachat from the checkout of `main` in the IDE with the Air support. Verify that the agent information of the IDE (the log or the about view of the agent, where the IDE shows it) has `0.4.0+<count>.g<commit>`, and that `node src/main.mjs status` prints the same `version`.
- [ ] 6.2 After the first release with this change, run the install line with a temporary `MEGACHAT_ACP_CONFIG` and a temporary npm cache. Verify that the last line gives the release form, such as "Megachat 0.4.1", with no `+`. Record both results in `docs/manual-checks.md`.

## Workflow follow-up

- Archive the change: the deltas of `launch` and `install` merge into their specs.
- Run `openspec validate --all --strict` after the merge.
- Commit with `Fixes #33` only when the author also made the release; else `Part of #33`.

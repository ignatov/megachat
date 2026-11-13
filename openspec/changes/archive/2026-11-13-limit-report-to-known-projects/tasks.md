# Tasks

## 1. The filter of the tokprof part

- [x] 1.1 In `src/Tokprof.mjs`, give `parseTokprof` the option `known`: a list of the real paths of the known projects. Apply decision 3 of `design.md`: the pi line of the state directory first, then `expandHome`, then `isWithin` on the path and on its `directoryKey`, one real path for each distinct frame. Sum only the lines that count. Add `otherWork: 'notShown'` when at least one other line is left out. Give `readTokprof` the same option, and keep one run with the same arguments.
- [x] 1.2 In `test/morning-report.test.mjs`, change the case "the tokprof part sums the cost by agent, project and origin" to pass the known projects `/home/user/src/demo-app` and `/home/user/src/demo-tool`, so it keeps its values. Add cases with the values of the scenarios of "Projects of the tokprof part" and "Other work on this machine": `~/src/demo-app/server` counts, `~/src/demo-app-2` and `temporary folders` do not; a symbolic link `~/link-app` to a known repository in a temporary home counts; only the workspace gives 0 USD and empty lists; private work gives `otherWork` `notShown`, no agent `codex`, and a JSON of the part without `private-app`, `codex chats`, 32 and 47; no other work gives no `otherWork`.
- [x] 1.3 Run `npm test`.

## 2. The known projects of a report

- [x] 2.1 In `src/MorningReport.mjs`, make `collectReportData` compute the set of decision 2: the `cwd` of each entry of `directoriesOf(state)`, and the `cwd` of each child run in `children` and in `permissionsWaiting`. Pass it to `readTokprof` as real paths.
- [x] 2.2 In `test/workday-daemon.mjs`, make the state of `daemonFixture` list `~/src/demo-app` and `~/src/demo-tool` of its home directory, so the lines of `folded` count. Check that the case "the report is one automatic turn at the start of the day" keeps 20 USD, `agents.pi` 1 and `excludedPiChildUsd` 0.7, as the scenario "The money of a report" says.
- [x] 2.3 Add daemon cases to `test/morning-report.test.mjs`: a known repository `~/src/demo-app` and a fake tokprof line of `~/src/private-app` give 15 USD and a data JSON without `private-app` ("A project that Megachat does not know"); a child run of the period in `~/src/old-app`, which is not listed, gives 2 USD for it ("A child run in a removed project"); the workspace and three known repositories give one line in the arguments file of the fake tokprof, without `--project` ("Many known projects").
- [x] 2.4 Extend the case "the tokprof command runs from PATH with a time limit": the directory `megachat-tokprof-*` of the run does not exist after `readTokprof` ends. The arguments file of the fake tokprof gives the path after `-o`: check that its parent directory does not exist.
- [x] 2.5 Run `npm test`.

## 3. The rules of the turn and the strings

- [x] 3.1 In `resources/Megachat.properties`, add to `event.morning` after the sentence about `money.otherSessions`: "money.otherSessions holds only the projects that Megachat knows. When money.otherSessions.otherWork is notShown, say: Other work on this machine: not shown. Guess nothing about the cost or the projects of that work."
- [x] 3.2 Change `setting.report.morning`: the API-equivalent cost of the other agent sessions from tokprof, only in the projects that Megachat knows.
- [x] 3.3 In `test/morning-report.test.mjs`, assert that the prompt of the report matches "Other work on this machine: not shown." ("Private work on the machine").
- [x] 3.4 Run `npm test`.

## 4. Specs and documents

- [x] 4.1 Check that each modified and added requirement of the delta has the `Tests:` line `test/morning-report.test.mjs`, and that each scenario matches a test case with its values.
- [x] 4.2 Update "The morning report" in `README.md`: the Money part gives the API-equivalent cost only in the listed directories and in the projects of the child runs of the period; the report says "Other work on this machine: not shown." for the rest; a group of tokprof, such as `temporary folders`, is not shown; a listed worktree can show no cost, because tokprof names a worktree by its main repository.
- [x] 4.3 No ACP extension changes, so `docs/air-contract.md`, Air and the IJAI ticket need no change. `npm run test:bundle` and `npm run test:package` are not necessary: `build.mjs`, `package.json`, the launcher and `install` do not change.
- [x] 4.4 Run `npm test` and `openspec validate --all --strict`.

## 5. Manual checks of the author

- [ ] 5.1 Start the daemon with `MEGACHAT_HOME=$(mktemp -d)`, `report.morning` on, one known repository with a child run of the period, and tokprof on `PATH`. Verify that the Money part names only that repository, gives no sum of four digits, and says "Other work on this machine: not shown."
- [x] 5.2 For the same period, compare the cost of the report for that repository with `tokprof flame --project <repository> --stack agent,project --value cost -o <temporary file>`. The two values must agree, apart from the lines that `--project` matches by a part of the text.
- [x] 5.3 Record both results in `docs/manual-checks.md`.

## Workflow follow-up

- Archive the change: the delta of `morning-report` merges into its spec.
- Run `openspec validate --all --strict` after the merge.
- Commit the code with `Fixes #36`.

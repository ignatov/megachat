# Tasks

## 1. The scope and its state directory

- [x] 1.1 In `test/state-guard.mjs`, delete `MEGACHAT_PROJECT` from the environment of each test process, next to the guard of `MEGACHAT_HOME` (design.md, decision 2). Export the name of the variable from `src/MegachatHome.mjs`. Verify that `npm test` passes with `MEGACHAT_PROJECT=/tmp` in the shell.
- [x] 1.2 Add `resolveProject()` and `projectStateDirectory()` to `src/MegachatHome.mjs` (design.md, decisions 2 and 3): the real path, the refusal of a path that `resolveRepository()` refuses, the name of at most 40 characters and the digest of 12 hexadecimal digits. Add the errors `project` and `projectState` with their strings to `resources/Megachat.properties`. Verify with the cases of 1.5.
- [x] 1.3 In `src/main.mjs`, read `MEGACHAT_PROJECT` one time before `start()`: select the state directory, give it to the daemon as its final argument, skip `connectLegacy()` and the copy of an earlier directory, and end `acp`, `start`, `daemon`, `status`, `stop` and `compact` with the exit code 1 and one line for a refused value. Verify with the cases of 1.5.
- [x] 1.4 In the daemon start of `src/main.mjs`, write `project.json` with the mode 0600 before the connection file, end with `projectState` for another directory in the file, and take the scope of the file when the variable is not set (design.md, decision 3). Verify with the cases of 1.5.
- [x] 1.5 Add `test/project-scope.test.mjs` with the cases of "Selection of the scope", "Refused project directory", "State directory of a project scope" (the values `My_App-ed3ef1005942` and `app-70467eff2e0a`), "Record of the project" and "Own state of a project scope". Add the cases "The directory of a project scope" and "A project scope" of the delta of `state-directory` to `test/home.test.mjs`. Use a temporary `MEGACHAT_HOME` in each case. Verify that `npm test` passes.
- [x] 1.6 In `README.md`, add the section "The scopes of Megachat" before "The state directory": the machine scope and a project scope, the variable `MEGACHAT_PROJECT`, the directory `projects/<name>-<digest>`, the file `project.json`, own settings and memory, the cost of one daemon for each Megachat, and that a directory that moves gets a new Megachat. Add `projects/` and `project.json` to "The state directory", and the variable to "Commands" for `status`, `stop` and `compact`. Change the product line of `context` in `openspec/config.yaml` to name the two scopes. Verify that each command of the new text runs as written with a temporary `MEGACHAT_HOME`.

## 2. The directories of a project scope

- [x] 2.1 Give `MegachatState` the project directory, and keep it in `projectDirectory` of the state document: `initialize` sets it, or `null`, and it sets `megachatWorkspace` to `null` in a project scope (design.md, decisions 3 and 4). Give the directory first in `directoriesOf()` with the origin `project`, and accept it in `isDirectoryOf()` of `src/ProjectDirectories.mjs`. Verify with the cases of 2.4.
- [x] 2.2 In `addWorkspace()`, refuse in a project scope each directory that is not the project directory, a directory in it, or a linked worktree whose main repository is the project directory. Keep the bridge as it is. Verify with the case "Registered directories" of 2.4.
- [x] 2.3 In the tool `agents_projects` of `src/PiMegachatService.mjs`, fail `add`, `remove`, `discover` and `create` with the new error `projectScope` in a project scope. Add its string to `resources/Megachat.properties`, and add the origin `project` to the text of `tool.list`. Verify with the cases of 2.4.
- [x] 2.4 Add the cases of "Directories of a project scope" and "No change of the list in a project scope" to `test/project-scope.test.mjs`, with a real linked worktree from `git worktree add`. Add the cases "A session search in a project scope" and "A task in the workspace of a project scope" of the delta of `projects` there too. Check that the `Tests:` lines of the delta of `projects` name `test/project-scope.test.mjs`. Verify that `npm test` passes.

## 3. The sessions of the machine in a project scope

- [x] 3.1 Give `SessionCatalog` the option `scope`, and pass it from `src/SessionIndexService.mjs` in a project scope: the live table keeps a session file only when its `cwd` is a listed directory or a directory in one, reads of another file only the lines that give the `cwd`, and takes a change of the listed directories (design.md, decision 5). Verify with the case "The live table and the history" of 3.4.
- [x] 3.2 In `RunningAgents.scan()` of `src/RunningAgents.mjs`, drop in a project scope each row whose `cwd` is unknown or out of the listed directories. Refuse in `AgentStop.targets()` a PID that this view does not give, and in `SessionArchive.record()` a compressed Codex file of another directory. Verify with the cases "The running sessions", "A stop of a session out of the scope" and "An archive of a session out of the scope" of 3.4.
- [x] 3.3 In `src/Settings.mjs`, refuse the value `on` of `cloud.sessions` in a project scope with `projectScope`. Verify with the case "A set to on" of 3.4.
- [x] 3.4 Add the cases of "Sessions of the machine in a project scope" and "Cloud sessions in a project scope" to `test/project-scope.test.mjs`: the running sessions with the fake process tree, the stop, the live table with `agents_session_history` and the notes, and the archive. When a reader finds a session that the live table does not hold, add the same check at that reader. Verify that `npm test` passes.
- [x] 3.5 In `README.md`, add to "The scopes of Megachat" what a Megachat of a project does not see: the other projects, the known repositories, the sessions of other directories and the cloud sessions. Verify that the text names each tool of the requirement "Sessions of the machine in a project scope".

## 4. The rules and the setup of a project scope

- [x] 4.1 Add `resources/instructions-project.md` with the text of design.md, decision 6, and put it after the bundled rules in a project scope in `src/PiMegachatService.mjs`. The text holds no path. Verify with the cases of "Rules of a project scope" in 4.3.
- [x] 4.2 Add `resources/instructions-onboarding-project.md` (design.md, decision 6), and use it in a project scope in place of `instructions-onboarding.md`, also in the result of `agents_settings` with the status `pending`. Add the string `onboarding.offer.project` to `resources/Megachat.properties`, and give it to `startOnboardingNote` in a project scope with the last segment of the project directory. Verify with the cases of 4.3.
- [x] 4.3 Add the cases of "Rules of a project scope", "Setup rules of a project scope" and "Setup note of a project scope" to `test/project-scope.test.mjs`, and the case "No settings file in a project scope" of the delta of `settings`. Verify that `npm test` passes.
- [x] 4.4 In `README.md`, add to "Settings and the first run" that a Megachat of a project asks two questions and keeps its own settings. Verify that the text names the two questions of `instructions-onboarding-project.md`.

## 5. The capabilities and the request `_agent/stop`

- [x] 5.1 In the answer of `initialize` in `src/AcpBridge.mjs`, add `agentStop` for each client and `projectScope` in a project scope, after the present values. Change the expected list in `test/transcript.test.mjs` (the line with `['persistentSession', 'asyncTasks']`). Verify with the cases of 5.3.
- [x] 5.2 Move `workLines()` and the wait for the end of a daemon out of `src/MegachatInstall.mjs` into a module that `uninstall` and the bridge both load. Add the handler of `_agent/stop` to `src/AcpBridge.mjs` as design.md, decision 7, says. Add the strings `stop.agent.busy` with its parts, `stop.agent.timeout` and `log.agentStopped` to `resources/Megachat.properties`. Verify with the cases of 5.3, and that `test/uninstall.test.mjs` still passes.
- [x] 5.3 Add `test/agent-stop.test.mjs` with the cases of "Capability agentStop", "Stop at the request of the client", "Refusal while work runs", "State after the stop" and "Daemon that does not end" (a time limit of 200 ms). Add the cases of "Capability projectScope" to `test/project-scope.test.mjs`. Verify that `npm test` passes.
- [x] 5.4 Update `docs/air-contract.md` as design.md, decision 10, says: the section "The scopes of Megachat", the rows `agentStop` and `projectScope` of the capabilities, the row `_agent/stop` of the requests, and the button "Spawn Megachat" in "The agent identity". Verify that each key and each value of the text is the one of the code and of the tests of 5.3.
- [ ] 5.5 Write the text of the Air ticket in `openspec/changes/spawn-megachat/air-ticket.md` with the five points of design.md, decision 11. The author files it as an IJAI ticket and puts its number into the file and into `docs/air-contract.md`. Verify that the file names each capability, the variable and the request.
- [x] 5.6 In `README.md`, change step 2 of "Quick start" and step 3 of "Install for a colleague" to "press Spawn Megachat in Agent Sessions", and add to "The start, the update and the removal" what "Remove Megachat" does: it stops the daemon when no work runs, the state stays, and a new "Spawn Megachat" gives the same conversation. Verify that no text of `README.md` still tells the user to select Megachat in the agent list.

## 6. Several daemons of one copy

- [x] 6.1 Add `stateDirectories()` (design.md, decision 8), and make `uninstall()` of `src/MegachatInstall.mjs` act on each directory of the state tree: it ignores `MEGACHAT_PROJECT`, names the project directory in each work line, refuses when one daemon has work, and stops each daemon. Add the cases of "Uninstall with project scopes" to `test/uninstall.test.mjs`. Verify that `npm test` passes.
- [x] 6.2 Add the routes `GET /update/ready` and `POST /update/stop` to `src/DaemonServer.mjs`, and make the stop for an update in `src/main.mjs` and `src/MegachatUpdate.mjs` ask each other daemon of the state tree, stop each ready daemon of the same copy, and stop nothing when one is not ready (design.md, decision 8). Add the cases of "Update of a copy that several daemons use" to `test/update.test.mjs`. Verify that `npm test` passes.
- [x] 6.3 In `README.md`, add to "The start, the update and the removal" that `uninstall` stops the daemon of each Megachat, that an update stops each daemon of one copy together, also a daemon with `update.auto` off, and that two Megachats can each run a child in one checkout. Add the new files to "Code map". Verify that the text of `uninstall` is the output of the command in a temporary `MEGACHAT_HOME` with `MEGACHAT_ACP_CONFIG` set to a temporary file.
- [ ] 6.4 Run `npm run test:package`, because `src/MegachatInstall.mjs` changed. Verify that it passes.

## 7. The checks of the whole change

- [x] 7.1 Check that each `Tests:` line of the deltas names a test file that has a case for each scenario. Run `openspec validate --all --strict`, and verify that it passes.
- [x] 7.2 Run `npm test`, and run `npm run test:bundle` to verify that the bundle holds the two new files of `resources/`. Verify that both pass.
- [ ] 7.3 Manual check of the author, with a temporary `MEGACHAT_HOME`: start `acp` two times through an ACP client, one time without and one time with `MEGACHAT_PROJECT` for a small project. Verify two daemons, the setup note of the project, a task that starts in the project, a refusal of a task in another directory, and `_agent/stop` with and without a child run. Write the result in `docs/manual-checks.md`.
- [ ] 7.4 Manual check with an Air build that has the change of the ticket of 5.5: "Spawn Megachat" for the IDE and for a project, and "Remove Megachat" for both. Until such a build exists, record the check as open in `docs/manual-checks.md`.

## Workflow follow-up

- The author approves the proposal before `/opsx:apply`.
- The change of Air is a separate change in the repository of the IDE. The ticket of task 5.5 holds it.
- Archive the change with `/opsx:archive` after the review, then run `openspec validate --all --strict`.

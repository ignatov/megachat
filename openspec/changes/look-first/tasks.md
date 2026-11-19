# Tasks

## 1. The time of the addition of a directory

- [x] 1.1 Add the map `addedAt` to the state in `src/MegachatState.mjs`: `initialize` adds `addedAt ??= {}`; `addWorkspace`, `addProject`, `addProjects` and `createProject` set the time only for a path that is not in the list of the directories yet; `removeProject` deletes the entry only when the path is not a project of an IDE (design.md, decision 4). Verify with `npm test`.
- [x] 1.2 Give `addedAt` as an ISO 8601 time in UTC in `directoriesOf` of `src/ProjectDirectories.mjs`, so `agents_list` and `agents_projects` get it, and the workspace of Megachat gets none. Add the sentence of design.md, decision 4, at the end of `tool.list` in `resources/Megachat.properties`, after the sentence of `continue-child-sessions` about `hotSessions`.
- [x] 1.3 Add the cases of "Time of the addition of a directory" to `test/projects.test.mjs`: two additions with a second registration of `outside`, an older state with a remove and a new add, and the description of `agents_list`. Use the mock timers of `node:test` and the real values of the scenarios. Verify that `npm test` passes.

## 2. The tool ls of a pi child

- [x] 2.1 Add the tool `ls` to `src/PiChild.mjs` next to `readTool`, with `replay: 'safe'`: it calls `listDir` of the environment of the child, checks the real path again after the list, and gives the sorted names with `/` for a directory, at most 500 entries, and `truncated` (design.md, decision 5). Give it to the extension of a pi child and to `childAgent`. Verify with `npm test`.
- [x] 2.2 Change `child.pi.instructions` in `resources/Megachat.properties` as design.md, decision 5, says: the two tools, no "list a directory" in the list of what the child cannot do, and "Never copy the value of a token, a key or a password into your answer. Name its file."
- [x] 2.3 In `test/pi-child.test.mjs`, change the case of "Tool of a pi child" to expect the tools `read` and `ls`, and add the cases of "Instructions of a pi child" (the tools and the secrets) and of "Directory list of a pi child": a list of the project, paths out of the project and a directory of 501 files, and a directory that another process swaps after the path check. Check that the test harness still tells a child request by its tool `read`. Verify that `npm test` passes.
- [x] 2.4 Change the paragraph "Pi children: cheap tasks that only read" of `README.md`: a pi child reads and lists the files of its project, and the main agent uses pi for a look or when you name it. Change the rows of `src/PiChild.mjs` and `src/ProjectReadEnv.mjs` in the code map when they name only `read`.

## 3. The rules and the tool descriptions

- [x] 3.1 Replace the lines "Start a task without a project in the Megachat workspace, ...", "Ask the user when the project is unclear. ..." and "Use agent=pi only when the user names pi. ..." of `resources/instructions.md` with the lines of design.md, decision 3, and add the line about a claim after the line "When a child fails with an error about a login, an account or a key, ...". Find each line by its text. Keep each rule of a hot child session of `continue-child-sessions` as it is (design.md, decision 7).
- [x] 3.2 In `tool.spawn` of `resources/Megachat.properties`, replace only the pi sentence with the sentence of design.md, decision 7. Keep the sentence of `continue-child-sessions` about a hot child session.
- [x] 3.3 Add a new `test/look-first.test.mjs`. It reads `resources/instructions.md` and the descriptions of the tools of `service.extension()`, and it has the cases of "Look before a question", "Question that decides something", "Definition of a look", "Task in the project of its means", "Directory that the user added last", "No claim about a child without a run", and the scenario "The rules of the agent of a task" of "Agent of a delegated task". Verify that `npm test` passes.
- [x] 3.4 Add a short paragraph to `README.md`, after "Pi children: cheap tasks that only read": the main agent does not ask where a thing is in a listed project; a task goes to the project that holds its means; a look is a pi task that answers a question about a project, and its result comes as a proposal that you confirm; `addedAt` tells the agent which folder you added last.

## 4. The specs and the checks

- [x] 4.1 Check that each `Tests:` line of the delta names the test files of tasks 1.3, 2.3 and 3.3, and that each scenario has its case there. Run `openspec validate --all --strict`.
- [ ] 4.2 Run `npm test`. No change of `build.mjs`, of `package.json`, of the launcher, of `install` or of a dependency, so `npm run test:bundle` and `npm run test:package` are not necessary.
- [ ] 4.3 Manual check of the author, in a temporary `MEGACHAT_HOME`: add a project with a `data/` folder and a `.claude/skills/youtrack/` skill, and ask "draw a chart of the data in the folder that I just added". Verify that the task starts in that project with no question where the data is. Then ask "which project has the YouTrack skill?" with three listed projects, and verify the look rows of the agent Pi and the proposal in the report. Write the result in `docs/manual-checks.md`.

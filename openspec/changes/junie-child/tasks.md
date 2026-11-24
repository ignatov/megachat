# Tasks

## 1. The facts of Junie, before the code

These checks use a script outside the repository that speaks ACP to `central run junie -- --acp=true` in a new
temporary directory. They use the Junie account of the author and write to `~/.junie`, so ask the author before the
first one. Send no `session/delete`. Before and after each check, keep a list of `~/.junie/sessions` and a copy of
`~/.junie/settings.json`, and compare them. Write each result in `docs/manual-checks.md`. When a result differs from a
delta or from a decision of `design.md`, correct the delta and `design.md` before the code, and tell the author.

- [ ] 1.1 Ask for `session/new` and send no prompt. Record whether a folder of the session appears in `~/.junie/sessions`, and whether Air lists such a session. Verify: the record names the two results, and the author decided whether the account check of Junie keeps `session/new` (design.md, decision 6).
- [x] 1.2 Send a short prompt in a new session. In a second process, ask for `session/load` of that session, and record whether its answer holds `configOptions` or a `config_option_update` comes before the next request. Send `session/set_config_option` with the `configId` `model` and the value of an option of the list, then a short prompt. Verify: the record names the model that Junie used for the turn, the error answer for a value that is not in the list, and whether `acpLastSelectedModel` of `~/.junie/settings.json` changed. Set a changed value back.
- [x] 1.3 In a directory that Junie did not see before, send a prompt that runs one harmless command, with `brave_mode` `off` for that session. Verify: the record holds the `session/request_permission` request with the IDs of its options, what Junie does for a directory that it does not trust, what it does with a question to the user for a client without elicitation, and whether `braveMode` of `~/.junie/settings.json` changed. Set a changed value back.
- [x] 1.4 While a prompt runs, send `_session/steering` with a message, as `deliverSteers` of `src/AcpRunService.mjs` does. Verify: the record holds the answer and whether the reply of the turn reads the message.
- [x] 1.5 After a prompt, read the request log of Central (`~/.local/bin/central log`). Verify: the record says that the requests of the Junie turn are in the log. Print no key and no address of the proxy.
- [x] 1.6 On a machine or a macOS user without `central add junie`, run `central run junie -- --acp=true` with a test command `junie` at the start of the `PATH` that writes only the names of its arguments and of the new variables. Verify: the record says whether the route is in the command line. When no such machine is at hand, the record says that nobody checked it.

## 2. The settings and the agent of a run

- [x] 2.1 In `src/Settings.mjs`, add `junie` to `CHILD_AGENTS`, and add the setting `children.junieModel` (default `inherit`, `applies` `nextChild`, `project` true) with a validation as `codexModel` for the prefix `junie/`. Add the texts `setting.children.junieModel` and `settings.junieModel.other` to `resources/Megachat.properties`, and name `junie` in `setting.children.agent`. Verify: `npm test`.
- [x] 2.2 In `admitChild` of `src/MegachatState.mjs`, accept the agent `junie`. In `agents_list` of `src/PiMegachatService.mjs`, give `agents` as `claude`, `codex`, `junie`, `pi`. Verify: `npm test`.
- [x] 2.3 Add the cases to `test/settings.test.mjs` ("Values of the Junie model": the three model IDs and the four refused texts; `children.agent` `junie`), to `test/project-settings.test.mjs` (the list with `children.junieModel`) and to `test/child-settings.test.mjs` ("The value junie" of "Default agent of a child task", "A file without the key"). Verify: `npm test`, and each scenario of these requirements has its case with the same values.

## 3. The launch

- [x] 3.1 In `src/CentralConfigurationService.mjs`, add `junieOnPath` (design.md, decision 2) and the launch of `junie` in `childLaunch`: the Central command with `run`, `junie`, `--`, `--acp=true`, the environment of `codexEnvironment()`, and `MegachatError('junieMissing')` without the command. Move the lookup of `codexOnPath` of `src/MegachatInstall.mjs` to one function for both commands. Add the text `error.junieMissing` with the words of the scenario "A machine without Junie". Verify: `npm test`.
- [x] 3.2 Add the cases to `test/launch.test.mjs`: "The command of a Junie child" (the command and the four arguments) and "The variables of a Junie child" (the five variables and the `PATH` of the scenario). Verify: `npm test`.

## 4. The run

- [x] 4.1 In `src/AcpRunService.mjs`, keep the last config option `model` of the session (the answers of `session/new` and `session/load`, and a `config_option_update` before the prompt). For a Junie run with a model of `children.junieModel`, find the option and send its value (design.md, decision 4), and fail with `MegachatError('childJunieModel', <value>)` without an option or for an error answer. Send a Junie child no `_meta`, no mode and no `AGENTS.md` block. Add the text `error.childJunieModel`. Verify: `npm test`.
- [x] 4.2 In `test/fake-acp.mjs`, add a variable that gives the options of the config option `model` in a group, in the answers of `session/new` and `session/load`. Add the cases to `test/child-settings.test.mjs`: "No model request", "A new task", "A follow-up after a change", "A model ID that starts another model ID", "A model that Junie does not have", "A Codex child" and "A project value" of the Junie model, "The settings of the other agents" and "A project with an AGENTS.md". Verify: `npm test`.
- [x] 4.3 Add the cases to `test/integration.test.mjs`: "A task for Junie", "A machine without Junie" (the error text, no process, no continuation), "A follow-up" and "A stop of a Junie task". Add "Two tasks in one checkout" to `test/parallel.test.mjs`. Verify: `npm test`.

## 5. The names and the contract with Air

- [x] 5.1 Give the name `Junie` in `agentName` of `src/AcpBridge.mjs` and of `src/ChildTranscript.mjs`, and give a session for the agent `junie` in `rowSession` of `src/AcpBridge.mjs`. Add the cases "The row of a Junie child" to `test/transcript.test.mjs` and "A hidden Junie session" to `test/integration.test.mjs`. Verify: `npm test`.
- [x] 5.2 In `docs/air-contract.md`, add `junie` to the values of `agentId` in the table of the requests and in "The session of a child run", and `Junie` to the agents of `description` in "The background tasks". Say that a Junie run has a session of Junie, and that Megachat has no session source of Junie. Verify: the document names `junie` in each place that names `codex` as an `agentId`.

## 6. The account check, install and the README

- [x] 6.1 In `src/AgentAccountCheck.mjs`, check `claude` and `codex`, and `junie` only when `junieOnPath` gives a path. Add the name `Junie` and the texts `accounts.fix.<step>.junie`, and name Junie in `tool.accounts`. Add the three cases of "Account check of Junie" to `test/accounts.test.mjs`. Verify: `npm test`.
- [x] 6.2 In `src/MegachatInstall.mjs`, print the line about Junie after the line about Codex, with the texts `install.junie` and `install.junieMissing`. The line does not change `passed`. Add the cases "Junie on the PATH" and "No Junie" to `test/install.test.mjs`. Verify: `npm test` and `npm run test:package`, because `install` changed.
- [x] 6.3 In `README.md`: name Junie in the first paragraph and in the texts about a child task, add the optional command `junie` to "The machine needs" with the install command of the documentation of Junie CLI, add the line about Junie to the text about the checks of the install line, add `children.junieModel` and the value `junie` of `children.agent` to the text about the settings, and say that the settings of Junie decide its Brave Mode. Add the result of task 1.6 about `central add junie`. Verify: each command of the new text runs as written, or the text says that nobody checked it.

## 7. The rules of the main agent and the texts of the tools

- [x] 7.1 In `resources/instructions.md`, name Junie where the rules name Codex as an agent of a task: `agent=junie` when the user names it, "Send each other task to Claude, Codex or Junie.", the hot sessions, and the account check. In `resources/Megachat.properties`, do the same in `tool.spawn`, `setting.children.parallel`, `setting.children.showInProject`, `settings.spend.note` and `setting.budget.dailyUsd`, and add `instructions.junie`. Add it to the section `settings` in `src/PiMegachatService.mjs`, next to `instructions.codex`. Do not change a text about the index of past sessions, about `agents_sessions`, `agents_resume`, `agents_running` or `agents_archive`. Verify: `npm test`.
- [x] 7.2 Change the case of `test/look-first.test.mjs` to the new sentence and to "agent=junie" in the description of `agents_spawn`, and add the case "The default and a changed value" of "Junie model in the rules of the main agent" to `test/child-settings.test.mjs`. Verify: `npm test`.

## 8. The checks of the whole

- [x] 8.1 A real run with a temporary `MEGACHAT_HOME` and the checkout: start a Junie child with a small task in a test repository, send a follow-up, send a message while it works, and stop a second Junie child while it runs a long command. Repeat the first task with `children.junieModel` set to a model of the list. Verify: `docs/manual-checks.md` holds the result of each step, also that no process of the stopped run stays, and the list of `~/.junie/sessions` shows only the new sessions.
- [ ] 8.2 A manual check of the author in an Air build with a temporary `MEGACHAT_HOME`: a Junie child shows as a row `Junie · <project>`, a click on its title opens the session of Junie, and with `children.showInProject` `false` Air hides that session. Verify: `docs/manual-checks.md` holds the result. When Air does not take the agent ID `junie`, write an IJAI ticket for the Air side, only after the author says "да".
- [x] 8.3 Check that each `Tests:` line of the deltas names the files of the cases, and that each scenario has its case with the same values. Verify: `npm test`, `npm run test:package` and `openspec validate --all --strict` pass. `npm run test:bundle` is not necessary: `build.mjs` and the dependencies do not change.

## Workflow follow-up

- Archive the change `look-first` before this change. The delta of "Agent of a delegated task" builds on its text.
- The change `junie-sessions` adds the source of the sessions of Junie (`~/.junie/sessions`). Apply it after this change.

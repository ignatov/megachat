# Tasks

Rules for each task: never start `src/main.mjs` without a temporary state directory, never run `install` without
`MEGACHAT_ACP_CONFIG` set to a temporary file, print no key or token, push only to a local bare repository in a
temporary directory, and use no recursive delete.

## 1. The live check first

- [ ] 1.1 With a temporary `MEGACHAT_HOME`, a temporary git repository and a local bare remote, start a real Claude
  child through the adapter 0.102.0 with an allow rule `Bash(git push:*)` in the `.claude/settings.local.json` of the
  repository, and with the options of design D1. Ask the child to commit and push. Check each case: `deny` gives a
  refusal and no push; `ask` gives one `session/request_permission` before the push; in the modes `default`,
  `acceptEdits` and `auto`. Record the results in `docs/manual-checks.md`, with no key. If a mode does not ask for an
  ask rule, change the requirement "Limits of the permission rules" with that result, and stop for a decision of the
  author before task 2.1. Verify that the record exists.

## 2. The rules in the options

- [ ] 2.1 Add `CHILD_STEP_RULES` and `claudeStepRules(values)` to `src/Settings.mjs` (design D2). Add a case to
  `test/child-settings.test.mjs` for each combination of `allow`, `ask` and `deny` of the two steps. Verify with
  `npm test`.
- [ ] 2.2 Spread `claudeStepRules(this.settings(run.cwd))` into `_meta.claudeCode.options` of a Claude child in
  `src/AcpRunService.mjs`. Add cases to `test/child-settings.test.mjs` for the scenarios "The defaults", "Two values
  deny" and "A follow-up after a change" of "Permission rules of the steps", and "A project value" and "A Codex child"
  of "Sources of the permission rules". Verify with `npm test`.
- [ ] 2.3 Change the case "a Claude child loads the settings of the user, of the project and the local settings, and
  its options hold no key, no base URL and no turn limit" of `test/child-settings.test.mjs`: `settings` is
  `{"permissions":{"ask":["Bash(git push:*)"]}}` with the defaults, and the options hold no `test-key` and no `wire`.
  Change the comment in `src/AcpRunService.mjs` that says that the options hold no session settings. Verify with
  `npm test`.
- [ ] 2.4 Check the `Tests:` lines of the modified and new requirements of `child-settings` and `claude-child`. Verify
  with `openspec validate --all --strict`.

## 3. Descriptions and documents

- [ ] 3.1 Add the sentence of design D3 to `setting.children.commit` and `setting.children.push` in
  `resources/Megachat.properties`. Add a case to `test/child-settings.test.mjs` for the scenario "The description in
  get". Verify with `npm test`.
- [ ] 3.2 In `README.md`, at the settings `children.commit` and `children.push`, say that a Claude child gets a
  permission rule, that `ask` gives a permission request in the chat, that this is a best effort, and that a Codex
  child gets the prompt text only. Verify by reading it against the requirements.

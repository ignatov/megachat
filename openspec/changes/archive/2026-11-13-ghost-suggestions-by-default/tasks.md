# Tasks

## 1. The default ghost

- [x] 1.1 In `src/Settings.mjs`, set the default of `reply.suggestions` to `ghost`. Update the comment of
  `SUGGESTIONS_VARIABLE` and the comment of the modes in `src/Suggestions.mjs`, which says "`off`, the default".
- [x] 1.2 In `test/suggestions.test.mjs`, change the test "MEGACHAT_SUGGESTIONS selects the mode" so that
  `suggestionsMode({})` gives `ghost`. Change the test "by default the main agent has no suggestion tool and no
  suggestion rule" to a test of the mode `off` that sets the mode, with the scenarios of the requirement "The mode
  off". Add a case for the scenario "No stored value": no option, no variable and no stored value give the tools
  `agents_suggest` and `agents_feedback` and the rule "Do not propose a next step in the reply text."
- [x] 1.3 In `test/settings.test.mjs`, change the expected `reply.suggestions` in the test "the registry gives the
  environment, then the stored setting, then the default" to `ghost`. In the test "the reply style gives lines of the
  rules", seed `reply.suggestions` `off` before the check of "Do not propose a next step unless the user asks for
  one.", or check the rules of the mode `ghost` for the defaults. In the test "the suggestions setting changes the
  tools of the running main agent", start from a stored `off`. In the test "the setting reply.suggestions takes the
  stored values", add a stored `off` (mode `off`), a seed without the value and without the variable (mode `ghost`),
  and a stored `reply` with `MEGACHAT_SUGGESTIONS=0` (mode `off`).
- [x] 1.4 In `test/upgrade.test.mjs`, change the expected `default` of the entry in the test "a settings.json of v0.3.0
  with reply.suggestions true or false" to `ghost`. The modes `reply` and `off` of the stored values stay.
- [x] 1.5 In `test/waiting-results.test.mjs`, the check `isResult` compares the prompt with `event.children`, which is
  the prompt of the mode `off`. Set the mode `off` in its fixture, or compare with the prompt of the mode of the test.
- [x] 1.6 Run `npm test`. Fix each other test that fails because it relies on the default `off`: set the mode `off` in
  that test with the option `suggestions` or a stored value. Do not change a test of the mode `ghost` or `reply`.

## 2. The setup rules of the mode ghost

- [x] 2.1 Add `resources/instructions-onboarding-ghost.md` with the text of `design.md`, decision 2. Do not change
  `resources/instructions-onboarding.md`.
- [x] 2.2 In `src/PiMegachatService.mjs`, read the file into `rules.onboardingGhost`. In `settingsRules`, add it after
  the setup rules only when the onboarding is pending and the mode is `ghost`. In the tool result of the status
  `pending`, add it after `rules.onboarding` under the same condition.
- [x] 2.3 Do not change `build.mjs` or `package.json`: `build.mjs` copies the folder `resources/` as a whole, and the
  `files` of `package.json` name the folder `resources`. So `npm run test:bundle` and `npm run test:package` are not
  necessary.
- [x] 2.4 In `test/suggestions.test.mjs`, add a case for each scenario of the requirement "Setup rules of the mode
  ghost": a first start without `settings.json`, a pending onboarding in the mode `reply`, the status `done` in the
  mode `ghost`, and the tool result of the status `pending` in the mode `ghost`.
- [x] 2.5 In `test/suggestions.test.mjs`, add a case for each scenario of the requirement "Prompt suggestion of a setup
  question": the text of `resources/instructions-onboarding-ghost.md` (with no setting key of `SETTINGS`), a setup turn
  of the fake model that calls `agents_suggest` with "Keep the current values", and the same turn after
  `agents_feedback(decision="silence")`.
- [x] 2.6 Run `npm test`.

## 3. A next step that the user asks for

- [x] 3.1 In `resources/instructions-suggestions-ghost.md`, change "Do not propose a next step in the reply text." to
  "Do not propose a next step in the reply text unless the user asks for one.", and add the line "When the user asks
  for a next step, such as "what next?", answer in the reply text. You can also give a suggestion after that answer."
- [x] 3.2 In `test/suggestions.test.mjs` and `test/settings.test.mjs`, change each check of the old line to the new
  text. Add a case for the scenario "A request for a next step" of the requirement "Next step that the user asks
  for in the mode ghost".
- [x] 3.3 Run `npm test`.

## 4. Specs and documents

- [x] 4.1 Check that the `Tests:` lines of the requirements "Modes of the setting reply.suggestions", "The mode off",
  "Rules of the mode ghost", "Next step that the user asks for in the mode ghost", "Setup rules of the mode ghost",
  "Prompt suggestion of a setup question" and "List of the settings of the reply" name the files of the cases above.
  Run `openspec validate --all --strict`.
- [x] 4.2 In `README.md`, change the default of `reply.suggestions` in the table of the settings from `off` to
  `ghost`. Say that a stored value stays, and that `MEGACHAT_SUGGESTIONS=0` gives `off`. In the section of the setup,
  say that in the mode `ghost` Air shows the likely answer of each setup question as grey text. In the row of
  `reply.suggestions`, say that in the mode `ghost` a next step that the user asks for goes into the reply text. In
  the table of the files, name `resources/instructions-onboarding-ghost.md` next to
  `resources/instructions-onboarding.md`.
- [x] 4.3 Do not change `docs/air-contract.md`: the carrier and its text do not change, and the contract names no
  default. Do not make an IJAI ticket: Air does not change.
- [ ] 4.4 Not run in the apply. Optional, with the consent of the author: a manual check with `MEGACHAT_HOME` set
  to a temporary directory and Air connected. Start the setup, and check that Air shows grey text for the setup
  questions. Record the result in `docs/manual-checks.md`.
- [x] 4.5 Run `npm test` and `openspec validate --all --strict`.

## Workflow follow-up

- `/opsx:archive ghost-suggestions-by-default` after the author accepts the implementation.

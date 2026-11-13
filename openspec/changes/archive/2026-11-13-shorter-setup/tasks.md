# Tasks

## 1. The setup of three questions

- [x] 1.1 Replace the text of `resources/instructions-onboarding.md` with the text of `design.md`, decision 1.
- [x] 1.2 In `resources/instructions-onboarding-ghost.md`, add the line of `design.md`, decision 9, after "The likely
  answer keeps the current values of the question.".
- [x] 1.3 In `test/settings.test.mjs`, change the test "the setup rules name each setting of this build and no other
  setting" so that the named keys are `coordinator.model`, `children.agent`, `children.codexModel` and
  `sessions.index`. Add cases for the scenarios "The pairs of agents", "The values of the pair Opus + Codex" and "The
  closing text" of the requirement "Content of the setup rules", and for the scenario "The end of the setup" of the
  requirement "When the check runs" of `accounts`.
- [x] 1.4 In `test/session-notes.test.mjs`, change the check of the setup order: the setup rules do not name
  `sessions.notes`. In `test/session-index.test.mjs`, keep the check of the question of consent, and run it.
- [x] 1.5 In `test/suggestions.test.mjs`, change the case of the scenario "A setup question" to the pair question and
  the prompt suggestion "Opus + Claude", and the case of "The text of the rules" to the new line.
- [x] 1.6 Run `npm test`.

## 2. The offers

- [x] 2.1 Add `resources/instructions-offers.md` with the text of `design.md`, decision 5.
- [x] 2.2 In `resources/Megachat.properties`, change `instructions.settings` to the text of `design.md`, decision 6.
  Add `instructions.offers.open`, the heading of the open offers. Add the action `offer` to `tool.settings`.
- [x] 2.3 In `src/MegachatState.mjs`, add `initiative.offers ??= {}` to the open of a state. Add a method that records
  an offer through `initiativeDecision` with the gate of `design.md`, decision 7, and that refuses a second allowed
  offer of the same turn.
- [x] 2.4 In `src/PiMegachatService.mjs`, read `resources/instructions-offers.md`, and take the keys from its lines of
  the form `- <key>: <trigger>`. Add the action `offer` to `settingsTool`, before the refusal of a change in an
  automatic turn, and let the turn of the morning report call it. Keep a copy of the recorded keys for
  `settingsRules`, and add the offer rules and the open offers as `design.md`, decision 6, says.
- [x] 2.5 Add `test/setting-offers.test.mjs` with a case for each scenario of the capability `setting-offers`, of the
  scenario "The rules of the setup" of `child-settings`, and of the scenario "The order of the setup" of
  `session-notes`.
- [x] 2.6 In `test/setting-offers.test.mjs`, add the scenario "An offer in a turn of a child result" of the
  requirement "No change from an automatic turn". In `test/settings.test.mjs`, change the scenario "Done stays after a
  restart" to the new text of `instructions.settings`. The test "after done or skipped, the setup rules stay away
  after a restart" already has the scenario "Skipped stays after a restart".
- [x] 2.7 In `test/morning-report.test.mjs`, add the scenario "An offer in the report turn".
- [x] 2.8 Run `npm test`.

## 3. Specs and documents

- [x] 3.1 Check that each `Tests:` line of the deltas names the files of the cases above. Run
  `openspec validate --all --strict`.
- [x] 3.2 In `README.md`, change the section of the setup: the three questions, the account check that shows only the
  problems, and the offers after the setup with their one-time record. The text "In the setup, the main agent looks
  for git repositories" names `projects.newRoot` only for a new project, so it stays. Add
  `resources/instructions-offers.md` to the table of the files.
- [x] 3.3 Do not change `docs/air-contract.md`, and make no IJAI ticket: the change modifies no ACP extension.
- [x] 3.4 Do not run `npm run test:bundle` or `npm run test:package`: `build.mjs` and `package.json` take the folder
  `resources/` as a whole, and the change touches no dependency.
- [ ] 3.5 Not run in the apply. Optional, with the consent of the author: a manual check with `MEGACHAT_HOME` set to a
  temporary directory and Air connected. Run the setup, and check the three questions and the grey text. Record the
  result in `docs/manual-checks.md`.
- [x] 3.6 Run `npm test` and `openspec validate --all --strict`.

## Workflow follow-up

- `/opsx:archive shorter-setup` after the author accepts the implementation.

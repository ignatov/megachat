# Tasks

## 1. Texts

- [x] 1.1 Add question 4 to `resources/instructions-onboarding.md`, and say "four questions" there. Add the likely answer of question 4 to `resources/instructions-onboarding-ghost.md`.
- [x] 1.2 Change `onboarding.offer` in `resources/Megachat.properties` to four questions.
- [x] 1.3 Update `README.md`.

## 2. Tests

- [x] 2.1 Cover "The folder of new projects" and "The settings in the setup rules" in `test/settings.test.mjs`, the grey text in `test/suggestions.test.mjs` and the note in `test/onboarding.test.mjs`.

## 3. Checks

- [x] 3.1 Check the `Tests:` lines. Run `npm test` and `openspec validate --all --strict`.
- [ ] 3.2 Manual check of the author: start a setup in a temporary state directory, answer questions 3 and 4, and see that `agents_settings get` gives the new `projects.newRoot`.

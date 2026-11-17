# Tasks

## 1. Code

- [x] 1.1 Split `event.morning` in `resources/Megachat.properties`, and add `morningPrompt` and the `html` option of `nextMorningReport` in `src/MegachatState.mjs` (decision 2).
- [x] 1.2 Pass `this.html` from `src/PiMegachatService.mjs` (decision 1).

## 2. Tests and documents

- [x] 2.1 Add the cases for the page and the text to `test/morning-report.test.mjs`. Update the `Tests:` line.
- [x] 2.2 Update `README.md` (the setting `chat.html` and the section of the report).

## 3. Checks

- [x] 3.1 Run `npm test` and `openspec validate --all --strict`.
- [ ] 3.2 Live check in Air: record it in `docs/manual-checks.md`.

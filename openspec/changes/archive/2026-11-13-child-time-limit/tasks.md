## 1. Setting

- [x] 1.1 Add `children.timeoutMinutes` with the default 240, the range 0 to 1440 and a project value, and its description in `resources/Megachat.properties`. Cover it in `test/settings.test.mjs` and `test/project-settings.test.mjs`.

## 2. Runs

- [x] 2.1 Make each Claude and Codex run take the value of its directory at its start, with 0 for no limit. Cover it in `test/parallel.test.mjs`.
- [x] 2.2 Make each pi run take the value at its start and keep it in the run. Cover it in `test/pi-child.test.mjs`.

## 3. Documents and checks

- [x] 3.1 Update `README.md` and the setup rules.
- [x] 3.2 Run `npm test` and `openspec validate --all --strict`.

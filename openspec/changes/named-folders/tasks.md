# Tasks

## 1. Code

- [x] 1.1 Change `resolveRepository` in `src/ProjectDirectories.mjs` (decision 1). Update the case in `test/projects.test.mjs`.
- [x] 1.2 Add `folder` to `discoverRepositories` (decision 2) and `cwd` to the action `discover` of `agents_projects`.
- [x] 1.3 Add `MegachatState.addProjects` and `cwds` to the action `add` (decision 3).
- [x] 1.4 Add the case of a named folder, of `cwds`, of the refused paths, of the limit and of `MEGACHAT_PROJECT_ROOTS` to `test/discovery.test.mjs`, and the case of a turn with a named folder to `test/projects.test.mjs`.

## 2. Texts

- [x] 2.1 Update `tool.projects` and `error.directory` in `resources/Megachat.properties`.
- [x] 2.2 Update the setup question 3 in `resources/instructions-onboarding.md` and the rule of a named folder in `resources/instructions.md`. Add the case to `test/settings.test.mjs`.
- [x] 2.3 Update `README.md`.

## 3. Checks

- [x] 3.1 Check the `Tests:` lines. Run `npm test`, `npm run test:bundle` and `openspec validate --all --strict`.

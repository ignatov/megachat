# Tasks

## 1. Code

- [x] 1.1 Add `mainRepositoryOf` to `src/ProjectDirectories.mjs` (decision 1).
- [x] 1.2 Group the worktrees in `discoverRepositories` (decision 2) and skip them in `MegachatState.addProjects` (decision 3).
- [x] 1.3 Add `worktreeOf` and `worktrees` to `directoriesOf` (decision 4).
- [x] 1.4 Add the cases to `test/discovery.test.mjs`.

## 2. Texts

- [x] 2.1 Update `tool.projects`, and add `worktree.skipped`, in `resources/Megachat.properties`.
- [x] 2.2 Update `resources/instructions.md` and `resources/instructions-onboarding.md`. Add the case to `test/settings.test.mjs`.

## 3. Checks

- [x] 3.1 Run `npm test` and `openspec validate --all --strict`.

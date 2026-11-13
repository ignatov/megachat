# Tasks

Rules for each task: never start `src/main.mjs` without a temporary state directory, print no key or token, change no
file of the user, and use no recursive delete.

## 1. Claude child

- [x] 1.1 Add `CLAUDE_SETTING_SOURCES` to `src/AcpRunService.mjs` and give a copy of it in the options of the session
  (D1). Update the case "a Claude child loads the settings of the user, of the project and the local settings" of
  `test/child-settings.test.mjs`.
- [x] 1.2 Replace `refuseProjectBaseUrl()` with `refuseSettingsBaseUrl()` after `childLaunch()` (D2). Rename
  `error.projectBaseUrl` to `error.settingsBaseUrl` and `log.projectSettings` to `log.claudeSettings` in
  `resources/Megachat.properties`, and update `resources/instructions.md`. Add the case "a base URL of the user or of
  the local settings refuses a Claude child only when it is not the Central address of the child" to
  `test/child-settings.test.mjs`, and update the cases of the refusal and of the failed read.
- [x] 1.3 Set `CLAUDE_CONFIG_DIR` to an empty temporary directory in `test/state-guard.mjs` (D5).

## 2. Environment

- [x] 2.1 Change `baseEnvironment()`, `childEnvironment()` and add `codexEnvironment()` in
  `src/CentralConfigurationService.mjs` (D3, D4). Extend the case "the environment of a Claude child has the Central
  configuration and no background tasks" of `test/launch.test.mjs` with the variables of the user, of Megachat, of
  another route, of a Claude Code session and of Codex, for a Claude child, a Codex child and the Codex history.

## 3. Documents and checks

- [x] 3.1 Update `README.md`: the settings sources, the guard and the environment of each child.
- [x] 3.2 Update the `Tests:` lines of the modified requirements of `claude-child` and `launch`.
- [x] 3.3 Run `npm test` and `openspec validate --all --strict`.
- [x] 3.4 Run a real Claude child through `AcpRunService` and `CentralConfigurationService` with a temporary state
  directory and no daemon, and check that it states the first line of `~/.claude/CLAUDE.md`. Record the result in
  `docs/manual-checks.md`.

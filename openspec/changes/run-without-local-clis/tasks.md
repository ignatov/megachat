# Tasks

Rules for each task: never start `src/main.mjs` without a temporary state directory, never run `install` without
`MEGACHAT_ACP_CONFIG` set to a temporary file, print no key or token, run no `central add` and no `central login`, and
use no recursive delete.

## 1. Claude child without Claude Code and without its Central entry

- [x] 1.1 In `CentralConfigurationService.childEnvironment()`, set `CLAUDE_CODE_EXECUTABLE` only when `this.claude` is
  an executable file (D1). Update the case "the environment of a Claude child has the Central configuration and no
  background tasks" of `test/launch.test.mjs` to make an executable `claude` in the temporary directory, and add a
  case without it that expects no `CLAUDE_CODE_EXECUTABLE`. Verify with `npm test`.
- [x] 1.2 Add the fallback to `pi()` when the settings of Claude Code give no valid Central entry, with the log line
  `log.central.claudeFallback` "The settings of Claude Code give no Central entry, so a Claude child uses the Central
  configuration of the main agent:" and only the name and the code of the error (D2). Add the key to
  `resources/Megachat.properties`. Add the cases of the four scenarios of "Central configuration of a Claude child" to
  `test/launch.test.mjs`, with a Central script of the test, and check that `remember()` gets the values of `pi()`.
  Verify with `npm test`.
- [x] 1.3 Check that `test/integration.test.mjs` still covers "A failed Central configuration for a Claude child" of
  `failure-handling`, and that `test/accounts.test.mjs` passes. Verify with `npm test`.
- [x] 1.4 Change `accounts.fix.central.claude` and `accounts.fix.login.claude` in `resources/Megachat.properties` to
  "Run "central login" in a terminal. Then run the check again." (D6). Verify with `npm test`.
- [x] 1.5 Check the `Tests:` line `test/launch.test.mjs` of "Central configuration of a Claude child" of
  `claude-child`, and of the scenarios "Claude Code of the user" and "No Claude Code of the user" of `launch`.

- [x] 1.6 Put the directory of the Central command first on the `PATH` of the key helper, of `central run pi` and of
  each child (D7). Add the case "the key helper of Central and each child find a bare central in the directory of the
  Central command" to `test/launch.test.mjs`, and name it in the `Tests:` lines of "PATH of the key helper of Claude
  Code" of `claude-child` and "PATH of a child agent" of `launch`. Verify with `npm test`.

- [x] 1.7 Give the key helper the time limit `KEY_HELPER_TIMEOUT_MS`, 60 seconds, and tell a missing entry
  (`log.central.claudeFallback`, `install.claudeKeyPi`) apart from a failed key helper (`log.central.claudeHelperFailed`,
  `install.claudeKeyHelper`). `install` writes no log line. Add the case "a key helper that fails or does not end in
  its time limit gives the pi route with a log line of its own" to `test/launch.test.mjs`, and the two texts and an
  empty error output to `test/install.test.mjs`. Verify with `npm test`.

## 2. Codex child and Codex history without the Codex CLI

- [x] 2.1 In `bin/codex`, in the branch with `MEGACHAT_CODEX_ARGS`, search the `PATH` without `bin/` for an executable
  `codex`. Without one, start `process.execPath` with `@openai/codex/bin/codex.js`, resolved with `createRequire`
  bound to `@agentclientprotocol/codex-acp` (D3). Add the cases "Codex of the user" and "No Codex of the user" to
  `test/launch.test.mjs`: start `bin/codex` with `MEGACHAT_CODEX_ARGS` `[]`, the argument `--version` and a temporary
  `CODEX_HOME`, once with a `PATH` that holds a `codex` script that prints `user codex`, and once with `/usr/bin:/bin`.
  Verify with `npm test`.
- [x] 2.2 In `codexAppServerLaunch()`, put `bin/` first on the `PATH` and set `MEGACHAT_CODEX_ARGS` to `[]` (D4). Add
  the case of the scenario "The PATH of the app-server of the Codex history" to `test/launch.test.mjs`. Verify with
  `npm test`.
- [x] 2.3 In `test/package.mjs`, start the Codex child of the packed copy with a `PATH` without `node_modules/.bin` and
  without another `codex`, and expect an answer to `initialize`. Verify with `npm run test:package`.
- [x] 2.4 Add the scenario "The bundle" to `test/bundle.test.mjs`: `out/bundle` holds no file of the agents and of
  their platform binaries. Verify with `npm run test:bundle`, because `bin/codex` goes into the bundle.
- [x] 2.5 Check the `Tests:` lines of "Agent commands", "Agents that npm installed" and "PATH of a child agent" of
  `launch`.
- [x] 2.6 In `bin/codex`, put the arguments of Central before the arguments of the Codex ACP, and leave out `--profile`
  and its value before `app-server` (requirement "Arguments of Central for Codex" of `launch`). Add the two scenarios
  to the case of `bin/codex` in `test/launch.test.mjs`. Verify with `npm test`.

## 3. install

- [x] 3.1 Add a resolver of the two platform binaries to `CentralConfigurationService`: the `claude` binary from the
  SDK of `claude-agent-acp` with the candidates of `claude-cli.js`, and `@openai/codex/bin/codex.js` from `codex-acp`
  (D5). Let `install` take the resolver as a parameter.
- [x] 3.2 Change `checks()` and the exit code to the table and the rule of D5. Change `install.claude`,
  `install.claudeMissing`, `install.claudeCentral`, `install.codex` and `install.codexMissing`, and add
  `install.claudeBundled`, `install.claudeKey`, `install.claudeKeyPi` and `install.codexBundled` in
  `resources/Megachat.properties`.
- [x] 3.3 Update `test/install.test.mjs` for the scenarios of "Checks of install" and "Last lines and exit code of
  install": each check passes; missing tools; no binary of an agent; a failed check; only Central and the binaries of
  npm (the exit code 0 on macOS); no child agent is ready. Verify with `npm test`.
- [x] 3.4 Check the `Tests:` lines `test/install.test.mjs` of the two requirements. Verify with `npm run test:package`,
  because the change touches `install`.

## 4. Documents

- [x] 4.1 In `README.md`, "The machine needs": keep Central and its login, mark Claude Code at `~/.local/bin/claude`,
  `central add claude-code` and `codex` on the `PATH` as optional, say which binary and which key a child uses without
  them, say that `central add codex` is not necessary, and remove the sentence that the Codex history
  needs the local Codex CLI. Update the sentence about the exit code of the install line.
- [x] 4.2 Add the results of the check of 2026-11-13 (facts 4, 5 and 6 of design.md) to `docs/manual-checks.md`.

## 5. Integration

- [x] 5.1 Run `npm test`, `npm run test:bundle`, `npm run test:package` and `openspec validate --all --strict`.
- [x] 5.2 Live check: start a Codex child through Central with the bundled `codex`, no other `codex` on the `PATH`, a
  temporary `MEGACHAT_HOME` and a temporary `CODEX_HOME`, and a small prompt. Record the result without a secret in
  `docs/manual-checks.md`.

## Workflow follow-up

- Archive the change with `/opsx:archive` after the review, and run `openspec validate --all --strict`.

# Proposal

## Why

Megachat ships the Claude and Codex agents with their platform binaries: `@agentclientprotocol/claude-agent-acp`
with the `claude` binary of `@anthropic-ai/claude-agent-sdk-<platform>`, and `@agentclientprotocol/codex-acp` with the
`codex` binary of `@openai/codex-<platform>`. All the same, Megachat uses only the Claude Code and the Codex CLI of the
user. A check on 2026-11-13 with an empty home directory showed these results:

- A Claude child fails with "Central did not supply a valid local provider configuration.", because Megachat reads
  its key only from `~/.claude/settings.json`, which `central add claude-code` writes. Megachat also points Claude Code
  to `~/.local/bin/claude`, also when that file does not exist.
- A Codex child exits with the code 1, because `bin/codex` starts `codex` from the `PATH` and finds none.
- The Codex history fails for the same reason.
- `install` exits with the code 1 without Claude Code at `~/.local/bin/claude` and without `codex` on the `PATH`.

The same check showed that the binaries that npm installed work through Central: the bundled `claude` answered a
prompt with the configuration of `central run pi`, and the bundled `codex` answered a prompt and a `thread/list` request behind
`central run codex`.

## What Changes

Where it shows: the result of a child task in the chat and in the task list of Air, the lines of the command
`install`, the result of the tool `agents_accounts`, the log of the daemon, the Codex history, and `README.md`.

- **A Claude child starts without Claude Code of the user.** When `~/.local/bin/claude` is an executable file, a
  Claude child uses it, as now. Without that file, the Claude agent uses the `claude` binary that npm installed with it.
- **A Claude child gets a key without `central add claude-code`.** When `~/.claude/settings.json` gives a valid Central
  entry, a Claude child uses it, as now. Else it uses the Central configuration of the main agent, from
  `central run pi`, and the log of the daemon gets one line. Only when both fail does the run fail with the present
  text.
- **A Codex child starts without the Codex CLI of the user.** When the `PATH` has a `codex` command, a Codex child uses
  it, as now. Else `bin/codex` starts the `codex` that npm installed with the Codex agent. Central needs no Codex of
  its own: `central run codex` starts the `codex` of the `PATH`, which is `bin/codex` of Megachat, and it passes the
  route of Central itself. So `central add codex` is not necessary.
- **The Codex history works without the Codex CLI of the user.** The app-server of the history uses the same `codex`
  as a Codex child.
- **A bare `central` works in the key helper and in each child.** The key helper of `central add claude-code`,
  `central run pi` and each child get the directory of the Central command on the `PATH`, by default `~/.local/bin`.
- **`install` needs Central, its login, and one ready child agent.** The checks of the platform and of Central stay.
  The lines about Claude Code and Codex tell which binary and which key a child uses. With only the route of pi, the
  key line names `central add claude-code` as a hint. The exit code is 0 when the platform and Central pass and a child
  agent is ready: Claude with a binary and a key, or Codex with a binary.
- **The fixes of `agents_accounts` for Claude no longer ask for `central add claude-code`.** They ask for
  `central login`.
- **`README.md`** lists Claude Code, `central add claude-code` and Codex of the user as optional, and it removes the
  sentence that the Codex history needs the local Codex CLI.
- The default of `children.agent` stays `claude`.

## Note on `central add claude-code`

`central add claude-code` works without a Claude Code CLI (see design.md, D2). Its key helper calls `central` by its
bare name, so Megachat puts the directory of the Central command on the `PATH` of the helper and of each child
(design.md, D7). The installer of Central does not put `~/.local/bin` on the `PATH`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `launch`: the requirements "Agent commands", "Agents that npm installed" and "PATH of a child agent" change. A
  child uses the binary of the user when it is there, else the binary that npm installed with its agent. The
  app-server of the Codex history gets the same `PATH` as a Codex child.
- `install`: the requirements "Checks of install" and "Last lines and exit code of install" change. Claude Code and
  Codex of the user become information. The exit code needs one ready child agent.
- `claude-child`: the new requirements "Central configuration of a Claude child" and "PATH of the key helper of Claude
  Code" state the source of the key and the base URL, and the `PATH` of the helper. No present requirement states
  them.

## Impact

- `src/CentralConfigurationService.mjs`: `childEnvironment()` with the fallback to `pi()`, `codexAppServerLaunch()`,
  and a resolver of the two platform binaries. The in-flight change `name-central-failure` also changes this file, but no requirement of both
  changes is the same.
- `bin/codex`: the fallback to the `codex` that npm installed.
- `src/MegachatInstall.mjs`: `checks()` and the exit code.
- `resources/Megachat.properties`: the lines of `install` for Claude Code and Codex, a log line for the fallback of the
  key, and two fixes of `agents_accounts`.
- `README.md`: the list "The machine needs" and the text about the exit code of the install line.
- `docs/manual-checks.md`: the live check of a Codex child with the bundled `codex`.
- `test/launch.test.mjs`, `test/install.test.mjs`, `test/package.mjs`, `test/bundle.test.mjs`.
- The change does not modify an ACP extension. Air does not change. `docs/air-contract.md` does not change.
- `package.json` does not change: the agents already depend on their platform binaries.

## Out of scope

- A setting that selects the binary of the user or the binary of npm. The order is fixed.
- The Air bundle of `build.mjs`. It still holds no agent and no platform binary, and the IDE passes its agents in
  `MEGACHAT_CLAUDE_ACP` and `MEGACHAT_CODEX_ACP`. A Codex child of the bundle without `codex` on the `PATH` still
  fails (see design.md, Open Questions).
- A run of `central add` or `central login` by Megachat. The change keeps the non-goal "Megachat does not install a
  login service": the user runs `central login`.
- A pi child. It already uses the configuration of `central run pi`.
- A platform other than macOS. npm installs the binary of each platform, but nobody tested it there.

# Proposal

## Why

The user wants a child to work as the same agent works when the user starts it from a terminal or from the IDE in that
directory. At 2b01f2d this is not so:

- A Claude child starts with `settingSources: ["project"]`. So it does not load `~/.claude/CLAUDE.md`,
  `~/.claude/settings.json` (the hooks, the permissions, the `env`, `enabledPlugins`), the skills, the agents and the
  plugins of the user, the MCP servers of `~/.claude.json`, and `.claude/settings.local.json` of the project.
- A Claude child and a Codex child get only ten variables of the environment of the daemon. A proxy, a CA file, a tool
  variable and each other variable of the user do not reach the child. The two children get the same list, so a Codex
  child is not apart from Claude Code.

## What Changes

Where it shows: the work and the result of a child task in the chat and in the task list of Air, the failure of a
refused Claude child, the log of the daemon, and `README.md`.

- **A Claude child loads each settings source.** The options of the session give
  `settingSources: ["user", "project", "local"]`, the default of Claude Code in a terminal.
- **The guard of the base URL covers each settings file.** Megachat refuses a Claude child when the `env` of a settings
  file of the user, of the project or of the local settings sets `ANTHROPIC_BASE_URL` to another value than the Central
  address of the child. The Central entry of `central add claude-code` in `~/.claude/settings.json` has the same
  address, so it passes. Before, any project value refused the child, and the user files were not read.
- **Each child gets the environment of the daemon.** No child gets a `MEGACHAT_*` variable. A Claude child gets no
  variable that sends Claude Code past Central and no mark of a Claude Code session that started the daemon. A Codex
  child and the Codex history get no variable of Claude Code. Codex reads only its own configuration in `~/.codex`
  or in `CODEX_HOME`, as before.
- **A Claude child no longer gets `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`.** Claude Code in a terminal does not set
  it. `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` stay.
- The setting `children.permissionMode`, `children.claudeModel` and the removal of `bypassPermissions` stay.
- The message `error.projectBaseUrl` becomes `error.settingsBaseUrl`, and the log line `log.projectSettings` becomes
  `log.claudeSettings`.

## Capabilities

- Modified: `claude-child` (the setting sources, the guard, the environment), `launch` (the environment of a Codex
  child).

## ACP extension

No ACP extension changes. Air needs no change.

## Out of scope

- A pi child. It stays read-only and does not apply the skills or the settings of Claude Code (a non-goal).
- The check of `agents_accounts`. It has no project, so it keeps `settingSources: []`.
- A guard against a hostile settings file. A hook can read the key, as before.
- `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` in the `env` of a settings file. Such a key is a choice of the user
  and does not send the key of Megachat anywhere.

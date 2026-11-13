# Design

## Context

- `AcpRunService` gives `_meta.claudeCode.options.settingSources: ["project"]` in `session/new` and `session/load`.
  `refuseProjectBaseUrl()` reads only the project source with `resolveSettings` of the SDK before `childLaunch()`.
- `CentralConfigurationService.baseEnvironment()` copies ten variables. `childEnvironment()` adds the key, the base URL,
  `CLAUDE_CODE_EXECUTABLE`, `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` and
  `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`.
- `src/main.mjs` starts the daemon with `MEGACHAT_HOME` of the state directory. So the daemon always has it.
- `~/.claude/settings.json` of this machine has the Central entry: `apiKeyHelper` and `env.ANTHROPIC_BASE_URL`.
  `childEnvironment()` takes its base URL from the same file.
- On this machine, `central run codex` passes no argument, because `~/.codex/config.toml` sets the provider of Central.
  With an empty `CODEX_HOME`, it passes `--profile jetbrains-central` and `-c` overrides (see `run-without-local-clis`).

## Decisions

D1. `CLAUDE_SETTING_SOURCES = ["user", "project", "local"]` in `src/AcpRunService.mjs` is the one place of the
sources. The options get a copy of it. The policy settings of a machine load in each case, as before.

D2. `refuseSettingsBaseUrl(cwd, baseUrl, resolveSettings)` runs after `childLaunch()` and before the spawn, because it
compares with `ANTHROPIC_BASE_URL` of the environment of the launch. It reads `CLAUDE_SETTING_SOURCES` and examines each
returned source, the policy source too. A value equal to the address of the child passes. The message names the path
of the source. A failed read goes to the log as before, with the new key `log.claudeSettings`.

D3. `baseEnvironment(dropped)` copies each variable of the daemon except `MEGACHAT_*` and the variables that `dropped`
names. `childEnvironment()` drops `CLAUDE_DROPPED_VARIABLES`: `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`,
`ANTHROPIC_BASE_URL` (Central replaces them, and an auth token wins over the key), `CLAUDE_CODE_OAUTH_TOKEN`,
`CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_FOUNDRY` (another route), `CLAUDECODE`,
`CLAUDE_CODE_ENTRYPOINT` and `CLAUDE_CODE_SSE_PORT` (the marks of a Claude Code session that started the daemon).
`codexEnvironment()` drops each `ANTHROPIC_*`, `CLAUDE_*` and `CLAUDECODE` variable. `childLaunch('codex')` and
`codexAppServerLaunch()` use it, and they add `MEGACHAT_CODEX_ACP` and `MEGACHAT_CODEX_ARGS` as before.

D4. `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` goes: no requirement and no test needs it, and a terminal does not set
it. `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false` stays, because a suggestion of a child costs a request and nobody reads
it. `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` stays, because the capability `child-scheduling` requires it: a run ends
with its prompt.

D5. `test/state-guard.mjs` sets `CLAUDE_CONFIG_DIR` to an empty temporary directory, so no test reads
`~/.claude/settings.json` of the user through the guard.

## Daemon state

The change adds no field to `conversation.sqlite` or to `settings.json`, and it reads none. A run that was admitted
before an update gets the new sources and the new environment at its next launch. A restart of the daemon is necessary
to take the change.

## ACP messages

No new message and no new `_meta` key. `_meta.claudeCode.options.settingSources` of `session/new` and `session/load`
gets a new value.

## Risks

- A hook, a plugin or an MCP server of the user now runs in each Claude child, as in a terminal. A slow MCP server of
  the user makes the start of a child slower.
- A user setting `env.ANTHROPIC_BASE_URL` that is not the Central address refuses each Claude child. The failure names
  the file, and Codex stays available.

## MODIFIED Requirements

### Requirement: Setting sources of a Claude child
A Claude child MUST start with `settingSources: ["user", "project", "local"]`, as Claude Code starts in a terminal. So it loads `~/.claude/CLAUDE.md`, `~/.claude/settings.json`, the plugins, skills and agents of the user, the MCP servers of `~/.claude.json`, `CLAUDE.md` of the project with its imports, `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json`. A hook then runs with the environment of the child, the key of Megachat included.

Tests: `test/child-settings.test.mjs`

#### Scenario: The setting sources
- **WHEN** a Claude child starts
- **THEN** the options of the child hold `settingSources: ["user", "project", "local"]`

## REMOVED Requirements

### Requirement: Files that a Claude child does not load
**Reason**: The user wants a Claude child to work as Claude Code in a terminal, with the files of the user and the local settings.
**Migration**: None. The requirement "Setting sources of a Claude child" gives the new sources. `children.permissionMode` and `children.claudeModel` still control the mode and the model (see the capability `child-settings`).

### Requirement: Guard for a project base URL
**Reason**: The guard now covers each settings file, and a value equal to the Central address passes.
**Migration**: None. See the requirement "Guard for a base URL of the settings".

### Requirement: Result of the guard for a project base URL
**Reason**: The message covers each settings file.
**Migration**: The message key `error.projectBaseUrl` becomes `error.settingsBaseUrl`. See the requirement "Result of the guard for a base URL of the settings".

### Requirement: Failed read of the project settings
**Reason**: The guard reads each settings source.
**Migration**: The log key `log.projectSettings` becomes `log.claudeSettings`. See the requirement "Failed read of the settings of a Claude child".

## ADDED Requirements

### Requirement: Guard for a base URL of the settings
Claude Code applies the `env` of each settings file after the environment of the child. So after the launch is ready and before the agent starts, Megachat MUST read the settings with `resolveSettings` of the SDK and the sources of the child. When an `env` sets `ANTHROPIC_BASE_URL` to another value than the base URL of the child, Megachat MUST refuse the run. An equal value, as the Central entry of `central add claude-code` gives, MUST pass.

Tests: `test/child-settings.test.mjs`

#### Scenario: A project base URL
- **WHEN** `.claude/settings.json` of the directory of the run has `env` with `ANTHROPIC_BASE_URL` `http://127.0.0.1:9/wire/project`
- **THEN** the run ends as `interrupted`, and the agent process does not start

#### Scenario: The Central entry of the user
- **WHEN** the settings of the user have `ANTHROPIC_BASE_URL` `http://127.0.0.1:9/wire/central`, and the child gets the same base URL
- **THEN** the run completes

#### Scenario: Another address of the user or of the local settings
- **WHEN** the settings of the user, or `.claude/settings.local.json` of the directory of the run, have `ANTHROPIC_BASE_URL` `https://gateway.test`
- **THEN** the run ends as `interrupted`, and its error names that file

### Requirement: Result of the guard for a base URL of the settings
The failure of the run MUST name the file and the variable, and never the value. A key or another variable in the `env` of a settings file MUST NOT refuse a run: it does not move the key of Megachat. A settings file that is not valid MUST NOT refuse a run, because Claude Code ignores it.

Tests: `test/child-settings.test.mjs`

#### Scenario: The message of a refused run
- **WHEN** the guard refuses a run because `.claude/settings.json` sets `ANTHROPIC_BASE_URL` to `http://127.0.0.1:9/wire/project`
- **THEN** the error of the run names the file and `ANTHROPIC_BASE_URL`, and it does not hold `127.0.0.1`

#### Scenario: A project key
- **WHEN** the `env` of the project settings has only `ANTHROPIC_API_KEY` `project-key` and `DEBUG` `1`
- **THEN** the run starts and completes

#### Scenario: A settings file that is not valid
- **WHEN** the project settings set `ANTHROPIC_BASE_URL` in a file that is not valid JSON
- **THEN** the run starts and completes

### Requirement: Failed read of the settings of a Claude child
When the read of the settings fails, the run MUST go on, and the log of the daemon MUST say that the guard did not run, with no content of the settings. This is a guard against an accident, not against a hostile project, because a hook can read the key.

Tests: `test/child-settings.test.mjs`

#### Scenario: A read that fails
- **WHEN** the read of the settings fails with a `SyntaxError` whose message holds `ANTHROPIC_BASE_URL` and `http://secret`
- **THEN** the run completes, the log of the daemon has one line that says that the guard did not run with `name=SyntaxError`, and the log does not hold `secret`

### Requirement: Environment of a Claude child
A Claude child MUST get the environment of the daemon without each `MEGACHAT_*` variable and without `CLAUDE_DROPPED_VARIABLES` of `src/CentralConfigurationService.mjs`: the key, the auth token and the base URL of the user, the other routes of Claude Code, and the marks of a Claude Code session. It MUST get the key and the base URL of Central, `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION` `false` and `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` `1`.

Tests: `test/launch.test.mjs`

#### Scenario: The variables of the user
- **WHEN** the daemon has `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `ANTHROPIC_MODEL`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `MEGACHAT_HOME`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_USE_BEDROCK` and `CLAUDECODE`
- **THEN** the Claude child gets the first five with their values, none of the last four, and no `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`

# claude-child Specification

## Purpose
A Claude child works as Claude Code works in the directory of its run. Megachat keeps its key out of the command line and out of the reach of a project base URL, and it gives a Claude child the rules of `AGENTS.md`.

## Requirements

### Requirement: Claude Code in the directory of the run
A Claude child MUST work as Claude Code works in the directory of its run.

Tests: `test/child-settings.test.mjs`

#### Scenario: A run in a project directory
- **WHEN** the main agent starts the task "first task" for a Claude child in a project directory with a `.claude/settings.json`
- **THEN** the Claude child starts in that directory with the project settings, and the run completes

### Requirement: Setting sources of a Claude child
A Claude child MUST start with `settingSources: ["project"]`, so it loads `CLAUDE.md` with its `@` imports, `.claude/settings.json` of the directory of the run with its permissions, hooks and `env`, the MCP servers of `.mcp.json`, and the skills of `.claude/skills`. A project hook and a project MCP server then run without a question, and a project hook runs with the environment of the child, the key of Megachat included.

Tests: `test/child-settings.test.mjs`

#### Scenario: The setting sources
- **WHEN** a Claude child starts
- **THEN** the options of the child hold `settingSources: ["project"]`

### Requirement: Files that a Claude child does not load
A Claude child MUST NOT load `.claude/settings.local.json`, a `.claude/settings.json` of a parent directory, and no file of the user: not `~/.claude/CLAUDE.md`, not `~/.claude/settings.json`, and not the skills, the plugins and the MCP servers of the user. The adapter of Claude Code reads the permission mode and the model from each settings file all the same. The settings `children.permissionMode` and `children.claudeModel` control them.

Tests: `test/child-settings.test.mjs`

#### Scenario: No setting source of the user
- **WHEN** a Claude child starts
- **THEN** the setting sources in the options of the child hold only `project`

### Requirement: Key and base URL only in the environment
The options of a Claude child MUST hold no session settings. The SDK puts them in the command line of the Claude process, which each local user can read, and the base URL of Central holds the key. The key and the base URL MUST go only in the environment of the agent.

Tests: `test/child-settings.test.mjs`

#### Scenario: The options of a child
- **WHEN** the environment of a Claude child has `ANTHROPIC_BASE_URL` `http://127.0.0.1:9/wire/test-key` and `ANTHROPIC_API_KEY` `test-key`
- **THEN** the options of the child hold no `settings`, no `test-key` and no `wire`

### Requirement: Guard for a project base URL
Claude Code applies the `env` of the project settings after the environment of the child. So before the launch of a Claude child, Megachat MUST read the project settings as Claude Code reads them, with `resolveSettings` of the SDK. When their `env` sets `ANTHROPIC_BASE_URL`, Megachat MUST refuse the run before it starts the agent, because the child would send its requests and the key of Megachat to that address.

Tests: `test/child-settings.test.mjs`

#### Scenario: A project base URL
- **WHEN** `.claude/settings.json` of the directory of the run has `env` with `ANTHROPIC_BASE_URL` `http://127.0.0.1:9/wire/project`
- **THEN** the run ends as `interrupted`, and Megachat does not start the agent

### Requirement: Result of the guard for a project base URL
The failure of the run MUST name the file and the variable, and never the value. A project key or another variable MUST NOT refuse a run: it does not move the key of Megachat. A settings file that is not valid MUST NOT refuse a run, because Claude Code ignores it.

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

### Requirement: Failed read of the project settings
When the read of the settings fails, the run MUST go on, and the log of the daemon MUST say that the guard did not run, with no content of the settings. This is a guard against an accident, not against a hostile project, because a project hook can read the key.

Tests: `test/child-settings.test.mjs`

#### Scenario: A read that fails
- **WHEN** the read of the project settings fails with a `SyntaxError` whose message holds `ANTHROPIC_BASE_URL` and `http://secret`
- **THEN** the run completes, the log of the daemon has one line that says that the guard did not run with `name=SyntaxError`, and the log does not hold `secret`

### Requirement: AGENTS.md in the prompt of a Claude child
Claude Code does not read `AGENTS.md`. When the directory of the run has an `AGENTS.md` and neither `CLAUDE.md` nor `.claude/CLAUDE.md`, the prompt of each dispatch of a Claude child MUST hold the content of `AGENTS.md` after the rules of the user, marked as the rules of the repository, with the read and the limit of the rules of a pi child. With a `CLAUDE.md`, the prompt MUST hold no such block, because Claude Code loads the file with its imports.

Tests: `test/child-settings.test.mjs`

#### Scenario: Only AGENTS.md
- **WHEN** the directory of the run has only an `AGENTS.md` with "Run npm test after each change."
- **THEN** the prompt of the Claude child holds the rules of the user, then this text in a block of the rules of the repository, then the task

#### Scenario: A CLAUDE.md
- **WHEN** the directory of the run has an `AGENTS.md`, and a `CLAUDE.md` or a `.claude/CLAUDE.md` with an `@` import of `AGENTS.md`
- **THEN** the prompt of the Claude child holds the rules of the user and the task, and no block of the rules of the repository

#### Scenario: A long AGENTS.md
- **WHEN** the `AGENTS.md` is longer than the limit of the rules of a pi child
- **THEN** the block holds the start of the file and a note of the limit

### Requirement: No AGENTS.md block for a Codex child
A Codex child MUST get no block with the content of `AGENTS.md`, because Codex reads `AGENTS.md` by itself.

Tests: `test/child-settings.test.mjs`

#### Scenario: A Codex child
- **WHEN** the directory of the run has an `AGENTS.md` and the task goes to `codex`
- **THEN** the prompt of the Codex child holds the rules of the user and the task, and no block of the rules of the repository

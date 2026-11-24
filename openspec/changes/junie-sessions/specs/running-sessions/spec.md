# Spec Delta

## MODIFIED Requirements

### Requirement: List of the running sessions
The tool `agents_running` of the main agent MUST list the agent sessions that run on the machine now: Claude Code, Codex, Junie, pi and OpenCode, also below the ACP adapters `claude-agent-acp` and `codex-acp`. It MUST read the process table, and the session logs only with the consent `sessions.index`. It MUST change nothing.

Tests: `test/running.test.mjs`

#### Scenario: A session of each agent
- **WHEN** Claude Code runs in Terminal, Codex runs below `codex-acp` of an IDE, pi runs in a `tmux` and OpenCode runs in Ghostty
- **THEN** `agents_running` gives a row for each session, with the `agent` `claude`, `codex`, `pi` and `opencode`

#### Scenario: A session of Junie
- **WHEN** Junie runs in Terminal in the directory `/work/demo-app`, with the executable `junie` of the app bundle `junie.app`
- **THEN** `agents_running` gives one row with the `agent` `junie`, the `cwd` `/work/demo-app` and the `parent.kind` `terminal`

#### Scenario: The tool of the main agent
- **WHEN** the main agent calls `agents_running` with the `agent` `pi`, and pi runs in a `tmux` in the directory `/work/pi`
- **THEN** the result has one row, with the `cwd` `/work/pi` and the `parent.kind` `multiplexer`

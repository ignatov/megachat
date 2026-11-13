## ADDED Requirements

### Requirement: Environment of a Codex child
A Codex child and the app-server of the Codex history MUST get the environment of the daemon without each `MEGACHAT_*` variable and without each `ANTHROPIC_*`, `CLAUDE_*` and `CLAUDECODE` variable. Codex then reads only its own configuration: `config.toml`, the profiles, the MCP servers and `AGENTS.md` of `~/.codex` or of `CODEX_HOME`, and the `AGENTS.md` files of the project. Central gives the route.

Tests: `test/launch.test.mjs`

#### Scenario: The variables of a Codex child
- **WHEN** the daemon has `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, `CODEX_HOME`, `OPENAI_API_KEY`, `MEGACHAT_HOME`, `ANTHROPIC_API_KEY` and `CLAUDE_CONFIG_DIR`
- **THEN** the Codex child and the Codex history get the first four with their values, and no `ANTHROPIC_*`, `CLAUDE_*` or `MEGACHAT_*` variable other than `MEGACHAT_CODEX_ARGS`

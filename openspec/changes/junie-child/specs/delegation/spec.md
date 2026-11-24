# Spec Delta

## MODIFIED Requirements

### Requirement: Agent of a delegated task
The user MAY delegate a task to Claude Code, Codex or Junie, and a task that only reads files to a pi child. The main agent MAY start a pi child for a look without a request that names pi. For each other task, the rules MUST allow pi only when the user names it. Claude Code MUST remain the default for delegated tasks unless the setting `children.agent` selects Codex or Junie.

Tests: `test/integration.test.mjs`, `test/look-first.test.mjs`

#### Scenario: A task for Codex
- **WHEN** the main agent calls `agents_spawn` with the agent `codex`
- **THEN** the daemon launches a Codex child, and the run has the agent `codex`

#### Scenario: A task for Junie
- **WHEN** the main agent calls `agents_spawn` with the agent `junie`
- **THEN** the daemon launches a Junie child, and the run has the agent `junie`

#### Scenario: A task without a named agent
- **WHEN** the main agent calls `agents_spawn` without an agent
- **THEN** the child is a Claude Code child, and the description of its row in the chat starts with `Claude · ` and the name of the project

#### Scenario: The rules of the agent of a task
- **WHEN** a test reads `resources/instructions.md` and the description of `agents_spawn`
- **THEN** the rules hold "Use agent=pi for a look, or when the user names pi." and "Send each other task to Claude, Codex or Junie.", and the description of `agents_spawn` holds "Use agent=pi for a look" and "agent=junie"

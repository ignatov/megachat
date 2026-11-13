# Spec Delta

## MODIFIED Requirements

### Requirement: Key and base URL only in the environment
The options of a Claude child MUST hold no session settings other than `permissions.ask` with the permission rules of the steps (see the capability `child-settings`). The SDK puts them in the command line of the Claude process, which each local user can read, and the base URL of Central holds the key. The key and the base URL MUST go only in the environment of the agent.

Tests: `test/child-settings.test.mjs`

#### Scenario: The options of a child
- **WHEN** the environment of a Claude child has `ANTHROPIC_BASE_URL` `http://127.0.0.1:9/wire/test-key` and `ANTHROPIC_API_KEY` `test-key`, and the settings of the steps are the defaults
- **THEN** the options of the child hold `settings` `{"permissions":{"ask":["Bash(git push:*)"]}}` and nothing else in `settings`, no `test-key` and no `wire`

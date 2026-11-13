## ADDED Requirements

### Requirement: Central configuration of a Claude child
A Claude child MUST get its key and base URL from `apiKeyHelper` and `env.ANTHROPIC_BASE_URL` of `~/.claude/settings.json`, which `central add claude-code` writes, when they give a valid Central configuration. Else it MUST get the configuration of the main agent from `central run pi`, and the log MUST get one line that names the fallback. When both fail, the launch MUST fail as a failed Central configuration (see the capability `failure-handling`).

Tests: `test/launch.test.mjs`

#### Scenario: The Central entry of the settings of Claude Code
- **WHEN** the settings file of the test holds `apiKeyHelper` `echo test-key` and `env.ANTHROPIC_BASE_URL` `http://127.0.0.1:9/wire/test`
- **THEN** the environment of a Claude child has `ANTHROPIC_API_KEY` `test-key` and `ANTHROPIC_BASE_URL` `http://127.0.0.1:9/wire/test`, and the Central command does not run

#### Scenario: No settings of Claude Code
- **WHEN** the settings file of the test does not exist, and the Central command of the test prints the configuration with the key `pi-key` and the base URL `http://127.0.0.1:9/wire/pi/`
- **THEN** the environment of a Claude child has `ANTHROPIC_API_KEY` `pi-key` and `ANTHROPIC_BASE_URL` `http://127.0.0.1:9/wire/pi/`, and the log has one line that starts with "The settings of Claude Code give no Central entry"

#### Scenario: A base URL of the settings that is not the local proxy
- **WHEN** the settings file of the test gives the base URL `https://example.com/wire/test`, and the Central command of the test prints the configuration with the key `pi-key`
- **THEN** the environment of a Claude child has `ANTHROPIC_API_KEY` `pi-key`

#### Scenario: No configuration at all
- **WHEN** the settings file of the test does not exist, and the Central command of the test exits with the code 7
- **THEN** the launch of a Claude child fails with the code `central`, and no log line holds the output of the command

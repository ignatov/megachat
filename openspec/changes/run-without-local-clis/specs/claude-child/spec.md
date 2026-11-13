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

### Requirement: Time limit and failure of the key helper of Claude Code
Megachat MUST give the key helper of the Central entry of Claude Code a time limit of 60 seconds. When the settings give no valid Central entry, the log line of the fallback MUST start with "The settings of Claude Code give no Central entry". When the entry is there, but its key helper fails, does not end in the time limit or gives no key, the log line MUST start with "The key helper of the Central entry of Claude Code failed".

Tests: `test/launch.test.mjs`

#### Scenario: A key helper that does not end in the time limit
- **WHEN** the settings file of the test holds the key helper `exec sleep 5` with a valid base URL, and the time limit of the test is 0.2 seconds
- **THEN** a Claude child gets the key `pi-key` of `central run pi` in less than 4 seconds, and the log has one line that starts with "The key helper of the Central entry of Claude Code failed or did not end in 0.2 seconds" and has `signal=SIGTERM`

#### Scenario: A key helper that fails
- **WHEN** the key helper of the settings file of the test is `exit 3`, or `true`, which gives no key
- **THEN** a Claude child gets the key of `central run pi`, and the log line names the key helper, not a missing entry

#### Scenario: An entry without a base URL
- **WHEN** the settings file of the test holds the key helper `echo test-key` and no `env.ANTHROPIC_BASE_URL`
- **THEN** a Claude child gets the key of `central run pi`, and the reason of the fallback is a missing entry

### Requirement: PATH of the key helper of Claude Code
Megachat MUST run the key helper of the settings of Claude Code, and `central run pi`, with the directory of the Central command first on the `PATH`. The key helper that `central add claude-code` writes is `central proxy start --ensure-updated --caller agent --return-key`. It calls `central` by its bare name, and the installer of Central does not put `~/.local/bin` on the `PATH`.

Tests: `test/launch.test.mjs`

#### Scenario: A key helper that calls a bare central
- **WHEN** the settings of the test hold the key helper `central proxy start --ensure-updated --caller agent --return-key`, and a `central` that prints a key is only in the directory of the Central command, which is not on the `PATH` of the test
- **THEN** the environment of a Claude child has that key, and its source is the Central entry of the settings

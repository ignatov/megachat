# Spec Delta

## ADDED Requirements

### Requirement: Registry agent at install
`install` MUST read `acp-agents/installed.json` of the common data directory of the IDE. When it has `acp.registry.megachat-acp`, `install` MUST NOT write the `acp.json` entry, and it MUST remove the entry of an `install` (see the capability `uninstall`) with a copy to `acp.json.before-megachat-<UTC time>`. Another entry MUST stay, with a line. `MEGACHAT_ACP_INSTALLED` MAY replace the path.

Tests: `test/install.test.mjs`

#### Scenario: The path of installed.json
- **WHEN** the platform is `darwin`, `linux` with `XDG_DATA_HOME` set to `/data`, or `win32` with `APPDATA` set to `/roaming`
- **THEN** the path is `~/Library/Application Support/JetBrains/acp-agents/installed.json`, `/data/JetBrains/acp-agents/installed.json` or `/roaming/JetBrains/acp-agents/installed.json`

#### Scenario: A copy without .git
- **WHEN** `installed.json` has the registry agent, and `acp.json` has `First` and the npx entry
- **THEN** the backup holds the earlier text, and `agent_servers` has only `First`

#### Scenario: An entry of the user
- **WHEN** `installed.json` has the registry agent, and the npx entry has an `env` with `HTTPS_PROXY`
- **THEN** `acp.json` stays unchanged, and `install` prints that the entry stays

### Requirement: Overlay entry of a checkout
In a git checkout, when `installed.json` has the registry agent, `install` MUST add the entry `acp.registry.megachat-acp` with only `agent.distribution.local` (the `command` and `args` of the checkout entry) to `~/.jetbrains/acp-registry-installed-overlay.json`. It MUST keep other keys, the key order and the mode, with a backup. A file that is not strict JSON, or another entry, MUST stay, with the `acp.json` entry. `MEGACHAT_ACP_OVERLAY` MAY replace the path.

Tests: `test/install.test.mjs`

#### Scenario: The overlay entry
- **WHEN** `installed.json` has the registry agent, the overlay file does not exist, and `acp.json` has `Other` and the entry of the checkout
- **THEN** the overlay file has only the entry and the mode 0600, and `agent_servers` has only `Other`

#### Scenario: A file with comments
- **WHEN** the overlay file starts with a comment line
- **THEN** the overlay file and `acp.json` stay unchanged, and the exit code is 1

### Requirement: Summary line of install
Before the line about the IDE build, `install` MUST print one line that starts with "Next step" and names the case: the written `acp.json` entry, the registry agent, the overlay entry, or a start that is not in place. A removed entry MUST add its path and its backup to that line. `setup.sh` MUST print that line again after its line "Megachat is installed.".

Tests: `test/install.test.mjs`, `test/setup.test.mjs`

#### Scenario: The registry agent in a copy without .git
- **WHEN** `installed.json` has the registry agent
- **THEN** the third line from the end is "Next step in Air: open the Megachat row. Air has Megachat from the registry already, so the install writes no entry to acp.json."

#### Scenario: The setup line
- **WHEN** the install line prints "Next step in Air: select Megachat in the agent list."
- **THEN** `setup.sh` prints it again after "Megachat is installed.", and it does not print its earlier fixed text about `acp.json`

### Requirement: Dialog about a second entry
After an attach of a view, when `installed.json` has the registry agent and `acp.json` has an entry `Megachat`, Megachat MUST ask with `session/request_permission`: "Megachat is installed two times", with `remove` and `keep`. One process MUST show one dialog at a time. `remove` MUST remove the entry with a backup when no turn runs. `keep` MUST go to `settings.json`, and Megachat MUST NOT ask again. `cancelled` MUST ask again at the next attach.

Tests: `test/acp-entry.test.mjs`

#### Scenario: Remove after a turn
- **WHEN** a turn runs, and the user selects "Remove the copy"
- **THEN** the entry stays until the end of the turn, then the backup holds the earlier text, and `agent_servers` keeps `Other`

#### Scenario: Keep
- **WHEN** the user selects "Keep both"
- **THEN** `settings.json` has `acpEntry` set to `keep`, and a later view of another process gets no dialog

#### Scenario: An entry of the user
- **WHEN** the entry has an `env` with `HTTPS_PROXY`
- **THEN** the text ends with "The acp.json entry has your changes.", and Remove removes the entry

#### Scenario: An entry that changes during the wait
- **WHEN** the user selects Remove while a turn runs, and the entry changes before the end of the turn
- **THEN** the changed entry stays, and no backup comes

#### Scenario: Cancelled
- **WHEN** Air answers `cancelled`
- **THEN** the next attach shows the dialog again, and a third attach while it shows sends no third dialog

## MODIFIED Requirements

### Requirement: Entry Megachat
Without the registry agent in `installed.json`, `install` MUST add the entry `Megachat` to `agent_servers` of `~/.jetbrains/acp.json`. The entry MUST have no `application_session` key. `MEGACHAT_ACP_CONFIG` MAY replace the path of `acp.json`. The tests set it to a temporary file.

Tests: `test/install.test.mjs`

#### Scenario: The path of acp.json
- **WHEN** `MEGACHAT_ACP_CONFIG` is set, and then it is not set
- **THEN** `install` uses the path of the variable first, and then `~/.jetbrains/acp.json`

#### Scenario: The entry has no application_session key
- **WHEN** `install` writes the entry in a git checkout
- **THEN** the entry `Megachat` has only the keys `command` and `args`

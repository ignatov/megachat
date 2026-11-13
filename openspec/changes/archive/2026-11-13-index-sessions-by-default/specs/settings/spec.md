## MODIFIED Requirements

### Requirement: Content of the settings file
The file `settings.json` MUST hold the schema 1, the status of the onboarding, the version of the defaults under the key `defaults`, and the stored values. Each write MUST give `defaults` the value 2. It can hold the project values under the key `projects`. A stored key that this build does not know MUST stay in the file.

Tests: `test/settings.test.mjs`, `test/project-settings.test.mjs`

#### Scenario: The first answer
- **WHEN** the state directory has no `settings.json` and the agent sets `reply.length` to `detailed`
- **THEN** `settings.json` holds `{ "schema": 1, "onboarding": "pending", "defaults": 2, "values": { "reply.length": "detailed" } }`

#### Scenario: An unknown key stays in the file
- **WHEN** `settings.json` holds the key `future.key` and the agent sets `reply.length` to `normal`
- **THEN** `settings.json` holds `future.key` and `reply.length`

### Requirement: Unreadable settings file
A file that the daemon cannot read MUST stay next to it as `settings.json.unreadable-<UTC time>`. The log MUST give the reason without the content, and the defaults MUST apply, but `sessions.index` MUST be `off`, because the file can hold an answer off. The daemon MUST write a new `settings.json` with that value at once.

Tests: `test/settings.test.mjs`

#### Scenario: A file with incomplete JSON
- **WHEN** `settings.json` holds `{ "schema": 1, "onboarding": `
- **THEN** the file moves to `settings.json.unreadable-<UTC time>` with the same content, the log has one line "Megachat cannot read settings.json (json). The file is now settings.json.unreadable-...", the onboarding is pending, and the new `settings.json` holds `{ "schema": 1, "onboarding": "pending", "defaults": 2, "values": { "sessions.index": "off" } }`

#### Scenario: A file with another schema
- **WHEN** `settings.json` holds the schema 2
- **THEN** the file moves to `settings.json.unreadable-<UTC time>`, and the log gives the reason `schema`

### Requirement: Settings of the index of past sessions
The settings of the index of past sessions are `sessions.index`, `sessions.days` and `sessions.notes`. Their defaults MUST be `on`, `180` and `off`. They MUST apply at once, also in the middle of a turn, because they change no model request.

Tests: `test/settings.test.mjs`

#### Scenario: The defaults of the index
- **WHEN** no variable is set and no value is stored
- **THEN** `sessions.index` is `on`, `sessions.days` is `180` and `sessions.notes` is `off`

#### Scenario: A setting of the index in a turn
- **WHEN** a tool call in a turn sets `sessions.days` to `30`
- **THEN** the value `30` applies at once, before the turn ends

## ADDED Requirements

### Requirement: Settings file of an earlier build
A `settings.json` without the key `defaults` is of v0.6.3 or older. With the onboarding `done` or `skipped` and no stored `sessions.index`, its default of `sessions.index` MUST be `off`, because that setup stored no answer off. The open MUST NOT change the file. The first write MUST store `sessions.index` `off` and `defaults` 2. With the onboarding `pending`, the defaults of this build MUST apply.

Tests: `test/settings.test.mjs`, `test/workday.test.mjs`

#### Scenario: A file after the setup of v0.6.3
- **WHEN** `settings.json` holds the onboarding `done` or `skipped`, the value `normal` of `reply.length`, and no key `defaults`
- **THEN** `sessions.index` is `off` with the source `default` and the default `off`, and the file has the same text after the open

#### Scenario: The first write of such a file
- **WHEN** the agent sets `reply.language` to `Deutsch` in that file
- **THEN** the file holds `defaults` 2 and the values `reply.length` `normal`, `sessions.index` `off` and `reply.language` `Deutsch`, the next open gives `off` with the source `setting`, and a reset of `sessions.index` then gives `on`

#### Scenario: A file of this build after the setup
- **WHEN** `settings.json` holds the onboarding `done`, `defaults` 2 and no value
- **THEN** `sessions.index` is `on` with the source `default`

#### Scenario: A file of v0.6.3 before the setup
- **WHEN** `settings.json` holds the onboarding `pending`, no key `defaults` and no value, and the agent sets the onboarding to `done`
- **THEN** `sessions.index` is `on`, and the file holds `{ "schema": 1, "onboarding": "done", "defaults": 2, "values": {} }`

#### Scenario: A stored on of v0.6.3
- **WHEN** `settings.json` holds the onboarding `done`, the value `on` of `sessions.index`, and no key `defaults`
- **THEN** `sessions.index` is `on` with the source `setting`

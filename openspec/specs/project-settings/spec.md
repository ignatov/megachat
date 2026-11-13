# project-settings Specification

## Purpose
A setting of a child run can have a value for one project. A child in the directory of that project gets this value in place of the global value, and the other projects keep the global value.

## Requirements

### Requirement: Settings that can have a project value
A setting of one child run MUST be able to have a value for one project: `children.agent`, `children.piModel`, `children.claudeModel`, `children.codexModel`, `children.permissionMode`, `children.commit`, `children.push`, `children.daemonRestart` and `children.timeoutMinutes`. Each other setting applies to the daemon as a whole, also `children.parallel`, so it MUST have only the global value. `PROJECT_SETTINGS` of `src/Settings.mjs` MUST hold the list.

Tests: `test/project-settings.test.mjs`

#### Scenario: The list of the settings
- **WHEN** a test reads `PROJECT_SETTINGS`
- **THEN** it holds `children.agent`, `children.piModel`, `children.claudeModel`, `children.codexModel`, `children.permissionMode`, `children.commit`, `children.push`, `children.daemonRestart` and `children.timeoutMinutes`, and the only other setting of the children, `children.parallel`, is not in the list

#### Scenario: A stored project value of children.parallel
- **WHEN** `settings.json` holds the value `1` of `children.parallel` for the project `lib`
- **THEN** a child run in `lib` gets the global value `3`

### Requirement: Settings without a project value
Without a project value, each setting MUST work as before. A `settings.json` of v0.3.0 or older has no key `projects`, so it MUST open with no project value.

Tests: `test/project-settings.test.mjs`

#### Scenario: No project value
- **WHEN** no project has a value
- **THEN** a child run in the directory `app/server` gets the same values as the global values

#### Scenario: A file of v0.3.0
- **WHEN** `settings.json` has the global value `deny` of `children.push` and no key `projects`
- **THEN** `agents_settings get` gives no project value, and a child run in `app` gets `deny`

### Requirement: Storage of the project values
`settings.json` MUST keep the project values under the key `projects`, by the real path of the project directory: `{"projects": {"/work/app": {"children.push": "deny"}}}`. The last reset of a project value MUST remove the key, so the file has the shape of v0.3.0 again.

Tests: `test/project-settings.test.mjs`

#### Scenario: A value set through a symbolic link
- **WHEN** the user sets `children.push` to `deny` for the path `link`, a symbolic link to `app`
- **THEN** `settings.json` holds `{"children.push": "deny"}` under the key `projects`, by the real path of `app`

#### Scenario: The last reset
- **WHEN** the user resets each project value
- **THEN** `settings.json` holds only `schema`, `onboarding` and `values`

### Requirement: Project value of a child run
A child run in a directory MUST get, for each key, the project value of the nearest project directory that is the directory or holds it, else the global value. Megachat MUST compare the real paths by their segments, as the pool of the children does: a symbolic link to a project is that project, and `app2` is not in `app`. An environment variable and an option MUST win over a project value.

Tests: `test/project-settings.test.mjs`

#### Scenario: The nearest project directory
- **WHEN** `app` has `children.agent` `codex` and `children.push` `deny`, `app/server` has `children.push` `allow`, and a child runs in `app/server/src`
- **THEN** the child gets the agent `codex` of `app` and the push value `allow` of `app/server`

#### Scenario: A symbolic link and a common prefix
- **WHEN** a child runs in `link`, a symbolic link to `app`, and another child runs in `app2`
- **THEN** the child in `link` gets the values of `app`, and the child in `app2` gets the global values

#### Scenario: An option
- **WHEN** an option sets `children.push` to `ask`, and `app/server` has the project value `allow`
- **THEN** a child in `app/server` gets `ask` with the source `option`

### Requirement: Read of a project value at each dispatch
The daemon MUST read a project value at each dispatch: the agent of a new task without a named agent, the rules paragraph of the child, the permission mode and the model of a Claude child, and the model of a pi child. A follow-up and a continuation MUST use the value at their own dispatch.

Tests: `test/project-settings.test.mjs`

#### Scenario: A child in each project
- **WHEN** `app` has `children.agent` `codex` and `children.push` `deny`, `app/server` has `children.permissionMode` `ask` and `children.claudeModel` `anthropic/fable`, and `lib` has its own `children.piModel`
- **THEN** a new task in `app` goes to `codex` with the push rule of `deny`, a Claude child in `app/server` gets the mode `default` and the model `fable` before the prompt, and a pi child in `lib` gets the model of `lib`

#### Scenario: A follow-up after a change
- **WHEN** the user sets `children.push` to `allow` for `app`, and the main agent sends a follow-up to the run in `app`
- **THEN** the prompt of the follow-up holds the push rule of `allow`

### Requirement: Set a project value
`agents_settings set` and `reset` MUST take an optional `project`: an absolute path or a path that starts with `~`, of a directory that exists. The tool MUST store the real path. The validation of a project value MUST be the validation of the global value. A project value of a setting of the daemon as a whole MUST be refused with a message that names the settings that can have one.

Tests: `test/project-settings.test.mjs`

#### Scenario: A value that the global setting refuses
- **WHEN** the user sets `children.push` to `sometimes` or `children.agent` to `pi` for `app`
- **THEN** the tool refuses the value

#### Scenario: A setting of the daemon as a whole
- **WHEN** the user sets `children.parallel`, `coordinator.model` or `budget.dailyUsd` for `app`
- **THEN** the tool refuses it with a message that names the settings that can have a project value

#### Scenario: A path that is not a directory
- **WHEN** the user gives the project `app` as a relative path, a directory that does not exist, or the path of a file
- **THEN** the tool refuses the project

### Requirement: Reset of a project value
`reset` with `project` MUST remove the project value, so the value of a project that holds it, or the global value, applies again. `reset` with `project` and without `key` MUST remove each value of the project.

Tests: `test/project-settings.test.mjs`

#### Scenario: The value of the project that holds it
- **WHEN** `app` has `children.commit` `ask`, `app/server` has `children.commit` `deny`, and the user resets `children.commit` for `app/server`
- **THEN** the value for `app/server` is `ask` from the project `app`

#### Scenario: Each value of a project
- **WHEN** `app` has `children.push` and `children.commit`, and the user resets `app` without a key
- **THEN** the tool removes `children.push` and `children.commit` of `app`

### Requirement: Project values in get
`get` MUST mark each setting that can have a project value with `perProject`, and give the project values with their directories. A stored project value that this build does not accept MUST go to `ignored`, MUST NOT apply, and MUST stay in the file. A directory that no longer exists MUST keep its values and show `missing`, and a reset with its path MUST remove them.

Tests: `test/project-settings.test.mjs`

#### Scenario: The project values
- **WHEN** `app` has `children.push` `deny` and `children.commit` `ask`, and `app/server` has `children.permissionMode` `auto`
- **THEN** `get` gives these values with their directories, and it marks each setting of `PROJECT_SETTINGS` with `perProject`

#### Scenario: A value that this build does not accept
- **WHEN** `settings.json` holds `children.push` `sometimes` and `future.key` for `app`
- **THEN** `get` gives them under `ignored`, a child in `app` gets the global value of `children.push`, and a later write keeps them in the file

#### Scenario: A directory that no longer exists
- **WHEN** the directory `app/server` with a project value is removed
- **THEN** `get` shows `app/server` with its values and `missing`, and a reset with its path removes them

### Requirement: Project values in the rules of the main agent
The rules of the main agent MUST say in one line that a project can have its own values, how to set one, and that a request "in this project" or with a named project sets the project value and not the global value. They MUST give the project values that apply, one line for each project, or one line that no project has its own value. The setup of the first run MUST NOT change.

Tests: `test/project-settings.test.mjs`

#### Scenario: No project value
- **WHEN** no project has a value
- **THEN** the rules of the main agent say "No project has its own value now."

#### Scenario: Two projects with values
- **WHEN** `app` has `children.push` `deny` and `children.commit` `ask`, and `app/server` has `children.permissionMode` `auto`
- **THEN** the rules of the main agent have one line for `app` with `children.push=deny, children.commit=ask`, and one line for `app/server` with `children.permissionMode=auto`

### Requirement: Project values in automatic turns
An automatic turn MUST NOT change a project value.

Tests: `test/project-settings.test.mjs`

#### Scenario: A turn of a child result, of an event or of the morning report
- **WHEN** an automatic turn sets or resets `children.push` for `app`
- **THEN** the tool refuses the change, and Megachat writes no `settings.json`

### Requirement: Project values in a daemon of v0.3.0
A daemon of v0.3.0 MUST open a `settings.json` with project values. It ignores them, its children get the global values, and a write of the file keeps them, because v0.3.0 keeps each top-level key that it does not know.

Tests: `test/project-settings.test.mjs`

#### Scenario: A file of this build in v0.3.0
- **WHEN** this build stores `children.push` `deny` for `app`, and a daemon of v0.3.0 opens the file and sets `children.commit` to `deny`
- **THEN** the daemon of v0.3.0 gives `ask` for `children.push`, and the file keeps the project value, so this build then gives `deny` for both settings in `app`

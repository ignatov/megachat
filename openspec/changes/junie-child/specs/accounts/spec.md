# Spec Delta

## MODIFIED Requirements

### Requirement: Account check
The tool `agents_accounts` MUST check Claude Code and Codex in parallel, and Junie with them when Junie is there (see "Account check of Junie"). It MUST start each agent as a child starts, ask for `initialize` and `session/new` in the workspace of Megachat, send no prompt, and close the process after the check. The check has no project, so Claude MUST load no settings file: `settingSources` MUST be empty.

Tests: `test/accounts.test.mjs`

#### Scenario: A check without a prompt
- **WHEN** the check starts Claude Code
- **THEN** the agent gets `session/new` with the options of a child and with an empty `settingSources`, it gets no prompt, and its process stops after the check

## ADDED Requirements

### Requirement: Account check of Junie
The check MUST include Junie only when a file `junie` that the user can run is on the `PATH` of a child. Without it, the result MUST hold no row for Junie, so the setup shows no problem to a user without Junie. A row of Junie MUST have the statuses, the time limit and the texts of the other agents, with the name `Junie`.

Tests: `test/accounts.test.mjs`

#### Scenario: A machine without Junie
- **WHEN** the `PATH` of a child has no `junie`, and Claude Code and Codex open the session
- **THEN** the result has a row for Claude Code and a row for Codex, and no row for Junie

#### Scenario: Junie opens the session
- **WHEN** the `PATH` of a child has `junie`, and Junie opens the session
- **THEN** Junie has the status `started` with the login `unknown`, it gets no prompt, and its process stops after the check

#### Scenario: Junie without a login
- **WHEN** the `PATH` of a child has `junie`, and Junie refuses the session with `authRequired`
- **THEN** Junie has the status `failed` with the login `missing`, the problem "Junie needs a login." and the fix "Run "~/.local/bin/central login" in a terminal. Then run the check again."

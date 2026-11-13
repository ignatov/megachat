# accounts Specification

## Purpose
The tool `agents_accounts` checks that Claude Code and Codex start and open a session. The user gets the status of each agent, and for each failure the problem and what to fix.

## Requirements

### Requirement: Account check
The tool `agents_accounts` MUST check Claude Code and Codex in parallel. It MUST start each agent as a child starts, ask for `initialize` and `session/new` in the workspace of Megachat, send no prompt, and close the process after the check. The check has no project, so Claude MUST load no settings file: `settingSources` MUST be empty.

Tests: `test/accounts.test.mjs`

#### Scenario: A check without a prompt
- **WHEN** the check starts Claude Code
- **THEN** the agent gets `session/new` with the options of a child and with an empty `settingSources`, it gets no prompt, and its process stops after the check

### Requirement: Time limit and shared check
Each agent MUST have a time limit of 30 seconds. A second call while a check runs MUST get the result of that check.

Tests: `test/accounts.test.mjs`

#### Scenario: An agent that does not answer
- **WHEN** both agents read their input and never answer
- **THEN** each agent gets the status `failed` with the problem that it did not answer in the time limit, and the two checks run at the same time

#### Scenario: Two calls share one check
- **WHEN** two calls of `agents_accounts` come while one check runs, and a third call comes after that check
- **THEN** the two calls get the same result of one check, and the third call starts a new check

### Requirement: Agent that opens the session
An agent that opens the session MUST give the status `started` with the login `unknown`, because only a prompt proves that the provider accepts the login. The result MUST say so.

Tests: `test/accounts.test.mjs`

#### Scenario: An agent that starts
- **WHEN** Claude Code opens the session
- **THEN** Claude Code has the status `started` with the login `unknown`, and a note that the check sends no prompt, so it cannot prove that the provider accepts the login

### Requirement: Failed agent
An agent that refuses the session with the ACP error `authRequired` MUST give the status `failed` with the login `missing`. An agent that does not start, a failed Central configuration, a refused session and the time limit MUST give `failed`. Each failure MUST give the problem and what to fix, from the resources and not from the agent.

Tests: `test/accounts.test.mjs`

#### Scenario: An agent without a login
- **WHEN** Codex refuses the session with `authRequired`
- **THEN** Codex has the status `failed` with the login `missing`, the problem "Codex needs a login." and the fix "Run "central login" in a terminal. Then run the check again."

#### Scenario: An agent that does not start and a failed Central configuration
- **WHEN** the command of Claude Code does not exist and Central gives no configuration for Codex
- **THEN** Claude Code has the status `failed` with the problem "Claude Code did not start.", and Codex has the status `failed` with the problem "Central gave no key to Codex."

### Requirement: When the check runs
The setup MUST run the check at its end as no question. It MUST show only the agents with a problem and what to fix, and say nothing about the check when each agent is ready. The rules of the main agent MUST run the check when a child fails with a login error.

Tests: `test/settings.test.mjs`

#### Scenario: The end of the setup
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "call agents_accounts" and "Show only the agents with a problem and what to fix. When each agent is ready, say nothing about the check."

# child-settings Specification

## Purpose
The settings of the children let the user select the agent, the model and the permission mode of a child task, the steps that a child can do, and the count of the children that run at the same time.

## Requirements

### Requirement: Default agent of a child task
The setting `children.agent` MUST select the agent of a new child task without a named agent: `claude`, the default, or `codex`. It MUST refuse `pi`, because a pi child cannot change code. A follow-up and a continuation MUST stay with the agent of their session. A change MUST apply to the next child task, also in the turn that made it.

Tests: `test/settings.test.mjs`, `test/child-settings.test.mjs`

#### Scenario: The agent of the setting
- **WHEN** `children.agent` is `codex` and the main agent starts the task "first task" without a named agent
- **THEN** the run of "first task" has the agent `codex`

#### Scenario: A change in the turn that made it
- **WHEN** a turn sets `children.agent` to `claude`, then starts the task "second task" and sends the follow-up "more" to the session of the `codex` run
- **THEN** "second task" goes to `claude`, and "more" stays with `codex`

#### Scenario: The value pi
- **WHEN** the main agent sets `children.agent` to `pi`
- **THEN** the setting refuses the value

### Requirement: Values of the step settings
The settings `children.commit`, `children.push` and `children.daemonRestart` MUST take `allow`, `ask` or `deny`. The defaults are `allow`, `ask` and `ask`. A daemon restart is a restart or a stop of the Megachat daemon. The rules of the main agent MUST give the default agent and the three values, so the agent does not promise the user other rules.

Tests: `test/settings.test.mjs`, `test/child-settings.test.mjs`

#### Scenario: A value that is not allowed
- **WHEN** the main agent sets `children.commit` to `yes` or `children.push` to `never`
- **THEN** the setting refuses the value

#### Scenario: The values in the rules of the main agent
- **WHEN** the settings of the children have their defaults
- **THEN** the section `settings` of the main agent says that a task goes to claude, and it gives "commit allow, push ask, restart or stop of the Megachat daemon ask"

### Requirement: Rules paragraph in the prompt of a child
At each dispatch, the daemon MUST add one rules paragraph from the settings `children.commit`, `children.push` and `children.daemonRestart` to the prompt of the child, as a block before the task. A change MUST reach the next new task, follow-up and continuation. The state MUST keep the prompt of a run without the paragraph.

Tests: `test/child-settings.test.mjs`

#### Scenario: The rules of the defaults
- **WHEN** no setting of the steps is stored and the main agent starts the task "first task"
- **THEN** the prompt of the child holds the rules paragraph with the commit rule of `allow`, the push rule of `ask` and the daemon restart rule of `ask` before "first task", and the run keeps the prompt "first task"

#### Scenario: A change before a follow-up
- **WHEN** a turn sets `children.push` to `deny` and `children.commit` to `ask`, and then sends the follow-up "follow-up"
- **THEN** the prompt of "follow-up" holds the commit rule of `ask` and the push rule of `deny`, and the run keeps the prompt "follow-up"

### Requirement: Meaning of the step values
`allow` MUST let the child do the step. `deny` MUST forbid the step, also when the task asks for it. `ask` MUST forbid the step unless the task says that the user approved it. The child MUST then say in its result that the step is necessary.

Tests: `test/child-settings.test.mjs`

#### Scenario: The value ask
- **WHEN** `children.commit` is `ask`
- **THEN** the rules paragraph tells the child to make a git commit only when the task says that the user approved the commit, and else to say in its result that a commit is necessary

#### Scenario: The value deny
- **WHEN** `children.push` is `deny`
- **THEN** the rules paragraph tells the child not to push to a remote repository, also when the task asks for it

### Requirement: Settings of the children in automatic turns
A turn of a child result or of the summary of the past sessions MUST NOT change the settings `children.agent`, `children.commit`, `children.push` and `children.daemonRestart`.

Tests: `test/child-settings.test.mjs`

#### Scenario: A turn of a child result
- **WHEN** the turn of a child result or of the summary of the past sessions sets `children.agent` to `codex`, `children.push` to `allow` or `children.daemonRestart` to `allow`
- **THEN** the setting refuses the change, and `settings.json` keeps no value

### Requirement: Settings of the children across a daemon restart
A daemon restart MUST keep each setting of the children, the known repositories and the spend limit.

Tests: `test/settings.test.mjs`

#### Scenario: A restart after a change
- **WHEN** the user sets `children.agent` to `codex`, `children.parallel` to `1`, `children.permissionMode` to `allowEdits`, `children.commit` to `deny` and `budget.dailyUsd` to `3`, and the daemon restarts
- **THEN** `agents_settings get` gives each of these values with the source `setting`

### Requirement: Parallel child runs
The setting `children.parallel` MUST give the count of the child runs that run at the same time: an integer from 1 to 8. The default is 3. The value 1 MUST give the order and the states of the builds up to v0.3.0, which ran one child at a time. A change MUST apply to the next start of a child. It MUST NOT stop a child that runs. A lower value MUST let a queued run start only when fewer children run than the new value.

Tests: `test/settings.test.mjs`, `test/parallel.test.mjs`

#### Scenario: Three places
- **WHEN** `children.parallel` is `3` and four tasks start in four different directories
- **THEN** three tasks run at the same time, and the fourth task waits until one of them ends

#### Scenario: One place
- **WHEN** `children.parallel` is `1` and two tasks start in two different directories
- **THEN** the second task starts only after the first task ends

#### Scenario: A lower value
- **WHEN** two tasks run, a turn sets `children.parallel` to `1`, and a third task starts
- **THEN** no running task stops, and the third task starts only after the two running tasks end

#### Scenario: A value out of the range
- **WHEN** the main agent sets `children.parallel` to `0`, `9` or `2.5`
- **THEN** the setting refuses the value

### Requirement: Parallel runs in the rules
The rules of the setup MUST ask for the setting `children.parallel`. The rules of the main agent MUST say that tasks in different directories run at the same time, and that tasks in one directory or in a directory inside it run one after the other.

Tests: `test/settings.test.mjs`, `test/parallel.test.mjs`

#### Scenario: The rules of the main agent
- **WHEN** the main agent reads its rules
- **THEN** the rules say "Tasks in different directories run at the same time, at most children.parallel of them." and "Tasks in one directory or in a directory inside it run one after the other"

#### Scenario: The rules of the setup
- **WHEN** the setup rules start
- **THEN** they name `children.parallel` together with each other setting of this build

### Requirement: Claude settings in the rules of the main agent
The rules of the main agent MUST give the values of `children.permissionMode` and `children.claudeModel`, say that `inherit` leaves them to the settings of Claude Code, that no value lets a child skip a permission request, that a refused mode or model fails the task before its start, and that the settings do not change a Codex or a pi child.

Tests: `test/child-settings.test.mjs`

#### Scenario: The defaults
- **WHEN** `children.permissionMode` and `children.claudeModel` have the default `inherit`
- **THEN** the section `settings` of the main agent says that a Claude child uses the mode and the model `inherit`, that `inherit` leaves them to the settings of Claude Code, that a child never gets the mode `bypassPermissions`, and that these settings do not change a Codex child or a pi child

#### Scenario: Changed values
- **WHEN** a turn sets `children.permissionMode` to `ask` and `children.claudeModel` to `anthropic/fable`
- **THEN** the section `settings` of the main agent gives the mode `ask` and the model `anthropic/fable`

### Requirement: Description of the permission mode
The description of `children.permissionMode` MUST say that Claude Code applies an allow rule of the project only in a directory that the user trusted.

Tests: `test/settings.test.mjs`

#### Scenario: The description in get
- **WHEN** `agents_settings get` gives the setting `children.permissionMode`
- **THEN** its description says "Claude Code applies an allow rule of the project only in a directory that the user trusted in Claude Code."

### Requirement: Values of the permission mode
The setting `children.permissionMode` MUST select the permission mode of a Claude child: `inherit`, the default, `ask`, `allowEdits` or `auto`. One map in `src/Settings.mjs` MUST hold these names. The setting MUST NOT offer `bypassPermissions`. It MUST NOT offer `plan`, because the approval of a plan has an option that switches the child to `auto`. The adapter ignores a mode `auto`, `acceptEdits` or `bypassPermissions` of the project settings.

Tests: `test/settings.test.mjs`

#### Scenario: The values of the setting
- **WHEN** the main agent sets `children.permissionMode` to ` allowEdits `
- **THEN** the setting has the value `allowEdits`

#### Scenario: The names of Claude Code
- **WHEN** the main agent sets `children.permissionMode` to `default`, `acceptEdits`, `bypassPermissions` or `plan`
- **THEN** the setting refuses the value

### Requirement: Modes of Claude Code for the permission mode
`ask`, `allowEdits` and `auto` MUST give the modes `default`, `acceptEdits` and `auto` of Claude Code. Claude Code applies the `permissions.allow` rules of `.claude/settings.json` only in a workspace that the user trusted in Claude Code, with its trust dialog. In another directory it drops them, and a child in the mode `default` asks all the same. The `deny` and `ask` rules apply in each directory. Megachat does not change the trust.

Tests: `test/child-settings.test.mjs`

#### Scenario: The modes of the values
- **WHEN** `children.permissionMode` is `ask`, `allowEdits` or `auto`, and a Claude child starts
- **THEN** the child gets the mode `default`, `acceptEdits` or `auto` before the prompt

### Requirement: Inherited permission mode
With `inherit`, Megachat MUST send no mode, and the settings of Claude Code decide. The adapter takes the start mode from `permissions.defaultMode` of each settings file of Claude Code, whatever `settingSources` says: also from `~/.claude/settings.json` of the user. So a user setting `auto` puts each Claude child in the mode `auto`, and a project can set the mode `plan`. A load continues in the mode of its transcript.

Tests: `test/child-settings.test.mjs`

#### Scenario: No mode request
- **WHEN** `children.permissionMode` is `inherit` and a Claude child starts the task "first task"
- **THEN** Megachat sends no mode request, and the run completes

### Requirement: Explicit permission mode
With another value, Megachat MUST send the mode in a `session/set_mode` request after `session/new` or `session/load` and before the prompt, so the mode wins over each settings file. The adapter ignores `permissionMode` in `_meta.claudeCode.options`. When the adapter refuses the mode, the run MUST fail before the prompt, with a message that names the value, and with no continuation. A closed connection MUST stay an interruption with a continuation.

Tests: `test/child-settings.test.mjs`

#### Scenario: The mode before the prompt
- **WHEN** `children.permissionMode` is `allowEdits` and a Claude child starts
- **THEN** Megachat sends the mode `acceptEdits` before the prompt

#### Scenario: A refused mode
- **WHEN** `children.permissionMode` is `auto` and the agent offers only the modes `default`, `acceptEdits` and `plan`
- **THEN** the run ends as `interrupted` with a message that names `auto`, the child gets no prompt, and the run gets no continuation

#### Scenario: A closed connection
- **WHEN** `children.permissionMode` is `ask` and the agent ends in the mode request
- **THEN** the run is an interruption, and the run gets a continuation

### Requirement: Scope of the permission mode
The setting `children.permissionMode` MUST NOT change a Codex child or a pi child. A change MUST apply to the next Claude child: a new task, a follow-up and a continuation. A `settings.json` without the key MUST open with `inherit`. When no settings file sets `permissions.defaultMode`, the adapter 0.102.0 starts the child in the mode `auto` if the modes of the session offer it, else in the mode `default`, as a real run showed on 2026-11-12.

Tests: `test/child-settings.test.mjs`

#### Scenario: A follow-up after a change
- **WHEN** a turn sets `children.permissionMode` to `ask` and sends a follow-up to the session of a Claude run
- **THEN** the follow-up loads its session and gets the mode `default` before the prompt

#### Scenario: A Codex child
- **WHEN** `children.permissionMode` is `ask` and a task goes to `codex`
- **THEN** Megachat sends no mode to the Codex child

#### Scenario: A file without the key
- **WHEN** `settings.json` has values but no key `children.permissionMode`
- **THEN** the setting has the value `inherit` with the source `default`

### Requirement: No mode bypassPermissions for a Claude child
A Claude child MUST never get the mode `bypassPermissions`. With `permissions.defaultMode: "bypassPermissions"` in `~/.claude/settings.json` of the user and `inherit`, a Claude child of Megachat starts in the mode `default`, with no error. The adapter ignores the mode, because the options turn it off. A load of a transcript in `bypassPermissions` also continues in the mode `default`. So such a child asks for each step that a permission rule does not allow.

Tests: `test/child-settings.test.mjs`

#### Scenario: A user mode bypassPermissions
- **WHEN** the adapter starts a session with the start mode `bypassPermissions`, and the options of the child turn that mode off
- **THEN** the session starts in the mode `default`

#### Scenario: A load of a transcript in bypassPermissions
- **WHEN** the adapter loads a transcript in the mode `bypassPermissions`, and the options of the child turn that mode off
- **THEN** the session continues in the mode `default`

### Requirement: Options and filter of a Claude child
The options of a Claude child MUST hold `allowDangerouslySkipPermissions: false`, so the adapter does not offer the mode in the modes of the session and in the options of the approval of a plan. Before the state keeps a permission request of a child, Megachat MUST remove each option whose `optionId` names `bypass`. This filter is a second guard that does not depend on that option.

Tests: `test/child-settings.test.mjs`

#### Scenario: The options of the child
- **WHEN** a Claude child starts
- **THEN** its options hold `allowDangerouslySkipPermissions: false`

#### Scenario: The approval of a plan with bypass options
- **WHEN** a Claude child asks for the approval of a plan with the options `exit-plan-clear-bypass`, `exit-plan-auto`, `exit-plan-bypass`, `exit-plan-default` and `reject`
- **THEN** the state keeps the request with only the options `exit-plan-auto`, `exit-plan-default` and `reject`

### Requirement: Answer with a removed option
An answer that names a removed option MUST be refused.

Tests: `test/child-settings.test.mjs`

#### Scenario: An answer with a bypass option
- **WHEN** the user answers the approval of a plan with `exit-plan-bypass` or `exit-plan-clear-bypass`
- **THEN** Megachat refuses the answer, and the request stays pending

#### Scenario: An answer with a kept option
- **WHEN** the user then answers the request with `exit-plan-default`
- **THEN** the child gets the option `exit-plan-default`, and the run completes

### Requirement: Values of the Claude model
The setting `children.claudeModel` MUST select the model of a Claude child: `inherit`, the default, or a model of Claude Code as `anthropic/<model ID>`. The model registry need not know the model, because Claude Code has models and aliases that the registry does not have, such as `fable`.

Tests: `test/settings.test.mjs`, `test/child-settings.test.mjs`

#### Scenario: A model that the registry does not know
- **WHEN** the model registry has no model `anthropic/fable` or `anthropic/claude-unknown-9`, and the main agent sets `children.claudeModel` to one of them
- **THEN** the setting has that value

#### Scenario: Another provider
- **WHEN** the main agent sets `children.claudeModel` to `openai/gpt-5` or `faux/fast`
- **THEN** the setting refuses the value

#### Scenario: A model of the setting at the agent
- **WHEN** `children.claudeModel` is `anthropic/claude-unknown-9` and a Claude child starts
- **THEN** the options of the child name the model `claude-unknown-9`, and Megachat sends the model `claude-unknown-9` before the prompt

### Requirement: Form of a Claude model ID
A model ID MUST have at most 100 letters, digits, dots, dashes and underscores, start with a letter or a digit, and can end with a context hint such as `[1m]`. Each other text and each other provider MUST be refused.

Tests: `test/settings.test.mjs`

#### Scenario: A context hint
- **WHEN** the main agent sets `children.claudeModel` to `anthropic/claude-opus-5-5[1m]`
- **THEN** the setting has the value `anthropic/claude-opus-5-5[1m]`

#### Scenario: A text that is not a model ID
- **WHEN** the main agent sets `children.claudeModel` to `claude-sonnet-5-5`, `anthropic/claude sonnet`, `anthropic/a/b`, `anthropic/-opus`, `anthropic/opus[1m`, `Anthropic/opus` or a model ID of 101 letters
- **THEN** the setting refuses the value

### Requirement: Inherited Claude model
The options of a Claude child MUST name the model `claude-sonnet-5-5`. The options alone do not decide: the adapter switches a session to the `model` of the settings of Claude Code, also of `~/.claude/settings.json`, and a load continues with the model of its transcript. With `inherit`, Megachat MUST send no model request. The model of the settings of Claude Code then decides, and without one the model of the options applies.

Tests: `test/child-settings.test.mjs`

#### Scenario: The value inherit
- **WHEN** `children.claudeModel` is `inherit` and a Claude child starts
- **THEN** the options of the child name the model `claude-sonnet-5-5`, and Megachat sends no model request

### Requirement: Explicit Claude model
With a model, Megachat MUST put its model ID in the options and send it in a `session/set_config_option` request with the `configId` `model` after `session/new` or `session/load`, before the mode and the prompt, so the model wins over each settings file.

Tests: `test/child-settings.test.mjs`

#### Scenario: A model of the setting
- **WHEN** `children.claudeModel` is `anthropic/claude-haiku-5-5`, `children.permissionMode` is `ask`, and a new Claude child starts
- **THEN** the options of the child name the model `claude-haiku-5-5`, and Megachat sends the model `claude-haiku-5-5` before the mode and the prompt

### Requirement: Refused Claude model
When the adapter refuses the model, for example because Claude Code does not offer it, or because the `availableModels` of the settings of Claude Code do not hold it, the run MUST fail before the prompt, with a message that names the value, and with no continuation. The adapter maps a value to a model of its list by its own rules, so a near ID can give a near model: `claude-opus-5-5[1m]` gives `opus`.

Tests: `test/child-settings.test.mjs`

#### Scenario: A model that the agent does not have
- **WHEN** `children.claudeModel` is `anthropic/claude-unknown-9` and the agent has only the model `claude-opus-5-5`
- **THEN** the run fails with a message that names `anthropic/claude-unknown-9`, Megachat sends no mode and no prompt, and the run gets no continuation

### Requirement: Scope of the Claude model
The setting `children.claudeModel` MUST NOT change a Codex child or a pi child. A change MUST apply to the next Claude child: a new task, a follow-up and a continuation.

Tests: `test/child-settings.test.mjs`

#### Scenario: A follow-up after a change
- **WHEN** `children.claudeModel` changes from `inherit` to `anthropic/claude-haiku-5-5`, and the main agent sends a follow-up to the session of a Claude run
- **THEN** the follow-up loads its session and gets the model `claude-haiku-5-5` before the prompt

#### Scenario: A Codex child
- **WHEN** `children.claudeModel` is `anthropic/claude-haiku-5-5` and a task goes to `codex`
- **THEN** Megachat sends no model request to the Codex child

### Requirement: Values of the Codex model
The setting `children.codexModel` MUST select the model of a Codex child: `inherit`, the default, or a model of Codex as `openai/<model ID>`. A model ID MUST have at most 100 letters, digits, dots, dashes and underscores, and start with a letter or a digit. It MUST have no reasoning level in brackets, because the adapter selects a model by its base ID. Each other text and each other provider MUST be refused.

Tests: `test/settings.test.mjs`, `test/child-settings.test.mjs`

#### Scenario: Model IDs of Codex
- **WHEN** the main agent sets `children.codexModel` to `openai/gpt-5.5`, ` openai/gpt-5.3-codex ` or `openai/o4_mini`
- **THEN** the setting has the value `openai/gpt-5.5`, `openai/gpt-5.3-codex` or `openai/o4_mini`

#### Scenario: A reasoning level and another provider
- **WHEN** the main agent sets `children.codexModel` to `openai/gpt-5.5[high]`, `anthropic/claude-sonnet-5-5`, `openai/gpt 5` or `OpenAI/gpt-5.5`
- **THEN** the setting refuses the value, and `settings.json` keeps the value from before

### Requirement: Models of the Codex adapter
The form MUST be the form of the other model settings: the provider, then the model ID that the agent knows. The model registry need not know the model, because the Codex adapter lists its own models. A real run on 2026-11-12 with the adapter 2.6.0, Codex 0.167.0 and Central showed: the model list of the session held `gpt-6.1-sol` (the default), `gpt-6-astra`, `gpt-6-sol`, `gpt-6-luna`, `gpt-5.6-sol`, `gpt-6.1-terra`, `gpt-5.6-terra`, `gpt-5.6-luna` and `gpt-5.5`.

Tests: `test/settings.test.mjs`

#### Scenario: A model that the registry does not know
- **WHEN** the model registry has no model of the provider `openai`, and the main agent sets `children.codexModel` to ` openai/gpt-unknown-9 `
- **THEN** the setting has the value `openai/gpt-unknown-9`

#### Scenario: A model ID without the provider
- **WHEN** the main agent sets `children.codexModel` to `gpt-5.5`
- **THEN** the setting refuses the value

### Requirement: Inherited Codex model
With `inherit`, Megachat MUST send no model request, so a Codex child gets the requests of the builds before the setting. The `model` of the configuration of Codex then decides, and without one the default model of the model list of Codex applies. Central passes only the model provider and no model.

Tests: `test/child-settings.test.mjs`

#### Scenario: No model request
- **WHEN** `children.codexModel` is `inherit` and a Codex child starts the task "first task"
- **THEN** Megachat sends no model request and no mode request, and the run completes

### Requirement: Explicit Codex model
With a model, Megachat MUST send its model ID in a `session/set_config_option` request with the `configId` `model` after `session/new` or `session/load` and before the prompt. With `inherit`, Codex recorded the model `gpt-6.1-sol` for the turn. With `openai/gpt-5.5`, it recorded `gpt-5.5`. Both runs completed with the reply of the task. `openai/gpt-nonexistent-9` failed the run before the prompt, with the message of the setting, and Codex started no turn.

Tests: `test/child-settings.test.mjs`

#### Scenario: A follow-up after a change
- **WHEN** a turn sets `children.codexModel` to `openai/gpt-5.5` and sends a follow-up to the session of a Codex run
- **THEN** the follow-up loads its session and gets the model `gpt-5.5` before the prompt

#### Scenario: A new task
- **WHEN** `children.codexModel` is `openai/gpt-5.5` and a new task goes to `codex`
- **THEN** the Codex child gets the model `gpt-5.5` before the prompt

### Requirement: Refused Codex model
The adapter `@agentclientprotocol/codex-acp` 2.6.0 takes the model in `applyModelChange`, keeps the reasoning level when the model supports it, and sends the model with each `turn/start`. It refuses a model that is not in its model list with the JSON-RPC error `invalidParams`. The run MUST then fail before the prompt, with a message that names the value, and with no continuation.

Tests: `test/child-settings.test.mjs`

#### Scenario: A model that the agent does not have
- **WHEN** `children.codexModel` is `openai/gpt-unknown-9` and the Codex agent has only the model `gpt-5.5`
- **THEN** the run ends as `interrupted` with a message that names `openai/gpt-unknown-9`, the child gets no prompt, and the run gets no continuation

### Requirement: Scope of the Codex model
The setting `children.codexModel` MUST NOT change a Claude child or a pi child. A change MUST apply to the next Codex child: a new task, a follow-up and a continuation. A `settings.json` without the key MUST open with `inherit`. A daemon of v0.3.0 MUST open a `settings.json` with the key, ignore the key, and keep it when it writes the file. v0.2.0 wrote no `settings.json`.

Tests: `test/child-settings.test.mjs`, `test/project-settings.test.mjs`

#### Scenario: A Claude child
- **WHEN** `children.codexModel` is `openai/gpt-5.5` and a task goes to `claude`
- **THEN** the Claude child gets no model request and only its mode

#### Scenario: A file without the key
- **WHEN** `settings.json` has values but no key `children.codexModel`
- **THEN** the setting has the value `inherit` with the source `default`

#### Scenario: A daemon of v0.3.0
- **WHEN** this build stores `children.codexModel` as `openai/gpt-5.5`, and a daemon of v0.3.0 opens the file and sets `children.commit` to `deny`
- **THEN** the daemon of v0.3.0 shows no setting `children.codexModel`, and the file keeps `children.codexModel` with the new value of `children.commit`

### Requirement: Codex model in the rules of the main agent
The rules of the main agent MUST give the value of `children.codexModel`, say that `inherit` leaves the model to the configuration of Codex, and that a refused model fails the task before its start.

Tests: `test/child-settings.test.mjs`

#### Scenario: The default and a changed value
- **WHEN** `children.codexModel` is `inherit`, and a turn then sets it to `openai/gpt-5.5`
- **THEN** the section `settings` of the main agent first says that a Codex child uses the model `inherit` and that `inherit` leaves it to the configuration of Codex, and then gives the model `openai/gpt-5.5`

### Requirement: Time limit of a child run
The setting `children.timeoutMinutes` MUST give the time limit of a Claude, Codex or pi child run in minutes, from 0 to 1440, with the default 240. The value 0 MUST give no limit. Each run MUST take the value of its directory at its start, and a change MUST NOT change the limit of a run that runs. A pi run MUST keep its limit through a restart of the daemon.

Tests: `test/settings.test.mjs`, `test/parallel.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: Allowed values
- **WHEN** the main agent sets `children.timeoutMinutes` to `0`, ` 120 ` or `1440`
- **THEN** the setting stores `0`, `120` or `1440`, and it refuses `-1`, `1441` and `1.5`

#### Scenario: The value of the directory
- **WHEN** the value is 0.005 minutes in the directory `a` and 0 in the directory `b`, and a run starts in each directory
- **THEN** the run in `a` becomes `interrupted` with a time limit of 0.005 minutes, and the run in `b` still runs 600 ms later

### Requirement: Child sessions in the session list of the project
The setting `children.showInProject` MUST be `true` or `false`, with the default `false`. A new Claude or Codex child session MUST take the value of its directory at its first run. With `true`, that session MUST be no service session, so that Air shows it in the session list of its project.

Tests: `test/settings.test.mjs`, `test/integration.test.mjs`

#### Scenario: Allowed values
- **WHEN** the main agent sets `children.showInProject` to `true` or `false`
- **THEN** the setting stores the value, and it refuses `sometimes` and `2`

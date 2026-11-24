# Spec Delta

## MODIFIED Requirements

### Requirement: Default agent of a child task
The setting `children.agent` MUST select the agent of a new child task without a named agent: `claude`, the default, `codex` or `junie`. It MUST refuse `pi`, because a pi child cannot change code. A follow-up and a continuation MUST stay with the agent of their session. A change MUST apply to the next child task, also in the turn that made it.

Tests: `test/settings.test.mjs`, `test/child-settings.test.mjs`

#### Scenario: The agent of the setting
- **WHEN** `children.agent` is `codex` and the main agent starts the task "first task" without a named agent
- **THEN** the run of "first task" has the agent `codex`

#### Scenario: The value junie
- **WHEN** `children.agent` is `junie` and the main agent starts the task "first task" without a named agent
- **THEN** the run of "first task" has the agent `junie`

#### Scenario: A change in the turn that made it
- **WHEN** a turn sets `children.agent` to `claude`, then starts the task "second task" and sends the follow-up "more" to the session of the `codex` run
- **THEN** "second task" goes to `claude`, and "more" stays with `codex`

#### Scenario: The value pi
- **WHEN** the main agent sets `children.agent` to `pi`
- **THEN** the setting refuses the value

## ADDED Requirements

### Requirement: Values of the Junie model
The setting `children.junieModel` MUST select the model of a Junie child: `inherit`, the default, or a model of Junie as `junie/<model ID>`. A model ID MUST have at most 100 letters, digits, dots, dashes and underscores, and start with a letter or a digit. Each other text and each other provider MUST be refused. The model registry need not know the model, because Junie lists its own models.

Tests: `test/settings.test.mjs`

#### Scenario: Model IDs of Junie
- **WHEN** the main agent sets `children.junieModel` to `junie/claude-opus-5-5`, ` junie/gemini-3.7-flash ` or `junie/gpt-6-astra`
- **THEN** the setting has the value `junie/claude-opus-5-5`, `junie/gemini-3.7-flash` or `junie/gpt-6-astra`

#### Scenario: Another form
- **WHEN** the main agent sets `children.junieModel` to `claude-opus-5-5`, `anthropic/claude-opus-5-5`, `junie/claude opus` or `junie/v1:13:proxy:central:claude-opus-5-5`
- **THEN** the setting refuses the value, and `settings.json` keeps the value from before

### Requirement: Inherited Junie model
With `inherit`, Megachat MUST send no model request to a Junie child. The configuration of Junie then decides the model.

Tests: `test/child-settings.test.mjs`

#### Scenario: No model request
- **WHEN** `children.junieModel` is `inherit` and a Junie child starts the task "first task"
- **THEN** Megachat sends no `session/set_config_option` request, and the run completes

### Requirement: Explicit Junie model
With a model, Megachat MUST find it in the model list of the session: the options of the config option `model` that the session gave last before the prompt, in the answer of `session/new` or `session/load` or in a `config_option_update`, also in a group. It MUST take the first option whose value is the model ID or ends with `:` and the model ID, and send that value in a `session/set_config_option` request with the `configId` `model` before the prompt.

Tests: `test/child-settings.test.mjs`

#### Scenario: A new task
- **WHEN** `children.junieModel` is `junie/claude-opus-5-5`, and the model list of the session holds `v1:13:proxy:central:gemini-3.7-flash` and `v1:13:proxy:central:claude-opus-5-5` in the group `proxy:central`
- **THEN** the Junie child gets the model `v1:13:proxy:central:claude-opus-5-5` before the prompt

#### Scenario: A follow-up after a change
- **WHEN** a turn sets `children.junieModel` to `junie/claude-opus-5-5` and sends a follow-up to the session of a Junie run
- **THEN** the follow-up loads its session and gets the model `v1:13:proxy:central:claude-opus-5-5` before the prompt

#### Scenario: A model ID that starts another model ID
- **WHEN** `children.junieModel` is `junie/claude-opus-5`, and the model list of the session holds `v1:13:proxy:central:claude-opus-5-5` before `v1:13:proxy:central:claude-opus-5`
- **THEN** the Junie child gets the model `v1:13:proxy:central:claude-opus-5` before the prompt

### Requirement: Refused Junie model
When the model list of the session has no option for the model, or Junie refuses the request, the run MUST fail before the prompt, with a message that names the value of the setting, and with no continuation.

Tests: `test/child-settings.test.mjs`

#### Scenario: A model that Junie does not have
- **WHEN** `children.junieModel` is `junie/gpt-unknown-9`, and the model list of the session holds only `v1:13:proxy:central:claude-opus-5-5`
- **THEN** the run ends as `interrupted` with a message that names `junie/gpt-unknown-9`, the child gets no model request and no prompt, and the run gets no continuation

### Requirement: Scope of the Junie model
The setting `children.junieModel` MUST NOT change a Claude child, a Codex child or a pi child. A change MUST apply to the next Junie child: a new task, a follow-up and a continuation. A `settings.json` without the key MUST open with `inherit`. The setting MUST be able to have a project value (see the capability `project-settings`).

Tests: `test/child-settings.test.mjs`, `test/project-settings.test.mjs`

#### Scenario: A Codex child
- **WHEN** `children.junieModel` is `junie/claude-opus-5-5` and a task goes to `codex`
- **THEN** the Codex child gets no model request

#### Scenario: A file without the key
- **WHEN** `settings.json` has values but no key `children.junieModel`
- **THEN** the setting has the value `inherit` with the source `default`

#### Scenario: A project value
- **WHEN** the project `app` has the value `junie/claude-opus-5-5` of `children.junieModel`, the global value is `inherit`, and a Junie child runs in `app` and another one in `lib`
- **THEN** the child in `app` gets a model request, and the child in `lib` gets none

### Requirement: Junie model in the rules of the main agent
The rules of the main agent MUST give the value of `children.junieModel`, say that `inherit` leaves the model to the configuration of Junie, that a refused model fails the task before its start, and that Megachat sends no mode to a Junie child, so the settings of Junie decide when the child asks for a permission.

Tests: `test/child-settings.test.mjs`

#### Scenario: The default and a changed value
- **WHEN** `children.junieModel` is `inherit`, and a turn then sets it to `junie/claude-opus-5-5`
- **THEN** the section `settings` of the main agent first says that a Junie child uses the model `inherit` and that `inherit` leaves it to the configuration of Junie, and then gives the model `junie/claude-opus-5-5`

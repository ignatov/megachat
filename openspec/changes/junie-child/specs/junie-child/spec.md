# Spec Delta

## Purpose

The main agent can give a task to Junie. A Junie child is the command `junie` of the user in its ACP mode, on the route of Central, and its run follows the rules of a Codex child run.

## ADDED Requirements

### Requirement: Start of a Junie child
A Junie child MUST start as `central run junie -- --acp=true` in the directory of the run, with the Central command of Megachat. Central then starts the first `junie` on the `PATH` of the child. Megachat MUST NOT install Junie, and it MUST NOT start `junie` without Central.

Tests: `test/launch.test.mjs`, `test/integration.test.mjs`

#### Scenario: The command of a Junie child
- **WHEN** the main agent calls `agents_spawn` with the agent `junie` in the project `project`
- **THEN** the daemon starts the Central command with the arguments `run`, `junie`, `--` and `--acp=true` in the directory of `project`, and the run has the agent `junie`

### Requirement: Environment of a Junie child
A Junie child MUST get the environment of the daemon without each `MEGACHAT_*`, `ANTHROPIC_*`, `CLAUDE_*` and `CLAUDECODE` variable, as a Codex child does (see the capability `launch`). The node that runs Megachat and then the directory of the Central command MUST come first on its `PATH`. Junie then reads its own configuration, and Central gives the route.

Tests: `test/launch.test.mjs`

#### Scenario: The variables of a Junie child
- **WHEN** the daemon has `HTTPS_PROXY`, `JUNIE_DATA`, `MEGACHAT_HOME`, `ANTHROPIC_API_KEY` and `CLAUDE_CONFIG_DIR`, and its `PATH` is `/usr/bin`
- **THEN** the Junie child gets the first two with their values, no `ANTHROPIC_*`, `CLAUDE_*` or `MEGACHAT_*` variable, and a `PATH` of the directory of node, the directory of the Central command and `/usr/bin`

### Requirement: Missing Junie command
When no file `junie` that the user can run is on the `PATH` of a child, a Junie run MUST fail before the start of a process. The error MUST name the command and the two ways out: to install Junie CLI, or to give the task to Claude or Codex. The run MUST get no continuation.

Tests: `test/integration.test.mjs`

#### Scenario: A machine without Junie
- **WHEN** the `PATH` of a child has no `junie`, and the main agent calls `agents_spawn` with the agent `junie`
- **THEN** the run ends as `interrupted` with the error "The command junie is not on the PATH, so Megachat did not start the Junie task. Install Junie CLI, or give the task to Claude or Codex.", Megachat starts no process, and the run gets no continuation

### Requirement: Requests of a Junie child
Megachat MUST send a Junie child no mode request, no value of the config options `mode`, `effort` and `brave_mode`, and no `_meta` of Claude Code. The settings of Junie then decide, also its Brave Mode. The settings `children.permissionMode`, `children.claudeModel` and `children.codexModel` MUST NOT change a Junie child.

Tests: `test/child-settings.test.mjs`

#### Scenario: The settings of the other agents
- **WHEN** `children.permissionMode` is `ask`, `children.claudeModel` is `anthropic/claude-haiku-5-5`, `children.codexModel` is `openai/gpt-5.5`, and a task goes to `junie`
- **THEN** the Junie child gets `session/new` without `_meta`, no mode request and no `session/set_config_option` request, and the run completes

### Requirement: Prompt of a Junie child
The prompt of a Junie child MUST hold the blocks of a Codex child in the same order: the text of the history tools, the rules paragraph of the user (see the capability `child-settings`), the task, and the messages that the user added. It MUST hold no block with the content of `AGENTS.md`, because Junie reads `AGENTS.md` by itself.

Tests: `test/child-settings.test.mjs`

#### Scenario: A project with an AGENTS.md
- **WHEN** the directory of the run has an `AGENTS.md` and no `CLAUDE.md`, and the task "first task" goes to `junie`
- **THEN** the prompt of the Junie child holds the rules paragraph and "first task", and no block of the rules of the repository

### Requirement: Follow-up and continuation of a Junie child
A follow-up and a continuation of a Junie child MUST load the session of the run with `session/load`, as for a Codex child (see the capabilities `delegation` and `run-recovery`). The new run MUST keep the agent `junie` and the child session of the run before it.

Tests: `test/integration.test.mjs`

#### Scenario: A follow-up
- **WHEN** a Junie child completed with the session `fake-session`, and the main agent calls `agents_send` for its child session
- **THEN** the new run has the agent `junie`, and the child loads the session `fake-session`

### Requirement: Message to a Junie child without a running turn
Junie does not read `_meta.steering.idleBehavior`. For a session without a running turn, it starts a turn of its own with the message and answers `startedNewTurn`. Megachat MUST read that answer as a turn that ended first (see the capability `steering`): the message MUST NOT become `delivered`, and the run MUST get a follow-up in its session with the message as a possible repeat.

Tests: `test/integration.test.mjs`

#### Scenario: The answer startedNewTurn
- **WHEN** a Junie child answers `startedNewTurn` to the message "One more file" of `agents_steer`
- **THEN** the tool gives the outcome `followUp`, and a follow-up run with the agent `junie` loads the session of the run and gets "One more file" as a possible repeat

### Requirement: Junie child in Air
The description of the row of a Junie run MUST start with `Junie · `, and the title of its permission request MUST name `Junie`. For a client with `asyncTaskSessions`, the row MUST hold `session` with the `agentId` `junie` (see the capability `chat-view`). A new Junie child session MUST follow `children.showInProject` as a Codex child session does, and its registration MUST have the agent `junie`.

Tests: `test/integration.test.mjs`, `test/transcript.test.mjs`

#### Scenario: The row of a Junie child
- **WHEN** the main agent starts a Junie child with the title `First` in the project `project`, and a view with `asyncTasks` and `asyncTaskSessions` shows the chat
- **THEN** the description of its row is `Junie · project`, and after the agent gave the session `fake-session`, the view gets one `async_task_progress` with `session` with the agent ID `junie` and the session ID `fake-session`

#### Scenario: A hidden Junie session
- **WHEN** `children.showInProject` is `false` for the directory of a new Junie child, and a view with `serviceSessions` shows the chat
- **THEN** the view gets a registration with the agent `junie` and the provider session ID of the run

### Requirement: Rules of a child run for a Junie child
A Junie child run MUST follow the rules of a Codex child run in the capabilities `child-scheduling`, `child-processes`, `steering`, `secrets`, `transcripts`, `failure-handling` and `run-recovery`, and the settings `children.timeoutMinutes`, `children.commit`, `children.push` and `children.daemonRestart`. Its cost MUST NOT be in the spend count (see the capability `spend-limit`).

Tests: `test/integration.test.mjs`, `test/parallel.test.mjs`

#### Scenario: Two tasks in one checkout
- **WHEN** the main agent starts a Junie child and then a Claude child in the same directory
- **THEN** the Claude run stays `admitted` until the Junie run ends

#### Scenario: A stop of a Junie task
- **WHEN** the user stops the row of a Junie run that runs
- **THEN** the child gets `session/cancel`, and the run ends as `cancelled`

# Proposal

## Why

The author wrote on 2026-11-23: "сейчас джуни не поддерживается, только кодекс клод и pi - добавь поддержку" (Junie is
not supported now, only Codex, Claude and pi: add the support). The agent of a child task is `claude`, `codex` or `pi`
(`admitChild` in `src/MegachatState.mjs`), and `children.agent` takes only `claude` or `codex`. A user who works with
Junie cannot give a task to it from Megachat.

Junie can be a child now. A probe on 2026-11-23 with Junie CLI 26.10.5 showed that `junie --acp=true` is an ACP agent
with `loadSession`, with HTTP MCP servers and with the steering extension, which are the three things that a Claude or
Codex child run uses. Central has the route: `central run junie`. `design.md` has the record of the probe.

## What Changes

Where it shows: the chat (the user names Junie, and the main agent starts a Junie child), the task list of Air (the row
of the task says `Junie`), the tools `agents_settings`, `agents_list` and `agents_accounts`, and the command `install`.

- **A Junie child.** `agents_spawn` takes `agent=junie`. The daemon starts `central run junie -- --acp=true` in the
  directory of the task, and it sends the task as it does for a Codex child: the history tools, the rules paragraph of
  the user, then the task. A follow-up (`agents_send`), a message to a running task (`agents_steer`), a cancel, the
  time limit, a permission request and a continuation after a crash work as for a Codex child.
- **The default agent.** `children.agent` takes `junie`, also as a project value. `claude` stays the default.
- **The model.** A new setting `children.junieModel`: `inherit`, the default, or `junie/<model ID>`, for example
  `junie/claude-opus-5-5`. With `inherit`, the configuration of Junie decides. With a model, Megachat selects it in the
  model list of the session before the prompt. A model that the list does not have fails the task before its start.
- **No mode.** Megachat sends no mode and no Brave Mode value to a Junie child. The settings of Junie decide, as the
  configuration of Codex decides for a Codex child. `children.permissionMode`, `children.claudeModel` and
  `children.codexModel` do not change a Junie child.
- **Junie is optional.** Megachat installs no Junie. A Junie child uses the command `junie` of the user. Without it, a
  Junie task fails before its start with a text that says so, `agents_accounts` gives no row for Junie, and `install`
  prints one line. The exit code of `install` does not change.
- **The task row and the session in Air.** The description of the row starts with `Junie · `. The row holds `session`
  with the agent ID `junie` for a client with `asyncTaskSessions`. With `children.showInProject` `false`, Megachat
  records the session with the agent ID `junie`.
- **The texts.** The rules of the main agent and the descriptions of the tools and of the settings name Junie where
  they name Codex as an agent of a task. `README.md` and `docs/air-contract.md` get the same.

ACP extension: no new message, field or capability. The change adds the value `junie` of `agentId` in
`_session/service/record` and in the field `session` of a task row. Air needs no change if its agent ID of Junie is
`junie`: `AcpServiceSessionRequests.kt` of Air takes each agent ID, and `ProductDefaultAgents.kt` names
`AgentId.from("junie")`. The task list has the check with a real Air build, and an IJAI ticket only if the check fails.

Non-goals of the project: the change touches none. A Junie child runs commands and changes files, as a Claude or Codex
child does. The limit of one child in one checkout stays.

## Capabilities

### New Capabilities

- `junie-child`: how a Junie child starts, what its requests and its prompt hold, how Air sees its session, and what
  Megachat does without the command `junie`.

### Modified Capabilities

- `delegation`: "Agent of a delegated task" is MODIFIED: the user can delegate a task to Junie. The text is the one of
  the change `look-first`, which is not in the archive yet.
- `child-settings`: "Default agent of a child task" is MODIFIED: `junie` is a value. The requirements of
  `children.junieModel` are new: its values, `inherit`, a model, a refused model, its scope, and the rules of the main
  agent.
- `project-settings`: "Settings that can have a project value" is MODIFIED: the list holds `children.junieModel`.
- `accounts`: "Account check" is MODIFIED: the check includes Junie when the command `junie` is there.
- `install`: "Line about Junie" is new.

## Out of scope

- The past and running sessions of Junie: the index (`sessions.sqlite`), `agents_sessions`, `session_history`,
  `agents_running`, `agents_archive` and `agents_resume`. The change `junie-sessions` adds them, with a session source
  for `~/.junie/sessions`. Until then, `agents_resume` refuses the agent `junie` as today, and the main agent reads the
  result of a Junie child from its run and its transcript file, not from the session tools.
- A dialog for a question of a child to the user. Megachat announces no elicitation to a child, for each agent. A
  child that needs an answer says so in its result, and the user answers with a follow-up.
- A Junie that npm installs with Megachat, and a variable `MEGACHAT_JUNIE_ACP` for a Junie of the IDE.
- `central add junie` in `setup.sh`. `central run junie` gives the route for one start.
- A setting for the mode (`default`, `plan`), the effort (`low`, `medium`, `high`) or the Brave Mode of Junie.
- A pair with Junie in the first setup question. The user names Junie, or sets `children.agent`.
- The cost of a Junie child in `budget.dailyUsd`. The account of Central pays for it, as for a Claude or Codex child.
- No change of `conversation.sqlite`, and no new file in the state directory.

## Impact

- Code: `src/CentralConfigurationService.mjs` (the launch and the environment), `src/AcpRunService.mjs` (the model, the
  missing command), `src/Settings.mjs` (`children.agent`, `children.junieModel`), `src/MegachatState.mjs` (the agent of
  a run), `src/PiMegachatService.mjs` (`agents_list`, the section `settings`), `src/AgentAccountCheck.mjs`,
  `src/MegachatInstall.mjs`, `src/AcpBridge.mjs` and `src/ChildTranscript.mjs` (the name `Junie`, the session of a row).
- Texts: `resources/Megachat.properties`, `resources/instructions.md`.
- Documents: `README.md`, `docs/air-contract.md`, `docs/manual-checks.md`.
- Tests: `test/fake-acp.mjs` gets a model list as a config option. New cases go to `test/child-settings.test.mjs`,
  `test/settings.test.mjs`, `test/project-settings.test.mjs`, `test/integration.test.mjs`, `test/launch.test.mjs`,
  `test/accounts.test.mjs`, `test/install.test.mjs` and `test/transcript.test.mjs`.
- Dependencies: none. `package.json` does not change.

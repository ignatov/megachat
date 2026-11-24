# Design

## Context

See `proposal.md` for the reason.

`src/AcpRunService.mjs` runs a Claude child and a Codex child. It is an ACP client: `initialize`, `session/new` or
`session/load`, `session/set_config_option`, `session/set_mode`, `session/prompt`, `session/cancel`,
`session/request_permission` and the steering request `_session/steering`. It needs three things from an agent: an
HTTP MCP server for the history tools (else the run fails with `agentHttp`), `loadSession` for a follow-up and a
continuation (else `agentLoad`), and `_meta.steering.supported` for a message to a running task (else the message
waits for the next run). The parts that depend on the agent are few: `childLaunch` of
`src/CentralConfigurationService.mjs`, the options of Claude Code in `session/new`, the model key, the mode, the guard
of the base URL and the `AGENTS.md` block.

The list of the agents is in these places: `CHILD_AGENTS` of `src/Settings.mjs` (`claude`, `codex`), the check of
`admitChild` in `src/MegachatState.mjs` (`claude`, `codex`, `pi`), `agents` of `agents_list` in
`src/PiMegachatService.mjs`, `rowSession` and `agentName` of `src/AcpBridge.mjs`, `agentName` of
`src/ChildTranscript.mjs` and `NAMES` of `src/AgentAccountCheck.mjs`.

### The probe of Junie on 2026-11-23

Junie CLI 26.10.5 (3579.7) on macOS, the command `~/.local/bin/junie`, Central with a login. No prompt went out.

- `junie --acp=true` is an ACP agent on its standard input and output. It writes one line with its log file to its
  error output.
- The answer of `initialize`: `loadSession` true, `mcpCapabilities` `http` and `sse` true, `promptCapabilities.image`
  true, `sessionCapabilities` `fork`, `list`, `resume`, `delete`, `close` and `additionalDirectories`, one
  `authMethods` item `jetbrains-account`, `agentInfo.name` `@jetbrains/junie`, `_meta.steering.supported` true, and
  `_meta.jetbrains.air.capabilities` `nativeSubagentSessions`, `agentFileChangeReport` and `planFile`.
- The answer of `session/new`: a session ID of the form `session-<yymmdd>-<hhmmss>-<4 characters>`, which the pattern
  of `admitChild` for a provider session accepts, and four `configOptions`:
  - `mode`: `default` (the current value) and `plan`.
  - `model`: one group `proxy:central` with 18 options. A value is `v1:13:proxy:central:<model ID>`, for example
    `v1:13:proxy:central:claude-opus-5-5`, `...:gpt-6-astra`, `...:gemini-3.7-flash` (the current value) and
    `...:grok-4.7`. `13` is the count of the characters of `proxy:central`: `~/.junie/settings.json` of the same
    machine holds an `acpLastSelectedModel` of another route, whose name has 15 characters, and that value starts with
    `v1:15:`. So the start of a value depends on the machine, and its end is the model ID.
  - `effort`: `low`, `medium` (the current value) and `high`.
  - `brave_mode`: `brave-auto` ("Auto"), `on` ("Brave", runs each command without a question) and `off` ("Safe"). The
    current value was `on`, from `braveMode` of `~/.junie/settings.json`.
- After the answer, Junie sent `available_commands_update` and `config_option_update` with the same four options.
- `central agents` gave "Junie: installed · configured" on this machine, and `~/.junie/config.json` holds the provider
  `central` with a proxy at `127.0.0.1`. `central run junie -- --acp=true` started the first `junie` of the `PATH`
  with the one argument `--acp=true` and with no new variable. A test command at the start of the `PATH` took the
  call, so Central finds `junie` on the `PATH`.
- Not in the probe: `session/load`, `session/set_config_option`, a prompt, a permission request, the steering request,
  a directory that Junie does not trust, and `central run junie` on a machine without `central add junie`. The first
  group of `tasks.md` checks them. "The checks of 2026-11-23" below gives their results.
- A side effect: the probe asked for `session/new` and then for `session/delete` of that session.
  `~/.junie/sessions` had 205 entries before the probe and 204 after it. The log of Junie names only the delete of
  the probe session. Nobody found which other entry left. So no check of this change sends `session/delete`, and each
  check with the real Junie compares a list of that folder from before and after.

### The checks of 2026-11-23

The first group of `tasks.md` ran on the same day, after the code and before the real run. `docs/manual-checks.md`
holds the record. What the checks changed:

- `session/load` gives `configOptions` in its answer, and a `config_option_update` after it. So a follow-up finds the
  model list, as decision 4 needs.
- Junie takes only a value of its list in `session/set_config_option`: it refuses a bare model ID and an unknown
  value with the error -32602. The request does not change `acpLastSelectedModel` of `~/.junie/settings.json`, so
  `children.junieModel` does not change the model of the other clients of Junie.
- A `brave_mode` request changes `braveMode` of `~/.junie/settings.json` for each later session of the user. This is
  one more reason for decision 5: Megachat sends no such request.
- The permission request has the standard shape, with the option IDs `Yes`, `No` and `Always allow ("<pattern>")`.
  Junie asks no question about the trust of a new directory.
- A Junie child asks the user no question through the client: it writes the question in its reply and ends the turn.
- `_session/steering` gives `injected` during a turn. Without a running turn, Junie starts a turn of its own and
  answers `startedNewTurn`: it does not read `idleBehavior`. The run service already reads that answer as a turn that
  ended first. The new requirement "Message to a Junie child without a running turn" states it, with a test.
- `session/new` without a prompt leaves a folder with one small file in `~/.junie/sessions`, and no line in
  `index.jsonl`, so Air lists no session. So each account check of Junie leaves one such folder (decision 6). The
  author decides whether the check keeps `session/new`.

## Goals / Non-Goals

**Goals:**

- A Junie child is one more agent of `AcpRunService`, with the code paths of a Codex child. No second run service.
- Each request of a Junie child goes through Central.
- A machine without Junie sees no change but one line of `install`.

**Non-Goals:**

- A source of the sessions of Junie. The change `junie-sessions` adds it.
- A control of the Brave Mode, of the mode or of the effort of Junie.

## Decisions

### 1. `central run junie -- --acp=true`

`childLaunch('junie')` gives the Central command with the arguments `run`, `junie`, `--`, `--acp=true`. This is the
launch of a Codex child without the shim `bin/codex`: Codex needs the shim because the Codex ACP is an adapter that
starts `codex`, and Junie is its own ACP agent.

- Alternative: `junie --acp=true` without Central. Then the route depends on `central add junie`, and a Junie with
  another login sends its requests past Central. Refused: all model traffic goes through Central.
- Alternative: a variable `MEGACHAT_JUNIE_ACP` for a Junie of the IDE, as `MEGACHAT_CODEX_ACP`. Air passes no such
  variable today. Later, when Air needs it.

### 2. The command of the user, and a check before the start

Megachat adds no dependency. A function `junieOnPath` gives the first file `junie` that the user can run on the
`PATH` of a child: the directory of node, the directory of the Central command, then the `PATH` of the daemon. It
skips a directory that npm adds, as `codexOnPath` of `src/MegachatInstall.mjs` does. The function is in
`src/CentralConfigurationService.mjs`, and the run, the account check and `install` use it.

`childLaunch('junie')` throws `MegachatError('junieMissing')` without the command. A `MegachatError` gives a run that
ends as `interrupted` with its text and with `autoResume` false, so the run gets no continuation. No new code in
`execute`.

- Alternative: let `central run junie` fail. Then the run ends with "The agent process ended with the exit code ...",
  and it gets continuations that fail the same way.
- Alternative: an npm package of Junie as a dependency. `npm run test:package` installs about 870 MB already, and
  the installer of Junie puts the command in `~/.local/bin`, where Megachat looks.

### 3. The environment of a Codex child

`childLaunch('junie')` uses `codexEnvironment()`: the environment of the daemon without `MEGACHAT_*`, `ANTHROPIC_*`,
`CLAUDE_*` and `CLAUDECODE`. A variable of Claude Code can hold the key of Central for Claude, and Junie has a mode
with a key of the user for Anthropic. The `PATH` has no `bin` directory of Megachat, because Junie needs no shim.

### 4. The setting `children.junieModel` with a lookup in the model list

The value is `inherit` or `junie/<model ID>`. The model ID has the pattern of `children.codexModel`:
`^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$`. `junie` is no provider of the model registry: the models of Junie are of
Anthropic, OpenAI, Google and xAI, and the prefix says that the list of Junie decides.

The value of an option depends on the machine (see the probe). So `AcpRunService` keeps the last `model` option of the
session: from `configOptions` of the answer of `session/new` or `session/load`, and from a `config_option_update` that
comes before the prompt. The service already reads that update before the dispatch. With a model, it takes the first
option, also in a group, whose `value` is the model ID or ends with `:<model ID>`, and it sends `value` in
`session/set_config_option` with the `configId` `model`. Without such an option, and for an error answer, the run fails
with `MegachatError('childJunieModel', <value of the setting>)`, as `childCodexModel` does.

- Alternative: the value of the option as the value of the setting. It is long, and it changes with the proxy name.
- Alternative: no setting. Then the model of a Junie child is the one that another ACP client selected last, for
  example the Junie chat of Air. On the probe machine that was Gemini 3.7 Flash.
- Alternative: send the model ID and let Junie refuse it, as for Codex. Junie takes only a value of its list.

### 5. No mode, and the Brave Mode of the user

Megachat sends no `session/set_mode` and no `mode`, `effort` or `brave_mode` option. This is the rule of a Codex
child: its configuration decides, also its approval policy. A Junie child with `brave_mode` `off` or `brave-auto`
sends `session/request_permission`, and the present code shows the request to the user and removes each option whose
ID holds "bypass".

- Alternative: `children.permissionMode` gives the Brave Mode (`ask` gives `off`, `auto` gives `brave-auto`). The
  setting is of Claude Code by its spec, and its values `allowEdits` and `inherit` have no clear value of Junie. A
  later change can add a setting of its own.
- Alternative: Megachat always sends `brave_mode` `brave-auto`. It overrides the choice of the user without a setting.

The rules of the main agent say that the settings of Junie decide (the text `instructions.junie`).

### 6. The account check only with the command

`checkAccounts` checks `CHILD_AGENTS` today. It will check `claude`, `codex`, and `junie` only when `junieOnPath`
gives a path. So the setup, which shows each agent with a problem, says nothing about Junie to a user without Junie.
The check of Junie asks for `initialize` and `session/new`, as for the other agents, and it sends no
`session/delete`.

### 7. The agent ID `junie` for Air

`rowSession` gives a session for `claude`, `codex` and `junie`. `serviceSession` of a run is already true for each
agent but `pi`, so a Junie run with `children.showInProject` `false` gets a record with `agentId` `junie`. Air takes
each agent ID in `_session/service/record` (`AcpServiceSessionRequests.kt`), and its ID of Junie is `junie`
(`ProductDefaultAgents.kt`). The manual check of group 8 verifies it in a real build.

### 8. `agents_resume` stays without Junie in this change

`agents_resume` reads the session through `SessionHistoryService` first, and that service has no provider `junie`.
The call fails with the code `invalid`, as today. The change `junie-sessions` adds the source of the sessions of
Junie, and with it the continue of a session of the user. This change has no requirement about `agents_resume`, so
that change needs no delta of a requirement of this one.

### 8a. No elicitation for a child

`AcpRunService` sends empty `clientCapabilities`, so a child gets no form elicitation, for each agent. The probe
found that a Junie session can ask the user a question (`AskAsyncRequestUpdatedEvent` in its event log). Task 1.3
records what a Junie child does with a question when the client announces no elicitation. A dialog for such a
question is a change of its own, for each agent.

### 9. The state, the settings file and the ACP messages

- **The admitted work.** A Junie run is a run of the durable state, as a Codex run: `runs[<id>]` with `agent`
  `junie`. A disconnect of the ACP client changes nothing, because the daemon runs the child. After a crash or a
  restart of the daemon, the run gets a continuation that loads `providerSessionId` with `session/load` and gets the
  continuation prompt (see the capability `run-recovery`).
- **`conversation.sqlite`.** No new field. The field `agent` of a run gets the new value `junie`. A daemon of an
  earlier build that opens a state with an unfinished Junie run fails that run, because its `childLaunch` knows no
  `junie`.
- **`settings.json`.** The new key `children.junieModel` in `values` and in the project values. A file without the
  key opens with `inherit`. `children.agent` gets the new value `junie`. An earlier build ignores a stored value that
  it does not accept and keeps the key in the file, as for `children.codexModel`.
- **ACP, as a client of Junie.** Megachat reads `configOptions` of the answers of `session/new` and `session/load`, the
  update `config_option_update`, and `_meta.steering.supported` of `initialize`. It sends
  `session/set_config_option` with the `configId` `model`.
- **ACP, as an agent of Air.** The value `junie` of `agentId` in `_session/service/record` and in `session` of
  `async_task_spawned` and `async_task_progress`. No new `_meta` key.

## Risks / Trade-offs

- [A Junie child with Brave Mode `on` runs each command without a question] → The rules paragraph of
  `children.commit`, `children.push` and `children.daemonRestart` is in its prompt, as for a Codex child. The rules of
  the main agent and `README.md` say that the settings of Junie decide.
- [`session/load` gives no `configOptions`, so a follow-up finds no model list] → Task 1.2 found that the answer
  holds them. The service also keeps the last `config_option_update`. Without a list, the run fails with the text of
  `childJunieModel`, and it sends no prompt.
- [A model request of Megachat changes `acpLastSelectedModel` of `~/.junie/settings.json`, and so the model of the
  other ACP clients of Junie, such as the Junie chat of Air] → Task 1.2 found no change of that key.
- [A variable of the user, such as a key of OpenAI, sends Junie past Central] → `central run junie` gives the route.
  Task 1.5 reads the request log of Central after a Junie run.
- [Central puts the route in the command line of Junie on a machine without `central add junie`, where each local
  user can read it] → Task 1.6 checks it. `README.md` then gives the result, as it does for `central add codex`.
- [Junie starts a turn of its own for a steering request without a running turn] → Megachat sends the request only
  while its prompt runs. For the answer `startedNewTurn`, the message stays `pending`, the end of the run stops the
  process of Junie, and a follow-up sends the message as a possible repeat. The session of Junie then holds the
  message two times.
- [Junie asks to trust a new directory, and the child waits] → Task 1.3 found no such question. The time limit of the
  run stops a child that waits.
- [The processes of a Junie run are not in its process group] → The supervisor reads the process table for each run
  (see the capability `child-processes`). Task 8.1 stops a Junie child that runs a command.
- [The account check leaves an empty session of Junie] → Task 1.1 found that `session/new` writes a folder with one
  file of 21 bytes, which Air does not list. The check keeps `session/new`, because only that request tells a missing
  login. The author can change it to `initialize` only.
- [Two changes modify "Agent of a delegated task"] → The delta builds on the text of `look-first`. Archive
  `look-first` first.

## Migration Plan

No migration. A state directory and a `settings.json` of an earlier build open as they are. To go back, set
`children.agent` to `claude` or `codex` and wait for the end of each Junie run before the start of an earlier build.

## Open Questions

- Which install command of Junie CLI the texts name. The texts of this change say "install Junie CLI" and name no
  command. Task 6.3 adds the command of the documentation of Junie to `README.md`.

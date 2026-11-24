# Manual checks

This file records the manual checks of Megachat. Each record is a measurement, not a requirement.

One manual check of `agents_steer` ran on 2026-11-12 against `@agentclientprotocol/claude-agent-acp` 0.102.0 and
`@agentclientprotocol/codex-acp` 2.6.0, with a fake main agent, the Central configuration of the children, and a new
temporary project. The task was a shell command of some seconds, then a file with the word that the user gives. A steer
in the mode `queue` gave the word during the command.

- Both `initialize` answers gave `_meta.steering.supported: true`. Both steering requests gave `injected`.
- Claude: the child wrote the steered word. The running shell tool call was not lost: it ended with `completed` after
  the full time of the command, and the next tool call wrote the file. So the Claude priority `now` did not stop the tool
  call here. The first `session/prompt` ended after the steered work, with `end_turn`.
- Codex: the child named the steered word in its reply. The first `session/prompt` ended after that reply, with
  `end_turn`. The shell tool of Codex failed on that machine, before and after the steer, so the file was not written,
  and the check could not tell whether a steer stops a running Codex tool call.
- Neither adapter gave the steered message in `session/update` on the protocol version 1: no `user_message_chunk`.
- The check did not try a steer at the end of a turn. The Codex adapter says that a turn can end before Codex reads an
  injected message, and that it then drops the message. The fake agent tests that case.

One manual check of the reply stream ran on 2026-11-12 against Claude Opus 5.5 through Central, with the reasoning level
`low` and a temporary state directory. It recorded the provider events, the partial reply in `pi.live`, the `stream`
events of the daemon and the ACP chunks. The fake API in `test/stream.test.mjs` gives the event order of the first item.

- With the display `summarized`, the thinking block opened about 1.5 s after the request, and no event followed while the
  model thought. Then the summary, the signature and the text that the model wrote in the meantime arrived in one burst:
  100 to 250 characters, or the whole reply when it was short. A reply of 121 characters arrived 30 ms before the end of
  its response, so the chat got it as one chunk. With the display `omitted`, the first burst held 3 to 6 characters, and
  the text after it came as the model wrote it.
- When the request held a tool result, Claude Opus 5.5 sent the whole text of the reply in the last 10 ms of the
  response, with each display. Claude Sonnet 5.5 did the same with the display `summarized`. Without a thinking block,
  the response itself started only at its end. A direct request through pi-ai, without Pi Durable and the daemon, gave the same result, so the cause is not in
  Megachat. Central streamed the same request for Claude Opus 5, Claude Sonnet 5 and Claude Haiku 5.5, so the cause is
  probably in the provider. It agrees with the documented change of Claude Opus 5.5 and Claude Sonnet 5.5: their text
  between tool calls becomes a thinking block, so the API cannot send a text before it knows that no tool call follows.
  So the reply after a tool call of the main agent arrives as one chunk. Each display, a request without each beta of
  pi-ai, and a request without the effort messages gave the same result.

One manual check of a Claude child with the mode `bypassPermissions` in the settings of Claude Code ran on 2026-11-12
with the adapter `@agentclientprotocol/claude-agent-acp` 0.102.0 and `children.permissionMode` `inherit`. The capability
`child-settings` gives the rule.

- With `permissions.defaultMode: "bypassPermissions"` in `~/.claude/settings.json` of the user, the Claude child started
  in the mode `default`, with no error.
- A load of a transcript in `bypassPermissions` continued in the mode `default`.

One manual check of the processes of a child run ran on 2026-11-12 at `c40c45e`, with stand-in processes and no
provider: a stand-in daemon with the lifetime pipe, the real `src/child-supervisor.mjs`, a stand-in adapter, a stand-in
of Claude Code in the process group of the adapter, and a `/bin/zsh` with `detached: true` that ran `sleep 300`, as the
Bash tool of Claude Code 0.3.321 starts its shell (`detached:to.detached`). Each signal went to a PID that the probe
started and recorded.

- The shell and its `sleep` survived each end of the run: the kill of `AcpRunService` (a deadline, a limit, the
  escalation of a cancel, a completed run, a stop of the daemon), a cancel that the agent did not handle, a SIGKILL of
  the daemon, a crash of the adapter, and a crash of Claude Code. After a crash or a loss, the shell had the parent PID 1.
- Only a cancel that the agent handled as the code of Claude Code does, with SIGTERM to the process group of the shell,
  ended them.
- `zsh -c 'sleep 30 >/dev/null 2>&1 & echo $!'` lived 10.1 ms. Its `sleep` then had the parent PID 1 and the process
  group of the dead shell.
- `ps -E -ww` gave the environment of a Node.js process and of `/usr/bin/python3`, but not of `/bin/zsh` and
  `/bin/sleep`.
- One read of `ps -A -o pid=,ppid=,pgid=,uid=,lstart=` of 1,254 processes took about 40 ms and 4 ms of CPU time. Under a
  load average of about 100, one read took up to 1.15 seconds.

One manual check of a stopped turn ran on 2026-11-13 against the default main model through Central, with a temporary
state directory and an ACP client that sends what Air sends. The user sent "Write a 600-word essay about queues. No
tools.", sent `session/cancel` after 6 seconds, and then sent "Count from 1 to 5 in words."

- Before the change, a run of the same steps on `origin/main` gave the whole essay, about 3,600 characters, and then
  "One, two, three, four, five." in the second reply.
- After the change, the stopped turn ended with `cancelled` and 985 characters of partial text in the chat. The second
  reply was "One, two, three, four, five.", 28 characters, with `end_turn`. The conversation had the entry
  `air.megachat.stopped` with the marker after the `aborted` entry of the partial reply. The run cost 0.0051 USD.

One manual check of the project names of tokprof ran on 2026-11-13 with tokprof 0.1.6 and synthetic Claude logs in a
temporary home directory (`HOME`, `TMPDIR` and `TOKPROF_CACHE_DIR` in the directory of the check). The home held a git
repository `~/src/demo-app` with a linked worktree `~/src/demo-app-wt`, and a folder `~/plain/notes` that is no
repository. `tokprof flame --stack agent,project,origin --value cost` gave these project frames:

- A session in `~/src/demo-app/server` gave `~/src/demo-app`: the root of its repository.
- A session in `~/src/demo-app-wt/web` gave `~/src/demo-app`: the main repository of the worktree.
- A session in `~/plain/notes/sub` gave `~/plain/notes/sub`: the folder itself.
- On the machine of the author, the sessions in the leases of Branch Deck of a repository also had the frame of the main
  repository. `place.rs` of tokprof gives the same rules.

So the tokprof part of the morning report counts a session in a subdirectory of a known repository, and in a worktree of
a known repository. A listed worktree and a listed subdirectory of a repository show no cost.

One manual check of the data of the morning report (change `limit-report-to-known-projects`) ran on 2026-11-13 with
tokprof 0.1.6 on `PATH`, the real logs of the machine, and `collectReportData` with a temporary state directory. The
state listed one known repository and held one child run of the period in it. The tokprof run took 5.6 seconds.

- The tokprof part named only that repository, gave no agent and no project of the other work, and had `otherWork`
  `notShown`.
- `tokprof flame --project <repository> --stack agent,project --value cost` for the same period gave the same cost, to
  the cent.

One local probe of a stalled start (change `first-start-feedback`) ran on 2026-11-13 with git 2.50.1 (Apple Git-155)
and npm 11.19.0. A Node.js server on `127.0.0.1` accepted each connection, read the input and never answered. No request
left the machine.

| Command | Variables | Result |
| --- | --- | --- |
| `git ls-remote http://127.0.0.1:<port>/megachat.git` | `GIT_HTTP_LOW_SPEED_LIMIT=1000`, `GIT_HTTP_LOW_SPEED_TIME=5` | exit code 128 after 5.3 s, "Operation too slow. Less than 1000 bytes/sec transferred the last 5 seconds" |
| the same | none | no end in 45 s (the probe stopped it) |
| `git ls-remote https://github.com/ignatov/megachat.git` with `https_proxy` set to the server | the two variables, time 5 | no end in 45 s |
| the same | none | no end in 45 s |
| `npm view semver version` with `NPM_CONFIG_HTTPS_PROXY` set to the server and a temporary cache | `NPM_CONFIG_FETCH_TIMEOUT=5000`, `NPM_CONFIG_FETCH_RETRIES=0` | no end in 45 s |

- The low speed limit of git applies after the connection, when git waits for the answer to its request. It does not
  apply while git waits for the answer of a proxy to `CONNECT`. git has no setting for the connect time of HTTPS, and
  the time limit of npm does not apply there either.
- With the values of the entry (time 20), the case of `test/install.test.mjs` ended after 20.1 s with the exit code 128
  and "Operation too slow".

One measurement of the npx cache (change `automatic-update`, task 1.1) ran on 2026-11-13 with npm 11.19.0, Node.js
26.7.0, a temporary npm cache and a local bare git repository, with the spec `#semver:x`. The test added the tags
v1.1.0 to v1.4.0 one after the other, and started the entry after each tag.

- Each next start ran the new tag: without a flag, with `--prefer-offline` and with `--prefer-online`.
- The reason is in npm. `missingFromTree` of `libnpmexec/lib/index.js` asks pacote for the manifest of a spec that is
  not of the registry at each start. It uses the `_npx` copy only when `node.package.resolved` is equal to the
  `_resolved` of that manifest, else it installs again. `pacote/lib/git.js` resolves the range with `git ls-remote` each
  time. The cache of that answer in `@npmcli/git/lib/revs.js` lives only in the process, for 5 minutes.
- The key of the directory `_npx/<hash>` is a hash of the spec text only. So each release installs into the same
  directory, and npm replaces the files in place. A running process that loads a file late gets the file of the new
  release.
- Without the network, the entry ended with the exit code 128 and no output, also with a full cache.

So the entry of `install` stays as it is: the next start after an automatic stop installs the new release.

One manual check of the fallback models ran on 2026-11-13 against Claude Fable 5.2 through Central, with the reasoning
level `low` and a temporary state directory. Before the fix, each turn with `claude-fable-5-2` failed in about 0.4 s with
the HTTP status 400 and the error "Anthropic proxy does not support fallback field". The check sent one request "Reply
with OK" through `CentralConfigurationService.models()`.

- The request body had no field `fallbacks`, and the header `anthropic-beta` had no `server-side-fallback-2026-07-01`.
- The response ended with the stop reason `stop` and the text "OK", after 4.8 s, with 14 input tokens and 4 output
  tokens.

One manual check of the binaries that npm installed with the agents ran on 2026-11-13 on macOS arm64, with the Central
CLI of that day, `@agentclientprotocol/codex-acp` 2.6.0 with `@openai/codex` 0.166.0, and
`@anthropic-ai/claude-agent-sdk` 0.3.321. No check printed a key or a base URL.

- The bundled `claude` binary, with an empty `HOME` and the base URL and the key of `central run pi`, answered `ok` to
  `-p` with the model `claude-haiku-4-5`. So the route of pi in Central serves the requests of Claude Code. Its base URL
  has the path `/wire/<key>/pi/anthropic`, and the base URL of the entry of `central add claude-code` has
  `/wire/<key>/claude-code/anthropic`, with another key.
- The bundled `codex`, behind `central run codex -- exec`, with an empty `CODEX_HOME` and no other `codex` on the
  `PATH`, answered `ok`. Central does not ask the binary for its version. With an empty `CODEX_HOME`, Central passes
  `--profile jetbrains-central` and four `-c` options with the route, and writes `jetbrains-central.config.toml`, which
  only turns on its plugin. With `central add codex`, Central passes no argument.
- The bundled `codex app-server` answered `thread/list` of the Codex history with an empty `CODEX_HOME`.
- A Codex child as Megachat starts it: `central run codex --` with `bin/` first on the `PATH`, no other `codex`, and an
  empty `CODEX_HOME`. The first run failed: Codex refused `--profile` for `app-server`, before and after the
  subcommand. After the shim left out the profile before `app-server`, the child answered `ok` with `end_turn` in
  3 seconds, and the process of the app-server was `@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`.
  The Codex history through `codexAppServerLaunch()` then listed the session of that child.
- Without `central add codex`, the base URL of Central with its key is in the command line of the Codex process.
- `central agents --json` finds Claude Code only as `claude` on the `PATH`, and reports `installed` apart from
  `configured`.

One manual check of Central ran on 2026-11-13 on a clean macOS 26.6.2 virtual machine with Central 2.5.0 and no
Claude Code.

- `central add claude-code` exited with 0 and printed "Claude Agent configured via port 19516". `central agents` showed
  "Claude Agent  not installed · configured". The command wrote `apiKeyHelper` and `env.ANTHROPIC_BASE_URL` into
  `~/.claude/settings.json`, and a backup `settings.json.<time>.backup`. Without a login it printed "not logged in —
  run 'central login' first" and exited with 1.
- The key helper is `central proxy start --ensure-updated --caller agent --return-key`. With
  `PATH=/bin:/usr/bin:/usr/sbin:/usr/local/bin:/opt/homebrew/bin` it exited with 127 and gave no key. With
  `~/.local/bin` on the `PATH` it exited with 0 and printed a key of 32 characters. The installer of Central does not
  add `~/.local/bin` to the `PATH`.
- `central status` exited with 0 also without a login. Its text then held "Auth  not connected".

A run of `setup.sh` on the same kind of virtual machine on 2026-11-13 passed each step. On its first run, directly
after `central login` and `central add claude-code`, `install` said that a Claude child gets its key from the pi route
of Central, and printed the fallback log line with the frames of the stack and `signal=SIGTERM`. The key helper did
not end in the time limit of 10 seconds of that build, because it started the proxy and checked for an update of
Central. Later runs of the key helper took 1 to 2 seconds, also with the proxy stopped first. So the time limit is now
60 seconds, and `install` writes no log line.

One manual check of the settings of the children (`children-read-agent-settings`) ran on 2026-11-13 on macOS arm64
with `@anthropic-ai/claude-agent-sdk` 0.3.321, without a daemon and with a temporary `MEGACHAT_HOME`. A script started
each agent with `CentralConfigurationService.childLaunch()` in an empty temporary directory and asked it, with no tool,
to quote the instructions file of the user from its context. No check printed a key or a base URL.

- A Claude child with `settingSources: ["user", "project", "local"]` quoted the first line of `~/.claude/CLAUDE.md`.
  With `["project"]`, the same prompt gave `NONE`. The guard read the source `user`, whose `ANTHROPIC_BASE_URL` is the
  Central entry, and it did not refuse the child.
- A Codex child through `central run codex --` quoted the first words of `~/.codex/AGENTS.md`. Its environment had no
  `ANTHROPIC_*` and no `CLAUDE_*` variable.

One manual check of the texts of a failure of Central (`name-central-failure`) ran on 2026-11-13 on macOS arm64 with
Central 2.6.0. Each run had a new temporary `HOME` and a temporary `MEGACHAT_HOME`, so it did not touch the login of
the user. A script sent "Hello" through the daemon service and the ACP bridge, with the Central command at
`~/.local/bin/central` of the temporary `HOME`.

- A copy of the Central command in a temporary `HOME` that never had a login: `central run pi` exited with 1 after
  1.2 s. Its standard output was empty, and its error output was "not logged in — run 'central login' first". The
  command wrote `~/.jetbrains-central` and `~/Library/Caches/jetbrains-central` in the temporary `HOME`, and it left
  no process. The chat showed the text of `central_command`: "JetBrains Central gave Megachat no configuration. Run
  `central login` in a terminal. When you are logged in, run `central repair`. Then send the message again."
- A temporary `HOME` without the Central command: the chat showed the text of `central_missing`: "Megachat cannot find
  the JetBrains Central CLI at ~/.local/bin/central. Install it, run `central login` in a terminal, and then send the
  message again."
- The check did not run `central logout`, and it did not try an expired login. See the open checks.

One manual check of the cloud sessions ran on 2026-11-17 against Central with the plugin `airc` 0.1.3 on the machine of
the author, without a daemon. A script called `locateAirc` and `readCloudSessions` of `src/CloudSessions.mjs` with the
real `~/.local/bin/central` and the `PATH` of Central first. It printed only the counts, the statuses and the field
names, and no name, ID or repository of a session.

- `central plugins` took 0.6 s. `locateAirc` found the binary `~/.jetbrains-central/plugins/airc/airc` in 0.4 s.
- `airc sessions --limit 50` took 0.8 s and gave 50 sessions: 36 `ARCHIVED`, 11 `SUSPENDED`, 2 `FINISHED` and 1
  `LAUNCHING`. Each session had `id`, `name`, `status`, `agent`, `repositories` and `updatedAt`. 45 sessions had
  `taskId`, 1 had `statusComment`, and 21 had a `resultsBranch` in the first repository. The agents were `claude`,
  `codex` and `junie`. `Date.parse` read each `updatedAt`.
- `airc sessions --limit 200` gave 194 sessions in the order of `updatedAt`, the newest first. Each session after the
  first 50 had the status `ARCHIVED`. So the 50 sessions of a read are the 50 newest.
- The first read of a new watch gave no note and 50 records. A watch that started in 1970 gave a note for each of the 2
  sessions with a status of a note.
- The part `cloud` of the morning report for the last 24 hours had 2 finished sessions, 0 failed, 0 waiting and 1 running.
- The check did not run a daemon, did not show a note in Air, and did not try a missing login. See the open checks.

One manual check of Junie as an ACP agent ran on 2026-11-23 against Junie CLI 26.10.5 (3579.7) on the machine of the
author, with Central and a login, for the change `junie-child`. A script outside the repository started Junie with the
launch of `childLaunch('junie')`, `central run junie -- --acp=true`, each time in a new temporary directory. It sent
no `session/delete`. It compared a list of `~/.junie/sessions` and a copy of `~/.junie/settings.json` from before with
the state after each step. The checks left 6 new session folders in `~/.junie/sessions` and removed none.

- **A session without a prompt (task 1.1).** `session/new` answered in 0.9 s with the session ID and 4 `configOptions`:
  `mode`, `model`, `effort` and `brave_mode`. Junie made the folder `~/.junie/sessions/<session ID>` with one file,
  `transcript.md` of 21 bytes, and no `events.jsonl`. It added no line to `index.jsonl`. A new start of Junie did not
  remove the folder. Air reads its list of Junie sessions from `index.jsonl` (`JunieSessionIndex.kt`), so it lists no
  such session. Nobody looked at the list in Air. So each account check of Junie leaves one such folder.
- **A prompt, a load and a model (task 1.2).** A short prompt ended with `end_turn` after 8.6 s. The folder then held
  `events.jsonl`, `summary.json`, `state.json` and `tasks.json`. In a second process, the answer of `session/load` held
  the same 4 `configOptions`, and a `config_option_update` with them came after the answer. Before the answer, Junie
  sent the old turn again as `user_message_chunk` and `agent_message_chunk`. `session/set_config_option` with the
  `configId` `model` and the value `v1:13:proxy:central:claude-haiku-5-5` of the list answered with the new current
  value, and the next turn used that model: `summary.json` of the session had usage of `claude-haiku-5-5` after it.
  A value that the list does not have and the bare model ID `claude-haiku-5-5` both gave the error -32602
  "Unsupported or unavailable Junie model config value". `acpLastSelectedModel` of `~/.junie/settings.json` did not
  change. A change of the model also changed the options of `effort`.
- **A permission request (task 1.3).** With `brave_mode` `off` ("Safe"), Junie ran `echo` with no request, and it asked
  before `touch`. The request had `toolCall` with `toolCallId`, `kind` `execute`, `status` `pending`, `title` (the
  command) and `rawInput` with `command` and `cwd`, and three options: `Yes` (`allow_once`), `No` (`reject_once`) and
  `Always allow ("touch *")` (`allow_always`). No option ID holds "bypass". After the answer `No`, the tool call
  failed, Junie did not run the command, and the turn ended with `end_turn`. Junie asked no question about the trust
  of the new directory.
- **The Brave Mode (task 1.3).** `session/set_config_option` with the `configId` `brave_mode` changed `braveMode` of
  `~/.junie/settings.json`, so it changes each later session of the user, not only the session of the request. The
  check set the value back to `on` with the same request, and the file then was equal to the copy from before.
  Megachat sends no `brave_mode` request.
- **A question to the user (task 1.3).** Megachat announces no elicitation. A prompt that told Junie to ask a
  question with two options gave no request to the client. Junie wrote the question in its reply and ended the turn
  with `end_turn`.
- **A steering request (task 1.4).** `initialize` gave `_meta.steering.supported` `true`. `_session/steering` during a
  command of 12 seconds answered `{"outcome":"injected"}` in 0.1 s, the command ran to its end, and the reply of the
  turn used the message. The same request for a session without a running turn answered
  `{"outcome":"startedNewTurn"}`: Junie started a turn of its own with the message, and a `session/prompt` after it
  got the error -32602 "A prompt is already active for this session". So Junie does not read
  `_meta.steering.idleBehavior`. Megachat sends a steering request only while its prompt runs, and it reads
  `startedNewTurn` as a turn that ended first: the message stays `pending`, the end of the run stops the process of
  Junie, and a follow-up sends the message again. The session of Junie then holds the message two times.
- **The route of Central (task 1.5).** `central log` listed the requests at the time of each Junie turn: the requests
  of the model of the turn and the `/v1/chat/completions` requests of the small models of Junie, each with the status 200.
- **Central without `central add junie` (task 1.6).** Nobody checked it: `central agents` gives "installed ·
  configured" for Junie on this machine, and no other machine was at hand.

One real run of a Junie child ran on 2026-11-23, for the task 8.1 of the change `junie-child`. A script outside the
repository opened the services of the daemon of the checkout as `src/main.mjs` does, in a temporary state directory:
the state, the server with the history tools, the transcripts and the run service with the real
`CentralConfigurationService`. The main agent was a fake model that called the tools. Each child was the real Junie
CLI 26.10.5 through `central run junie -- --acp=true`, in a new temporary git repository, with the Brave Mode `on` of
the author and the model `gemini-3.7-flash` of the configuration of Junie.

- **A task.** `agents_spawn` with the agent `junie` and a task that makes a file: the run ended as `completed` after
  88 s, and the file had the line of the task. Junie took the HTTP MCP server of the history tools in `session/new`.
  The transcript named `Junie` and held the lines of 2 tool calls.
- **A follow-up.** `agents_send` to the child session: the new run loaded the session of the first run, added the line
  to the file, and ended as `completed` after 42 s, with the same provider session.
- **A message to a running task.** During a command of 25 seconds, `agents_steer` in the mode `queue` gave the outcome
  `injected`, and the delivery of the message was `delivered`. The command ran to its end, the child wrote the word of
  the message in its file, and the task had one run.
- **A stop.** A child ran a script that prints a line each 2 seconds. The stop of its row ended the run as
  `cancelled` with the stop reason `cancelled` in less than 1 second. 7 seconds later, the process table had no
  process of the script, of Junie or of `central run junie`, and the run had no continuation.
- **A model of the setting.** With `children.junieModel` `junie/claude-haiku-5-5`, the same kind of task ended as
  `completed`, and `summary.json` of its session had the usage of `claude-haiku-5-5` and none of `gemini-3.7-flash`.
  With `junie/no-such-model-9`, the run ended as `interrupted` after 1.3 s with the text of `error.childJunieModel`,
  with no session and no continuation.
- **The sessions of Junie.** The run left 5 new session folders in `~/.junie/sessions` and removed none.
  `~/.junie/settings.json` was equal to the copy from before.
- A first try of the stop told the child to run `sleep 333`. The model refused the command as a waste and ended its
  turn in 23 s, so that try stopped nothing.
- Not checked: a permission request of a Junie child in the chat, because it needs the Brave Mode `off`, which is a
  setting of the author for each session. The check of the task 1.3 recorded the request of Junie. Not checked: a
  restart of the daemon during a Junie run, and the row of a Junie child in Air.

One manual check of the session folder of Junie ran on 2026-11-23 against Junie CLI 26.10.5 (3579.7) on the machine of
the author, for the change `junie-sessions` (the tasks 1.1, 1.3 and 1.4). It used a test repository in a temporary
directory, and it read the event logs of `~/.junie/sessions` with a script that printed the kinds, the states and the
counts, and no text of a session of the author. It deleted nothing and sent no `session/delete`.

- **The files of a process (task 1.1).** `junie --task "<task>"` ran in a terminal mode in the test repository. While
  it ran a command, the process had these files of `~/.junie` open: its own two log files in `~/.junie/logs`
  (`log-<time>-pid-<PID>.log` and `llm-streaming-<time>-pid-<PID>.log`) and some directories. It did not keep
  `events.jsonl` open. `~/.junie/processes` and `~/.junie/instances` were empty, and the log of the process did not
  name the session ID. The `cwd` of the process was the test repository, and `projectDir` of `summary.json` was its
  real path. The first event of the log had a time 2 seconds after the start of the process. So the source has no
  `keepsOpen`, and a row gets its log by the `cwd` and the start time of the process.
- **Appended lines and the continue (task 1.3).** Two more runs with `junie --resume --session-id=<session ID> --task
  "<task>"` wrote to the same session folder. The inode of `events.jsonl` stayed, its size grew from 37,331 to 87,658
  and to 118,701 bytes, and a hash of the bytes from before each run stayed the same. So Junie only adds lines. In
  this mode the log has no `UserPromptEvent`: it has `TaskStartedEvent`, the events of the agent, `TaskState` and
  `SystemMessageEvent`, so the task text of the command line is not in the log.
- **A wait for the user (task 1.4).** 93 event logs (47,516 lines; one log of 1.5 GB was left out) had 59 waits: 29
  for a permission and 30 for the answer to a question. A wait for a permission is a `TerminalBlockUpdatedEvent` with
  `approvalRequest` in the state `INPUT_REQUIRED`, and the answer is a `UserResponseEvent`. Then the block comes again
  in the state `IN_PROGRESS`, with the status `COMPLETED`, `FAILED` or `REJECTED`. A question is an
  `AskAsyncRequestUpdatedEvent` in the state `INPUT_REQUIRED`, and the answer is a `UserAsyncResponseEvent`. 7 waits
  ended with a `CancelAgentEvent`, 2 with a `TaskState`, and 5 logs ended in the wait. `TaskState` had the states
  `COMPLETED` (117) and `CANCELED` (5).
- **Lines during a wait.** While the terminal UI of Junie waits, it writes a `TipSuggestionCreatedEvent` in the state
  `INPUT_REQUIRED` about every 30 seconds: 10,461 lines in one wait of 101 hours, and 30 lines in a wait of 15
  minutes. So the last write of the log is no start of a wait, and a tip changes no step. In its ACP mode, Junie wrote
  no line in a wait of 70 seconds.
- **Blocks that come again.** An ended block of a command, a tool, a file view, a file change or an MCP call came two
  times with its ended status in most turns: at its end in the state `IN_PROGRESS`, and again after the end of the
  turn in the state `COMPLETED`. Some came one time. Each of 107 results of a turn came in the state `IN_PROGRESS`,
  and 102 of them again in the state `COMPLETED`, with a text of the same length.
- **A question through ACP.** For a client that announces `clientCapabilities.elicitation.form`, Junie sent the
  request `elicitation/create` with `sessionId`, `mode` `form`, `message` and a `requestedSchema`: an object with one
  string property for each question, with `title` and the options in `oneOf` (`const`, `title`, `description`). The
  log got the `AskAsyncRequestUpdatedEvent` in the state `INPUT_REQUIRED`. The check client refused the request, and
  Junie then wrote a `CancelAgentEvent` and ended its turn. Megachat announces no elicitation, so a Junie child gets no
  such request today.
- The parser of `src/JunieSessionSource.mjs` read the 94 logs (47,571 lines, 47 MB) in 0.2 s. It gave 3,041 entries
  with 1,654 different keys: 179 of the user, 120 of the assistant and 1,355 of a tool. 82 sessions had a project
  directory, and 12 had none.
- Not checked: "Done" and the restore of a Junie session in Air, and a line of Megachat in Air (task 1.2, see the open
  checks). Not checked: a question wait of the terminal UI of Junie in a new session. The logs from before gave it.

One real run of the session actions for Junie ran on 2026-11-23, for the task 8.1 of the change `junie-sessions`. A
script outside the repository opened the services of the daemon of the checkout in a temporary state directory, with
`sessions.index` on, a fake main agent that called the tools, the real `~/.junie` of the author and one listed
directory: a new temporary git repository.

- **The first pass.** The live table read 318 session logs of Claude Code, Codex, pi and Junie in 0.9 s to 1.9 s: 96
  logs of Junie, also the log of 1.5 GB, of which it reads the head and the tail. The index had no session then,
  because no session of the machine was a session of the listed directory.
- **A session that waits for a permission.** A Junie session ran in the test repository in a process of its own,
  through `central run junie -- --acp=true`, with `brave_mode` `off` for the check. 1 second after its permission
  request, `agents_running` gave the row with the status `waiting_for_permission`, the session ID and the title. 70
  seconds later the status was the same, and the start of the wait in the view was the time of the event, 0.2 s
  before the request reached the client. After the answer and the end of the turn, the status was
  `waiting_for_user`. The owner of the row was `unknown`, because a script had started Junie. The check set
  `brave_mode` back to `on`, and `~/.junie/settings.json` was equal to the copy from before.
- **Find and read.** `agents_sessions` for the test repository with a word of the prompt gave a page of the agent
  `junie` from the index, with the session and its title. `agents_session_history` gave its entries from the index:
  the prompt, the answer to the permission request, the command with its output, and the result.
- **Archive and restore.** `agents_archive` with the answer `Archive` in its dialog added one line to
  `~/.junie/sessions/agent-workbench-archive-state.jsonl`: the keys `sessionId`, `updatedAt`, `projectDir` and
  `archived`. The 11 lines from before stayed byte for byte. The card had `hidden` `junie`, `air` `no Air thread` and
  the command `junie --resume --session-id=<session ID>`. The restore added one line with `archived` false. So that
  file of the author has two lines more, for a session of a temporary directory.
- **Continue.** `agents_resume` with the agent `junie` and the session ID started a Junie child that loaded the
  session and answered. The run ended as `completed` after 10 s, with the same provider session, and it was no
  service session.
- **The sessions of Junie.** The checks of both changes left 15 new session folders in `~/.junie/sessions`, each for
  a temporary directory, and removed none: the list had 204 entries before the first check and 219 after the last.
- A first try ran the Junie session as a child of the process with the services. `agents_running` then gave no row,
  because each process below the daemon without a run is a helper of Megachat.
- Not checked: the note in the chat for the wait (the tests cover the plan and the text), a Junie session of the
  terminal UI in `agents_running`, and what Air shows after the line of the archive.

One check of the archive of Junie sessions ran on 2026-11-24 in the test build of Air of the author (`IU-271.SNAPSHOT`,
the prototype branch of `spawn-megachat`, with the Megachat of the checkout and a test state directory), for the task
1.2 of the change `junie-sessions`.

- **The archive of Megachat did not hide the sessions.** The author asked the Megachat of the build to mark each
  session of a test project as Done, and answered `Archive` in its dialog at 10:57:37. Megachat
  archived 1 Claude Code session and 18 Junie sessions, and added 18 lines to
  `~/.junie/sessions/agent-workbench-archive-state.jsonl`. Air still showed the 18 Junie sessions.
- **The reason.** The log of the IDE named the provider of the Junie rows. Until 10:55:42 it was `native:junie`, which
  reads `index.jsonl` and the archive state file. At 10:55:30 the author opened a Junie session, Air started the
  Junie of its ACP registry (4171.4), and from 10:55:44 the rows came from the ACP list of that agent
  (`INDEXED_ACP`). That Junie keeps the Done state in `session_metadata.json` of each session folder. It read the
  archive state file of Air one time, for an import, and the marker `air-archive-import-v1.done` of the author is from
  2026-10-28.
- **Done of Air.** At 10:58:12 the author pressed Done on one Junie session in Air. Air sent `_session/archive`
  through the ACP list, and Junie wrote `{"archived":true}` to `session_metadata.json` of that session. Air added no
  line to the archive state file. Then 13 session folders of the author had that file, each with only `archived`
  true: 10 from 2026-10-28, the time of the import, and 3 from later Done actions. The folders held 13 files
  `session_metadata.json.lock`.
- **The probe (task 5.5).** A script started that Junie with `--acp=true` in a temporary directory, sent
  `initialize` with `_meta.jetbrains.air` `{"version":1,"capabilities":["sessionIndex","sessionArchive"]}`, and sent
  `session/list` for the project with the filters `unarchived` and `archived`. It printed only the IDs and the flags.
  The answer had 17 sessions that are not archived and 1 archived one: the session of the Done of 10:58. Then, in the
  same process, the script wrote `{"archived":true}` to `session_metadata.json` of one more of the 18 sessions, with
  a temporary file and a rename. The next `session/list` gave 16 and 2. Without the capability, `session/list` gave
  the first 10 sessions for each filter.
- **The Junie CLI of the author.** 26.10.5 (3579.7) has no `_session/archive` and does not read
  `session_metadata.json`.
- **The fix.** Megachat now writes both stores (decision 6 of `junie-sessions`). A second probe wrote the field with
  `writeMetadataArchived` of the checkout for one more of the 18 sessions, between two lists in one Junie process. The
  lists gave 16 and 2 before, and 15 and 3 after. The folder had no temporary file after the write.
- The checks changed the files of the author: 3 session folders of the project got `session_metadata.json`, one from
  the Done of Air and two from the probes. Each one is a session that the author asked to archive. The probes made no
  session folder. `~/.junie/settings.json` was equal to the copy from before, and the list of `~/.junie/sessions` had
  224 entries before and after the probes.
- **The fix in the build of Air.** The IDE started again with the fixed checkout, and the rows of Junie came from the
  ACP list. The author asked the Megachat of the build to repeat the archive, and answered `Archive` at 11:19:04.
  Megachat archived 15 Junie sessions, and skipped 4 that were archived already: the Claude Code session and the 3
  sessions with `session_metadata.json`. A screenshot after that turn showed no row of the 15 sessions and no row of
  the Claude Code session in the project.
- **A session with a thread of Air stays.** One Junie session still showed: the session that the author opened at
  10:55. Air has a thread of its own for it, its tab came back after the restart, and the provider `air-run:junie`
  gives its row. For such a row the archive state of Air decides, not the listing of Junie. Megachat does not write
  that state, and it told the author "no Air thread": it reads the threads of Air in `<caches>/<IDE>/acp/projects`,
  and a build of the monorepo keeps them in `MonorepoDevData/<hash>/<IDE>/system/acp/projects`.

## Open checks

These checks need the author by hand. Each one names its OpenSpec change.

- `show-build-version` (task 6.1): start Megachat from the checkout of `main` in the IDE with the Air support. Verify
  that the agent information of the IDE (the log or the about view of the agent, where the IDE shows it) has
  `0.4.0+<count>.g<commit>`, and that `node src/main.mjs status` prints the same `version`.
- `show-build-version` (task 6.2): after the first release with this change, run the install line with a temporary
  `MEGACHAT_ACP_CONFIG` and a temporary npm cache. Verify that the last line gives the release form, such as
  "Megachat 0.4.1", with no `+`.
- `limit-report-to-known-projects` (task 5.1): start the daemon with `MEGACHAT_HOME=$(mktemp -d)`, `report.morning` on,
  one known repository with a child run of the period, and tokprof on `PATH`. Verify that the Money part of the text of
  the report names only that repository, gives no sum of four digits, and says "Other work on this machine: not shown."
- `first-start-feedback` (task 5.3): turn off Wi-Fi and each other network, with a warm npm cache of the IDE. Open
  Megachat in the IDE. Record the time to the end, the exit code, the error output of npx in the log of the IDE
  (`idea.log` or the log of the ACP agent), and what the IDE shows. Repeat with an empty npm cache of the IDE. Record
  whether the SSH fallback of npm waits, and how long.
- `first-start-feedback` (task 5.4): with the network on, start a local server that accepts each connection and never
  answers (the probe above), and set `HTTPS_PROXY` to it in the `env` of the entry `Megachat`, next to the two
  variables. Open Megachat in the IDE. Verify that the IDE passes the `env` (the start goes to the proxy), and record
  how long the start waits before the IDE or npx ends it. Remove the proxy from the entry after the check.
- `first-start-feedback` (task 5.5): block the packets to port 443 of `github.com` with `pfctl` (a rule `block drop`),
  and open Megachat in the IDE. Record the time to the end and the output. Remove the rule after the check.
- `first-start-feedback` (task 5.6): open Megachat in an IDE build without the Air support. Record where the IDE shows
  the line "This ACP client has no Air support for Megachat", and whether the IDE cancels or closes the session when a
  window releases it.
- `first-start-feedback` (task 5.7): run the npx entry two times in a row in a terminal, with the network on and
  `--loglevel silly`, as after the first start. Record the reason when a start ends at once with the exit code 128.
- `first-start-feedback` (task 5.8): file one IJAI ticket for the Air side of the proposal: a time limit for the first
  answer of an npx agent, such as 3 minutes; the exit code and the error output of an agent that ends before its first
  answer, in the chat or in a notification; and a sign of progress while npx installs an agent. No ACP extension
  changes, so `docs/air-contract.md` does not change.
- `first-start-feedback` (task 5.9): record the results of 5.3 to 5.7 here and in `README.md`, part "The start in the
  IDE".
- `update-on-request` (task 3.2): on a real IDE build with the Air support, use a copy of the npx entry and a temporary
  new tag in `MEGACHAT_RELEASE_REPOSITORY` (the entry needs it in its `env`). Write "update yourself" in the chat. Record
  whether the reply comes whole before the daemon stops, whether Air starts the agent again at the next message, how long
  the install takes after the move of `_npx/<hash>`, and whether the message "Megachat updated from" comes with the line
  about the automatic update. Also ask with a child task that runs: the agent must name the task and not stop.
- `automatic-update` (task 6.2): on a real IDE build with the Air support, use a copy of the npx entry, a temporary
  state, and a repository with a new temporary tag in `MEGACHAT_RELEASE_REPOSITORY` (the entry gets the variable in
  its `env`). Set the working day so that the conversation sleeps. Let the daemon stop itself for the update. Record
  what Air shows at the exit of the agent, whether Air starts `npx` again at the next message or attach, whether it
  loads the session, and whether the next reply starts with "Megachat updated from". When Air does not start the agent
  again, file the Air side as an IJAI ticket.
- `answer-phase` (tasks 4.1 and 4.2): build a daemon with this change, and run it with a temporary `MEGACHAT_HOME`. On a
  real IDE build with the Air support, send a message that makes the main agent write a text, call `agents_list`, and
  then reply. Verify that the chat shows both messages open with no block "Worked for", and record what the log line
  `[AIR_WORKING_GROUP]` gives and what the replay of a new view shows. Check the first turn after an update (a state
  with the field `update.version` set to an earlier version, such as `0.6.1`) and the turn of the morning report the
  same way.
- `name-central-failure` (task 4.2): with a Central login that expired, or after `central logout` on a machine where
  the author allows it, run `central run pi` and record its exit code, its time and its error output, without a key
  or a URL of Central. Send "Hello" in Air, and record the text of the chat. When Central gives a fixed exit code for
  a missing login, a later change can give that case a text of its own.
- The dialog of a permission request after the end of the prompt (a fix without a change): on a real IDE build with
  the Air support and a temporary state, give a task to a Claude child that asks for a permission while the main
  agent still replies. Let the reply end, and do not answer. Verify that the dialog closes and shows again about 2
  seconds after the end of the reply, with no warning row about a cancelled request, and that the answer `Allow` then
  reaches the child. Repeat with a Stop of the reply while the dialog shows, for a child of an earlier turn.
- `session-archive` (task 1.1, open): on copies of the logs in a temporary `MEGACHAT_HOME`, check what Claude Code and
  the Codex TUI write on SIGTERM in a terminal, and whether `codex archive <id>` hides a thread in the Codex app and in
  Air. Record the results here.
- `session-archive` (task 3.2, open): on a real Air build, archive a copy of 3 Claude Code logs with `agents_archive` in
  a temporary `MEGACHAT_HOME`, then record how many seconds Air needs to move each row to Done (the file watch of Air),
  whether a session that Air ran and reopened stays active in Air, and a restore in Air of an archived row.
- `session-archive` (checked on 2026-11-14, read-only on copies in `/tmp`): the title records of Megachat equal the
  records of Air byte for byte. The check took the 13 Claude Code logs of `~/.claude/projects` whose last two lines are
  Air records with the prefix, copied each, restored it and archived it again, and compared the last two lines with the
  originals: 13 of 13 equal. The 16 logs have no sidecar `custom-title.json`, as `ClaudeCustomTitleSidecarWrite.WHEN_PRESENT`
  of Air gives.
- `air-html-in-chat` (task 1.1, open): on a real Air build with a temporary `MEGACHAT_HOME`, log the `initialize` and the
  `session/new` that Air sends to Megachat, without a token. Record the capabilities, and whether `additionalDirectories`
  or the `air-views` path arrives. The ACP logs of the IDE (`~/Library/Logs/JetBrains/IntelliJIdea2027.1/acp`) hold no
  request body, so the check needs Air. The state keeps the last value of the support in the field `airSupport` of the
  state document (no key-value table was needed).
- `air-html-in-chat` (task 1.2, open): give the rules to the model in a test chat, and verify that Air draws the fence and
  that a stream with a chunk inside the fence ends in a page.
- `air-html-in-chat` (task 3.2, open): ask "draw the open tasks as a chart" in Megachat in Air, and record the result.
- `watch-cloud-sessions` (after the merge): start the daemon with `MEGACHAT_HOME=$(mktemp -d)` and `cloud.sessions` on,
  in the IDE with the Air support. Start a short cloud session in Air. Verify that one note "Megachat note: one cloud
  session changed its state." shows in the chat at most 2 minutes after the session finished, and that the replay of a
  new view shows it again. Ask "what runs in the cloud?", and verify that the answer names the session.
- `uninstall` (task 5.2, open): on a real IDE build with the Air support, on a machine where the author allows a change
  of `~/.jetbrains/acp.json`, such as a test VM, install Megachat and open a Megachat session in Air. Run `uninstall`
  in a terminal, then send a message in that session. Record whether Air reads `acp.json` again, whether it starts
  `acp` again and so a new daemon, and what the chat shows.
- `junie-sessions` (task 1.2, open): in an Air build, archive and restore a Junie session with `agents_archive` in a
  temporary `MEGACHAT_HOME`, also a session of a linked git worktree. Do it two times: after a start of the IDE, while
  the rows of Junie come from `index.jsonl`, and after Air started the Junie of its ACP registry, for example after a
  click on a Junie session. Record the provider of the rows from the log of the IDE ("Session row provider selection
  changed"), and whether Air hides and shows the session after each write without a restart, at most 60 seconds
  later. The check of 2026-11-24 found that Done of Air through the ACP list writes `session_metadata.json`. A Done of
  Air from `index.jsonl` still needs a record.
- `junie-child` (task 8.2, open): in an Air build with a temporary `MEGACHAT_HOME`, start a Junie child. Verify that
  its row says `Junie · <project>`, that a click on its title opens the session of Junie, and that Air hides that
  session with `children.showInProject` `false`. Megachat sends the agent ID `junie`, which is the ID of Junie in
  `ProductDefaultAgents.kt` of Air. Nobody looked at it in Air.
- `junie-child` (task 1.6, open): on a machine or a macOS user without `central add junie`, run
  `central run junie -- --acp=true` with a test command `junie` first on the `PATH` that writes the names of its
  arguments and of the new variables. Record whether Central puts the route in the command line of Junie.
- `spawn-megachat` (task 7.3): with `MEGACHAT_HOME=$(mktemp -d)`, start `acp` two times through an ACP client, one time
  without and one time with `MEGACHAT_PROJECT` for a small project. Verify two daemons, the setup note of the project,
  a task that starts in the project, a refusal of a task in another directory, and `_agent/stop` with and without a
  child run. The tests of the change cover each of these with a fake model. Nobody ran them with a real model yet.
- `spawn-megachat` (task 7.4): with an Air build that has the change of
  `openspec/changes/spawn-megachat/air-ticket.md`, press "Spawn Megachat" for the IDE and for a project, and "Remove
  Megachat" for both. Verify that Air starts no command of the entry before the add, that the process of a project has
  `MEGACHAT_PROJECT` and the capability `projectScope`, and that a new "Spawn Megachat" after a removal gives the same
  conversation. No released Air build has the change.
  - A first run on 2026-11-23, with a prototype of the Air side (a local branch of the IDE, not merged), a real model
    and a separate `MEGACHAT_HOME`: "Spawn Megachat" in the menu of two project rows gave two processes with
    `MEGACHAT_PROJECT`, and two state directories `projects/<name>-<digest>` with `project.json`, next to the daemon
    of the machine scope. The setup of a project asked its two questions and ended. A Claude child task ran in the
    directory of its project. The session was the first row of its project.
  - Not checked in that run: "Remove Megachat", the button for the IDE, a refusal of a task in another directory, and
    a new "Spawn Megachat" after a removal.
  - Found in that run: Air starts the process of the entry at the start of the IDE, for the session list of the
    application workspace. So the daemon of the machine scope ran before the user added a Megachat. Point 2 of the
    Air ticket covers this.

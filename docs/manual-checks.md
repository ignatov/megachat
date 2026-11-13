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
- `automatic-update` (task 6.2): on a real IDE build with the Air support, use a copy of the npx entry, a temporary
  state, and a repository with a new temporary tag in `MEGACHAT_RELEASE_REPOSITORY` (the entry gets the variable in
  its `env`). Set the working day so that the conversation sleeps. Let the daemon stop itself for the update. Record
  what Air shows at the exit of the agent, whether Air starts `npx` again at the next message or attach, whether it
  loads the session, and whether the next reply starts with "Megachat updated from". When Air does not start the agent
  again, file the Air side as an IJAI ticket.
- `name-central-failure` (task 4.2): with a Central login that expired, or after `central logout` on a machine where
  the author allows it, run `central run pi` and record its exit code, its time and its error output, without a key
  or a URL of Central. Send "Hello" in Air, and record the text of the chat. When Central gives a fixed exit code for
  a missing login, a later change can give that case a text of its own.
- The dialog of a permission request after the end of the prompt (a fix without a change): on a real IDE build with
  the Air support and a temporary state, give a task to a Claude child that asks for a permission while the main
  agent still replies. Let the reply end, and do not answer. Verify that the dialog closes and shows again about 2
  seconds after the end of the reply, with no warning row about a cancelled request, and that the answer `Allow` then
  reaches the child. Repeat with a Stop of the reply while the dialog shows, for a child of an earlier turn.

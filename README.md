# Megachat

Megachat is one durable chat for a user on a machine. It is an ACP agent for JetBrains Air.
Each project window and each JetBrains product of the user opens the same conversation.
The main agent delegates file and command work to Claude Code and Codex, and lists that work as background tasks.
A daemon keeps the conversation and the work when the IDE closes.
All model traffic goes through JetBrains Central.

## Install for a colleague

Run this line once in a terminal, then open Megachat in the IDE:

```sh
npx -y "github:ignatov/megachat#semver:x" install
```

A release is a tag `v<version>` of this repository, and `#semver:x` selects the tag with the highest version. Keep the
quotation marks: a zsh with the option `extendedglob` reads `#` as a pattern.

The line checks what the machine needs, and prints one line for each result. Then it adds this entry to
`agent_servers` in `~/.jetbrains/acp.json`:

```json
"Megachat": { "command": "npx", "args": ["-y", "github:ignatov/megachat#semver:x", "acp"] }
```

The IDE starts the command `npx` with its own Node.js and its own npm cache. So each start of the agent in the IDE
starts the last release. The exit code of the line is 0 only when the entry is in place and each check passed. The
last line gives the version and the directory of the copy that ran the install. That copy is in the npm cache of the
terminal, and the IDE does not use it.

The machine needs:

- An IDE build with the Air support for Megachat. No released IDE build has it yet: only a build from the current
  sources of the IDE has it. An IDE build without it starts Megachat as an ordinary custom ACP agent. Then Megachat
  gets no list of the open projects and cannot hide its delegated sessions from the session list. That IDE also does
  not know that the session persists, so it can cancel or close the session when a window releases it. Nobody tested
  Megachat on such a build. When the policy of the organization does not allow custom agents, the IDE does not show
  Megachat.
- git, and access to `github.com`. The repository is public, so the line needs no GitHub account.
- Node.js 22.19 or later for the install line. The IDE runs Megachat with its own Node.js.
- The Central command at `~/.local/bin/central`, with a login: `central login`.
- Claude Code at `~/.local/bin/claude`, set up through Central: `central add claude-code`.
- The Codex command, `codex`, on the `PATH`.
- macOS. Nobody tested Megachat on another platform.

**The start in the IDE.** These numbers come from the npm 11.19.1 of the IDE on one Mac, with an empty npm cache of a
test and the release 0.2.0 on GitHub:

- The first start installs the release. It took 27 seconds in one measurement and 105 seconds in another one. The copy
  takes 870 MB in the directory `_npx` of the npm cache, and the npm cache takes 1.3 GB.
- Each later start asks GitHub for the tags with `git ls-remote`, and it clones the tag of the release to read its
  `package.json`. When the release is the same, npm writes no file of the copy again. Five later starts gave the first
  ACP answer after 2.5 to 4.2 seconds. That time includes the start of the daemon.
- Two other later starts, directly after the first start, ended after 0.3 and 0.4 seconds with the exit code 128
  and printed nothing. A failed git command gives this result, but the npm log does not give the reason.
- A path of the npm cache through a symbolic link, such as `/tmp` on macOS, makes npm reject the lock file of the
  copy. Then each start writes all 20,640 files of the copy again, and a later start took 18 seconds. The npm cache of
  the IDE is in `~/Library/Caches`, and that path had no symbolic link on the Mac of the test.

Without the network, `npx` cannot ask GitHub for the tags, so Megachat does not start, also when the copy is in the
cache. With a proxy that refused each connection, `npx` ended after 1.3 to 2.4 seconds with the exit code 128 and
printed nothing. With a proxy that accepted each connection and never answered, `npx` did not end in 180 seconds. The
IDE waits for the first answer of an agent without a time limit. Nobody found a reliable time limit for this case yet.

**Disk use.** The IDE keeps its copy in its own npm cache, in the Node.js directory of the IDE, such as
`~/Library/Caches/JetBrains/<product>/acp-agents/.runtimes/node/<version>/npm-cache`. The install line keeps another
copy in the npm cache of the terminal, `~/.npm`. So the two copies take about 2.6 GB together.

The installed copy does not use `package-lock.json`. So its indirect dependencies can differ from the tested ones.

When `acp.json` has an entry `Megachat` that the install line of Megachat 0.2.0 wrote, the line replaces it with the
new entry. That earlier entry starts a copy in an `_npx` directory directly with Node.js. The line copies the file to
`acp.json.before-megachat-<UTC time>` first, and prints the earlier entry. When `acp.json` has another entry
`Megachat`, the line does not change the file. It prints both entries and what to do. Two copies of Megachat on one
machine replace the daemon of each other.

**Update.** The update is automatic. The next start of the agent after a release installs the new release, and its
daemon replaces the daemon of the earlier release. In two runs of a test with a local repository, that start took 10.6 and 12 seconds.
Nobody measured it against GitHub. Nobody tested what happens to an unfinished delegated task when a new release
replaces the daemon.

**Removal.** Delete the entry `Megachat` from `~/.jetbrains/acp.json`. Then delete the directory `_npx/<hash>` that
holds `node_modules/megachat`, in the npm cache of the IDE and in `~/.npm`. `install` printed the directory of the
terminal copy in its last line.

## Install from a checkout

The checkout needs the same tools. Then run:

```sh
npm ci
node src/main.mjs install
```

`npm ci` takes each package from `registry.npmjs.org`. npm 11.19 runs no install script that `allowScripts` does not
name, so it skips the scripts of `esbuild`, `protobufjs` and `@google/genai`. The build still works, because npm
installs `@esbuild/darwin-arm64` as an optional dependency.

In a checkout, `install` adds the entry `Megachat` that starts `bin/megachat.mjs acp` of the checkout directly with
Node.js, not the entry with `npx`. Keep the name `Megachat`: Air derives the agent ID `acp.megachat` from it. The
checkout needs the same IDE build as a colleague.

A checkout has the build `dev`, so a pull does not replace a running daemon. Run `node src/main.mjs stop` to start the
new code at the next attach.

## Commands

Run each command as `node bin/megachat.mjs <command> [<directory>]`, or as `node src/main.mjs` in a checkout. The
optional directory selects a state directory of its own, for a test or for development.

| Command | What it does |
|---|---|
| `start` | Starts the daemon in the background when no daemon runs, and waits until it answers. It replaces a daemon of another build. It also replaces a daemon with other agent commands, when this command passes agent commands. |
| `status` | Prints the current task and the state of each child run as JSON. |
| `stop` | Stops the daemon. |
| `compact` | Asks the running daemon to replace the older part of the model context with a summary. The daemon waits for the end of the current turn. The history keeps each message. |
| `acp` | Starts the daemon when necessary and speaks ACP on the standard input and output. The IDE runs this command. |
| `daemon` | Runs the daemon in the foreground. `start` runs this command. It ends with the exit code 3 when another daemon owns the directory. |
| `install` | Checks the machine and adds the entry `Megachat` to `~/.jetbrains/acp.json`. The entry starts the last release with `npx`, or in a checkout the checkout directly. `MEGACHAT_ACP_CONFIG` replaces the path of the file. |

## The state directory

The state is in `~/.jetbrains/air/megachat`, and on Windows in `%USERPROFILE%\.jetbrains\air\megachat`. Each
JetBrains product of the user shares it. `MEGACHAT_HOME` or the directory argument selects another directory.

| File | Content |
|---|---|
| `conversation.sqlite` | The conversation, the child runs and the permission requests. |
| `owner.sqlite` | The lock of the daemon. One daemon owns the directory. |
| `search.sqlite` | The search index. The daemon builds it again from the conversation when necessary. |
| `workspace/` | The workspace of Megachat. A task without a project works there. |
| `instructions.md` | Your own rules, optional, at most 64 KB. The bundled rules keep priority. A restart of the daemon applies a change. |
| `settings.json` | The settings that you gave in the chat, and the status of the setup. |
| `spend.json` | The cost of the model requests of the main agent on this day, for `budget.dailyUsd`. |
| `sessions.sqlite` | The index of your past Claude Code, Codex and pi sessions. It exists only while the setting `sessions.index` is `on`. |
| `daemon/connection.json` | The process ID, the port, the build and the token of the running daemon. Keep the token private. |
| `daemon/daemon.log` | The log of a daemon that `start` started. |

Each directory has the mode 0700, and each file has the mode 0600. When the shared directory has no conversation, the
daemon copies it once from `~/Library/Application Support/JetBrains/AirMegachat`. `MEGACHAT_LEGACY_DIRS` replaces that
list.

## The size of the model context

The daemon sends the conversation to the model with each request. Above 100,000 tokens, it replaces the older part
with a summary, and it keeps about 20,000 recent tokens as they are. The setting `compaction.tokens` or
`MEGACHAT_COMPACT_TOKENS` in the environment of the daemon replaces the limit. The summary keeps your standing agreements, the open child tasks, the questions that
wait for you, and the recent decisions. `resources/compaction.md` holds its instructions. The conversation and the
search index keep each message, so the agent still finds the earlier details. `node src/main.mjs compact` writes a
summary at once.

## The prompt cache

A request reads the model context from the prompt cache at a twentieth of the input price. After the lifetime of the
cache, the next request writes the whole context again, which is slow and costs 40 reads. So the daemon asks for the
1-hour cache, and an idle daemon acts 50 minutes after its last model request:

- Above the limit of a summary, it writes the summary. Your next message then starts from a small context.
- Between 20,000 tokens and that limit, it sends a keep-alive request. The request reads the context from the cache
  for one output token, and the cache lives another hour. The conversation does not get the reply. For a context of
  100,000 tokens, one request costs about $0.02 at the list price of Claude Opus 5.5.

The keep-alive requests stop 6 hours after the last turn. The settings `cache.ttl`, `keepAlive.hours` and
`keepAlive.enabled` change these values, and the variables below win over them. The log of the daemon has one line with the token counts
of each keep-alive request and of each summary request.

| Variable of the daemon | Effect |
|------------------------|--------|
| `MEGACHAT_CACHE_TTL` | `1h` is the default. `5m` asks for the 5-minute cache, and the idle daemon then acts after 4 minutes 10 seconds. |
| `MEGACHAT_KEEPALIVE_HOURS` | The time after the last turn in which keep-alive requests go out. The default is `6`. |
| `MEGACHAT_KEEPALIVE` | `0` stops the keep-alive requests and the summary of an idle conversation. |
| `MEGACHAT_STREAM` | `0` stops the stream of a reply. Then the chat shows a reply when the model has written all of it. |

## Settings and the first run

Megachat keeps its settings in `settings.json` in the state directory. The file is apart from the conversation, so a
compaction does not change it. Change a setting in the chat, for example "answer in German" or "use Sonnet 5.5 for the
main agent". The main agent stores the value with its tool `agents_settings`. A change applies at once when no turn
runs, else at the end of the current turn. No setting needs a restart.

| Setting | Default | Variable | Effect |
|---|---|---|---|
| `coordinator.model` | `anthropic/claude-opus-5-5` | | The model of the main agent. The agent lists the models of the registry with their prices. |
| `coordinator.thinking` | `low` | | The reasoning level of the main agent and of a keep-alive request. |
| `keepAlive.enabled` | `true` | `MEGACHAT_KEEPALIVE` | The keep-alive requests and the summary of an idle conversation. |
| `keepAlive.hours` | `6` | `MEGACHAT_KEEPALIVE_HOURS` | The time after the last turn in which keep-alive requests go out, 0 to 168 hours. |
| `cache.ttl` | `1h` | `MEGACHAT_CACHE_TTL` | The lifetime of the prompt cache: `1h` or `5m`. |
| `compaction.tokens` | `100000` | `MEGACHAT_COMPACT_TOKENS` | The size of the model context above which the conversation gets a summary. |
| `reply.suggestions` | `false` | `MEGACHAT_SUGGESTIONS` | The main agent offers a next step by itself. |
| `reply.language` | `auto` | | The language of the answers. `auto` is your language. |
| `reply.length` | `short` | | The length of the answers: `short`, `normal` or `detailed`. |
| `reply.quoteRequest` | `false` | | A report of a child result quotes your original request first. |
| `children.agent` | `claude` | | The agent of a new task when you name no agent: `claude` or `codex`. A follow-up stays with the agent of its session. |
| `children.piModel` | `anthropic/claude-haiku-5-5` | | The model of a pi child. When the model registry does not know it, a pi child uses the model of the main agent. |
| `children.commit` | `allow` | | Whether a child may make a git commit: `allow`, `ask` or `deny`. |
| `children.push` | `ask` | | Whether a child may push: `allow`, `ask` or `deny`. |
| `children.daemonRestart` | `ask` | | Whether a child may restart or stop the Megachat daemon: `allow`, `ask` or `deny`. |
| `projects.newRoot` | `~/src` | | The directory where a new project without a named location goes. |
| `budget.dailyUsd` | `0` | | The daily spend limit of the main agent and the pi children in USD, with one warning on each day. `0` is no limit. |
| `sessions.index` | `off` | | The index of your past sessions. `on` gives the consent to read the session files. It applies at once. |
| `sessions.days` | `180` | | The import takes the sessions with activity in this count of days. `0` takes all sessions. |

The daemon adds the rules of `children.commit`, `children.push` and `children.daemonRestart` to the prompt of each
child at its dispatch, also to a follow-up and to a continuation. With `ask`, the child does the step only when its task
says that you approved it. Else it says in its result that the step is necessary, and the main agent asks you. With
`deny`, the child does not do the step, also when the task asks for it. A change of a `children.*` setting applies to the
next child, also in the turn that made it.

In the setup, the main agent looks for git repositories in `~/src`, in `~/IdeaProjects` and in the roots of
`MEGACHAT_PROJECT_ROOTS`, two levels deep, and offers the ones that are not listed yet, at most 200, the newest first.
The scan follows no symbolic link and reads no file. You choose the repositories, and the agent adds them to the known
list. When you ask for a new project without a location, the agent makes `<projects.newRoot>/<name>`, with a number at
the end when the name is taken, and adds it.

Megachat counts the cost of each request of the main agent and of the pi children on the local day: the replies, the
summaries and the keep-alive requests. The cost of the Claude and Codex children is not in the count, because the
accounts of Claude and Codex pay for them. When the count passes `budget.dailyUsd`, the main agent warns you one time on that day, and the work goes on.
`spend.json` keeps the count across a restart. Ask the agent for the settings to see the spend of the day.

At the end of the setup, the main agent checks the accounts with its tool `agents_accounts`. The check starts Claude
Code and Codex as a task starts them and opens a session without a prompt, so it spends no tokens. It shows for each
agent `started`, or the problem and what to fix, for example a missing login. A session that opens does not prove that
the provider accepts the login: the first task shows that. Ask the agent to check the accounts again at any time.

Each environment variable still works, and it wins over the stored value. The agent tells you when a variable hides
a stored value. A daemon reads the variables at its start.

Without `settings.json`, the setup of Megachat is pending. In its next reply to you, the main agent answers your
message and then offers the setup. The setup asks one question at a time and shows the default of each question. You
can skip one question or the whole setup, and the defaults then apply. After the setup, or after a skip, Megachat
does not offer it again. Ask the agent to run the setup again at any time. A file that the daemon cannot read stays as
`settings.json.unreadable-<UTC time>`, and the defaults apply.

## Add information to a task that runs

Send the information in the main chat while the child works, for example one more link for the same task. The main
agent calls its tool `agents_steer`, and the child gets the message during its turn, without a wait for the end of the
task. Claude Code and Codex take the message through the ACP extension `_session/steering`. An agent without it, or a
request to stop the current step, gets a cancel of the turn and then a continuation in the same session with the
message. A task that waits in the queue gets the message in its prompt. The task keeps one result. The daemon records
each message before it sends it, so a message survives a restart of the daemon. After a restart, a message that the
child can have already says that it can be a repeat.

## Pi children: cheap tasks that only read

Say "ask pi to summarize the README of project X" to give a small task to a pi child. A pi child is a conversation of
the daemon on Pi Durable, with the small model of `children.piModel`. It starts no process, so it starts at once and
costs little. It has only the tool `read`: it reads the files of its project and answers. It cannot run a command,
change a file, or read a file out of its project, also through `..` or a symbolic link. It gets the content of
`AGENTS.md` of the project, else of `CLAUDE.md`, at most 32 KB. It does not apply the skills or the settings of Claude
Code.

Use pi only to read and to summarize. Give each task that changes code, runs a command or needs the tools of Claude
Code to Claude or Codex. The main agent uses pi only when you name it, and `children.agent` cannot select it.

A pi child is a task as the others are: the chat lists it as a background task of the agent Pi, it waits its turn, it
stops at the deadline of 30 minutes and after 20 tool rounds, and you can cancel it. A follow-up goes to the same
conversation. A message that you add with `agents_steer` reaches the child after its current tool round. A daemon
restart continues the run. Its cost is in the daily spend. Megachat cannot delete the
conversation of a pi child, so `conversation.sqlite` keeps it after the run leaves the state.

## The sessions that run on the machine

Ask the agent "what is running now?". The main agent calls its tool `agents_running` and answers in the chat. The tool
lists the running sessions of Claude Code, Codex, pi and OpenCode on the machine, from a terminal, an IDE or Megachat.
It reads the process table with one `ps` call, and the working directory and the open session logs of each new
session with one `lsof` call. It changes nothing, and it stops no process. Each session has its agent, its project,
its start time, its owner (the terminal, the IDE or Megachat) and a state:

- `orphan`: no terminal, IDE, app or Megachat run owns the process any more.
- `active`: the session and its helpers use 10 percent of one core or more, now or in the last 2 minutes, or its log
  got a write in the last 2 minutes.
- `idle`: each other session.

The server of `tmux`, `screen` or `herdr` counts as a live terminal, so a session in a detached multiplexer is not an
orphan. The tool keeps its view for 5 seconds. It reads the processes on macOS only.

With the consent `sessions.index` (see the next section), Megachat also reads the metadata and the tail of the session
log of each running session, also outside the listed directories. Then each session also has its session ID, its
title, the time of the last write to its log, and a status:

- `working`: the log ends with a tool call, a tool result or a message without a reply.
- `stuck`: such an open step, and no write for 10 minutes or more.
- `waiting_for_user`: the log ends with a finished turn.
- `idle`: a finished turn, and no write for 30 minutes or more.

The status is a reading of the log, not a fact from the agent. Claude Code, Codex and pi write no record of a
permission prompt to their logs. So a session that waits for a permission shows as `working`, and after 10 minutes as
`stuck`. Megachat links a process to its log only when the link is certain: Codex keeps its log open, Claude Code
writes `~/.claude/sessions/<PID>.json`, and for pi the log must begin in the first 30 seconds of the process. A session
without a certain link has no title and no status, and the answer says so. A `codex app-server` gives one row for each
open session. Then ask "what is session X doing?": the main agent reads the last messages of the session from the end
of its log, also for a log of hundreds of MB. Without the consent, Megachat reads no session log, and the answer says
so.

## The index of past sessions

With your consent, Megachat keeps an index of your past Claude Code, Codex and pi sessions. Then the main agent and
the children find an earlier session at once, and they can read pi sessions. The same consent lets `agents_running`
read the log of each agent session that runs on the machine: its metadata and its status, and its content only when
you ask for it. The setup asks one time: "Index past Claude, Codex and pi sessions in your projects, and read the logs
of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only
when you ask. Everything stays local." Say "turn on the session index" or "turn off the session index" in the chat at
any time. Without your consent, Megachat reads no session file and keeps no index file. The search in Claude Code and
Codex sessions then reads them live, as before.

- **What is in it.** The sessions in `~/.claude/projects`, in `~/.codex/sessions` (or `$CODEX_HOME/sessions`), and in
  `~/.pi/agent/sessions` (or `PI_CODING_AGENT_SESSION_DIR`), only when the directory of a session is a listed
  directory or a directory in one: a project of an IDE, a known repository, or the Megachat workspace. A newly listed
  directory brings its old sessions. The import takes the sessions with activity in the last 180 days, and the setting
  `sessions.days` changes that count.
- **What it keeps.** For each session: the agent, the session ID, the directory, the title, the start time and the time
  of the last activity. For each message, tool call and tool result: at most about 2 KB of its text. The index does not
  read the archived Codex sessions.
- **Where it is.** `sessions.sqlite` in the state directory, with the mode 0600. Nothing leaves the machine.
- **Secrets.** Before the index keeps a text, it replaces what looks like a secret with `[secret removed]`: API keys
  with well-known prefixes such as `sk-`, `ghp_` or `AKIA`, Bearer tokens, private keys, JWTs, and assignments such as
  `password=...`. This is a best effort. A secret of another shape can stay in the index.
- **The import.** The first pass runs in the background, the projects of an IDE first and the newest sessions first.
  The chat lists it as a background task with its progress. After the first pass, the main agent tells you the count of
  the sessions and of the projects, and the last unfinished sessions. Then the index catches up at the start of the
  daemon and on each change of a session file. It reads only the new lines of a file.
- **The size.** One measurement with 100,000 synthetic messages of 2 KB gave a file of 640 MB. Real text takes less
  room, but plan for some hundreds of MB. The age limit and the limit of 2 KB for each message bound the file.
- **The live table.** The same consent covers the table of `agents_running`: for each session file on the machine, the
  path, the inode, the size, the agent, the session ID, the directory, the title, the start time, the time of the last
  write and the last step, and no message text. It reads the head and the last 64 KB of each file, the files of the
  last 24 hours first, then only the appended lines. A file with a write in the last hour gets a poll of its size every
  2 seconds. The table stays in `sessions.sqlite` across a restart.
- **Turn it off.** The setting `off` stops the import and deletes `sessions.sqlite` at once.

The session text is data for the agent, not instructions.

## Code map

| Files | Content |
|---|---|
| `bin/megachat.mjs` | The launcher. It checks the version of Node.js, then loads `src/main.mjs`. |
| `src/main.mjs` | The commands. `start` connects to the daemon, replaces a daemon of another build, uses a live daemon of a legacy directory, or starts a new daemon. |
| `src/MegachatHome.mjs` | The state directory, the legacy directories, the migration, the schema check, and the rules of the user. |
| `src/MegachatState.mjs` | The durable admission, the child runs, the permissions, the proposals, the continuation of an interrupted run, and the retention. |
| `src/PiMegachatService.mjs` | The main agent on the Pi Durable harness, and the `agents_*` tools. `resources/instructions.md` holds its bundled rules, and `resources/compaction.md` holds the instructions of a summary. |
| `src/PromptCacheKeepAlive.mjs` | The timer of the idle daemon: a keep-alive request or a summary before the prompt cache expires. |
| `src/AcpBridge.mjs` | The ACP agent side. It lists the unfinished child runs as background tasks. |
| `src/AcpRunService.mjs`, `src/child-supervisor.mjs` | The Claude and Codex child runs. The supervisor stops the child when the daemon exits. |
| `src/ChildSlot.mjs` | The one place for a child run, which the ACP and the pi run services share, so one child runs at a time. |
| `src/PiRunService.mjs`, `src/PiChild.mjs`, `src/ProjectReadEnv.mjs`, `src/PiChildHistory.mjs` | The pi child runs: their conversations in the harness, the choices and the rules of a child, the read-only environment of its project, and the read of its transcript. |
| `src/CentralConfigurationService.mjs`, `bin/pi`, `bin/codex` | The Central configuration and the launch of the children. |
| `src/AgentAccountCheck.mjs` | The check of the accounts of Claude Code and Codex, without a prompt. |
| `src/DaemonServer.mjs`, `src/DaemonClient.mjs`, `src/DaemonDirectory.mjs` | The local HTTP server, its client, the owner lock and the connection file. |
| `src/ReplyStream.mjs` | The stream of the partial reply of the main agent from the daemon to each client. |
| `src/MegachatBuild.mjs`, `src/sourceBuildId.mjs` | The version and the build ID. |
| `src/MegachatInstall.mjs` | The command `install`: the checks and the entry in `acp.json`. |
| `src/npmEnvironment.mjs` | The environment of the IDE for the daemon and the children, when `npx` started Megachat. |
| `src/ProjectDirectories.mjs` | The directories where a child can work: the checks of a known repository, the origins of the list, the discovery of the repositories, and the directory of a new project. |
| `src/RunningAgents.mjs`, `src/AgentProcesses.mjs`, `src/ProcessTable.mjs` | The tool `agents_running`: the view of the running sessions, the rules that find an agent session and its owner, and the process table of macOS. |
| `src/SessionCatalog.mjs`, `src/SessionLinks.mjs`, `src/SessionStatus.mjs`, `src/SessionTail.mjs` | The live table of the session files, the certain link of a process to its log, the status from the log tail, and the read of a log from its end. |
| `src/DailySpend.mjs` | The count of the spend of the main agent on each day, and the cost of one request. |
| `src/Settings.mjs` | The settings: the registry of each setting with its key, default, variable and validation, the file `settings.json`, and the precedence. `resources/instructions-onboarding.md` holds the setup rules. |
| `src/Suggestions.mjs` | The variable `MEGACHAT_SUGGESTIONS`, which lets the main agent offer a next step by itself. |
| `src/MegachatSearchIndex.mjs`, `src/MegachatHistoryServer.mjs` | The search index of the conversation, and its read-only MCP tool for the children. |
| `src/SessionHistoryService.mjs`, `src/ClaudeSessionHistoryService.mjs`, `src/CodexSessionHistoryService.mjs`, `src/CodexAppServerClient.mjs` | The search in the Claude and Codex sessions of the registered projects. |
| `src/SessionIndexService.mjs`, `src/SessionIndex.mjs`, `src/SessionText.mjs` | The index of past sessions: the consent, the import passes, the file `sessions.sqlite`, and the secret filter. |
| `src/SessionSources.mjs`, `src/SessionLog.mjs`, `src/ClaudeSessionSource.mjs`, `src/CodexSessionSource.mjs`, `src/PiSessionSource.mjs` | The session files of Claude Code, Codex and pi, and the parser of their lines. |
| `src/SqliteSidecar.mjs` | The code that the two search indexes share: the open of the file, the folding, the terms and the snippet. |
| `src/messages.mjs`, `resources/Megachat.properties` | The user-visible strings, the errors, and the log lines about a failure. |
| `build.mjs` | The bundle in `out/bundle/`. |
| `release.mjs` | The release of the version in `package.json`: the tag and the GitHub release. |

## Tests

```sh
npm test
npm run test:bundle
npm run test:package
```

`npm test` runs each `test/*.test.mjs` file. `test/state-guard.mjs` gives each test process a temporary
`MEGACHAT_HOME` and a temporary `MEGACHAT_ACP_CONFIG`. So a test cannot reach your conversation or your `acp.json`.
`npm run test:bundle` builds the bundle into `out/bundle/` and runs `test/bundle.test.mjs` on it.

`npm run test:package` runs `npm pack`, installs the package into a temporary prefix with a temporary npm cache, and
tests that copy: its daemon, its Claude and Codex agents, and its `install`. Then it runs the `npx` entry on a
temporary git repository with release tags, as the IDE does, and adds a higher tag. Each of the two tests takes about
1 GB and one to two minutes, so `npm test` does not run them. In one run, the network failed, npm installed the copy
without the optional package `@openai/codex-darwin-arm64`, and the Codex agent of the copy failed with
`Missing optional dependency`. The next run passed.

In a fresh clone, `npm test` skips the bundle test, because `out/bundle/` does not exist. After a build, `npm test`
tests the last build, and that build can be older than the source. Only `npm run test:bundle` tests a new build.

`node test/bench/session-index.bench.mjs [entries]` measures the import, the longest block of the event loop and the
search latency of the index of past sessions on a synthetic corpus. `npm test` does not run it.

The requirements are in `docs/spec.md`. The ACP extensions that Megachat and Air exchange are in
`docs/air-contract.md`. The later work is in `docs/roadmap.md`.

## Releases

A release is the tag `v<version>` and its GitHub release. The install line gives a colleague the release with the
highest version. So a commit on `main` reaches a colleague only with the next release.

To make a release:

1. Set the new version with `npm version <version> --no-git-tag-version`. Commit `package.json` and
   `package-lock.json`, and push `main`.
2. Run `npm run release`.

`npm run release` refuses a checkout with changes, a branch other than `main`, a `main` that is not equal to
`origin/main`, and a version that is not higher than the last release. Then it runs `npm run build`, `npm test` and
`npm run test:package`. The build comes first, because `npm test` tests the bundle in `out/bundle/`, and that bundle
can come from an earlier version. Then it makes the tag, pushes it, and makes the GitHub release with `gh`. The
notes of the release are the subjects of the commits since the last release. `npm run release -- --dry-run` prints
the release and changes nothing.

## License

Megachat has the Apache License 2.0. The text is in `LICENSE`. Each npm package that Megachat installs keeps its own
license.

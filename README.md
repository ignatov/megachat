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
"Megachat": {
  "command": "npx",
  "args": ["-y", "github:ignatov/megachat#semver:x", "acp"],
  "env": { "GIT_HTTP_LOW_SPEED_LIMIT": "1000", "GIT_HTTP_LOW_SPEED_TIME": "20" }
}
```

The IDE starts the command `npx` with its own Node.js and its own npm cache. So each start of the agent in the IDE
starts the last release. The `env` is a time limit of git for a stalled network, as "The start in the IDE" tells. The
exit code of the line is 0 only when the entry is in place and each check passed. Before its last line, the line says
that it cannot check the IDE build, and that each start in the IDE needs the network. The last line gives the version
and the directory of the copy that ran the install. That copy is in the npm cache of the terminal, and the IDE does not
use it.

The machine needs:

- An IDE build with the Air support for Megachat. No released IDE build has it yet: only a build from the current
  sources of the IDE has it. An IDE build without it starts Megachat as an ordinary custom ACP agent. Then Megachat
  gets no list of the open projects and cannot hide its delegated sessions from the session list. That IDE also does
  not know that the session persists, so it can cancel or close the session when a window releases it. Nobody tested
  Megachat on such a build. The install line cannot check the IDE build. When the IDE starts Megachat without the Air
  support, Megachat writes the line "This ACP client has no Air support for Megachat" to its error output, and the IDE
  keeps that output in its log. When the policy of the organization does not allow custom agents, the IDE does not show
  Megachat.
- git, and access to `github.com`. The repository is public, so the line needs no GitHub account.
- Node.js 22.19 or later for the install line. The IDE runs Megachat with its own Node.js.
- The Central command at `~/.local/bin/central`, with a login: `central login`.
- Claude Code at `~/.local/bin/claude`, set up through Central: `central add claude-code`.
- The Codex command, `codex`, on the `PATH`. Codex history requires the local Codex CLI with the app-server history
  API.
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
IDE waits for the first answer of an agent without a time limit. Before the first answer, only npx and git run, so
Megachat cannot show a message or end the start then.

The `env` of the entry sets `GIT_HTTP_LOW_SPEED_LIMIT` to 1000 and `GIT_HTTP_LOW_SPEED_TIME` to 20. Then git ends an
HTTPS transfer that stays below 1000 bytes per second for 20 seconds, and npm does not run it a second time. In a local
probe, a server that accepted each connection and never answered made `git ls-remote` end after 5.3 seconds with the
time 5, and the exit code 128. Without the variables, it did not end in 45 seconds. These variables do not end a proxy
that never answers `CONNECT`, and they do not end a network that drops the packets of the connection: git and npm have
no time limit for that wait. Only a time limit of the IDE can end such a start, so that is a request to Air.
`docs/manual-checks.md` holds the probe. The daemon and its children do not get these two values, so a slow `git fetch`
of a task does not end after 20 seconds. Another value of the user stays.

**Disk use.** The IDE keeps its copy in its own npm cache, in the Node.js directory of the IDE, such as
`~/Library/Caches/JetBrains/<product>/acp-agents/.runtimes/node/<version>/npm-cache`. The install line keeps another
copy in the npm cache of the terminal, `~/.npm`. So the two copies take about 2.6 GB together.

The installed copy does not use `package-lock.json`. So its indirect dependencies can differ from the tested ones.

When `acp.json` has an entry `Megachat` that the install line of Megachat 0.2.0, 0.3.0 or 0.4.0 wrote, the line
replaces it with the new entry. The entry of 0.2.0 starts a copy in an `_npx` directory directly with Node.js. The
entry of 0.3.0 and 0.4.0 is the npx entry without the `env`. The line copies the file to
`acp.json.before-megachat-<UTC time>` first, and prints the earlier entry. An npx entry with an `env` of the user is
another entry. When `acp.json` has another entry
`Megachat`, the line does not change the file. It prints both entries and what to do. Two copies of Megachat on one
machine replace the daemon of each other.

**Update.** The update is automatic. The next start of the agent after a release installs the new release, and its
daemon replaces the daemon of the earlier release. In two runs of a test with a local repository, that start took 10.6 and 12 seconds.
Nobody measured it against GitHub. Nobody tested what happens to an unfinished delegated task when a new release
replaces the daemon. A measurement with a local repository showed that npx takes the new tag at each next start, also
without `--prefer-online` (see `docs/manual-checks.md`).

The daemon lives for days, so it looks for a new release itself. 60 seconds after its start and then every 24 hours,
it runs `git ls-remote --tags` on `https://github.com/ignatov/megachat`, with the time limits of git of the entry and a
time limit of 30 seconds. It takes the highest tag `v<major>.<minor>.<patch>` and ignores a pre-release. A failed
check, for example without the network, writes one line to `daemon/daemon.log` and tries again after 1 hour. When a
higher release is available, `status` gives the key `update`, for example "A new release is available: 0.4.0 → 0.5.0".

The automatic update is opt-in. With the setting `update.auto` on (the default is off), the daemon of a copy of the install line, in a directory
`_npx/<hash>/node_modules/megachat`, stops itself for the update when all of these are true:

- No turn runs, and no message and no morning report waits for its turn.
- No child task runs or waits, and no permission request and no stop request waits.
- With `workday.enabled` on, the conversation sleeps: the time is outside the working hours, and the conversation was
  idle for `workday.idleMinutes`. With `workday.enabled` off, the local time is from 01:00 to before 05:00, and your
  last message ended 30 minutes or more before.

The daemon checks these conditions every 10 minutes. The stop is the same stop as the command `stop`, so the
conversation and each admitted message stay. Each `acp` process of the IDE then writes "The Megachat daemon stopped for
the update" to its error output and exits with the code 0. Megachat starts no daemon and no `npx` itself: the next start
of the agent in the IDE goes through `npx`, which installs the new release. Nobody checked yet on a real IDE build that
the IDE starts the agent again at the next message (`docs/manual-checks.md`, open checks). When the next daemon still
has the earlier version, it does not stop itself again for the same release.

After an update, your next message or the next morning report, whichever comes first, starts with a message of
Megachat: "Megachat updated from 0.4.0 to 0.5.0.", with the notes of each new release from GitHub. Without an answer
of GitHub in 10 seconds, the message gives the address of the release instead. A git checkout, a copy outside `_npx`,
and a daemon with `update.auto` off (the default) only show the new release in `status`. To get each
release without an action, ask the agent to set `update.auto` to `true`.

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
Node.js, not the entry with `npx`. The entry has absolute paths. Keep the name `Megachat`: Air derives the agent ID
`acp.megachat` from it. The checkout needs the same IDE build as a colleague.

A checkout has the build `dev`, so a pull does not replace a running daemon. Run `node src/main.mjs stop` to start the
new code at the next attach.

A checkout that is not exactly at a release tag adds the commit to its version as SemVer build metadata. For example,
`0.4.0+3.g1a2b3c4` is 3 commits after the tag `v0.4.0`, at the commit `1a2b3c4`. `0.5.0+g1a2b3c4` tells that the tag
`v0.5.0` of the version is not in the history yet. `.dirty` at the end tells that a tracked file has a change, and
`0.4.0+dev` tells that git failed or gave no answer in 2 seconds. A checkout at the tag with no change gives `0.4.0`.
The IDE gets this version in `agentInfo`, and the last line of `install` gives it. The build stays `dev`. `npm run
build` writes the version of the checkout into the bundle.

## Commands

Run each command as `node bin/megachat.mjs <command> [<directory>]`, or as `node src/main.mjs` in a checkout. The
optional directory selects a state directory of its own, for a test or for development.

| Command | What it does |
|---|---|
| `start` | Starts the daemon in the background when no daemon runs, and waits until it answers. It replaces a daemon of another build. It also replaces a daemon with other agent commands, when this command passes agent commands. |
| `status` | Prints the version of the running daemon, the current task and the state of each child run as JSON. The daemon of a checkout keeps its version after a pull, so `version` can be older than the checkout. A daemon of an earlier build gives no `version`. When a new release is available, the key `update` after `version` says so. |
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
| `conversation.sqlite` | The conversation, the child runs and the permission requests. It also records the version of the last daemon, for the message after an update. |
| `owner.sqlite` | The lock of the daemon. One daemon owns the directory. |
| `search.sqlite` | The search index. The daemon builds it again from the conversation when necessary. |
| `workspace/` | The workspace of Megachat. A task without a project works there. |
| `transcripts/` | The transcript of each child run that the state keeps, one plain text file for each run. |
| `instructions.md` | Your own rules, optional, at most 64 KB. The bundled rules keep priority. A restart of the daemon applies a change. |
| `settings.json` | The settings that you gave in the chat, the project values, and the status of the setup. |
| `spend.json` | The cost of the model requests of the main agent on this day, for `budget.dailyUsd`. |
| `memory.md` | The learned memory: the facts about you and the working notes that the main agent and the reflection saved, and the topics that it must not save again. You can edit it. The first write makes it. See [The learned memory](#the-learned-memory). |
| `memory-versions/` | The newest 20 versions of `memory.md` before each write of Megachat, the newest 5 texts that an undo replaced, and the digest of the file after the last write. A forget deletes the versions. |
| `sessions.sqlite` | The index of your past Claude Code, Codex and pi sessions. It exists only while the setting `sessions.index` is `on`. |
| `daemon/connection.json` | The process ID, the port, the build and the token of the running daemon. Keep the token private. |
| `daemon/daemon.log` | The log of a daemon that `start` started, with the mode 0600. For a failed child run, it holds the answer of the agent and the end of its error output, without the known secrets. |

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
  for one output token, and the cache lives another hour. The conversation does not get the reply. Claude Opus 5.5
  refuses a request that ends with a message of the assistant, so the request ends with a short message of its own
  after the context, and the conversation does not get that message either. For a context of
  100,000 tokens, one request costs about $0.02 at the list price of Claude Opus 5.5.

The keep-alive requests stop 6 hours after the last turn. The settings `cache.ttl`, `keepAlive.hours` and
`keepAlive.enabled` change these values, and the variables below win over them. The log of the daemon has one line with the token counts
of each keep-alive request and of each summary request.

The setting `workday.enabled` ties the keep-alive requests to your working hours. When it is off, the default, the
behavior above stays. When it is on, the daemon sends no keep-alive request outside the hours from `workday.start` to
`workday.end` on the days of `workday.days`, in the timezone of `workday.timezone`. When you still work after the end,
the summary waits until the conversation is idle for `workday.idleMinutes`. Then the conversation goes to sleep: above
the limit of a summary it gets the summary, also after the cache expired, and no request goes out until your next message.
A message at night works as usual, and the same idle rule applies after it. A child task does not stop, and a
permission request of a child shows at once. But a child result that arrives while the conversation sleeps waits: it
comes right after your next message, or at `workday.start` of the next working day. With the morning report on, the
results come first, and the report does not tell them again. Your first message of the morning starts from the
summary, so its cache write is small. `keepAlive.enabled` off stops the effect of the working day on the keep-alive
requests and on the summary, and the results still wait.

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
| `workday.enabled` | `false` | | The working day: no keep-alive request outside the working hours, and a summary and a sleep after the idle time. |
| `workday.start` | `09:00` | | The local time when the working hours start, as `HH:MM`. |
| `workday.end` | `19:00` | | The local time when the working hours end, as `HH:MM`. A time before the start gives hours that go past midnight. |
| `workday.days` | `mon`-`fri` | | The working days, as a list or as a text such as `mon-fri` or `mon,wed,fri`. |
| `workday.timezone` | `auto` | | The timezone of the working hours. `auto` is the timezone of the system, else an IANA name such as `Europe/Berlin`. |
| `workday.idleMinutes` | `30` | | The idle time outside the working hours before the conversation goes to sleep, 0 to 1440 minutes. |
| `report.morning` | `false` | | The morning report on each working day at `workday.start`. See [The morning report](#the-morning-report). |
| `update.auto` | `false` | | Whether the daemon of a copy of the install line stops itself for a new release when no work runs, at night or while the conversation sleeps. See "Update" in [Install for a colleague](#install-for-a-colleague). |
| `reply.suggestions` | `ghost` | `MEGACHAT_SUGGESTIONS` | The main agent offers a next step by itself. `off` gives no offer. `reply` puts the offer into the reply text. `ghost` shows the offer as grey text in the empty prompt input of Air, and Tab puts it into the input; a client that does not know the key shows nothing. In the mode `ghost`, a next step that you ask for is in the reply text. A stored value stays after an update, and only a `settings.json` without a value gets the default `ghost`. The variable takes `0`, `1` or `ghost`, and `0` gives `off`. The stored values `false` and `true` of earlier releases give `off` and `reply`. |
| `reply.language` | `auto` | | The language of the answers. `auto` is your language. |
| `reply.length` | `short` | | The length of the answers: `short`, `normal` or `detailed`. |
| `reply.quoteRequest` | `false` | | A report of a child result quotes your original request first. |
| `children.agent` | `claude` | | The agent of a new task when you name no agent: `claude` or `codex`. A follow-up stays with the agent of its session. |
| `children.parallel` | `3` | | The count of the tasks that run at the same time, 1 to 8. Tasks in one checkout run one after the other. See below. |
| `children.piModel` | `anthropic/claude-haiku-5-5` | | The model of a pi child. When the model registry does not know it, a pi child uses the model of the main agent. |
| `children.claudeModel` | `inherit` | | The model of a Claude child: `inherit` (the model of your settings of Claude Code, else `anthropic/claude-sonnet-5-5`), or a model of Claude Code as `anthropic/<model ID>`. See below. |
| `children.codexModel` | `inherit` | | The model of a Codex child: `inherit` (the model of your configuration of Codex, else the default model of Codex), or a model of Codex as `openai/<model ID>`. See below. |
| `children.permissionMode` | `inherit` | | The permission mode of a Claude child: `inherit` (the settings of Claude Code decide), `ask`, `allowEdits` or `auto`. It does not change a Codex child or a pi child. See below. |
| `children.commit` | `allow` | | Whether a child may make a git commit: `allow`, `ask` or `deny`. |
| `children.push` | `ask` | | Whether a child may push: `allow`, `ask` or `deny`. |
| `children.daemonRestart` | `ask` | | Whether a child may restart or stop the Megachat daemon: `allow`, `ask` or `deny`. |
| `children.timeoutMinutes` | `240` | | The time limit of a child run in minutes, from `0` to `1440`. `0` gives no limit. A run keeps the limit of its start. The wait for a permission request does not count. |
| `children.showInProject` | `false` | | With `true`, a new Claude or Codex child session shows in the session list of its project in Air. With `false`, Air shows it only in the Service Sessions group. A session keeps the choice of its first run. |
| `projects.newRoot` | `~/src` | | The directory where a new project without a named location goes. |
| `budget.dailyUsd` | `0` | | The daily spend limit of the main agent and the pi children in USD, with one warning on each day. `0` is no limit. |
| `memory.characters` | `4000` | | The cap of the size of `memory.md` in characters, from `1000` to `20000`. Above it, the main agent cannot add an entry. |
| `memory.reflection` | `true` | | The reflection: a background pass that adds entries to `memory.md` from the conversation. `false` stops it. See [The learned memory](#the-learned-memory). |
| `sessions.index` | `off` | | The index of your past sessions. `on` gives the consent to read the session files. It applies at once. |
| `sessions.days` | `180` | | The import takes the sessions with activity in this count of days. `0` takes all sessions. |
| `sessions.notes` | `off` | | A short note in the chat when an agent session waits for you for a long time. It needs `sessions.index`. See [Notes about the sessions that wait](#notes-about-the-sessions-that-wait). |

The daemon adds the rules of `children.commit`, `children.push` and `children.daemonRestart` to the prompt of each
child at its dispatch, also to a follow-up and to a continuation. With `ask`, the child does the step only when its task
says that you approved it. Else it says in its result that the step is necessary, and the main agent asks you. With
`deny`, the child does not do the step, also when the task asks for it. A change of a `children.*` setting applies to the
next child, also in the turn that made it.

A setting of one child run can have a value for one project: `children.agent`, `children.piModel`,
`children.claudeModel`, `children.codexModel`, `children.permissionMode`, `children.commit`, `children.push`,
`children.daemonRestart`, `children.timeoutMinutes` and `children.showInProject`. Say for example "in this project, children do not push". The main agent then stores the value for the directory of the
project, and the global value stays. A child gets the value of the nearest project directory that is its directory or
holds it, else the global value. A symbolic link to a project is that project. The daemon reads the value at each
dispatch, also for a follow-up and for a continuation. Ask the agent for the settings to see the project values, or to
remove a project value, so the global value applies again. A value of a directory that no longer exists stays, and the
settings show it as missing until you remove it. Each other setting applies to the daemon as a whole, and the agent
refuses a project value of it. `settings.json` keeps the project values under the key `projects`, by the real path of the
directory. Megachat 0.3.0 opens such a file, ignores the project values and keeps them.

Tasks in different directories run at the same time, at most `children.parallel` of them. Claude, Codex and pi children
count together, and at most one pi child runs at a time. Two tasks in one directory, or in a directory and a directory
inside it, never run at the same time, because two agents that change one checkout break the work of each other.
Megachat compares the real paths by their segments, so a symbolic link to a project is that project, and `app2` is not
in `app`. A task waits while a task in its checkout runs, and behind an earlier task of its checkout that waits. A task
for another checkout behind it does not wait for it. The tasks without a project share the Megachat workspace, so they
run one after the other. A task in a project that holds other projects, such as a home directory that an IDE opened,
waits for each task in them, and they wait for it. Each task keeps its own deadline, permission requests and messages, and the chat lists each task
with its own state. The title of a permission request names the agent and the task. A change of the setting applies to
the next start of a task, and it stops no task that runs. With `1`, one task runs at a time, as in the releases up to
0.3.0. Results that are ready at the same time come in one report.

The limit of one pi child keeps the state readable for Megachat 0.3.0: its daemon continues a dispatched pi run after a
restart only when no other child is active.

A Claude child works as Claude Code works in its project. It loads the project settings: `CLAUDE.md` with its imports,
`.claude/settings.json` with its permissions, hooks and `env`, the MCP servers of `.mcp.json`, and the skills of
`.claude/skills`. So a project hook runs in the child without a question, with the environment of the child. The child
does not load `.claude/settings.local.json` or your files in `~/.claude`: not your `CLAUDE.md`, your settings, your
skills or your plugins. When the `env` of `.claude/settings.json` sets `ANTHROPIC_BASE_URL`, Megachat does not start the
Claude child, because the child would send the key of Megachat to that address. The failure names the file. Claude Code
does not read `AGENTS.md`. When the project has an `AGENTS.md` and no `CLAUDE.md`, the daemon adds `AGENTS.md` to the
prompt of the child, at most 32 KB. A Codex child reads `AGENTS.md` by itself.

The adapter of Claude Code takes the permission mode of a Claude child from `permissions.defaultMode` of each settings
file, also of `~/.claude/settings.json`. With `children.permissionMode` `inherit`, Megachat keeps that: when your
settings say `auto`, each Claude child starts in the mode `auto`, and a project can set the mode `plan`. When no
settings file sets a mode, the adapter starts the child in the mode `auto` if Claude Code offers it, else in the mode
`default`. Each other value wins over each settings file: `ask` is the mode `default` of Claude Code, so the child asks
before each change and each command. `allowEdits` is the mode `acceptEdits`, so the child changes files without a
question and asks before a command. `auto` lets the classifier of Claude Code decide. A question of the child goes to
the main conversation. Megachat offers no `bypassPermissions` and no `plan`, and it removes each option of a permission
request that switches a child to `bypassPermissions`. When your `~/.claude/settings.json` sets `permissions.defaultMode`
to `bypassPermissions`, a Claude child of Megachat starts in the mode `default`, so it asks for each step that a
permission rule does not allow. When Claude Code refuses the mode, for example because your settings turn off the mode
`auto`, the task fails before it starts. Claude Code applies an allow rule of the project settings only in a directory
that you trusted in Claude Code: in another directory, the child asks all the same. A deny rule applies in each
directory.

The adapter also switches a Claude child to the `model` of your settings of Claude Code. With `children.claudeModel`
`inherit`, Megachat keeps that: the model of your settings decides, and without one the child uses
`anthropic/claude-sonnet-5-5`. Another value names a model of Claude Code as `anthropic/<model ID>`, also a model or an
alias that the model registry does not know, such as `anthropic/fable`. Megachat sends it after the start of each Claude
child, so it wins over your settings. When Claude Code does not offer that model, or your settings do not allow it, for
example with `availableModels`, the task fails before it starts.

With `children.codexModel` `inherit`, Megachat sends no model to a Codex child: the `model` of your configuration of
Codex decides, and without one the child uses the default model of the model list of Codex. Central sets no model.
Another value names a model of Codex as `openai/<model ID>`, such as `openai/gpt-5.5`, also a model that the model
registry does not know. The form is the form of the other model settings: the provider, then the model ID that the
agent knows. Megachat sends the model ID after the start of each Codex child, also of a follow-up and of a
continuation, so it wins over your configuration. The child keeps its reasoning level when the model supports it. When
the model list of Codex does not hold the model, the task fails before it starts. Megachat 0.3.0 opens a
`settings.json` with the key, ignores it and keeps it.

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
can skip one question or the whole setup, and the defaults then apply. In the mode `ghost` of `reply.suggestions`, Air
shows the likely answer of each setup question as grey text, such as "Keep the current values", and Tab puts it into
the input. After the setup, or after a skip, Megachat does not offer it again. Ask the agent to run the setup again at
any time. A file that the daemon cannot read stays as `settings.json.unreadable-<UTC time>`, and the defaults apply.

## The learned memory

The main agent remembers your preferences in `memory.md` in the state directory. It saves an entry when you state a
general rule or a preference, or when you correct it, and it does not ask first. Each write gives one line, such as
`Memory: added to "About the user": The user prefers short answers.`, and the reply quotes it. Ask "what do you
remember?" to see the entries, or ask for the file to get its path, and open it in the IDE. The file has three
sections: `## About the user`, `## Working notes` and `## Do not remember`, one bullet for each entry. An indented
bullet is an entry of its own. Edit it by hand
when you like: the next turn reads it. A write of Megachat changes only the lines of the entry that it addresses, and
it keeps each other line as you wrote it.

Ask the agent to forget a fact. It removes the entry and adds a short topic to `## Do not remember`, and it does not
save that topic again. It names the other entries of the topic and asks you about them. A summary of the conversation
drops the topic too. The forget has a limit: the stored conversation and `agents_history` keep your original messages,
and the earlier text of the memory stays in the model context until the next summary. The history search does not
find the text of a call of the memory tool, and the line of a forget does not hold the forgotten text. A forget deletes
the earlier versions in `memory-versions/`, also when an earlier write removed the entry, so no undo brings the fact
back. To let the agent save the topic again,
remove its line under `## Do not remember`, or ask the agent to remove it. Ask the agent to undo its last write of the
memory: `memory-versions/` keeps the earlier files. An undo does not remove your own edit of the file.

Each write checks the entry: Megachat refuses a key, an invisible character and a text that looks like an
instruction to the model. An entry of yours that fails the check stays in the file and shows as `[blocked: <reason>]`
in the prompt. A child result, the morning report and the summary of the past sessions cannot change the memory. No
child gets the memory: not a Claude child, not a Codex child and not a pi child.

The reflection is a background pass that finds a preference that you showed over many turns. It runs after a summary of
the conversation and after 10 of your turns, 60 seconds after the last turn and only when no turn runs. It does not run
while the conversation sleeps outside the working hours (see `workday.enabled`). It reads only your messages and the
replies of the main agent since the last pass, the newest 60,000 characters: no tool result, no child output, no note
and no automatic turn. It saves only what you said, such as a rule with "always" or "from now on", or a correction that
you repeated. Text that you paste or quote, such as a file, a log or the output of a program, is not a statement of
yours, and a reply of the main agent is never a source. It only adds entries, through the same checks as the memory
tool, and it never saves a topic of `## Do not remember`. A change or a removal is a proposal for you. The next reply
tells the line of each entry that the reflection added, and each proposal. To take back an entry of the reflection, ask
the agent to remove it: an undo takes back only the newest write. A message of yours and its turn do not stop a pass.
The reply of the first turn that starts after the end of the pass tells its adds. A forget stops a pass, and no later
pass reads the conversation before the forget. Each pass is one model request with the model of the main agent, at most
1,000 output tokens and no prompt cache. It counts in the daily spend, and no pass starts above `budget.dailyUsd`. Set
`memory.reflection` to `false` to stop it: the later passes then do not read the conversation of that time.

## The morning report

With `report.morning` on, the main agent writes a report on each working day at `workday.start`, on the days of
`workday.days` and in the timezone of `workday.timezone`, also when `workday.enabled` is off. The report covers the
days from the previous working day up to yesterday, so the report of a Monday covers Friday and the weekend. It has
three parts:

- **Done:** the finished child tasks, the commits of each listed project, and the sessions of the period by project
  when the index of the past sessions is on.
- **Open:** the child tasks that still run or that failed, and the permission requests that wait.
- **Money:** the USD that the key of Megachat paid for the main agent and the pi children, from `spend.json`, and apart
  from it the API-equivalent cost of your other agent sessions from [tokprof](https://github.com/ignatov/tokprof),
  which the accounts of Claude Code, Codex and the other agents paid. This cost covers only the projects that Megachat
  knows: the listed directories, and the projects of the child tasks of the period. For the rest, the report says
  "Other work on this machine: not shown." Without tokprof, the report says that this part is missing.

The daemon collects the data, and the main agent only writes the text. The commits come from `git log` with a time
limit. tokprof comes from `PATH`, else from `~/.local/bin`, and runs as `tokprof flame --stack agent,project,origin
--value cost` for the period, with a time limit of 2 minutes. tokprof does not read the store of the pi children of
Megachat, so their cost is only in the first part.

tokprof reads the logs of the whole machine. Megachat runs it one time, with no `--project`, and keeps only the lines
whose project is a known project or a directory in one. The data and the prompt get no cost, no name and no sum of the
other lines. tokprof names a session by the root of its git repository, so a session in a subdirectory of a known
repository counts. Some limits follow from the names of tokprof:

- tokprof names a session in a linked worktree, such as a lease of Branch Deck, by its main repository. So the cost of
  a worktree of a known repository counts for that repository, and a listed worktree shows no cost. A listed
  subdirectory of a repository also shows no cost.
- A group of tokprof, such as `temporary folders` or `codex chats`, is not a project, so it is not shown. A state
  directory in `/var/folders`, the place of `mktemp -d` on macOS, thus shows no cost of its workspace.

The report is an automatic turn, as the report of a child result. When Air is open, the report comes as a reply. When
Air is closed, the reply waits in the conversation, and Air shows it at the next attach. A message of yours interrupts
the report, and the report then comes again one time. The report starts no work: it lists what the agent would do
next, and you approve it. A period without a turn of yours and without a child task gives no report. The report itself
costs money, but this spend does not make the next period active. The report also starts no window of keep-alive
requests.

The state keeps the date of the last report, so a restart sends no second report. When the computer slept or the
daemon was down at `workday.start`, the report comes at the first chance on that working day. When you turn the report
on after the start of a working day, the first report comes on the next working day.

## Add information to a task that runs

Send the information in the main chat while the child works, for example one more link for the same task. The main
agent calls its tool `agents_steer`, and the child gets the message during its turn, without a wait for the end of the
task. Claude Code and Codex take the message through the ACP extension `_session/steering`. An agent without it, or a
request to stop the current step, gets a cancel of the turn and then a continuation in the same session with the
message. A task that waits in the queue gets the message in its prompt. The task keeps one result. The daemon records
each message before it sends it, so a message survives a restart of the daemon. After a restart, a message that the
child can have already says that it can be a repeat.

## Stop one task

The Background Tasks tab of the chat lists each unfinished child task. Click Stop on the row of a task to stop that
task alone. The other tasks and the turn of the main agent go on, and the stop needs no message to the main agent. A
task that waits in the queue ends before its start. A task that runs gets a cancel of its turn, and its pending
permission requests end. The task gets no continuation. Then the main agent gets the result `cancelled` in a turn of
its own. It tells you that the task stopped, and it does not start the task again unless you ask. The row of the import
of past sessions has no Stop.

Air hides the Background Tasks tab while the chat shows a permission request. Answer the request first, or ask the main
agent to cancel the task.

The permission dialog of a task goes away in each chat window when the request can no longer get an answer: after an
answer in another window, and when the task stops, fails or reaches its deadline. A window that opens later shows no
dialog for it.

### The processes of a stopped task

On macOS, a stop of a task also ends each process that the task started: a shell of the agent, and a build, a test
loop or a server that runs in it, also when the shell runs in a session of its own or its parent ended first. This
applies to a Stop of a row or of the turn, a cancel, the deadline, the limit of the error output, a stop for a message
of the user, and a failure of the agent while the daemon runs. The supervisor of the task reads the process table every
second, without the command lines, and it sends a signal only to a process that the task started: SIGTERM first, and
SIGKILL after 1 second. Such a stop takes at most 5 seconds longer.

These processes stay, as before:

- the processes of a task that completed, outside the process group of the agent, such as a server that the task
  started;
- the processes of each task at a stop or a loss of the daemon, because a task can restart the daemon from its own
  shell;
- a process that leaves the task in less than a second, such as `cmd &` in a shell that ends at once.

On other platforms, only the process group of the agent ends, as before.

## Read the transcript of a task

Click the title of a running task in the Background Tasks tab. The IDE opens the transcript of that run, a plain text
file in `transcripts/` of the state directory. It holds the task, the messages of the child, each tool call by its name
and title, each permission request, each message that you added with `agents_steer`, and the end of the run. Claude,
Codex and pi children have one. The secret filter of the index of past sessions removes the text that looks like a
key or a password. It also removes the exact key and base URL of Central that the daemon knows, which it keeps in its
memory only. A transcript stops at 1 MB with a note. The file goes away when the state drops its run. A
continuation of a task, for example after a restart or a message, is a new run with a new row and a file of its own.

The output of a child that the main agent reads, with `agents_inspect` and in the report of the result, loses only the
key of Megachat: the exact key and base URL of Central that the daemon knows, and the key after `/wire/` of a URL. The
same applies to a permission request, to the error of a task, and to a session that the session tools read without the
index. Other text stays as the child wrote it, so the main agent gets the data that it needs. While a task runs, its
output lacks the last word, because the next chunk of the reply can complete a key.

Air does not follow the file while it grows. The IDE shows the newer text after its next refresh of the files, for
example when its window gets the focus again, or after File | Reload All from Disk. A queued task has no transcript yet, and a finished task leaves the tab, so its transcript does not open
from the chat.

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
has no turn limit, only the time limit of `children.timeoutMinutes` stops it, and you can cancel it. A follow-up goes to the same
conversation. A message that you add with `agents_steer` reaches the child after its current tool round. A daemon
restart continues the run. Its cost is in the daily spend. Megachat cannot delete the
conversation of a pi child, so `conversation.sqlite` keeps it after the run leaves the state.

## The sessions that run on the machine

Ask the agent "what is running now?". The main agent calls its tool `agents_running` and answers in the chat. The tool
lists the running sessions of Claude Code, Codex, pi and OpenCode on the machine, from a terminal, an IDE or Megachat.
It reads the process table with one `ps` call, and the working directory and the open session logs of each new
session with one `lsof` call. It changes nothing. Each session has its agent, its project,
its start time, its owner (the terminal, the multiplexer, the IDE or Megachat) and a state:

- `orphan`: the owner is gone for certain. No terminal, multiplexer, IDE, app or Megachat run owns the process any
  more, and between the process and launchd there are only shells and the processes of the same agent.
- `unknown`: the parent chain has a live process that can own the session, such as a Java process or a script, and
  Megachat cannot tell whether it does. The answer gives the count of such sessions.
- `active`: the session and its helpers use 10 percent of one core or more, now or in the last 2 minutes, or its log
  got a write in the last 2 minutes.
- `idle`: each other session.

The server of `tmux`, `screen`, `zellij` or `herdr` owns its sessions also without a client, so a session in a detached
multiplexer is not an orphan, and its owner kind is `multiplexer`. An IDE that runs from sources is a bare `java`
process. It counts as an IDE when its command line has the main class `com.intellij.idea.Main` or the dev server
`org.jetbrains.intellij.build.devServer.DevMainKt`. Another Java process gives the state `unknown`. The tool keeps its
view for 5 seconds. It reads the processes on macOS only.

With the consent `sessions.index` (see the next section), Megachat also reads the metadata and the tail of the session
log of each running session, also outside the listed directories. Then each session also has its session ID, its
title, the time of the last write to its log, and a status:

- `working`: the log ends with a tool call, a tool result or a message without a reply.
- `stuck`: such an open step, and no write for 10 minutes or more.
- `waiting_for_user`: the log ends with a finished turn.
- `idle`: a finished turn, and no write for 30 minutes or more.
- `waiting_for_permission`: the session waits for a permission of the user. For a child of Megachat, a pending
  permission request of its run in the state of Megachat tells it. For another Claude Code session,
  `~/.claude/sessions/<PID>.json` tells it, such as a prompt for a tool call or a network request of the sandbox.
- `waiting_for_user` also comes from `~/.claude/sessions/<PID>.json` when Claude Code asks the user a question.

The other statuses are a reading of the log, not a fact from the agent. Claude Code, Codex and pi write no record of a
permission prompt to their logs. Outside its children, Megachat takes a status from the process file of Claude Code
only when the file has the PID and the start time of the process, the log has no later write, and the process has no
CPU load after the first 2 minutes of the wait. A question of the agent is no permission request. Codex writes no file
that tells a permission prompt, so a Codex session outside Megachat that waits for a permission shows as `working`,
and after 10 minutes as `stuck`. Megachat links a process to its log only when the link is certain: Codex keeps its
log open, Claude Code writes `~/.claude/sessions/<PID>.json`, and for pi the log must begin in the first 30 seconds of
the process. A session without a certain link has no title and no status, and the answer says so. A `codex app-server`
gives one row for each open session. Then ask "what is session X doing?": the main agent reads the last messages of
the session from the end of its log, also for a log of hundreds of MB. Without the consent, Megachat reads no session
log, and the answer says so.

## Notes about the sessions that wait

With `sessions.notes` on, Megachat tells you in the chat when an agent session on the machine waits for you for a long
time. Say "tell me when a session waits for me" to turn it on. It is off by default. The notes read the session logs, so
they also need the consent `sessions.index`. Without it, they stay off, and the settings say why.

- **What gives a note.** A session outside Megachat that seems to wait for a permission for 5 minutes or more, from the
  process file of Claude Code, and a session that is `stuck`: an open step and no log write for 10 minutes. A child of
  Megachat that waits for a permission gets no note, because the chat shows its dialog. A session after a finished turn
  gets no note, because that is the usual state of a session. A Codex session outside Megachat that waits for a
  permission shows as `stuck` after 10 minutes, because Codex writes no file that tells the wait.
- **One note for each session and state.** The note comes one time. A session gets a second note only when it leaves
  the state and comes back, for example a new permission prompt. Sessions that need a note at the same time come in one
  note, with one line for each session: the agent, the project, the title, the state and how long. A restart of the
  daemon gives no second note: the state keeps a record of each note, without a title or a path.
- **The text.** A note starts with "Megachat note:". It is a fixed text, and it says that the state is a reading of the
  logs, not a message of the agent. Look at the session before you act. The main agent sees the note in its next turn,
  and it does not take it as a request.
- **The cost.** A note costs no model request. The daemon writes it into the conversation as a message of the
  assistant, without a turn, and the chat shows it at once. When a turn runs, the note waits for its end. The next turn
  sends the note to the model as a few more input tokens.
- **The working day.** No note goes out while the conversation sleeps (see [The prompt cache](#the-prompt-cache)). A
  session that still waits when the conversation wakes, at `workday.start` or at your next message, gets its note then.
  A wait that ended at night gives no note. A note does not wake the conversation and starts no keep-alive request.
- **Privacy.** A note holds the title and the project name of a session. It goes only into the conversation, as an
  answer of `agents_running` does. The log of the daemon gets the count of the sessions only.

The daemon checks the sessions every minute while the notes are on, with the same `ps` call as `agents_running`.

Megachat 0.3.0 opens a state with a note: it shows the note as a message of the assistant, and it keeps the records.

## Stop an orphan session

Ask the agent "stop the orphan sessions" or "stop PID 4242". The main agent calls its tool `agents_stop`, and the
chat shows a permission dialog with each PID, its agent and its project. Only your answer in that dialog sends the
signal. The main agent cannot answer it, and no argument of the tool sends a signal. After your answer, Megachat reads
the processes again. It sends `SIGTERM` only when each process has the same PID, the same start time and the same
command, and is still an orphan.

The dialog is valid one time, for 5 minutes, and only while the turn of the request runs. A Stop of the turn closes it.
When two chat windows show the dialog, the first answer counts, and the other dialog closes. A dialog of a request that
closed sends no signal. When no chat window is open, the request expires, and the agent asks you to open the chat.
`SIGKILL` goes out only to a process that got `SIGTERM` from the tool and still runs, after a second dialog. An
automatic turn, such as a child result or the morning report, cannot stop a process.

Megachat stops only an orphan. A session with a live owner (an IDE, a terminal, a multiplexer or a Megachat run) goes
through its owner, and the answer names the owner. A session in the state `unknown` is not stopped either. Megachat never
stops PID 1, the daemon, the processes above the daemon, or a process of another user. The log of the daemon holds the
PIDs and the outcome only. The tool works on macOS only.

## The index of past sessions

With your consent, Megachat keeps an index of your past Claude Code, Codex and pi sessions. Then the main agent and
the children find an earlier session at once, and they can read pi sessions. The same consent lets `agents_running`
read the log of each agent session that runs on the machine: its metadata and its status, and its content only when
you ask for it. The setup asks one time: "Index past Claude, Codex and pi sessions in your projects, and read the logs
of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only
when you ask. Everything stays local." Say "turn on the session index" or "turn off the session index" in the chat at
any time. Without your consent, Megachat reads no session file and keeps no index file. The search in Claude Code and
Codex sessions then reads them live, as before.

- **What is in it.** The sessions in `~/.claude/projects`, in `~/.codex/sessions` and `~/.codex/archived_sessions` (or
  the same directories in `$CODEX_HOME`), and in `~/.pi/agent/sessions` (or `PI_CODING_AGENT_SESSION_DIR`), also the
  Codex sessions that Codex compressed to `.jsonl.zst` after 7 days, only when the directory of a session is a listed
  directory or a directory in one: a project of an IDE, a known repository, or the Megachat workspace. A newly listed
  directory brings its old sessions. The import takes the sessions with activity in the last 180 days, and the setting
  `sessions.days` changes that count.
- **What it keeps.** For each session: the agent, the session ID, the directory, the title, the start time and the time
  of the last activity. For each message, tool call and tool result: at most about 2 KB of its text.
- **Where it is.** `sessions.sqlite` in the state directory, with the mode 0600. Nothing leaves the machine.
- **Secrets.** Before the index keeps a text, it replaces what looks like a secret with `[secret removed]`: API keys
  with well-known prefixes such as `sk-`, `ghp_` or `AKIA`, Bearer tokens, private keys, JWTs, assignments such as
  `password=...` (a value in quotes as a whole, so a passphrase with spaces goes too), the password of a URL such as
  `https://user:password@host`, Basic authentication, `curl -u user:password`, and the path segment after `/wire/` of a
  URL, where the base URL of Central holds its key. The name, the user and the host stay. The import also removes the
  exact key and base URL of Central after the daemon read them. This is a best effort. A secret of another shape can stay in the index. A new build with a change of the
  filter makes the index again one time.
- **The import.** The first pass runs in the background, the projects of an IDE first and the newest sessions first.
  The chat lists it as a background task with its progress. After the first pass, the main agent tells you the count of
  the sessions and of the projects, and the last unfinished sessions. When your message interrupts this summary, it
  comes one more time after your turn. Then the index catches up at the start of the
  daemon and on each change of a session file. It reads only the new lines of a file.
- **The size.** One measurement with 100,000 synthetic messages of 2 KB gave a file of 640 MB. Real text takes less
  room, but plan for some hundreds of MB. The age limit and the limit of 2 KB for each message bound the file.
- **The live table.** The same consent covers the table of `agents_running`: for each session file on the machine, the
  path, the inode, the size, the agent, the session ID, the directory, the title, the start time, the time of the last
  write and the last step, and no message text. It reads the head and the last 64 KB of each file, the files of the
  last 24 hours first, then only the appended lines. A file with a write in the last hour gets a poll of its size every
  2 seconds. The table stays in `sessions.sqlite` across a restart. An archived or a compressed Codex session is not in
  the table, because no session runs in such a file.
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
| `src/PromptCacheKeepAlive.mjs` | The timer of the idle daemon: a keep-alive request or a summary before the prompt cache expires, and the sleep outside the working hours. |
| `src/Workday.mjs` | The working day: the pure functions that tell whether a time is in the working hours, the next start of a working day, and the period of a report, with the timezone through `Intl`. |
| `src/MorningReport.mjs`, `src/Tokprof.mjs` | The timer of the morning report, the collection of its data, and the read of the spend of the other agent sessions from tokprof. |
| `src/MegachatUpdate.mjs` | The automatic update: the check of the release tags with `git ls-remote`, the notice, the conditions and the time of the stop of a copy of npx, and the message after an update with the notes of the GitHub releases. |
| `src/AcpBridge.mjs` | The ACP agent side. It lists the unfinished child runs as background tasks, with their Stop and their transcript. |
| `src/ChildTranscript.mjs` | The transcript of each child run, its limit, its secret filter and its removal with the run. |
| `src/AcpRunService.mjs`, `src/child-supervisor.mjs`, `src/RunProcesses.mjs` | The Claude and Codex child runs. The supervisor stops the child when the daemon exits, and at a stop or a failure of a task it ends each process that the task started. |
| `src/ChildPool.mjs` | The places for the child runs, which the ACP and the pi run services share: the limit `children.parallel`, one child in a checkout, and one pi child. |
| `src/PiRunService.mjs`, `src/PiChild.mjs`, `src/ProjectReadEnv.mjs`, `src/PiChildHistory.mjs` | The pi child runs: their conversations in the harness, the choices and the rules of a child, the read-only environment of its project, and the read of its transcript. |
| `src/CentralConfigurationService.mjs`, `bin/pi`, `bin/codex` | The Central configuration and the launch of the children. |
| `src/AgentAccountCheck.mjs` | The check of the accounts of Claude Code and Codex, without a prompt. |
| `src/DaemonServer.mjs`, `src/DaemonClient.mjs`, `src/DaemonDirectory.mjs` | The local HTTP server, its client, the owner lock and the connection file. |
| `src/ReplyStream.mjs` | The stream of the partial reply of the main agent from the daemon to each client. |
| `src/MegachatBuild.mjs`, `src/sourceBuildId.mjs` | The version of the build, from `git describe` in a checkout, and the build ID. |
| `src/MegachatInstall.mjs` | The command `install`: the checks and the entry in `acp.json`. |
| `src/npmEnvironment.mjs` | The environment of the IDE for the daemon and the children, when `npx` started Megachat. |
| `src/ProjectDirectories.mjs` | The directories where a child can work: the checks of a known repository, the origins of the list, the discovery of the repositories, and the directory of a new project. The real path of a directory, and the check that one directory holds another. |
| `src/RunningAgents.mjs`, `src/AgentProcesses.mjs`, `src/ProcessTable.mjs` | The tool `agents_running`: the view of the running sessions, the rules that find an agent session and its owner, and the process table of macOS. |
| `src/AgentStop.mjs` | The tool `agents_stop`: the stop requests for the dialog of the client, the answer of the user, the check of the process directly before the signal, and the refused PIDs. |
| `src/SessionCatalog.mjs`, `src/SessionLinks.mjs`, `src/SessionStatus.mjs`, `src/SessionTail.mjs` | The live table of the session files, the certain link of a process to its log, the status from the log tail, and the read of a log from its end. |
| `src/SessionNotes.mjs` | The notes about the sessions that wait: the rules of a note, its text, the records of the sent notes and the timer of the checks. |
| `src/DailySpend.mjs` | The count of the spend of the main agent on each day, and the cost of one request. |
| `src/MegachatMemory.mjs` | The learned memory: the parse of `memory.md`, the checks of an entry, the address of an entry, the write with the second read, the versions, and the section of the prompt. |
| `src/MemoryReflection.mjs` | The reflection of the learned memory: the transcript of a pass, the parse of the answer, the writes, and the schedule. `resources/reflection.md` holds the prompt of a pass. |
| `src/Settings.mjs` | The settings: the registry of each setting with its key, default, variable and validation, the settings that can have a project value, the file `settings.json`, and the precedence. `resources/instructions-onboarding.md` holds the setup rules, and `resources/instructions-onboarding-ghost.md` holds the added setup rules of the mode `ghost`. |
| `src/Suggestions.mjs` | The modes of the next-step suggestions, and the prompt suggestion of the mode `ghost` with its ACP update. `resources/instructions-suggestions.md` and `resources/instructions-suggestions-ghost.md` hold the rules of the modes `reply` and `ghost`. |
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
It also sets `MEGACHAT_RELEASE_REPOSITORY` to a path that does not exist and `MEGACHAT_RELEASE_NOTES_URL` to a local
address, so no test asks GitHub for a release. `test/update.test.mjs` uses a local git repository with tags, a local
HTTP server for the notes, and `MEGACHAT_UPDATE_START_DELAY_MS` for a short wait of the first check.
`npm run build` writes the bundle into `out/bundle/` with `THIRD_PARTY_NOTICES.txt` for the bundled packages. Git
ignores `out/`. `npm run test:bundle` builds the bundle into `out/bundle/` and runs `test/bundle.test.mjs` on it.

`npm run test:package` runs `npm pack`, installs the package into a temporary prefix with a temporary npm cache, and
tests that copy: its daemon, its Claude and Codex agents, and its `install`. Then it runs the `npx` entry on a
temporary git repository with release tags, as the IDE does, and adds a higher tag. Each of the two tests takes about
1 GB and one to two minutes, so `npm test` does not run them. In one run, the network failed, npm installed the copy
without the optional package `@openai/codex-darwin-arm64`, and the Codex agent of the copy failed with
`Missing optional dependency`. The next run passed.

In a fresh clone, `npm test` skips the bundle test, because `out/bundle/` does not exist. After a build, `npm test`
tests the last build, and that build can be older than the source. Only `npm run test:bundle` tests a new build.

`node test/live/smoke.mjs [<scenario>...]` is the live smoke run. It starts the daemon of the checkout with the real
main agent through Central and real Claude, Codex and pi children, and it drives the daemon with a scripted ACP client
that sends what Air sends. It checks the reply stream, the prompt suggestion, the project rules of a Claude child, the
permission mode and the model of a Claude child, the rows of the background tasks with their Stop and their transcript,
the parallel children, the steering, a Codex and a pi child, the wait of a child result outside the working hours, a
restart of the daemon during a child, a reply with two tool calls in three turns in a row, the withdrawal of the prompt
suggestion at a change of the mode, the answer of the main agent about a task whose result waits, the error of a
child run that fails, and the end of the processes of a child run. The scenarios are `chat`, `suggest`, `rules`,
`permissions`, `tasks`, `steer`, `others`, `workday`, `restart`, `twotools`, `withdraw`, `waiting`, `failures` and
`processes`. Without a name, all of them run, in about 60 minutes. Numbers after a colon select the items of the
scenarios `failures` and `processes`, for example `failures:14.3b,14.4c`.

- The run uses the Central account of the machine and costs real money. One full run cost about 0.5 USD for the main
  agent and the pi children in the count of the daemon. The Claude and Codex accounts paid for about 25 small children,
  and the daemon does not count that cost.
- Each scenario gets a new state home and new throwaway projects in one new temporary directory. The run refuses a
  home outside the temporary directory. It sets `MEGACHAT_ACP_CONFIG` to a temporary file and turns off the keep-alive
  requests. It does not turn on the index of past sessions.
- The run reads the Central configuration into its memory, removes its key and its address from each text that it
  prints or keeps, and lists each file of the run that holds one of them. The scenario `permissions` starts the Claude
  adapter through `test/live/tap.mjs`, which records the mode and the model of each child. The run also reads the
  session file of Claude Code of its own children for the model that they used.
- The scenario `failures` sends SIGKILL to a process of its own child run. It finds the process by the PID in the
  state of its home and checks its command line first. 3 seconds after the end of that run, each process of the run
  that still runs with the same command line also gets SIGKILL, and the report lists it. After a kill of the Claude
  Code process, no process of the run may run when the continuation starts. The scenario also starts Claude children
  with agent commands that fail at their start, through `MEGACHAT_CLAUDE_ACP` and files in the temporary directory.
- The scenario `processes` stops Claude children during a shell command, through the Stop of a row and through
  `agents_cancel`, also with commands in the background, and it lets one child complete with a command in the
  background. It lists the processes under the supervisor of the run and the PIDs that the commands of the child write
  to files of the project, and it records the end of each one. It also starts one `sleep` of its own outside the runs,
  which must still run after each end. 3 seconds after the end of a run, each process of the run that still runs with
  the same command line gets SIGKILL. One child runs a script that stops and starts the daemon of its home. The script
  holds the absolute paths, and it refuses each home outside the temporary directory of the run. A dry run with `echo`
  in place of the two daemon commands checks the paths first.
- The output gives one line for each item, and `report.json` in the temporary directory gives the evidence. A turn of
  the main agent without an answer after 4 minutes is a stall: the run keeps the evidence, starts the daemon again, and
  goes on. `npm test` does not run the live smoke run.

`node test/bench/session-index.bench.mjs [entries]` measures the import, the longest block of the event loop and the
search latency of the index of past sessions on a synthetic corpus. `npm test` does not run it.

The requirements are in `openspec/specs/`, one capability in each folder. `openspec list --specs` lists them. The
records of the manual checks are in `docs/manual-checks.md`. The ACP extensions that Megachat and Air exchange are in
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

A copy of the install line comes from a release tag and has no `.git`, so it gives the release form of the version,
such as `0.4.0`. A copy without `.git` from another place, such as `npm pack`, also gives that form. The build and the
tests of `npm run release` run before the tag, so they see the form `<version>+g<commit>`. No copy of that run is
published.

## License

Megachat has the Apache License 2.0. The text is in `LICENSE`. Each npm package that Megachat installs keeps its own
license.

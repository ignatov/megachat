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

The line installs a copy of the last release of Megachat in the npm cache. A release is a tag `v<version>` of this
repository, and `#semver:x` selects the tag with the highest version. Keep the quotation marks: a zsh with the option
`extendedglob` reads `#` as a pattern.

The line checks what the machine needs, and prints one line for each result. Then it adds the entry `Megachat` to
`agent_servers` in `~/.jetbrains/acp.json`. The entry starts the installed copy directly with Node.js, not with `npx`.
The last line gives the version and the directory of the copy. The exit code is 0 only when the entry is in place and
each check passed.

The machine needs:

- git, and access to `github.com`. The repository is public, so the line needs no GitHub account.
- Node.js 22.19 or later.
- The Central command at `~/.local/bin/central`, with a login: `central login`.
- Claude Code at `~/.local/bin/claude`, set up through Central: `central add claude-code`.
- The Codex command, `codex`, on the `PATH`.
- macOS. Nobody tested Megachat on another platform.

The first run takes about a minute, and the copy takes about 870 MB in the npm cache. On each run, `npx` asks GitHub
for the tags, and it installs the package again only after a new release. So the entry does not use `npx`.

The installed copy does not use `package-lock.json`. So its indirect dependencies can differ from the tested ones.

The entry has no `application_session` key. An IDE build from before the Air change needs that key. Nobody verified
Megachat on such a build.

When `acp.json` has another entry `Megachat`, the line does not change the file. It prints both entries and what to
do. Two copies of Megachat on one machine replace the daemon of each other.

**Update.** Run the same line. It installs the last release in the same directory, so the entry stays. The daemon of
the earlier copy stops at the next attach of the IDE, and the daemon of the new copy starts.

**Removal.** Delete the entry `Megachat` from `~/.jetbrains/acp.json`. Then run `npx clear-npx-cache`, or delete the
directory `_npx/<hash>` in the path that `install` printed in its last line.

## Install from a checkout

The checkout needs the same tools. Then run:

```sh
npm ci
node src/main.mjs install
```

`npm ci` takes each package from `registry.npmjs.org`. npm 11.19 runs no install script that `allowScripts` does not
name, so it skips the scripts of `esbuild`, `protobufjs` and `@google/genai`. The build still works, because npm
installs `@esbuild/darwin-arm64` as an optional dependency.

`install` adds the entry `Megachat`, which starts `bin/megachat.mjs acp` of the checkout. Keep the name `Megachat`:
Air derives the agent ID `acp.megachat` from it. An IDE build from before the Air change also needs
`"application_session": true` in the entry. After that change, Air knows Megachat by its ID and ignores the key.

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
| `install` | Checks the machine and adds the entry `Megachat` of this copy to `~/.jetbrains/acp.json`. `MEGACHAT_ACP_CONFIG` replaces the path of the file. |

## The state directory

The state is in `~/.jetbrains/air/megachat`, and on Windows in `%USERPROFILE%\.jetbrains\air\megachat`. Each
JetBrains product of the user shares it. `MEGACHAT_HOME` or the directory argument selects another directory.

| File | Content |
|---|---|
| `conversation.sqlite` | The conversation, the child runs and the permission requests. |
| `owner.sqlite` | The lock of the daemon. One daemon owns the directory. |
| `search.sqlite` | The search index. The daemon builds it again from the conversation when necessary. |
| `instructions.md` | Your own rules, optional, at most 64 KB. The bundled rules keep priority. A restart of the daemon applies a change. |
| `daemon/connection.json` | The process ID, the port, the build and the token of the running daemon. Keep the token private. |
| `daemon/daemon.log` | The log of a daemon that `start` started. |

Each directory has the mode 0700, and each file has the mode 0600. When the shared directory has no conversation, the
daemon copies it once from `~/Library/Application Support/JetBrains/AirMegachat`. `MEGACHAT_LEGACY_DIRS` replaces that
list.

## The size of the model context

The daemon sends the conversation to the model with each request. Above 100,000 tokens, it replaces the older part
with a summary, and it keeps about 20,000 recent tokens as they are. `MEGACHAT_COMPACT_TOKENS` in the environment of
the daemon replaces the limit. The summary keeps your standing agreements, the open child tasks, the questions that
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

The keep-alive requests stop 6 hours after the last turn. The log of the daemon has one line with the token counts
of each keep-alive request and of each summary request.

| Variable of the daemon | Effect |
|------------------------|--------|
| `MEGACHAT_CACHE_TTL` | `1h` is the default. `5m` asks for the 5-minute cache, and the idle daemon then acts after 4 minutes 10 seconds. |
| `MEGACHAT_KEEPALIVE_HOURS` | The time after the last turn in which keep-alive requests go out. The default is `6`. |
| `MEGACHAT_KEEPALIVE` | `0` stops the keep-alive requests and the summary of an idle conversation. |

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
| `src/AcpRunService.mjs`, `src/child-supervisor.mjs` | The child runs, one at a time. The supervisor stops the child when the daemon exits. |
| `src/CentralConfigurationService.mjs`, `bin/pi`, `bin/codex` | The Central configuration and the launch of the children. |
| `src/DaemonServer.mjs`, `src/DaemonClient.mjs`, `src/DaemonDirectory.mjs` | The local HTTP server, its client, the owner lock and the connection file. |
| `src/MegachatBuild.mjs`, `src/sourceBuildId.mjs` | The version and the build ID. |
| `src/MegachatInstall.mjs` | The command `install`: the checks and the entry in `acp.json`. |
| `src/ProjectWatchService.mjs` | The watch of the project paths, which gives the proposals. |
| `src/MegachatSearchIndex.mjs`, `src/MegachatHistoryServer.mjs` | The search index of the conversation, and its read-only MCP tool for the children. |
| `src/SessionHistoryService.mjs`, `src/ClaudeSessionHistoryService.mjs`, `src/CodexSessionHistoryService.mjs`, `src/CodexAppServerClient.mjs` | The search in the Claude and Codex sessions of the registered projects. |
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
tests that copy: its daemon, its Claude and Codex agents, and its `install`. It takes about a minute and 870 MB, so
`npm test` does not run it.

In a fresh clone, `npm test` skips the bundle test, because `out/bundle/` does not exist. After a build, `npm test`
tests the last build, and that build can be older than the source. Only `npm run test:bundle` tests a new build.

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
`origin/main`, and a version that is not higher than the last release. Then it runs `npm test` and
`npm run test:package`. Then it makes the tag, pushes it, and makes the GitHub release with `gh`. The notes of the
release are the subjects of the commits since the last release. `npm run release -- --dry-run` prints the release and
changes nothing.

## License

Megachat has the Apache License 2.0. The text is in `LICENSE`. Each npm package that Megachat installs keeps its own
license.

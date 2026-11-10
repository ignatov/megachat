# Megachat

Megachat is one durable chat for a user on a machine. It is an ACP agent for JetBrains Air.
Each project window and each JetBrains product of the user opens the same conversation.
The main agent delegates file and command work to Claude Code and Codex, and lists that work as background tasks.
A daemon keeps the conversation and the work when the IDE closes.
All model traffic goes through JetBrains Central.

## Needs

- macOS.
- Node.js 22.19 or later.
- The Central command at `~/.local/bin/central`, with a login.
- Claude Code at `~/.local/bin/claude`.
- The Codex command, `codex`, on the `PATH`.

## Install

```sh
npm ci
```

`npm ci` takes each package from `registry.npmjs.org`. npm 11.19 runs no install script that `allowScripts` does not
name, so it skips the scripts of `esbuild`, `protobufjs` and `@google/genai`. The build still works, because npm
installs `@esbuild/darwin-arm64` as an optional dependency.

Then add the entry `Megachat` to `agent_servers` in `~/.jetbrains/acp.json`. Use absolute paths:

```json
{
  "agent_servers": {
    "Megachat": {
      "command": "/opt/homebrew/bin/node",
      "args": ["/Users/<user>/src/megachat/src/main.mjs", "acp"],
      "application_session": true
    }
  }
}
```

Keep the name `Megachat`: Air derives the agent ID `acp.megachat` from it. `application_session` is for an IDE build
from before the Air change. After that change, Air knows Megachat by its ID and ignores the key.

## Commands

Run each command as `node src/main.mjs <command> [<directory>]`. The optional directory selects a state directory of
its own, for a test or for development.

| Command | What it does |
|---|---|
| `start` | Starts the daemon in the background when no daemon runs, and waits until it answers. It replaces a daemon of another build. |
| `status` | Prints the current task and the state of each child run as JSON. |
| `stop` | Stops the daemon. |
| `acp` | Starts the daemon when necessary and speaks ACP on the standard input and output. The IDE runs this command. |
| `daemon` | Runs the daemon in the foreground. `start` runs this command. |

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

## Code map

| Files | Content |
|---|---|
| `src/main.mjs` | The commands. `start` connects to the daemon, replaces a daemon of another build, uses a live daemon of a legacy directory, or starts a new daemon. |
| `src/MegachatHome.mjs` | The state directory, the legacy directories, the migration, the schema check, and the rules of the user. |
| `src/MegachatState.mjs` | The durable admission, the child runs, the permissions, the proposals, the continuation of an interrupted run, and the retention. |
| `src/PiMegachatService.mjs` | The main agent on the Pi Durable harness, and the `agents_*` tools. `resources/instructions.md` holds its bundled rules. |
| `src/AcpBridge.mjs` | The ACP agent side. It lists the unfinished child runs as background tasks. |
| `src/AcpRunService.mjs`, `src/child-supervisor.mjs` | The child runs, one at a time. The supervisor stops the child when the daemon exits. |
| `src/CentralConfigurationService.mjs`, `bin/pi`, `bin/codex` | The Central configuration and the launch of the children. |
| `src/DaemonServer.mjs`, `src/DaemonClient.mjs`, `src/DaemonDirectory.mjs` | The local HTTP server, its client, the owner lock and the connection file. |
| `src/MegachatBuild.mjs` | The version and the build ID. |
| `src/ProjectWatchService.mjs` | The watch of the project paths, which gives the proposals. |
| `src/MegachatSearchIndex.mjs`, `src/MegachatHistoryServer.mjs` | The search index of the conversation, and its read-only MCP tool for the children. |
| `src/SessionHistoryService.mjs`, `src/ClaudeSessionHistoryService.mjs`, `src/CodexSessionHistoryService.mjs`, `src/CodexAppServerClient.mjs` | The search in the Claude and Codex sessions of the registered projects. |
| `src/messages.mjs`, `resources/Megachat.properties` | The user-visible strings and the errors. |
| `build.mjs` | The bundle in `out/bundle/`. |

## Tests

```sh
npm test
npm run test:bundle
```

`npm test` runs each `test/*.test.mjs` file. `test/state-guard.mjs` gives each test process a temporary
`MEGACHAT_HOME`, so a test cannot reach your conversation. `npm run test:bundle` builds the bundle into `out/bundle/`
and runs `test/bundle.test.mjs` on it.

In a fresh clone, `npm test` skips the bundle test, because `out/bundle/` does not exist. After a build, `npm test`
tests the last build, and that build can be older than the source. Only `npm run test:bundle` tests a new build.

The requirements are in `docs/spec.md`. The ACP extensions that Megachat and Air exchange are in
`docs/air-contract.md`. The later work is in `docs/roadmap.md`.

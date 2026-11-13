# Design

## Context

See proposal.md, "Why", for the problem. The present code:

- `CentralConfigurationService.childEnvironment()` reads `apiKeyHelper` and `env.ANTHROPIC_BASE_URL` of
  `~/.claude/settings.json`, runs the helper, and validates the result (`http:`, `127.0.0.1`, a path under `/wire/`).
  It always sets `CLAUDE_CODE_EXECUTABLE` to `~/.local/bin/claude`. `claude-agent-acp/dist/claude-cli.js` uses that
  variable first. Without it, the agent resolves `@anthropic-ai/claude-agent-sdk-<platform>-<arch>/claude` from the SDK.
- `childLaunch('codex')` starts `central run codex --` with `bin/` first on the `PATH`. Central starts `codex` of the
  `PATH`, which is `bin/codex`. The shim starts the Codex ACP with `CODEX_PATH` set to the shim and the arguments of
  Central in `MEGACHAT_CODEX_ARGS`. The Codex ACP then starts `CODEX_PATH app-server ...`. The shim adds the arguments
  of Central and starts `codex` of the `PATH` without `bin/`.
- `codexAppServerLaunch()` starts `central run codex -- app-server --listen stdio://` with the base environment, so
  Central starts `codex` of the `PATH` directly.
- `install` (`checks()` in `src/MegachatInstall.mjs`) fails without `~/.local/bin/claude`, without its Central entry,
  and without `codex` on the `PATH`. Its PATH search ignores a `node_modules/.bin` directory.

Facts from a check on 2026-11-13 with Central 2026-11-13 on macOS arm64. The check printed no key:

1. `central run claude -- x` with a fake `claude` and a clean environment: Central passes only `--settings <JSON>`
   with `availableModels`, `enforceAvailableModels`, `modelPicker` and `env.CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY`.
   It passes no base URL and no key, because `~/.claude/settings.json` of this machine already has the Central entry.
   Central ignores `CLAUDE_CONFIG_DIR`. So the check could not show what Central passes on a machine without that
   entry without a change of `~/.claude` of the user.
2. `central run codex -- x` with a fake `codex`: on this machine (`model_provider = 'wire'` in `~/.codex/config.toml`)
   Central passes no argument. With an empty `CODEX_HOME`, Central passes `--profile jetbrains-central` and four `-c`
   overrides of the provider, and writes `$CODEX_HOME/jetbrains-central.config.toml`. Central does not ask the binary
   for `--version`. With an empty `HOME`, Central says "not logged in", because its login is in `~/.jetbrains-central`.
3. The base URL of `central run pi` has the path `/wire/<key>/pi/anthropic`. The base URL of the Claude Code entry has
   `/wire/<key>/claude-code/anthropic`. The keys are different. The port is the same.
4. The bundled `claude` binary (`@anthropic-ai/claude-agent-sdk-darwin-arm64`, SDK 0.3.321) with an empty `HOME`,
   `ANTHROPIC_BASE_URL` and `ANTHROPIC_API_KEY` of `central run pi`, and `-p` with the model `claude-haiku-4-5`
   answered `ok` with the exit code 0.
5. The bundled `codex` (`@openai/codex` 0.166.0) behind `central run codex -- exec`, with an empty `CODEX_HOME` and no
   other `codex` on the `PATH`, answered `ok` with the exit code 0.
6. `CodexSessionHistoryService.list()` against `node @openai/codex/bin/codex.js app-server --listen stdio://` with an
   empty `CODEX_HOME` returned a page with `sessions` and `nextCursor`.
7. `@openai/codex/bin/codex.js` replaces its node process with the native binary (`process.execve`), and it sets
   `CODEX_MANAGED_BY_NPM=1` and `CODEX_MANAGED_PACKAGE_ROOT`.
8. Without `CODEX_PATH`, the Codex ACP starts its own `@openai/codex/bin/codex.js`. It also has the subcommand `cli`,
   which runs `CODEX_PATH` or that same file.

## Goals / Non-Goals

**Goals:**

- A Claude child, a Codex child, the Codex history and `install` work with Central and its login only.
- A machine that has Claude Code and Codex of the user keeps its present behavior.

**Non-Goals:**

- A change of the agents, of their versions, or of `package.json`.
- A change of `~/.claude`, `~/.codex` or the configuration of Central by Megachat. Central itself writes
  `jetbrains-central.config.toml` into `CODEX_HOME` when it starts Codex, as it does now.
- A Codex child of the Air bundle without `codex` on the `PATH`.

## Decisions

### D1. Claude Code of the user first, then the binary of the SDK

`childEnvironment()` sets `CLAUDE_CODE_EXECUTABLE` only when `~/.local/bin/claude` is an executable file
(`access(X_OK)`, the same test as `install`). Else it sets no such variable, and the agent starts the `claude` binary
of its SDK. With an IDE-passed Claude ACP, that is the binary of the agent of the IDE.

Alternative: always the binary of the SDK. For it: the version of the binary is the version that
`claude-agent-acp` 0.102.0 pins (SDK 0.3.321), the tests run that version, and each machine gets the same behavior.
Against it: a machine that works today changes its Claude Code, and the user loses the Claude Code version that the
user keeps up to date. A Claude child loads no settings file of the user (see the capability `claude-child`), so the
order changes only the version, not the settings. The proposal keeps the present behavior where it works. The author
can select the other order at the review: that changes one sentence of the `launch` delta and the install lines.

### D2. The Central entry of Claude Code first, then the configuration of the main agent

`childEnvironment()` first tries the present path: `apiKeyHelper` and `env.ANTHROPIC_BASE_URL` of
`~/.claude/settings.json`, which `central add claude-code` writes. When it fails for any reason (no file, no
`apiKeyHelper`, a helper that fails, a configuration that is not valid), it calls `pi()`, uses its `baseUrl` and
`apiKey`, and writes the log line `log.central.claudeFallback` with only the name and the code of the first error.
When `pi()` fails too, it throws `MegachatError('central')` as now. `remember()` gets the values of each source, so the
secret filter knows them.

Alternatives:

- `central run claude` with a capture shim, as `bin/pi` does for pi. Rejected now: fact 1 shows that on a machine
  with the entry Central gives no key, and the behavior without the entry is unknown.
- A rewrite of the path `/pi/` to `/claude-code/`. Rejected: it depends on the inside of Central, and fact 3 shows a
  different key for each route.
- A run of `central add claude-code` by Megachat. Rejected: it writes `~/.claude/settings.json` of the user.

Trade-off: Central counts the requests of such a child on the route of pi (fact 3). Fact 4 shows that the route
serves the requests of Claude Code.

**Does `central add claude-code` need a Claude Code CLI?** Not known. The facts, without a run of `add` against the
real home directory:

- `central add --help` names no requirement.
- The documentation of Central (https://www.jetbrains.com/help/central-cli/) says: "JetBrains Central CLI configures
  agents but does not install them", and lists "at least one supported agent" as a requirement. The pages about `add`
  and `agents` do not say what `add` does when it does not find the agent.
- `central agents --json` reports `installed` and `configured` apart. With the real home directory and a `PATH`
  without `~/.local/bin`, Claude Code is `installed: false, configured: true`. So Central finds Claude Code only as
  `claude` on the `PATH`.
- The strings of the binary hold no message that refuses an agent that is not installed.
- With an empty `HOME`, `central add claude-code` stops at "not logged in — run 'central login' first" before it
  looks for the agent. The login cannot go into a temporary home without a copy of its credentials.

With the fallback, a Claude child does not need `central add claude-code`, so the answer only tells the README.

### D3. `bin/codex`: Codex of the user first, then the Codex of the Codex ACP

In the branch with `MEGACHAT_CODEX_ARGS`, the shim searches the `PATH` without `bin/` for an executable file `codex`.
When it finds one, it starts it as now. Else it starts `process.execPath` with `@openai/codex/bin/codex.js`, which it
resolves with `createRequire` bound to `@agentclientprotocol/codex-acp` that npm installed. So the version is the
version that the Codex ACP declares (`^0.166.0`). Fact 7: the process becomes the native `codex`, so the scans of
running sessions, of session logs and of stop requests see the same process as before. When the shim finds neither,
it exits with the code 1, as now.

The shim cannot import `src/`, because the bundle keeps `bin/` as files and bundles `src/`. So it has its own PATH
search of a few lines.

Alternatives:

- The subcommand `cli` of the Codex ACP (fact 8). It also works for an IDE-passed Codex ACP, but it adds a node
  process and depends on a subcommand outside the ACP. It stays an open question for the bundle.
- A direct path to the native binary. Rejected: it copies the table of targets of `codex.js`.

Central needs no Codex of its own: it starts `codex` of the `PATH` (fact 2), which is the shim.

### D4. The app-server of the Codex history through the shim

`codexAppServerLaunch()` puts `bin/` first on the `PATH`, as `childLaunch('codex')` does, and sets
`MEGACHAT_CODEX_ARGS` to `[]`. Central starts the shim with its arguments and `app-server --listen stdio://`. The shim
takes the branch of D3 at once, so it starts the Codex of the user or of the Codex ACP, and no Codex ACP. Fact 6 shows
that the bundled Codex serves the history API.

### D5. The lines and the exit code of `install`

`checks()` keeps the lines of the platform and of Central. The other lines:

| Case | Key | Text | Ready |
| --- | --- | --- | --- |
| `~/.local/bin/claude` is executable | `install.claude` | A Claude child uses Claude Code at {0}. | binary |
| no such file, the SDK binary resolves | `install.claudeBundled` | Claude Code is not at {0}. A Claude child uses the Claude Code that npm installed with Megachat. | binary |
| neither | `install.claudeMissing` | No Claude Code is available for a Claude child. Install Claude Code at {0}, or run the install line again. | no |
| the settings give a valid entry | `install.claudeKey` | A Claude child gets its key from the Central entry in {0}. | key |
| no valid entry, `pi()` works | `install.claudeKeyPi` | A Claude child gets its key from the pi route of Central, because {0} has no valid Central entry. Run "central add claude-code" to give Claude children the route of Claude Code. | key |
| no source | `install.claudeCentral` | A Claude child gets no key from Central. Run "central login", then run the install again. | no |
| `codex` on the `PATH` | `install.codex` | A Codex child uses Codex at {0}. | binary |
| no `codex`, `codex.js` resolves | `install.codexBundled` | The command codex is not on the PATH. A Codex child uses the Codex that npm installed with Megachat. | binary |
| neither | `install.codexMissing` | No Codex is available for a Codex child. Install the Codex CLI, or run the install line again. | no |

Claude is ready with a binary and a key from one of the two sources. Codex is ready with a binary, because `central run codex` passes the route of
Central itself (fact 2), so `central add codex` is not necessary. The exit code is 0 when the entry is in place, the
platform and Central passed, and Claude or Codex is ready. The key check of Claude runs also without a binary.

The PATH search of `install` still ignores a `node_modules/.bin` directory. A new function of
`CentralConfigurationService` resolves the two binaries: the `claude` binary from the SDK of `claude-agent-acp`, with
the candidates of `claude-cli.js`, and `@openai/codex/bin/codex.js` from `codex-acp`. `install` takes the resolver as a
parameter, so a test can make both fail. The check runs no binary.

### D6. Texts of `agents_accounts`

`accounts.fix.central.claude` and `accounts.fix.login.claude` become "Run "central login" in a terminal. Then run the
check again.", as for Codex, because a Claude child no longer needs `central add claude-code`.

### Daemon, state and ACP

- Megachat decides the binary and the key at each start of a child, as now. A run that the daemon admitted keeps its
  process through a disconnect of the ACP client. After a restart of the daemon, a continuation starts a new process
  with the same rules. A later `central add claude-code` or a new Claude Code of the user applies to the next child.
- The change adds no field to `conversation.sqlite`, `settings.json` or another state file. It reads
  `~/.claude/settings.json` (`apiKeyHelper`, `env.ANTHROPIC_BASE_URL`) as now, and it reads whether
  `~/.local/bin/claude` is executable. An older state directory needs nothing.
- The change adds and reads no ACP message and no `_meta` key. The key stays only in the environment of the child.

## Risks / Trade-offs

- [Central limits or counts the requests of Claude Code on the route of pi in another way] → The entry of
  `central add claude-code` stays first, and the `install` line tells which source a child uses.
- [Claude Code or Codex of the user has another version than the agent expects] → This is the present behavior. The
  `install` line names the binary. D1 names the other order.
- [npm installed without optional dependencies, so the platform binary is missing] → The `install` line fails and
  names the fix. A child then fails as now.
- [On a machine without Codex, Central writes `jetbrains-central.config.toml` and a plugin cache into `~/.codex`] →
  Central does this also for a Codex child now. Megachat writes nothing there.
- [The test of the shim runs the bundled `codex --version`] → The binary is in `node_modules` of each checkout. The
  test sets `CODEX_HOME` to a temporary directory.

## Migration Plan

No migration. A machine with Claude Code, its Central entry and `codex` keeps its behavior. To go back, revert the
commit.

## Open Questions

- Central counts the requests of a Claude child on the route of pi as pi traffic. Does Central also limit them, or
  allow other models there, than on the route of `claude-code`? A later Central can give a `claude-code` key through
  `central run claude` on a machine without the entry. Then a later change can use that source.
- Does `central add claude-code` work on a machine without Claude Code (see D2)? The answer changes only the README.
- Must `bin/codex` use the subcommand `cli` of an IDE-passed Codex ACP when the `PATH` has no `codex`? That makes a
  Codex child of the Air bundle work without the Codex CLI. It depends on the Codex agent that Air installs.
- Nobody ran the fallback on Linux or on an Intel Mac. npm installs the binary of each platform.

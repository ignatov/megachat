---
name: Megachat
description: One persistent conversation delegates tasks and searches Claude Code and Codex histories.
style: plain-1
targets:
  - ../src/*.mjs
  - ../resources/*
  - ../bin/megachat.mjs
  - ../bin/pi
  - ../bin/codex
  - ../build.mjs
  - ../package.json
---

# Megachat

Status: Implemented
Date: 2026-11-11

## Summary

Megachat is one conversation shared by the projects on a machine. A separate daemon runs Pi Durable, Claude Code, and Codex through Central.

The ACP extensions that Megachat and Air exchange are in [air-contract.md](air-contract.md).

## Requirements

- The daemon must keep admitted work when the ACP client disconnects.
- Opening Megachat must start its daemon if it is unavailable.
  [@test] ../test/recovery.test.mjs
- A large conversation must not disconnect a client while it receives updates.
- An idle client connection must stay open while the daemon is available.
- Waiting for a long task must keep the connection open until the task ends or the client disconnects.
  [@test] ../test/transport.test.mjs
- A permission request must stay pending without a connected client.
- Reconnection must show the pending request without starting the task again.
- Stop must cancel the main task and each child that it owns.
- The main reply must finish without waiting for its children.
- The main conversation must accept new messages while a child works or needs permission.
- New delegated tasks must wait in a durable queue when a child is already running.
- A later user message may cancel an earlier background task.
- The user may delegate a task to Claude Code or Codex.
- Claude Code must remain the default for delegated tasks.
- The user may continue an existing session in its registered project.
  [@test] ../test/integration.test.mjs
- One provider session must have at most one unfinished delegated task.
  [@test] ../test/state.test.mjs
- A repeated request ID must return the original admission.
- A repeated request ID with different arguments must fail.
- An uncertain dispatch must become interrupted after a daemon restart.
- Recovery must not send an uncertain prompt again.
- An interrupted run must continue automatically unless the user cancelled it or it reached a limit.
- A continuation of a sent prompt must resume the same provider session with a prompt to check the work and continue.
- A run that never sent its prompt must send that prompt again.
- A run must receive at most two automatic continuations, each after a longer delay.
- The interrupted run must become resumed and name its continuation. The main conversation must receive one report.
- Cancelling a resumed run must cancel its continuation.
- A failed final continuation must remain interrupted and must be reported.
- An answer from a previous process generation must fail.
  [@test] ../test/state.test.mjs

## User Experience

- The main conversation must use the native ACP chat.
- Megachat must retain the conversation when a project closes.
- The main agent must use Claude Opus 5.5 through Central.
- Changing the main model must keep the existing conversation.
- The agent must know that its conversation persists through an IDE or daemon restart.
- The user may add rules in `instructions.md` in the state directory. They must follow the bundled rules as user preferences.
- User rules must not override the bundled rules. A daemon restart applies a changed file.
  [@test] ../test/home.test.mjs
- The agent must read retained messages when earlier details are absent from its active context.
- History lookup must survive context replacement and a daemon restart.
- History lookup must return timestamps and mark partial results.
- Retrieved messages must grant no new permission.
  [@test] ../test/state.test.mjs
- New delegated sessions must be service sessions when the client supports their registration.
- The ordinary session list must hide these sessions. The daemon must retain their histories.
- Continuing an existing user session must preserve its visibility in the ordinary session list.
- Reconnection must mark earlier delegated sessions too.
- The daemon must keep the address of a delegated session after it drops the runs of that session.
- At 5,000 addresses, it must drop the oldest addresses until 4,000 stay.
- The main conversation must show no child lifecycle rows, tool calls, or child output.
- The chat must not show the main agent's own tool calls. The retained conversation must keep them.
- The chat must not show a row for the main agent's own turn.
- The chat must list each unfinished child task with its title, agent, project, and state: queued, running, waiting for permission, or interrupted and resuming.
- A task title must be at most 60 characters. Without a title from the main agent, it must come from the first prompt line.
- The list must show no run IDs or prompts. A finished task must leave the list.
- Permission requests must appear in the main conversation.
- Reconnection must restore the conversation without child lifecycle rows.
- A completed main reply must arrive before the prompt response.
- History replay must include the earlier user messages.
- Each ACP view must have its own session ID.
- Views in one pooled process must share the conversation and close independently.
  [@test] ../test/integration.test.mjs
- Megachat may offer one useful next step after work ends.
- After a refusal, it may offer two alternatives. After the third refusal, it must stop proposing work.
- A direct request for silence must suppress proposals until the user asks to resume.
- Proposal decisions must survive a daemon restart.
- A new project event may permit another proposal after ordinary refusals.
- An event must not start delegated work without a user request.
- A user message must interrupt an automatic project-event turn.
  [@test] ../test/state.test.mjs
- A child that finishes after the main reply must produce a result in the main conversation.
- A user message must take priority over an automatic result report without losing that result.
- A child must be able to search retained Megachat history through a read-only tool.
- The history token must grant no access to daemon controls.
- An event reply must appear in an attached idle view.
- History replay must hide internal event prompts.
  [@test] ../test/integration.test.mjs
- A result report that fails on a model error or on a daemon stop must be sent once more, after a delay.
- A second failure must end the reports of that result. The result must stay in the history, and the main agent must still be able to read the run.
- A report that the user stopped, or that reached its limit of tool rounds, must not be sent again.
  [@test] ../test/integration.test.mjs
  [@test] ../test/state.test.mjs
  [@test] ../test/recovery.test.mjs
- Session search must include Claude Code and Codex unless the caller selects one provider.
- Search must match session titles and message text in the selected project.
- Reading a stored session must start no model turn and must not resume that session.
- A child must be able to search both providers through read-only tools.
- Long histories must provide continuation cursors, including pages without matches.
- Cursors must remain bound to their project, provider, query, and session where applicable.
- Unavailable histories must mark the search incomplete and preserve other matches.
- Excerpts must identify truncated text.
  [@test] ../test/session-history.test.mjs
- Saved source changes in registered projects may trigger a proposal while the IDE is closed.
- The watcher must ignore generated files and read no source contents.
  [@test] ../test/project-watch.test.mjs

## Data & Backend

- The state must live in `~/.jetbrains/air/megachat/` for each user: `%USERPROFILE%\.jetbrains\air\megachat` on Windows.
- All JetBrains products of the user must share this directory, its daemon, and its conversation.
- `MEGACHAT_HOME` or the final command argument may select another directory for a test or development.
- The directory must hold `conversation.sqlite`, `owner.sqlite`, `search.sqlite`, and `daemon/` with the connection file and log.
- The name `memory.md` is reserved for learned memory that the user can edit. Megachat does not read it yet.
- The directories must be private to the user: mode 0700 for directories and 0600 for files on macOS and Linux.
- Only one daemon may own a storage directory.
- A second daemon must fail at once. A second product must connect to the running daemon.
- A start that loses the race with a concurrent start must stop its own daemon.
- When the shared directory has no conversation, the daemon must copy the conversation once from an earlier directory: `~/Library/Application Support/JetBrains/AirMegachat` on macOS.
- `MEGACHAT_LEGACY_DIRS` may replace the list of earlier directories. An empty value gives an empty list.
- The copy must include committed WAL content and pass an integrity check before the daemon uses it.
- The search index must be rebuilt from the copy.
- The earlier files must stay in place with a `MIGRATED_TO` file that names the new directory. A marked directory must not be copied again.
- The daemon must not copy state that a running daemon owns. Until that daemon stops, a client must use it.
- A directory with an explicit path must not receive a copy.
  [@test] ../test/home.test.mjs
- The local HTTP connection must require the private connection token.
- A history request must return at most 100 entries.
- The daemon must use only project directories registered by a client.
- The daemon must run at most one child at a time.
- It may retain at most eight unfinished child tasks, including queued tasks.
- Claude background tasks must be disabled. A child run ends with its ACP prompt.
- A main task may create at most eight child runs.
- The conversation must have no lifetime limit. The daemon must drop old settled records and keep the work.
- At 1,000 main inputs, the daemon must drop the oldest settled inputs until 500 stay.
- A request ID that the daemon dropped must start a new input.
- At 64 child runs, it must drop the oldest reported runs and their permission requests until 48 stay.
- It must keep each run that an unfinished continuation descends from, and each run that the current result report names.
- A follow-up to a child session without a retained run must fail, as a follow-up to an unknown session does.
- It must refuse permission requests after 32 requests per child.
- At 256 permission requests, it must drop the oldest requests of finished runs until 128 stay. A pending request must stay.
- At 2,000 proposal decisions, it must drop the oldest decisions until 1,000 stay.
- A stored record without its admission time must count as older than each record with one.
- Child output must stop growing at the configured retention limit.
- Project events must coalesce into bounded batches and trigger at most one proposal per project per minute.
- Changes during delegated work must not trigger another proposal.
- Permission waits must suspend the child execution deadline.
  [@test] ../test/integration.test.mjs
  [@test] ../test/state.test.mjs
  [@test] ../test/recovery.test.mjs

## Error Handling

- An agent exit must mark its running task interrupted before it continues.
- Before it opens the state, Megachat must read the Pi Durable schema version.
- A version newer than this build supports must stop the start with "Megachat state was created by a newer Megachat build; update Megachat." It must not change the state.
- A failed integrity check must leave the earlier state unchanged and start no daemon.
  [@test] ../test/home.test.mjs
- The daemon must retain the output of an interrupted task.
- A failed Central configuration must start no child agent.
- Stored conversation data must contain no Central credentials.
- A reply that fails on a model error must tell the user "The model did not answer. Send the message again."
- The state must keep only the reason code of a failed reply, not the error text of the provider.
  [@test] ../test/integration.test.mjs
- A child agent must not stay alive after its daemon. This also applies when the agent still writes output.
  [@test] ../test/recovery.test.mjs

## Non-goals

- Megachat does not install a login service.
- It does not resume a tool call through a daemon crash. The continuation prompt asks the agent to check its work.
- It does not start parallel child tasks.
- It does not expose IDE tools to children.

## Launch

- Megachat must not bundle Claude, Codex, or their platform binaries.
- It must start the Claude and Codex ACP agents whose commands `MEGACHAT_CLAUDE_ACP` and `MEGACHAT_CODEX_ACP` give. An IDE passes the commands of its installed agents in these variables.
- Each command may be a JSON array, a JSON object with `command`, `args`, `env`, and `cwd`, or one executable path.
- Without these variables, Megachat must start the agents that npm installed with it. The module system finds them in
  `node_modules` of a checkout and next to an installed copy.
- The node that runs Megachat must come first on the `PATH` of its children.
  [@test] ../test/launch.test.mjs
  [@test] ../test/package.mjs
- The daemon must publish its build and a digest of the agent commands in its connection file.
- A client of another build or other agent commands must stop the running daemon and start its own.
- A source checkout must keep a daemon that publishes no build.
- The ACP `agentInfo` must give the version of `package.json`, in a source checkout and in the bundle.
  [@test] ../test/bundle.test.mjs
  [@test] ../test/launch.test.mjs
  [@test] ../test/recovery.test.mjs
- A git checkout is a package root with a `.git` entry. Its build must be `dev`, so a pull keeps the running daemon.
- A copy without `.git` must have a build from the version and a digest of `package.json` and of each file in `bin`,
  `resources` and `src`. A change of one of these files must change the build, so an update replaces the daemon.
  [@test] ../test/launch.test.mjs
  [@test] ../test/package.mjs

## Install

- The command `megachat` must check the version of Node.js before it loads Megachat. A Node.js older than the
  `engines` range must get one line with the found and the needed version, and the exit code 1.
- One line must install the last release of Megachat and update it:
  `npx -y "github:ignatov/megachat#semver:x" install`.
- `install` must check the platform, Central and its login, Claude Code and its key from Central, and the command
  `codex` on the `PATH`. It must use the places that Megachat uses at run time.
- Each check must print one line. A failed check must name what to install or do. A platform other than macOS must
  get a line that nobody tested it there, and the install must go on.
- `install` must not print the output of Central or of the key helper of Claude Code.
- `install` must add the entry `Megachat` to `agent_servers` of `~/.jetbrains/acp.json`. The entry must start
  `bin/megachat.mjs acp` of the copy with Node.js directly, not with `npx`. It must have no `application_session` key.
- The command of the entry must be the first `node` on the `PATH` that is the same file as the running Node.js. Without
  such a `node`, it must be the path of the running Node.js.
- Without a file, `install` must write a file with the one entry and the mode 0600, and make its directory when
  necessary.
- Without the entry, `install` must copy the file to `acp.json.before-megachat-<UTC time>`, and then add the entry. It
  must keep each other key, the key order and the mode of the file.
- An equal entry must stay. `install` must then say that Megachat is installed already.
- A different entry `Megachat`, or a file that is not a JSON object, must stay unchanged. `install` must print the
  entries and what to do, and exit with 1. There is no option to replace the entry.
- The last line of `install` must give the version and the directory of the copy.
- The exit code must be 0 only when the entry is in place and each check passed.
- `MEGACHAT_ACP_CONFIG` may replace the path of `acp.json`. The tests set it to a temporary file.
- The package must hold `bin`, `src`, `resources`, `README.md`, `LICENSE` and `package.json`, and no tests.
  [@test] ../test/install.test.mjs
  [@test] ../test/package.mjs

## Release

- A release must be the tag `v<version>` of the version in `package.json`, and the GitHub release of that tag.
- The install line must select the release with the highest version. It must not select a pre-release.
- `npm run release` must refuse a checkout with changes, a branch other than `main`, and a `main` that is not equal
  to `origin/main`.
- `npm run release` must refuse a version that is not three numbers, a tag that exists in the checkout or in the
  remote repository, and a version that is not higher than the last release.
- The notes of a release must be the subjects of the commits since the last release.
- `npm run release` must run `npm test` and `npm run test:package` before it makes the tag.
- `npm run release -- --dry-run` must print the release and change nothing.
  [@test] ../test/release.test.mjs

## Testing / Local Run

Megachat requires macOS, Node.js 22.19 or later, and a working Central configuration for Pi, Claude Code, and Codex.
Codex history requires the local Codex CLI with the app-server history API.
Install the exact dependencies with `npm ci` in the repository root.
`npm run build` writes the bundle into `out/bundle/` with `THIRD_PARTY_NOTICES.txt` for the bundled packages. Git ignores `out/`.
For development, run `node src/main.mjs install` in the checkout. It registers `bin/megachat.mjs acp` of the checkout
as a custom ACP agent with absolute paths.
Name the entry `Megachat`. Air derives the agent ID `acp.megachat` from that name.
An IDE build without that derivation also needs `"application_session": true` in the entry. `install` does not write it.
`npm run test:package` packs Megachat, installs the package into a temporary prefix, and tests that copy. `npm test`
does not run it.
Omit the final argument to use the shared state directory. The optional final argument selects a separate state directory for a test.
The daemon writes its log to `daemon/daemon.log` in the state directory.
Use `node src/main.mjs status` to inspect tasks and `node src/main.mjs stop` to stop the daemon.

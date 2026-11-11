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
- The daemon must accept 1,024 connections at a time. The event streams of many views must not block `/health`, a new
  view or a command.
  [@test] ../test/transport.test.mjs
- A permission request must stay pending without a connected client.
- Reconnection must show the pending request without starting the task again.
- Stop must cancel the main task and each child that it owns.
- Stop must cancel only the turn that the view shows. A stop for a turn that ended must not cancel the next turn.
- The main reply must finish without waiting for its children.
- The main conversation must accept new messages while a child works or needs permission.
- New delegated tasks must wait in a durable queue when a child is already running.
- A later user message may cancel an earlier background task.
- The user may delegate a task to Claude Code or Codex.
- Claude Code must remain the default for delegated tasks unless the setting `children.agent` selects Codex.
- The user may continue an existing session in its registered project.
  [@test] ../test/integration.test.mjs
- One provider session must have at most one unfinished delegated task.
  [@test] ../test/state.test.mjs
- A repeated request ID must return the original admission.
- A repeated request ID with different arguments must fail.
- An uncertain dispatch must become interrupted after a daemon restart.
- Recovery must not send an uncertain prompt again as a new task.
- An interrupted run must continue automatically unless the user cancelled it or it reached a limit.
- A continuation of a sent prompt must resume the same provider session with a prompt to check the work and continue.
- That prompt must quote the task, because the provider can lose a prompt that it did not store.
- A run that never sent its prompt must send that prompt again.
- A run must receive at most two automatic continuations, each after a longer delay.
- A continuation after a planned stop of the daemon must not count as one of the two.
- An agent that cannot use an HTTP MCP server or cannot load a session must end its run with that reason, without a continuation.
- The interrupted run must become resumed and name its continuation. The main conversation must receive one report.
- Cancelling a resumed run must cancel its continuation.
- A failed final continuation must remain interrupted and must be reported.
- An answer from a previous process generation must fail.
  [@test] ../test/state.test.mjs
  [@test] ../test/integration.test.mjs
  [@test] ../test/recovery.test.mjs

## User Experience

- The main conversation must use the native ACP chat.
- Megachat must retain the conversation when a project closes.
- By default, the main agent must use Claude Opus 5.5 through Central with the reasoning level `low`. The setting `coordinator.model` may select another model of the model registry, and `coordinator.thinking` another level.
- Changing the main model must keep the existing conversation.
- The agent must know that its conversation persists through an IDE or daemon restart.
- The user may add rules in `instructions.md` in the state directory. They must follow the bundled rules as user preferences.
- User rules must not override the bundled rules. A daemon restart applies a changed file.
  [@test] ../test/home.test.mjs
- The agent must read retained messages when earlier details are absent from its active context.
- History lookup must survive context replacement and a daemon restart.
- A summary must replace the older part of the model context when the context is above 100,000 tokens. `MEGACHAT_COMPACT_TOKENS` may replace this limit. A daemon restart applies a changed value.
- Above the limit, the daemon must write the summary in the background. Above the limit plus 32,768 tokens, the next model request must wait for the summary.
- A context below the limit must get no summary.
- A summary must keep the standing agreements and preferences of the user, the open child tasks, the questions that wait for the user, and the recent decisions. `resources/compaction.md` holds these instructions.
- A summary must list each child task of the state that is unfinished or unreported, with its status, title, agent and project. This list must come from the state, not from the model.
- A summary must not remove an entry from the retained conversation or from the search index.
- The chat must not show a summary as a message.
- The command `compact` must ask the running daemon for a summary now. The daemon must wait for the end of the current turn first. The command must not start a daemon.
  [@test] ../test/compaction.test.mjs
- Each request of the main agent must ask for the 1-hour prompt cache. `MEGACHAT_CACHE_TTL=5m` must ask for the 5-minute prompt cache.
- The idle daemon must act at 5/6 of the cache lifetime after the last model request. It must not act while a turn runs. A turn must stop a keep-alive request that runs.
- When the model context is above the limit of a summary at that time, the daemon must write the summary, and it must send no keep-alive request.
- When the model context is between 20,000 tokens and that limit, the daemon must send a keep-alive request. The request must hold the model context as a turn sends it, and it must ask for one output token. The conversation must not get its reply.
- After a keep-alive request, the daemon must act again at 5/6 of the cache lifetime. The keep-alive requests must stop 6 hours after the last turn. `MEGACHAT_KEEPALIVE_HOURS` may replace this time.
- The daemon must send no keep-alive request when the cache lifetime is over, and after a keep-alive request that failed.
- After a restart, the time of the last message of the model context must stand for the time of the last model request.
- `MEGACHAT_KEEPALIVE=0` must stop the keep-alive requests and the summary of an idle conversation. It must not change the cache lifetime.
- The log of the daemon must get one line with the token counts and the cost of each keep-alive request and of each summary request. The line must hold no content of the conversation.
  [@test] ../test/keepalive.test.mjs
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
- A second attach of a session ID must replace the earlier view of that ID, also while the earlier view attaches. The
  earlier view must end its attach, and it must start no event stream after that.
  [@test] ../test/integration.test.mjs
- The chat must show the text of a reply of the main agent while the model writes it. The first text must not wait for the entry of the reply.
- The chunks of one model request must have one message ID. A reply after a tool call must be a new message.
- The entry of a reply must add only the text that the stream did not send. The chat must not show a text two times.
- A reply that the user stopped, or that failed, must keep its partial text in the chat one time. That text must be an entry, so a replay shows it too. The notice of a failed reply must be a message of its own.
- When the entry of a reply does not start with the sent text, the entry must be a second message, because Air cannot replace a sent chunk.
- A replay must hold only entries. A view that connects in the middle of a reply must get the text so far as a live chunk after the replay, and then the text that follows.
- Each connected view must get each text one time.
- The text before a call of a tool of the main agent must be a stream. The call must stay hidden.
- The stream must not hold the thinking of the model.
- The daemon must send at most 20 stream events in a second to one client. A partial reply must not send the conversation again.
- `MEGACHAT_STREAM=0` must stop the stream. Then the chat gets a reply when its entry is written. A daemon restart applies a changed value.
- The log of the daemon must get one line with the time from the start of a model request to its first text. The line must hold no content of the conversation.
  [@test] ../test/stream.test.mjs
- By default, Megachat must not offer a next step by itself. It may offer one when the user asks.
- By default, the main agent must have no suggestion rules and no `agents_suggest` and `agents_feedback` tools. The stored proposal decisions must stay.
- `MEGACHAT_SUGGESTIONS=1` must give the suggestion rules and the two tools back. A daemon restart applies a changed value.
  [@test] ../test/suggestions.test.mjs
- Megachat must keep its settings in `settings.json` in the state directory, apart from the conversation. A daemon restart and a compaction must not lose a setting.
- The file must have the mode 0600. The daemon must write it to a temporary file and rename that file, so a crash cannot leave a partial file.
- The file must hold the schema 1, the status of the onboarding, and the stored values. A stored key that this build does not know must stay in the file.
- A file that the daemon cannot read must stay next to it as `settings.json.unreadable-<UTC time>`. The log must give the reason without the content, and the defaults must apply.
- A stored value that this build does not accept must give the default. The file must keep that value.
- The effective value of a setting must be the environment variable, else the stored value, else the default. A variable that the daemon cannot read must have no effect.
- The tool `agents_settings` must give each setting with its value, its source (`environment`, `setting` or `default`), its default, its variable, the allowed values or the range, a description, and when a change applies.
- It must say when a variable hides a stored value. A caller of the service may give an explicit value for a test, with the source `option`.
- The tool must store a valid value at once, remove a stored value, and set the status of the onboarding. It must refuse an unknown key and an invalid value as each other tool refuses an invalid request.
- A project event or a child result must not change a setting or the status of the onboarding.
- The settings are `coordinator.model`, `coordinator.thinking`, `keepAlive.enabled` (`MEGACHAT_KEEPALIVE`), `keepAlive.hours` (`MEGACHAT_KEEPALIVE_HOURS`), `cache.ttl` (`MEGACHAT_CACHE_TTL`), `compaction.tokens` (`MEGACHAT_COMPACT_TOKENS`), `reply.suggestions` (`MEGACHAT_SUGGESTIONS`), `reply.language`, `reply.length`, and `reply.quoteRequest`.
- The settings of the index of past sessions are `sessions.index` and `sessions.days`. They must apply at once, also in the middle of a turn, because they change no model request.
- A model must be valid only when the model registry knows it. A reasoning level must be a level of pi-ai that the model supports.
- The output of `get` must list each model of the registry with the prices of its model data, and one note with the measurement of Claude Opus 5.5. It must give no measurement of another model.
- A changed setting must apply at once when no turn runs, else at the end of the current turn, before the next turn starts. A change must not apply in the middle of a turn. A setting with another time in its `applies` text, such as a setting of the children, must apply at that time.
- The model and the reasoning level must reach the next model request without a restart. A keep-alive request must use the same model and level as the turns.
- The keep-alive, the cache lifetime and the limit of a summary must take the stored value without a restart.
- The setting `reply.suggestions` must change the rules and the suggestion tools of the running main agent.
- The reply style must give lines of the rules of the main agent: the language, the length, and a quote of the original request in a report of a child result. The defaults must give the rules from before the settings.
- The rules that the settings give must be a section of their own, so a change sends only that section to the model again.
- Without `settings.json`, the onboarding must be pending. The rules of the main agent must then hold the setup rules of `resources/instructions-onboarding.md`.
- The setup rules must tell the agent to answer the user first and then offer the setup one time, to ask one question at a time with its default, to let the user skip one question or the setup, to store each answer at once, and to mark the onboarding done at the end. They must name only the settings of this build.
- After the status `done` or `skipped`, the setup rules must not come back by themselves, also after a restart. The rules must then say that the agent changes a setting or runs the setup again when the user asks.
- The status `pending` must bring the setup rules back. The tool result must hold them, so the setup can start in the same turn.
  [@test] ../test/settings.test.mjs
- The setting `children.agent` must select the agent of a new child task without a named agent: `claude`, the default, or `codex`. A follow-up and a continuation must stay with the agent of their session. A change must apply to the next child task, also in the turn that made it.
- The settings `children.commit`, `children.push` and `children.daemonRestart` must take `allow`, `ask` or `deny`. The defaults are `allow`, `ask` and `ask`. A daemon restart is a restart or a stop of the Megachat daemon.
- At each dispatch, the daemon must add one rules paragraph from these settings to the prompt of the child, as a block before the task. A change must reach the next new task, follow-up and continuation. The state must keep the prompt of a run without the paragraph.
- `allow` must let the child do the step. `deny` must forbid the step, also when the task asks for it. `ask` must forbid the step unless the task says that the user approved it. The child must then say in its result that the step is necessary.
- The rules of the main agent must give the default agent and the three values, so the agent does not promise the user other rules.
- A project event or a child result must not change these settings.
- A daemon restart must keep each setting of the children, the project events, the known repositories and the spend limit.
  [@test] ../test/settings.test.mjs
  [@test] ../test/child-settings.test.mjs
- The setting `budget.dailyUsd` must be a daily spend limit of the main agent in USD, from 0 to 100,000. The default 0 means no limit.
- Megachat must count the cost of each model request of the main agent on the local day: each reply, also a reply with tool calls, each summary and each keep-alive request. A request without a cost from its provider must get the cost from the prices of its model data. The cost of the children must not be in the count.
- The count must stay in `spend.json` in the state directory with the mode 0600, so a daemon restart keeps it. The count must start again at the local midnight.
- When the count passes the limit, the rules of the next turn must hold one line with the spend and the limit, which asks for one short warning. The line must go away after a completed turn that had it. The user must get at most one warning on each day. Megachat must not stop the work.
- `agents_settings get` must give the spend of the day, the limit, whether the warning went out, and a note that the children are not in the count.
  [@test] ../test/spend.test.mjs
- The tool `agents_accounts` must check Claude Code and Codex in parallel. It must start each agent as a child starts, ask for `initialize` and `session/new` in the workspace of Megachat, send no prompt, and close the process after the check.
- Each agent must have a time limit of 30 seconds. A second call while a check runs must get the result of that check.
- An agent that opens the session must give the status `started` with the login `unknown`, because only a prompt proves that the provider accepts the login. The result must say so.
- An agent that refuses the session with the ACP error `authRequired` must give the status `failed` with the login `missing`. An agent that does not start, a failed Central configuration, a refused session and the time limit must give `failed`. Each failure must give the problem and what to fix, from the resources and not from the agent.
- The setup must run the check at its end and show the result. The rules of the main agent must run the check when a child fails with a login error.
  [@test] ../test/accounts.test.mjs
- With `MEGACHAT_SUGGESTIONS=1`, Megachat may offer one useful next step after work ends.
- After a refusal, it may then offer two alternatives. After the third refusal, it must stop proposing work.
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
- The tool `agents_running` of the main agent must list the agent sessions that run on the machine now: Claude Code,
  Codex, pi and OpenCode, also below the ACP adapters `claude-agent-acp` and `codex-acp`. It must read the process
  table only, and it must change nothing.
- One session must give one row. An agent process below a process of the same agent must not be a row. An adapter must
  be a row only when no agent of its own runs below it. A helper of an agent, such as an MCP server, a shell or a tool,
  must not be a row. The background service of an agent (`claude daemon`, `codex app-server daemon`) and the processes
  of this daemon outside a child run, such as the account check, must not be rows.
- Each row must have `agent`, `sessionId`, `title`, `cwd`, `state`, `status`, `startedAt`, `lastActivityAt`, `pid` and
  `parent` with `kind`, `name` and `pid`. `kind` must come from the nearest owner in the parent chain: `megachat`, `ide`
  for an IDE, an editor or the desktop app of an agent, `terminal` for a terminal app, a multiplexer server or SSH, and
  `unknown` for the service of an agent, another app, or no owner. `name` must be the name of the app or of the program,
  never a command line.
- For a process below this daemon, the state of Megachat must be the authority. The run of the supervisor PID must give
  the session ID, the title and the task directory.
- The state must be `orphan` when the parent chain reaches launchd without an owner, or when the run of a Megachat child
  ended. A shell that stays after its terminal is no owner. Else the state must be `active` at a CPU load of 10 percent
  of one core or more, of the session process with its helpers, and `idle` below it.
- The server of `tmux`, `screen` or `herdr` must count as a live terminal. Thus a session in a multiplexer without a
  client is not an orphan.
- In this version, `status` and `lastActivityAt` must be null, a session outside Megachat must have an empty `sessionId`
  and `title`, and `incomplete` must name the session logs. A session that waits for the model is `idle`.
- The order must be: orphan, active, idle, and the newest start first in each group. `limit` must be 1 to 200, and the
  default must be 50. `nextCursor` must continue after the last row of the page, and `truncated` must be true when more
  rows exist. `agent`, `project` and `state` must select the rows. `project` must select each working directory that
  is that directory or in it.
- Megachat must keep the view of the processes for 5 seconds, so two calls in that time make one `ps` call. `scannedAt`
  must give the time of the view. Megachat must get the working directory once for each process, and again for a PID
  with another start time.
- A working directory that Megachat cannot read must give a row with the `cwd` null and an entry in `incomplete`, not an
  error. A failed `ps` call must give an empty list and an entry in `incomplete`. On a platform other than macOS, the list
  must be empty, and `incomplete` must name the platform. `incomplete` must name the logs of OpenCode when the list has
  an OpenCode session.
- The output must hold no command-line argument, no message text and no environment. The MCP server of the children must
  not have the tool.
  [@test] ../test/running.test.mjs
- With the setting `sessions.index` on, Megachat must keep an index of the past Claude Code, Codex and pi sessions in `sessions.sqlite` in the state directory. The default is off.
- The setup must ask for the consent with "Index past Claude, Codex and pi sessions in your projects? Everything stays local." The main agent must set `sessions.index` to on only when the user agrees.
- With the setting off, Megachat must read no session file for the index, watch no directory of a provider, and keep no `sessions.sqlite`. A change to off must stop the import and delete the file.
- A change to on must start the import at once, without a restart.
- The index must hold only a session whose `cwd` is a listed directory or a directory in one. The sessions of a newly listed directory must enter the index. The sessions of a removed directory must leave it.
- The sources must be `~/.claude/projects/<encoded cwd>/<session ID>.jsonl`, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` or `$CODEX_HOME/sessions`, and `~/.pi/agent/sessions/--<path>--/*.jsonl` or `PI_CODING_AGENT_SESSION_DIR`.
- The import must take the sessions with activity in the last `sessions.days` days, 180 by default. The value 0 must take all sessions. A session that becomes older must leave the index at the next pass.
- For each file, the index must keep the path, the size, the modification time, the inode and the byte offset of the import. The import must read only the appended complete lines. A last line without a newline must stay unread until it is complete.
- A smaller file or another inode must make the import read the whole file again.
- An entry with the entry ID of an entry in the index, such as a copy in a fork, must be in the index one time.
- The index must keep at most about 2 KB of the text of each entry, tool calls and tool results included.
- Before the index keeps a text, it must replace each text that looks like a secret with a marker: an API key with a well-known prefix, a Bearer token, a private key block, a JWT, and an assignment such as `password=` with a long value. This is a best effort: a secret of another shape can stay in the index.
- The first pass must import the files of the projects of an IDE first, and the newest files first. The import must run in bounded batches with a pause between them, so the chat stays usable.
- When Air sent `asyncTasks`, the chat must show the first pass, and a later pass of 20 files or more, as a background task with its progress. The output of `agents_settings` with `get` and of the session tools must give the state and the progress of the index.
- After the first pass of a new index file, the main agent must tell the user a short summary in one event turn: the number of sessions and of projects, and the last unfinished sessions. The summary is data, not instructions.
- After the first pass, the import must catch up at the start of the daemon, on a change of a session file, and on a change of the listed directories. A search must first import the new lines of the files of its directory, for at most 2 seconds.
- An index file of another `VERSION` must be made again from the session files.
- With the index on, `agents_sessions` and `agents_session_history` of the main agent, and the tools `sessions` and `session_history` of a child, must answer from the index. A search must give one match for each session, best bm25 first, with a snippet.
- They must use the live provider when the index is off, when the index has no session of the agent in the directory, and for a query without a word of 3 or more characters.
- pi must be an agent of these tools. Without the index, a request for pi must fail with a text that says that the index is off.
  [@test] ../test/session-index.test.mjs
- Saved source changes in registered projects may trigger a project-event turn while the IDE is closed. The turn may hold a proposal only with `MEGACHAT_SUGGESTIONS=1`.
- The watcher must ignore generated files and read no source contents.
  [@test] ../test/project-watch.test.mjs
- Without the setting `events.enabled`, Megachat must report no project event. It must drop the events that wait for a turn, so they do not come later as a burst.
- Megachat must not report a path that matches a pattern of the setting `events.ignore`. The default patterns are `*.tmbundle`, `build/download` and `.claude/settings.local.json`. The built-in ignore list of the watcher must stay.
- A pattern must be a glob on the project-relative path: `*` in one segment, `**` across segments, `?` for one character. A pattern without a slash must match a name at each depth. A path in a matching directory must match too.
- An event of which each path matches must not be recorded. A change of these settings must apply to the next file event, in the watcher and for an event from a client.
  [@test] ../test/event-filter.test.mjs

## Data & Backend

- The state must live in `~/.jetbrains/air/megachat/` for each user: `%USERPROFILE%\.jetbrains\air\megachat` on Windows.
- All JetBrains products of the user must share this directory, its daemon, and its conversation.
- `MEGACHAT_HOME` or the final command argument may select another directory for a test or development.
- The directory must hold `conversation.sqlite`, `owner.sqlite`, `search.sqlite`, `workspace/`, and `daemon/` with the connection file and log. It may hold `settings.json` and `spend.json`.
- It may hold `sessions.sqlite`, the index of past sessions, only with the consent of the user.
- The name `memory.md` is reserved for learned memory that the user can edit. Megachat does not read it yet.
- The directories must be private to the user: mode 0700 for directories and 0600 for files on macOS and Linux.
- Only one daemon may own a storage directory.
- A second daemon must fail at once. A second product must connect to the running daemon.
- A start that loses the race with a concurrent start must stop its own daemon.
- A start must wait for its daemon while the daemon process lives, at most 2 minutes. It must not stop after a count of attempts.
- A start must end at once when its daemon ends with an error.
- A daemon that finds another daemon on its directory must end with the exit code 3.
- When that other daemon does not answer, the start must start a daemon again after a delay. One start must make at most five daemon processes.
- When the shared directory has no conversation, the daemon must copy the conversation once from an earlier directory: `~/Library/Application Support/JetBrains/AirMegachat` on macOS.
- `MEGACHAT_LEGACY_DIRS` may replace the list of earlier directories. An empty value gives an empty list.
- The copy must include committed WAL content and pass an integrity check before the daemon uses it.
- The search index must be rebuilt from the copy.
- The earlier files must stay in place with a `MIGRATED_TO` file that names the new directory. A marked directory must not be copied again.
- The daemon must not copy state that a running daemon owns. Until that daemon stops, a client must use it.
- A directory with an explicit path must not receive a copy.
  [@test] ../test/home.test.mjs
- The local HTTP connection must require the private connection token.
- The daemon must accept an input of 100,000 characters in each script. It must refuse a request body of more than 1,000,000 bytes.
- A history request must return at most 100 entries.
- A child must work only in a listed directory: a project directory that a client registered, a known repository, or the workspace of Megachat.
- The workspace of Megachat must be the directory `workspace` in the state directory. The daemon must make it at its start with the mode 0700. A task without a project works there.
- The state must keep the list of the known repositories through a daemon restart. The list must start empty, and it must hold at most 100 repositories.
- The tool `agents_projects` must list the directories, add a known repository, and remove one. Only a turn of the user may add a repository.
- A known repository must be an absolute path or a path that starts with `~`. The state must keep its real path.
- That real path must be an existing directory in the home directory of the user or in a root of `MEGACHAT_PROJECT_ROOTS`. Thus a symbolic link must not lead out of these directories.
- The home directory itself, its `Library` directory, its hidden directories, and the state directory of Megachat must be refused.
- A child in a known repository must have that repository as its working directory, also when no IDE has opened it.
- A task, a follow-up, a continued session, and a session search must refuse a directory that is not listed.
- `agents_list` must give each listed directory one time with its origin: `ide`, `known`, or `megachat`. The workspace of Megachat must have the name "Megachat workspace".
  [@test] ../test/projects.test.mjs
- The action `discover` of `agents_projects` must give the git repositories in `~/src`, in `~/IdeaProjects` and in each root of `MEGACHAT_PROJECT_ROOTS`: a directory of a root, or a directory in a directory of a root, that holds a `.git` entry. It must not give a listed directory.
- The scan must not go into a repository or a hidden directory, must follow no symbolic link, and must read no file. It must give at most 200 repositories, the newest change of `.git` first, and `truncated` when more exist. It must add nothing to the list.
- The setting `projects.newRoot` must name the directory of a new project without a named location: an absolute path or a path that starts with `~`. The default is `~/src`.
- The action `create` must make `<projects.newRoot>/<name>`, or `<name>-2` and so on when the name is taken, and add it to the known list. The name must be one directory name of at most 100 characters that is not hidden.
- The root of a new project must be in the home directory or in a root of `MEGACHAT_PROJECT_ROOTS`, out of a hidden directory and out of the state directory. The daemon may make a root that does not exist. Only a turn of the user may make a project.
  [@test] ../test/discovery.test.mjs
- A project directory that the daemon cannot read must not stop the attach of a view or the registration of the other directories.
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
- Child output must stop growing at the configured retention limit. The daemon must keep the end of a longer output.
- The state must keep only the text that a child agent wrote. An open of the state must drop the stored updates of an earlier build.
- Project events must coalesce into bounded batches and trigger at most one project-event turn per project per minute.
- Changes during delegated work must not trigger another project-event turn.
- Permission waits must suspend the child execution deadline.
- The deadline must start again only when no permission request of the child waits.
  [@test] ../test/integration.test.mjs
  [@test] ../test/state.test.mjs
  [@test] ../test/recovery.test.mjs
  [@test] ../test/transport.test.mjs
  [@test] ../test/launch.test.mjs

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
- A daemon that gets SIGTERM or SIGINT, or a storage error, during its start must end the start and exit. It must not
  publish its connection file after it released the lock.
  [@test] ../test/recovery.test.mjs
- After a storage error, the daemon must write the reason to its log and stop. The next start opens the state again.
- The log of the daemon must name each failure of a child run, of a request, of an automatic turn, and of the Central configuration.
- A log line about an error must not contain the message of that error, because the message can hold a credential.
  [@test] ../test/failure.test.mjs

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
- The node that runs Megachat must come before the other directories on the `PATH` of its children. For Codex, the `bin` directory of Megachat comes before that node, because it holds the `codex` command that Central starts.
- A child agent must get the file mask (umask) that the user had when Megachat started, so a file that a task writes
  gets the mode that the same agent gives it in a terminal. A daemon that `start` started must get that mask from
  `start`, not from its own mask. The daemon must keep the mask 077 for its own files.
  [@test] ../test/launch.test.mjs
  [@test] ../test/package.mjs
- The daemon must publish its build and a digest of the agent commands in its connection file.
- A client of another build or other agent commands must stop the running daemon and start its own.
- A client that passes no agent command must keep a daemon of its own build, whatever agent commands that daemon has.
- Before a client stops a daemon, it must check that it can open the state. A client that cannot must leave the daemon alive.
- A source checkout must keep a daemon that publishes no build.
- The ACP `agentInfo` must give the version of `package.json`, in a source checkout and in the bundle.
  [@test] ../test/bundle.test.mjs
  [@test] ../test/launch.test.mjs
  [@test] ../test/recovery.test.mjs
  [@test] ../test/home.test.mjs
- A git checkout is a package root with a `.git` entry. Its build must be `dev`, so a pull keeps the running daemon.
- A copy without `.git` must have a build from the version and a digest of `package.json` and of each file in `bin`,
  `resources` and `src`. A change of one of these files must change the build, so an update replaces the daemon.
  [@test] ../test/launch.test.mjs
  [@test] ../test/package.mjs
- When npm or npx started Megachat, the daemon and each child must get the environment that the IDE gives a direct
  command. They must get no variable `npm_*`, no `INIT_CWD` and no `COLOR`, and no `NODE` or `EDITOR` that npm set.
  They must get none of the variables that the IDE adds for `npx`: `NPM_CONFIG_CACHE`, `NPM_CONFIG_MIN_RELEASE_AGE`,
  `NPM_CONFIG_GLOBAL`, `NPM_CONFIG_DRY_RUN`, `NPM_CONFIG_INCLUDE`, `NPM_CONFIG_ENGINE_STRICT` and
  `NPM_CONFIG_STRICT_PEER_DEPS`. Their `PATH` must not start with the `node_modules/.bin` directories and the
  `node-gyp-bin` directory that npm added.
- `NODE_USE_SYSTEM_CA`, each other `NPM_CONFIG_*` variable, and each later `PATH` entry must stay.
- So a child must find the `codex` and the `claude` of the user, not a command in `node_modules/.bin` of the copy.
- A copy that Node.js started directly must keep its environment.
  [@test] ../test/environment.test.mjs
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
- `install` must add the entry `Megachat` to `agent_servers` of `~/.jetbrains/acp.json`. The entry must have no
  `application_session` key.
- In a copy without `.git`, the entry must be
  `{"command":"npx","args":["-y","github:ignatov/megachat#semver:x","acp"]}`. So each start of the agent must start
  the last release.
- The next start of the agent after a release must install the new release, and its daemon must replace the daemon
  of the earlier release. The entry must stay unchanged.
- In a git checkout, the entry must start `bin/megachat.mjs acp` of the checkout with Node.js directly. The command of
  the entry must be the first `node` on the `PATH` that is the same file as the running Node.js. Without such a
  `node`, it must be the path of the running Node.js.
- Without a file, `install` must write a file with the one entry and the mode 0600, and make its directory when
  necessary.
- Without the entry, `install` must copy the file to `acp.json.before-megachat-<UTC time>`, and then add the entry. It
  must keep each other key, the key order and the mode of the file.
- An equal entry must stay. `install` must then say that Megachat is installed already.
- In a copy without `.git`, `install` must replace the entry that `install` 0.2.0 wrote: Node.js starts
  `bin/megachat.mjs acp` of a copy in an `_npx` directory, and the entry has no other key. `install` must first copy
  the file to `acp.json.before-megachat-<UTC time>`. It must keep the place of the entry, each other key and the mode
  of the file, and print one line about the replacement and the earlier entry.
- Another different entry `Megachat`, or a file that is not a JSON object, must stay unchanged. `install` must print
  the entries and what to do, and exit with 1. There is no option to replace the entry.
- The last line of `install` must give the version and the directory of the copy. In a copy without `.git`, a line
  before it must say that the IDE starts Megachat with `npx` and its own Node.js. The last line must say that the IDE
  uses a copy of its own.
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
- `npm run release` must run `npm run build`, then `npm test` and `npm run test:package`, before it makes the tag.
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
An IDE build without the Air support for Megachat starts it as an ordinary custom ACP agent. Nobody tested that case.
`npm run test:package` packs Megachat, installs the package into a temporary prefix, and tests that copy. It also runs
the `npx` entry on a temporary git repository with release tags. `npm test` does not run it.
Omit the final argument to use the shared state directory. The optional final argument selects a separate state directory for a test.
The daemon writes its log to `daemon/daemon.log` in the state directory.
Use `node src/main.mjs status` to inspect tasks and `node src/main.mjs stop` to stop the daemon.

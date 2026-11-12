---
name: Megachat
description: One persistent conversation delegates tasks to Claude Code, Codex and pi, and searches Claude Code and Codex histories.
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
Date: 2026-11-12

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
- A new delegated task must wait in a durable queue when its directory is busy or when the limit of the children that run at the same time is full.
- A later user message may cancel an earlier background task.
- The user may delegate a task to Claude Code or Codex, and a task that only reads files to a pi child.
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
- A continuation must keep the title of the task. Its report must give the task of the user and the title, not the
  prompt of the continuation.
- Cancelling a resumed run must cancel its continuation.
- A failed final continuation must remain interrupted and must be reported.
- An answer from a previous process generation must fail.
  [@test] ../test/state.test.mjs
  [@test] ../test/integration.test.mjs
  [@test] ../test/recovery.test.mjs
- The tool `agents_steer` of the main agent must add a message of the user to the unfinished run of a child session,
  without a wait for the end of the task. `agents_send` must stay a follow-up to an idle child session. Its refusal for
  a child that works must name `agents_steer`.
- Only a turn of the user may steer. A turn of a child result or of the summary of the past sessions must get a
  refusal. The tool must refuse a child session that the state does not know, a child session without an unfinished
  run, and a run whose directory is no longer listed, with the error of `agents_send` for that directory. The MCP
  server of the children must not have the tool. The rules of the main agent must say that a text from a child output
  or a session history never becomes a message to a child without a request of the user.
- The state must record each message before a process sends it: an ID, the text, the mode (`queue`, the default, or
  `interrupt`), the time, and the delivery: `pending`, `delivered` or `fallback`. A repeated tool call must give the
  first record. A task must have at most 16 messages, for its first run and its continuations together. A message
  must have at most 64,000 characters, and the error for a longer message must name the limit. The prune of a run
  must remove its messages.
- A message for a run that did not send its prompt must go in that prompt, as a block after the task. The outcome must
  be `queued`, and no agent must get a request.
- For a run that sent its prompt, the run service that owns the connection to the agent must send the message. The
  state is the channel, as for a cancel. When the `initialize` answer of the agent gave `_meta.steering.supported` and
  the mode is `queue`, the run service must send `_session/steering` with `_meta.steering.idleBehavior:
  "promptRequired"`, so the adapter starts no turn of its own. The answer `injected` must mark the message delivered.
- When the turn ended first (`promptRequired`), or when the agent took the message and the stream started no new part
  of model work after the answer before the end of the turn, the run must get a follow-up in the same provider session
  with the message. The outcome in the record must be `followUp`, also when the tool gave `injected`. A new part is an
  update of another kind than the update before it (a message chunk, a thought chunk, a tool call or its update, a
  plan), or a new tool call. More chunks of the reply that streamed at the answer are no new part: the Codex adapter
  can send them after its answer.
- The answer `failed`, an error, no answer in 20 seconds, an agent without steering, and the mode `interrupt` must use
  the fallback: `session/cancel`, and after the end of the prompt a continuation in the same provider session. Its
  prompt must say that the user stopped the step, and it must hold the message. The outcome must be `restarted`. When
  the turn ends with `end_turn` before the stop, the message must go in a follow-up, with the outcome `followUp`. After
  one message used the fallback, each other waiting message of the run must go to the same stop without a steering
  request.
- While a permission request of the run waits for the user, the fallback must wait until the user answered each
  request of the run. A steer must not change a permission request. The chat must keep the task of the run with its ID
  and its phase.
- A follow-up or a continuation for a message must start at once, also before an older queued task, must not count
  as an automatic attempt, and must start also after the last attempt. The main agent must get one report for the
  task: the report of the last run, with the output of the earlier run before its own output.
- After a daemon restart, the continuation of an interrupted run must hold each message of the run that the provider
  session may not have. A message that can have reached the agent must say that it can be a repeat. So the delivery is
  "at least one time".
- The tool must wait at most 30 seconds for the outcome. After that time, its outcome must be `pending`, and the
  message must stay in the state.
  [@test] ../test/state.test.mjs
  [@test] ../test/integration.test.mjs
  [@test] ../test/recovery.test.mjs
  [@test] ../test/pi-child.test.mjs

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
- The setting `workday.enabled` must be off by default. Off must keep each rule above about the idle daemon.
- The working hours are from `workday.start` to `workday.end` (defaults `09:00` and `19:00`) on the days of `workday.days` (default Monday to Friday), in the timezone of `workday.timezone`. The value `auto`, the default, is the timezone of the system. The local time must come from `Intl`, so a change of the daylight saving time moves the working hours with the local clock.
- A `workday.start` after `workday.end` must give working hours that go past midnight, from a working day into the next day. Equal times must give the whole day of each working day.
- One pure function of the working-day settings and a time must decide whether the time is in the working hours.
- With `workday.enabled` on, the daemon must send no keep-alive request outside the working hours. In the working hours, the idle daemon must act as without the working day.
- Outside the working hours, the idle daemon must act only when the conversation is idle for `workday.idleMinutes` (default 30). Then the conversation must go to sleep: a context above the limit of a summary must get the summary one time through the summary of the idle daemon, and no request must go out until the next turn. A smaller context must get no summary. The log must get one line for the sleep.
- Outside the working hours, the summary must come at the end of the idle time also when the cache lifetime is over, for example with `cache.ttl=5m` or with an idle time above 50 minutes. The summary request sends the conversation as a transcript with its own system prompt and no cache retention, so it reads no prompt cache, and a cold cache does not change its cost. In the working hours, a timer that comes after the cache lifetime must still do nothing, because the user is then likely back, and a summary would make the next turn wait.
- A turn outside the working hours must work as usual. After it, the idle rule must apply, and `keepAlive.hours` must not apply. A daemon restart outside the working hours must send no keep-alive request.
- The first turn after the sleep must start from the context that the summary left.
- The sleep must not stop a child task.
- With `keepAlive.enabled` off, the working day must have no effect on the keep-alive requests and on the summary. The wait of the child results below stays.
- A time must be `HH:MM` or `H:MM` of a 24-hour clock, and the value must become `HH:MM`. The days must be a list or a text such as `mon-fri` or `mon,wed`, with short or full English names, and at least one day. A timezone must be `auto` or a name that `Intl` knows. The idle time must be a whole number of minutes from 0 to 1440.
- A `settings.json` without the `workday.*` keys must open with the defaults.
  [@test] ../test/workday.test.mjs
  [@test] ../test/settings.test.mjs
- With `workday.enabled` on, a child result must start no turn while the conversation sleeps: outside the working hours, and idle for `workday.idleMinutes` since the end of the last turn of the user. The keep-alive and the wait of the results must use one shared pure function for this decision, `isSleeping` of `src/Workday.mjs`.
- Only a turn of the user must end this idle time, in the service and in the keep-alive. A turn of a child result, of the sessions summary and of the morning report must not end it, so a chain of child results at night does not keep the conversation awake: after a last turn of the user at 22:55, a result at 23:10 starts its turn, and a result at 23:35 waits. In the working hours, a turn of a child result and a turn of the sessions summary must still start the `keepAlive.hours` window again.
- After a restart, the end of the last turn of the user must come from the state: the time when the state settled its input, else its admission time for an input of an earlier build. The inputs of the automatic turns have the request ID prefixes `children:`, `sessions:` and `morning:`.
- The waiting results must go out at the first of these: right after the next turn of the user, or at `workday.start` of the next working day. A Friday night result goes out on Monday.
- While the user is active outside the working hours, with a turn in the last `workday.idleMinutes`, a child result must start its turn at once.
- A permission request of a child must show at once. Only the turn of the result waits.
- The wait must survive a restart of the daemon: its end must come from the settings and the clock. The timer must look at the clock again at least every 15 minutes.
- With `report.morning` on, the turn of the waiting results must come before the turn of the morning report, because the event pump starts the result turns first. The data of the report must mark each finished child run without a reported result with `separateResult: true`, and the rules of the report must ask the main agent to name it in a few words and not to tell its result again.
- With `workday.enabled` off, a child result must start its turn at once, at each time of the day.
  [@test] ../test/waiting-results.test.mjs
- The setting `report.morning` must be off by default. Off must start no report, no timer and no run of tokprof. A `settings.json` without the key must open with the default.
- With it on, the daemon must start one automatic turn of the kind `morning` on each working day at `workday.start`, on the days of `workday.days`, in the timezone of `workday.timezone`, also when `workday.enabled` is off. A change of the daylight saving time must move the time with the local clock.
- The timer is the first scheduler of the daemon. Its next time must come from the settings and the clock through the pure function `nextWorkdayStart` of `src/Workday.mjs`. It must look at the clock again at least every 15 minutes, so a missed timer gives the report at the first chance on that working day, one time.
- The state must keep the local date of the last report. A restart must send no second report on that date. A state of an earlier build must open.
- When the user turns the report on after the start of a working day, the first report must come on the next working day.
- The report must cover the calendar days from the previous working day up to the day before. So the report of a Monday covers Friday, Saturday and Sunday. A period without a turn of the user and without a child run must give no turn and no run of tokprof. The state must keep its date all the same. The spend must not make a period active, because the turn of a report, a keep-alive request and a summary also cost money. So two working days without the user give no report on the second day.
- The daemon must collect the data, and the turn must get it as JSON in its prompt. The data must hold the child runs of the period that finished or failed and the child runs that still run, with title, project, agent and status; the permission requests that wait; the sessions of the period by project from the session index when `sessions.index` is on; the commits of the period of each listed project, at most 20 projects with 30 commits; the spend of Megachat on each day of the period, with the part of the pi children; and the API-equivalent cost of the other agent sessions from tokprof.
- The commits must come from `git log` with a time limit, and from no other git command.
- tokprof must come from `PATH`, else from `~/.local/bin`. It must run with no shell, with a time limit of 120 seconds, as `tokprof flame --since <first day> --until <report date> --stack agent,project,origin --value cost -o <file>`. The file must be in a private temporary directory, and Megachat must read at most 4 MB of it. Without tokprof, after a failure, after the time limit, and for a larger file, the data must say that this part is missing and why. The rules of the turn must ask the main agent to say it.
- The data and the report must keep the two kinds of money apart: the USD that the key of Megachat paid, and the API-equivalent cost of the sessions that the accounts of the agents paid. tokprof reads no store of Pi Durable, so a pi child of Megachat is not in its output. A line of the agent `pi` in the state directory of Megachat must be left out of the tokprof part all the same, and the data must give its cost apart.
- `spend.json` must keep the spend of the last 31 earlier days with the part of the pi children. A file of an earlier build must open.
- The turn of the report must wait for a turn that runs. A user message must interrupt it. An interrupted report, and a report that failed for a reason that can go away, must run again one time with the same data. A stop of the user must end it.
- The turn of the report must refuse each tool that starts or changes something: a child task, a steer, a change of a setting or of the onboarding, a project create or remove, a close of a child, a cancel, and the account check. Its rules must ask for the report, for a list of the next steps for the user to approve, and for no start of work.
- A connected client must get the report as it gets each automatic turn. Without a client, the reply must stay in the conversation one time, and the next attach must show it without the prompt.
- The turn of the report must start no window of keep-alive requests. The window starts at the next turn of the user. A turn of a child result and a turn of the sessions summary start the window as a turn of the user does.
- A turn of a child result and a turn of the sessions summary must still refuse a steer and a change of a setting. A turn of a child result must still run `agents_accounts`.
  [@test] ../test/morning-report.test.mjs
  [@test] ../test/settings.test.mjs
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
- The chat must list each unfinished child task with its title, agent, project, and state: queued, running, waiting for permission, or interrupted and resuming. Each child that runs at the same time as another child must have a row of its own with its own state.
- A task title must be at most 60 characters. Without a title from the main agent, it must come from the first prompt line.
- The list must show no run IDs or prompts. A finished task must leave the list.
- Permission requests must appear in the main conversation. The title of a request must name the agent and the task, because several children can ask at the same time.
- Reconnection must restore the conversation without child lifecycle rows.
- A completed main reply must arrive before the prompt response.
- History replay must include the earlier user messages.
- A prompt may hold the blocks `text` and `resource_link`, as ACP requires of each agent. The main agent must get each
  link as a Markdown link with its name and its URI, in the order of the blocks. Each other block type must be refused.
- Each ACP view must have its own session ID.
- Views in one pooled process must share the conversation and close independently.
- A second attach of a session ID must replace the earlier view of that ID, also while the earlier view attaches. The
  earlier view must end its attach, and it must start no event stream after that.
  [@test] ../test/integration.test.mjs
  [@test] ../test/parallel.test.mjs
- The chat must show the text of a reply of the main agent while the model writes it. The first text must not wait for the entry of the reply.
- The chunks of one model request must have one message ID. A reply after a tool call must be a new message.
- The entry of a reply must add only the text that the stream did not send. The chat must not show a text two times.
- A reply that the user stopped, or that failed, must keep its partial text in the chat one time. That text must be an entry, so a replay shows it too. The notice of a failed reply must be a message of its own.
- When the entry of a reply does not start with the sent text, the entry must be a second message, because Air cannot replace a sent chunk.
- A replay must hold only entries. A view that connects in the middle of a reply must get the text so far as a live chunk after the replay, and then the text that follows.
- Each connected view must get each text one time.
- The text before a call of a tool of the main agent must be a stream. The call must stay hidden.
- The stream must not hold the thinking of the model.
- Each model request through Central must ask for thinking blocks without text (the display `omitted`). With a summary
  of the thinking, the API sends the text of a reply only after the summary. Then the first part of a reply arrives as
  one chunk, and a short reply arrives whole at its end.
- The daemon must send at most 20 stream events in a second to one client. A partial reply must not send the conversation again.
- `MEGACHAT_STREAM=0` must stop the stream. Then the chat gets a reply when its entry is written. A daemon restart applies a changed value.
- The log of the daemon must get one line with the time from the start of a model request to its first text. The line must hold no content of the conversation.
  [@test] ../test/stream.test.mjs
- By default, Megachat must not offer a next step by itself. It may offer one when the user asks.
- The setting `reply.suggestions` must have the modes `off` (the default), `reply` and `ghost`. `MEGACHAT_SUGGESTIONS=0`, `1` and `ghost` must select `off`, `reply` and `ghost`.
- The stored values `false` and `true` of v0.3.0 must give `off` and `reply`, and the open must not change the file.
- In the mode `off`, the main agent must have no suggestion rules and no `agents_suggest` and `agents_feedback` tools. The stored proposal decisions must stay.
- The mode `reply` must give the suggestion rules of `resources/instructions-suggestions.md` and the two tools, as the value `true` did. A daemon restart applies a changed value.
  [@test] ../test/suggestions.test.mjs
  [@test] ../test/settings.test.mjs
  [@test] ../test/upgrade.test.mjs
- The mode `ghost` must give the rules of `resources/instructions-suggestions-ghost.md` and the two tools. The rules must forbid a proposal in the reply text. They must ask for at most one call of `agents_suggest` in a turn, with one short prompt in the voice and the language of the user, and for no call when no next step is clearly useful.
- In the mode `ghost`, `agents_suggest` must keep the gate of the mode `reply`: no silence, fewer than three declines, and no live prompt suggestion. A proposal of the mode `reply` that waits for its feedback must not stop it. The text must become one line.
- The allowed text must become the prompt suggestion of the turn, and the tool result must tell the agent not to repeat it in the reply. A second call in the same turn must get `allowed=false` and change nothing.
- A turn that admits a child task is a delegation acknowledgment. It must get no prompt suggestion, also when the main agent admits the child after the proposal. A turn that the user stopped or that failed must keep no prompt suggestion.
- A turn of a child result or of the summary of the past sessions must send a prompt suggestion only when the main agent calls `agents_suggest`. The rules must allow that only when the result leaves a clear next action for the user.
- In the mode `ghost`, Megachat must send the prompt suggestion to each client, without a capability. The carrier must be the key of Air `_meta.promptSuggestions` of a `session_info_update` without a title, with `{ "suggestions": [{ "text": ... }] }`, as `docs/air-contract.md` gives it. No client may get the proposal in the reply text. The mode `ghost` must not fall back to the mode `reply`.
- The bridge must send the prompt suggestion after the last `agent_message_chunk` of its turn and before the end of the turn. The wire must have no ID, no turn and no expiry time. The daemon must keep them.
- A prompt suggestion must end at the start of the next turn, of the user or automatic, at a `session/cancel` while no turn runs, and at its `expiresAt`. The lifetime is `PROMPT_SUGGESTION_LIFETIME_MS` of `src/Suggestions.mjs`: one hour, the lifetime of the default prompt cache. A sent suggestion that ends must get a withdrawal: the same update with an empty list.
- `session/load` and `session/new` must send a live prompt suggestion again after the replay and the title. They must send no old suggestion.
- Each prompt of the user while a suggestion is live must record `ignored`, also a prompt with the text of the suggestion, because the client reports no accept. `ignored` must change no counter.
- `agents_feedback(decision="silence")` must stop each later prompt suggestion. The suggestion of the turn before ends at the start of the turn.
- A prompt suggestion is not permission. Megachat must start the work only when the prompt of the user arrives.
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
- A turn of a child result or of the summary of the past sessions must not change a setting or the status of the onboarding.
- The settings are `coordinator.model`, `coordinator.thinking`, `keepAlive.enabled` (`MEGACHAT_KEEPALIVE`), `keepAlive.hours` (`MEGACHAT_KEEPALIVE_HOURS`), `cache.ttl` (`MEGACHAT_CACHE_TTL`), `compaction.tokens` (`MEGACHAT_COMPACT_TOKENS`), `workday.enabled`, `workday.start`, `workday.end`, `workday.days`, `workday.timezone`, `workday.idleMinutes`, `report.morning`, `reply.suggestions` (`MEGACHAT_SUGGESTIONS`), `reply.language`, `reply.length`, and `reply.quoteRequest`.
- The settings of the index of past sessions are `sessions.index` and `sessions.days`. They must apply at once, also in the middle of a turn, because they change no model request.
- A model must be valid only when the model registry knows it. A reasoning level must be a level of pi-ai that the model supports.
- The output of `get` must list each model of the registry with the prices of its model data, and one note with the measurement of Claude Opus 5.5. It must give no measurement of another model.
- A changed setting must apply at once when no turn runs, else at the end of the current turn, before the next turn starts. A change must not apply in the middle of a turn. A setting with another time in its `applies` text, such as a setting of the children, must apply at that time.
- The model and the reasoning level must reach the next model request without a restart. A keep-alive request must use the same model and level as the turns.
- The keep-alive, the cache lifetime, the limit of a summary and the working day must take the stored value without a restart.
- The setting `reply.suggestions` must change the rules and the suggestion tools of the running main agent.
- The reply style must give lines of the rules of the main agent: the language, the length, and a quote of the original request in a report of a child result. The defaults must give the rules from before the settings.
- The rules that the settings give must be a section of their own, so a change sends only that section to the model again.
- Without `settings.json`, the onboarding must be pending. The rules of the main agent must then hold the setup rules of `resources/instructions-onboarding.md`.
- The setup rules must tell the agent to answer the user first and then offer the setup one time, to ask one question at a time with its default, to let the user skip one question or the setup, to store each answer at once, and to mark the onboarding done at the end. They must name only the settings of this build.
- After the status `done` or `skipped`, the setup rules must not come back by themselves, also after a restart. The rules must then say that the agent changes a setting or runs the setup again when the user asks.
- The status `pending` must bring the setup rules back. The tool result must hold them, so the setup can start in the same turn.
  [@test] ../test/settings.test.mjs
- The setting `children.agent` must select the agent of a new child task without a named agent: `claude`, the default, or `codex`. It must refuse `pi`, because a pi child cannot change code. A follow-up and a continuation must stay with the agent of their session. A change must apply to the next child task, also in the turn that made it.
- The settings `children.commit`, `children.push` and `children.daemonRestart` must take `allow`, `ask` or `deny`. The defaults are `allow`, `ask` and `ask`. A daemon restart is a restart or a stop of the Megachat daemon.
- At each dispatch, the daemon must add one rules paragraph from these settings to the prompt of the child, as a block before the task. A change must reach the next new task, follow-up and continuation. The state must keep the prompt of a run without the paragraph.
- `allow` must let the child do the step. `deny` must forbid the step, also when the task asks for it. `ask` must forbid the step unless the task says that the user approved it. The child must then say in its result that the step is necessary.
- The rules of the main agent must give the default agent and the three values, so the agent does not promise the user other rules.
- A turn of a child result or of the summary of the past sessions must not change these settings.
- A daemon restart must keep each setting of the children, the known repositories and the spend limit.
  [@test] ../test/settings.test.mjs
  [@test] ../test/child-settings.test.mjs
- The setting `children.parallel` must give the count of the child runs that run at the same time: an integer from 1 to 8. The default is 3. The value 1 must give the order and the states of the builds up to v0.3.0, which ran one child at a time.
- A change must apply to the next start of a child. It must not stop a child that runs. A lower value must let a queued run start only when fewer children run than the new value.
- The rules of the setup must ask for the setting. The rules of the main agent must say that tasks in different directories run at the same time, and that tasks in one directory or in a directory inside it run one after the other.
  [@test] ../test/settings.test.mjs
  [@test] ../test/parallel.test.mjs
- The setting `children.permissionMode` must select the permission mode of a Claude child: `inherit`, the default, `ask`, `allowEdits` or `auto`. `ask`, `allowEdits` and `auto` must give the modes `default`, `acceptEdits` and `auto` of Claude Code. One map in `src/Settings.mjs` must hold these names. The setting must not offer `bypassPermissions`. It must not offer `plan`, because the approval of a plan has options that switch the child to `auto` and to `bypassPermissions`.
- With `inherit`, Megachat must send no mode, and the settings of Claude Code decide. The adapter takes the start mode from `permissions.defaultMode` of each settings file of Claude Code, whatever `settingSources` says: also from `~/.claude/settings.json` of the user. So a user setting `auto` puts each Claude child in the mode `auto`, and a project can set the mode `plan`. The adapter ignores a mode `auto`, `acceptEdits` or `bypassPermissions` of the project settings. A load continues in the mode of its transcript.
- With another value, Megachat must send the mode in a `session/set_mode` request after `session/new` or `session/load` and before the prompt, so the mode wins over each settings file. The adapter ignores `permissionMode` in `_meta.claudeCode.options`. When the adapter refuses the mode, the run must fail before the prompt, with a message that names the value, and with no continuation. A closed connection must stay an interruption with a continuation.
- The setting must not change a Codex child or a pi child. A change must apply to the next Claude child: a new task, a follow-up and a continuation. A `settings.json` without the key must open with `inherit`.
  [@test] ../test/settings.test.mjs
  [@test] ../test/child-settings.test.mjs
- The setting `children.claudeModel` must select the model of a Claude child: `inherit`, the default, or a model as `provider/model`. The model registry must know the model, and its provider must be `anthropic`.
- The options of a Claude child must name the model `claude-sonnet-5-5`. The options alone do not decide: the adapter switches a session to the `model` of the settings of Claude Code, also of `~/.claude/settings.json`, and a load continues with the model of its transcript.
- With `inherit`, Megachat must send no model request. The model of the settings of Claude Code then decides, and without one the model of the options applies.
- With a model, Megachat must put its model ID in the options and send it in a `session/set_config_option` request with the `configId` `model` after `session/new` or `session/load`, before the mode and the prompt, so the model wins over each settings file.
- When the adapter refuses the model, for example because the `availableModels` of the settings of Claude Code do not hold it, the run must fail before the prompt, with a message that names the value, and with no continuation. The setting must not change a Codex child or a pi child. A change must apply to the next Claude child: a new task, a follow-up and a continuation.
  [@test] ../test/settings.test.mjs
  [@test] ../test/child-settings.test.mjs
- The setting `budget.dailyUsd` must be a daily spend limit of the main agent and the pi children in USD, from 0 to 100,000. The default 0 means no limit.
- Megachat must count the cost of each model request of the main agent and of each pi child on the local day: each reply, also a reply with tool calls, each summary and each keep-alive request. A request without a cost from its provider must get the cost from the prices of its model data. The cost of the Claude and Codex children must not be in the count.
- The count must stay in `spend.json` in the state directory with the mode 0600, so a daemon restart keeps it. The count must start again at the local midnight.
- When the count passes the limit, the rules of the next turn must hold one line with the spend and the limit, which asks for one short warning. The line must go away after a completed turn that had it. The user must get at most one warning on each day. Megachat must not stop the work.
- A warning that waits at the local midnight must not go into a turn of the next day, and it must not mark the warning of the next day as shown.
- `agents_settings get` must give the spend of the day, the limit, whether the warning went out in a completed turn (`warned`), whether a warning waits (`warningPending`), and a note that the Claude and Codex children are not in the count.
  [@test] ../test/spend.test.mjs
  [@test] ../test/pi-child.test.mjs
- The tool `agents_accounts` must check Claude Code and Codex in parallel. It must start each agent as a child starts, ask for `initialize` and `session/new` in the workspace of Megachat, send no prompt, and close the process after the check. The check has no project, so Claude must load no settings file: `settingSources` must be empty.
- Each agent must have a time limit of 30 seconds. A second call while a check runs must get the result of that check.
- An agent that opens the session must give the status `started` with the login `unknown`, because only a prompt proves that the provider accepts the login. The result must say so.
- An agent that refuses the session with the ACP error `authRequired` must give the status `failed` with the login `missing`. An agent that does not start, a failed Central configuration, a refused session and the time limit must give `failed`. Each failure must give the problem and what to fix, from the resources and not from the agent.
- The setup must run the check at its end and show the result. The rules of the main agent must run the check when a child fails with a login error.
  [@test] ../test/accounts.test.mjs
- In the modes `reply` and `ghost`, Megachat may offer one useful next step after work ends.
- After a refusal, it may then offer two alternatives. After the third refusal, it must stop proposing work.
- A direct request for silence must suppress proposals until the user asks to resume.
- Proposal decisions must survive a daemon restart.
- After the third refusal, only an accepted proposal, a new task of the user (`accepted`) or `resume` may permit another
  proposal. An automatic turn must not reset the count of the refusals.
- An event must not start delegated work without a user request.
- A user message must interrupt an automatic turn, such as the turn of the summary of the past sessions.
- A turn of the summary of the past sessions that a user message interrupted, or that failed for a reason that can go away, must run again one time with the same data after the turn of the user, as the morning report does. A stop of the user and a reason that does not go away, such as the limit of tool rounds, must end it.
  [@test] ../test/state.test.mjs
  [@test] ../test/integration.test.mjs
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
  table, and the session logs only with the consent `sessions.index`. It must change nothing.
- One session must give one row. An agent process below a process of the same agent must not be a row. An adapter must
  be a row only when no agent of its own runs below it. A helper of an agent, such as an MCP server, a shell or a tool,
  must not be a row. The background service of an agent (`claude daemon`, `codex app-server daemon`) and the processes
  of this daemon outside a child run, such as the account check, must not be rows.
- Each row must have `agent`, `sessionId`, `title`, `cwd`, `state`, `status`, `startedAt`, `lastActivityAt`, `pid` and
  `parent` with `kind`, `name` and `pid`. `kind` must come from the nearest owner in the parent chain: `megachat`, `ide`
  for an IDE, an editor or the desktop app of an agent, `terminal` for a terminal app or SSH, `multiplexer` for the
  server of `tmux`, `screen`, `zellij`, `herdr`, `dtach` or `abduco`, and `unknown` for the service of an agent, another
  app, or no owner. `name` must be the name of the app or of the program, never a command line.
- A bare `java` process with the main class `com.intellij.idea.Main` or
  `org.jetbrains.intellij.build.devServer.DevMainKt` on its command line must count as an IDE that runs from sources,
  with the `kind` `ide` and the `name` `java`. A JetBrains property such as `-Didea.platform.prefix` without such a main
  class is no sure sign of an IDE.
- For a process below this daemon, the state of Megachat must be the authority. The run of the supervisor PID must give
  the session ID, the title and the task directory.
- An orphan must mean: the owner process is gone, and the session process is still alive with the same start time.
  The state must be `orphan` only when the owner is gone for certain: the parent chain reaches launchd without an owner,
  and each process in it is a shell, `login`, `env`, `nohup`, a helper of Megachat or a process of the same agent; or
  the run of a Megachat child ended. A shell that stays after its terminal is no owner.
- The state must be `unknown` when the parent chain has no owner and has another live process that can own the session,
  such as a bare `java` process without a sure sign of an IDE or a script that started the agent, or when the chain
  ends before launchd. `incomplete` must give the count of such sessions. A session in the state `unknown` is not an
  orphan.
- Else the state must be `active` at a CPU load of 10 percent of one core or more, of the session process with its
  helpers, now or in a scan of the last 2 minutes, or at a write to its session log in the last 2 minutes. Else the
  state must be `idle`.
- The server of a multiplexer must own its sessions, also without a client. Thus a session in a detached `tmux` or
  `screen` is not an orphan, and its `parent.kind` is `multiplexer`.
- Without the consent `sessions.index`, `status` and `lastActivityAt` must be null, also for a child of Megachat. A
  session outside Megachat must have an empty `sessionId` and `title`, and `incomplete` must say that the session logs
  are off. Megachat must then read no session file and no process file of an agent.
- The order must be: orphan, unknown, active, idle, and the newest activity first in each group: the time of the last log write,
  or the start time for a row without a log. `limit` must be 1 to 200, and the
  default must be 50. `nextCursor` must continue after the last row of the page, and `truncated` must be true when more
  rows exist. `agent`, `project` and `state` must select the rows. `project` must select each working directory that
  is that directory or in it.
- The cursor must name the scan time of its view. Megachat must keep the view of the last page with a next cursor for
  1 minute, one view only, and the next pages of that cursor must come from it, so a change of the activity or of the
  state moves no row across the cursor. When that view is gone, the page must come from a new view after the last row
  of the cursor, and `incomplete` must say that a session can be missing or come two times.
- Megachat must keep the view of the processes for 5 seconds, so two calls in that time make one `ps` call. `scannedAt`
  must give the time of the view. Megachat must get the working directory once for each process, and again for a PID
  with another start time.
- Megachat must read a name and a command line outside ASCII as UTF-8, also an app name such as `Café.app`, and the
  start time in one fixed format.
- A working directory that Megachat cannot read must give a row with the `cwd` null and an entry in `incomplete`, not an
  error. A failed `ps` call must give an empty list and an entry in `incomplete`. On a platform other than macOS, the list
  must be empty, and `incomplete` must name the platform. `incomplete` must name the logs of OpenCode when the list has
  an OpenCode session.
- The output must hold no command-line argument, no message text and no environment. The MCP server of the children must
  not have the tool.
  [@test] ../test/running.test.mjs
  [@test] ../test/session-logs.test.mjs
- The tool `agents_stop` of the main agent must stop an orphan session of `agents_running` with a signal, in two steps.
  The MCP server of the children must not have the tool. A restart of the daemon must not run a cut-off call again.
- The first step, a call with `pids` and without `confirmation`, must send no signal. It must give the targets (the PID,
  the start time, the agent, the program, the project, the owner and the sessions of each process), the refused PIDs
  with a reason that the model can give to the user, and a confirmation for the targets. A list without a target must
  give no confirmation.
- The confirmation must be bound to the PIDs, their start times, the digests of their command lines, the signal and the
  turn. It must be valid one time only, also when its check fails, for 5 minutes, and only in a later turn of the user.
  A confirmation of the same turn, of other PIDs or of another signal, an expired one, a used one and an unknown one
  must send no signal. The confirmations must stay in the memory of the daemon only.
- Directly before the signal, Megachat must read the process table again. Each process must have the same PID, the
  same start time and the same command, and its state must still be `orphan`. Else no process of the call must get the
  signal, and the result must give the reason for each changed process.
- Only a turn of the user must call the tool. An automatic turn and a call without a turn must be refused in both
  steps.
- Megachat must stop only an orphan. A session with a live owner, such as an IDE, a terminal, a multiplexer or a
  Megachat run, must be refused with the name of its owner, so the user stops it through the owner. A session in the
  state `unknown` and a PID that is no agent session must be refused too.
- The first signal must be `SIGTERM`. `SIGKILL` must go out only through a second confirmation of the same kind, and
  only to a process that got `SIGTERM` from this tool and still lives with the same start time and command.
- Before each other check, the tool must refuse PID 1 and below, the PID of the daemon, its parent, each process above
  them, and a process of another user or of an unknown user. On a platform where `agents_running` gives no row, the tool
  must refuse.
- The signal function and the process table must come by injection, so a test sends no real signal. The default signal
  function must be `process.kill`.
- The result and the log of the daemon must hold the PIDs and the outcome (`sent`, `ended`, `denied` or `failed`), and
  no content of a session and no command line.
- The instructions of the main agent must tell it to show the list to the user, to ask for a confirmation of exactly
  these PIDs, and never to confirm for the user.
  [@test] ../test/stop.test.mjs
- With the consent `sessions.index`, Megachat must keep a live table of each session file of Claude Code, Codex and pi
  on the machine, also outside the listed directories, without the archived and the compressed Codex session files, in a table of its own in `sessions.sqlite`: the path, the inode,
  the size, the byte offset, the agent, the session ID, the `cwd`, the title, the start time, the time of the last write
  and the last step. It must hold no message text. A restart must answer from this table before it reads a file again.
  A query of `agents_running` must read the memory, not the session files.
- The first pass must read the head and the last 64 KB of each file: the files with a change in the last 24 hours first,
  the newest first, then the other files. A tail without a step can read more lines backwards, at most 1 MB.
- The table must read a file on an event of the watch of the provider roots, the same watch as the index. Each file with
  a write in the last hour must also get a poll of its size every 2 seconds, because macOS reports a write only when a
  file closes, and Codex keeps its file open. The log of each Codex row must also get a stat at each scan
  of `agents_running`, whatever the age of its last write, and a read when it changed, because a session can be quiet
  for more than an hour. A read must take only the appended complete lines. A smaller file or
  another inode must make the table read the file again.
- Each row must get its session log only by a certain link: the session ID of a Megachat run; an open log of the process
  (Codex keeps its log open, one row for each open log of a `codex app-server`; an open `.jsonl` file of another
  agent must give no link); the process file
  `~/.claude/sessions/<PID>.json` of Claude Code with the PID and the same start time, a regular file of at most 16 KB
  and not a symbolic link; else the only log of the agent
  in the `cwd` that began in the first 30 seconds of the process, when no other row of the agent in that directory
  could have begun it, and when no other log of the agent there, that no other row could have begun, has a later
  write. Thus a process that moves to another log with `/new` or `/resume` must not keep the title of its first log.
  Two processes of one agent in one directory that start at nearly the same time must not get a
  log, so no row shows the title of another session. A row without a certain log must have an empty `title`, a null
  `status` and `lastActivityAt`, and one entry in `incomplete` must give the count of such rows.
- The log must give `sessionId`, `title` (a title of the user or of the agent, never a message text), `lastActivityAt`
  (the time of the last write) and `status`. The status is a reading of the log tail, not a fact from the agent, except
  a status from the state of Megachat or from the process file of Claude Code:
  - `working`: the tail ends with a tool call, a tool result or a message without a reply, and the last write is less
    than 10 minutes old. Without a write and a CPU load for 2 to 10 minutes, the status stays `working`.
  - `stuck`: such an open step and no write for 10 minutes or more.
  - `waiting_for_user`: the tail ends with a finished turn, an interrupted turn, or a log without a turn. A local
    command of Claude Code (such as `/model`), a shell line of its bash mode (`!`), a note of its memory mode (`#`)
    and the output of each one start no turn.
  - `idle`: a finished turn and no write for 30 minutes or more.
  - `waiting_for_permission` for a child of Megachat: the run of the row has a pending permission request of its
    current generation in the state of Megachat. This must hold for a Claude, a Codex and a pi child, whatever the log
    or a process file says, also without a read log. A child whose run has no pending request must get its status from
    its log. A pending request of a run must not change the status of a session that is no child of Megachat.
  - `waiting_for_permission` for another Claude Code session: the process file `~/.claude/sessions/<PID>.json` says
    that the session waits for a permission: the field `status` is `waiting`, and the field `waitingFor` is
    `permission prompt`, `sandbox request`, `worker request` or `goal proposal`. Claude Code puts these four values in
    the group `permission` of its own status line.
  - `waiting_for_user` from the process file: the field `status` is `waiting`, and the field `waitingFor` is
    `input needed`, a question to the user. Claude Code puts this value in the group `question`. `dialog open` must give
    the status of the log.
  - A status from the process file must replace `working`, `stuck`, `waiting_for_user` and `idle`, so a session that
    waits for the user does not become `stuck` because its log is silent.
  - The process file is a hint of another program. Each of its statuses must count only when the file gives the link of
    the row, so a file with another PID, another start time, a symbolic link, a file above 16 KB and a file that is not
    valid JSON give no status. Its field `statusUpdatedAt` must be a number and must not be more than 1 minute in the
    future. The log must have no write more than 10 seconds after `statusUpdatedAt`. A CPU load of the process at the
    scan must cancel a wait that started 2 minutes ago or more, because a process that waits uses no CPU. Else the row
    must get the status of its log, and a file that Megachat cannot read must give no error.
  - Codex and pi write no record of a permission request, and no other file of them tells it. A pending permission
    prompt of a Codex session shows as `working`, then as `stuck`. pi has no permissions.
- A session in a detached `tmux` keeps its multiplexer owner and gets its status from its log as each other session.
- `incomplete` must name the first pass of the table while it reads the files of the last 24 hours, the count of the
  rows without a certain log, and the count of the logs that Megachat could not read.
- Megachat must write to no provider file and open each one read-only.
- When the consent goes off, a call of `agents_running` or of `agents_session_history` that runs must read no more
  session file, and a call after the change must get no data of a log, also from a scan that started before it.
  [@test] ../test/session-logs.test.mjs
  [@test] ../test/session-index.test.mjs
- `agents_session_history` of the main agent with `order` `newest` must read a session of the live table by its agent
  and session ID, also outside the listed directories, from the end of its log: the last `limit` entries (20 by
  default, at most 100) in the order of the log, and a cursor to the older page. `query` must select the entries in the
  session. A page must read at most about 8 MB, so a log of 600 MB opens without a read of the whole file. Each entry
  must come in exactly one page, also an entry whose line crosses the limit of 8 MB of a page. A cursor past the end
  of a log that became shorter must fail with the error of an invalid cursor, and a page that reads no line must give
  no cursor, so a caller that follows the cursor does not loop. Each text
  must pass the secret filter and be cut to about 2 KB. Without the consent, the tool must fail with a text that says
  that the session logs are off. The tool `session_history` of the children must keep its limit to the listed
  directories and must not have `order`. Its description must not offer `order` or a read outside the listed
  directories.
  [@test] ../test/session-logs.test.mjs
  [@test] ../test/session-history.test.mjs
- With the setting `sessions.index` on, Megachat must keep an index of the past Claude Code, Codex and pi sessions in `sessions.sqlite` in the state directory. The default is off.
- The setup must ask for the consent with "Index past Claude, Codex and pi sessions in your projects, and read the logs of the agent sessions that run on this machine to show their status? Megachat reads the content of a session only when you ask. Everything stays local." The main agent must set `sessions.index` to on only when the user agrees.
- With the setting off, Megachat must read no session file for the index or for the live table of `agents_running`, watch no directory of a provider, and keep no `sessions.sqlite`. A change to off must stop the import and delete the file.
- A change to on must start the import at once, without a restart. A start that failed, for example because the index file could not open, must run again at the next set of a setting of the index, also of the same value.
- The index must hold only a session whose `cwd` is a listed directory or a directory in one. The sessions of a newly listed directory must enter the index. The sessions of a removed directory must leave it.
- The sources must be `~/.claude/projects/<encoded cwd>/<session ID>.jsonl`, `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` or `$CODEX_HOME/sessions`, the archived Codex sessions `~/.codex/archived_sessions/rollout-*.jsonl` or `$CODEX_HOME/archived_sessions`, and `~/.pi/agent/sessions/--<path>--/*.jsonl` or `PI_CODING_AGENT_SESSION_DIR`.
- Codex compresses a session file without a change for 7 days to `rollout-*.jsonl.zst`, in both Codex directories. The import must read such a file with the same rules as a plain file: the age limit by the modification time, the cut of each entry and the secret filter. A compressed file must have a new import of the whole file at each change. When the plain file and the compressed file of one session both exist, the import must take the plain file, as Codex does.
- When Codex compresses a file, makes a plain file of a compressed one again, or moves a file to the archive and back, the session must keep each entry, in each order of the watch events. A file that leaves the index must make a new import of each other file of its session from the start.
- An archived file and a compressed file hold no running session: the live table of `agents_running` must not read them.
- The import must take the sessions with activity in the last `sessions.days` days, 180 by default. The value 0 must take all sessions. A session that becomes older must leave the index at the next pass.
- For each file, the index must keep the path, the size, the modification time, the inode, the byte offset of the import, and a hash of the 128 bytes before the offset. The import must read only the appended complete lines. A last line without a newline must stay unread until it is complete.
- A smaller file, another inode, or other bytes before the offset, as after a rewrite in place, must make the import read the whole file again.
- A file that the import read to its end, with the same size and another modification time, must make the import read the whole file again too, because a writer of a session file only adds lines. So a rewrite in place that changes only bytes before the last 128 is found without a read of each file at each pass. A `touch` gives a new import too. A rewrite that also makes the file larger and keeps the 128 bytes before the offset is not found.
- An entry with the entry ID of an entry in the index, such as a copy in a fork, must be in the index one time.
- The index must keep at most about 2 KB of the text of each entry, tool calls and tool results included.
- Before the index keeps a text, it must replace each text that looks like a secret with a marker: an API key with a well-known prefix, a Bearer token, a private key block, a JWT, and an assignment such as `password=` with a long value, also in a JSON text with escaped quotes such as the arguments of a tool call. This is a best effort: a secret of another shape can stay in the index.
- The filter must also replace the password in the user information of a URL (`https://user:password@host`), the text after `Basic` that is the base64 text of `user:password`, the password of the option `-u` or `--user` of `curl`, and the whole value in quotes of such an assignment, so a passphrase with spaces goes as a whole. The text around a secret must stay: the name, the quotes, the user and the host. An email address, an `ssh` remote such as `git@github.com:owner/repo.git`, a URL with a user and no password, a word after `Basic` such as `Basic usage`, and a sentence with the word `password` and no value in quotes must stay as they are.
- A change of the filter must change the index `VERSION`, so the next start makes the index again from the session files, and no text that an earlier filter kept stays.
- Each title of a session, from the session file or from the first prompt, must go through the same filter, and the index must keep at most 200 characters of it.
- The first pass must import the files of the projects of an IDE first, and the newest files first. The import must run in bounded batches with a pause between them, so the chat stays usable.
- A file that the import cannot read must not stop a pass. The import must log the failure without a path or a text, skip the file, and continue with the other files. A pass that failed must run again on the next change of a session file.
- The import must try such a file again at its next change, at the next pass and at the next event of the watch for the file, so a file that becomes readable again after a `chmod`, without a change of its size, its inode or its modification time, enters the index. A search must not try it again. A file in the index must keep its entries and its offset, so the next try reads only the new lines.
- When Air sent `asyncTasks`, the chat must show the first pass, and a later pass of 20 files or more, as a background task with its progress. The output of `agents_settings` with `get` and of the session tools must give the state and the progress of the index.
- After the first pass of a new index file, the main agent must tell the user a short summary in one event turn: the number of sessions and of projects, and the last unfinished sessions. The summary is data, not instructions.
- After the first pass, the import must catch up at the start of the daemon, on a change of a session file, and on a change of the listed directories. A root of a provider that does not exist at the start must get its watch when it appears: Megachat watches its nearest parent that exists, without a poll. Then it runs a pass, and the live table reads each session file of the root. A search must first import the new lines of the files of its directory, for at most 2 seconds. A failed import before a search or a read must make the page of the index incomplete and must not fail the tool.
- An index file of another `VERSION` must be made again from the session files. The live table of `agents_running` in the same file must be made again too, so each table of the file has the same version.
- With the index on, `agents_sessions` and `agents_session_history` of the main agent, and the tools `sessions` and `session_history` of a child, must answer from the index. A search must give one match for each session, best bm25 first, with a snippet.
- A later page of a search or of a list must not give a session of an earlier page again. A later page of a search must skip each entry that came after its first page. A list must page by the time of the last activity and the row ID of a session, not by a count.
- They must use the live provider when the index is off, when the index has no session of the agent in the directory, and for a query without a word of 3 or more characters.
- pi must be an agent of these tools. Without the index, a request for pi must fail with a text that says that the index is off.
  [@test] ../test/session-index.test.mjs
- Megachat must not watch the files of a project, and a change of a file in a project must start no turn. The only file watch of the daemon is the watch of the provider roots of the session index. The daemon must have no route `/project-event`.
  [@test] ../test/integration.test.mjs
- Megachat up to v0.3.0 watched the files of each project and reported a change in an event turn, with the settings `events.enabled` and `events.ignore`. A stored value of these two settings must cause no error, and `agents_settings` must not give them. The next write of `settings.json` must drop them. Another key that this build does not know must stay in the file.
  [@test] ../test/settings.test.mjs
- A state that holds the changes that waited for their event turn (`initiative.pending`) must open, and these changes must start no turn.
  [@test] ../test/state.test.mjs
- An old history entry of such an event turn (`air.megachat.event` with the type `project`) must stay readable in the replay, the history tools and the search index.
  [@test] ../test/search-index.test.mjs
  [@test] ../test/upgrade.test.mjs

## Data & Backend

- The state must live in `~/.jetbrains/air/megachat/` for each user: `%USERPROFILE%\.jetbrains\air\megachat` on Windows.
- All JetBrains products of the user must share this directory, its daemon, and its conversation.
- `MEGACHAT_HOME` or the final command argument may select another directory for a test or development.
- The directory must hold `conversation.sqlite`, `owner.sqlite`, `search.sqlite`, `workspace/`, and `daemon/` with the connection file and log. It may hold `settings.json` and `spend.json`.
- It may hold `sessions.sqlite`, the index of past sessions and the live table of the session files, only with the consent of the user.
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
- The home directory itself, its `Library` directory, the hidden directories directly in it, and the state directory of Megachat must be refused. A repository that the user names may be in a hidden directory deeper in the home directory or in a root.
- A child in a known repository must have that repository as its working directory, also when no IDE has opened it.
- A task, a follow-up, a continued session, and a session search must refuse a directory that is not listed.
- `agents_list` must give each listed directory one time with its origin: `ide`, `known`, or `megachat`. The workspace of Megachat must have the name "Megachat workspace".
  [@test] ../test/projects.test.mjs
- The action `discover` of `agents_projects` must give the git repositories in `~/src`, in `~/IdeaProjects` and in each root of `MEGACHAT_PROJECT_ROOTS`: a directory of a root, or a directory in a directory of a root, that holds a `.git` entry. It must not give a listed directory.
- The scan must not go into a repository or a hidden directory, must follow no symbolic link, and must read no file. It must give at most 200 repositories, the newest change of `.git` first, and `truncated` when more exist. It must add nothing to the list.
- The setting `projects.newRoot` must name the directory of a new project without a named location: an absolute path, `~`, or a path that starts with `~/`, and `~\` on Windows. It must refuse each other form, so the create can expand each value that the setting accepts. The default is `~/src`.
- The action `create` must make `<projects.newRoot>/<name>`, or `<name>-2` and so on when the name is taken, and add it to the known list. The name must be one directory name of at most 100 characters that is not hidden.
- A run again of the same `create` call after a restart must give the directory of the first run and must make no second directory, also when the restart came between the `mkdir` and the state commit. The state must keep a bounded set of these records.
- The root of a new project must be in the home directory or in a root of `MEGACHAT_PROJECT_ROOTS`, out of the state directory, and no directory below the home directory or below the root on its path may be hidden. The daemon may make a root that does not exist. Only a turn of the user may make a project.
  [@test] ../test/discovery.test.mjs
- A project directory that the daemon cannot read must not stop the attach of a view or the registration of the other directories.
  This also applies to the working directory of `session/new` and `session/load`.
- The daemon must run at most `children.parallel` children at the same time. Claude, Codex and pi children must count together.
- Two children must never run in one checkout at the same time, whatever the limit is, because two agents that change one checkout break the work of each other. Two runs must conflict when the real path of the directory of one run is the real path of the other, or a directory in it. The rule must compare path segments, so `/work/app2` is not in `/work/app`, and a symbolic link to a directory is that directory. A follow-up, a continuation and a continuation for a message of the user must keep the rule of their directory.
- A queued run must wait while a conflicting run runs, and behind a conflicting run that is earlier in the queue and waits, so a run in a directory with many subdirectories gets its turn. It must not stop a queued run behind it that conflicts with no earlier run. Among the runs that can start, the queue order must hold across the ACP and the pi runs. A continuation for a message of the user must come before the older queued runs of both kinds.
- The rule must have no exception for the Megachat workspace or for a broad directory. The tasks without a project share the workspace, so they run one after the other. A task in a listed directory that holds other listed directories, such as a home directory that an IDE opened, waits for each task in them, and they wait for it, because its child can change each of them.
- At most one pi child must run at a time, inside the limit. A queued pi run that waits for this place must not stop a queued run of another agent in another checkout behind it. A daemon of v0.3.0 follows a dispatched pi run after a restart only when no other child is active. With two dispatched pi runs, it would start no child again. Pi Durable can run two child conversations at the same time.
- A dispatched pi run that continues after a restart must take its place also over the limit, because Pi Durable continues it. It must count for each later start.
- Each run must keep the time of its start, `startedAt`, so the state shows which children ran at the same time.
- The deadline, the permission requests, the messages of the user, a cancel and the output must stay for each run. A permission request of one run must not stop another run. A stop of a main task must cancel each child that it owns and no other child.
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
- Permission waits must suspend the child execution deadline.
- The deadline must start again only when no permission request of the child waits.
  [@test] ../test/integration.test.mjs
  [@test] ../test/state.test.mjs
  [@test] ../test/recovery.test.mjs
  [@test] ../test/transport.test.mjs
  [@test] ../test/launch.test.mjs
  [@test] ../test/parallel.test.mjs
- A Claude child must work as Claude Code works in the directory of its run. It must start with `settingSources: ["project"]`, so it loads `CLAUDE.md` with its `@` imports, `.claude/settings.json` of the directory of the run with its permissions, hooks and `env`, the MCP servers of `.mcp.json`, and the skills of `.claude/skills`. A project hook and a project MCP server then run without a question, and a project hook runs with the environment of the child, the key of Megachat included. It must not load `.claude/settings.local.json`, a `.claude/settings.json` of a parent directory, and no file of the user: not `~/.claude/CLAUDE.md`, not `~/.claude/settings.json`, and not the skills, the plugins and the MCP servers of the user. The adapter of Claude Code reads the permission mode and the model from each settings file all the same. The settings `children.permissionMode` and `children.claudeModel` control them.
- The options of a Claude child must hold no session settings. The SDK puts them in the command line of the Claude process, which each local user can read, and the base URL of Central holds the key. The key and the base URL must go only in the environment of the agent.
- Claude Code applies the `env` of the project settings after the environment of the child. So before the launch of a Claude child, Megachat must read the project settings as Claude Code reads them, with `resolveSettings` of the SDK. When their `env` sets `ANTHROPIC_BASE_URL`, Megachat must refuse the run before it starts the agent, because the child would send its requests and the key of Megachat to that address. The failure of the run must name the file and the variable, and never the value. A project key or another variable must not refuse a run: it does not move the key of Megachat. A settings file that is not valid must not refuse a run, because Claude Code ignores it. When the read of the settings fails, the run must go on, and the log of the daemon must say that the guard did not run, with no content of the settings. This is a guard against an accident, not against a hostile project, because a project hook can read the key.
- Claude Code does not read `AGENTS.md`. When the directory of the run has an `AGENTS.md` and neither `CLAUDE.md` nor `.claude/CLAUDE.md`, the prompt of each dispatch of a Claude child must hold the content of `AGENTS.md` after the rules of the user, marked as the rules of the repository, with the read and the limit of the rules of a pi child. With a `CLAUDE.md`, the prompt must hold no such block, because Claude Code loads the file with its imports. A Codex child must get no such block, because Codex reads `AGENTS.md` by itself.
  [@test] ../test/child-settings.test.mjs
- `agents_spawn` with `agent` `pi` must start a pi child: an ownerless conversation in the harness of the main agent, in the daemon process, with no new process. The ID of that conversation must be the provider session ID of the run. `agents_list` must name `pi` as an agent.
- A pi run must go through the same states as an ACP run, and the main agent must get one report of its result. The limits, the queue and the prune rules of the runs must apply to it.
- A pi child must use the model of the setting `children.piModel`, `provider/model`, which the model registry must know. The default is `anthropic/claude-haiku-5-5`. When the registry does not know the effective value, as in a test, a pi child must use the model of the main agent. The model of the main agent must not change. A change must apply to the next pi run, also to a follow-up.
- A pi child must have only the tool `read`. It must get none of the `agents_*` tools, not the rules of the main agent, not the section `settings`, not the instructions of the user, and not the hooks of the main agent. Its instructions must say what it can do, and they must hold the content of `AGENTS.md` of the directory of the run, else of `CLAUDE.md`, at most 32,000 bytes, marked as the rules of the repository. A rules file that is not a regular file, such as a FIFO, must not count, and its read must not wait.
- The environment of a pi child must read only the files of the directory of its run. It must compare real paths, so `..`, an absolute path, `~` and a symbolic link must not lead out of the directory. After the open, a read must refuse the file when the path has another real path, or when the open file is not the file at its real path. So another process that swaps a directory of the path cannot lead a read out of the directory. The read of the rules file must go through the same environment. An error of a read must not tell whether a path out of the directory exists: such a path must get the same error, whether it exists or not, and no error may hold a path out of the directory other than the requested path. It must refuse each write, command, watch and temporary file. The main conversation must get no environment. A read-only child needs no sandbox, because this environment is its only way to a file.
- `read` must return at most 2,000 lines or 50 KB of a text file, or one image of at most 4.5 MB, in each call. A run of a pi child must end after 20 tool rounds, as `failed` with the reason code. The output of a pi run must keep the text of each answer of the child within the retention limit of a child output. A pi continuation must keep a copy of the output of the run before it only for a restart of its dispatched run. At its end the copy must go, and `agents_inspect` and `agents_wait` must return the output one time.
- `agents_send` must submit a follow-up to the same conversation. A pi run must refuse a session of the pi command-line agent.
- `agents_cancel` and the deadline of 30 minutes must abort the conversation of the child. The main conversation must continue. A run at the deadline must become interrupted with no continuation. Before the dispatch, in `launching` and `ready`, `agents_cancel`, the deadline and a daemon stop must also end a run whose step waits, so the run cannot hold the place of a child.
- A daemon restart during a dispatched pi run must not lose the run. Pi Durable continues the conversation, and the next daemon must follow the same run to its end. A pi run that had not sent its prompt must become interrupted and continue, as an ACP run does.
- A pi child must not be a service session, so Megachat must send no `_session/service/record` for it. The chat must list it as a background task of the agent `Pi`.
- `agents_session_history` with the agent `pi` and the session ID of a pi run in its directory must read the transcript of that child, also without the index of past sessions.
- A pi child shares the event loop and the memory of the daemon. The turn limit, the deadline, the size of a read and the size of the stored output bound it.
- Pi Durable 1.5.0 cannot delete or archive a conversation. So `conversation.sqlite` must keep the conversation of a pi child after the prune drops its last run.
- `agents_steer` must work for a pi run with the same record, limit, outcomes and refusals as for an ACP run. For a pi run, the submission of a message is a commit in the same storage as the state: the commit that submits the message to the conversation of the child also marks it `delivered`, with the request ID of the tool call, so a message arrives one time, also after a restart.
- A message for a pi run that did not send its prompt must go in that prompt, as a block after the task (`queued`). A message for a pi child that works must go to its conversation with `whenBusy: "steer"` and `whenIdle: "reject"`, so Pi Durable places it after the current tool round (`injected`). The run must end only after the run of each such message. When the turn ends without an answer, the run must withdraw each such message that Pi Durable did not place, and it must not wait for it. A continuation must carry that message as a possible repeat. When no continuation follows, as after the turn limit or the deadline, the error of the run must tell the main agent that the child did not get it, and the run must keep its text.
- A message that the conversation refuses because its turn ended must wait, and the end of the run must give a follow-up in the same conversation with the message (`followUp`). The mode `interrupt`, and each other refusal, must abort the turn and continue in the same conversation with the message (`restarted`).
- After a daemon restart, a `pending` message of a pi run must still arrive.
- The continuation of an interrupted pi run, and the continuation after a stop for a message, must have texts of their own that name no git status, because a pi child only reads.
- The setting `cache.ttl` applies to the requests of a pi child too. Pi Durable 1.5.0 reads the stream options of the harness without the conversation, so a child cannot get a cache lifetime of its own without a rewrite of the provider request.
  [@test] ../test/pi-child.test.mjs
  [@test] ../test/settings.test.mjs

## Error Handling

- An agent exit must mark its running task interrupted before it continues.
- Before it opens the state, Megachat must read the Pi Durable schema version.
- A version newer than this build supports must stop the start with "Megachat state was created by a newer Megachat build; update Megachat." It must not change the state.
- A failed integrity check must leave the earlier state unchanged and start no daemon.
  [@test] ../test/home.test.mjs
- A state of the last release must open with the new release, after a stop and after a kill of the daemon. The open
  must write no failure to the log. Each run, permission request, report, suggestion and history entry of the state
  must stay, and each field that the new release added must get its default. A dispatched run and a pending permission
  request must recover as after a restart of the same release. The search index of the state must stay in use.
  `test/fixtures/v0.2.0/generate.mjs` makes the fixture with the code of the last release.
  [@test] ../test/upgrade.test.mjs
- The daemon must retain the output of an interrupted task.
- A failed Central configuration must start no child agent.
- Stored conversation data must contain no Central credentials.
- A reply that fails on a model error must tell the user "The model did not answer. Send the message again."
- The state must keep only the reason code of a failed reply, not the error text of the provider.
  [@test] ../test/integration.test.mjs
- A child agent must not stay alive after its daemon. This also applies when the agent still writes output.
- A helper of a child agent in its process group, such as an MCP server or a background shell, must not stay alive after
  the agent ends by itself.
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
- It does not run two children in one checkout at the same time, and it does not run two pi children at the same time.
- A pi child does not run a command, change a file, or apply the skills and the settings of Claude Code.
- Air does not show the transcript of a pi child.
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

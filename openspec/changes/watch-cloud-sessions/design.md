# Design

## Context

See proposal.md for the reason. The facts that shape the design:

- `airc` 0.1.3 is a plugin of Central. Central installs it in `~/.jetbrains-central/plugins/airc` and gives it the Central
  login (the hook `plugin-loaded` runs `airc login --credentials central`). `central exec airc` does not run it, so
  Megachat runs the binary of the plugin by its path. `central plugins` prints one line for each plugin, with the
  fields separated by tabs: the ID, the version, the state, `present=`, `origin=`, `source=<directory>` and `hooks=`.
- `airc sessions --limit <n>` prints a JSON array. Its entries have a type of `airc` itself, not the wire type of the
  agent spawner (`listedSession` in `internal/commands/session_list.go` of `JetBrains/air-cloud-cli`): `id`, `name`,
  `status`, `statusComment` (only when the cloud gives one), `agent`, `repositories` (`host`, `organization`,
  `repository`, `branch`, `resultsBranch`), `updatedAt` and `taskId`. One call took 0.9 seconds on the machine of the
  author.
- The statuses of the agent spawner are `LAUNCHING`, `STARTING_CONTAINER`, `RUNNING`, `USER_INPUT_REQUIRED`, `FINISHED`,
  `ERROR`, `ABORTED`, `CANCELLED`, `SUSPENDED`, `ARCHIVED` and `DRAFT` (`session_event.proto` of
  `JetBrains/jcp-agent-spawner`). `SUSPENDED` is a session with a stopped environment that can continue.
- The notes about the agent sessions (`src/SessionNotes.mjs`) already have the full path of a note into the
  conversation: `MegachatState.sessionNote` writes an entry of the kind `air.megachat.note` only when no turn and no run
  is live.
- The tools of the main agent come from `extension()`, and `applySettings()` installs them again after a change of the
  settings. A tool that comes or goes changes the tools of the next request (see the change
  `cache-marker-before-tool-change` about the cost of that request).

## Goals / Non-Goals

**Goals:**

- One module, `src/CloudSessions.mjs`, holds the detection, the read, the plan, the text and the timer. The service and
  the state only wire it.
- The tool, the rules line, the reads and the report part have one gate: `cloud.sessions` is on and `airc` is found.

**Non-Goals:**

- A cache of the list between the tool and the timer. Each call of the tool reads the list again.
- A watch of `central plugins` for a plugin that comes or goes while the daemon runs.

## Decisions

### The term "cloud session"

`airc` and the agent spawner say "session". Megachat already says "agent session" for a session on the machine and
"child task" for its own work. So the term is "cloud session": the setting `cloud.sessions`, the tool `agents_cloud`,
the state field `cloudSessions` and the capability `cloud-sessions`. The rules line tells the main agent that the user
can say "cloud task" or "cloud agent" for a cloud session.

Alternative: "cloud task", the word of Air Web. A task of the agent spawner can hold more than one session, and "task"
already means a child task in Megachat.

### The gate

`adopt()` computes `cloudState`: `off` when `cloud.sessions` is off, `on` when `airc` is found, else `missing`.
`extension()` adds `agents_cloud` only for `on`. `settingsRules()` gives one line for `on`, one line for `missing`, and
no line for `off`, so a user without `airc` sees no change of the rules or of the tools.

The detection runs only with the setting on: at the start of the daemon, at each set or reset of `cloud.sessions`
through `agents_settings`, and in `applySettings()` when the setting is on and no detection ran since it turned on (a
hand edit of `settings.json`). A detection is one `central plugins` call with a time limit of 10 seconds. The path of
`central` is `CentralConfigurationService.central`. The default `off` keeps the tools of each current user as they are
after the update, so the update costs no uncached request.

Alternative: the fixed path `~/.jetbrains-central/plugins/airc/airc`. It breaks when Central moves its plugins, and it
does not see a disabled plugin.

Alternative: a tool that is always there and refuses without `airc`. Its description would be in each request of each
user, also of the users who cannot have `airc`, because the plugin is internal.

### A tool of its own, not a flag on the tools of the child runs

The child runs have their own tools: `agents_spawn`, `agents_list`, `agents_inspect`, `agents_wait`, `agents_send`,
`agents_steer`, `agents_resume`, `agents_cancel` and `agents_close`. A cloud session gets the new tool `agents_cloud`,
not a flag `local` or `cloud` on each of these tools. The author of the change agreed to this decision. The commands of
`airc` 0.1.3 for each tool:

| Tool | With a flag `cloud` | Command of `airc` |
|---|---|---|
| `agents_list` | Can list the cloud sessions next to the runs | `sessions` |
| `agents_inspect`, `agents_wait` | Can give the status, the comment and the results branch, but no output of the agent | `sessions --id` |
| `agents_spawn` | Can start a session on the remote branch, without a title | `sessions start` |
| `agents_cancel` | Can cancel, but it archives the full task, and an archived session cannot continue | `sessions cancel --id` |
| `agents_send`, `agents_steer`, `agents_resume`, `agents_close` | Must refuse | none |
| `agents_running`, `agents_sessions`, `agents_session_history` | Must refuse: they read the processes and the logs of this machine | none |

The reasons:

- A cloud session is not a child run. Air, Air Web and the automations start most of them, and Megachat cannot control
  them. The closest tools are `agents_running` and the notes about the agent sessions: they show the sessions that
  Megachat did not start. `agents_cloud` and the cloud notes follow them.
- A child run ends with an ACP event, and its output goes to the main agent in a turn of its own. A cloud session gives
  only a status, a comment and a results branch, and only a read of the list finds its end.
- A new parameter of a present tool changes the tools of each user, also of a user without `airc`, and each user then
  pays for one uncached request. A tool that comes only with `airc` changes nothing for the other users.
- This change only reads. A flag would change only `agents_list`, and four tools would refuse it.

Alternative: a flag on the tools of the child runs. A later change, "cloud child runs", can add it together with the
start and the cancel:

- `agents_spawn` with `cloud: true` starts a cloud session after a dialog of the user, as `agents_stop` asks, because a
  start costs credits. The cloud works on the remote branch, so the session does not see a change that is not pushed.
- `agents_inspect` and `agents_cancel` work on the run ID of that session. A cancel needs a dialog too, because it
  archives the full task.
- `agents_send`, `agents_steer`, `agents_resume` and `agents_close` refuse it with the reason `cloud`.
- The end of the session goes to the main agent as the result of a child run, with the status and the results branch.
- `agents_cloud` can then become a part of the output of `agents_list`. The cloud notes stay for the sessions that
  Megachat did not start.

### The read

`readCloudSessions(airc)` runs `airc sessions --limit 50` with `execFile`, a time limit of 30 seconds, a buffer of 4 MB
and the `PATH` of Central first, as the key helper of Claude Code gets it (`centralPath()`). The output must be a JSON
array of objects with a string `id`. Else the read fails with the exit code and the first line of the error output, at
most 200 characters. The log line of a failed read has the exit code only, because the output can hold the names of the
sessions.

Alternative: the store of Air. Air keeps a thread for each session that it opened, also for a cloud session, in
`~/Library/Caches/JetBrains/<IDE>/acp/projects/<hash>/threads/<id>/`: `summary.json` with `association.namespaceId`
`cloud`, and `events.jsonl` with the transcript and the events `ThreadWaiting`, `TurnEnded`, `ResultsBranchUpdated` and
`SessionFailureUpdated`. Megachat already reads this store for the archive state (see `AirArchive.mjs`). The store has
the output of the agent, and `airc` does not give it. But the store has only the cloud sessions that Air opened on this
machine, it changes only while Air runs, its format is internal to Air without a contract, and its path is for macOS
only. ACP gives Megachat no list of the threads of Air: Air is the client, and the contract has no such request. `airc`
gives each cloud session of the login from the cloud. A later change can read the transcript of a cloud session from
the store of Air, as `agents_session_history` reads a local session.

### The watch

`CloudWatch` follows `SessionNotes`: `apply(on)`, `check()`, `turnEnded()` and `close()`, with the clock of the working
day. A check reads the list, plans the note and gives the plan to `MegachatState.cloudNote`, which commits the note and
the records in one change. The next check comes after 2 minutes (`CLOUD_CHECK_MS`). While the conversation sleeps, a
check runs no `airc` and only sets the next timer. A check whose note could not go out, because a turn ran, sets
`waiting`, and `turnEnded()` then checks at once.

Alternative: a read every minute, as the notes about the agent sessions do. A cloud session runs for minutes or hours,
and each read is a network request with the token of the user.

### The plan of a note

`planCloudNotes(watch, sessions, now)` looks at each listed session with the key `sha256(id)` (32 hexadecimal
characters):

- A session with a status of a note, a record with another status or no record, and `updatedAt` at or after
  `watch.since` is due. Its record changes only when the note goes out.
- Else a session with a new status gets the record `{ status, seenAt: now }` without a note.
- Else a record older than 1 day gets a new `seenAt`, so the record of a session that the list still has does not
  expire after 30 days and give a second note.

`since` makes the first read of a watch a base: a session that finished before the watch gives no note. A restart keeps
`since` and the records, so a session that finished while the daemon was down gets its note at the next read.

### The note

The note uses the entry kind `air.megachat.note` with the data `{ type: 'cloud', count }`, the provider `megachat` and
no usage, so each rule of the capability `session-notes` about the delivery, the replay, the keep-alive and the
summary also holds for a cloud note. `MegachatState.sessionNote` and `MegachatState.cloudNote` share one private helper
for the check of an idle conversation and for the write.

### The morning report

`collectReportData` gets `cloud`, a function that reads the list, only when `cloudState` is `on`. The part `cloud` has
`state` `on` with `finished` (`FINISHED` in the period), `failed` (`ERROR` or `ABORTED` in the period), `waiting`
(`USER_INPUT_REQUIRED`) and `running` (`LAUNCHING`, `STARTING_CONTAINER` or `RUNNING`), at most 30 sessions each, each with
the name, the status, the agent, the first repository, the results branch, the status comment and `updatedAt`. A failed
read gives `state` `unavailable`. One sentence of `event.morning.rules` tells the main agent to put the part into Done
and Open. The cloud sessions do not make a period active.

### State files

- `conversation.sqlite`: the new field `cloudSessions` of the Megachat document, `{ since, records }`. `since` is a time
  in milliseconds or `null`. Each record is `{ status, seenAt }`. A state of an earlier build has no field: the first
  start of a watch makes it. An earlier build keeps the field, because the state keeps each field that it does not
  know (see the capability `session-notes`, requirement "State with a note in v0.3.0").
- `settings.json`: the new key `cloud.sessions`. An earlier build keeps an unknown key (see the capability `settings`).

### Disconnect and restart

A read and a note need no ACP client: the daemon commits the note, and the next attach replays it. A restart keeps
`since` and the records, and the new daemon detects `airc` again before its first read. A read that a stop of the
daemon ends commits nothing.

### ACP

The change adds no ACP message and no `_meta` key. A cloud note reaches the client as each note does: an
`agent_message_chunk` with the message ID `megachat-entry-<entry>` and the phase `final_answer`.

## Risks / Trade-offs

- [The output of `airc` changes in a later release] → The read takes only the fields of the type of `airc` and
  refuses a list without a string `id`. A failed read gives a log line, an error of the tool and no note.
- [`central plugins` changes its line format] → The detection gives no `airc`, and `agents_settings` says why.
- [A cloud note after a long stop of the daemon names old changes] → The note gives at most 10 lines and the count of
  the others.
- [A user with `airc` turns the setting on and off often] → Each change of the tools costs one uncached request.

## Open Questions

None.

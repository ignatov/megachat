# Design

## Context

See proposal.md, "Why". Today the main agent sees this at the choice between `agents_spawn` and `agents_send`:

- The result of `agents_spawn` and of `agents_send` holds the run with its `childSessionId`. The context keeps it only
  until a summary.
- The report of a child result gives `runId`, `cwd`, `prompt`, `title`, `status` and `output`, and no
  `childSessionId`.
- `agents_list` gives `runs`: one row for each retained run, with `runId`, `childSessionId`, `agent`, `cwd`, `status`,
  `title` and the first 200 characters of the prompt. A row has no end time and no `closed`. The state keeps 48 to 64
  runs (see the capability `child-scheduling`), so the rows of one session are spread among the rows of other
  sessions.
- The summary of the context adds "Child tasks in the daemon state" only for the unfinished and the unreported runs.
- The rules say only "Use agents_send for a follow-up in the same child session." `tool.spawn` does not name
  `agents_send`. `tool.send` ends with a pointer to `agents_sessions` and `agents_resume` for a session that does not
  exist.

So a rule alone is not sufficient: the agent must also get a short view of its idle child sessions. The change adds
that view to `agents_list`, and it adds the rule and the tool descriptions. `agents_send` already does the work: it
keeps the agent of the session, it refuses a closed or a pruned session (`missing`) and a session that works
(`childBusy`), and its run continues the same provider session.

## Goals / Non-Goals

**Goals:**

- The agent sees its idle child sessions, one entry for each session, at the time of the choice.
- The rule is short and has few conditions. The code holds the conditions that do not need a judgment: the status,
  the age, `closed` and the listed directory.

**Non-Goals:**

- A judgment of the topic in the code. Only the model compares the request with the titles.
- A forced continuation. `agents_spawn` does not refuse a call.

## Decisions

### 1. The view is in the result of `agents_list`

The agent already calls `agents_list` to see the directories and the tasks. A field `idleSessions` there costs no new
tool. The rule asks for one call before `agents_spawn`, unless a call in this turn gave the list.

Alternatives:

- A section of the system prompt with the idle sessions. The list changes at the end of each child run. Each change
  of a section makes the next request read the conversation without the prompt cache (see the capability
  `keep-alive`). Rejected for the cost.
- A refusal of `agents_spawn` while an idle session exists in the directory, with a parameter `fresh` to override it.
  This is a gate: it changes the tool, and it costs a second call each time that the agent correctly starts a new
  session. The author said "это инструкция, тут просто". Rejected for now. It is the next step when the measure in
  task 4.2 shows that the rule is not sufficient.
- `childSessionId` in the report of a child result. The report is also the data of the event `children` that Air
  reads (`air.megachat.event`). Rejected to keep Air out of the change. `agents_list` gives the ID.

### 2. The code filters the bad targets

A session is in `idleSessions` only when all of these are true:

- Its last run, the run with the newest `createdAt`, has the status `completed`. A failed, cancelled or interrupted run
  has its own rules today: a cancelled task does not start again unless the user asks, and an interrupted run gets a
  question before replacement work. A session that works is not idle.
- The last run ended less than 24 hours ago (`finishedAt`). An older session holds an old picture of the code, and the
  user does not remember it as "the session of this task".
- No run of the session has `closed` (`agents_close`).
- Its directory is listed. `agents_send` refuses another directory.

The constant of 24 hours is in `src/PiMegachatService.mjs`, next to the tool. The clock is the clock of the service
(`workdayClock`), so a test can move it.

The agent can still send a follow-up to a session that is not in the list, with the `childSessionId` of `runs`. The
view is a recommendation, not a limit.

### 3. The entry

`childSessionId`, `agent` (a run without the field is `claude`), `cwd`, `title`, `lastTitle` and `endedAt`. `title`
is the title of the oldest retained run of the session: the topic of the session. Without a title, it is the first 80
characters of the prompt, as in the summary of the context. `lastTitle` is the title of the last run, only when it
differs, so the agent sees the last step. `endedAt` is an ISO 8601 time in UTC, so the agent can say "this morning".
The entry has no output: the titles are sufficient to compare a topic, and an output can be long. The list has at most
20 entries, the newest first, so the result stays short.

### 4. The rule

The text replaces the line "Use agents_send for a follow-up in the same child session." in
`resources/instructions.md`:

```
Continue a child session before you start a new one. Before agents_spawn in a directory, read idleSessions of agents_list for that directory, unless a call in this turn gave it.
When the request continues the topic of one of these sessions, such as a follow-up, a fix of its result or the next step of the same task, send it to that session with agents_send.
Start a new session with agents_spawn for an unrelated task, for a task that needs another agent than the session has, or when the user asks for a new session.
When you continue a session, tell the user its title in one short phrase. When the user objects, start a new session.
A child session that works now is not in idleSessions. Give it a message of the user only with agents_steer, as the rules below say.
Do not continue a session that is not in idleSessions with agents_resume unless the user asks.
```

"Another agent" covers a pi session for a task that changes files, and a request that names another agent. A task in
the directory of a session that works waits in the queue in all cases (see the capability `child-scheduling`), so the
rule has no case "work in parallel with a busy session" for one directory.

### 5. The tool descriptions

- `tool.spawn` gets, after its first sentence: "Before a new task, look at idleSessions of agents_list for the
  directory, and continue a session of the same topic with agents_send."
- `tool.send` starts: "Send a follow-up to an idle child session in the same project: a follow-up, a fix of its
  result or the next step of the same task. Use it before agents_spawn for the same topic." The rest stays. Its last
  sentence, about `agents_resume` for a session that does not exist, applies when the user names that session, as the
  rule of `agents_resume` says.
- `tool.list` gets: "idleSessions are the child sessions of Megachat that a follow-up can continue: the last run
  completed less than 24 hours ago, the session is not closed, and its directory is listed. Each has its title, the
  title of its last run and its end time, the newest first."
- `tool.resume` does not change.

### 6. ADDED, not MODIFIED

No requirement of `openspec/specs/` states when the agent uses `agents_spawn` or `agents_send`. "Continued sessions"
of `delegation` is about `agents_resume` and the sessions of the user, and it stays as it is. "Tool agents_steer" of
`steering` keeps "`agents_send` MUST stay a follow-up to an idle child session". So the requirements are new, in
`delegation`.

### 7. State, restart and ACP

The view reads the fields of `conversation.sqlite` that each run has today: `childSessionId`, `agent`, `cwd`,
`status`, `title`, `prompt`, `createdAt`, `finishedAt` and `closed`. The change adds no field. A run of an older state
directory without `finishedAt` counts as older than 24 hours, so it is not in the list. The view is a read of the
state, so a disconnect of the ACP client and a restart of the daemon change nothing: after a restart, an interrupted
run is not `completed`, and its continuation becomes the last run of its session. No ACP message and no `_meta` key
changes.

## Decisions for the author

Each decision has a recommended option, and the specs and the tasks use it.

1. **The age limit.** Recommended: 24 hours. Other options: 7 days, or no limit (only the prune of the runs).
2. **The status of the last run.** Recommended: only `completed`. Other option: also `failed`, so a fix of a failed
   run continues its session. The present rules for a cancelled or an interrupted task stay in both options.
3. **The place of the view.** Recommended: `idleSessions` in `agents_list` (decision 1). Other options: a section of
   the prompt, or the refusal of `agents_spawn`.
4. **A long session.** Recommended: no limit for the count of runs of a session. Claude Code and Codex compact their own
   context, and Megachat does not know its size. Other option: no entry for a session with 8 or more runs.

## Risks / Trade-offs

- [The agent puts an unrelated task into an old session.] → The rule names the cases of a new session, and the one
  short phrase lets the user object.
- [The agent does not call `agents_list` before `agents_spawn`.] → `tool.spawn` repeats the rule at the time of the
  call. The measure of task 4.2 shows the effect; the refusal of decision 1 is the next step.
- [One more tool call before a new task.] → The call reads the state only, and the rule skips it when a call in this
  turn gave the list.
- [A follow-up gets the context of a long session.] → Accepted (decision 4 for the author).

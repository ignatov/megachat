# Design

## Context

See proposal.md, "Why". Before this change, the main agent saw this at the choice between `agents_spawn`,
`agents_send` and `agents_steer`:

- The result of `agents_spawn` and of `agents_send` holds the run with its `childSessionId`. The context keeps it only
  until a summary.
- The report of a child result gives `runId`, `cwd`, `prompt`, `title`, `status` and `output`, and no
  `childSessionId`.
- `agents_list` gives `runs`: one row for each retained run, with `runId`, `childSessionId`, `agent`, `cwd`, `status`,
  `title` and the first 200 characters of the prompt. A row has no end time and no `closed`. The state keeps 48 to 64
  runs (see the capability `child-scheduling`), so the rows of one session are spread among the rows of other
  sessions.
- The summary of the context adds "Child tasks in the daemon state" only for the unfinished and the unreported runs.
- The rules said only "Use agents_send for a follow-up in the same child session." `agents_steer` was only for
  "information that the user adds to that task". So the next step of a task that works started a new session.
- `agents_send` keeps the agent of the session, it refuses a closed or a pruned session (`missing`) and a session that
  works (`childBusy`), and its run continues the same provider session. One provider session has at most one
  unfinished delegated task (see "Continued sessions" of the capability `delegation`).
- `agents_steer` with the mode `queue` gives a message to the unfinished run of a session: during the turn
  (`injected`), in the prompt of a task that waits in the queue (`queued`), or in a new turn of the same provider
  session when the turn ended first (`followUp`). The task keeps one result (see the capability `steering`).

The first version of this change (commit `bca6af7`) added `idleSessions` to `agents_list` and a rule to read it before
each `agents_spawn`. The author corrected it on 2026-11-19 (proposal.md, "Why"). This design replaces it.

## Goals / Non-Goals

**Goals:**

- The agent continues a hot session when it understands that the request continues the task of that session. The
  rule states this decision. It does not ask for a step before each `agents_spawn`.
- The agent has the child session ID of a task in its context, without a tool call, in the usual case: a request
  about a task that it started or that ended in this context.
- A hot session that works gets the next step in its queue, not a new session.
- The rule is short and has few conditions. The code holds the conditions that do not need a judgment: the age,
  `closed` and the listed directory.

**Non-Goals:**

- A judgment of the topic in the code. Only the model compares the request with the task of a session.
- A forced continuation. `agents_spawn` does not refuse a call.
- A queue of runs with a result of their own for one session (decision 3, option b).

## Decisions

### 1. The rule states the decision

The rule says: "When a request continues the task of a hot child session, ... continue that session." It has no
step "Before agents_spawn, read ...". The agent usually knows the task from its context: it started the task, or it
reported its result. A lookup before each new task costs a tool call each time that the agent correctly starts a new
session, and the author does not want this ritual. The rule names where the agent finds the ID (decision 4), and it
asks for `hotSessions` only when the context does not have the ID.

### 2. The definition of a hot session

A hot child session is a child session of Megachat that is not closed, whose directory is listed, and that:

- works now: its last run, the run with the newest `createdAt`, did not end (it waits in the queue or it runs), or
- is idle: its last run ended less than 24 hours ago (`finishedAt`), with each status.

The status of the last run does not count, because "hot" is about recency. A fix of a failed task continues the
session that knows the failure. The present rules for a cancelled and for an interrupted task stay: the agent does
not start a cancelled task again unless the user asks now, and it asks before replacement work for an interrupted run.
A continuation of such a session is a new request of the user, so these rules do not refuse it. The entry gives the
status, so the agent sees it. The age limit stays 24 hours: an older session holds an old picture of the code, and the
user does not remember it as "the session of this task". The limit is a decision of the author (see below).

A session in a directory that is not listed is not hot: `agents_send` and `agents_steer` refuse it (`workspace`). A
closed session is not hot: `agents_send` refuses it (`missing`).

The constant of 24 hours is in `src/PiMegachatService.mjs`, next to the tool. The clock is the clock of the service
(`workdayClock`), so a test can move it.

### 3. A session that works: `agents_steer` with the mode `queue`

Two mechanisms can put a request into the queue of a session that works:

- (a) The rule of `agents_steer` with the mode `queue` also carries a correction or the next step of the task. The
  tool does not change.
- (b) `agents_send` accepts a session that works, and its run starts after the current run ends, as a new run with a
  result of its own.

| | (a) `agents_steer`, mode `queue` | (b) `agents_send` to a session that works |
|---|---|---|
| The child | Gets the message during its turn (`injected`), in its prompt when the task waits (`queued`), or in a new turn of the same provider session (`followUp`). | Gets the request as a new prompt after the end of its turn. |
| The user | The same row in the Background Tasks tab. The reply names the session. | A second row of the same session, with its own title. |
| The result report | One report for the task: the report of the last run, with the output of the earlier run before its own output. The title is the title of the task. | A report of its own. |
| Stop | The Stop of the row stops the task and the step in it. | Each row has its Stop. A stop of the first run must decide about the second. |
| Limits | 16 messages a task, 64,000 characters a message. | 8 unfinished runs, 8 child runs a turn. |
| Daemon restart | The state records each message before the send. A continuation holds each message that the agent can lack. | The admitted run stays in the state, and it must wait for the continuation of the interrupted run. |
| The size | The rule, the descriptions and one error text. No change of the code of the tool. | A change of the admission (`childBusy`, `busy`), of the scheduler (an order of the runs of one session, also against a continuation of a steer, which starts at once), the provider session ID at the dispatch instead of at the admission, the target of a later steer, and the requirement "Continued sessions". |

The report of (a) is correct: it is one result of one task that got one more step, and the main agent knows that it
added the step. So this change uses (a). (b) is a later step, when the author wants a result of its own for each
step.

An agent without the steering extension gets the fallback also in the mode `queue`: a stop of the current step and a
continuation with the message (see the capability `steering`). Claude Code and Codex give the extension (see
`docs/manual-checks.md`), and a pi child has its own steering, so the fallback is rare.

### 4. Where the agent finds the child session ID

- The result of `agents_spawn` and of `agents_send`: the run with `childSessionId`. This does not change.
- The report of a child result: each result gets `childSessionId` (decision 5).
- `hotSessions` of `agents_list`: for a session that the context does not show, for example after a summary of the
  context or for a task of yesterday.

Alternatives:

- A section of the system prompt with the hot sessions. The list changes at the start and at the end of each child
  run. Each change of a section makes the next request read the conversation without the prompt cache (see the
  capability `keep-alive`). Rejected for the cost.
- A note with the hot sessions in each turn of the user. It keeps the prompt cache, because the note is at the end of
  the conversation. But the conversation keeps each note, so the cost grows with each turn, also for a turn without a
  task. Rejected for now.
- A hint with the hot sessions of the directory in the result of `agents_spawn`. The result comes after the
  admission, and a task in a free directory starts at once. So the hint comes too late to prevent the new session, and
  a cancel after it leaves a cancelled row in Air. Rejected.
- A refusal of `agents_spawn` while a hot session exists in the directory, with a parameter `fresh` to override it.
  This is a gate: it changes the tool, and it costs a second call each time that the agent correctly starts a new
  session. Rejected for now. It is the next step when the measure in task 7.2 shows that the rule is not sufficient.

### 5. The child session in the result report

Each result of the report gets `childSessionId`, the session of the run. The first version of this design kept the
report as it was, because it named the report "the data of the event `children` that Air reads". The code shows that
Air does not get it: `AcpBridge.conversation` sends no user message of an entry `air.megachat.event`, and no ACP
message of `docs/air-contract.md` holds the results. The entry also goes to the search index of the history, which
reads only `status`, `cwd`, `prompt`, `output` and `error`. So the field goes to the model only, and Air needs no
change. A report that the conversation holds from before the change has no field. The agent then reads `hotSessions`.

### 6. The entry

`childSessionId`, `agent` (a run without the field is `claude`), `cwd`, `title`, `lastTitle`, `state`, `status` and
`endedAt`. `title` is the title of the oldest retained run of the session: the topic of the session. Without a title,
it is the first 80 characters of the prompt, as in the summary of the context. `lastTitle` is the title of the last
run in the same form, only when it differs, so the agent sees the last step. `state` is `working` or `idle`, so the
agent selects the tool without a look at the status. `status` is the status of the last run. `endedAt` is an ISO 8601
time in UTC, only for an idle session, so the agent can say "this morning". The entry has no output: the titles are
sufficient to compare a topic, and an output can be long.

The list has at most 20 entries, so the result stays short. The sessions that work come first, the newest start
first, because a request about a task that works is the most probable. Then come the idle sessions, the newest end
first. At most 8 runs are unfinished (see the capability `child-scheduling`), so the sessions that work always fit.

### 7. The rule

The text replaces the six lines of the first version, from "Continue a child session before you start a new one.",
and the line "When the user adds information to a task that a child works on now, ..." in
`resources/instructions.md`:

```
A hot child session works now, or its last run ended less than 24 hours ago.
When a request continues the task of a hot child session, such as a follow-up, a fix of its result or the next step of the same task, continue that session. Do not start a new one.
The childSessionId of a session is in the result of agents_spawn and agents_send and in its child result. When your context does not have it, read hotSessions of agents_list.
Send the request to an idle session with agents_send. Give the request to a session that works now with agents_steer in the default mode: the child gets it during its work, and the task keeps one result.
Start a new session with agents_spawn for an unrelated task, for a task that needs another agent than the session has, or when the user asks for a new session.
When you continue a session, tell the user its title in one short phrase. When the user objects, start a new session.
Do not continue a session that is not in hotSessions with agents_resume unless the user asks.
Also give information that the user adds to a task that a child works on now to that child with agents_steer. Do not wait for the end of the task, and do not use agents_send for a child that works.
```

The line about the mode `interrupt` and the line about the outcome of `agents_steer` stay after it. "Another agent"
covers a pi session for a task that changes files, and a request that names another agent. A task in the directory of
a session that works waits in the queue in all cases (see the capability `child-scheduling`), so the rule has no case
"work in parallel with a busy session" for one directory.

The tool descriptions say the same:

- `tool.spawn` gets, after its first sentence: "For a request that continues the task of a hot child session, continue
  that session instead: agents_send when it is idle, agents_steer when it works now."
- `tool.send` starts: "Continue an idle child session in the same project: a follow-up, a fix of its result or the
  next step of the same task. Use it instead of agents_spawn for the same task." Its sentence about a task that
  runs becomes: "For a child session that works now, give the request to its task with agents_steer." The rest stays.
  Its last sentence, about `agents_resume` for a session that does not exist, applies when the user names that
  session, as the rule of `agents_resume` says.
- `tool.steer` says: "Use it when the user adds information, a correction or the next step of that task." The rest
  stays.
- `tool.list` gets: "hotSessions are the child sessions of Megachat that a request can continue: each works now, or
  its last run ended less than 24 hours ago, it is not closed, and its directory is listed. ..."
- `error.childBusy` says: "The child session still works on a task. To add information, a correction or the next step
  of that task, use agents_steer. For an unrelated task, start a new session with agents_spawn."
- `tool.resume` does not change.

### 8. ADDED in `delegation`, MODIFIED in `steering`

No requirement of `openspec/specs/` states when the agent uses `agents_spawn`, `agents_send` or `agents_steer`.
"Continued sessions" of `delegation` is about `agents_resume` and the sessions of the user, and it stays as it is. So
the requirements of the continuation are new, in `delegation`. "Tool agents_steer" of `steering` states the use of
the tool, and the use gets the correction and the next step of the task. So it is MODIFIED. It keeps "`agents_send`
MUST stay a follow-up to an idle child session".

### 9. State, restart and ACP

The view reads the fields of `conversation.sqlite` that each run has today: `childSessionId`, `agent`, `cwd`,
`status`, `title`, `prompt`, `createdAt`, `finishedAt` and `closed`. The report reads `childSessionId`. The change adds
no field. An ended run of an older state directory without `finishedAt` counts as older than 24 hours, so its session
is not in the list. The view is a read of the state, so a disconnect of the ACP client and a restart of the daemon
change nothing: after a restart, an interrupted run gets its continuation, and the continuation becomes the last run
of its session, so the session works. A message of `agents_steer` survives a restart as the capability `steering`
says. No ACP message and no `_meta` key changes.

## Decisions for the author

Each decision has a recommended option, and the specs and the tasks use it.

1. **The age limit of an idle hot session.** Recommended: 24 hours. Other options: 8 hours (one working day), or 7
   days.
2. **The status of the last run.** Recommended: each status. Other option: only `completed` and `failed`, so a
   cancelled or an interrupted session is not hot.
3. **A session that works.** Recommended: `agents_steer` with the mode `queue` (decision 3, option a). Other option:
   a queue of runs with a result of their own (option b), as a later change.
4. **The place of the view.** Recommended: the results of `agents_spawn` and `agents_send`, `childSessionId` in the
   report of a child result, and `hotSessions` of `agents_list` (decision 4). Other options: a note in each turn of
   the user, a section of the prompt, or the refusal of `agents_spawn`.
5. **A long session.** Recommended: no limit for the count of runs of a session. Claude Code and Codex compact their own
   context, and Megachat does not know its size. Other option: no entry for a session with 8 or more runs.

## Risks / Trade-offs

- [The agent puts an unrelated task into a hot session.] → The rule names the cases of a new session, and the one
  short phrase lets the user object.
- [The agent does not see that a request continues a hot session.] → The report of each result now names its session.
  The measure of task 7.2 shows the effect; the refusal of decision 4 is the next step.
- [A step in a task that works makes one long result.] → Accepted (decision 3). The task keeps 16 messages at most;
  after the limit, the agent waits for the result and uses `agents_send`.
- [An agent without the steering extension stops its current step for a message in the mode `queue`.] → Claude Code,
  Codex and pi give steering. The fallback continues in the same provider session.
- [A follow-up gets the context of a long session.] → Accepted (decision 5 for the author).

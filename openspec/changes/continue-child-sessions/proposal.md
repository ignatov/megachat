# Proposal

## Why

A colleague of the author wrote on 2026-11-18: "часто спаунит новые сессии вместо продолжения старых" (it often
spawns new sessions instead of a continuation of the old ones). Later on the same day: "он у меня чет много говна
спаунит ... там оч резко помойка из сессий получается" (it spawns a lot of junk, and the sessions very soon become a
mess). The author answered on 2026-11-18: "а, ну это инструкция, тут просто" (that is an instruction, it is easy), and
asked for this proposal on 2026-11-19.

The main agent has two tools for work in a project: `agents_spawn` starts a new child session, and `agents_send` gives
a follow-up to an idle child session. Its rules said only "Use agents_send for a follow-up in the same child session."
No rule told it to continue such a session. Also, the agent could not see its child sessions well at that time.
`agents_list` gives one row for each retained run. A row has no end time and no mark of a closed session, and a
session with three runs has three rows. The report of a child result has no child session ID. After a summary of the
context, the summary names only the unfinished and the unreported tasks. So the agent starts a new session for each
request. Since 0.12.0, each new Claude or Codex child session shows in the session list of its project in Air
(`children.showInProject`, default `true`), so the user sees each one of them.

The first version of this change (commit `bca6af7`) told the agent to read `idleSessions` of `agents_list` before each
`agents_spawn`, and to continue only an idle session whose last run completed. The author corrected it on 2026-11-19:
"ну не так должно быть, а он если понимает, что это продолжение уже существующей горячей сессии – продолжает ее или
ставит ей в очередь сообщение" (it must not work like that: when the agent understands that the request continues an
existing hot session, it continues that session, or it puts a message into the queue of that session). So:

- The trigger is the understanding of the agent, not a lookup before each `agents_spawn`.
- A hot session is also a session that works now. Its next step goes into its queue, not into a new session.
- "Hot" is about recency, not about the status of the last run.

## What Changes

Where it shows: the chat (the reply that names the continued session), the session list of the project in Air (fewer
new sessions), the Background Tasks tab of Air (the next step of a task that works stays in the row of that task), and
the log of the daemon (`started kind=send` instead of `started kind=spawn`). No ACP extension changes, so Air needs no
change.

- **Hot child sessions.** A hot child session is a child session of Megachat that is not closed, whose directory is
  listed, and that works now, or whose last run ended less than 24 hours ago, with each status. A session works now
  when its last run did not end: it waits in the queue or it runs.
- **Hot child sessions in `agents_list`.** The result gets `hotSessions` instead of `idleSessions`. The list has one
  entry for each hot session: first the sessions that work, then the idle sessions, the newest first, at most 20. An
  entry has `childSessionId`, `agent`, `cwd`, `title` (the title of the first retained run of the session),
  `lastTitle` (the title of its last run, when it differs), `state` (`working` or `idle`), `status` (the status of
  its last run) and, for an idle session, `endedAt`. The field `runs` does not change.
- **The child session in the result report.** Each result of the report of a child result gets `childSessionId`. So
  the agent has the session of each task that it started or that ended in its context, without a tool call.
- **The rule of the main agent.** When a request continues the task of a hot child session (a follow-up, a fix of its
  result, the next step of the same task), the agent continues that session. It uses `agents_send` for an idle
  session. It gives the request to a session that works with `agents_steer` in the default mode `queue`. The rule
  names where the agent finds the child session ID, and it reads `hotSessions` of `agents_list` only when its context
  does not have the ID. It starts a new session for an unrelated task, for a task that needs another agent than the
  session has, or when the user asks for a new session.
- **One short phrase.** When the agent continues a session, it tells the user the title of that session in one short
  phrase, so the user can object. After an objection, the agent starts a new session.
- **The rule of `agents_steer`.** The agent gives information, a correction or the next step of a task that works to
  its child with `agents_steer`. The task keeps one result. The mode `interrupt` stays only for a request of the user
  to stop or to redirect the current step.
- **The tool descriptions and the error.** `tool.spawn` points to the continuation of a hot session. `tool.send` is
  for an idle session. `tool.steer` names the next step of the task. `tool.list` describes `hotSessions`.
  `error.childBusy` names `agents_steer` for the next step of that task, and `agents_spawn` for an unrelated task.
  `tool.resume` does not change: it stays for a session that the user names.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `delegation`: "Hot child sessions in agents_list", "Entry of a hot child session", "Child session of a result",
  "Continuation of a hot session", "Name of the continued session" and "Tool descriptions of a continuation" are new.
  No present requirement states the choice between `agents_spawn`, `agents_send` and `agents_steer`, so no
  requirement of `delegation` is MODIFIED (see design.md, decision 8).
- `steering`: "Tool agents_steer" is MODIFIED. The tool also carries a correction and the next step of the task that
  works, and the task keeps one result.

## Out of scope

- No change of the work of `agents_send`, `agents_spawn`, `agents_steer` or `agents_resume`: no new parameter, no new
  refusal and no gate. `agents_spawn` still starts a new session when the agent calls it. `agents_send` still refuses
  a session that works (`childBusy`).
- No follow-up with its own result for a session that works. That needs a queue of runs for one session in the
  scheduler (design.md, decision 3, option b). It is a later step.
- No new setting. The limit of 24 hours and the limit of 20 entries are constants.
- No change of the summary of the context and no change of the data that Air gets. The report of a child result goes
  to the model only: Air does not get the user message of an event (see design.md, decision 5).
- No continuation of a session of the user from outside Megachat. `agents_resume` stays "only when the user asks".
- No change of the prune of the child runs (see the capability `child-scheduling`). A pruned session is not in the list.
- The change `session-triage` adds `similarTo`, a guess of duplicate sessions in `agents_triage`. It finds the
  duplicates after they exist, also outside Megachat. This change prevents new duplicates of the child sessions of
  Megachat. Neither change needs the other.
- The change `assignments-ledger` adds a store of the assignments with links to runs and sessions. A later step can
  use the session of an assignment as the target of a follow-up. This change does not need it.
- No non-goal of `openspec/config.yaml` changes. Two tasks in one checkout still run one after the other.

# Proposal

## Why

A colleague of the author wrote on 2026-11-18: "часто спаунит новые сессии вместо продолжения старых" (it often
spawns new sessions instead of a continuation of the old ones). Later on the same day: "он у меня чет много говна
спаунит ... там оч резко помойка из сессий получается" (it spawns a lot of junk, and the sessions very soon become a
mess). The author answered on 2026-11-18: "а, ну это инструкция, тут просто" (that is an instruction, it is easy), and
asked for this proposal on 2026-11-19.

The main agent has two tools for work in a project: `agents_spawn` starts a new child session, and `agents_send` gives
a follow-up to an idle child session. Its rules say only "Use agents_send for a follow-up in the same child session."
No rule tells it to look for such a session before a new task. Also, the agent cannot see its idle child sessions well
at that time. `agents_list` gives one row for each retained run. A row has no end time and no mark of a closed
session, and a session with three runs has three rows. The report of a child result has no child session ID. After a
summary of the context, the summary names only the unfinished and the unreported tasks. So the agent starts a new
session for each request. Since 0.12.0, each new Claude or Codex child session shows in the session list of its
project in Air (`children.showInProject`, default `true`), so the user sees each one of them.

## What Changes

Where it shows: the chat (the reply that names the continued session), the session list of the project in Air (fewer
new sessions), and the log of the daemon (`started kind=send` instead of `started kind=spawn`). No ACP extension
changes, so Air needs no change.

- **Idle child sessions in `agents_list`.** The result gets `idleSessions`: the child sessions of Megachat that a
  follow-up can continue. A session is in the list when its last run completed less than 24 hours ago, it is not
  closed, and its directory is listed. The list has one entry for each session, the newest first, at most 20. An entry
  has `childSessionId`, `agent`, `cwd`, `title` (the title of the first retained run of the session), `lastTitle` (the
  title of its last run, when it differs) and `endedAt`. The field `runs` does not change.
- **The rule of the main agent.** Before `agents_spawn` in a directory, the agent reads `idleSessions` for that
  directory. When the request continues the topic of one of these sessions (a follow-up, a fix of its result, the next
  step of the same task), it uses `agents_send` to that session. It starts a new session for an unrelated task, for a
  task that needs another agent than the session has, or when the user asks for a new session.
- **One short phrase.** When the agent continues a session, it tells the user the title of that session in one short
  phrase, so the user can object. After an objection, the agent starts a new session.
- **A session that works.** A child session that works now is not idle. The present rules of `agents_steer` stay: the
  agent gives it information of the user only when the user adds information to its task.
- **The tool descriptions.** `tool.spawn` tells the agent to look at `idleSessions` first. `tool.send` says that it is
  the tool for a follow-up, a fix of the result or the next step of the same task, before `agents_spawn`. `tool.list`
  describes `idleSessions`. `tool.resume` does not change: it stays for a session that the user names.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `delegation`: "Idle child sessions in agents_list", "Continuation before a new session" and "Tool descriptions of a
  continuation" are new. No present requirement states the choice between `agents_spawn` and `agents_send`, so no
  requirement is MODIFIED (see design.md, decision 6).

## Out of scope

- No change of `agents_send`, `agents_spawn`, `agents_steer` or `agents_resume` themselves: no new parameter, no new
  refusal and no gate. `agents_spawn` still starts a new session when the agent calls it.
- No new setting. The limit of 24 hours and the limit of 20 entries are constants.
- No change of the result report of a child, of the summary of the context or of the event `children` that Air reads.
- No continuation of a session of the user from outside Megachat. `agents_resume` stays "only when the user asks".
- No change of the prune of the child runs (see the capability `child-scheduling`). A pruned session is not in the list.
- The change `session-triage` adds `similarTo`, a guess of duplicate sessions in `agents_triage`. It finds the
  duplicates after they exist, also outside Megachat. This change prevents new duplicates of the child sessions of
  Megachat. Neither change needs the other.
- The change `assignments-ledger` adds a store of the assignments with links to runs and sessions. A later step can
  use the session of an assignment as the target of a follow-up. This change does not need it.
- No non-goal of `openspec/config.yaml` changes. Two tasks in one checkout still run one after the other.

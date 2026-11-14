# Brief: assignments, the open commitments of the user

Date: 2026-11-14. Author: principal PM review for Sergey Ignatov. Status: a proposal for a decision, not a spec.
Behavior changes follow `AGENTS.md`: the first step is the OpenSpec change `assignments-ledger`, which the author must
approve.

## Verdict

The author asks for one more store with all the assignments and tasks, so that he knows what goes on.

**A second store of everything: no. A small ledger of open commitments: yes.**

Reason: the data says that child runs are not the problem. The runs already have a store, a status and a transcript.
What gets lost is the commitments that no store holds: a decision that waits for the user, a "do it later", a wait for
a bot or a colleague. Today these live only in the chat and in the summary of the coordinator.

So Megachat needs **one place for the things that wait**, not a copy of the things that run.

## Real data (read-only, 2026-11-14)

Source: `conversation.sqlite` in the state directory, opened read-only. The kinds are my reading, one reviewer, so
treat them as a map and not as a count of record. Period: 2026-11-12 to 2026-11-14 (3 days).

| Measure | Value |
|---|---|
| Messages of the user | 148 |
| An ask: a new outcome is wanted | 64 |
| A follow-up, an approval or a steer of an earlier ask | 40 |
| A question that needs only an answer | 36 |
| Noise or a greeting | 8 |
| Asks with a clear final state (done, with a run, a commit, a ticket or an answer) | 55 of 64 (86%) |
| Asks that wait for a decision of the user | 5 messages, 4 items (`session-triage`, `session-archive` asked twice, `air-html-in-chat`, this brief) |
| Asks that wait for a date or for a bot ("later", "when it is ready") | 3: the release entry in `acp.json` for colleagues, PR #1634 of IJAI-6223, the `/patronus merge` of #1147 and #1132 |
| Asks with an unclear end | 1: the grey text of the suggestion (the answer said "write a message and see") |
| Child runs in the 3 days | 90: 82 completed, 6 resumed, 2 cancelled |
| Child runs of all time | 153: 134 completed, 9 interrupted, 3 cancelled, 7 resumed |
| Submissions that got no answer, all time | 6 (3 model errors, 3 aborted) |
| Commits that name a proposal in 3 days | 11 |
| OpenSpec changes open now | 13: 9 with no task done, 1 almost done, 3 finished and not archived |
| Open GitHub issues of Megachat | 20 |

Findings:

1. **The 9 open asks have one trait: each waits for a human or a bot, none waits for a child.** A run that ends is
   reported to the coordinator. A wait that nobody owns is not.
2. **A run that dies is found by the user, late.** The run of "implement #40" was cancelled on 11-13 at 11:13. The user
   asked "what's going on with the task 40?" at 13:41. That is 2.5 hours, and the user found it, not Megachat.
3. **The state of a proposal is not written anywhere.** The repository shows 9 changes with no task done. It cannot say
   which ones the author approved and which ones wait for him. Only the chat holds it, and the chat gets summarized.
4. **A dependency lives in the text of a run.** The run for ultimate #1739 ended with "a push is necessary after #1739
   is merged". That sentence is the only record of the wait.
5. **86% of asks close with no help.** A new store of every ask would copy what already works, and it would be wrong
   as soon as a run ends.

Not measured: how many of the 64 asks the user would call "open" himself. The author can mark them in a week
(metric 1).

## What an assignment is

Three words, three things. Do not mix them.

| Word | What it is | Where it lives today | Who changes it |
|---|---|---|---|
| **Assignment** (поручение) | An outcome that the user wants, which lasts longer than one turn. It has one owner of the next move. | Nowhere. The chat only. | The coordinator writes it; the user decides; evidence closes it |
| **Task** (run) | One child process: one prompt, one directory, one result. | `conversation.sqlite`, `agents_list` | The scheduler of children |
| **Session** | The log of one agent process, of a child or of a foreign CLI. | The logs of the CLIs, `sessions.sqlite` | The CLI that owns it |

One assignment has 0 to many runs. A run has one session. One request of the user can be: "research, then a proposal,
then implement, then push, then restart". That is one assignment with five runs, and the owner of the next move
changes between the steps (the child, then the user for the approval, then the coordinator).

A question that gets its answer in the same turn is **not** an assignment. 36 of 148 messages were such questions.
An ask that ends in the same turn (a restart, a push) needs no row either, if its run and its commit say the end.

### Lifecycle

```
          add                 the run ends / the user answers
 (none) ────────▶ open ─────────────────────────────────────────┐
                   │                                              ▼
                   ├─▶ running   (a run works on it)           done  ← needs evidence: a sha that is pushed,
                   ├─▶ waiting   (owner: user | external)              a run that completed, an issue that closed
                   ├─▶ later     (owner: nobody until a date)
                   └─▶ lost      (derived: its run was cancelled,   dropped ← needs a reason: the user said so
                                  interrupted or failed)
```

Who changes the state:

| Actor | May do | May not do |
|---|---|---|
| The coordinator (main agent) | add, set `waiting` or `later`, close as `done` with evidence | close with no evidence; drop on its own guess |
| The user | answer, approve, say "drop it" (the coordinator records it) | n/a. He never edits a file |
| A child | nothing. It has no tool for the ledger. Its result is read by the coordinator. | write the ledger |
| Megachat (derived) | flag `lost`, `result_ready`, `stale` from facts | close, drop or hide a row |

The ledger **never closes a row by itself.** A closed row is a claim, and a wrong claim ends the trust.

## Jobs to be done

1. "What is open, and who must move next?" in one answer, under 10 seconds.
2. "Did the thing that I asked for ever finish?" for an ask of three days ago.
3. "What waits for me?" (approvals, proposals, open questions), oldest first.
4. "What did I put off?" with the date.
5. After a restart or a summary: the coordinator still knows what is open, without reading the whole history.

## What not to build

- **No Jira inside Megachat.** No priorities, no labels, no estimates, no assignees, no sprints, no boards, no
  comments, no sub-tasks. The trackers (GitHub, YouTrack) hold the work. The ledger holds only the pointers and who
  moves next.
- **No copy of a run, a session, an issue or a PR.** A row holds a link (`runId`, `change`, `issue`, `pr`, `sha`,
  `sessionId`). The state of a linked run is read at each call.
- **No model call to find assignments.** The coordinator writes a row when it takes an ask. A model that scans the
  history would invent rows and miss rows. A rule in the instructions is the first step.
- **No automatic close, no automatic drop.** Stale rows are flagged and shown, never removed.
- **No GUI.** Chat and the morning report. A view in Air is a later IJAI ticket.
- **No new SQLite table.** One append-only file, like `session-archive.jsonl`. Pi Durable has no cross-process lock,
  so one extra writer in the same database is a risk.

## How it connects with triage and archive

`session-triage` answers "which sessions on this machine wait for me". `session-archive` closes the sessions that
are done. Both work on **sessions**. The ledger works on **commitments**. They meet at two points only:

1. A `needs_you` row of the triage can carry the id of the assignment that it serves, as the reason. This is a join at
   read time, and it is phase 2.
2. `agents_archive` warns when a session belongs to an open assignment ("this session is linked to a1: wait for the
   approval of the proposal"). A warning only. The user decides. This is phase 2.

The ledger does not scan the machine, and the triage does not keep a list of commitments. Neither can go stale for the
reason of the other.

## The minimum that changes his day

Step 1 (the change `assignments-ledger`): one tool `agents_assignments` for the main agent, with `add`, `update`,
`close`, `drop`, `list`. One file `assignments.jsonl`. One rule in `resources/instructions.md`. No other surface.

What the author sees: he writes "what is open?" and gets one answer:

1. The count line: 4 wait for you, 2 are later, 1 is lost, 1 is stale.
2. The rows that wait for him, oldest first, each with its age and the one thing that he must say.
3. The lost rows, each with the reason (its run was cancelled).
4. The later rows with their date, and the stale rows with their age.

Step 2 (after the numbers of step 1): a block "Открыто" of the morning report from the ledger, then the links to the
triage and the archive, then derived rows from git (a commit that is not pushed) and from the trackers.

Gate to step 2: for a week, the author marks the rows. Coverage is 90% or more, and no stale row looked live.

## Surfaces

| Surface | Step | Why |
|---|---|---|
| Chat answer to "what is open" | 1 | One place, the author already asks there |
| Morning report, block "Открыто" | 2 | The report already has "Открыто" built from the history. The ledger makes it exact. |
| Air list | later | An Air change and an IJAI ticket |
| A note when a row turns `lost` | later | Needs the dedup rules of `session-notes` |

## Metrics

| Metric | Target | How to read it |
|---|---|---|
| Coverage: asks that outlast a turn and have a row | 90% or more | The author marks 20 asks of a week against the rows |
| Time to answer "what is open" | under 10 s, one message | The author times it, 5 days |
| Stale row shown as live | 0 | Counter-metric. The author tells. |
| Rows closed with evidence and later found wrong | 0 | Counter-metric. The author tells. |
| Time between a run that dies and the notice to the user | under 15 min, now 150 min in the one case | `lost` rows and the time of the next turn |
| Open rows at any time | 15 or fewer | `list` count. More means that the ledger is a dump. |

## Risks

| Risk | Answer |
|---|---|
| **A stale list is worse than none.** A row that says "open" for a thing that was done teaches the user to ignore the list. | A row closes only with evidence. A linked run is read at each call. A row that nobody touched for 7 days is flagged `stale` and shown first. At 30 days the report asks to drop it. Nothing disappears silently. |
| The coordinator forgets to write a row | The rule is in the instructions, and coverage is a metric. If coverage is below 90%, step 2 adds derived rows (open changes, unpushed commits) so the ledger does not rest on discipline alone. |
| Two rows for one ask | The tool refuses an `add` whose text is the same as an open row, and it shows that row. |
| The ledger grows into a task tracker | The list of "what not to build". The limit is 200 open rows, and the target is 15. |
| A summary of the conversation drops a row | The ledger is not in the context. The coordinator reads it with `list`, so a summary cannot lose it. |
| Private text of a quote | The text of a row passes the secret filter of `session-index`, has 300 characters at most, and the file has mode 0600. It stays on the machine. |
| An older state directory | There is no file, so there are no rows. The tool works at once. |

## Open decisions for the author

1. Name: "assignments" (поручения), as in this brief, or "open loops". The brief uses "assignment".
2. Step 1 has no block in the morning report. Do you want the block in step 1 already? It costs a MODIFIED delta of
   `morning-report` and one more test.
3. A proposal of Megachat is itself an assignment. Should the coordinator record "waiting for your approval" the moment
   it commits a proposal? The brief says yes, because this is the biggest gap of the data.

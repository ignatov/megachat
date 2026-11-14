# Brief: Megachat as the orchestrator of agent sessions

Date: 2026-11-14. Author: principal PM review for Sergey Ignatov. Status: a proposal for a decision, not a spec.
Behavior changes follow `AGENTS.md`: the first one is the OpenSpec change `session-triage`, which the author must approve.

## Verdict

Yes, but not as a "super agent" that owns all sessions. Megachat can be the **desk**: one place that tells the user
which sessions wait for them, which are stuck, which are quiet for days, and which look like duplicates. The user then
acts in the terminal that owns the session. Megachat acts alone only for its own children.

Reason: a live session of another CLI belongs to that CLI. Megachat can read it, and it cannot write into it. So
"orchestrator" means "see, sort, tell, and hand over". It does not mean "drive".

## Problem and who has it

Who: one person who runs 10 to 30 coding-agent sessions at the same time, across terminals, a multiplexer, IDEs and
Megachat. Colleagues with the same habit are the next group (data of one person: a map of hypotheses, not statistics).

Pain: the user does not know, without opening each tab, (a) which session waits for an answer, (b) which one is
done, (c) which one is stuck, (d) which one can close, (e) which two sessions do the same work.

## Jobs to be done

1. "What waits for me right now?" (answer in under 10 seconds, without a tab walk).
2. "What can I close?" (a list with the reason and the age, not a command to close).
3. "What did session X do, and where did I stop?" (read without a resume).
4. "Continue that old work" (resume as a child, once the old process is closed).
5. "Do not start the same work twice" (a hint before or after the start).

## What "session hell" is (measurable)

Measured on this machine on 2026-11-14 (read-only: `ps`, `lsof` for the cwd, and `~/.claude/sessions/<pid>.json`):

| Measure | Value |
|---|---|
| Live agent sessions in terminals | 20 (18 Claude Code, 2 Codex) |
| By project directory | json-profiler 8, air-audit 5, ultimate 4, gitbob 1, src 1, megachat 1 |
| Claude sessions with no activity for more than 24 hours | 16 of 18 |
| Claude sessions with no activity for more than 7 days | 4 of 18 (oldest 232 hours) |
| Claude sessions with the process status `idle` and an age of more than 3 days | 9 of 18 |
| Sessions in a state `shell` (a command runs) | 2 |
| Codex sessions with a status | 0 of 2 (no process file; the log gives the status) |
| Terminal tabs with a shell login (`login`, `-zsh`) | about 32 shells for 20 agents |
| Sessions of the last 30 days on disk | 623 Claude, 71 Codex, in 337 project directories |
| Share of live sessions in the last 30 days | about 3% |

Findings:

- The "stuck" session in gitbob is **not stuck**. Its process file says `idle`, with no activity for 232 hours (9.7
  days). It is the oldest session on the machine. The pain is "abandoned and invisible", not "hung". The present
  status `stuck` (an open step with no write for 10 minutes) does not describe it. A new class is needed.
- Most of the problem is quiet sessions, not broken ones: 16 of 18 are silent for a day or more.
- Duplicates by topic cross the project directories (json-profiler and ultimate), so a match by directory is useless.
  A match by title is needed. Not measured: how many real duplicates exist (the titles need the `sessions.index` consent).
- Not measured: how many of the idle sessions hold an unanswered question (needs the log, and a reading of the last
  message). This decides whether phase 3 is worth it.

## Goals

1. One answer to "what waits for me", with the sessions sorted by who must act next.
2. A list of sessions that are abandoned, with the age, so the user closes them by choice.
3. A hint of duplicate topics.
4. The number of live sessions goes down and stays down, with no lost work.

## Non-goals (what NOT to build)

- **No writes into a foreign live session.** No keystroke injection into a terminal, no `tmux send-keys`, no
  Accessibility tricks. It breaks on each terminal and it risks the user's work. (`steering` works for children only.)
- **No automatic stop, close or archive of a session.** Stop stays an explicit confirmation of the user, for an
  orphan only (capability `stop-sessions`). A heuristic that guesses "done" will kill live work once, and one such
  case ends the trust.
- **No second store of session state.** The logs of the CLIs are the truth. The triage is a view that Megachat
  computes at each call. No new SQLite table, no sync, no cache that can go stale. (Also: Pi Durable has no
  cross-process lock, so a second writer is a risk.)
- **No model call for the triage in phase 1.** Rules on the status, the age and the title. No cost per call, no
  private text that leaves the machine, and a result that a test can check.
- **No dashboard or board UI.** The chat is the surface. Air shows tasks of children only; a board needs an Air
  change and an IJAI ticket. Prove the answer in chat first.
- **No merge of sessions, no "auto-resume of all".** Two writers on one log is the known hazard.
- **No new default.** Notes, index and every new reading stay behind the present consent. Nothing starts to run on its own.

## Success metrics

| Metric | Today | Target | How to read it |
|---|---|---|---|
| Time to answer "what waits for me" | a tab walk, minutes (not measured) | under 10 s, one chat message | the author times it, 5 days |
| Live agent sessions on the machine | 20 | 12 or fewer after 4 weeks | a weekly `ps` count, `agents_running` |
| Sessions silent for more than 7 days | 4 of 18 | 0 at the end of a week | `agents_triage` count |
| Precision of `abandoned` (the user agrees it can close) | none | 90% or more | the author marks 20 rows |
| Precision of a duplicate hint | none | 50% or more | the author marks the hints of one week |
| Work lost by a closed session | none | 0 reports | the author tells, a counter-metric |

The ratio matters less than the counter-metric: one lost session beats all gains.

## Risks

| Risk | Answer |
|---|---|
| `abandoned` marks a session that the user wants (a long wait for a result) | Show the age and the last status, never an action. Threshold of 72 hours is a first guess; the author tunes it after the first week. |
| Codex has no permission record, so `waiting_for_user` is blind | Say it in the answer: a Codex row gets a "status from log only" mark. Do not hide it. |
| Titles can be empty or private; duplicate hints are noisy | Hints only, with a low claim. Measure first. Cut the hint if precision is below 30%. |
| Consent: the triage needs `sessions.index` | Without the consent, the tool says so and gives process facts only. It never turns the consent on. |
| Resume makes two writers | Phase 3 only, and only after the old process is gone (see `delegation`). |
| Scope creep to "agent OS" | Each phase has a gate on a metric. No phase starts without the numbers of the one before. |

## Phased plan

Gate rule: a phase starts when the author approves its OpenSpec proposal and the metrics of the earlier phase say it
helps.

0. **Measure** (done in part, section above). Add the two missing numbers: unanswered questions and real duplicates.
1. **Observe and triage** (change `session-triage`, in this commit). One read-only tool `agents_triage` and one rule
   in the instructions: the buckets `needs_you`, `stuck`, `working`, `abandoned`, `quiet`, and the duplicate hints.
   Gate to phase 2: precision of `abandoned` is 90% or more for a week.
2. **Notify** (modifies `session-notes` and `morning-report`). The morning report gets a "waits for you" and an
   "abandoned" line. A note for `needs_you` is opt-in under the present `sessions.notes`. No new default.
3. **Adopt** (modifies `delegation`). "Continue this old work" in one step: Megachat reads the old session, asks the
   user to close the old process, then resumes it as a child. Gate: the order of the steps proves no two writers.
4. **Policies** (new capability). Rules of the user, for example "ask me about a session silent for 5 days". A
   rule only asks. It never stops.
5. **Archive** (new capability, small). A closed or ended session leaves a one-paragraph card in the learned memory
   ("what was done, where it stopped"), so a closed tab loses no context. Only with a request of the user.

Not planned: any step that writes into a foreign terminal.

## Open questions for the author

1. Is 72 hours the right line for `abandoned`? (Data: 9 of 18 are past it today.)
2. Is a duplicate hint worth a place in phase 1, or does it wait for the measurement of real duplicates?
3. Phase 2: the morning report line only, or also a note for `needs_you`?

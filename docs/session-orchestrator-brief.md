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
- **No automatic stop, close or archive of a session.** Each stop and each archive needs an explicit confirmation
  of the user (capability `stop-sessions`, change `session-archive`). A heuristic that guesses "done" will kill live
  work once, and one such case ends the trust.
- **No second store of session state.** The logs of the CLIs are the truth. The archive cards are a record of the
  user's decision, not a copy of the state. The triage is a view that Megachat
  computes at each call. No new SQLite table, no sync, no cache that can go stale. (Also: Pi Durable has no
  cross-process lock, so a second writer is a risk.)
- **No model call for the triage in phase 1.** Rules on the status, the age and the title. No cost per call, no
  private text that leaves the machine, and a result that a test can check.
- **No GUI of Megachat's own.** No menu bar app, no web dashboard, no Kanban board, no mobile app. The section
  "Interface" gives the reasons. A view in Air is an Air change and an IJAI ticket, not Megachat code.
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
| Sessions archived with a card | 0 | 15 or more in the first week | `session-archive.jsonl` |
| Time to archive the close list | a tab walk for each session | one dialog, under 1 minute | the author times it |
| Restores within 7 days of an archive | none | under 10% | `restoredAt` in the cards |
| Work lost by a closed session | none | 0 reports | the author tells, a counter-metric |

The ratio matters less than the counter-metric: one lost session beats all gains.

## Risks

| Risk | Answer |
|---|---|
| `abandoned` marks a session that the user wants (a long wait for a result) | Show the age and the last status, never an action. Threshold of 72 hours is a first guess; the author tunes it after the first week. |
| Codex has no permission record, so `waiting_for_user` is blind | Say it in the answer: a Codex row gets a "status from log only" mark. Do not hide it. |
| Titles can be empty or private; duplicate hints are noisy | Hints only, with a low claim. Measure first. Cut the hint if precision is below 30%. |
| Consent: the triage needs `sessions.index` | Without the consent, the tool says so and gives process facts only. It never turns the consent on. |
| An archive closes a session with work in it | Refuse a working or waiting session; warn on uncommitted files, unpushed commits and a shared directory; card first. |
| The title mark couples Megachat to an Air format | IJAI ticket makes it a contract; a fixture test in Megachat. |
| Resume makes two writers | Phase 3 only, and only after the old process is gone (see `delegation`). |
| Scope creep to "agent OS" | Each phase has a gate on a metric. No phase starts without the numbers of the one before. |

## Interface

Question of the author (2026-11-14): is the chat the right surface for many sessions, or is another surface better?
Earlier the author said "foreign sessions only in the chat, no new UI". This section treats that as open.

Method: a web search on 2026-11-14. Most sources are product docs, vendor blogs and forum threads, not studies. The
direct fetch of `code.claude.com` and `github.com` failed from this machine, so the quotes of these two come from
search excerpts. Nothing here is tested hands-on, except `herdr --help` on this machine.

### What other products do

Agent tools:

| Product | Pattern | What users praise or report | Source |
|---|---|---|---|
| Claude Code agent view (`claude agents`) | One list of background sessions with states `working`, `blocked`, `done`, `failed`, `stopped`; peek, attach, reply | One screen for "what needs input". Interactive sessions in other terminals do not show until the user backgrounds them. | [docs](https://code.claude.com/docs/en/agent-view), [HN](https://news.ycombinator.com/item?id=49158580) |
| Claude Code notifications | OS notification from a `Notification` hook | With 5 sessions, identical "Claude Code needs your attention" alerts do not say which session. Fix: put the project name in the text. | [issue #36885](https://github.com/anthropics/claude-code/issues/36885), [guide](https://contextbolt.com/blog/claude-code-notifications/) |
| Claude Code Notifier, Context Board | Menu bar app; a "Needs you" widget over Claude Code and Codex | Third-party tools fill the gap "which one needs me". | [notifier](https://claudecodenotifier.com/), [roundup](https://tacticremote.com/blog/2026-02-28-managing-multiple-claude-code-sessions/) |
| Claude Remote Control, Dispatch | Phone as a remote screen; the permission prompt shows on all devices | Mobile approval of a prompt. Only for sessions that the user starts with Remote Control. | [guide](https://radar.firstaimovers.com/claude-code-remote-control-dispatch-multi-device-guide-2026) |
| Codex app | Threads by project; a Triage section with an inbox of runs, filter "unread" | The review queue is the center. Several sources say the human review is the bottleneck. | [guide](https://codex.danielvaughan.com/2026/04/08/codex-desktop-automations/), [review](https://www.verdent.ai/guides/codex-app-first-impressions-2026) |
| Cursor Agents Window | Sidebar of agents grouped by repository; pin | Forum: no global list of active chats, repo groups bury live work, no multi-select for batch actions, about 25% of cloud agents missing from the sidebar. | [no recent list](https://forum.cursor.com/t/agents-window-sidebar-unusable-for-multi-repo-orchestration-no-recent-list-no-multi-chat-view-repo-groups-bury-active-work/166317), [no batch](https://forum.cursor.com/t/please-add-multi-select-in-the-agents-window-for-batch-actions/167355), [missing](https://forum.cursor.com/t/cloud-agents-do-not-show-in-agents-recent-agents-sidebar/158067) |
| GitHub Copilot agents panel | An overlay on each page; a task list with live status; the result is a draft PR | Start and track without leaving the current page. | [GitHub blog](https://github.blog/news-insights/product-news/agents-panel-launch-copilot-coding-agent-tasks-anywhere-on-github/) |
| Devin | One Slack thread for each session, with a status chip `working`, `blocked`, `done`; sessions sleep, not end; `devin_session_gather` waits for many | A chat for one session, not one chat for all sessions. | [Slack](https://docs.devin.ai/integrations/slack), [MCP](https://docs.devin.ai/work-with-devin/devin-mcp) |
| Warp | Agent management panel, a mailbox of notifications (All, Unread, Errors), toasts, a badge on the tab | The panel does not show Claude Code or Codex; for them, only notifications and the tab badge. | [docs](https://docs.warp.dev/guides/agent-workflows/how-to-run-multiple-ai-coding-agents/) |
| herdr (on this machine) | Multiplexer sidebar with `working`, `blocked`, `done`, `idle`; "done" stays flagged until the user looks | State from hooks or from the screen text; only for panes inside herdr. | [Better Stack](https://betterstack.com/community/guides/ai/herdr-ai-agent/), [Jacar](https://jacar.es/en/herdr-terminal-agent-multiplexer/) |
| Conductor, Sculptor, Nimbalyst (was Crystal), Vibe Kanban | A desktop app: one workspace (worktree) per agent; a list or a Kanban board | They manage only the agents that they start. Vibe Kanban is shutting down; reviews name "review debt" and worktree cleanup. | [Conductor](https://tgmarinhopro.com/en/blog/conductor-mac-parallel-agents-experience-en), [Sculptor](https://imbue.com/product/sculptor), [Vibe Kanban](https://vibecoding.app/blog/vibe-kanban-review), [HN](https://news.ycombinator.com/item?id=44533004) |
| JetBrains Air | Tasks of agents in one desktop app; switch, review and approve | Also only the tasks that Air or its ACP agents run. | [docs](https://air.dev/docs), [blog](https://blog.jetbrains.com/air/2026/03/air-launches-as-public-preview-a-new-wave-of-dev-tooling-built-on-26-years-of-experience/) |

Analogies outside agents:

| Product | Pattern | Lesson | Source |
|---|---|---|---|
| Superhuman | Split inbox; Remind Me (hide until a time); "get me to zero" archives all mail older than a week in one step | A bulk action on "old" is the praised feature. | [Product Hunt](https://www.producthunt.com/products/superhuman/reviews), [review](https://www.breakthetwitch.com/superhuman/) |
| HEY | Screener; Reply Later and Set Aside piles | Users say the piles "just move the problem" and become a second inbox. | [Masalar](https://mariusmasalar.me/hey-is-not-for-me), [TheKeesh](https://thekeesh.com/2021/01/review-of-hey-com-email/) |
| Linear Triage | A shared inbox; four keys: accept, decline, duplicate, snooze | A fixed, small set of verbs, and "duplicate" is one of them. | [docs](https://linear.app/docs/triage) |
| PagerDuty | Deduplication and grouping of alerts into one incident | Fewer, grouped interrupts. The ops guide ranks deduplication first. | [docs](https://support.pagerduty.com/main/docs/alert-grouping), [guide](https://www.pagerduty.com/ops-guides/ops-practices/reduce-noise/) |
| Browser tabs (CMU, CHI 2021) | Study of tab overload | People keep tabs open as reminders and from fear that they cannot find the work again. | [CMU](https://www.cmu.edu/news/stories/archives/2021/may/overcoming-tab-overload.html) |
| Parallel agents, practitioners | HN threads | For real work, many people say 2 to 3 parallel sessions is the limit; the cost is the reload of context. | [HN 1](https://news.ycombinator.com/item?id=45110075), [HN 2](https://news.ycombinator.com/item?id=47573483) |

### Five findings

1. **The pattern is a list with states and one "needs you" signal, not a chat.** Claude agent view, Codex Triage,
   Warp, herdr and the Copilot panel all show rows with a state and a badge for "blocked". Devin uses chat, but one
   thread for each session. No product found uses one chat as the overview of many sessions.
2. **Each product sees only its own sessions.** Claude agent view does not list interactive terminal sessions. Warp
   does not list Claude Code or Codex. Conductor, Air and Vibe Kanban list only what they start. A view across
   owners (terminal, herdr, IDE, Megachat) is the one narrow thing that Megachat has and the others do not. This is
   the difference to defend. It is not an empty market: herdr and Context Board cover parts.
3. **An interrupt without identity is noise.** The most reported gap is "which session needs me". Each fix adds the
   project and the title to the signal. PagerDuty adds deduplication and grouping.
4. **Bulk "old" actions are praised; "later" piles are not.** Superhuman's "get me to zero" is praised, and Cursor
   users ask for multi-select. HEY's piles turned into a second inbox. So a bucket `abandoned` is only useful with a
   one-step exit, and a "keep for later" bucket is a trap.
5. **People keep things open from fear of loss.** The CMU tab study gives the reason for 16 silent sessions better
   than any status: a tab is a reminder. For a session, the log stays on disk, and `agents_resume` can continue it.
   Saying so at the moment of the close list is cheaper than any UI.

### Chat compared with other surfaces

| Job | Chat (Megachat) | List or board (Air, agent view) | Notification or badge | Terminal sidebar (herdr) |
|---|---|---|---|---|
| Overview of 20 sessions | Weak: a long table goes stale at once, and the user must ask | Strong: always there, sorted | Weak | Strong, but only for herdr panes |
| "What needs me" | Good on request | Good | Strong: it comes to the user | Good inside herdr |
| Attention and interrupts | Weak: a chat note is an interrupt in the wrong place | Medium: a badge | Strong, with identity | Medium |
| Bulk actions (close 9 old ones) | Strong: "these 9, the reason, the age; say yes" | Strong with multi-select; Air has none for foreign sessions | None | Weak |
| Drill into one session | Strong for "what did it do" (read without resume) | Medium | None | Strong for "go to it" |
| Duplicates, "where did I stop" | Strong: it needs words, not pixels | Weak | None | None |
| Mobile | Medium: Air has no mobile client | None today | Claude Remote Control covers Claude only | None |

Read: the chat is strong where the job needs language (why, what it did, which ones, a decision on a batch). It is
weak where the job needs presence (an overview that is always there, an interrupt that comes to the user). The
author is right that the chat is not enough. The chat is still the right place for triage and decisions.

### Recommendation: which surface owns which job

| Job | Owner | Why |
|---|---|---|
| Triage on request, "what did X do", duplicates, the close list, resume | **Chat of Megachat** | Needs language and a decision. Megachat already has the data. |
| Overview that is always there, a count of `needs_you` | **Air** (IJAI ticket, not Megachat code) | The author works in Air. Air has a task list for children of Megachat. A read-only section "Other sessions" and a badge reuse that place. |
| The interrupt "session X waits for you" | **The note of `session-notes`, with project, title and tty** (phase 2) | One signal, deduplicated by the present rule "one note for each state". No new channel. |
| Go to the session | **The owner** (Terminal, Rex, herdr, IDE) | Megachat gives the tty and the owner name. It does not focus a window. herdr already has a sidebar for its panes. |
| Mobile | **Not built** | Claude Remote Control covers Claude sessions. One user on one Mac does not need more. |

The minimum that changes the day of the author (phase 1, no new surface):

1. One question "what waits for me / what can I close" gives one chat answer: a short count line, the `needs_you`
   rows first, then the close list of `abandoned` rows with the age, the project and the tty.
2. The close list says that closing a tab loses nothing: the log stays, and `agents_resume` continues it later.
3. The user closes the tabs, and the tty helps to find each one.

What not to build:

- **No GUI of Megachat's own** (menu bar app, web dashboard, Kanban). Every product of this kind sees only its own
  sessions, and Vibe Kanban shows that a board is costly to keep alive. Megachat's edge is the data across owners,
  not pixels. If a GUI is needed, it goes to Air.
- **No "later" bucket and no snooze.** HEY shows the pile becomes a second inbox.
- **No focus of a foreign window or pane** from Megachat. It is an Accessibility or AppleScript path for each
  terminal, and it is close to "write into a foreign session".
- **No push for each state change.** Only `needs_you`, once, with identity.

### Open question for the author

Air side: a read-only section "Other sessions" in the task list with a `needs_you` badge. This needs an ACP extension
(a list of foreign rows), a change of `docs/air-contract.md`, and an IJAI ticket. Phase 2 measures first whether the
chat answer is used each day; if it is, the Air ticket goes next.

## Archive

Decision of the author (2026-11-14): "we must be able to archive any session, else we do not clear this mess". So the
archive moves from phase 5 to phase 1, next to the triage, and it covers each session on the machine. The OpenSpec
change is `session-archive`.

### What "archive a session" means

Three steps, in this order, and each one is separate:

1. **Card.** Megachat writes what the session did and how to continue it. This is the step that removes the fear of
   loss. It works for each owner.
2. **Close.** The process of the session ends. Megachat does it only where it is safe and the user confirms.
3. **Hide.** The session leaves the lists of the products (Codex, Air), in their own format. `restore` brings it
   back.

### What the products have (checked on 2026-11-14, read-only)

| Product | Own archive state | Can a third party set it | Evidence |
|---|---|---|---|
| Codex (CLI, app, IDE) | `threads.archived` and `archived_at` in `~/.codex/state_5.sqlite`; `~/.codex/archived_sessions` (126 files; 126 rows with `archived = 1`, 705 with 0) | Yes, officially: `codex archive <id>`, `codex unarchive <id>` (codex-cli 0.167.0), app-server `thread/archive` | local files, `codex --help` |
| Claude Code CLI | None for an interactive session. `claude --resume` lists each session file. `claude rm <id>` removes a background session from agent view and keeps the conversation | No official way. Air uses a title record `[archived] <title>` (`custom-title` and `agent-name`, plus `custom-title.json`), as `/rename` writes it. 16 of 768 Claude Code logs of 60 days have it | Air source at `e9de692b3d125`: `AgentThreadArchiveTitles.kt`, `ClaudeStoreThreadBackend.kt` |
| Claude desktop app | Not installed on this machine | Not checked | `~/Library/Application Support` has no `Claude` |
| Air | Reads the states above for its list. Before the mark of a Claude Code session, Air stops its workers, also a `claude` in a terminal after a wait | An ACP agent can write the same marks; Air has no ACP request for an archive | `ClaudeSessionSource.archiveSession`, `ClaudeSessionWorkerStopper.kt` |
| pi | Air appends a `session_info` record with the prefix | Yes, the same format | `PiSessionSource.kt` |
| herdr | Panes, no archive. `herdr pane close`, `herdr agent focus`, `herdr agent list` | Close only | `herdr --help`; the server was not on the default socket, so no live check |
| Megachat children | Delegated Claude Code and Codex sessions are hidden in Air already (`_session/service/record`). Pi Durable cannot archive a pi child (`docs/roadmap.md`, item 9) | Card only for a pi child | `docs/air-contract.md` |

### What Megachat can do for each owner

| Owner | Card | Close of the process | Hide |
|---|---|---|---|
| Terminal (Terminal, Rex, iTerm) | yes | yes, SIGTERM then SIGKILL, after the dialog; the tab stays with its shell | Codex: `codex archive`; Claude Code: title record |
| herdr, tmux | yes | yes, the same; the pane stays | the same |
| IntelliJ IDEA, Air | yes | no: archive it in Air, which stops and marks it | only after the process is gone |
| Megachat run | yes | no: cancel the task first | after the run; pi child: card only |
| `claude daemon` background job | yes | no: the answer gives `claude stop <id>` | after the process is gone |
| Past session, no process | yes | nothing to close | yes |

Why Megachat does not stop an IDE session: the IDE owns the process and its ACP adapter, and Air already has a stop
and an archive of its own. Two stoppers of one process is a race.

### The card

One JSON line of `session-archive.jsonl` in the state directory: the title, the project, the dates, the first and the
last prompt, the last answer, the commits and the tickets that the log names, the changed files, the warnings, the
hide state, and the command to continue (`agents_resume`, or `claude --resume <id>` and `codex resume <id>`).
`agents_archive(action="search")` finds a card by a ticket, a file or a word.

No model makes the card. It costs nothing, no text leaves the machine, and a test can check it. The last answer of a
session is often its summary. If the author finds the cards too thin after a week, phase 2 adds a model summary on
request for one card. Its cost is not measured; measure it before the proposal.

The commits come from the `git commit` output in the log, not from `git log`, because one directory had 8 live
sessions on 2026-11-14.

### Bulk and undo

- The close list of `agents_triage` gives the batch: up to 50 rows, one dialog, the options `archive` and `keep`.
- The dialog has one line for each row: agent, project, age, owner, what happens (close and hide, card only), the
  warnings.
- `restore` reverses the hide and keeps the card. It starts no process. The result gives the command to continue.
- The close of a process cannot be undone, but no work goes with it: the log stays, and `agents_resume` continues it.

### Safety: never lose work

Refuse the row (no dialog line):

- the status `working`, `stuck` or `waiting_for_permission`;
- a tool runs: the process file of Claude Code says `shell` (2 sessions on 2026-11-14), or a process below the agent
  that is no MCP server;
- a Megachat run has the session;
- a Codex row with an activity in the last 10 minutes, because Codex writes no permission record;
- no consent `sessions.index`.

Warn in the dialog, and keep the warning in the card:

- uncommitted files in the directory (`git status --porcelain`);
- the branch is ahead of its upstream;
- another live session has the same directory, so the changes can be its own;
- the last activity is less than 1 hour ago.

Never: delete a log, a worktree or a branch; `claude rm --discard-unpushed`; move a file in `~/.claude` or
`~/.codex`; write a mark while a process of the session lives; archive without the dialog.

### What Megachat does alone, and what goes to Air

Alone (phase 1): the card, the batch dialog, the close of terminal and multiplexer sessions, the hide in the formats
of Codex and Air. Air shows the hidden state with no Air release, because it reads these marks.

IJAI ticket (draft, not filed; filed on "да"):

1. Keep the prefix `[archived] ` and the record types as a contract that an ACP agent may write, with a test in Air.
2. Refresh the session list on a new title record of a closed session.
3. Later: an ACP request `_session/archive` from an agent, so Megachat can ask Air to archive a session that Air owns.
   This needs a change of `docs/air-contract.md`.

## Phased plan

Gate rule: a phase starts when the author approves its OpenSpec proposal and the metrics of the earlier phase say it
helps.

0. **Measure** (done in part, section above). Add the two missing numbers: unanswered questions and real duplicates.
1. **Observe and triage** (change `session-triage`, in this commit). One read-only tool `agents_triage` and one rule
   in the instructions: the buckets `needs_you`, `stuck`, `working`, `abandoned`, `quiet`, the duplicate hints, the
   tty of each terminal row, and one chat answer that ends with a close list.
   **Archive** (change `session-archive`): the card, one dialog for the close list, the close of terminal and
   multiplexer sessions, the hide in the formats of Codex and Air, `restore` (section "Archive").
   Gate to phase 2: precision of `abandoned` is 90% or more, restores are under 10%, and no work is lost.
2. **Notify and show** (modifies `session-notes` and `morning-report`; an IJAI ticket for Air). The morning report
   gets a "waits for you" and an "abandoned" line. A note for `needs_you` names the project, the title and the tty,
   and is opt-in under the present `sessions.notes`. The Air side: a count badge of `needs_you` and a read-only list
   of foreign sessions (section "Interface"). No new default.
3. **Adopt** (modifies `delegation`). "Continue this old work" in one step: Megachat reads the old session, asks the
   user to close the old process, then resumes it as a child. Gate: the order of the steps proves no two writers.
4. **Policies** (new capability). Rules of the user, for example "ask me about a session silent for 5 days". A
   rule only asks. It never stops.
5. **Archive** moved to phase 1. Phase 2 can add a model summary of a card on request, after a cost measure.

Not planned: any step that writes into a foreign terminal or into the log of a live session.

## Open questions for the author

1. Is 72 hours the right line for `abandoned`? (Data: 9 of 18 are past it today.)
2. Is a duplicate hint worth a place in phase 1, or does it wait for the measurement of real duplicates?
3. Phase 2: the morning report line only, or also a note for `needs_you`?
4. Interface: the Air section "Other sessions" after phase 1, or only when the chat answer proves daily use?
5. Archive: may Megachat write the title mark of Air into a closed Claude Code log (works today), or wait for an ACP
   request of Air (cleaner, needs an Air release)?
6. Archive: a stop of an idle terminal session after the dialog, or a card and hide only, and the user closes the tab?

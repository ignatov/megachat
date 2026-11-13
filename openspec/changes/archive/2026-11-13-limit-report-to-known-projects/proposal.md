# Proposal

## Why

The Money part of the morning report gives the API-equivalent cost of each agent session of the machine from tokprof
(issue #36). tokprof reads the logs of the user, not the state of Megachat. So the report names the projects of the
whole machine and gives their sum, also in a temporary `MEGACHAT_HOME`. In a run on 2026-11-13, the report gave a sum
of four digits, named projects out of the run, and offered to look into the cost of other work. On the machine of a
colleague and in a demo, this shows private work on the screen. The data also goes to the model in the prompt.

The author decided: the report shows only the projects that Megachat knows.

## What Changes

Where it shows: the Money part of the morning report in the chat, and the JSON of the data in the prompt of the
report turn.

- **Only the projects that Megachat knows.** The tokprof part counts a line of tokprof only when its project is a
  project that Megachat knows, or a directory in one. A project that Megachat knows is a listed directory (the
  workspace of Megachat, a project directory that an IDE registered, or a known repository), or the working directory
  of a child run in the data of the report. The sum, the agents, the projects and the origins of the tokprof part come
  only from these lines.
- **The rest is not shown.** The data gives no cost, no project, no agent, no origin and no sum of the other lines.
  When at least one line is left out, the data says that other work on this machine is not shown, and the report says
  "Other work on this machine: not shown."
- **A group of tokprof is not a project.** tokprof puts some sessions into a group with a name, such as
  `temporary folders` or `codex chats`. Such a line is not a path, so it is not shown. Thus a temporary `MEGACHAT_HOME`
  in `/var/folders`, the place of `mktemp -d` on macOS, shows no tokprof cost of its workspace.
- **One tokprof run.** tokprof still runs one time for a report with the same arguments and no `--project`. Megachat
  applies the filter to the output. `design.md` gives the reason.
- **No known project.** The daemon always lists the workspace of Megachat, so the set is never empty. When no line of
  tokprof is in a known project, the tokprof part gives 0 USD and no project, and the report says that other work is not
  shown.
- **No change of the other parts.** The commits, the sessions, the child runs and the spend of the key of Megachat stay
  as they are. The commits and the sessions already come only from the listed directories.
- **No ACP extension changes.** The report is a text reply of an automatic turn. Air needs no change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `morning-report`: the requirements "Commits and money in the data", "tokprof command" and "Two kinds of money" change.
  The new requirements "Projects of the tokprof part" and "Other work on this machine" give the filter and the text
  about the rest.

## Impact

- Code: `src/Tokprof.mjs` (`parseTokprof` and `readTokprof` get the known projects), `src/MorningReport.mjs`
  (`collectReportData` makes the set of the known projects).
- Strings: `event.morning` and `setting.report.morning` in `resources/Megachat.properties`.
- Tests: `test/morning-report.test.mjs`, `test/workday-daemon.mjs` (the fixture lists the projects of its tokprof lines).
- Documents: `README.md` ("The morning report").
- No field of `conversation.sqlite`, `settings.json`, `spend.json` or another state file changes.
- Out of scope:
  - A setting that shows the cost of the whole machine again, or a question to the user before the first report. The
    author can propose it later.
  - A filter of the names of the known projects. The commits and the sessions already give these names.
  - The line "Megachat key: $0.00" when `workday.timezone` is not the time zone of the system (issue #36, "Also seen").
    `spend.json` counts the local days of the system, and the report reads the days of `workday.timezone`. A fix
    changes the day of the daily spend limit, so it is a change of the capability `spend-limit`. It needs a proposal of
    its own.
  - The cost of the Claude and Codex children (#13), and the delivery of the report in Air with no prompt pending
    (IJAI-6285, item 2).
  - No non-goal changes.

# Design

## Context

See `proposal.md` for the reason of the change.

### The code today

- `collectReportData` in `src/MorningReport.mjs` collects the data of a report. It calls `readTokprof` of
  `src/Tokprof.mjs` one time for the period.
- `readTokprof` runs `tokprof flame --since <first day> --until <report date> --stack agent,project,origin --value cost
  -o <file>` with no shell, in a temporary directory of `mkdtemp`. It reads at most 4 MB of the file, and it removes
  the directory in `finally`.
- `parseTokprof` reads each line `<agent>;<project>;<origin> <micro-dollars>`. It leaves out a line of the agent `pi`
  in the state directory of Megachat, and it adds the cost of that line to `excludedPiChildUsd`. It sums each other
  line into `usd`, `agents`, `projects` (the 15 with the highest cost) and `origins` (the 15 with the highest cost).
- The commits come from the listed directories without the workspace. The session index holds only the sessions of a
  listed directory or of a directory in one (see the capability `session-index`). So only the tokprof part names
  projects of the whole machine.

### The output of tokprof on this machine

A run of tokprof 0.1.6 on 2026-11-13, `tokprof flame --since 2026-11-12 --until 2026-11-13 --stack
agent,project,origin --value cost -o <temporary file>`:

- The run read 1737 Claude files (7.5 GB), 818 Codex files (2.7 GB), 2 pi files and 9 opencode files in 11.6 seconds
  with a warm cache. The comment of `TOKPROF_TIMEOUT_MS` gives about 45 seconds for a first run.
- The file had 26 lines. Each line had 3 frames.
- The project frame of 22 lines was a path in the form `~/...`, for example `~/src/megachat` and
  `~/.jetbrains/air/megachat/workspace`. The project frame of 4 lines was the name of a group: `temporary folders`
  and `codex chats`.
- `tokprof flame --project branch-deck` gave the project frame `~/src/ultimate`. So tokprof matches `--project` with
  the folder of the session, but it names a session in a worktree by its main repository.
- `tokprof flame --project /var/folders` gave the frame `temporary folders` for Claude and for Codex.

## Decisions

### 1. One tokprof run, and a filter of its output

Megachat runs tokprof one time, as today, and keeps only the lines of the known projects.

The other choice was one run with `--project <path>` for each known project. It is worse:

- `--project` takes one text, and each run reads all the logs of the machine again: 11.6 seconds with a warm cache and
  about 45 seconds for a first run. 20 known projects go past the time limit of 120 seconds.
- `--project` matches a part of the text of the project or of the folder of the session. So `~/src/app` also matches
  `~/src/app-2`, and a worktree of another repository with the text in its path. Megachat must apply a filter to the
  output all the same.

The folded stacks hold the project path, so a filter of the output is exact and costs one run.

### 2. The projects that Megachat knows

The set of the known projects is:

- each listed directory of `directoriesOf(state)`: the workspace of Megachat, each project directory that an IDE
  registered, and each known repository;
- the working directory (`cwd`) of each child run in the data: the runs that finished, failed or still run, and the
  runs of the permission requests that wait.

The session index uses the same rule for the listed directories. A child run in a removed project is in the data
already, with its project, so its tokprof cost names no new project. The commits keep their rule.

### 3. The match of a line

`parseTokprof` gets the known projects as real paths. For each line:

1. The rule of the pi line of the state directory comes first, as today. Such a line goes to `excludedPiChildUsd` and
   does not count as other work.
2. `expandHome` gives the path of the project frame. A frame that is not an absolute path after that, such as
   `temporary folders`, is other work.
3. The line counts when its path, or the real path of its path, is a known project or a directory in one. `isWithin`
   of `src/ProjectDirectories.mjs` compares path segments, so `~/src/app-2` is not in `~/src/app`. The real path covers
   a symbolic link, because an IDE and the known list keep real paths. `directoryKey` gives the real path, and it
   gives the absolute path of a directory that does not exist any more.
4. Each other line is other work.

Megachat computes the real path one time for each distinct project frame. The output has a few dozen lines, so the
cost is small.

A line that is in doubt does not count. So a change of the form of the frame in a later tokprof gives a lower cost,
not a project of the whole machine.

### 4. The rest

When at least one line is other work, the tokprof part gets `otherWork: 'notShown'`. Without other work, it has no
such key. The data gives no count, no cost and no name of the other lines. A count of the lines or a sum tells the
amount of private work, and the author asked for neither.

`event.morning` gets a sentence: `money.otherSessions` holds only the projects that Megachat knows; when
`money.otherSessions.otherWork` is `notShown`, say "Other work on this machine: not shown.", and guess nothing about it.

### 5. No known project

The daemon makes the workspace of Megachat at its start and lists it (see the capability `projects`). So the set has
at least one directory. A claude child or a codex child in the workspace costs money on the account of its agent, so
tokprof still runs. When no line is in a known project, the tokprof part is `{ status: 'ok', usd: 0, agents: {},
projects: [], origins: [], excludedPiChildUsd: ..., otherWork: 'notShown' }`.

With a temporary `MEGACHAT_HOME` in `/var/folders`, tokprof names the workspace `temporary folders`. Then the cost of
the workspace is not shown. This is correct: the filter cannot tell this workspace from the other temporary folders.

### 6. The disconnect of a client and a restart

Nothing changes. The daemon collects the data one time and keeps it in `state.morningReport.pending` of the
conversation state, and a run again uses the same data (see the requirement "Turn of the report"). The data in the
state now holds only the known projects. A pending report of an earlier build keeps its data, so after an update it
can run again one time with the cost of the whole machine.

### 7. State, settings and ACP

- No field of `conversation.sqlite`, `settings.json`, `spend.json` or another state file is added. The filter reads
  `megachatWorkspace`, `workspaces`, `projects` and the `cwd` of `runs` of the conversation state. An older state
  directory has them.
- No setting is added.
- No ACP message and no `_meta` key is added or read.

### 8. What stays private and what does not

- The output file of tokprof still holds the whole machine. It stays in a private temporary directory, and Megachat
  removes it after the read, as today.
- Only the filtered part goes into the data, the conversation state and the prompt to the model.
- The names of the known projects are in the data, as today: the commits and the sessions give them too.

## Left out

- The line "Megachat key: $0.00" when `workday.timezone` is not the time zone of the system. `DailySpend` counts the
  local days of the system (`localDay` in `src/DailySpend.mjs`), and `reportPeriod` gives the days of
  `workday.timezone`. A count in the days of `workday.timezone` also moves the reset of the daily spend limit and of
  the spend warning, and it changes the days in `spend.json`. This is a change of the capability `spend-limit`, not a
  small fix of this change.
- The cost of a listed worktree or of a listed subdirectory of a repository. tokprof names a session in a worktree by
  its main repository, so its line is not in the listed worktree. A match of a frame that holds a known project would
  show each other worktree and directory of that repository, so this change does not make it.

## Risks

- A listed worktree, such as a Branch Deck lease that an IDE opened, shows no tokprof cost, and the report says that
  other work is not shown. The cost is too low, but no private name shows.
- Nobody checked whether tokprof gives the root of the repository or the folder of the session for a session in a
  subdirectory. If it gives the root, a listed subdirectory shows no cost.
- A later tokprof can change the form of the project frame. The filter then shows less, not more.
- A pending report of an earlier build can run again one time after the update with its old data.

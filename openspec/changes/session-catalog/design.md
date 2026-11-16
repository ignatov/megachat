# Design

## Context

The code today:

- `SessionIndexService.#candidates()` and `#importPaths()` drop a file whose `mtimeMs` is below `cutoff`
  (`sessions.days`). `#pass()` removes the rows of such a file.
- `SessionCatalog` (the live table `logs`) reads the head and the tail of each file of `source.all()` and keeps no
  text. It skips the archived source. `CodexSessionSource.all()` lists no `.jsonl.zst` file.
- `SessionArchive` uses the live table through `catalog()`, and `AirStore` for the Air state.
- The numbers of the machine of the author on 2026-11-15: 1960 Claude Code files (7.3 GB, 300 older than 30 days),
  827 Codex files (754 of them `.zst`) in `sessions` and `archived_sessions`, 2 pi files, and 1159 Air threads.

The commit `ddfcbd0` fixed one symptom: `SessionArchive.record()` looks for the Codex log by the session ID in the
folder of Codex. This change removes the cause.

## Goals / Non-Goals

**Goals:**

- Each session on the machine is in one catalog, whatever its age, its file form or its source.
- Each tool that finds a session uses that catalog.
- One archive request takes a project and ends with a report of what remains.
- A scan costs a few stat calls in the steady state.

**Non-Goals:**

- Message texts of old sessions in the index.
- The sources Junie, OpenCode and the generic Air store. The interface makes them possible.
- A write to the store of Air.

## Decisions

### 1. The two levels

| Level | Holds | Window | Cost |
|---|---|---|---|
| catalog (`catalog`) | metadata of each session | none | a stat of each file, a head and a tail read of a new or changed file |
| text index (`files`, `sessions`, `entries`, `texts`, `entries_fts`) | messages, cut to 2000 characters | `sessions.days` | as today |

The catalog row says by `indexed` whether the texts of the session are in the index. The window uses the modification
time of the file, as the "Age limit" requirement does now. A session that leaves the window loses its texts at the next
pass, and keeps its catalog row. `sessions.days` 0 means that each session has texts. The consent `sessions.index` is
the consent for both levels: with `off`, Megachat reads no session file and keeps no catalog.

### 2. The table `catalog`

One row for each session. The key is `(agent, session_id)`. When the head of a file gives no ID, the ID that the name of
the file gives is used (`nameId`).

| Column | Meaning |
|---|---|
| `agent` | `claude`, `codex`, `pi`, or the agent name of an Air-only thread |
| `session_id` | ID of the session, or the ID of the thread for an Air-only row |
| `source` | `log` or `air` |
| `path` | the file of the log (UNIQUE, NULL for an Air-only row) |
| `form` | `plain` or `zst` |
| `location` | `sessions` or `archived` (the folder of Codex) |
| `ino`, `size`, `mtime_ms` | the identity of the file, for the change check |
| `offset`, `last_step` | the data that the live table has today |
| `cwd`, `title`, `title_rank`, `started_at`, `updated_at` | the metadata. The filter of titles of the index cleans `title` |
| `archived` | 0 or 1: the title prefix `[archived] ` or the folder `archived_sessions` |
| `air_thread` | the directory name of the thread of Air, or NULL |
| `air_archived` | 0, 1 or NULL for no thread or an unknown state |
| `air_checked_at` | the time of the last read of the thread |
| `state` | `ok` or `unreadable` |
| `indexed` | 1 when the texts of the session are in the index |

Indexes: `(cwd, updated_at)` for the project queries, `(agent, session_id)`, and `air_thread`. The plain file and the
compressed file of one Codex session are one row. The source says which one wins (`prefers`, as now).

### 3. The scan

`source.all()` of each source gives the files. For each file the pass compares `(ino, size, mtime_ms)` with the row.
Only a new or changed row is read: the head (at most 1 MB) and the tail (64 KB), and for a `.zst` file one stream
decompression. A `.zst` file never changes, so it is read one time.

- The first pass reads the new files by the modification time, the newest first, with a pause between two files (as
  the live table does now). The catalog reports `progress` and `complete`. A tool that needs the whole catalog tells
  the user when `complete` is false (see the capability `running-sessions`, "Incomplete lists").
- After the first pass: the watch of the roots and the size poll of the live table work as now, and a catch-up (start,
  before a search) enumerates all files. On the machine above the enumeration is about 2800 stat calls plus 1159 stat
  calls for the Air threads.
- A file that is gone leaves the catalog, except a Codex file that moved to `archived_sessions` (the session is the same).
- Air: for each thread directory the pass reads `summary.json` when its stat changed, and `events.jsonl` (at most 64 MB,
  `EVENTS_LIMIT`) only when `summary.archived` is missing and its stat changed. The `association.agentSessionId` and
  `namespaceId` link the thread to a log row (the rule of `AirStore.thread()`). A thread with no matching log row, or
  with no association, makes an Air-only row.

#### 3a. The scan of one project

Before an archive by project (decision 6), the catalog finishes the scan for that `cwd` only. It does not wait for
the first pass of the machine. Each source has `projectFiles(cwd, fs)`, which gives the files of that project:

- Claude Code: the one directory `<root>/<encoded cwd>/`. When the encoded name is longer than the limit of Claude
  Code, the name ends with a hash, so the scan reads each directory with the same prefix and keeps a file only when the
  `cwd` of its head is the project.
- Codex: `~/.codex/state_5.sqlite` (or `$CODEX_HOME/state_5.sqlite`) is a hint. Megachat opens it read-only and reads
  `id`, `cwd`, `rollout_path` and `archived` of the table `threads` for the project. The file has no contract. So the
  scan checks each file of the hint by its first `session_meta` line (the ID and the `cwd`). When `rollout_path`
  does not exist, the scan takes the `.zst` sibling (`sibling()`), and then the same name in `archived_sessions`.
  The hint does not give the archive state: the folder and the log give it, as now. On 2026-11-15 the table had 831
  threads, and only 3 `rollout_path` values named a `.zst` file of the 754 that exist.
- Codex, the files that the hint does not name: each rollout file that has no catalog row, or a changed
  `(ino, size, mtime_ms)`, gets a read of its first line only. For a `.zst` file the decompression stops after that
  line. A file of a row that is already read gives its `cwd` from the row.
- Codex, no hint: when `state_5.sqlite` is missing, cannot be opened, or has no table `threads` with these columns,
  the scan reads the first line of each Codex file without a current row. The log records the reason once.
- pi: the one directory `--<path>--` of the project, as `files()` gives now.
- Air: `store.json` of each hash directory (`AirStore.projects(cwd)`), and then only the `summary.json` of the threads
  of the project. On 2026-11-15 there were 33 hash directories.

The rows that this scan reads go into `catalog` with the usual full read (head and tail). The first pass of the machine
skips them later, because their identity did not change.

The cost on the machine above: with the hint, about 10 Codex files of the project. Without the hint, about 830 `stat`
calls and the first line of each Codex file without a row. One `zstd -dc` of the first megabyte took 27 ms, so the
worst case is 10 to 25 seconds, one time. A `.zst` file never changes, so the second scan reads none.

While the scan runs, the tool call of `agents_archive` runs and no dialog shows. The tool sends the counts of the scan
(`<agent>: <done>/<total>`) to the log and to the progress row of the change `tool-progress-line`. That row has a fixed
title now, so a text with the counts needs a modification of that change (see the open questions). An abort of the turn
stops the scan. Then the tool builds no batch, shows no dialog, and the result gives the counts that it read.

A file that the scan cannot read makes the project catalog not complete. The dialog then says how many files were
not read and the reason of each group (`unreadable` for a file that cannot be opened or decompressed, `no session_meta` for a Codex file without that first line). With each file read, the dialog
says that the project catalog is complete.

#### 3b. A restart in the middle of the first pass

The pass writes the row of each file into `catalog` when it reads the file, in its own transaction. A restart keeps
these rows. The next pass reads only the files without a row or with another `(ino, size, mtime_ms)`. `complete` stays
false until that pass reads each file. The flag is not stored: each start begins with `complete` false, and the
catch-up sets it.

The first pass on the machine above is bounded: about 2800 files, a head and a tail of at most 1.1 MB each, and the
decompression of 754 `.zst` files. The task 1.1 measures it before the code. A failure of one file sets `state` to
`unreadable` and does not stop the pass (as now).

### 4. The sources

The interface of `src/SessionSources.mjs` stays. It gets:

- `all(fs)` includes each file of the source, also `.zst` and the archived folder, and each form of the file.
- `describe(file, fs)` gives `{ sessionId, cwd, title, titleRank, startedAt, updatedAt, archived }` from the head and
  the tail. It replaces the code of the live table that reads these fields.
- `hide` and `show` (optional): the hide and the restore of the session (the title record or `codex archive`). They
  move from `SessionArchive` into the source, so a new agent brings its own.

A new source `AirThreadSource` (`source: air`) reads the threads of the store of Air. It has no log and no hide. Junie,
OpenCode and the generic store are follow-ups: each one is a source with `all` and `describe`.

### 5. The consumers

- `agents_sessions` and the tool `sessions`: with a `query`, the match of the index gives the texts; the catalog gives the
  sessions outside the window by the title, the ID and the directory. The result tells that the texts search only the
  last `sessions.days` days. With no `query`, the list is the catalog.
- `agents_session_history`, `session_history`: the catalog resolves the session ID to a `path` and a `form`. A session that
  has no texts in the index is read from its file by the history service of the agent, as the live-provider read does now.
  An Air-only row has no history, and the result says so.
- `agents_running`: the enrichment reads the catalog row of a live session.
- `agents_archive`: all actions resolve a session by the catalog (see decision 6).

### 6. Archive by project

`agents_archive` with `action: "archive"` takes `project` (a directory, a listed one) or `sessions` (the present
parameter, at most 50). Not both. The new parameters of the project mode are `exclude` (session IDs or short IDs) and
`updatedWithinHours` (N: skip a session with an activity in the last N hours).

1. The catalog finishes the scan of the project (decision 3a). Then it gives the candidates: each row of the project with `archived = 0`, source `log` or `air`.
2. The checks that exist now remove the refused rows before the dialog (working, stuck, waiting, a tool below, a Megachat
   run, a Codex activity in 10 minutes). The result keeps each refused row with its reason.
3. The Air-only rows cannot be hidden by Megachat: they are not in the dialog list, and they go to the report with the
   reason `Done in Air`.
4. One dialog, with the options `archive` and `keep`: the state of the project catalog (complete, or the count of the
   files that were not read and the reasons), the total count, the count of each agent, the count of the warnings, the lines of the first 50 rows (the newest first), and "and N more" for the rest. The batch is frozen at
   this moment: the rows that the user confirmed are the rows that the tool processes, not a new query.
5. The limit: an explicit `sessions` list stays at 50. A project batch has at most 500 rows, because the dialog
   cannot show more in a form that the user checks. A project with more rows gets a refusal that tells the user to
   narrow it with `exclude` or `updatedWithinHours`. Open question 2 asks if the user wants another number.
6. The rows go one at a time in the order of the archive (card, stop, hide). An abort of the turn stops after the
   present row. The result says how many are done.
7. The report check: the tool reads the store of Air again (as the "State of Air after the hide" requirement does) and
   gives each remaining session with a reason: `Done in Air` (an Air thread that still shows), `live process` (a
   session of an IDE, of a Megachat run, or of an unknown owner), `refused: <status>`, `failed: <step>`. A project that
   has no remaining session says that.

The rule that only a user's turn can archive stays: the tool refuses in an automatic turn. The dialog stays the only way.

### 7. Absorb the fix of `ddfcbd0`

The `.zst` log of Codex is a catalog row with `form: zst`, so `SessionArchive.record()` needs no look into the folder of
Codex. The task 3.2 removes that code and keeps its test of the compressed fixtures. `hide()` still runs `codex archive
<id>`. Order of the work: the commit `ddfcbd0` and the change `session-archive` stay as they are; this change replaces the code.

### 8. Migration of `sessions.sqlite`

- `VERSION` of the index file stays 4. The table `catalog` is made with `CREATE TABLE IF NOT EXISTS`, as `logs` is: a file
  of the same version gets it without a new import of the texts.
- At open, when the table `logs` exists, one transaction copies each row into `catalog` (`last_write_at` becomes
  `mtime_ms`, and the form, the location, the archive state and the Air link are filled by the first pass), and then drops `logs`.
  A start of an older build with this file makes `logs` again and does not use `catalog`.
- The texts: no change at the start. The window of the pass removes the texts of a session whose file is older than
  `sessions.days`. With the new default, a user who has no stored value loses the texts between 30 and 180 days at
  the next pass. The catalog keeps these sessions, and the history is read from the file. A user who sets
  `sessions.days` to 180 again gets the texts back at the next pass.
- `settings.json` has no new key. A stored `sessions.days` wins over the default, so the 30 of the author stays.
- The catalog does not hold the version in a separate column: the pass checks each file by `(ino, size, mtime_ms)`, and the version of the index file already
  forces a new import for a filter change.

### 9. ACP and state

No ACP message and no `_meta` key. The state files: the table `catalog` in `sessions.sqlite`. The daemon keeps no new
work through a disconnect or a restart: the catalog is a cache of the files, and the first pass after a restart reads
only the changed files. The archive batch of decision 6 is not stored: a restart in the middle of a batch leaves the
rows that have a card and no hide, and the next archive of the project does them again (the card step finds its card).

## Risks

- **First pass cost.** About 2800 files, 754 decompressions. Mitigation: the newest first, pauses, `progress`, a bounded head
  read, the measure in task 1.1.
- **A catalog that is not complete** gives a short list. Mitigation: `complete: false` shows in each tool result.
- **The schema of `state_5.sqlite` can change.** Codex gives no contract for it. Mitigation: read-only, a check of the
  columns before the read, a check of each file by its first line, and the fallback to the first-line scan.
- **A hint that is not correct** (a stale `rollout_path`, a `cwd` that the session changed). Mitigation: the file
  decides, and the scan reads each Codex file without a row that the hint does not name.
- **Air store format.** `summary.json` has no contract. Mitigation: read only (as now), `air_archived` NULL means unknown, and an unreadable thread is skipped.
- **A bigger dialog.** The user can approve 500 sessions in one click. Mitigation: the 500 limit, the per-agent counts, the warnings,
  the frozen list, and a card before each hide.
- **Loss of derived texts** at the change of the default. Mitigation: the data is a cache, and the setting brings it back.
- **A session without an ID** (an unreadable head) gets the `nameId`. Two forms of one file share it.
- **Privacy.** The catalog keeps titles and directories of all old sessions in `sessions.sqlite` (mode as today), and the filter cleans titles.

## Open Questions

1. The default of `sessions.days`: 30 removes the texts between 30 and 180 days for a user without a stored value.
2. The limit of a project batch: 500 rows, with 50 lines in the dialog.
3. The counts of the scan in the progress row: the change `tool-progress-line` gives the row a fixed title with no
   output. A text with the counts needs a modification of that change. Without it, the counts go only to the log.

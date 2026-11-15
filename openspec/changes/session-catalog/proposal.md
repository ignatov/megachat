# Proposal

## Why

Sessions get lost in two places.

1. The session index drops a log whose modification time is older than `sessions.days` (180 by default, 30 for the
   author). A session older than that cannot be found, listed or archived through the index.
2. Each part keeps its own list of sessions. The archive and `agents_running` use the live table
   (`SessionCatalog`). The search uses the index. Each list misses some files: `CodexSessionSource.all()` skips the
   Codex `rollout-*.jsonl.zst` files, the Air-only threads in `<caches>/<IDE>/acp/projects/<hash>/threads/` are in no
   list, and a new source (Junie, OpenCode, a generic ACP agent) would need a change in each list.

A real case on 2026-11-15: the archive of `/Users/ignatov/src/air-audit` into an empty folder. The index held 41 of
55 Claude Code logs. Three Codex `.zst` sessions were refused. The tool needed pages of 10 sessions.

The author decided on 2026-11-15: "the catalog has no age limit, the texts have 30 days, the archive works by project,
OpenSpec first".

## What Changes

Where it shows: the chat (the tools `agents_sessions`, `agents_session_history`, `agents_running`, `agents_archive`),
the log and `README.md`. No ACP extension changes.

- **Two levels in `sessions.sqlite`.** (a) A metadata catalog of each session on the machine, with no age limit. (b) The
  full-text index of messages, only for the last `sessions.days` days. The window now limits only the texts.
- **One catalog.** The archive, the search and the list of sessions, the enrichment of `agents_running`, and the lookup
  of a session for its history use the catalog. The live table `logs` becomes a part of it.
- **One source interface for each agent.** Claude Code, Codex (also `.jsonl.zst` and `archived_sessions`), pi, and the
  Air-only threads. Each row has a `source`. The sources of other agents join later on the same interface.
- **Archive by project.** `agents_archive` takes a project and optional exclusions. It asks once, archives every
  session that it can, checks what Air shows, and reports what remains and why.
- **The default of `sessions.days` is 30.** A stored value wins.

## Capabilities

### New Capabilities

- `session-catalog`: the catalog, its sources, its use by the other tools, and the archive by project.

### Modified Capabilities

- `session-index`: "Age limit" limits only the texts. "Sources of the index", "Version of the index file" and "Files that
  hold no running session" change in the way that `design.md` says (decisions 2 and 5).
- `settings`: "Settings of the index of past sessions" has the default `30` for `sessions.days`.

The change depends on `session-archive`, which is not archived yet. It adds to the tool `agents_archive` of that
change, and it keeps its limits and its rules. Archive `session-archive` first. Then archive this change. The fix of
the commit `c3ff63d` (the Codex `.zst` lookup in `SessionArchive.record()`) is a part of this change: the catalog gives
the path of such a log, so that code goes away (see `design.md`, decision 7).

## ACP and Air

No ACP extension changes, and `docs/air-contract.md` does not change. Megachat reads the store of Air as before and
never writes it. The catalog adds a read of `summary.json` of each thread. Air needs no change. An Air-only thread
stays shown in Air until the user presses Done there.

## Impact

- Code: `src/SessionCatalog.mjs` (no more the live table only: the catalog of all sources), a new `src/AirThreadSource.mjs`,
  `src/SessionSources.mjs` (the interface), `src/SessionIndexService.mjs` (the window of the texts), `src/SessionIndex.mjs`
  (the table `catalog`, the migration), `src/SessionArchive.mjs` (the project mode, the end of its own lookup),
  `src/RunningAgents.mjs`, `src/SessionHistoryService.mjs`, `src/Settings.mjs`.
- State: a new table `catalog` in `sessions.sqlite`, and no new file. The table `logs` leaves (see `design.md`).
- Strings: the new dialog and the report in `resources/Megachat.properties`.
- Tests: a new `test/session-catalog.test.mjs`, and cases in `test/archive.test.mjs`, `test/session-index.test.mjs`,
  `test/running.test.mjs` and `test/settings.test.mjs`.
- Documents: `README.md` (the setting, the archive by project).
- Out of scope:
  - The sources Junie (issue #44, `~/.junie/sessions`), OpenCode (#43) and the generic Air thread store (#45). They
    are follow-ups on the same interface.
  - A write to the store of Air. A delete of a log. A model summary in a card.
  - A text index for the sessions outside the window.
  - An automatic archive: each archive needs the confirmation of the user.
  - The non-goals of `openspec/config.yaml` do not change.

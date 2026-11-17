# Design

## Context

`UpdateCheck` of `src/MegachatUpdate.mjs` owns the timers of the update. `src/main.mjs` builds it after the publish of
the connection file. The service has no link to it, so the main agent cannot ask it.

## Decisions

### 1. Check on demand

`UpdateCheck.checkNow()` runs `check()` in the line of the other work of the update and gives `summary()`. The summary
holds `version`, `latest`, `available`, `kind`, `checkedAt` and `error`. `PiMegachatService.updater` holds the check,
and `main.mjs` sets it. A service without it answers `unavailable`.

### 2. Timer

`schedule()` stores a due time. One timer lasts at most `CHECK_TICK_MS` (1 hour) and then compares the wall clock with
the due time. After a sleep, the first tick finds the check due. The 24 hours and the retry after 1 hour stay.

### 3. Request of the user

`apply({ whenIdle })` checks, then:

- no higher release: `current`, or `checkFailed` when the check failed;
- `kind` `checkout` or `other`: no stop, the reason `checkout` or `other`;
- work (`PiMegachatService.updateWork()`, without the turn of the request) and no `whenIdle`: `busy` with the list;
- else `requested` is true. The conditions then poll each `APPLY_POLL_MS` (2 seconds) and stop when `updateWork()` is
  empty, which includes the end of the turn of the request. The request needs neither `update.auto` nor the night
  window, because the request is the approval. The stop is the stop of the automatic update.

The tool refuses in a turn whose kind is not `user`, with the error `updateEvent`. A `check` is allowed in each turn.

### 4. The copy of npx

The measurement in `docs/manual-checks.md` shows that npm 11.19.0 installs the new tag at each start, and the key of
`_npx/<hash>` comes from the spec only. An older npm may reuse the directory. After the stop, `main.mjs` calls
`retireCopy(root)`: when `root` is `_npx/<hash>/node_modules/megachat` without `.git`, and its `package.json` has the
name `megachat`, the directory `_npx/<hash>` is renamed to `<hash>.megachat-old-<ms>`. A rename keeps the files of a
process that loads them late, and it needs no wait. `removeRetired(root)` at the start of the next daemon removes the
directories `<hash>.megachat-old-<digits>` next to its own `<hash>`. Nothing else is removed. The cost is the install
that npx does anyway for a new release. When the network is down at the next start, npx fails with or without the
copy (see `docs/manual-checks.md`).

### 5. `update.auto` migration

The default is `true`. `SettingsStore.migrate()` runs at the open: when `migrations.updateAuto` is not `true`, a stored
value other than `true` is removed in memory, and the record is set in memory. The next write stores both. A start that
no write follows repeats the same change, so the result is the same. A new file starts with the record. A later
`false` of the user goes with the record, so it stays. The variable rules do not change: `update.auto` has no variable.
The field `migrations` is new in `settings.json`. An older build ignores it, as it ignores each unknown key.

`recordVersion` takes `autoOn`, which is true when the open migrated the file and the value is `true`. The waiting
notice of the update gets `autoOn`, and `updateNoteText` adds the line `update.autoOn` and gives it one of the lines of
the limit. A daemon with no version change gives no note.

## Risks

- A start of a copy through an old npm that reuses nothing needs a full install after the move: about 1 minute.
- Air must start the agent again after the exit. The check of the author is open (`docs/manual-checks.md`).

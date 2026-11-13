# Design

## Context

See `proposal.md` for the reason of the change.

### How a release reaches a colleague today

- The entry of `install` is `npx -y github:ignatov/megachat#semver:x acp` with the `env` of `ENTRY_GIT_VARIABLES`
  (`src/MegachatInstall.mjs`, `RELEASE_ENTRY`). npm runs `git ls-remote` and selects the tag `v<version>` with the
  highest version.
- npm installs the copy in `<npm cache>/_npx/<hash>/node_modules/megachat`. The copy has no `.git`, so its version is
  the version of `package.json`, for example `0.4.0` (`src/sourceBuildId.mjs`, `buildVersion`), and its build ID is the
  version and a digest of its files (`sourceBuildId`).
- `acp` calls `start()` of `src/main.mjs` one time, at its start. `start()` connects to the daemon of the state
  directory. When the daemon has another build (`needsReplacement` of `src/MegachatBuild.mjs`), `start()` sends
  `/shutdown`, waits for the end of its process, and starts its own daemon. So the bridge of a newer release already
  replaces the daemon of an earlier release. This change reuses that path without a change: after the automatic stop,
  no daemon runs, and the next `start()` of the new copy starts its own daemon.

### What the bridge does when its daemon goes away (measured on 2026-11-13)

A probe in the lease with a temporary `MEGACHAT_HOME` started `node src/main.mjs acp <home>`, sent `initialize`, and
then stopped the daemon with `node src/main.mjs stop <home>`:

| The bridge | Result |
| --- | --- |
| with a view of `session/new` | The event stream of the view ended. The bridge wrote "Megachat lost its local event connection (UND_ERR_SOCKET)." to its error output, ended the ACP connection, and exited with the code 0 after 305 ms. |
| without a view, only `initialize` | The bridge kept running for 8 s and more. A later `session/new` got the error `-32603` "Internal error" with the details "fetch failed". The bridge started no daemon, and no daemon ran after it. |

So the code today already has the important property: **a bridge never starts a daemon after its own start**. It
calls `start()` only once, and `DaemonClient` keeps the port and the token of the first daemon. An old bridge thus
cannot start a daemon of its old copy. But a bridge without a view stays alive with a dead daemon and gives an error
to each request. This change closes that gap (decision 5).

### Where the release notes are

`release.mjs` (the capability `release`) makes the notes from the subjects of the commits since the last release, and
gives them to `gh release create --notes-file -`. So the notes are only in the body of the GitHub release. The package
has no notes: `package.json` `files` is `bin`, `src`, `resources` and `README.md`, and the tag commit is on `main`
before the release, so the notes cannot be in it. The tag message is `Megachat <version>`, and `git ls-remote` does not
give it.

## Goals / Non-Goals

**Goals:**

- A daemon of a release finds a higher release at its start and within 24 hours.
- A daemon of a copy of npx stops itself for the update only when no work runs or waits, outside the working time.
- The next start goes through `npx`, so it gets the new release. No process of Megachat starts a daemon or `npx` for the
  update.
- After the update, the user gets one message with the old and the new version and the release notes.

**Non-Goals:**

- A change of the replacement of a daemon by a newer bridge during the day.
- An install of the new release by the daemon itself, for example with `npm` or `git clone`.
- A message in the chat while the update waits.

## Decisions

### 1. The check of a release

- The command is `git ls-remote --tags --refs <repository>`, with the repository
  `https://github.com/ignatov/megachat`. `git` comes from `PATH`. The environment is the environment of the daemon with
  `ENTRY_GIT_VARIABLES` of `src/npmEnvironment.mjs` and `GIT_TERMINAL_PROMPT=0`. So git ends a stalled transfer after
  20 seconds, and it never asks for a password. A timer ends git with `SIGKILL` after 30 seconds, because the variables
  do not end a proxy that never answers `CONNECT` (see the change `first-start-feedback`).
- The daemon takes each line `refs/tags/v<major>.<minor>.<patch>`. A pre-release, such as `v0.5.0-rc.1`, and each other
  tag do not count. The highest version is the release.
- The own version is `megachatVersion()` of `src/MegachatBuild.mjs`. The comparison uses the part before `+`, so
  `0.4.0+9.geb044cf` compares as `0.4.0`. A release is available only when its version is higher.
- The first check runs after the daemon published its connection file, so the check does not delay the start. Then
  the next check runs 24 hours after the last successful check. A failure, such as no `git`, an exit code other than 0,
  the time limit, or an output without a release tag, writes one line to the log of the daemon and gives a next check
  after 1 hour. The user gets no message.
- The timers use a clock object, as `src/MorningReport.mjs` does: a test gives a fake clock. Each timer is `unref`, so
  it does not keep a stopping daemon alive. A timer that comes late after a sleep of the computer only checks later.
- The variable `MEGACHAT_RELEASE_REPOSITORY` replaces the repository. `test/state-guard.mjs` sets it to a path that
  does not exist, so no test uses the network, and a test sets it to a local bare repository with tags. The variable
  is not a setting for the user. `withoutNpm` does not touch it.

Alternatives:

- **The GitHub API for the tags.** It needs no `git`, but it has a limit of 60 requests per hour for each address
  without a key, and npm uses `git ls-remote` for `#semver:x` too. So `git` gives the same answer as npx.
- **A check only at the start.** A daemon lives for days, so it would not find a release in time.

### 2. The notice

- `/health` of the daemon gets the field `update` when a higher release is available:
  `{"available":"0.5.0","notice":"A new release is available: 0.4.0 → 0.5.0"}`. The text is the message
  `update.available` of `resources/Megachat.properties`. A daemon without a known release gives no field.
- `status` prints the key `update` with the text of `notice`, directly after the key `version`:
  `{"running":true,"version":"0.4.0","update":"A new release is available: 0.4.0 → 0.5.0","current":null,"children":[]}`.
  A daemon of an earlier build gives no field, so `status` prints no key.
- `agentInfo.version` of `initialize` does not change. The issue names the status only.

### 3. The setting `update.auto`

A global setting in `settings.json` (see the capability `settings`): boolean, default `true`, no variable, not a
project setting. It applies at the next check of the conditions, so it gets the new text
`settings.applies.update`: "At once. The next check of the update uses the new value." The default is `true`, because
the author wants colleagues to update without an action. A change of `update.auto` comes from the user through the
main agent, as each setting does. An automatic turn cannot change it (see the requirement "No change from an automatic
turn" of `settings`).

### 4. The automatic stop

- **The kind of copy.** The daemon stops itself only when its package root is not a git checkout and its path ends
  with `_npx/<one directory>/node_modules/megachat`, the same pattern as `earlierEntry` of `src/MegachatInstall.mjs`.
  A checkout, the bundle in `out/bundle`, a copy of `npm install -g` and a copy of `npm pack` do not stop themselves: a
  start of such a copy gives the same version again. One function in `src/MegachatUpdate.mjs` holds the rule.
- **The conditions.** A new method of `PiMegachatService` reads the state snapshot one time and gives `true` only when:
  - `state.current` is `null`, the inbox has no item, and `state.morningReport.pending` is `null`;
  - each run of `state.runs` is in a terminal state (`terminalStates` of `src/MegachatState.mjs`), which covers the
    Claude, Codex and pi children, also a run that waits for its start or for an approval;
  - no permission request is open (`permissionOpen`), and the daemon has no open stop request (the stop dialog keeps
    its requests in the memory of the daemon);
  - the time is right. With `workday.enabled` on, `isSleeping` of `src/Workday.mjs` with the end of the last turn of
    the user, which is the rule of the keep-alive and of the waiting child results. With `workday.enabled` off, the
    local time of `workday.timezone` is 01:00 or later and before 05:00, and the last turn of the user ended 30
    minutes or more before.
- **The time of the check.** While a release is available and the stop is allowed, the daemon checks the conditions
  every 10 minutes, and once directly after the check of the release. The 4 hours of the window give 24 checks, so a
  turn at 01:05 does not lose the night.
- **The work during the stop.** Between the check of the conditions and the stop, a new input can arrive. The daemon
  keeps it as each stop does: the input is admitted in `conversation.sqlite`, and the next daemon runs it. So the user
  loses no message. The reply of that input comes after the next start.
- **The stop.** The daemon first writes `update.stop` to the state (decision 6), then sends the event `update` on each
  event stream, then waits 1 second for the bridges, then calls the same `shutdown()` of `src/main.mjs` as `/shutdown`.
  So the daemon closes the server, the children, the transcripts and the storage in the usual order, releases the lock
  and removes the connection file. Its exit code is 0. The log of the daemon gets one line "Megachat stops for the
  update from 0.4.0 to 0.5.0."
- **No start from inside.** The daemon starts no process for the update: no daemon, no `npx`, no `npm`, no copy of
  Megachat. The only process of the check is `git ls-remote`, and of the notes none (`fetch`).

How the daemon keeps the admitted work through the stop and the next start: the stop is the clean stop of today. Each
admitted input, each child run, each waiting result, each permission request, the morning report and the settings are
in `conversation.sqlite`, `settings.json` and `spend.json`. The conditions make sure that no child process runs at the
stop, so no tool call is lost. The next daemon resumes the state as after each restart (see the capability
`run-recovery`).

### 5. The bridge after the stop of its daemon (the crux)

The old bridge must end, so that the next start goes through `npx`, and it must never start a daemon of its old copy.

- **A bridge with a view.** The view gets the event `update` with `{"from":"0.4.0","to":"0.5.0"}`. The bridge writes
  the message `log.update.bridge` to its error output, "The Megachat daemon stopped for the update from 0.4.0 to 0.5.0.
  The next start of Megachat installs it.", and ends the ACP connection. When the stream ends without the event, the
  bridge writes the line `error.connection` of today. In both cases the process exits with the code 0, as it does
  today. A bridge of an earlier build ignores the unknown event and ends at the end of the stream, as in the probe.
- **A bridge without a view.** The bridge asks `/health` of its daemon every 60 seconds while it has no open view, with
  a time limit of 2 seconds. When two requests in a row fail, or `/health` gives another `pid`, the bridge writes the
  message `log.daemonGone` and ends the ACP connection. So it exits within about 2 minutes. A request of the client to
  a bridge whose daemon is gone also ends the connection after its error answer.
- **No start after the start.** The bridge keeps the client of its first `start()`, and it has no path that calls
  `start()` again. A test makes this a requirement: after the stop of the daemon, no daemon process runs for the
  state directory, and a request to the old bridge starts none.

What Air sees:

- At the stop, each agent process of Megachat in the IDE exits with the code 0, and the log of the IDE has the line of
  `log.update.bridge`. No turn runs, so Air cancels no prompt. The open background tasks of the view are ended runs, so
  Air shows none as running.
- At the next attach, or at the next prompt of the user, Air starts the command of the entry again: `npx -y
  github:ignatov/megachat#semver:x acp`. npx asks GitHub for the tags and installs the new release. The new bridge
  starts the new daemon, and Air loads the persistent session (`persistentSession` in `docs/air-contract.md`).
  The replay shows the conversation. The note of decision 6 comes before the next reply.
- This expectation is not checked on a real IDE build. Task 6.2 is a manual check of the author. When Air does not
  start the agent again, or shows an error for the end of the process, that is an Air side: an IJAI ticket of the
  author, not filed by this change.
- When the network fails at the next start, the start fails as each start without the network does today (README,
  "The start in the IDE"). The state stays, and a later start works.

Alternatives:

- **The bridge starts the daemon of the new release.** It would need `npx` or a download inside the old bridge, and
  the rule of the issue says that Megachat never starts a daemon from inside.
- **The bridge stays and starts a daemon when its daemon is gone.** It would start the old copy, which is the error
  that the issue names.
- **The daemon asks Air to restart the agent through an ACP extension.** It needs a change in Air for each IDE build.
  The exit of the process needs none, if Air starts the agent again.

### 6. The state of the update

The state document of `conversation.sqlite` (the root document of `MegachatState`) gets the field `update`:

```json
"update": {
  "version": "0.5.0",
  "stop": { "from": "0.4.0", "to": "0.5.0", "at": 1794600000000 },
  "failed": "0.5.0",
  "notice": { "from": "0.4.0", "to": "0.5.0", "notes": [{ "version": "0.5.0", "text": "- ..." }], "url": "https://github.com/ignatov/megachat/releases/tag/v0.5.0" }
}
```

- `version`: the version of the last daemon that opened the state, as `megachatVersion()` gives it.
- `stop`: the last automatic stop, or `null`.
- `failed`: the release for which an automatic stop gave no update, or `null`.
- `notice`: the message that waits for the next turn of the user or for the morning report, or `null`.

An older state directory has no field. The migration in `MegachatState` (the block with `??=`, next to
`morningReport`) sets `update` to `{ version: <this version>, stop: null, failed: null, notice: null }`, so the first
daemon of this change records its version with no message. A daemon of v0.4.0 that opens the state again keeps the
field as it is, as it keeps `sessionNotes`.

At each start, after the migration:

1. When the base version of this daemon is higher than the base version of `update.version`, the daemon gets the
   notes (decision 7), sets `notice`, and clears `failed`.
2. When `update.stop` exists and the base version of this daemon is not higher than `update.stop.from`, the stop gave
   no update. The daemon sets `failed` to `update.stop.to` and logs `log.update.failed`. Then no automatic stop comes
   for that release or a lower one. A higher release can stop the daemon again. The notice in `status` stays.
3. A lower version, such as a return to an earlier release, records the version with no message.
4. The daemon sets `version` to its own version and `stop` to `null`.

The base version decides, so a pull of a checkout with a new commit gives no message.

### 7. The release notes and the message

- The new daemon asks `https://api.github.com/repos/ignatov/megachat/releases?per_page=30` with `fetch` and a time limit
  of 10 seconds, without a key. It takes each release whose tag is a release version higher than the earlier version
  and not higher than its own version, and its `body`, the newest first. The variable `MEGACHAT_RELEASE_NOTES_URL`
  replaces the address. `test/state-guard.mjs` sets it to a local address that gives no answer.
- The message has at most 40 lines of notes and at most 8000 characters. Longer notes end with the line of the message
  `update.more` and the address of the release.
- A failure, such as no network, an HTTP status other than 200, invalid JSON or the time limit, gives the message
  without the notes and with the address of the release: `update.noNotes`. The log gets one line. The daemon does not
  ask again.
- The message is a note of the daemon, as the notes about the waiting sessions (see the capability `session-notes`):
  an entry of the kind `air.megachat.note` with the data `{"type":"update","from":"0.4.0","to":"0.5.0"}`, and a fixed
  text without a model request. The daemon writes it in the same transaction as the input of the next turn of the user
  or of the turn of the morning report, directly before that input. So the chat shows the message, then the reply, and
  the main agent sees the message in its context. The daemon then sets `notice` to `null`. A turn of a child result
  does not take the message, because the issue names the reply to the user and the morning report.

Alternatives:

- **The main agent writes the message.** A model can shorten or leave out the notes, and the version numbers must be
  exact. The fixed text costs no request.
- **Notes in the package.** `npm run release` cannot add a file to the tag commit, because it refuses a checkout with
  changes and pushes only the tag. A `CHANGELOG.md` that the author commits before each release changes the release
  steps of the author. A later change can add it; then the daemon reads the notes from its own copy and needs no
  network.
- **The message at the start of the new daemon.** The daemon can start at 03:00 with no user. The message before the
  next reply comes when the user reads.

### 8. The entry and the npx cache

A separate measurement checks whether `#semver:x` selects the new tag at the next start of npx, or whether the npx
cache gives the old copy, and whether `--prefer-online` changes it. Task 1.1 takes the result:

- When npx selects the new tag, the entry stays, and `install` does not change.
- When it does not, the entry gets the fix of the measurement, and a delta of `install` modifies "Entry of a copy
  without .git" and replaces the entry of this release. Decision 6, step 2, keeps a daemon of a stale copy from a stop
  in a loop in both cases.

### ACP messages and `_meta` keys

- No new ACP message and no new `_meta` key. `initialize` stays the same.
- The local event stream of the daemon (`/events`, not ACP) gets the event type `update` with `{from, to}`.
- `/health` gets the field `update`.
- The note of decision 7 goes to Air as an `agent_message_chunk` with the message ID `megachat-entry-<entry>`, as each
  note does today.

## Risks / Trade-offs

- [Air does not start the agent again after the exit] → The user sees no Megachat until a new window or a restart of
  the IDE. Task 6.2 checks it before the default `true` reaches colleagues. If it fails, the author can set the default
  to `false` or file the Air side.
- [The user works at night with no turn for 30 minutes] → The stop can come then. The next prompt goes through the
  next start. With `workday.enabled` on, the rule is the sleep of the conversation, so a user who works late keeps the
  daemon while turns come.
- [npx gives the old copy] → Decision 6 stops the loop after one stop. Task 1.1 measures it.
- [A newer bridge replaces the daemon during the day] → The behavior of today. It is out of scope.
- [The GitHub API has a limit of 60 requests per hour] → The daemon asks one time for each update.
- [The text of the notes comes from GitHub] → It is the text that the author released, and the note is a message of
  Megachat in the chat, not an instruction.

## Migration Plan

The first daemon of this change records its version with no message. `update.auto` has the default `true`, so the
next release after this change updates each colleague who runs a copy of npx. A colleague who runs a release before
this change gets this change through the replacement by a newer bridge, as today. A rollback is a revert: an earlier
daemon ignores the field `update`, and it keeps the key `update.auto` in `settings.json` without a use (see the
requirement "Content of the settings file" of `settings`).

## Open Questions

- Task 1.1: the result of the measurement of the npx cache.
- Task 6.2: what Air does after the exit of the agent process.

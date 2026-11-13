# Proposal

## Why

Colleagues get Megachat through the npx entry of `acp.json` (issue #40). The next start of `npx` after a release
installs the new release, and its daemon replaces the daemon of the earlier release. But the daemon lives long, and
while it runs, nothing starts `npx` again. So a colleague can stay on an old release for days, and the daemon does not
know about a newer release. The author wants colleagues to get each release without an action, but never during work:
the daemon updates only when no task runs, for example at night.

## What Changes

Where it shows: the output of the command `status`, a fixed message in the chat after an update, the setting
`update.auto` of `agents_settings`, the log of the daemon, and the error output of `acp` in the log of the IDE.

- **The check of a release.** At its start, and then every 24 hours, the daemon runs
  `git ls-remote --tags https://github.com/ignatov/megachat` with the time limits of git of the entry and a hard time
  limit of 30 seconds. It takes the highest tag `v<major>.<minor>.<patch>` and ignores a pre-release. It compares that
  version with its own version. A build of a checkout, such as `0.4.0+9.geb044cf`, compares by its base version
  `0.4.0`. A failed check, for example without the network, writes one line to the log of the daemon and tries again
  after 1 hour. The user gets no message.
- **The status.** When a higher release is available, `status` prints the key `update` after the key `version`, with the
  text "A new release is available: 0.4.0 → 0.5.0".
- **The setting `update.auto`.** A boolean, default `true`. The setting is the approval of the user for the automatic
  stop of the daemon. The rule `children.daemonRestart` for a child stays as it is.
- **The automatic update.** With `update.auto` on, a copy of npx (the daemon runs from a directory
  `_npx/<hash>/node_modules/megachat`) and a higher release, the daemon stops itself when each of these is true:
  - no child task runs or waits for its start;
  - no permission request and no stop request waits;
  - no turn of the main conversation runs, and no input or morning report waits for its turn;
  - with `workday.enabled` on, the conversation sleeps (see the capability `workday`): the time is outside the working
    hours, and the conversation was idle for `workday.idleMinutes`;
  - with `workday.enabled` off, the local time in `workday.timezone` is between 01:00 and 05:00, and the last turn of
    the user ended 30 minutes or more before.

  The daemon checks the conditions every 10 minutes while an update waits. The stop is the same clean stop as the
  command `stop`, so the admitted work and the state stay. The daemon never starts a daemon, `npx` or another copy of
  Megachat.
- **The end of the bridge.** Before the stop, the daemon sends the event `update` on each event stream. Each `acp`
  bridge writes one line to its error output and ends its ACP connection, so its process exits with the code 0. A
  bridge without an attached view also exits within 1 minute after its daemon is gone. A bridge never starts a daemon
  after its own start. So the next start of Megachat goes through `npx` again, and `npx` selects the new tag.
- **No stop in a loop.** When the next daemon after an automatic stop still has the earlier version, for example
  because npx gave the old copy, the daemon does not stop itself again for the same release. It keeps the notice in
  `status`, and it logs the reason.
- **A copy that does not update itself.** A git checkout, the bundle and a copy outside `_npx` never stop themselves.
  With `update.auto` off, a copy of npx also does not. They only show the notice in `status`.
- **The message after the update.** The daemon records its version in the state. When the version is higher than the
  recorded version, the next turn of the user or the next morning report, whichever comes first, starts with a fixed
  message of Megachat in the chat: "Megachat updated from 0.4.0 to 0.5.0.", and the release notes of each release after
  the earlier version. The notes come from the GitHub releases of the repository, with a time limit of 10 seconds.
  Without an answer, the message gives the address of the release instead. A state without a recorded version gets
  the version with no message.

## Capabilities

### New Capabilities

- `update`: the check of a release, the notice in `status`, the conditions and the time of the automatic stop, the
  guard against a stop in a loop, and the message after an update.

### Modified Capabilities

- `settings`: a new requirement for `update.auto`.
- `launch`: the requirement "Version of the daemon in status" gets the key `update`.
- `daemon`: new requirements for the end of a bridge after the stop of its daemon, and for a bridge that never starts
  a daemon after its own start.
- `install`: only when the entry changes after the measurement of the npx cache (task 1.1). The proposal does not
  change it now.

`workday`, `morning-report` and `release` are not modified. The automatic stop reads the decision of the sleep of
`workday`, and the message comes before the turn of the morning report without a change of its data or its prompt.
The release notes stay the GitHub release of `npm run release`.

## ACP and Air

No ACP extension changes. The bridge ends its process with the code 0, which is not an extension.
`docs/air-contract.md` gets a paragraph about the end of the agent process for an update and about what Megachat
expects from Air: Air starts the agent command again at the next attach or prompt, and it loads the persistent session
again. Nobody checked this on a real IDE build (task 6.2). When Air does not start the agent again, the Air side goes
to an IJAI ticket of the author. This change files no ticket.

## Impact

- Code: a new module `src/MegachatUpdate.mjs` (the check, the comparison, the conditions, the timers and the notes),
  `src/main.mjs` (the start of the check in the daemon, the stop, the key `update` of `status`), `src/DaemonServer.mjs`
  (the field `update` of `/health` and the event `update`), `src/AcpBridge.mjs` (the end of the bridge),
  `src/MegachatState.mjs` (the field `update` of the state and the message before a turn), `src/Settings.mjs`
  (`update.auto`), `src/PiMegachatService.mjs` (the conditions of the stop).
- Strings: the notice, the message after an update, the log lines and the description of `update.auto` in
  `resources/Megachat.properties`.
- Tests: a new `test/update.test.mjs`, and cases in `test/settings.test.mjs`, `test/launch.test.mjs` and
  `test/recovery.test.mjs`. The tests use a local bare git repository with tags and a local HTTP server. No test uses
  the network: `test/state-guard.mjs` sets the two variables of the sources to local values.
- Documents: `README.md` ("Update", the commands, the settings, the state), `docs/air-contract.md`,
  `docs/manual-checks.md`.
- The state: a new field `update` in the state document of `conversation.sqlite`. `settings.json` can hold
  `update.auto`.
- Out of scope:
  - An update during work. A newer bridge still replaces the daemon of an earlier release at each time of the day, as
    today (issue #38, risk 4). This change does not change that.
  - The decision of the entry: `#semver:x` with or without `--prefer-online`. It waits for the measurement of the npx
    cache (task 1.1).
  - Release notes in the package, such as a `CHANGELOG.md`. `design.md` gives the reason.
  - A message in the chat about a new release while the update waits, or with `update.auto` off.
  - Linux and Windows (issue #8).
  - No non-goal changes. The non-goal "It does not resume a tool call through a daemon crash" stays: the automatic
    stop comes only when no child task and no turn runs.

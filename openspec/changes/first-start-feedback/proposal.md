# Proposal

## Why

Nobody checked the first start of Megachat on the machine of a colleague (issue #38, roadmap item 1). A stalled network
can make the start wait without end, a start without the network ends with the exit code 128 and no message, and an
IDE build without the Air support gives no sign. Colleagues get the install line after the demo to the Air team, so
each of these risks needs a guard or a message first.

## What Changes

Where it shows: the `env` of the entry `Megachat` in `acp.json`, the output of `install` in the terminal, the error
output of `acp` in the log of the IDE, and the environment of the daemon and its children.

### What Megachat controls, and what it does not

Before the first answer of Megachat, `npx` and git run, and the code of Megachat does not run. So Megachat cannot
print a message, show progress or end a stalled start at that time. It controls only:

- the entry that `install` writes, with its `env`;
- the text of `install` in the terminal;
- what `acp` does after npx started it.

`npx` controls the resolution of `#semver:x` with `git ls-remote`, the retries and the download. The IDE controls the
wait for the first answer, what it shows during the first start, and what it shows when the agent ends with an error.

### The changes

- **A time limit for a stalled transfer.** The entry of a copy without `.git` gets
  `"env": {"GIT_HTTP_LOW_SPEED_LIMIT": "1000", "GIT_HTTP_LOW_SPEED_TIME": "20"}`. git then ends an HTTPS transfer that
  stays below 1000 bytes per second for 20 seconds. A local probe on 2026-11-13 with git 2.50.1: against a server that
  accepts each connection and never answers, `git ls-remote` ended after 5.3 seconds with the time 5 and the exit code
  128, with "Operation too slow" in its error output. Without the variables, the same command did not end in 45
  seconds.
- **This limit does not end each stall.** In the same probe, with a proxy that accepts each connection and never
  answers the request `CONNECT`, `git ls-remote` with the same variables did not end in 45 seconds. `npm view` with
  `fetch-timeout` 5000 and `fetch-retries` 0 through that proxy also did not end in 45 seconds. git has no setting for
  the connect time of HTTPS. So for this case of issue #38, the only reliable guard is a time limit in the IDE. That is
  the Air side, below.
- **No time limit stays in the daemon and the children.** When npx started Megachat, the daemon and each child get
  neither variable with the value of the entry. So a slow `git fetch` of a child task does not end after 20 seconds.
- **The entry of install 0.3.0 gets the new entry.** In a copy without `.git`, `install` replaces the entry that
  `install` 0.3.0 wrote (the same entry without `env`), with a copy of the file first, as it does for the entry of
  0.2.0.
- **Two new lines of `install`.**
  - In a copy without `.git`: each start in the IDE needs the network, because npx asks GitHub for the last release;
    without the network the start fails and the IDE can show no reason; with a proxy that does not answer, the start
    can wait without end; then check the network and the proxy, and open Megachat again.
  - In each copy: `install` cannot check the IDE build. Megachat needs an IDE build with the Air support for Megachat,
    no released build has it yet, and another build can close the session when a window releases it. `install` runs
    in a terminal and finds no IDE, and no build number with the Air support is known. So `install` cannot tell it.
- **A line in the log of the IDE.** When the `initialize` request has no `_meta.jetbrains.air` with the version 1 or
  more, `acp` writes one line to its error output: this client has no Air support for Megachat. The answer to
  `initialize` stays the same.

### The Air side (an IJAI ticket of the author)

No ACP extension changes, so `docs/air-contract.md` does not change. These requests go to Air, because only the IDE can
do them:

- a time limit for the first answer of an agent of the command `npx`, such as 3 minutes, because the first start took
  up to 105 seconds;
- the exit code and the error output of an agent that ends before its first answer, in the chat or in a notification;
- a sign of progress while npx installs an agent.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `install`: the requirement "Entry of a copy without .git" gets the `env`. New requirements give the time limits of
  the entry, the replacement of the entry of `install` 0.3.0, and the lines about the network and the IDE build.
- `launch`: new requirements remove the variables of the entry from the daemon and its children, and give the line of
  a client without the Air support.

## Impact

- Code: `src/MegachatInstall.mjs` (the entry, the replacement, the lines), `src/npmEnvironment.mjs` (the removal of the
  variables), `src/AcpBridge.mjs` (the line of a client without the Air support).
- Strings: `install.network`, `install.air`, `install.replacedEarlier` and `log.noAir` in
  `resources/Megachat.properties`.
- Tests: `test/install.test.mjs`, `test/environment.test.mjs`, `test/recovery.test.mjs`, `test/package.mjs`.
- Documents: `README.md` (the install line, the entry, the start in the IDE, the network), `docs/manual-checks.md` (the
  local probe of 2026-11-13 and the manual checks of the author).
- No field of `conversation.sqlite`, `settings.json` or another state file changes.
- Out of scope:
  - A time limit for a proxy that never answers `CONNECT`, and for a network that drops the packets of the connection.
    Neither git nor npm has a setting for it. It needs the time limit of the IDE.
  - A message of Megachat during or after a failed npx start. The code of Megachat does not run then.
  - A wrapper command around npx, and a variable `NODE_OPTIONS` with a watchdog. `design.md` gives the reasons.
  - `GIT_SSH_COMMAND` with a connect time limit for the SSH fallback of npm. It replaces the `core.sshCommand` of the
    user. `design.md` gives the reasons.
  - An entry from a tarball of a GitHub release instead of `#semver:x`. It is a larger change of `install` and
    `release`.
  - A notice in the chat for a client without the Air support. It needs a decision about the replay.
  - The key `application_workspace` of IJAI-6283, an update during work, two windows at the same time, and a skipped
    optional package (the other risks of issue #38).
  - The version of the installed copy (issue #33, the change `show-build-version`).
  - No non-goal changes.

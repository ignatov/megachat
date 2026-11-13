# Proposal

## Why

Each start of the entry `npx -y github:ignatov/megachat#semver:x acp` asks GitHub for the tags. A walk of the path of a
colleague on 2026-11-14 found this: without the network, npx ended after 0.3 seconds with the exit code 128 and no
output. When only the packets to GitHub were dropped, it ended after 78 seconds. In both cases the daemon still ran,
the conversation was on the disk, and the copy of the release was in the npm cache. But the chat could not reach them.
Air waits for the first answer of an agent with no time limit. Colleagues use Megachat since v0.6.2, so a train, a
plane or a bad proxy stops their chat.

## What Changes

Where it shows: the entry `Megachat` in `acp.json`, the output of `install` in the terminal, a new directory
`launcher/` in the state directory, and the error output of the agent in the log of the IDE. The chat does not change.

- **A launcher in the state directory.** `install` writes `launcher/start.mjs`, a small Node.js script with only
  `node:` imports. The entry of a copy without `.git` starts it through npx:
  `{"command":"npx","args":["--call","\"$NODE\" '<state directory>/launcher/start.mjs'"],"env":{...}}`. The command
  stays `npx`, so Air still gives the agent its own Node.js, its npm cache and its variables. `npx --call` with no
  package installs nothing and asks no server.
- **The record of the installed release.** At each start, the daemon of a copy of npx writes the directory of its copy
  to `launcher/copy.json`. It also writes `launcher/start.mjs` again when the text differs, so a release can correct
  the launcher.
- **The check of GitHub with a time limit.** The launcher runs `git ls-remote --tags --refs` on the repository, with the
  `env` of the entry and a hard time limit of 10 seconds. Then:
  - GitHub answers, and the recorded copy has the highest release tag or a higher version: the launcher starts
    `bin/megachat.mjs acp` of that copy directly. npx does not run a second time.
  - GitHub answers, and the record is missing, older or broken: the launcher runs
    `npx -y github:ignatov/megachat#semver:x acp`, as the entry does today. So the next start after a release
    installs the new release, as today.
  - GitHub does not answer in 10 seconds, or git fails: the launcher starts the recorded copy and writes one line to
    its error output. Without a record, it writes one line and exits with the code 1.
- **The user sees this.** Online, the chat opens as today. Offline, the chat opens with the installed release, after
  at most 10 seconds plus the start of the copy. The conversation and the running daemon are the same. The error output
  of the agent in the log of the IDE gets one line, such as "Megachat could not reach GitHub, so it started the
  installed release 0.6.3." A first start without the network and without an installed release still fails, but the
  log of the IDE gets a line with the reason. A usual start with the network gets shorter than today, because npx
  runs only when a new release is available (`design.md`, decision 3).
- **The entry of existing colleagues.** No process of Megachat changes `acp.json` except `install`. The entry of
  `install` 0.5.0 and later (the npx entry with the time limits of git) gets the same replacement as the entry of 0.3.0
  and 0.4.0: `install` copies the file to `acp.json.before-megachat-<UTC time>`, keeps the place of the entry, and
  prints the earlier entry. A colleague gets the new entry when they run the setup line or the install line again. An
  earlier entry still works online, as today.
- **The line about the network of `install`** changes: each start asks GitHub for the last release, and without an
  answer in 10 seconds the IDE starts the installed release. Only a first start needs the network.

## Capabilities

### New Capabilities

- `launcher`: the launcher of the IDE entry. It checks GitHub with a time limit, starts the recorded copy or npx, and
  writes one line without GitHub. The daemon records its copy for it.

### Modified Capabilities

- `install`: "Entry of a copy without .git" gets the launcher entry. "Line about the network" gets the new text. New
  requirements: the write of the launcher, and the replacement of the npx entry with the time limits.
- `state-directory`: "Content of the state directory" gets the directory `launcher/`.

## ACP and Air

No ACP extension changes. The entry keeps the name `Megachat` and the command `npx`. `docs/air-contract.md`, part "The
end of the agent for an update", names the command of the entry, so its text changes. Air needs no change for this
proposal.

Out of scope, for a later IJAI ticket of the author: a time limit for the first answer of an agent in Air, and a
progress state while the agent process starts. The first start of a release still takes 40 to 112 seconds, and the
window shows nothing then.

## Impact

- Code: a new module `src/MegachatLauncher.mjs` (the text of the launcher, its write, and the record of the copy),
  `src/MegachatInstall.mjs` (the entry, the write of the launcher, the replacement, the line about the network),
  `src/main.mjs` (the record at the start of the daemon).
- Strings: the two lines of the launcher, the line about the network and the line of the replacement in
  `resources/Megachat.properties`.
- Tests: a new `test/launcher.test.mjs`, cases in `test/install.test.mjs` and `test/home.test.mjs`, and the start of
  the entry in `test/package.mjs`.
- Documents: `README.md` (the entry, "The start, the update and the removal", the state directory),
  `docs/air-contract.md`, `docs/manual-checks.md`.
- The state: a new directory `launcher/` with `start.mjs` and `copy.json`. No field of `conversation.sqlite` or
  `settings.json` changes. An older state directory gets the directory at the next `install` or at the next start of a
  daemon of a copy of npx.
- Out of scope:
  - The Air side above.
  - A message in the chat about a start without GitHub. The line goes only to the log of the IDE.
  - A change of `acp.json` by the daemon or by the chat. An offer in the chat to run the install line again.
  - A fallback after a failed npx run when GitHub answered, such as a failed download of a dependency from the npm
    registry. The launcher cannot tell it from a Megachat that started and then ended.
  - A start of the IDE from the copy of the terminal (`~/.npm`). `install` records no copy. `design.md`, open
    questions, gives the reason.
  - Linux and Windows (issue #8).
  - No non-goal changes.

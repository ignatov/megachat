# Proposal

## Why

A colleague runs Megachat through the npx entry of `acp.json` with `update.auto` on. Her main agent said "you have the
last version, 0.10.0" while 0.11.0 and 0.12.0 were out. It could not start an update, because it had no tool for it, and
it told her to run npx with `@latest`, which is wrong for the spec `github:ignatov/megachat#semver:x`.

Three causes are in the code:

- The daemon checks 60 seconds after its start and then every 24 hours. A timer of Node.js counts the time that the
  computer is awake, so on a laptop the next check came days late. The daemon also gave the result only in `status` and in
  `/health`. The main agent could not read it, and nothing checked on demand.
- No tool updates Megachat on a request of the user.
- No text tells the main agent what the update of Megachat is.

A copy of npx may also reuse an old `_npx/<hash>` directory. A measurement with npm 11.19.0 (see
`docs/manual-checks.md`) shows that npx installs the new tag, but a colleague needed `rm -rf ~/.npm/_npx` once, so the
stop for an update now removes that risk.

The author also decided that the automatic update is on for each user, one time.

## What Changes

Where it shows: the chat (the tool `agents_update` and its texts), `settings.json`, and the daemon log.

- **Tool `agents_update`.** `action=check` asks the repository now and returns the version, the highest release, the kind
  of copy, the time of the check and the failure code. `action=apply` checks, and stops the daemon for the update. Only a
  turn of the user can apply: an automatic turn gets the error `updateEvent`. The daemon stops after the current turn
  ends, when no child task, permission request, stop request or waiting message exists. With work that runs, the result
  names the work and does not stop. With `whenIdle`, the daemon stops right after that work. A git checkout and a copy
  that is not of npx do not stop: the result says what the user does (`git pull`, then `node src/main.mjs stop`).
- **Instructions of the main agent.** The settings section tells the agent to call `agents_update` when the user asks
  to update or asks for the last release, and not to answer from the version that it knows. The texts name no
  `@latest`.
- **Check without a stale timer.** The timer of a check ends at least each hour and compares the wall clock with the due
  time, so a sleep of the computer does not delay a check.
- **A fresh npx start.** After the stop for an update, the daemon moves the directory `_npx/<hash>` of its own copy to
  `<hash>.megachat-old-<time>`, so npx cannot reuse it. The next daemon removes such directories of its own entry. No
  other directory of `_npx` and no other cache changes.
- **`update.auto` is on by default.** A new file gets `true`. One time, a file from an earlier build gets `true`, also
  when it stores `false`. `settings.json` then has `migrations.updateAuto`. A later `false` of the user stays. The note
  after the next update tells once that the automatic update is on and how to turn it off.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `update`: new requirements for the check on demand, the timer, the request of the user and the move of the copy (the
  capability comes with the change `automatic-update`).
- `settings`: a new requirement for the one-time start of `update.auto`.

The change `automatic-update` holds the default of `update.auto`, and it now says `true`. No ACP extension changes, so
`docs/air-contract.md` needs no change in Air. It only gets the text of the update.

## Out of scope

- A forced stop with work that runs. The user waits, or asks for `whenIdle`.
- A `git pull` of a checkout by Megachat.
- A start of a daemon, `npx` or `npm` by the daemon.
- The change `notify-new-release` stays as it is. It applies to a user who set `update.auto` to `false`.

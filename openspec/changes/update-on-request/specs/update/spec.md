# Spec Delta

## ADDED Requirements

### Requirement: Check on demand
The main agent MUST be able to ask for a check with the tool `agents_update` and `action` `check`. The check MUST ask the repository at once, also in an automatic turn. The result MUST have the version, the highest release, `available`, the kind of copy, the time of the check and `error` after a failed check.

Tests: `test/update.test.mjs`

#### Scenario: A release before the timer
- **WHEN** a daemon of `0.4.0` found `0.4.0`, and the repository then gets `0.5.0`
- **THEN** a check on demand gives `latest` `0.5.0` and `available` `0.5.0`, and a failed check gives the code `timeout`

### Requirement: Timer of the check
A timer of the check MUST end at least each hour and MUST compare the wall clock with the due time of the check. A check that is due MUST run at that tick, also after a sleep of the computer.

Tests: `test/update.test.mjs`

#### Scenario: A sleep of 30 hours
- **WHEN** the first check found `0.4.0`, the computer sleeps 30 hours, and the repository has `0.5.0`
- **THEN** the next tick runs the check and finds `0.5.0`

### Requirement: Update on request
The tool `agents_update` with `action` `apply` MUST check, and for a copy of npx MUST stop the daemon for a higher release when no work runs. The turn of the request MUST NOT count as work: the stop MUST come after that turn. It MUST need neither `update.auto` nor the night window. With work that runs, it MUST give the reason `busy` and the work, and MUST NOT stop. With `whenIdle` true, the daemon MUST stop right after that work.

Tests: `test/update.test.mjs`

#### Scenario: Turn and child
- **WHEN** `update.auto` is `false`, the turn of the request runs, and the repository has `0.5.0`
- **THEN** the apply is accepted, the daemon does not stop while the turn runs, and it stops 2 seconds after the turn ends

#### Scenario: A child runs
- **WHEN** a Claude child runs, and the agent applies, then applies with `whenIdle`
- **THEN** the first answer is `busy` with the kind `child`, and the daemon stops 2 seconds after the child ends

### Requirement: Request from an event
An automatic turn, such as a child result, the summary of the past sessions or the morning report, MUST NOT apply an update. `agents_update` with `action` `apply` MUST fail there with the code `updateEvent`.

Tests: `test/update.test.mjs`

#### Scenario: Three automatic turns
- **WHEN** the turn has the kind `report`, `event` or `morning`
- **THEN** `apply` fails with `updateEvent`

### Requirement: Copy that cannot update itself
For a git checkout or another copy that is not of npx, `apply` MUST NOT stop the daemon. The result MUST say that the copy does not update itself, and MUST give the steps: `git pull` and `node src/main.mjs stop` for a checkout. Megachat MUST NOT run `git pull`. The texts for the main agent and the user MUST NOT tell them to run npx with `@latest`.

Tests: `test/update.test.mjs`

#### Scenario: A checkout
- **WHEN** the daemon runs in a git checkout, the repository has `0.5.0`, and the agent applies
- **THEN** the reason is `checkout`, the instruction names `git pull` and `node src/main.mjs stop`, and no stop happens

#### Scenario: No newer release
- **WHEN** the highest release is `0.4.0`, or the check fails
- **THEN** the reason is `current` or `checkFailed`, and no stop happens

### Requirement: Fresh start of npx
After the stop for an update, the daemon MUST move the directory `_npx/<hash>` of its own copy to `<hash>.megachat-old-<time>`, only when its `package.json` has the name `megachat`. It MUST NOT change another directory. A later daemon MUST remove only the directories `<hash>.megachat-old-<digits>` of its own entry.

Tests: `test/update.test.mjs`

#### Scenario: One entry
- **WHEN** `_npx` has `0123abcd` (the copy), `other` and `9999.megachat-old-1000`, and the daemon of `0123abcd` stops for an update
- **THEN** `0123abcd` is `0123abcd.megachat-old-<time>`, and `other` and `9999.megachat-old-1000` stay

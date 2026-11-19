# Design

## Context

See proposal.md, "Why", for the request. The present state, from the code:

- `install()` of `src/MegachatInstall.mjs` writes the entry through `writeEntry()`. `acpConfigPath()` gives the file of
  `MEGACHAT_ACP_CONFIG`, else `~/.jetbrains/acp.json`. `earlierEntry()` and `entryWithoutTimeLimits()` recognize the
  entries of `install` 0.2.0, 0.3.0 and 0.4.0. `RELEASE_ENTRY` is the npx entry of the last release.
- `src/main.mjs` dispatches the commands. `stop` sends `/shutdown` to the daemon of the state directory and does not
  wait. `stopOtherBuild()` sends `/shutdown` and waits up to 30 seconds (300 times 100 ms) until the process ID of
  `/health` is gone. The launcher `bin/megachat.mjs` imports `src/main.mjs` and needs no change.
- The shutdown of the daemon closes the server, the child services and the state, and `DaemonDirectory.close()`
  removes `daemon/connection.json`. A child run that the stop interrupts gets `plannedStop`, and the next daemon
  continues it (see the capability `run-recovery`). Each `acp` bridge ends when its daemon is gone (`onGone`).

What keeps the daemon alive:

- `spawnDaemon()` starts the daemon with `detached: true` and `child.unref()`. The daemon does not depend on the `acp`
  bridge that started it, and no code stops it when the last client disconnects. No idle time ends it.
- Only these stop it: the command `stop`, `/shutdown` from a client of another build, `SIGTERM` or `SIGINT`, a storage
  error, a log-out or a restart of the computer, and the automatic update. The automatic update stops only a copy of
  npx with `update.auto` on, when a higher release exists and the work and the time allow it.
- While it runs without a client, these continue: each child run and its continuations, the keep-alive requests of
  the prompt cache up to `keepAlive.hours` (6 hours) after the last turn, the summary of an idle context, the turns of
  child results, the morning report when `report.morning` is on, and the check of a release every 24 hours. The
  keep-alive requests, the summary and the automatic turns cost money.
- Megachat has no login service. After a restart of the computer, the daemon starts again only when a client opens
  Megachat.

What the switch of Air does, from the knowledge of the Air side (not checked in this change): the Agents page of the
settings has an on/off switch for each local agent of `acp.json`. A disabled Megachat has no row in the session list,
so Air starts no new `acp` process for it. The switch does not change `acp.json`. The daemon is a separate process,
so the switch does not stop it, and the work above continues. After the next automatic update or a restart of the
computer, no daemon starts while the switch is off.

## Goals / Non-Goals

**Goals:**

- One command removes what `install` added to `acp.json` and ends each process of Megachat, with no loss of state.
- The install line brings Megachat back, with the same conversation, memory and settings.
- The command never removes what it did not write, and never ends work that runs.

**Non-Goals:**

- A deletion of the state directory, of the npm copies, or of the backups of `acp.json`.
- A change of Air.

## Decisions

### 1. A command of the launcher, not a script

`uninstall` is a case of `src/main.mjs` next to `install`, and its code is in `src/MegachatInstall.mjs`, which holds
the knowledge of the entries. So `uninstall` and `install` share `acpConfigPath()`, the entry recognizers and the
backup rule. A separate shell script would need its own JSON code and its own tests.

The user runs it as `npx -y "github:ignatov/megachat#semver:x" uninstall`. That line needs the network, because npx
asks GitHub for the last release, as for `install`. Without the network, `README.md` gives the direct line
`node <copy>/bin/megachat.mjs uninstall` with the copy that `install` named in its last line.

### 2. Which entry is ours

`uninstall` removes the entry when one of these accepts it: equal to `RELEASE_ENTRY`, `entryWithoutTimeLimits()`,
`earlierEntry()`, or a new `checkoutEntry()`: only the keys `command` and `args`, a command whose base name is `node`
or `node.exe`, and two arguments, a path that ends with `bin/megachat.mjs` and `acp`. A checkout entry of another
directory counts too: `install` of any checkout writes this shape, and the user who runs `uninstall` from the npx copy
wants the entry of the checkout gone. An entry with another key, such as `application_session` or an `env` of the
user, is not ours. This follows the requirement "Different entry" of the capability `install`: no option replaces or
removes such an entry, and the user edits the file.

Alternative: remove each entry with the name `Megachat`. Refused, because the name alone does not tell that Megachat
wrote it, and the user can have a custom `env` in it.

### 3. The write of acp.json

A new `removeEntry(path, now, ours)` mirrors `writeEntry()`. It gives `absent`, `removed`, `different` or
`unreadable`. Only `removed` writes. It copies the file to `<path>.before-megachat-<UTC time>` with `COPYFILE_EXCL`
and the mode of the file, deletes the key from `agent_servers` and writes the JSON with two spaces and a final new
line, as `install` does. A plain object keeps the order of the other keys. `writeFile` on an existing file keeps its
mode. The file stays, also with an empty `agent_servers`: the IDE and `setup.sh` accept it, and `install` then adds
the entry again. The backup name is the name of `install`, because the backup holds the file before Megachat changed
it.

### 4. Work that runs: refuse, do not stop

Before it writes, `uninstall` connects to the daemon of the state directory (`DaemonClient.connect()` and `/health`,
with a time limit of 2 seconds). When a daemon answers, `uninstall` reads `/state`. Work is `current` (a turn) and each
run whose status is not in `terminalStates`. With work, `uninstall` refuses, changes nothing and exits with 1. The command
`status` reads the same `/health` and `/state`, so the check also works for a daemon of an earlier build.

Alternatives:

- Stop the work, as `stop` does. Refused as the default. The stop interrupts the runs, and the next daemon continues
  them. After `uninstall`, the next daemon starts only after an `install`, maybe weeks later, and then old tasks start
  again in old checkouts. That is a surprise.
- An option `--now` that stops anyway. Left out: the user can stop the runs in the chat, or run `stop` and then
  `uninstall`. This is an open decision of the author (see "Open Questions").

The check and the stop are not atomic. A turn that starts between them is admitted work, and the daemon keeps it
through the stop as `stop` does: the inbox and the run are in `conversation.sqlite`, and the next daemon continues
them. This window is less than one second.

### 5. Order: refuse first, then remove, then stop

1. Read `acp.json`. A different entry or an unreadable file ends the command with 1 before the daemon check. The
   daemon continues to run, because the user did not get the removal.
2. Check the daemon for work. With work, end with 1. `acp.json` is unchanged.
3. Remove the entry.
4. Send `/shutdown`, and wait until the process ID of `/health` is gone, at most 30 seconds. The wait is the loop of
   `stopOtherBuild()`, moved to a shared function with the time limit as an argument, so a test can use 1 second.

The removal comes before the stop. An IDE can start `acp` again while the entry is still in the file, and that start
starts a new daemon. With the entry gone first, a new start finds no entry, when the IDE reads the file again.

Without a running daemon, step 2 and step 4 do nothing, and `uninstall` opens no file of the state directory.
`connection.json` of a daemon that is gone gives no answer, so it counts as no daemon. `uninstall` never calls
`start()`, so it starts no daemon.

### 6. The state stays, and no option deletes it

`uninstall` writes no file of the state directory. Only the daemon writes there, in its own shutdown. The output
names the path of the state directory and says that the user can delete it. There is no `--purge`: a deletion of the
conversation and the memory cannot be undone, the project rule forbids a recursive delete by an agent, and a user who
wants it can move the directory to the Trash. This is an open decision of the author too.

### 7. The main agent does not remove Megachat

The main agent has no shell tool, and the removal is not a tool. A child agent has a shell and could run the line. The
rule `instructions.uninstall` in the settings section of the rules of the main agent, next to `instructions.update`,
tells it: give the line, tell about the switch of Air and the state that stays, and start no child task for it. The
reasons: the stop ends the daemon that runs the turn, so the reply would end in the middle; the change is of a file of
the IDE, which the user owns; and the switch of Air is often what the user wants.

Alternative: a tool `agents_uninstall` with the permission dialog, as `agents_stop`. Refused: a stop of the daemon
from inside its own turn needs the logic of `agents_update` with `whenIdle`, and it gives the user no new power.

### 8. The texts

Each text is a key in `resources/Megachat.properties`:

- `uninstall.removed`: "Megachat removed the entry Megachat from {0}. The earlier file is in {1}."
- `uninstall.absent`: "{0} has no entry Megachat."
- `uninstall.notInstalled`: "Megachat is not installed: {0} has no entry Megachat, and no daemon runs."
- `uninstall.different`: "{0} holds another entry Megachat, so Megachat did not change the file. Remove the entry
  Megachat by hand, then run the command stop. The entry:"
- `uninstall.unreadable`: "Megachat cannot read {0} as JSON, so it did not change the file. Remove the entry Megachat
  from \"agent_servers\" by hand, then run the command stop."
- `uninstall.busy`: "Megachat did not change {0}, because work runs. Wait until it ends, or stop it in the chat, then
  run the uninstall again:"
- `uninstall.busyTurn`: "- A turn of the main agent runs."
- `uninstall.busyRun`: "- The child run {0} of {1} is {2}: {3}"
- `uninstall.stopped`: "Megachat stopped its daemon (process {0})."
- `uninstall.stopTimeout`: "The Megachat daemon did not stop in {1} seconds (process {0}). Run the command stop, then
  run the uninstall again."
- `uninstall.state`: "The state directory {0} stays, with the conversation, the memory and the settings. The install
  line brings Megachat back as it was: npx -y \"github:ignatov/megachat#semver:x\" install. To delete all of it,
  delete the directory yourself."
- `uninstall.failed`: "The uninstall did not finish, so it exits with the code 1. Read the lines above."
- `uninstall.switch`: "To hide Megachat without a removal, turn off Megachat on the Agents page of the Air settings.
  Then the daemon continues to run, with its tasks, its keep-alive requests and its timers, until the command stop."
- `uninstall.release`: "This uninstall ran Megachat {1} from {0}."
- `uninstall.crashed`: "The uninstall stopped with an error: {0} Remove the entry Megachat from acp.json by hand, then
  run the command stop."
- `instructions.uninstall`: the rule of decision 7, with the line of `uninstall` and "Agents page".

The order of the lines: the result of `acp.json`, the lines of work or of the stop, the state line, the closing line
of a failure, the switch line, and the last line.

### 9. State files, ACP messages and `_meta` keys

`uninstall` reads `acp.json` and `daemon/connection.json` of the state directory. It reads `pid` of `/health`, and
`current` and `runs` (`id`, `agent`, `status`, `title`) of `/state`. It adds no field to `conversation.sqlite`,
`settings.json` or another state file, so an older state directory needs nothing. It adds and reads no ACP message
and no `_meta` key. No ACP extension changes, so Air needs no change.

### 10. Admitted work through a disconnect and a restart

`uninstall` refuses while work runs, so it interrupts no run. Admitted work that the check did not see (decision 4)
stays in the state through the stop. The next daemon, after `install` and the next open in the IDE, continues it as
after `stop` (see the capability `run-recovery`).

## Risks / Trade-offs

- [An IDE window still shows Megachat and starts `acp` again, which starts a new daemon] → The entry goes first. It is
  not known whether Air reads `acp.json` again before a new start. `README.md` tells the user to close the Megachat
  sessions first, and a manual check in `docs/manual-checks.md` records what Air does.
- [A run that waits for a permission blocks `uninstall` without end] → The refusal names the run, and the user cancels
  it in the chat, or runs `stop` and then `uninstall`.
- [The line through npx needs the network and downloads the last release] → `README.md` gives the direct line of the
  copy.
- [The state stays on the disk and holds the conversation] → The output and `README.md` give the path, and the user
  deletes it. The state has the modes 0700 and 0600.
- [A daemon of the legacy directory runs] → Out of scope. `uninstall` looks only at the shared state directory.

## Migration Plan

No migration. A machine without the entry is a valid state for `install`. Rollback: the install line.

## Open Questions

Each is a decision of the author. The proposal takes the first option.

1. Work that runs: refuse (proposed), or also an option `--now` that stops the work as `stop` does.
2. The state: print the path and let the user delete it (proposed), or an option `--purge` that moves the directory to
   `/tmp` or deletes it.
3. The request in the chat: the agent gives the line (proposed), or a tool with a dialog of the user.

# Proposal

## Why

On 2026-11-18 a colleague of the author asked: "надо иметь возможность убрать мегачат и вернуть его
снова" (it must be possible to remove Megachat and bring it back again). The author agreed on 2026-11-18 and asked for
this proposal on 2026-11-19.

Today `install` adds the entry `Megachat` to `~/.jetbrains/acp.json`, but no command removes it. The paragraph
"Removal" of `README.md` tells the user to edit `acp.json` and to delete the copies in the npm caches. It does not
tell the user that the daemon continues to run after the entry is gone. The daemon is a detached process that does
not depend on a client. Nothing stops it when no client connects. So after a removal by hand, a child run, the
keep-alive requests of the prompt cache, the automatic turns of child results, the morning report and the check of a
release continue, and they can cost money.

The switch of Megachat on the Agents page of the Air settings hides Megachat: a disabled Megachat has no row in the
session list. The switch does not remove the entry, and it does not stop the daemon either. Air has no removal of an
`acp.json` entry.

## What Changes

Where it shows: a command in the terminal (`uninstall`), its output, the chat (the reply of the main agent to a
request such as "remove yourself"), and `README.md`. No ACP extension changes, so Air needs no change.

- **The command `uninstall`.** The same launcher as `install` gets the command `uninstall`:
  `npx -y "github:ignatov/megachat#semver:x" uninstall`, or `node src/main.mjs uninstall` in a checkout. It removes
  the entry `Megachat` from `agent_servers` of `acp.json` (the path of `install`, which `MEGACHAT_ACP_CONFIG` can
  replace), and then it stops the daemon of the state directory as the command `stop` does. It starts no daemon.
- **Only an entry of Megachat.** `uninstall` removes only an entry that an `install` of Megachat wrote: the npx entry
  of the last release, the npx entry of `install` 0.3.0 and 0.4.0, the entry of `install` 0.2.0, and the entry of a
  git checkout. Before the removal, it copies the file to `acp.json.before-megachat-<UTC time>`. It keeps each other
  key, the key order, the mode of the file and the file itself, also when `agent_servers` becomes empty. Another entry
  `Megachat`, or a file that is not a JSON object, stays unchanged: `uninstall` prints the entry, tells the user to
  remove it by hand, and exits with 1. The daemon then continues to run.
- **No stop of work that runs.** When the daemon runs a turn, or a child run is not in a final state, `uninstall`
  changes nothing. It lists the runs, tells the user to wait or to stop them in the chat, and exits with 1.
- **The state stays.** `uninstall` deletes and changes no file of the state directory: the conversation, the memory,
  the settings, the session index and the transcripts stay. It prints the path of the state directory and says that
  the install line brings Megachat back as it was, and that the user can delete the directory to delete all of it.
  There is no option to delete the state.
- **A second run.** Without the entry and without a running daemon, `uninstall` says that Megachat is not installed,
  changes nothing and exits with 0.
- **The lighter way.** Before its last line, `uninstall` prints that the switch on the Agents page of Air hides
  Megachat without a removal, and that the daemon then continues to run, with its tasks, its keep-alive requests and
  its timers, until the command `stop`.
- **Last lines and exit code.** The last line gives the version and the directory of the copy, as `install` does. The
  exit code is 0 only when the entry is not in `acp.json` and no daemon runs.
- **A request in the chat.** The main agent does not remove Megachat. When the user asks for it, the agent gives the
  line of `uninstall` and tells about the switch of Air. It does not delegate the removal to a child.
- **README.md.** The paragraph "Removal" describes `uninstall`, the switch of Air, the state that stays, the return
  with the install line, and the copies in the npm caches. The table "Commands" gets `uninstall`.

## Capabilities

### New Capabilities

- `uninstall`: the command `uninstall`, which removes the entry of Megachat, stops the daemon and keeps the state, and
  the reply of the main agent to a request to remove Megachat.

### Modified Capabilities

None. The requirements of `install` stay as they are: `install` after `uninstall` finds a file without the entry
(see the requirement "Write of acp.json" of the capability `install`), and the daemon of the next start opens the
state that `uninstall` kept.

## Out of scope

- A deletion of the state directory by Megachat, or an option such as `--purge` for it.
- A removal of the copies of Megachat in the npm cache of the IDE and in `~/.npm`. `README.md` tells where they are.
- A removal of the files `acp.json.before-megachat-<UTC time>`.
- A stop of work that runs, or an option to force it. The user waits, or stops the runs in the chat.
- A removal of an entry by Air, or a change of the switch of Air.
- A stop of the daemon when Megachat is disabled in Air. The daemon continues to run, as before.
- The legacy state directory `~/Library/Application Support/JetBrains/AirMegachat` and a daemon that owns it.
- No change of `setup.sh`.
- The change touches no non-goal. Megachat still installs no login service.

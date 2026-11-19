# Spec Delta

## Purpose

The command `uninstall` removes the entry of Megachat from `acp.json` of the IDE and stops the daemon. It keeps the
state directory, so the install line brings Megachat back as it was.

## ADDED Requirements

### Requirement: Command uninstall
The launcher MUST have the command `uninstall`, also through npx: `npx -y "github:ignatov/megachat#semver:x" uninstall`. It MUST remove the entry `Megachat` from `agent_servers` of the `acp.json` of `install` (see the capability `install`), and then stop the daemon of the state directory. It MUST NOT start a daemon. `MEGACHAT_HOME` or the directory argument selects the state directory.

Tests: `test/uninstall.test.mjs`, `test/package.mjs`

#### Scenario: Uninstall after install
- **WHEN** `install` wrote the npx entry into a temporary `acp.json` in a copy without `.git`, a daemon of a temporary state directory runs, and the user runs `uninstall`
- **THEN** `agent_servers` has no entry `Megachat`, the process of the daemon ends, no new daemon starts, and the exit code is 0

#### Scenario: The packed copy
- **WHEN** npm installed the tarball of Megachat, and `install` of the installed copy wrote the entry into a temporary `acp.json`
- **THEN** `uninstall` of the installed copy removes the entry and exits with the code 0

### Requirement: Entries that uninstall removes
`uninstall` MUST remove only an entry `Megachat` that an `install` of Megachat wrote: the npx entry with its `env`, the npx entry of `install` 0.3.0 and 0.4.0, the entry of `install` 0.2.0, and the entry of a git checkout. The entry of a git checkout MUST have only the keys `command` and `args`: a `node` command, and the arguments `<directory>/bin/megachat.mjs` and `acp`.

Tests: `test/uninstall.test.mjs`

#### Scenario: Each entry of install
- **WHEN** `agent_servers` has the entries `First`, `Megachat` and `Last`, and `Megachat` is the npx entry with its `env`, the npx entry without the `env`, or the entry that starts `/Users/me/.npm/_npx/ad3589aca26e8aac/node_modules/megachat/bin/megachat.mjs acp` with `/opt/homebrew/bin/node`
- **THEN** `uninstall` removes `Megachat`, and `First` and `Last` stay in this order

#### Scenario: The entry of a checkout
- **WHEN** the entry `Megachat` starts `/opt/megachat/bin/megachat.mjs acp` with `/usr/local/bin/node`, and `uninstall` runs from another directory
- **THEN** `uninstall` removes the entry

### Requirement: Write of acp.json at the removal
Before the removal, `uninstall` MUST copy the file to `acp.json.before-megachat-<UTC time>` with the mode of the file. It MUST keep each other key, the key order and the mode of the file. When `agent_servers` becomes empty, the file MUST keep `agent_servers` as an empty object. `uninstall` MUST NOT delete `acp.json`.

Tests: `test/uninstall.test.mjs`

#### Scenario: A file with other keys
- **WHEN** `acp.json` has the mode 0640 and the keys `default_mcp_settings`, `agent_servers` with the entries `Other` and `Megachat`, and `z`, and `uninstall` runs at 2026-11-19T09:08:07Z
- **THEN** the file `acp.json.before-megachat-20261119T090807Z` holds the earlier text, and `acp.json` keeps its keys in the same order, `agent_servers` has only `Other`, and the mode stays 0640

#### Scenario: The only entry
- **WHEN** `acp.json` holds only the entry `Megachat`
- **THEN** `acp.json` stays, and its JSON is `{"agent_servers":{}}`

### Requirement: Entry of another program
Another entry `Megachat`, or a file that is not a JSON object, MUST stay unchanged. `uninstall` MUST then print the entry, tell the user to remove it by hand, stop no daemon, and exit with 1. There is no option to remove such an entry.

Tests: `test/uninstall.test.mjs`

#### Scenario: An entry with an application_session key
- **WHEN** the entry `Megachat` of `acp.json` has `application_session` set to `true`, and a daemon runs
- **THEN** `acp.json` stays unchanged, `uninstall` prints the entry and tells the user to remove the entry Megachat by hand, the daemon still answers `/health`, and the exit code is 1

#### Scenario: An npx entry with an env of the user
- **WHEN** the entry `Megachat` starts `npx` with the arguments of the install line, and its `env` has `HTTPS_PROXY`
- **THEN** `acp.json` stays unchanged, and the exit code is 1

#### Scenario: A file that is not JSON
- **WHEN** `acp.json` holds `{ "agent_servers": `
- **THEN** the file stays unchanged, and the exit code is 1

### Requirement: Work that runs
When the daemon runs a turn, or a child run is not `completed`, `cancelled`, `interrupted`, `failed` or `resumed`, `uninstall` MUST change no file and stop no daemon. It MUST print one line for the turn and one line for each such run with its ID, agent, status and title. It MUST tell the user to wait for the runs or to stop them in the chat, and exit with 1. There is no option to stop the work.

Tests: `test/uninstall.test.mjs`

#### Scenario: A child run that runs
- **WHEN** a child run with the title "Fix the build" has the status `running`, and the user runs `uninstall`
- **THEN** `uninstall` prints a line with the ID of the run, `claude`, `running` and "Fix the build", `acp.json` stays unchanged, the daemon still answers `/health`, and the exit code is 1

#### Scenario: The same run after its end
- **WHEN** that run becomes `completed`, and the user runs `uninstall` again
- **THEN** `uninstall` removes the entry, stops the daemon, and exits with the code 0

### Requirement: Stop of the daemon at uninstall
After the removal, or without an entry, `uninstall` MUST stop a running daemon of the state directory as the command `stop` does, also a daemon of another build. It MUST wait until the process of the daemon ends, at most 30 seconds. After that time, it MUST print a line and exit with 1. Without a running daemon, it MUST NOT open the state.

Tests: `test/uninstall.test.mjs`

#### Scenario: A daemon without an entry
- **WHEN** `acp.json` has no entry `Megachat`, and a daemon of the state directory runs
- **THEN** `uninstall` prints "has no entry Megachat" and "Megachat stopped its daemon", the process of the daemon ends, and the exit code is 0

#### Scenario: A daemon that does not end
- **WHEN** the daemon answers `/shutdown`, its process does not end, and the time limit of the test is 1 second
- **THEN** `uninstall` prints "The Megachat daemon did not stop" with its process ID, and the exit code is 1

### Requirement: State after uninstall
`uninstall` MUST NOT delete a file of the state directory or write to it. The stop of the daemon keeps the state as the command `stop` does. `uninstall` MUST print the path of the state directory, that the install line brings Megachat back with the conversation, the memory and the settings, and that the user can delete the directory to delete all of it. It MUST have no option that deletes the state.

Tests: `test/uninstall.test.mjs`

#### Scenario: Uninstall and install again
- **WHEN** the conversation has the message "Remember the word kiwi", `memory.md` and `settings.json` exist, and the user runs `uninstall`, then `install`, then `start`
- **THEN** the conversation of the new daemon has "Remember the word kiwi", and `memory.md` and `settings.json` have the same content as before

#### Scenario: The lines about the state
- **WHEN** `uninstall` removes the entry
- **THEN** it prints "The state directory" with its path and "stays", and the install line

### Requirement: Nothing to uninstall
Without the entry `Megachat` and without a running daemon, `uninstall` MUST print that Megachat is not installed, with the path of `acp.json`, change nothing, and exit with 0. Without `acp.json`, it MUST make no file and no directory.

Tests: `test/uninstall.test.mjs`

#### Scenario: A second uninstall
- **WHEN** `uninstall` ran with the code 0, and the user runs it again
- **THEN** `acp.json` stays unchanged, `uninstall` prints "Megachat is not installed:" with the path, and the exit code is 0

#### Scenario: No acp.json
- **WHEN** the directory `jetbrains` and its `acp.json` do not exist
- **THEN** `uninstall` makes neither, and the exit code is 0

### Requirement: Line about the switch of Air
Before its last line, `uninstall` MUST print a line: the switch of Megachat on the Agents page of the Air settings hides Megachat without a removal, and the daemon then continues to run, with its tasks, its keep-alive requests and its timers, until the command `stop`. The line MUST NOT change the exit code.

Tests: `test/uninstall.test.mjs`

#### Scenario: Each run
- **WHEN** `uninstall` removes the entry, and then runs a second time
- **THEN** each output has "the Agents page of the Air settings" and "the daemon continues to run" directly before the last line

### Requirement: Last lines and exit code of uninstall
The last line of `uninstall` MUST give the version of the build (see the capability `launch`) and the directory of the copy. The exit code MUST be 0 only when `acp.json` holds no entry `Megachat` and no daemon of the state directory runs. An exit code 1 MUST follow a closing line that names the reason.

Tests: `test/uninstall.test.mjs`

#### Scenario: A removal in a checkout
- **WHEN** `uninstall` runs in a temporary git repository with the version `0.3.0`, the tag `v0.3.0` and two commits after it, and it removes the entry
- **THEN** the last line is "This uninstall ran Megachat 0.3.0+2.g" with the first 7 hexadecimal digits of the commit, followed by "from" and the directory, and the exit code is 0

#### Scenario: A refused entry
- **WHEN** `uninstall` refuses an entry of another program
- **THEN** the line before the switch line says that the uninstall did not finish, and the exit code is 1

### Requirement: An error of uninstall has a reason
`uninstall` MUST NOT exit with the code 1 without a text. An unexpected error MUST print its message and tell the user to remove the entry `Megachat` from `acp.json` by hand and to run the command `stop`.

Tests: `test/uninstall.test.mjs`

#### Scenario: A directory without the write permission
- **WHEN** the directory of `acp.json` has the mode 0500, and `uninstall` must copy the file
- **THEN** `uninstall` writes "The uninstall stopped with an error:" with the message of the error to the error output, `acp.json` stays unchanged, and the exit code is 1

### Requirement: Request to remove Megachat in the chat
The rules of the main agent MUST say that it does not remove Megachat. When the user asks for it, for example "remove yourself" or "удали себя", the agent MUST give the line `npx -y "github:ignatov/megachat#semver:x" uninstall`, tell about the switch on the Agents page of Air and that the state stays, and start no child task for the removal.

Tests: `test/uninstall.test.mjs`

#### Scenario: The rules of the main agent
- **WHEN** the main agent gets its rules
- **THEN** the section of the settings holds the text of `instructions.uninstall`, with the line of `uninstall` and "Agents page"

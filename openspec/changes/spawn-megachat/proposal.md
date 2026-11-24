# Proposal

## Why

On 2026-11-23 a contributor asked for this change. Today the entry `Megachat` of `acp.json` gives each IDE one
Megachat: one conversation for all the projects of the machine. Air shows its row first in each session list, also
before the first use. The user cannot choose where Megachat works. A user who wants an agent for one project gets the
agent of the machine, which lists each open project and each known repository. And the user cannot take Megachat out
of the session list without the command `uninstall` or the switch in the settings of Air.

The request: after the install, no Megachat is there. The user adds one with the action "Spawn Megachat". The user
adds it for the IDE, where it works across all the projects as today. Or the user adds it for one project or folder of
Agent Sessions, and then its scope is that project. The user can also remove a Megachat that the user added.

## What Changes

Where it shows: the session list of Air (a button and two menu actions), the chat of a Megachat of a project, the
commands `stop`, `status` and `uninstall`, `README.md` and `docs/air-contract.md`. The buttons and the menu actions
are code of Air, in another repository. This change gives the side of Megachat and the contract.

- **Two scopes.** A Megachat has the machine scope or a project scope. The machine scope is the Megachat of today:
  one conversation for the machine, in `~/.jetbrains/air/megachat`. A project scope is new: one Megachat for one
  project directory.
- **Selection of a project scope.** The variable `MEGACHAT_PROJECT` names the project directory. Air sets it when it
  starts the command of the entry for a project. Without the variable, Megachat has the machine scope, so the entry
  and each present start stay as they are.
- **Own state of a project scope.** A project scope has its own state directory,
  `~/.jetbrains/air/megachat/projects/<name>-<digest>`, with its own daemon, conversation, settings, memory, spend
  record and session index. It reads and writes no state of the machine scope or of another project. A file
  `project.json` names the project directory.
- **Limits of a project scope.** The listed directories are only the project directory, a directory in it that a
  client registers, and a linked git worktree of the project that a client registers. `agents_projects` gives only
  the action `list`. The workspace of Megachat is not listed. A session whose `cwd` is out of these directories is
  absent for `agents_running`, `agents_stop`, `agents_archive`, `agents_session_history`, the live table of the
  session files and the notes about the waiting sessions. Megachat reads of such a log only the first lines, which
  give its `cwd`. The setting `cloud.sessions` stays off, so the tool
  `agents_cloud` is not there.
- **Rules and setup of a project scope.** The rules of the main agent get the rules of a project scope: it works only
  in its project, and it tells the user to add another Megachat for another project. The setup has two questions, the
  agents and the index of past sessions. The setup note names the project.
- **No Megachat before the user adds one.** Megachat starts nothing by itself, as today. The contract now says that
  Air starts no command of the entry and shows no row before the user adds a Megachat, and that Air shows the button
  "Spawn Megachat" in the place of the launcher row.
- **Removal.** Air sends the new request `_agent/stop` for the action "Remove Megachat". Megachat stops its daemon
  when no turn and no child run is in work, and answers `stopped: true`. Else it answers `stopped: false` with a
  reason, and nothing changes. The state directory stays, so a new "Spawn Megachat" gives the same conversation.
- **Several daemons of one copy.** `uninstall` also stops the daemon of each project scope, and it changes nothing
  when one of them has work. A daemon stops itself for an update only together with the other daemons that run from
  the same copy, when each of them is ready.
- **`README.md`.** The quick start says "Spawn Megachat" in place of "select Megachat in the agent list". A new
  section describes the two scopes, the state directory of a project, the variable and the removal.
- **`openspec/config.yaml`.** The product line of the context says that a Megachat has the machine scope or a project
  scope.

This change modifies the ACP extensions. `docs/air-contract.md` gets them, and Air must change:

- Air shows the button "Spawn Megachat" in the place of the launcher row, and the action "Spawn Megachat" in the menu
  of a project row and of a folder row. Air keeps the record of the Megachats that the user added.
- For a project, Air starts the command of the entry with `MEGACHAT_PROJECT` set to the directory, one process for
  each project. It sends `session/new` with that directory as `cwd`, and it shows the session as the first row of the
  project.
- Air reads the new capability `projectScope` in the answer of `initialize`. A release of Megachat without it ignores
  the variable and opens the conversation of the machine. Air must then close the connection and show an error.
- Air reads the new capability `agentStop`, and it sends the new request `_agent/stop` for "Remove Megachat". It
  removes the row only after `stopped: true`, and it shows the `reason` of a refusal.

## Capabilities

### New Capabilities

- `project-scope`: a Megachat for one project directory: the variable that selects it, its state directory, its
  listed directories, the limits of the readers of the machine, its rules and its setup, and the commands that act on
  several daemons.
- `agent-stop`: the request `_agent/stop` of the client, which stops the daemon when no work runs and keeps the
  state.

### Modified Capabilities

- `state-directory`: the requirement "Place of the state directory" names the machine scope and the directory of a
  project scope. The requirement "State that the copy does not take" refuses the copy for a project scope.
- `projects`: the requirement "Listed directories" names the directories of a project scope. The requirement
  "Workspace of Megachat" says that the workspace is not listed in a project scope.
- `settings`: the requirement "Pending onboarding" names the setup rules of a project scope.

## Impact

- Code: `src/MegachatHome.mjs` and `src/main.mjs` (the scope and its state directory), `src/MegachatState.mjs` and
  `src/ProjectDirectories.mjs` (the listed directories), `src/PiMegachatService.mjs` and `src/Settings.mjs` (the
  tools, the rules and the cloud setting), `src/SessionCatalog.mjs`, `src/SessionIndexService.mjs`,
  `src/RunningAgents.mjs`, `src/AgentStop.mjs` and `src/SessionArchive.mjs` (the sessions of the machine),
  `src/AcpBridge.mjs` and the new `src/DaemonWork.mjs` (the capabilities and `_agent/stop`),
  `src/MegachatInstall.mjs` (`uninstall`), `src/MegachatUpdate.mjs` and `src/DaemonServer.mjs` (the update of a
  shared copy).
- Resources: new `resources/instructions-project.md` and `resources/instructions-onboarding-project.md`, and new
  strings in `resources/Megachat.properties`.
- State: a new directory `projects/` in the state directory of the machine scope, and a new file `project.json` in
  the state directory of a project scope. No schema of `conversation.sqlite` or `settings.json` changes.
- ACP: the capabilities `projectScope` and `agentStop`, and the request `_agent/stop`. Air needs the changes above,
  and an IJAI ticket holds them.
- Cost: each Megachat has its own daemon. Each daemon sends its own keep-alive requests of the prompt cache and runs
  its own automatic turns.

## Out of scope

- The code of Air: the button, the menu actions, the record of the added Megachats and the place of the rows.
- Settings, memory or a spend limit that two Megachats share. Each Megachat has its own, and the setup of a project
  scope copies nothing from the machine scope.
- One daemon that holds several conversations.
- A move of the conversation when the project directory moves or gets another name. The new path gets a new state
  directory, and the old one stays on the disk.
- A deletion of the state directory at the removal.
- A stop of work that runs at the removal, or an option to force it. The user stops the work in the chat first.
- A removal that reaches a second IDE. Each IDE keeps its own record of the added Megachats.
- The cloud sessions in a project scope. The setting `cloud.sessions` stays off there.
- A Megachat for a directory in another project scope. Two project scopes of nested directories are two Megachats.
- No change of `install`, of `setup.sh` or of the entry of `acp.json`.
- A lock of a checkout across two daemons. See the non-goals below.
- The change touches the product line "Megachat is one conversation shared by the projects on a machine": this stays
  true for the machine scope only.
- The change touches the non-goal "It does not run two children in one checkout at the same time". Each daemon keeps
  this rule for its own children. The Megachat of the machine and the Megachat of a project are two daemons, so each
  of them can run a child in the same checkout at the same time. `README.md` tells this.

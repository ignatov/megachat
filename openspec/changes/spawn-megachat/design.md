# Design

## Context

See proposal.md, "Why", for the request. The present state, from the code:

- `src/main.mjs` selects the state directory one time at the start of the process: the final command argument, else
  `defaultStateDirectory()` of `src/MegachatHome.mjs` (`MEGACHAT_HOME`, else `~/.jetbrains/air/megachat`). The command
  `acp` calls `start()` before it reads `initialize`. So one `acp` process serves one state directory and one daemon.
- `spawnDaemon()` starts the daemon with `MEGACHAT_HOME` set to the state directory, or with the directory as the
  final argument when the start got one. Only a start without the argument copies an earlier directory
  (`migrateLegacyState`, `connectLegacy`).
- The listed directories are in the state document of `conversation.sqlite`: `workspaces` (a client registered them
  through `/workspace`), `projects` (the known repositories) and `megachatWorkspace`. `directoriesOf()` and
  `isDirectoryOf()` of `src/ProjectDirectories.mjs` read them. The bridge registers the `cwd` of `session/new` and
  each directory of `_workspaces/list`, and it ignores a refusal of the daemon.
- The index of past sessions holds only the sessions of the listed directories. The live table of the session files
  (`SessionCatalog`, filled by `SessionIndexService`) and `agents_running` (`src/RunningAgents.mjs`) read the whole
  machine.
- `uninstall()` of `src/MegachatInstall.mjs` has the check of work (`workLines`), the stop (`/shutdown`) and the wait
  for the end of the process (`processEnded`), for the one daemon of the state directory.
- A daemon of a copy of npx stops itself for an update and then renames the directory of the copy (`retireCopy`). A
  running daemon loads `src/child-supervisor.mjs`, `bin/` and the files of `resources/` from its copy later. So a
  second daemon of the same copy cannot start a child run after the rename.
- Air (`plugins/air/spec/sessions/megachat.spec.md` of the IDE repository) gives the entry `Megachat` one application
  session in the workspace `~/.jetbrains/air/megachat/workspace`. Before the first use, a launcher row takes the place
  of the session row. No New Session surface offers Megachat.
- A prototype of 2026-11-16 (not merged) ran a fork of Megachat for each project. Air added a variable with a state
  directory to the environment of the entry, and its process pool keeps one process for each environment. This design
  uses the same means.

## Goals / Non-Goals

**Goals:**

- A Megachat of one project that cannot list, start, read or stop work out of its project.
- No change for a present user: without the new variable, each command and each file is as today.
- A removal that loses no admitted work and no state.

**Non-Goals:**

- One daemon for several conversations, or state that two Megachats share.
- The code of Air. This design gives the contract and the text of the ticket.

## Decisions

### 1. One daemon and one state directory for each scope

A project scope is a second instance of the present Megachat on another state directory. Pi Durable holds one
conversation in one storage directory, and the daemon, the lock, the settings, the memory and the index are all
bound to that directory. So a second directory gives a second Megachat with no change of the storage.

Alternative: one daemon with a conversation for each project. It needs a second key in each table, each route and
each timer of the daemon. Refused: the change is large, and a fault of one project would stop each conversation.

The cost is one daemon process for each Megachat (see "Risks").

### 2. The variable `MEGACHAT_PROJECT` selects the scope

Air adds `MEGACHAT_PROJECT=<project directory>` to the environment of the command of the entry. `main.mjs` reads it
one time, before `start()`. `resolveProject()` (new, in `src/MegachatHome.mjs`) gives the real path, and it refuses a
path that `resolveRepository()` refuses for a known repository: a relative path, a file, the root, the home
directory and a directory that holds it, the application data and the hidden directories directly in the home
directory, and the state directory of Megachat.

Alternatives:

- A field of `session/new`, such as `_meta.jetbrains.air.megachat.project`. Refused: `acp` starts its daemon before
  the first request, so the daemon of the machine scope would start for a user who added only a Megachat of a project.
- A variable with the state directory, as in the prototype. Refused: Air would then own the layout of the state of
  Megachat, and `uninstall` and the update could not find the directories.
- A command argument. Refused: Air builds the command from the entry of `acp.json`, and it can add a variable with no
  knowledge of the arguments.

`install` and the entry do not change. `test/state-guard.mjs` removes `MEGACHAT_PROJECT` from each test process, as
it sets `MEGACHAT_HOME`, so a test never gets the scope of the shell that started it.

### 3. The state directory `projects/<name>-<digest>` and the file `project.json`

`projectStateDirectory(machineDirectory, projectDirectory)` gives `projects/<name>-<digest>` in the state directory of
the machine scope. The name is for a reader. The digest (12 hexadecimal digits of the SHA-256 of the real path)
makes two projects with one name two directories. The directory `projects/` and each directory in it get the mode
0700 from `ensurePrivateDirectory()`.

In a project scope, `start` gives the state directory to the daemon as its final argument and keeps
`MEGACHAT_PROJECT` in its environment. So the daemon takes the directory as it is, and no earlier directory is
copied, because a directory from an argument gets no copy today. `connectLegacy()` also returns at once.

The daemon writes `project.json` before it publishes its connection file. The file makes the state directory
describe itself: `status` or `stop` with only the directory argument finds the scope, and a daemon cannot open the
conversation of a project with the machine scope. `selectScope()` of `src/main.mjs` reads the file in each command
that opens the state, also in `start`, so a state directory of another project ends the command with the new error
`projectState` before a daemon starts. A file that Megachat cannot read gives the error `projectRecord`.

State files that the change adds or reads:

| File | Field | An older state directory |
|---|---|---|
| `project.json` (new, only in a project scope) | `schema` (1), `directory` | The machine scope has no such file, and gets none. |
| `conversation.sqlite`, the state document | `projectDirectory` (new): the project directory, or `null` | `initialize` sets `null`, as it sets `megachatWorkspace`. |
| `conversation.sqlite`, the state document | `megachatWorkspace`: `null` in a project scope | No change in the machine scope. |
| `settings.json` | No new field. In a project scope, a set of `cloud.sessions` to on fails. | No change. |

The schema of `conversation.sqlite` (Pi Durable) and the schema of `settings.json` do not change.

### 4. The daemon holds the limit of the directories, not the bridge

`MegachatState` gets the project directory at its construction and puts it into `projectDirectory` of the state
document. `directoriesOf()` gives it first, with the origin `project`. `isDirectoryOf()` accepts it.

`addWorkspace()` gets one rule for a project scope (`inProjectScope()` of `src/ProjectDirectories.mjs`): it accepts a
directory that is the project directory, is in it (`isWithin`), or is a linked worktree whose main repository is the
project directory (`mainRepositoryOf`). It refuses each other directory with the error of a directory that is not
listed. `initialize` of a project scope also drops each known repository and each registered directory out of the
scope, so a state directory that the machine scope used before lists nothing more. The bridge does not change: it registers the
`cwd` of `session/new` and each directory of `_workspaces/list`, and it ignores each refusal, as it does today for a
directory that the daemon cannot read. So a second client, a test or a later client cannot make the scope wider.

`agents_projects` checks the scope first: `add`, `remove`, `discover` and `create` fail with the new error
`projectScope`. `megachatWorkspace` is `null`, so the workspace is not listed. The daemon still makes the directory
`workspace`, because the account check starts the agents there.

Each tool that takes a directory (`agents_spawn`, `agents_sessions`, `agents_resume`, the index) reads the listed
directories already. So these tools need no change.

### 5. Two places limit the sessions of the machine

- The live table. `SessionCatalog` gets the option `scope`, a function that gives the listed directories, and
  `SessionIndexService` passes it in a project scope. The table then keeps only a file whose `cwd` is a listed
  directory or a directory in one. It does not open a file whose path names another directory, as the path of a Claude
  Code or pi file does. Of each other file, such as a Codex file, it first reads only the lines that give the `cwd`,
  and it remembers a file of another directory by its inode, so it does not read it again. A change of the listed
  directories, such as a new worktree, starts a new pass (`rescope()`). `agents_session_history` with `order`
  `newest` finds a session through the table, so it follows.
- `RunningAgents.scan()` drops each row whose `cwd` is unknown or out of the listed directories. The notes about the
  waiting sessions read that view, so they follow.
- `agents_stop` reads the process table itself. So `AgentStop.targets()` refuses in a project scope a PID that the
  view does not give, with the reason of a PID that is no agent session.
- `agents_archive` finds a compressed Codex file without the table. So `SessionArchive.record()` reads the first lines
  of such a file in a project scope, and it refuses a file of another directory as an unknown session.

Alternative: a check in each tool. Refused: a new tool would then read the whole machine by default.

`cloud.sessions` cannot go on in a project scope: the validation of the setting refuses `on` with `projectScope`. The
cloud sessions belong to the Central login, not to a directory, so no filter applies to them.

### 6. The rules and the setup are files of their own, with no path in the rules

The service reads two new files: `resources/instructions-project.md` and
`resources/instructions-onboarding-project.md`. In a project scope, the rules of the main agent are the bundled rules,
then `instructions-project.md`. The setup rules are `instructions-onboarding-project.md` in place of
`instructions-onboarding.md`. The ghost rules of the setup stay as they are.

`instructions-project.md` holds no path and no name of the project. The main agent reads the directory from
`agents_list`, where it is data. So a directory name cannot become a rule, and the rules are the same text for each
project. The text starts with "This Megachat belongs to one project." It says: start each task in the directory
with the origin `project` or in a worktree of it; no other directory can come into the list; you see only the
sessions of this project; these rules win over a rule above about another project, a known repository or the
Megachat workspace; when the user asks for work in another project, say that this Megachat works only in its
project, and that the user adds a Megachat for that project, or the Megachat of the IDE, with "Spawn Megachat" in
Agent Sessions.

`instructions-onboarding-project.md` is `instructions-onboarding.md` with "two questions" in place of "four
questions", with the questions 1 and 2, and without the questions 3 and 4. Question 2 says "in this project" in
place of "in your projects".

The setup note is the new string `onboarding.offer.project` with the last segment of the project directory. It starts
with "Welcome to Megachat", so the rule of the setup about the note applies to it too.

Each Megachat has its own settings, as the contributor decided. So each project scope asks its setup one time.

### 7. `_agent/stop`: a request of its own, and a refusal while work runs

Air sends `_agent/stop` with `{}` on the ACP connection of the Megachat that the user removes. The bridge:

1. reads `/state` of its daemon, and counts the turn (`current`) and the child runs that are not in a terminal state,
   as `workLines()` of `uninstall` does. With work, it answers `stopped: false` with the text of `stop.agent.busy`.
2. else sends `/shutdown`, and waits with `processEnded()` at most 30 seconds (`STOP_WAIT_MS` of `uninstall`).
3. answers `{ "stopped": true }`, then ends with the new line `log.agentStopped` through `end()`, which closes the
   connection after `END_DELAY_MS`, so the answer goes out first.

While the stop runs, the end of an event stream and the health check do not end the connection: only the stop ends
it, after its answer. A second request during a stop gets the answer of the first one.

The request has no `sessionId`, because one `acp` process has one daemon, and Air can send it before a view exists.
`workOf()`, `workLines()`, `runningDaemon()` and `stopDaemon()` are in the new module `src/DaemonWork.mjs`, which
`uninstall`, the bridge and the update use.

Alternatives:

- `session/close`. Refused: with `persistentSession`, Air sends no `session/close` at a release, and a view that
  closes must not stop the daemon of the other windows.
- The command `stop` in a terminal. Refused: Air has only the command of the entry, which ends with `acp`.
- A stop that cancels the work. Refused: `uninstall` never ends work that runs, and a click in a menu must not lose
  a child run. Air can first send `session/cancel` and `_session/async_task/stop`, then `_agent/stop` again.

Megachat keeps no record of the removal. Air keeps the record of the added Megachats. So a second IDE that still
shows the row starts the daemon again at its next open, and that is correct for that IDE.

### 8. `uninstall` and the update act on the state tree

The state tree is the state directory of the machine scope and each directory of `projects/` in it. A new function
`stateDirectories(machineDirectory)` gives them. A daemon whose state directory came from a final argument out of
the tree is alone.

- `uninstall` ignores `MEGACHAT_PROJECT`. It connects to the daemon of each directory of the tree, collects the work
  lines of each, and adds the project directory of `project.json` to each line of a project scope (the new string
  `uninstall.busyProject`). It refuses when one daemon has work. Else it removes the entry, then stops each daemon.
- The update. The daemon gets the route `GET /update/ready`, which answers `{ "root": "<package root>", "ready": true }`
  when it has no work, by the rule "Work at the automatic stop" (`updateWork()`). Before a daemon stops itself for an
  update, the automatic one and the one of `agents_update`, `UpdateCheck` asks each other daemon of the tree through
  its new option `others`. A daemon with another `root`, or without the route, runs from another copy, and it does not
  count. When each daemon of the same copy is ready, the daemon sends the new request `POST /update/stop` with the two
  versions to each, and waits for their end. Such a daemon records the stop, sends the event `update` to its views,
  as for its own stop, and stops without a rename of the copy. Then the first daemon stops itself and renames the
  copy. When one daemon is not ready, nothing stops, and the next check of the conditions asks again.

Alternative: each daemon stops itself, and the last one renames the copy. Refused: the first start of a client would
then use the old copy again, and the release would never install while one Megachat is in use.

Only the daemon that starts the update checks the time of the automatic stop and its own `update.auto`. A daemon with
`update.auto` off does not start an update, but a daemon of the same copy with `update.auto` on can stop it, because
the copy is one. `README.md` says this.

### 9. Admitted work through a disconnect and a restart

Nothing changes in one scope: the daemon of each scope keeps its admitted work when its client disconnects, and the
next daemon on the same state directory continues it (see the capabilities `daemon` and `run-recovery`).

- `_agent/stop` refuses while a turn or a child run is in work, so it interrupts no admitted work. When an automatic
  turn starts between the check and the stop, the stop is a planned stop, and the daemon of the next start continues
  the run.
- The stop of a second daemon for an update comes only when that daemon is ready, by the same rule as its own stop.
- A daemon of a project scope that a client starts again takes the scope from `MEGACHAT_PROJECT` or from
  `project.json`, so it opens the same listed directories and the same runs.

### 10. ACP messages and `_meta` keys

| Message | Key | Change |
|---|---|---|
| `initialize`, the answer | `_meta.jetbrains.air.capabilities` | New values `agentStop` (always) and `projectScope` (only in a project scope). |
| `_agent/stop` (new, from Air) | parameters `{}`; answer `stopped`, `reason` | See decision 7. |
| `session/new`, `session/load` | `cwd` | Read as today. In a project scope, the daemon refuses a `cwd` out of the scope, and the view attaches without it. |
| `_workspaces/list` (from Megachat) | `directories` | Read as today. The daemon lists only the directories of the scope. |

`docs/air-contract.md` gets a new section "The scopes of Megachat" with: the variable, one process for each project,
the `cwd` of `session/new`, the check of `projectScope`, and that Air starts no command of the entry before the user
adds a Megachat. The tables of the capabilities and of the requests get the rows above. The line "Air shows the
Gothic M icon and the first row of the session list" changes to the button "Spawn Megachat" before the first use.

### 11. What Air must change

The text of the ticket goes to `openspec/changes/spawn-megachat/air-ticket.md`, as `session-archive` did:

1. The button "Spawn Megachat" in the place of the launcher row, and the action "Spawn Megachat" in the menu of a
   project row and of a folder row of Agent Sessions. A stored application session of a present user stays a row.
2. A record of the added Megachats in the state of the IDE. No command of the entry starts before an add.
3. For a project: the environment of the entry plus `MEGACHAT_PROJECT`, one process for each project, `session/new`
   with the project directory as `cwd`, and the session as the first row of that project.
4. The check of `projectScope` in the answer of `initialize` of a process that Air started with the variable. Without
   it, Air closes the connection and tells the user to update Megachat.
5. The action "Remove Megachat" for both scopes: `_agent/stop` to an agent with `agentStop`. Air starts the command
   first when it has no connection. After `stopped: true`, Air removes the row and shows the button again. After
   `stopped: false`, Air shows `reason`. Without `agentStop`, Air removes only the row and says that the daemon
   continues until the command `stop`.

## Risks / Trade-offs

- [Each Megachat is a daemon with its own keep-alive requests of the prompt cache (up to `keepAlive.hours` after its
  last turn), its own automatic turns and its own spend limit] → `README.md` states the cost. `_agent/stop` and
  `uninstall` end a daemon. A shared spend limit is out of scope.
- [A release of Megachat before this change ignores `MEGACHAT_PROJECT` and opens the conversation of the machine as
  the Megachat of a project] → the capability `projectScope`, which Air must check (decision 11, point 4).
- [The Megachat of the machine and the Megachat of a project can each run a child in one checkout at the same time,
  and two project scopes of nested directories can do so too] → each daemon keeps the rule for its own children.
  `README.md` tells the user. A lock across daemons is out of scope.
- [A project directory that moves gets a new, empty Megachat, and the old state directory stays] → `project.json`
  names the old path, so the user can find and delete the directory. `README.md` tells this.
- [The removal in one IDE does not remove the row of a second IDE, and that IDE starts the daemon again] → stated in
  the contract. The record is a state of Air.
- [When Air has no connection, it starts the command to send `_agent/stop`, and that start can start a daemon only to
  stop it] → accepted for the first version: the result is correct, and the cost is one start.
- [A daemon with `update.auto` off stops for the update of another daemon of its copy] → the copy is one, so the
  update is one. `README.md` says this.
- [A present test compares the full list of the capabilities of `initialize`] → the tasks change these tests with
  `agentStop`.

## Migration Plan

No migration. Without `MEGACHAT_PROJECT`, the state directory, the entry and each command are as before. A state
directory of today has no `project.json`, so it stays the machine scope.

Rollback: a build before this change ignores the variable and the directory `projects/`. The state directories of
the project scopes stay on the disk, and the user can delete them.

## Open Questions

- How Air names the row of a Megachat of a project, and whether it is an application session or an ordinary session
  of the project. This is a decision of Air, and it changes nothing in Megachat.
- Whether Air sends `session/cancel` and the stops of the rows before `_agent/stop`, behind a question to the user.
  Megachat answers the same in both cases.

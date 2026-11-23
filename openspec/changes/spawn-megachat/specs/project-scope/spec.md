# Spec Delta

## Purpose

A Megachat can belong to one project directory in place of the machine. This capability gives the variable that selects such a project scope, its state directory, the limits of what it lists and reads, its rules and its setup, and the rules for several daemons of one copy.

## ADDED Requirements

### Requirement: Selection of the scope
The variable `MEGACHAT_PROJECT` MUST select a project scope. Its value MUST be the absolute path of an existing directory, and Megachat MUST use the real path of that directory as the project directory. Without the variable, or with an empty value, Megachat MUST have the machine scope, and it MUST work as before.

Tests: `test/project-scope.test.mjs`

#### Scenario: No variable
- **WHEN** `MEGACHAT_PROJECT` is not set, or is an empty value, and `MEGACHAT_HOME` is `/tmp/x`
- **THEN** the scope is the machine scope, and the state directory is `/tmp/x`

#### Scenario: A symbolic link
- **WHEN** `MEGACHAT_PROJECT` is the path of `link`, a symbolic link to the directory `app`
- **THEN** the project directory is the real path of `app`

### Requirement: Refused project directory
A value of `MEGACHAT_PROJECT` that is not the absolute path of an existing directory, or that names a directory that cannot be a known repository (see the capability `projects`), MUST end the commands `acp`, `start`, `daemon`, `status`, `stop` and `compact` with the exit code 1 and one line that names the value. Megachat MUST then start no daemon and make no state directory.

Tests: `test/project-scope.test.mjs`

#### Scenario: A path that is no directory
- **WHEN** `MEGACHAT_PROJECT` is `src/app`, the path of a file, or the path of a directory that does not exist, and the user runs `start`
- **THEN** `start` ends with the exit code 1, its error output is one line that starts with "MEGACHAT_PROJECT names no project directory:" and names the value, no daemon runs, and `MEGACHAT_HOME` holds no directory `projects`

#### Scenario: The other commands
- **WHEN** `MEGACHAT_PROJECT` is `src/app`, and the user runs `status`, `stop`, `compact`, `daemon` or `acp`
- **THEN** each command ends with the exit code 1 and the same line

#### Scenario: A directory that cannot be a project
- **WHEN** `MEGACHAT_PROJECT` is the home directory of the user, or the state directory of Megachat, and the user runs `start`
- **THEN** `start` ends with the exit code 1, and no daemon runs

### Requirement: State directory of a project scope
The state of a project scope MUST live in `projects/<name>-<digest>` in the state directory of the machine scope. `<name>` MUST be the last segment of the project directory, with `_` for each character other than a Latin letter, a digit, `.`, `_` and `-`, and at most 40 characters. `<digest>` MUST be the first 12 hexadecimal digits of the SHA-256 of the project directory. The final command argument MUST select the state directory as it is.

Tests: `test/project-scope.test.mjs`

#### Scenario: A name with a space
- **WHEN** `MEGACHAT_HOME` is `/tmp/x` and the project directory is `/work/My App`
- **THEN** the state directory is `/tmp/x/projects/My_App-ed3ef1005942`

#### Scenario: Two projects with one name
- **WHEN** `MEGACHAT_HOME` is `/tmp/x`, and the project directories are `/work/app` and `/other/app`
- **THEN** the state directory of `/work/app` is `/tmp/x/projects/app-70467eff2e0a`, and the state directory of `/other/app` is another directory that starts with `app-`

#### Scenario: The command argument
- **WHEN** `start` gets the final argument `/tmp/y`, and `MEGACHAT_PROJECT` names the directory `app`
- **THEN** the state directory is `/tmp/y`, and the daemon has the project scope of `app`

### Requirement: Record of the project
The daemon of a project scope MUST write `project.json` in its state directory at its start, with the mode 0600: `{"schema":1,"directory":"<project directory>"}`. A daemon that finds another directory in the file MUST end with the exit code 1 and change no file. A daemon without `MEGACHAT_PROJECT` MUST take the project scope of the file when the file exists, and it MUST write no such file.

Tests: `test/project-scope.test.mjs`

#### Scenario: The first start
- **WHEN** the daemon of the project `app` starts on an empty state directory
- **THEN** `project.json` holds `{"schema":1,"directory":"<real path of app>"}` with the mode 0600

#### Scenario: A state directory of another project
- **WHEN** `project.json` of the state directory names `/work/other`, and `start` gets that state directory as its final argument with `MEGACHAT_PROJECT` for `app`
- **THEN** `start` ends with the exit code 1, it says that the state directory belongs to another project, and `project.json` stays unchanged

#### Scenario: A start without the variable
- **WHEN** `start` gets the state directory of the project `app` as its final argument, and `MEGACHAT_PROJECT` is not set
- **THEN** the daemon has the project scope of `app`

#### Scenario: The machine scope
- **WHEN** a daemon of the machine scope starts on a state directory without `project.json`
- **THEN** its state directory holds no `project.json`

### Requirement: Own state of a project scope
A project scope MUST have its own daemon, conversation, settings, learned memory, spend record and index of past sessions in its state directory. Its conversation, settings and memory MUST come only from that directory, so the first start of a project scope has no setting and no memory of another Megachat.

Tests: `test/project-scope.test.mjs`

#### Scenario: Two daemons at a time
- **WHEN** a daemon of the machine scope runs on `MEGACHAT_HOME` with the onboarding `done` in `settings.json` and a `memory.md`, and `start` runs with the same `MEGACHAT_HOME` and `MEGACHAT_PROJECT` for `app`
- **THEN** two daemons run with two process IDs, the state directory of the project scope holds no `settings.json` and no `memory.md`, the conversation of the project scope holds the setup note of the project, and the conversation of the machine scope holds no setup note

### Requirement: Capability projectScope
With a project scope, the answer of `acp` to `initialize` MUST hold the capability `projectScope` in the list `_meta.jetbrains.air.capabilities`. With the machine scope, the list MUST NOT hold it. So a client can tell a release that does not know `MEGACHAT_PROJECT`.

Tests: `test/project-scope.test.mjs`

#### Scenario: The answer of a project scope
- **WHEN** a client sends `initialize` to `acp` that runs with `MEGACHAT_PROJECT` for `app`
- **THEN** the list of the capabilities in the answer holds `projectScope`

#### Scenario: The answer of the machine scope
- **WHEN** a client sends `initialize` to `acp` that runs without `MEGACHAT_PROJECT`
- **THEN** the list of the capabilities in the answer does not hold `projectScope`

### Requirement: Directories of a project scope
In a project scope, the listed directories MUST be only the project directory, a directory in it that a client registers, and a linked git worktree that a client registers when its main repository is the project directory. The daemon MUST list the project directory at its start, with the origin `project`. It MUST refuse the registration of each other directory, and the list MUST stay unchanged.

Tests: `test/project-scope.test.mjs`

#### Scenario: The start of the daemon
- **WHEN** the daemon of the project `app` starts
- **THEN** `agents_list` gives one directory, `app`, with the origin `project`, and no directory with the origin `megachat`

#### Scenario: Registered directories
- **WHEN** a client registers `app/server`, the linked worktree `app-wt` of `app`, the directory `other` and the linked worktree `other-wt` of `other`
- **THEN** `agents_list` gives `app`, `app/server` and `app-wt`, with `worktreeOf` for `app-wt`, and it does not give `other` and `other-wt`

#### Scenario: A task out of the scope
- **WHEN** the main agent calls `agents_spawn` with the directory `other`
- **THEN** the tool fails with the error of a directory that is not listed, and the state has no run

### Requirement: No change of the list in a project scope
In a project scope, the actions `add`, `remove`, `discover` and `create` of `agents_projects` MUST fail with the code `projectScope`, and they MUST change nothing. The action `list` MUST work. The state MUST hold no known repository.

Tests: `test/project-scope.test.mjs`

#### Scenario: An add in a project scope
- **WHEN** the user asks the Megachat of the project `app` to add `~/src/repository`, and the main agent calls `agents_projects` with the action `add`
- **THEN** the call fails with the code `projectScope`, and the action `list` gives only `app`

#### Scenario: The other actions
- **WHEN** the main agent calls `agents_projects` with the action `remove`, `discover` or `create`
- **THEN** each call fails with the code `projectScope`, and Megachat scans and makes no directory

### Requirement: Sessions of the machine in a project scope
In a project scope, a session of Claude Code, Codex, pi or OpenCode MUST be absent when its `cwd` is unknown, or is not a listed directory or a directory in one. `agents_running`, `agents_stop`, `agents_archive`, `agents_session_history`, the live table of the session files and the notes about the waiting sessions MUST NOT give it or change it. Megachat MUST read no more of its log than the first lines that give its `cwd`.

Tests: `test/project-scope.test.mjs`

#### Scenario: The running sessions
- **WHEN** Claude Code runs in `app/server`, in `app` and in `other`, and the main agent of the project `app` calls `agents_running`
- **THEN** the result has two rows, with the `cwd` `app/server` and `app`, and the view that the notes about the waiting sessions read has the same two rows

#### Scenario: A stop of a session out of the scope
- **WHEN** the main agent of the project `app` calls `agents_stop` with the PID 70 of the orphan session in `other`
- **THEN** the result has the outcome `none` and the reason "The PID 70 is no agent session of agents_running now.", and no signal goes out

#### Scenario: The live table and the history
- **WHEN** the consent `sessions.index` is on, Claude Code has a session file for `app` and one for `other`, and Codex has a session file for `app/server` and one for `other`
- **THEN** the live table holds only the files of `app` and `app/server`, and `agents_session_history` with `order` `newest` fails with the code `missing` for each session of `other`

#### Scenario: A worktree that comes into the list
- **WHEN** a client registers the linked worktree `app-wt` of `app`, and Claude Code has a session file for `app-wt`
- **THEN** the live table holds that file too

#### Scenario: An archive of a session out of the scope
- **WHEN** the main agent of the project `app` calls `agents_archive` with the Claude Code session, the Codex session and a compressed Codex session of `other`
- **THEN** the call refuses each of them as a session that is not in the index of the session logs, and the chat shows no dialog

### Requirement: Cloud sessions in a project scope
In a project scope, the setting `cloud.sessions` MUST stay off. A set of `cloud.sessions` to on MUST fail with the code `projectScope`. So the main agent has no tool `agents_cloud`, and the daemon runs no `airc`.

Tests: `test/project-scope.test.mjs`

#### Scenario: A set to on
- **WHEN** the main agent of the project `app` sets `cloud.sessions` to `on`
- **THEN** the set fails with the code `projectScope`, the value stays `off`, and the main agent has no tool `agents_cloud`

### Requirement: Rules of a project scope
In a project scope, the rules of the main agent MUST hold the rules of `resources/instructions-project.md` after the bundled rules. They MUST say that this Megachat works only in its project, that `agents_list` gives the directory, and that the user adds another Megachat with "Spawn Megachat" for another project. The rules MUST NOT hold the path of the project. The machine scope MUST NOT get these rules.

Tests: `test/project-scope.test.mjs`

#### Scenario: The rules of a project scope
- **WHEN** the daemon of the project `app` builds the rules of the main agent
- **THEN** the rules hold "This Megachat belongs to one project." and "Spawn Megachat", and they do not hold the path of `app`

#### Scenario: The rules of the machine scope
- **WHEN** a daemon of the machine scope builds the rules of the main agent
- **THEN** the rules do not hold "This Megachat belongs to one project."

### Requirement: Setup rules of a project scope
The setup rules of a project scope, `resources/instructions-onboarding-project.md`, MUST ask two questions: the pair of agents and the index of past sessions. They MUST NOT name `agents_projects` and `projects.newRoot`. Each other rule of the setup MUST be the rule of the machine scope (see the capability `settings`).

Tests: `test/project-scope.test.mjs`

#### Scenario: The settings in the setup rules
- **WHEN** a test reads `resources/instructions-onboarding-project.md`
- **THEN** the setting keys that it names are `coordinator.model`, `children.agent`, `children.codexModel` and `sessions.index`, it holds "The setup asks the user two questions", and it does not hold `agents_projects` and `projects.newRoot`

#### Scenario: The rules that stay
- **WHEN** a test reads `resources/instructions-onboarding-project.md`
- **THEN** it holds "ask question 1 in full in the same reply", "Do not change coordinator.model" and "tell the user that each setting can change later in the chat"

### Requirement: Setup note of a project scope
On a fresh conversation with a pending setup, the note of a project scope MUST start with "Welcome to Megachat for the project <name>.", with the last segment of the project directory as `<name>`, at most 100 characters. It MUST say that this Megachat works only in that project, and it MUST offer the setup of two questions.

Tests: `test/project-scope.test.mjs`

#### Scenario: The note of a fresh project scope
- **WHEN** the daemon of the project `/work/My App` starts on an empty state directory
- **THEN** the conversation gets one note that starts with "Welcome to Megachat for the project My App." and holds "two short questions"

### Requirement: Uninstall with project scopes
The command `uninstall` MUST act on the state directory of the machine scope and on each state directory of `projects/` in it, with or without `MEGACHAT_PROJECT`. When the daemon of one of them has work, `uninstall` MUST change nothing, and it MUST name the project directory of that daemon. Else it MUST stop each of these daemons.

Tests: `test/uninstall.test.mjs`

#### Scenario: Two daemons without work
- **WHEN** the daemons of the machine scope and of the project `/work/app` run without work, and the user runs `uninstall`
- **THEN** the entry `Megachat` is gone, both daemons end, the exit code is 0, and both state directories stay

#### Scenario: A project scope with work
- **WHEN** the daemon of the project `/work/app` has the child run `run-1` of `claude` with the status `running` and the title "Fix the build", and the user runs `uninstall` with `MEGACHAT_PROJECT` set
- **THEN** `uninstall` prints "- The child run run-1 of claude is running: Fix the build This is work of the Megachat of the project /work/app.", the entry and both daemons stay, and the exit code is 1

### Requirement: Update of a copy that several daemons use
A daemon MUST stop itself for an update only when each other daemon that runs from the same copy is ready, in the state directory of the machine scope and in each state directory of `projects/` in it. A daemon is ready when it has no work, as the automatic stop requires. The daemon MUST then stop each of these daemons before the copy moves away. When one is not ready, no daemon MUST stop.

Tests: `test/update.test.mjs`

#### Scenario: Two daemons that are ready
- **WHEN** the daemons of the machine scope and of the project `app` run from one copy of npx without work, a higher release is available, and the conditions of the automatic stop hold for the daemon of the machine scope
- **THEN** both daemons end, each view of the daemon of `app` gets the event of the update before the stop, and the copy moves away one time

#### Scenario: A daemon with work
- **WHEN** a daemon has a child run with the status `running`, and another daemon of its copy asks whether it is ready
- **THEN** the answer is not ready, the daemon that asked does not stop itself or another daemon, and its next check of the conditions asks again

#### Scenario: A daemon of another copy
- **WHEN** the daemon of the project `app` runs from a git checkout, and the daemon of the machine scope stops itself for an update
- **THEN** the daemon of the project `app` continues to run

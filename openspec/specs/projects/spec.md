# projects Specification

## Purpose
The projects are the directories in which a child can work: a project directory that a client registered, a known repository, or the workspace of Megachat. The user can find the git repositories on the computer and make a new project.

## Requirements

### Requirement: Listed directories
A child MUST work only in a listed directory: a project directory that a client registered, a known repository, or the workspace of Megachat. A task, a follow-up, a continued session, and a session search MUST refuse a directory that is not listed.

Tests: `test/projects.test.mjs`

#### Scenario: A task in a directory that is not listed
- **WHEN** the main agent calls `agents_spawn` with the directory `~/src/repository`, which is not listed, or with a directory that does not exist
- **THEN** the tool fails with the error of a directory that is not listed, and the state has no run

#### Scenario: A session search
- **WHEN** a session search names the known repository `~/src/repository` by its absolute path or by its path with `~`, the workspace of Megachat, or a directory out of the home directory that is not listed
- **THEN** the search reads the sessions of the known repository and of the workspace, and it refuses the directory that is not listed with the code `workspace`

### Requirement: Workspace of Megachat
The workspace of Megachat MUST be the directory `workspace` in the state directory. The daemon MUST make it at its start with the mode 0700. A task without a project works there.

Tests: `test/projects.test.mjs`

#### Scenario: The start of the daemon
- **WHEN** the daemon starts and the state has no project
- **THEN** the directory `workspace` in the state directory exists with the mode 0700, and `agents_list` gives it with the origin `megachat`

#### Scenario: A task in the workspace
- **WHEN** the main agent calls `agents_spawn` with the directory `workspace` in the state directory
- **THEN** the run has that directory as its working directory

### Requirement: List of the known repositories
The state MUST keep the list of the known repositories through a daemon restart. The list MUST start empty, and it MUST hold at most 100 repositories. The tool `agents_projects` MUST list the directories, add a known repository, and remove one. Only a turn of the user MAY add a repository.

Tests: `test/projects.test.mjs`

#### Scenario: A restart
- **WHEN** `~/src/repository` is added to the known list and the daemon restarts
- **THEN** the known list holds the real path of `~/src/repository`

#### Scenario: A removed repository
- **WHEN** `agents_projects` adds a repository, then removes it, and then the main agent calls `agents_spawn` in it
- **THEN** the list of the directories does not give the repository, and `agents_spawn` fails with the error of a directory that is not listed

#### Scenario: An automatic turn
- **WHEN** the turn of a child result (`report`) or the turn of the summary of the past sessions (`event`) adds `~/other`
- **THEN** the add fails with the code `proposalOnly`

### Requirement: Path of a known repository
A known repository MUST be an absolute path or a path that starts with `~`. The state MUST keep its real path. That real path MUST be an existing directory in the home directory of the user or in a root of `MEGACHAT_PROJECT_ROOTS`. Thus a symbolic link MUST NOT lead out of these directories.

Tests: `test/projects.test.mjs`

#### Scenario: A symbolic link in the home directory
- **WHEN** `~/inner-link` is a symbolic link to `~/src/repository`, and `~/escape` is a symbolic link to a directory out of the home directory
- **THEN** `~/inner-link` gives the real path of `~/src/repository`, and `~/escape` is refused with the code `directory`

#### Scenario: Refused paths
- **WHEN** the path is `src/repository`, a file, or a directory that does not exist
- **THEN** the path is refused with the code `directory`

#### Scenario: A root out of the home directory
- **WHEN** `MEGACHAT_PROJECT_ROOTS` holds a directory out of the home directory
- **THEN** that directory, and the symbolic link `~/escape` to it, are accepted

### Requirement: Refused directories of a known repository
The home directory itself, its `Library` directory, the hidden directories directly in it, and the state directory of Megachat MUST be refused. A repository that the user names MAY be in a hidden directory deeper in the home directory or in a root.

Tests: `test/projects.test.mjs`

#### Scenario: Directories that cannot be a known repository
- **WHEN** the path is `~`, `~/Library/Application Support`, `~/.ssh`, the state directory, or the directory `workspace` in the state directory
- **THEN** the path is refused with the code `directory`

### Requirement: Working directory of a child in a known repository
A child in a known repository MUST have that repository as its working directory, also when no IDE has opened it.

Tests: `test/projects.test.mjs`

#### Scenario: A repository that no IDE opened
- **WHEN** the user adds `~/src/repository` with `agents_projects` and starts a task there with `agents_spawn`
- **THEN** the run completes with `~/src/repository` as its working directory, and the child agent writes its files in that directory

### Requirement: Directories in agents_list
`agents_list` MUST give each listed directory one time with its origin: `ide`, `known`, or `megachat`. The workspace of Megachat MUST have the name "Megachat workspace".

Tests: `test/projects.test.mjs`

#### Scenario: A directory with two origins
- **WHEN** an IDE registered the directories `outside` and `~/src/repository`, and the user adds `~/src/repository` and `~/second` as known repositories
- **THEN** `agents_list` and the action `list` of `agents_projects` give the workspace of Megachat with the origin `megachat` and the name "Megachat workspace", `outside` and `~/src/repository` with the origin `ide`, and `~/second` with the origin `known`

### Requirement: Default agent of a directory in agents_list
Each directory of `agents_list` MUST have `defaultAgent`: the agent that a new task in it gets without a named agent, with the project value of `children.agent`. The top-level `defaultAgent` MUST stay the global value. `agents_projects` MUST NOT get the field. The capability `project-settings` gives the project values.

Tests: `test/projects.test.mjs`, `test/project-settings.test.mjs`

#### Scenario: No project value
- **WHEN** no setting gives `children.agent`, and the main agent calls `agents_list` and the action `list` of `agents_projects`
- **THEN** each directory of `agents_list` has `defaultAgent` `claude`, and no directory of `agents_projects` has the field

#### Scenario: A project value
- **WHEN** the global value of `children.agent` is `codex`, the project value of `children.agent` for the project `app` is `claude`, and `server` is a directory in `app`
- **THEN** the top-level `defaultAgent` of `agents_list` is `codex`, `app` and `server` have `defaultAgent` `claude`, and the directory `lib` has `defaultAgent` `codex`

### Requirement: Discovery of repositories
The action `discover` of `agents_projects` MUST give the git repositories in `~/src`, in `~/IdeaProjects` and in each root of `MEGACHAT_PROJECT_ROOTS`: a directory of a root, or a directory in a directory of a root, that holds a `.git` entry. It MUST NOT give a listed directory.

Tests: `test/discovery.test.mjs`

#### Scenario: Repositories at two levels
- **WHEN** the home directory has the repository `~/src/old`, the worktree `~/src/org/worktree` with a `.git` file, the repository `~/src/org/group/deep`, the directory `~/src/org/plain` without `.git`, the repository `~/IdeaProjects/idea`, and a root of `MEGACHAT_PROJECT_ROOTS` with the repository `extra`
- **THEN** `discover` gives `~/src/old`, `~/src/org/worktree`, `~/IdeaProjects/idea` and `extra`, and it does not give `~/src/org/group/deep` and `~/src/org/plain`

#### Scenario: A listed repository
- **WHEN** the user adds `~/src/old` and `discover` runs again
- **THEN** `discover` does not give `~/src/old`

### Requirement: Limits of the discovery scan
The scan MUST NOT go into a repository or a hidden directory, MUST follow no symbolic link, and MUST read no file. It MUST give at most 200 repositories, the newest change of `.git` first, and `truncated` when more exist. It MUST add nothing to the list.

Tests: `test/discovery.test.mjs`

#### Scenario: Repositories that the scan does not give
- **WHEN** the home directory also has the repository `~/src/old/nested` in the repository `~/src/old`, the repository `~/src/.hidden/secret`, and a symbolic link `~/src/link` to a repository
- **THEN** `discover` gives none of them, and it gives `~/src/org/worktree`, `extra`, `~/IdeaProjects/idea` and `~/src/old` in this order, the newest change of `.git` first, with `truncated` false

#### Scenario: More repositories than the limit
- **WHEN** the scan has a limit of 1 repository
- **THEN** it gives only `~/src/org/worktree`, and `truncated` is true

### Requirement: Setting projects.newRoot
The setting `projects.newRoot` MUST name the directory of a new project without a named location: an absolute path, `~`, or a path that starts with `~/`, and `~\` on Windows. It MUST refuse each other form, so the create can expand each value that the setting accepts. The default is `~/src`.

Tests: `test/discovery.test.mjs`

#### Scenario: The default root
- **WHEN** the setting `projects.newRoot` has no value and `create` gets the name `app`
- **THEN** the new project is `~/src/app`

#### Scenario: A relative path
- **WHEN** the user sets `projects.newRoot` to `relative/path`
- **THEN** the set fails with the code `settingValue`

### Requirement: Action create
The action `create` MUST make `<projects.newRoot>/<name>`, or `<name>-2` and so on when the name is taken, and add it to the known list. The name MUST be one directory name of at most 100 characters that is not hidden.

Tests: `test/discovery.test.mjs`

#### Scenario: A name that is taken
- **WHEN** `create` gets the name `app` two times, and then the name `old`, which a repository has
- **THEN** it makes `~/src/app`, `~/src/app-2` and `~/src/old-2`, and `~/src/app` is in the known list with the origin `known`

#### Scenario: Refused names
- **WHEN** `create` gets the name `../escape`, `.hidden`, `a/b`, an empty name, `-flag`, a name of 101 characters, or no name
- **THEN** it fails with the code `projectName`

### Requirement: Repeated create call
A run again of the same `create` call after a restart MUST give the directory of the first run and MUST make no second directory, also when the restart came between the `mkdir` and the state commit. The state MUST keep a bounded set of these records.

Tests: `test/discovery.test.mjs`

#### Scenario: A replay of a call
- **WHEN** the call `call-1` of `create` with the name `app` runs again with the same task
- **THEN** it gives `~/src/app`, the known list holds `~/src/app` one time, and no `~/src/app-2` exists

#### Scenario: A stop between the mkdir and the commit
- **WHEN** the state has the record of the call `call-2` with the empty directory `~/src/web`, and the call runs again
- **THEN** it gives `~/src/web`

#### Scenario: Many records
- **WHEN** the state has 300 old records and `create` runs one more time
- **THEN** the state keeps at most 101 records

### Requirement: Place of a new project
The root of a new project MUST be in the home directory or in a root of `MEGACHAT_PROJECT_ROOTS`, out of the state directory, and no directory below the home directory or below the root on its path may be hidden. The daemon MAY make a root that does not exist. Only a turn of the user MAY make a project.

Tests: `test/discovery.test.mjs`

#### Scenario: A root that does not exist
- **WHEN** `projects.newRoot` is `~/work/new/`, which does not exist, and `create` gets the name `tool`
- **THEN** it makes `~/work/new/tool`

#### Scenario: Refused roots
- **WHEN** `projects.newRoot` is a directory out of the home directory and out of the roots, `~/.config/projects`, a directory in the state directory, `~/src/.hidden/projects`, or `.cache/new` in a root
- **THEN** `create` fails with the code `newRoot` and makes no directory

#### Scenario: An automatic turn
- **WHEN** an automatic turn (`event`) calls `create` with the name `automatic`
- **THEN** the call fails with the code `proposalOnly`, and `~/src/automatic` does not exist

### Requirement: Project directory that the daemon cannot read
A project directory that the daemon cannot read MUST NOT stop the attach of a view or the registration of the other directories. This also applies to the working directory of `session/new` and `session/load`.

Tests: `test/integration.test.mjs`

#### Scenario: A deleted project directory
- **WHEN** a view attaches with the project directories `<project>/deleted`, which does not exist, and `<project>`
- **THEN** the attach completes, the state registers `<project>`, and it does not register `<project>/deleted`

#### Scenario: A deleted working directory
- **WHEN** a view calls `session/new` and then `session/load` with a working directory that does not exist
- **THEN** `session/new` gives a session ID that starts with `megachat-`, `session/load` sends a `session_info_update`, and the state does not register the directory

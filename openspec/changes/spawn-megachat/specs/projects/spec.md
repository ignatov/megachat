# Spec Delta

## MODIFIED Requirements

### Requirement: Listed directories
A child MUST work only in a listed directory: a project directory that a client registered, a known repository, or the workspace of Megachat. A task, a follow-up, a continued session, and a session search MUST refuse a directory that is not listed. In a project scope, only the directories of that scope MUST be listed (see the capability `project-scope`).

Tests: `test/projects.test.mjs`, `test/project-scope.test.mjs`

#### Scenario: A task in a directory that is not listed
- **WHEN** the main agent calls `agents_spawn` with the directory `~/src/repository`, which is not listed, or with a directory that does not exist
- **THEN** the tool fails with the error of a directory that is not listed, and the state has no run

#### Scenario: A session search
- **WHEN** a session search names the known repository `~/src/repository` by its absolute path or by its path with `~`, the workspace of Megachat, or a directory out of the home directory that is not listed
- **THEN** the search reads the sessions of the known repository and of the workspace, and it refuses the directory that is not listed with the code `workspace`

#### Scenario: A session search in a project scope
- **WHEN** a session search of the Megachat of the project `app` names the directory `other`, which an IDE has open
- **THEN** the search refuses the directory with the code `workspace`

### Requirement: Workspace of Megachat
The workspace of Megachat MUST be the directory `workspace` in the state directory. The daemon MUST make it at its start with the mode 0700. A task without a project works there. In a project scope, the workspace MUST NOT be a listed directory, so each task works in a directory of the project.

Tests: `test/projects.test.mjs`, `test/project-scope.test.mjs`

#### Scenario: The start of the daemon
- **WHEN** the daemon starts and the state has no project
- **THEN** the directory `workspace` in the state directory exists with the mode 0700, and `agents_list` gives it with the origin `megachat`

#### Scenario: A task in the workspace
- **WHEN** the main agent calls `agents_spawn` with the directory `workspace` in the state directory
- **THEN** the run has that directory as its working directory

#### Scenario: A task in the workspace of a project scope
- **WHEN** the main agent of the project `app` calls `agents_spawn` with the directory `workspace` in its state directory
- **THEN** the tool fails with the error of a directory that is not listed, and the state has no run

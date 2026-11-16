# Spec Delta

## MODIFIED Requirements

### Requirement: Path of a known repository
A known repository MUST be an absolute path or a path that starts with `~`. The state MUST keep its real path. That real path MUST be an existing directory, in the home directory or out of it, and it need not be a git repository. The refusals MUST use the real path, so a symbolic link MUST NOT lead into a refused directory.

Tests: `test/projects.test.mjs`, `test/discovery.test.mjs`

#### Scenario: A symbolic link in the home directory
- **WHEN** `~/inner-link` is a symbolic link to `~/src/repository`, `~/escape` is a symbolic link to a directory out of the home directory, and `~/ssh-link` is a symbolic link to `~/.ssh`
- **THEN** `~/inner-link` gives the real path of `~/src/repository`, `~/escape` gives the directory out of the home directory, and `~/ssh-link` is refused with the code `directory`

#### Scenario: Refused paths
- **WHEN** the path is `src/repository`, a file, or a directory that does not exist
- **THEN** the path is refused with the code `directory`

#### Scenario: A root out of the home directory
- **WHEN** `MEGACHAT_PROJECT_ROOTS` is empty, and the user names a directory out of the home directory, or `~/dev/notes`, which has no `.git` entry
- **THEN** both are accepted

### Requirement: Refused directories of a known repository
The root of the file system, the home directory and each directory that holds it, `~/Library`, the hidden directories directly in the home directory, and the state directory of Megachat with each directory in it MUST be refused. A repository that the user names MAY be in a hidden directory deeper in the home directory.

Tests: `test/projects.test.mjs`

#### Scenario: Directories that cannot be a known repository
- **WHEN** the path is `/`, the parent of the home directory, `~`, `~/Library/Application Support`, `~/.ssh`, `~/.jetbrains`, the state directory, or the directory `workspace` in the state directory
- **THEN** the path is refused with the code `directory`

## ADDED Requirements

### Requirement: Discovery in a named folder
With `cwd`, the action `discover` MUST scan only that folder with the rules and the limits of the discovery scan. The folder MUST pass the checks of a known repository. The result MUST have `folder` with its real path, `repository` and `listed`. A folder with a `.git` entry MUST give no repository in it.

Tests: `test/discovery.test.mjs`, `test/projects.test.mjs`

#### Scenario: A folder of the user
- **WHEN** `~/dev` holds the repository `app`, the worktree `group/api`, the directory `notes` without `.git`, the repository `.hidden/secret` and a symbolic link to a repository, and `discover` gets `cwd` `~/dev`
- **THEN** it gives `~/dev/group/api` and `~/dev/app`, `roots` is only `~/dev`, and `folder.repository` is false

#### Scenario: A folder that is a repository
- **WHEN** `discover` gets `cwd` `~/dev/app`
- **THEN** `folder.repository` is true, and it gives no repository

#### Scenario: Refused folders
- **WHEN** `discover` gets `cwd` `~`, `/`, `dev`, `~/absent` or the state directory
- **THEN** it fails with the code `directory`

#### Scenario: The roots of the variable
- **WHEN** `discover` runs without `cwd` and `MEGACHAT_PROJECT_ROOTS` holds a root with the repository `extra`
- **THEN** it gives `extra`

### Requirement: Add of several directories
With `cwds`, a list of at most 200 paths, the action `add` MUST add each accepted path in one transaction. It MUST give the new paths in `added`, and each refused path in `refused` with its code and its reason. When the list cannot hold all new paths, the call MUST add none. Only a turn of the user MAY add.

Tests: `test/discovery.test.mjs`

#### Scenario: A list with refused paths
- **WHEN** `add` gets `~/dev/app`, `~/dev/group/api`, `~/dev/notes`, `/`, `~/absent` and `~/dev/app` again
- **THEN** `added` holds the three directories one time each, and `refused` holds `/` and `~/absent` with the code `directory`

#### Scenario: The limit
- **WHEN** the known list holds 99 repositories and `add` gets two new paths
- **THEN** it fails with the code `projectLimit`, and the list keeps 99 repositories

#### Scenario: An automatic turn
- **WHEN** a turn of the kind `event` calls `add` with `cwds`
- **THEN** it fails with the code `proposalOnly`

### Requirement: Folder that the user names
The rules of the main agent and the setup question 3 MUST tell the agent: when the user names a folder, call `discover` with it. Add the folder itself when it is a repository or holds none, else add all its repositories in one call with `cwds`, but the excluded ones. They MUST forbid a refusal of a folder out of `~/src` or `~/IdeaProjects`.

Tests: `test/settings.test.mjs`, `test/projects.test.mjs`

#### Scenario: The setup text
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "the user can name a folder of their own, such as ~/dev" and "Do not refuse a folder because it is out of ~/src or ~/IdeaProjects, and do not ask for an environment variable."

#### Scenario: A turn with a named folder
- **WHEN** the user writes "they are in ~/dev", and the main agent calls `discover` with `cwd` `~/dev` and then `add` with `cwds` of the two found repositories
- **THEN** the known list holds `~/dev/app` and `~/dev/api`

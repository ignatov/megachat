# Spec Delta

## MODIFIED Requirements

### Requirement: Directories in agents_list
`agents_list` MUST give each listed directory one time with its origin: `ide`, `known`, or `megachat`. The workspace of Megachat MUST have the name "Megachat workspace". A linked git worktree MUST have `worktreeOf`, the real path of its main repository, and MUST follow that repository in the list. A listed main repository MUST have `worktrees`.

Tests: `test/projects.test.mjs`, `test/discovery.test.mjs`

#### Scenario: A directory with two origins
- **WHEN** an IDE registered the directories `outside` and `~/src/repository`, and the user adds `~/src/repository` and `~/second` as known repositories
- **THEN** `agents_list` and the action `list` of `agents_projects` give the workspace of Megachat with the origin `megachat` and the name "Megachat workspace", `outside` and `~/src/repository` with the origin `ide`, and `~/second` with the origin `known`

#### Scenario: A worktree in the list
- **WHEN** the list holds `~/src/main`, the worktrees `~/src/main-ide` of an IDE and `~/src/main-known`, and `~/src/old`
- **THEN** the worktrees have `worktreeOf` `~/src/main` and follow `~/src/main`, `~/src/main` has `worktrees`, and `~/src/old` has none

### Requirement: Discovery of repositories
The action `discover` of `agents_projects` MUST give the git repositories in `~/src`, in `~/IdeaProjects` and in each root of `MEGACHAT_PROJECT_ROOTS`: a directory of a root, or a directory in a directory of a root, that holds a `.git` entry. It MUST NOT give a listed directory. It MUST NOT give a linked git worktree as a repository (see the requirement "Worktrees of a repository").

Tests: `test/discovery.test.mjs`

#### Scenario: Repositories at two levels
- **WHEN** the home directory has the repository `~/src/old`, the directory `~/src/org/worktree` with a `.git` file that names no worktree, the repository `~/src/org/group/deep`, the directory `~/src/org/plain` without `.git`, the repository `~/IdeaProjects/idea`, and a root of `MEGACHAT_PROJECT_ROOTS` with the repository `extra`
- **THEN** `discover` gives `~/src/old`, `~/src/org/worktree`, `~/IdeaProjects/idea` and `extra`, and it does not give `~/src/org/group/deep` and `~/src/org/plain`

#### Scenario: A listed repository
- **WHEN** the user adds `~/src/old` and `discover` runs again
- **THEN** `discover` does not give `~/src/old`

### Requirement: Limits of the discovery scan
The scan MUST NOT go into a repository or a hidden directory, and MUST follow no symbolic link. It MUST read no file, but the small `.git` file of a worktree and its `commondir` and `gitdir` files. It MUST give at most 200 repositories, the newest change of `.git` first, and `truncated` when more exist. It MUST add nothing to the list.

Tests: `test/discovery.test.mjs`

#### Scenario: Repositories that the scan does not give
- **WHEN** the home directory also has the repository `~/src/old/nested` in the repository `~/src/old`, the repository `~/src/.hidden/secret`, and a symbolic link `~/src/link` to a repository
- **THEN** `discover` gives none of them, and it gives `~/src/org/worktree`, `extra`, `~/IdeaProjects/idea` and `~/src/old` in this order, the newest change of `.git` first, with `truncated` false

#### Scenario: More repositories than the limit
- **WHEN** the scan has a limit of 1 repository
- **THEN** it gives only `~/src/org/worktree`, and `truncated` is true

## ADDED Requirements

### Requirement: Worktrees of a repository
A directory is a linked git worktree when its `.git` file names a `worktrees` directory of a main repository and that directory names the file back. The check MUST spawn no git and MUST use real paths. `discover` MUST give a worktree in `worktrees` with `worktreeOf`, give it also in the `worktrees` of its main repository, and offer a main repository that is not listed.

Tests: `test/discovery.test.mjs`

#### Scenario: Detection
- **WHEN** a directory has a `.git` file of a worktree of `~/src/main`, or is a link to it, or is a submodule, a forged `.git` file, a bare repository, or a `.git` link
- **THEN** only the worktree and its link give `~/src/main`

#### Scenario: Discovery of worktrees
- **WHEN** `~/src` holds `erlang` with the worktrees `ie-wt-1` and `ie-wt-2`, the worktree `ultimate-2` of a repository out of the scan, and `known-wt` of the listed `known`
- **THEN** `discover` gives `erlang` and the other main repository, each with its `worktrees`, gives no worktree as a repository, and reports `known-wt` in `worktrees`

### Requirement: Add of worktrees
`add` with `cwds` MUST skip a linked worktree: it goes to `skipped` with `worktreeOf` and the reason "worktree of <main>". `add` with `cwd` alone MUST add one worktree that the user names, so a child can work in it. The stored list keeps its worktrees.

Tests: `test/discovery.test.mjs`

#### Scenario: A list and one path
- **WHEN** `add` gets `cwds` with `erlang`, `ie-wt-1` and `ie-wt-2`, and then `cwd` `ie-wt-1`
- **THEN** the first call adds `erlang` and skips both worktrees, and the second call adds `ie-wt-1`, which `agents_list` gives under `erlang`

### Requirement: Agent text about worktrees
The rules of the main agent and the setup question 3 MUST tell the agent to add the main repository, to tell the user "N worktrees are glued to <repository>", and to add one worktree alone only when the user names it exactly.

Tests: `test/settings.test.mjs`

#### Scenario: The setup text
- **WHEN** a test reads `resources/instructions-onboarding.md`
- **THEN** it holds "N worktrees are glued to <repository>" and "Add one worktree alone only when the user names it exactly"

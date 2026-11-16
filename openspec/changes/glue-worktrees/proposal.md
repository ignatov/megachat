# Proposal

## Why

The first discovery of a folder of the author, `~/src`, gave 14 "repositories". Nine of them were linked git
worktrees of other repositories: `ie-wt-*`, `ultimate-2`, `ultimate-3` and `intellij-erlang-worktree`. The main agent
would add all of them, and the known list would hold many directories for one project. The author asked: "glue the
worktrees too".

## What Changes

Where it shows: the chat (the tools `agents_projects` and `agents_list`, the setup question 3 and the rules of the main
agent). No ACP extension changes, so Air needs no change.

- **Detect a linked worktree.** A directory with a `.git` file `gitdir: <main>/.git/worktrees/<name>` is a worktree.
  Its main repository comes from the file `commondir`. The check reads two small files, spawns no git and uses real
  paths.
- **discover.** A worktree is not a repository to add. It goes to `worktrees` with `worktreeOf`, and its main
  repository has it in its own `worktrees`. A main repository that is not listed and not in the scan is offered.
- **add with `cwds`.** A worktree goes to `skipped` with the reason "worktree of <main>". `add` with `cwd` alone adds
  one worktree that the user names exactly, so a child can still work in it.
- **The list.** A worktree in the list has `worktreeOf`, it follows its main repository, and the main repository has
  `worktrees`. A worktree stays in the stored list, because it is a directory where a child works. This also holds for
  a worktree that an IDE registered and for a known worktree that an older build added.
- **The rules of the main agent.** The agent adds the main repository and tells the user "N worktrees are glued to
  <repository>".

## Capabilities

### Modified Capabilities

- `projects`: "Directories in agents_list", "Discovery of repositories" and "Limits of the discovery scan" change.
  "Worktrees of a repository" is new.

## Out of scope

- No migration of the known list: a known worktree stays, and the list shows it under its main repository.
- No `git` command, no bare repository and no submodule: they have no main directory, so they stay repositories.
- No change of the tool `agents_spawn`: a task in a worktree names the worktree.

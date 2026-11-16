# Design

## Context

`discoverRepositories` gives each directory with a `.git` entry, also a `.git` file. `addProjects` adds each accepted
path. `directoriesOf` gives each listed directory with its origin.

## Decisions

1. **Detection by files.** `mainRepositoryOf(directory)` in `src/ProjectDirectories.mjs` is synchronous. The `.git`
   entry must be a file, not a link. Its line `gitdir:` must name a directory `…/worktrees/<name>`. The file
   `commondir` there gives the `.git` directory of the main repository, and the file `gitdir` there must name the
   `.git` file of the checked directory again, so a copied file is no worktree. The main repository is the parent of
   that `.git` directory. A submodule, a bare repository and a broken link give `undefined`. A file of more than 4096
   characters is not read.
2. **discover.** A found worktree moves to `worktrees: [{cwd, worktreeOf}]`, and its main repository gets
   `worktrees: [cwd]`. A main repository that the scan did not find is offered with the time of its own `.git`, when
   it is not listed and `resolveRepository` accepts it. A listed worktree stays out, as any listed directory does.
   `folder.worktreeOf` tells that a named folder is a worktree.
3. **add.** `addProjects` puts a worktree in `skipped`, with `worktreeOf` and the text `worktree.skipped`. The call
   `add` with `cwd` alone calls `addProject`, which accepts a worktree. A `cwd` together with `cwds` is one list.
4. **List.** `directoriesOf` sets `worktreeOf` on each listed worktree, sets `worktrees` on each listed main
   repository, and puts the worktrees after their main repository. The stored lists keep the worktrees, so the setting
   `children.agent` of a worktree, a task in it and the session search in it work as before. The flat shape of the
   entries stays, so the morning report and the session index need no change.

## State

No new field. An older state directory needs no migration.

## ACP

No ACP message and no `_meta` key changes.

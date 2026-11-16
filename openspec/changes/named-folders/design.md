# Design

## Context

`resolveRepository` accepted only a real path in the home directory or in a root of `MEGACHAT_PROJECT_ROOTS`.
`discoverRepositories` scanned only `~/src`, `~/IdeaProjects` and the roots. The tool `agents_projects` added one
directory in each call.

## Decisions

1. **The refusals stay, the allowed places go.** `resolveRepository` accepts each existing directory and refuses the
   root of the file system, the home directory and each directory that holds it, the application data and the hidden
   directories directly in the home directory, and the state directory and each directory in it or that holds it. The
   checks use the real path, so a symbolic link cannot lead into a refused directory. Only a turn of the user can add,
   as before. `createProjectDirectory` keeps its own check (`allowedLocation`) with the roots.
2. **The same scan for a named folder.** `discoverRepositories` takes `folder`, a real path from `resolveRepository`,
   and scans only it. A folder with a `.git` entry gives `folder.repository` true and no scan into it.
3. **One transaction for several paths.** `MegachatState.addProjects(paths)` resolves each path first, then commits the
   new ones in one `change`. The limit of 100 applies to the whole call. A `cwds` list has at most 200 items, the
   discovery limit.
4. **No setting.** The known list already keeps the repositories. A setting of roots would add a second list for the
   user to manage.

## State

No new field. `state.projects` of `conversation.sqlite` keeps the real paths as before. An older state directory needs
no migration. A known repository out of the home directory, which a root admitted, stays valid.

## ACP

No ACP message and no `_meta` key changes.

# Proposal

## Why

The setup of a colleague came to a dead end. Question 3 of the setup found no repository in `~/IdeaProjects`. The user
answered "they're in ~/dev". The main agent refused: it can scan only `~/src`, `~/IdeaProjects` and the roots of
`MEGACHAT_PROJECT_ROOTS`, and it asked the user for the paths one by one. A user must not need an environment
variable to tell Megachat where the projects are.

The author decided on 2026-11-16: "let people add their own folders easily", with minimum ceremony and no system of
roots.

## What Changes

Where it shows: the chat (the tool `agents_projects`, the setup question 3, the rules of the main agent) and
`README.md`. No ACP extension changes, so Air needs no change.

- **A named folder.** `agents_projects(action="discover", cwd)` scans only the folder that the user named, with the
  rules of the discovery of today: two levels, no hidden directory, no symbolic link, no file read, at most 200. The
  result tells whether the folder itself is a repository.
- **Several directories in one call.** `agents_projects(action="add", cwds)` adds a list of directories in one
  transaction. A refused path goes to `refused` with its reason, and the other paths go to the list. When the list
  cannot hold them all, the call adds none.
- **Each directory that the user names.** A known repository can be each existing directory, also out of the home
  directory and also one that is no git repository. The refused directories are the root of the file system, the home
  directory and each directory that holds it, `~/Library`, the hidden directories directly in the home directory, and
  the state directory. `MEGACHAT_PROJECT_ROOTS` no longer limits a known repository.
- **The rules of the main agent.** The setup question 3 and the general rules say: when the user names a folder, scan
  it, add the folder itself when it is a repository or holds none, else add all its repositories in one call but the
  excluded ones, and show the added list. The agent does not refuse a folder out of `~/src` or `~/IdeaProjects`.

## Capabilities

### Modified Capabilities

- `projects`: "Path of a known repository" and "Refused directories of a known repository" change. "Discovery in a
  named folder", "Add of several directories" and "Folder that the user names" are new.

## Out of scope

- No new setting. `MEGACHAT_PROJECT_ROOTS` stays for the discovery without a folder and for `projects.newRoot`. A later
  discovery without a folder does not scan `~/dev` again. The known list keeps the added repositories.
- No change of `projects.newRoot` and of the action `create`.
- No change of a non-goal.

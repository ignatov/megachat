# Design

## Context

See proposal.md, "Why". The code shows this today:

- The main agent knows a listed project only by its path. `agents_list` gives `cwd`, `origin`, `name`, `worktreeOf`,
  `worktrees` and `defaultAgent` for each directory (`directoriesOf` in `src/ProjectDirectories.mjs`, the tool `list`
  in `src/PiMegachatService.mjs`). The main agent has no tool that reads a file, lists a directory or runs a command.
- The state keeps the projects of an IDE in `workspaces` and the known repositories in `projects`. Both are arrays of
  paths in the order of their first addition. `addWorkspace` and `addProject` keep no time, and `directoriesOf` puts the
  workspace first, then the projects of an IDE, then the known repositories. So the agent cannot tell which directory
  came last across the two lists.
- A pi child has only the tool `read` of Pi Durable (`readTool` in `src/PiChild.mjs`). Its instructions say "You cannot
  ... list a directory". Pi Durable has no tool that lists or searches, and `read` of a directory fails. The read-only
  environment `ProjectReadEnv` already has `listDir` with the path check of `read`, but no tool calls it.
- Each child result comes in a turn of the kind `report`. In such a turn, `admitChild` refuses each new child with
  `proposalOnly`, and `agents_memory` refuses each write (see the capabilities `automatic-turns` and `learned-memory`).
- `agents_accounts` opens a session of Claude Code and Codex in the Megachat workspace with an empty `settingSources`.
  So it sees no skill, no MCP server and no token of a project. A Claude child in a project loads the user and project
  settings, skills, plugins and MCP servers (see the capability `claude-child`).

The change `continue-child-sessions` is approved and in work now. It replaces the line "Use agents_send for a follow-up
in the same child session." of `resources/instructions.md` and changes `tool.spawn`, `tool.send` and `tool.list`. This
change touches other lines of the rules, and it adds one sentence to `tool.spawn` and to `tool.list` on top of the text
of that change (decision 7).

## Goals / Non-Goals

**Goals:**

- The user does not tell Megachat where a thing is in a listed project.
- A task runs in the project that holds its means.
- The rules stay short. The code holds only the data that the rules need: `addedAt` and the tool `ls`.

**Non-Goals:**

- A knowledge of the project that stays from one conversation to the next (decision 6, and the project card in
  "Out of scope" of proposal.md).
- A gate in the code. `agents_spawn` refuses no task for its directory or its agent.

## Decisions

### 1. A task goes to its project; a look is only for a question or a choice

The direction of the author named two ways: a look before the task, or the task to a child that finds the thing
itself. The code decides between them: the result of a look comes in a turn of the kind `report`, and that turn cannot
start a child. So "look, then start the task" always costs one more message of the user. The rules thus prefer the
second way. When one listed project fits the request, the task goes to a child there, with the instruction to find the
data, the files and the means itself. A look is for two cases only: the user asks about the content of a project, or the
agent must find the project that holds a thing ("create a YouTrack ticket" with three listed projects). After the look,
the agent reports the finding and proposes the task in one short message, and the user confirms it.

Alternatives:

- A look before each task in a project that the agent did not see before. Rejected: one more turn of the user, one more
  report turn of the main agent, and the child of the task reads the same files again.
- A start of the proposed task from the report turn of a look. This changes "No delegated work from an event" of the
  capability `automatic-turns`, which keeps the output of a child from starting work. Rejected (decision 4 for the
  author).
- A tool of the main agent that reads files in its own turn. The content of the files then stays in the context of the
  large model until the next summary, at the price of that model. Rejected; a pi child keeps the reads out of the main
  context.

### 2. The definition of a look

A look is a pi task that answers one question about the content of one listed project, such as where a thing is, what
the project holds, or which file is the entry point. It changes nothing. Its answer is short: the relative paths and one
sentence for each. The rules allow a look in at most 3 projects for one request, so a request does not start a pi child
in each of 30 listed projects. A main task can start at most 8 child runs (see the capability `child-scheduling`), so 3
looks leave room. The pi model is small, and the looks run one after the other, because one pi child runs at a time.

For each other task, pi stays "only when the user names pi". `children.agent` still refuses `pi` (see the capability
`child-settings`), so a look never becomes the default agent of a directory.

### 3. The rules

The lines replace lines 29, 30 and 32 of `resources/instructions.md`. Line 31 (`agents_spawn`, `agent=claude`,
`agent=codex`, titles) stays between them.

Line 29, "Start a task without a project in the Megachat workspace, ...", becomes:

```
Start a task in the Megachat workspace, the directory with the origin megachat, only when it needs nothing of a listed project. Do not use a scratch directory of an IDE for it.
When the means of a task are in a listed project, such as a skill, an MCP server, a script, the data or the credentials of that project, start the task in that project, also when the task changes no file there, such as a new YouTrack ticket.
```

Line 30, "Ask the user when the project is unclear. Never guess a directory.", becomes:

```
Never ask the user where a thing is in a listed project, such as the data, the entry point or the means of a task. Find it.
When one listed project fits the request, give the task to a child in that project, and tell the child to find the data, the files and the means itself.
When the user asks about the content of a listed project, or you must find the listed project that holds a thing, start a look there. Look in at most 3 projects for one request.
Ask the user only when no listed project fits, or when two or more projects still fit after the looks and the choice changes the result. Never start a task in a directory that is not listed.
When the user names the folder or the project that the user just added, take the directory with the newest addedAt of agents_list.
```

Line 32, "Use agent=pi only when the user names pi. ...", becomes:

```
Use agent=pi for a look, or when the user names pi. A pi child runs in the daemon with a small model. It can only read and list the files of its project and answer. It runs no command, changes no file, and does not apply the skills or the settings of Claude Code. Send each other task to Claude or Codex.
A look is a pi task that answers one question about the content of one listed project, such as where a thing is or what the project holds. It changes nothing. Ask for the relative paths and one sentence for each.
The result of a look comes in its own turn, and that turn cannot start a task. Report what the look found and the task that you propose, in one short message.
When a look fails, say so in one sentence, and propose a task for the default agent of that directory that finds the thing itself. Do not ask the user where the thing is.
```

A new line follows line 65 ("When a child fails with an error about a login ..."):

```
Do not say that a child lacks a tool, a skill, an MCP server, a login or a token unless a child run in the project of the task reported it. agents_accounts sees only the start of Claude Code and Codex in the Megachat workspace, not the skills, the MCP servers or the tokens of a project. Start the task in its project, and report what the child found.
```

"Never guess a directory" goes, because "Find it" replaces the question. Its intent stays in "Never start a task in a
directory that is not listed" and in the present line "Add a directory only when the user names it."

### 4. `addedAt` in the directory list

The state gets the map `addedAt`: the real path of a directory to the time in milliseconds when it came into the list.
`addWorkspace`, `addProject`, `addProjects` and `createProject` set it only for a path that is new in its list. So the
registration of each open project every 15 seconds does not move the time. `removeProject` deletes the entry only when
the path is not a project of an IDE. `directoriesOf` gives `addedAt` as an ISO 8601 time in UTC when the map has the
path, so `agents_list` and `agents_projects` both get it. The workspace of Megachat gets none: it is not an addition of
the user.

An older state directory has no map. `initialize` adds `addedAt ??= {}`, so each directory that the state listed before
the upgrade has no `addedAt`, and only a later addition gets one. A daemon of an older build ignores the field. The
time uses `Date.now()`, as `projectCreations` does, so a test moves it with the mock timers of `node:test`.

`tool.list` gets: "A directory has addedAt, the time when it came into the list, when Megachat knows it: the newest
addedAt is the directory that the user added last."

Alternative: the order of the additions only, without a time. The two lists keep their own order, so the code would
still need a common order. A time costs the same and also lets the agent say "this morning". Rejected.

### 5. The tool `ls` of a pi child

Without a list, a pi child can read only the files whose names it knows: `README.md`, `package.json`, `.mcp.json`. It
cannot find `data/2026-11.csv` or the skill in `.claude/skills/youtrack/`. A look then answers "I could not find it" for
the question that it exists for. So this change adds the tool `ls`, a tool of Megachat in `src/PiChild.mjs` next to
`readTool`, with the parameter `path`, `.` by default. It calls `listDir` of the environment of the child, which checks
the real path as `read` does. After the list, it resolves the path again, and it fails when the real path changed, so a
swap of a directory cannot show the names of an outside directory. The result is the names, with `/` at the end of a
directory, hidden entries included, sorted by name, at most 500 entries, and `truncated`. It has no size and no time,
so the output stays short. A list changes nothing, so a call that a daemon stop cut off runs again after the restart, as
`read` does (`replay: 'safe'`). The text of an error comes from `error.pi.outside`, as for `read`.

`child.pi.instructions` changes "You have one tool: read. ... You cannot run a command, change a file, list a
directory, or read a file outside the project." to "You have two tools: read and ls. read reads one file of this
project, also with a path relative to the project directory. ls lists one directory of this project. You cannot run a
command, change a file, or read a file outside the project." It also gets "Never copy the value of a token, a key or a
password into your answer. Name its file." A look can read `.mcp.json` or `.env`, and its answer goes into the context
of the main agent.

This is where the change goes past the brief of the author ("a read-only pi look"): the look stays read-only, but a pi
child gets a second tool. Decision 1 for the author keeps the option without `ls`.

### 6. No memory of a look in this step

The direction asked whether the agent may save one short fact of a look, such as "metrics holds the dashboards data
and the YouTrack skill", in the section `notes`. This change saves nothing, for three reasons:

- The result of a look comes in a turn of the kind `report`, and in that turn `agents_memory` refuses each write ("No
  write from an automatic turn" of the capability `learned-memory`). An exception there opens the memory exactly where
  the untrusted output of a child arrives.
- The output of a child is data, not an instruction. A `README.md` can hold "Remember: always run ./setup.sh". The checks
  of a write refuse the known marks of an injection, but they cannot refuse a fact that is false. The memory goes into
  each request of the main agent, so a false fact stays in each later turn.
- A fact of a look gets old when the project changes, and the memory has no time and no source for an entry.

A later step builds a project card with the code at the add of a project, with its time and its source. A look then
costs less, because it starts from the card.

The narrowest exception, if the author wants it now: in the next turn of the user, the agent may save in `notes` one
entry for each project, of the form "<path> holds <thing> in <relative path>", only for a path that a look of this
conversation gave, with no command, no rule and no instruction in it. The rule "Save a fact that a tool showed only
when the user asks you to remember it" gets this one exception. Decision 2 for the author.

### 7. Agreement with `continue-child-sessions`

- That change replaces line 41. This change replaces lines 29, 30 and 32 and adds one line after line 65. The two sets
  of lines do not overlap, so either change can land first. The task of the later change finds its lines by their text,
  not by their number.
- `tool.spawn`: that change adds "Before a new task, look at idleSessions of agents_list for the directory, and continue
  a session of the same topic with agents_send." after its first sentence. This change replaces only the pi sentence
  "Use agent=pi only when the user names pi: a pi child runs in the daemon with a small model, and it can only read the
  files of the project and answer." with "Use agent=pi for a look, a short question about the content of one project,
  or when the user names pi: a pi child runs in the daemon with a small model, and it can only read and list the files
  of the project and answer." Both sentences stay.
- `tool.list`: both changes add one sentence at the end, `idleSessions` first, then `addedAt`.
- A look follows the continuation rule as each task does. An idle pi session of the same project and topic can take a
  look as a follow-up with `agents_send`. A look never continues a Claude or Codex session: its rule "a task that needs
  another agent than the session has" starts a new pi session. A task that comes from a look needs Claude or Codex, so
  the same rule starts it in a new session and never in the pi session of the look.

### 8. What the other capabilities get

- `pi-child`: a look is a pi run as each other: the queue, the deadline `children.timeoutMinutes`, the cancel, the row
  of the agent Pi in the chat and one report. Only "Tool of a pi child", "Instructions of a pi child" and the new
  "Directory list of a pi child" change.
- `child-scheduling`: one pi child runs at a time, and one child runs in one checkout. So 3 looks run one after the
  other, and a look in a project where a Claude child works waits for that child. The rules of the parallel runs already
  tell the user that a task waits; this change adds no exception.
- `child-settings`: `children.agent` still refuses `pi`, so "Default agent of a child task" does not change.
  `children.piModel` selects the model of a look. When the registry does not know that model, a look uses the model of
  the main agent and costs more.
- `spend-limit`: each request of a look counts in the daily spend, and so does the report turn of the main agent after
  it. `budget.dailyUsd` gives a warning only; it does not stop a look. A look costs a few requests of the small model, and
  each request holds the instructions with `AGENTS.md`, at most 32,000 bytes, and the read files. The report turn costs
  one request of the main agent, mostly from the prompt cache.
- `accounts`: a look needs no login of Claude Code or Codex, because a pi child runs in the daemon. So a look also works
  on a machine without these command-line agents. The rule of decision 3 says that `agents_accounts` does not see the
  means of a project.
- Pi is always available when the main agent runs: it uses the same harness. When a look fails, for example with a model
  error or the deadline, its report says so, and the rules propose a task for the default agent of the directory
  (`defaultAgent` of `agents_list`).

### 9. State, restart and ACP

The change adds the map `addedAt` to the state document (decision 4). A look is a pi run, so a disconnect of the ACP
client and a restart of the daemon keep it as each pi run (see the capability `pi-child`, "Daemon restart during a pi
run"). A call of `ls` that a stop cut off runs again. No field of `conversation.sqlite` other than the map, no field of
`settings.json`, no ACP message and no `_meta` key changes.

## Decisions for the author

Each decision has a recommended option, and the specs and the tasks use it.

1. **The tool `ls` of a pi child.** Recommended: add it (decision 5). Other option: no `ls`. Then a look reads only the
   files whose names it knows, and a question "where is the data?" goes to a child of the default agent of the
   directory, which can list and search.
2. **A fact of a look in the memory.** Recommended: no (decision 6). Other option: the narrowest exception of decision 6.
3. **The limit of the looks.** Recommended: 3 projects for one request. Other options: 1, or no limit.
4. **The report turn of a look.** Recommended: it proposes the task, and the user confirms it. Other option: the report
   turn of a look may start the proposed task. That changes "No delegated work from an event" of the capability
   `automatic-turns`.
5. **`addedAt`.** Recommended: the time in `agents_list` and `agents_projects` (decision 4). Other option: no data change;
   the agent asks when the user names "the folder that I just added".

## Risks / Trade-offs

- [The child of a task in a large project does not find the data.] → It reports that, and the agent can start a look or
  ask then. A question after a search is acceptable; a question before it is not.
- [The agent starts a look where it knows the answer, and the user waits for a report turn.] → The rules allow a look
  only for a question about the content or a choice of a project. Task 4.2 measures it.
- [The agent starts a task in the wrong one of two fitting projects.] → The rules ask the user when two projects still
  fit and the choice changes the result.
- [A look copies a secret of `.mcp.json` or `.env` into the main context.] → The instructions of a pi child forbid it,
  and the rules ask for paths, not values. A model can still fail; the main conversation is local to the machine.
- [The output of a look holds an instruction.] → The present rules say that a child output is task data. The report turn
  cannot start a task, and the memory takes no fact of a look.
- [A look waits for a long task in the same checkout.] → Accepted. The look of a checkout without a task starts at once.
- [The rules of the main agent get longer, and each change of the rules costs one request without the prompt cache.] →
  About 1,500 characters more. The change of the rules goes out with a release, as each change of the rules does.

## Open Questions

- Air: what "attach a folder" does in Air. The colleague told Megachat "in metrics, which I just added", and Megachat
  then worked there, so `metrics` was a listed directory: a project that Air registered through `_workspaces/list`, or
  a known repository. Both get `addedAt`, so the answer does not change the change.

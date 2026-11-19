# Proposal

## Why

A colleague of the author wrote on 2026-11-18: "чат долго учится где что лежит + добавление проекта не дает мегачату
знания про него и ему нужно про него рассказать" (the chat learns for a long time where things are, and an added
project gives Megachat no knowledge of it, so the user must tell it about the project). His examples: "я заатачил
фолдер "metrics" говорю иди рисуй график, он такой а где данные брать? я ему говорю "в метрикс что я сейчас добавил""
(I attached the folder "metrics" and asked for a chart, it asked where to get the data, and I said "in metrics, which
I just added"), and "я говорю "иди создай тикет в ютреке" - а он в metrics лежит" (I asked it to create a YouTrack
ticket, but the means for that are in metrics). Also: "мегачат не в курсе что за скиллы / мср доступны дочерним
агентам. В клоде был ютрек токен, но мегачат говорит что его нет" (Megachat does not know which skills and MCP servers
the children have; Claude had a YouTrack token, but Megachat said that there is none). The author answered on
2026-11-18: "онбординг давай сделаем удобный" (let us make the onboarding easy) and "надо сделать поактивней" (it must
be more active). On 2026-11-19 the author approved this smallest step, and allowed the main agent to start a read-only
pi look without a request that names pi.

The main agent knows only the path of a listed project. It has no tool that reads a file, lists a directory or runs a
command. Three rules then make it ask the user or work in the wrong place: "Ask the user when the project is unclear",
"Use agent=pi only when the user names pi", and "Start a task without a project in the Megachat workspace". In the
Megachat workspace, the skills, `.mcp.json` and `.claude/settings*.json` of a project do not load, so a task whose
means are in the project `metrics` runs without them. The agent also cannot see the environment or the configuration
of a child, so "there is no token" without a child run is a claim that it did not check. The order of the additions is
in the state, but no time is, and `agents_list` gives neither, so "the folder that I just added" has no answer in the
data. Also a pi child has only the tool `read`: it cannot list a directory, so it cannot find a file whose name it does
not know.

## What Changes

Where it shows: the chat (fewer questions "where is it?", a task that starts in the right project, a short report of a
look), the task list of Air (a background task of the agent Pi for a look), and the log of the daemon (`started` lines
with `agent=pi`). No ACP extension changes, so Air needs no change.

- **No question where a thing is.** The main agent never asks the user where a thing is in a listed project, such as
  the data, the entry point or the means of a task. When one listed project fits the request, it gives the task to a
  child in that project and tells the child to find the data, the files and the means itself.
- **A look.** When the user asks about the content of a listed project, or the agent must know which listed project
  holds a thing, the agent starts a look: a pi task in one listed project that answers one question about its content,
  changes nothing, and gives a short answer with relative paths. The agent may start a look without a request that
  names pi, in at most 3 projects for one request. For each other task, pi stays "only when the user names pi".
- **A question only when it decides something.** The agent asks the user only when no listed project fits, or when two
  or more projects still fit after the looks and the choice changes the result. It never starts a task in a directory
  that is not listed.
- **The task runs where its means are.** When the means of a task are in a listed project, such as a skill, an MCP
  server, a script, the data or the credentials of that project, the task starts in that project, also when it changes
  no file there. The Megachat workspace stays for a task that needs nothing of a listed project.
- **The directory that the user added last.** Each directory of `agents_list` and of `agents_projects` gets `addedAt`,
  the time when it came into the list, when Megachat knows it. For "the folder that I just added", the agent takes the
  directory with the newest `addedAt`.
- **No claim without a check.** The agent does not say that a child lacks a tool, a skill, an MCP server, a login or a
  token unless a child run in the project of the task reported it. It starts the task in its project and reports what
  the child found.
- **A pi child lists a directory.** A pi child gets a second read-only tool, `ls`: it lists one directory of its
  project, with the same path checks as `read`. Its instructions tell it never to copy the value of a token, a key or a
  password into its answer.
- **The texts.** `resources/instructions.md`, `tool.spawn`, `tool.list` and `child.pi.instructions` change. `README.md`
  tells about the look, `ls`, `addedAt` and the place of a task.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `delegation`: "Agent of a delegated task" is MODIFIED: the main agent may start a pi child for a look without the
  name pi. "Look before a question", "Question that decides something", "Definition of a look", "Task in the
  project of its means", "Directory that the user added last" and "No claim about a child without a run" are new.
- `pi-child`: "Tool of a pi child" and "Instructions of a pi child" are MODIFIED: the tool `ls`, and no copy of a
  secret value. "Directory list of a pi child" is new.
- `projects`: "Time of the addition of a directory" is new.

## Out of scope

- A project card that Megachat builds when a project is added, and shows in `agents_list`. It is the next step.
- An inventory of the skills, the plugins and the MCP servers of the children. A pi child cannot see the skills and
  the MCP servers of the user, and a Claude child in a project loads them (see the capability `claude-child`).
- A save of a fact that a look showed in the learned memory (see design.md, decision 6, and decision 2 for the author).
- A start of the proposed task from the turn of the result of a look. That turn stays an automatic turn that starts no
  delegated work (see the capability `automatic-turns`), so the user confirms the task.
- A look that the main agent waits for in its own turn, and a tool of the main agent that reads files.
- A look in a checkout where another task works. The look waits, as each task does (see the capability
  `child-scheduling`).
- No new setting. The limit of 3 looks for one request is a rule of the main agent, and the limit of 500 entries of
  `ls` is a constant.
- No change of `children.agent`: it still refuses `pi` (see the capability `child-settings`).
- The change touches the non-goal "A pi child does not run a command, change a file, or apply the skills and the
  settings of Claude Code" only to confirm it: `ls` reads the names of a directory and changes nothing.

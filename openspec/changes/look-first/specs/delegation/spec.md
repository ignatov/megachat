# Spec Delta

## MODIFIED Requirements

### Requirement: Agent of a delegated task
The user MAY delegate a task to Claude Code or Codex, and a task that only reads files to a pi child. The main agent MAY start a pi child for a look without a request that names pi. For each other task, the rules MUST allow pi only when the user names it. Claude Code MUST remain the default for delegated tasks unless the setting `children.agent` selects Codex.

Tests: `test/integration.test.mjs`, `test/look-first.test.mjs`

#### Scenario: A task for Codex
- **WHEN** the main agent calls `agents_spawn` with the agent `codex`
- **THEN** the daemon launches a Codex child, and the run has the agent `codex`

#### Scenario: A task without a named agent
- **WHEN** the main agent calls `agents_spawn` without an agent
- **THEN** the child is a Claude Code child, and the description of its row in the chat starts with `Claude · ` and the name of the project

#### Scenario: The rules of the agent of a task
- **WHEN** a test reads `resources/instructions.md` and the description of `agents_spawn`
- **THEN** the rules hold "Use agent=pi for a look, or when the user names pi." and "Send each other task to Claude or Codex.", and the description of `agents_spawn` holds "Use agent=pi for a look"

## ADDED Requirements

### Requirement: Look before a question
The rules of the main agent MUST forbid a question to the user about where a thing is in a listed project. When one listed project fits, they MUST tell the agent to give the task to a child there, which finds the thing itself. For a question about the content of a listed project, or to find the project that holds a thing, they MUST tell it to start a look, in at most 3 projects for one request.

Tests: `test/look-first.test.mjs`

#### Scenario: The rules of a look
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "Never ask the user where a thing is in a listed project", "tell the child to find the data, the files and the means itself." and "Look in at most 3 projects for one request."

### Requirement: Question that decides something
The rules of the main agent MUST tell it to ask the user only when no listed project fits, or when two or more projects still fit after the looks and the choice changes the result. They MUST forbid a task in a directory that is not listed.

Tests: `test/look-first.test.mjs`

#### Scenario: The rules of a question
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "Ask the user only when no listed project fits, or when two or more projects still fit after the looks and the choice changes the result." and "Never start a task in a directory that is not listed.", and it does not hold "Ask the user when the project is unclear."

### Requirement: Definition of a look
The rules MUST define a look: a pi task that answers one question about the content of one listed project, changes nothing, and answers with the relative paths and one sentence for each. They MUST say that the result of a look comes in its own turn, which cannot start a task, so the agent reports the finding and proposes the task. A failed look MUST lead to a proposal of a child of the default agent, not to a question where the thing is.

Tests: `test/look-first.test.mjs`

#### Scenario: The definition of a look
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "A look is a pi task that answers one question about the content of one listed project", "the relative paths and one sentence for each", "The result of a look comes in its own turn, and that turn cannot start a task." and "When a look fails"

### Requirement: Task in the project of its means
The rules MUST tell the agent to start a task in the listed project that holds its means, such as a skill, an MCP server, a script, the data or the credentials of that project, also when the task changes no file there. They MUST keep the Megachat workspace for a task that needs nothing of a listed project.

Tests: `test/look-first.test.mjs`

#### Scenario: The rules of the place of a task
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "start the task in that project, also when the task changes no file there" and "Start a task in the Megachat workspace, the directory with the origin megachat, only when it needs nothing of a listed project."

### Requirement: Directory that the user added last
The rules MUST tell the agent to take the directory with the newest `addedAt` of `agents_list` when the user names the folder or the project that the user just added. The time of the addition is in the capability `projects` ("Time of the addition of a directory").

Tests: `test/look-first.test.mjs`

#### Scenario: The rule of the newest directory
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "take the directory with the newest addedAt of agents_list."

### Requirement: No claim about a child without a run
The rules MUST forbid a statement that a child lacks a tool, a skill, an MCP server, a login or a token unless a child run in the project of the task reported it. They MUST say that `agents_accounts` does not see the skills, the MCP servers or the tokens of a project, and tell the agent to start the task in its project and report what the child found.

Tests: `test/look-first.test.mjs`

#### Scenario: The rule of a claim
- **WHEN** a test reads `resources/instructions.md`
- **THEN** it holds "Do not say that a child lacks a tool, a skill, an MCP server, a login or a token unless a child run in the project of the task reported it." and "Start the task in its project, and report what the child found."

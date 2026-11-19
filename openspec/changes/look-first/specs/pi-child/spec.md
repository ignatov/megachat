# Spec Delta

## MODIFIED Requirements

### Requirement: Tool of a pi child
A pi child MUST have only the tools `read` and `ls`. It MUST get none of the `agents_*` tools, not the rules of the main agent, not the section `settings`, not the instructions of the user, and not the hooks of the main agent.

Tests: `test/pi-child.test.mjs`

#### Scenario: The request of a pi child
- **WHEN** a pi child runs
- **THEN** each request of the child has only the tools `read` and `ls` and only the section `instructions`, and the instructions hold no rule of the main agent

### Requirement: Instructions of a pi child
The instructions of a pi child MUST say what it can do, name the tools `read` and `ls`, and tell it never to copy the value of a token, a key or a password into its answer. They MUST hold the content of `AGENTS.md` of the directory of the run, else of `CLAUDE.md`, at most 32,000 bytes, marked as the rules of the repository. A rules file that is not a regular file, such as a FIFO, MUST NOT count, and its read MUST NOT wait.

Tests: `test/pi-child.test.mjs`

#### Scenario: The rules of the repository
- **WHEN** a pi child runs in a directory whose `AGENTS.md` holds "Name each file that you read."
- **THEN** the instructions of the child hold that text in `<repository_rules file="AGENTS.md">`

#### Scenario: An AGENTS.md that is a FIFO
- **WHEN** the `AGENTS.md` of the directory of the run is a FIFO
- **THEN** the pi child starts and completes, and its instructions hold no repository rules

#### Scenario: The tools and the secrets in the instructions
- **WHEN** a pi child runs
- **THEN** its instructions hold "You have two tools: read and ls." and "Never copy the value of a token, a key or a password into your answer."

## ADDED Requirements

### Requirement: Directory list of a pi child
`ls` MUST list one directory of the project of the run, `.` by default: the name of each entry, with `/` at the end for a directory, hidden entries included, sorted by name, at most 500 entries, and `truncated` when the directory has more. It MUST go through the environment of the pi child, so a path out of the directory MUST fail with the error of `read`. After the list, the real path MUST be the same, else the call MUST fail.

Tests: `test/pi-child.test.mjs`

#### Scenario: A list of the project
- **WHEN** the project holds `README.md`, `.mcp.json`, `data/` and `.claude/skills/youtrack/`, and a pi child calls `ls` without a path and then with `.claude/skills`
- **THEN** the first list is `.claude/`, `.mcp.json`, `README.md` and `data/`, the second list is `youtrack/`, and no file changes

#### Scenario: Paths out of the project and a large directory
- **WHEN** a pi child calls `ls` with `..`, `/etc` and `outside-link`, and then with `many`, a directory of 501 files
- **THEN** each of the first three calls fails with the error that the path is outside the project directory, and the list of `many` has 500 entries and `truncated` true

#### Scenario: A directory that another process swaps
- **WHEN** another process swaps the directory `docs` for a symbolic link out of the directory of the run after the path check of `ls docs`
- **THEN** the call fails, and its result holds no name of the outside directory

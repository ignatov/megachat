# Spec Delta

## MODIFIED Requirements

### Requirement: Commits and money in the data
The data MUST hold
- the commits of the period of each listed project, at most 20 projects with 30 commits;
- the spend of Megachat on each day of the period, with the part of the pi children;
- and the API-equivalent cost of the other agent sessions from tokprof, only in the projects that Megachat knows (see the requirement "Projects of the tokprof part").

Tests: `test/morning-report.test.mjs`

#### Scenario: Spend of the period
- **WHEN** the period of the report of 2026-11-16 is 2026-11-13 to 2026-11-15, and Megachat spent 1.5 USD on 2026-11-13 with 0.5 USD for the pi children
- **THEN** the data gives the spend of 1.5 USD on 2026-11-13 with 0.5 USD for the pi children, and 0 USD on 2026-11-14 and 2026-11-15

#### Scenario: A project that is no git repository
- **WHEN** the directory of the only listed project is no git repository
- **THEN** the data gives no commits for that project

#### Scenario: A project that Megachat does not know
- **WHEN** `~/src/demo-app` is a known repository, and tokprof gives 15 USD in `~/src/demo-app` and 30 USD in `~/src/private-app`
- **THEN** the tokprof part gives 15 USD with the project `~/src/demo-app` only, and the JSON of the data has no `private-app`

### Requirement: tokprof command
tokprof MUST come from `PATH`, else from `~/.local/bin`. It MUST run one time for a report, with no shell, with a time limit of 120 seconds, as `tokprof flame --since <first day> --until <report date> --stack agent,project,origin --value cost -o <file>`, with no `--project`. The file MUST be in a private temporary directory. Megachat MUST read at most 4 MB of it, and it MUST remove the directory after the read.

Tests: `test/morning-report.test.mjs`

#### Scenario: The arguments of the command
- **WHEN** the period starts on 2026-11-13, and the report date is 2026-11-16
- **THEN** tokprof runs from `PATH` as `tokprof flame --since 2026-11-13 --until 2026-11-16 --stack agent,project,origin --value cost -o <file>`, and the temporary directory of the file does not exist after the read

#### Scenario: tokprof in the home directory
- **WHEN** `PATH` has no tokprof, and `~/.local/bin` has it
- **THEN** tokprof runs from `~/.local/bin`, and the data gets its cost

#### Scenario: Many known projects
- **WHEN** the state lists the workspace of Megachat and three known repositories, and the report of 2026-11-16 runs
- **THEN** tokprof runs one time, and its arguments have no `--project`

### Requirement: Two kinds of money
The data and the report MUST keep the two kinds of money apart: the USD that the key of Megachat paid, and the API-equivalent cost of the sessions in the known projects that the accounts of the agents paid. tokprof reads no store of Pi Durable, so a pi child of Megachat is not in its output. A line of the agent `pi` in the state directory of Megachat MUST be left out of the tokprof part all the same, and the data MUST give its cost apart.

Tests: `test/morning-report.test.mjs`

#### Scenario: The money of a report
- **WHEN** the key of Megachat paid 1.25 USD in the period with 0.25 USD for the pi children, the state lists `~/src/demo-app` and `~/src/demo-tool`, and tokprof gives 20 USD in them with a line of the agent `pi` in the state directory of Megachat that costs 0.7 USD
- **THEN** the data gives 1.25 USD paid by the key of Megachat, and 20 USD as the API-equivalent cost paid by the accounts of the agents, with the 0.7 USD of the pi line apart and with no path of the state directory

#### Scenario: The home directory in the form of tokprof
- **WHEN** tokprof gives a line of the agent `pi` in `~/.jetbrains/air/megachat`, and the state directory of Megachat is that directory
- **THEN** the line is left out of the tokprof part, and the data gives its cost apart

## ADDED Requirements

### Requirement: Projects of the tokprof part
A line of tokprof MUST count only when its project, with `~` as the home directory, is an absolute path, and that path or its real path is a known project or a directory in one. The comparison MUST use path segments. A known project is a listed directory (see the capability `projects`) or the working directory of a child run in the data. The rule of the pi line of the state directory MUST come first.

Tests: `test/morning-report.test.mjs`

#### Scenario: A directory in a known project
- **WHEN** `~/src/demo-app` is a known repository, and tokprof gives lines of `~/src/demo-app`, `~/src/demo-app/server`, `~/src/demo-app-2` and `temporary folders`
- **THEN** the tokprof part has the cost of `~/src/demo-app` and `~/src/demo-app/server` only

#### Scenario: A symbolic link to a known project
- **WHEN** `~/link-app` is a symbolic link to the known repository `~/src/demo-app`, and tokprof gives a line of `~/link-app`
- **THEN** the line counts in the tokprof part

#### Scenario: A child run in a removed project
- **WHEN** a child run of the period worked in `~/src/old-app`, the user removed `~/src/old-app` from the known repositories, and tokprof gives 2 USD in `~/src/old-app`
- **THEN** the tokprof part gives 2 USD for `~/src/old-app`

#### Scenario: Only the workspace
- **WHEN** the state lists only the workspace of Megachat, and tokprof gives lines only in `~/src/private-app` and in `temporary folders`
- **THEN** tokprof runs one time, and the tokprof part gives 0 USD, no project, no agent and no origin

### Requirement: Other work on this machine
When a line of tokprof does not count, the tokprof part MUST say that other work on this machine is not shown. The data MUST NOT give the cost, the project, the agent or the origin of such a line, or a sum of the machine. A pi line of the state directory is not other work. The rules of the turn MUST ask the main agent to say "Other work on this machine: not shown." and to guess nothing about it.

Tests: `test/morning-report.test.mjs`

#### Scenario: Private work on the machine
- **WHEN** `~/src/demo-app` is a known repository, and tokprof gives 15 USD in `~/src/demo-app`, 30 USD of the agent `codex` in `~/src/private-app`, and 2 USD in `codex chats`
- **THEN** the tokprof part has `otherWork` `notShown` and no agent `codex`, the JSON of the data has no `private-app`, no `codex chats` and no value of 32 or 47 USD, and the prompt asks the main agent to say "Other work on this machine: not shown."

#### Scenario: No other work
- **WHEN** each line of tokprof is in a known project or is a pi line of the state directory
- **THEN** the tokprof part has no `otherWork`

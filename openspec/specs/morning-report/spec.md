# morning-report Specification

## Purpose
The morning report is one automatic turn at the start of each working day. It tells the user about the child runs, the sessions, the commits and the money of the period since the previous working day, and it starts no work.

## Requirements

### Requirement: Morning report setting
The setting `report.morning` MUST be off by default. Off MUST start no report, no timer and no run of tokprof. A `settings.json` without the key MUST open with the default.

Tests: `test/morning-report.test.mjs`, `test/settings.test.mjs`

#### Scenario: The report is off
- **WHEN** `report.morning` is off, and the daemon runs for 3 days from Monday 2026-11-16 at 08:00 UTC after a turn of the user on Friday
- **THEN** the daemon has no timer of the report, starts no report and no run of tokprof, and the state keeps no date of a last report

#### Scenario: A settings.json of an earlier build
- **WHEN** `settings.json` does not have the key `report.morning`
- **THEN** `report.morning` is off, and no report and no run of tokprof happen

#### Scenario: The values of the setting
- **WHEN** `report.morning` gets the value `on`, ` off `, `daily` or `1`
- **THEN** `on` becomes on, ` off ` becomes off, and `daily` and `1` are refused

### Requirement: Time of the report
With `report.morning` on, the daemon MUST start one automatic turn of the kind `morning` on each working day at `workday.start`, on the days of `workday.days`, in the timezone of `workday.timezone`, also when `workday.enabled` is off. A change of the daylight saving time MUST move the time with the local clock.

Tests: `test/morning-report.test.mjs`

#### Scenario: A week
- **WHEN** `workday.enabled` is off, the timezone is `UTC`, and the daemon runs for 5 days from Thursday 2026-11-12 at 08:00
- **THEN** the reports come on Thursday 2026-11-12, Friday 2026-11-13 and Monday 2026-11-16 at 09:00, and no report comes on Saturday and Sunday

#### Scenario: A change of the daylight saving time
- **WHEN** the timezone is `Europe/Berlin`, which leaves the summer time on Sunday 2026-10-25
- **THEN** the report comes at 07:00 UTC on Friday 2026-10-23 and at 08:00 UTC on Monday 2026-10-26

#### Scenario: Another timezone
- **WHEN** the timezone is `America/New_York`, and `workday.start` is `08:30`
- **THEN** the report of Monday 2026-11-16 comes at 13:30 UTC

### Requirement: Report timer
The timer is the first scheduler of the daemon. Its next time MUST come from the settings and the clock through the pure function `nextWorkdayStart` of `src/Workday.mjs`. It MUST look at the clock again at least every 15 minutes, so a missed timer gives the report at the first chance on that working day, one time.

Tests: `test/morning-report.test.mjs`

#### Scenario: The next start after a Friday
- **WHEN** the time is Friday 2026-11-13 at 09:00 UTC
- **THEN** the next start of a working day is Monday 2026-11-16 at 09:00

#### Scenario: A computer that slept
- **WHEN** the timer waits on Monday 2026-11-16 at 08:00 UTC, and the computer sleeps until 11:00
- **THEN** the report of 2026-11-16 comes at 11:00, and no second report comes in the next hour

#### Scenario: A daemon that starts late
- **WHEN** the daemon starts on Monday 2026-11-16 at 10:30 UTC, and no report of that date came
- **THEN** the report comes at 10:30

### Requirement: Date of the last report
The state MUST keep the local date of the last report. A restart MUST send no second report on that date. A state of an earlier build MUST open.

When the user turns the report on after the start of a working day, the first report MUST come on the next working day.

Tests: `test/morning-report.test.mjs`

#### Scenario: A restart on the day of the report
- **WHEN** the report of Monday 2026-11-16 came at 09:10, and the daemon starts again at 11:00 on that day
- **THEN** no second report comes on 2026-11-16, and the next report comes on 2026-11-17 at 09:00

#### Scenario: A state of an earlier build
- **WHEN** the state has no record of the morning report
- **THEN** the state opens, and it has no date of a last report

#### Scenario: The report is turned on late
- **WHEN** the user sets `report.morning` on, on Monday 2026-11-16 at 10:00
- **THEN** no report comes on 2026-11-16, and the first report comes on 2026-11-17

### Requirement: Period of the report
The report MUST cover the calendar days from the previous working day up to the day before. So the report of a Monday covers Friday, Saturday and Sunday.

Tests: `test/morning-report.test.mjs`

#### Scenario: The report of a Monday
- **WHEN** the working days are Monday to Friday, and the report date is Monday 2026-11-16
- **THEN** the period is 2026-11-13, 2026-11-14 and 2026-11-15

#### Scenario: The report of a Tuesday
- **WHEN** the working days are Monday to Friday, and the report date is Tuesday 2026-11-17
- **THEN** the period is 2026-11-16

#### Scenario: One working day in the week
- **WHEN** `workday.days` is Monday, and the report date is Monday 2026-11-16
- **THEN** the period has 7 days

### Requirement: Period without activity
A period without a turn of the user and without a child run MUST give no turn and no run of tokprof. The state MUST keep its date all the same. The spend MUST NOT make a period active, because the turn of a report, a keep-alive request and a summary also cost money. So two working days without the user give no report on the second day.

Tests: `test/morning-report.test.mjs`

#### Scenario: A period with spend only
- **WHEN** the period of the report of 2026-11-16 has spend on 2026-11-13, but no turn of the user and no child run
- **THEN** no turn and no run of tokprof happen, the state keeps the date 2026-11-16, and the log says that the period "had no activity, so no report goes out"

#### Scenario: A report does not keep itself alive
- **WHEN** the last turn of the user was on Friday, and the turn of the report cost money on Monday 2026-11-16
- **THEN** no report comes on Tuesday 2026-11-17, and the state keeps the date 2026-11-17

### Requirement: Data in the prompt
The daemon MUST collect the data, and the turn MUST get it as JSON in its prompt.

Tests: `test/morning-report.test.mjs`

#### Scenario: The prompt of the report
- **WHEN** the report of Monday 2026-11-16 starts at 09:00 UTC
- **THEN** the daemon starts one turn, and its prompt holds the data as JSON with the period from 2026-11-13 to 2026-11-15 in the timezone `UTC`

### Requirement: Content of the data
The data MUST hold
- the child runs of the period that finished or failed and the child runs that still run, with title, project, agent and status;
- the permission requests that wait;
- the sessions of the period by project from the session index when `sessions.index` is on.

Tests: `test/morning-report.test.mjs`

#### Scenario: Runs and permission requests
- **WHEN** the period has a completed child run, a failed child run and a child run of the agent `pi` that waits for a permission request since 2026-11-15 at 20:00
- **THEN** the data holds the completed run and the failed run with title, project, agent and status, the run that still runs, and the permission request that waits

#### Scenario: Sessions of the period
- **WHEN** `sessions.index` is on, and the index has two sessions of the period in the project `/work/demo-app`
- **THEN** the data gives the project `/work/demo-app` with 2 sessions

#### Scenario: The session index is off
- **WHEN** `sessions.index` is off
- **THEN** the data says that the sessions part is off

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

### Requirement: Commits of the period
The commits MUST come from `git log` with a time limit, and from no other git command.

Tests: `test/morning-report.test.mjs`

#### Scenario: Commits in and out of the period
- **WHEN** a listed project has the commits "An old change" of 2026-11-10, "Fix the parser" of 2026-11-14 and "A change of today" of 2026-11-16
- **THEN** the data of the report of 2026-11-16 gives only the commit "Fix the parser" for this project

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

### Requirement: Missing tokprof part
Without tokprof, after a failure, after the time limit, and for a larger file, the data MUST say that the tokprof part is missing and why. The rules of the turn MUST ask the main agent to say it.

Tests: `test/morning-report.test.mjs`

#### Scenario: Each reason
- **WHEN** tokprof is not found, fails, runs past the time limit, or writes a file larger than 4 MB
- **THEN** the data says that the tokprof part is missing, and it gives the reason

#### Scenario: A report without tokprof
- **WHEN** the report of 2026-11-16 runs, and tokprof is not found
- **THEN** the data says that the cost of the other sessions is missing, the data still gives the spend of Megachat of 1.25 USD, and the rules of the turn ask the main agent to say that this part is missing

### Requirement: Two kinds of money
The data and the report MUST keep the two kinds of money apart: the USD that the key of Megachat paid, and the API-equivalent cost of the sessions in the known projects that the accounts of the agents paid. tokprof reads no store of Pi Durable, so a pi child of Megachat is not in its output. A line of the agent `pi` in the state directory of Megachat MUST be left out of the tokprof part all the same, and the data MUST give its cost apart.

Tests: `test/morning-report.test.mjs`

#### Scenario: The money of a report
- **WHEN** the key of Megachat paid 1.25 USD in the period with 0.25 USD for the pi children, the state lists `~/src/demo-app` and `~/src/demo-tool`, and tokprof gives 20 USD in them with a line of the agent `pi` in the state directory of Megachat that costs 0.7 USD
- **THEN** the data gives 1.25 USD paid by the key of Megachat, and 20 USD as the API-equivalent cost paid by the accounts of the agents, with the 0.7 USD of the pi line apart and with no path of the state directory

#### Scenario: The home directory in the form of tokprof
- **WHEN** tokprof gives a line of the agent `pi` in `~/.jetbrains/air/megachat`, and the state directory of Megachat is that directory
- **THEN** the line is left out of the tokprof part, and the data gives its cost apart

### Requirement: Spend of the earlier days
`spend.json` MUST keep the spend of the last 31 earlier days with the part of the pi children. A file of an earlier build MUST open.

Tests: `test/morning-report.test.mjs`

#### Scenario: The spend of 40 days
- **WHEN** Megachat spends money on each day from 2026-10-01 to 2026-11-09
- **THEN** on 2026-11-09, `spend.json` keeps the days from 2026-10-09 to 2026-11-08, and the older days go

#### Scenario: A file of an earlier build
- **WHEN** `spend.json` has no earlier days and no part of the pi children
- **THEN** the file opens, and the spend of the next days goes into it

### Requirement: Turn of the report
The turn of the report MUST wait for a turn that runs. A user message MUST interrupt it. An interrupted report, and a report that failed for a reason that can go away, MUST run again one time with the same data. A stop of the user MUST end it.

Tests: `test/morning-report.test.mjs`

#### Scenario: Two user messages during the report
- **WHEN** a user message interrupts the report, and another user message interrupts the report that runs again
- **THEN** the report runs two times with the same data, both report turns are cancelled, and no third report follows

### Requirement: Tools of the report turn
The turn of the report MUST refuse each tool that starts or changes something: a child task, a steer, a change of a setting or of the onboarding, a project create or remove, a close of a child, a cancel, and the account check. Its rules MUST ask for the report, for a list of the next steps for the user to approve, and for no start of work.

Tests: `test/morning-report.test.mjs`

#### Scenario: The report turn calls each tool that changes something
- **WHEN** the turn of the report calls `agents_spawn`, `agents_send`, `agents_steer`, `agents_settings` to set `reply.length` and to set the onboarding, `agents_projects` to create and to remove a project, `agents_close`, `agents_cancel` and `agents_accounts`
- **THEN** each call gives an error, no child run starts, the projects stay, and `settings.json` does not change

### Requirement: Delivery of the report
A connected client MUST get the report as it gets each automatic turn. Without a client, the reply MUST stay in the conversation one time, and the next attach MUST show it without the prompt.

Tests: `test/morning-report.test.mjs`

#### Scenario: A connected client
- **WHEN** a client is connected at 09:00, and the reply of the report is "Morning report text."
- **THEN** the client gets "Morning report text." as the turn runs

#### Scenario: A client that connects later
- **WHEN** no client is connected during the report, and a client attaches after it
- **THEN** the client gets "Morning report text." from the conversation, without the prompt of the report, and the conversation has one report

### Requirement: Keep-alive window after the report
The turn of the report MUST start no window of keep-alive requests. The window starts at the next turn of the user. A turn of a child result and a turn of the sessions summary start the window as a turn of the user does.

Tests: `test/morning-report.test.mjs`

#### Scenario: Six hours after the report
- **WHEN** the turn of the report ends on Monday at 09:00, and no turn of the user follows in the next 6 hours
- **THEN** no keep-alive request goes out

#### Scenario: A turn of the user after the report
- **WHEN** a turn of the user ends after the turn of the report
- **THEN** a keep-alive request goes out within the next hour

### Requirement: Tools of the other automatic turns
A turn of a child result and a turn of the sessions summary MUST still refuse a steer and a change of a setting. A turn of a child result MUST still run `agents_accounts`.

Tests: `test/morning-report.test.mjs`

#### Scenario: A steer, a setting and the account check
- **WHEN** a turn of a child result, a turn of the sessions summary and a turn of the morning report each call `agents_steer`, `agents_settings` to set `reply.length`, and `agents_accounts`
- **THEN** all three turns refuse the steer and the setting, the turn of a child result and the turn of the sessions summary run `agents_accounts`, and the turn of the morning report refuses it

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

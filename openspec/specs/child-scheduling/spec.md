# child-scheduling Specification

## Purpose
The daemon runs the child tasks of the main agent at the same time, within limits. It runs one child in one checkout, keeps the order of the queue, and drops old records so that the state stays bounded.

## Requirements

### Requirement: Count of the running children
The daemon MUST run at most `children.parallel` children at the same time. Claude, Codex and pi children MUST count together.

Tests: `test/parallel.test.mjs`

#### Scenario: Four tasks with the limit 3
- **WHEN** `children.parallel` is 3 and the main agent starts four tasks in the directories `a`, `b`, `c` and `d`
- **THEN** the tasks in `a`, `b` and `c` run at the same time, and the task in `d` stays `admitted` until one of the three tasks ends

#### Scenario: Two tasks with the limit 1
- **WHEN** `children.parallel` is 1, a task in the directory `a` runs, and a task in the directory `b` is queued
- **THEN** the agent in `b` gets no prompt until the task in `a` ends

### Requirement: One child for one checkout
Two children MUST never run in one checkout at the same time, whatever the limit is, because two agents that change one checkout break the work of each other. A follow-up, a continuation and a continuation for a message of the user MUST keep the rule of their directory. A run MUST keep its place until its supervisor exited, at most 6 seconds after its end (see `child-processes`).

Tests: `test/parallel.test.mjs`, `test/integration.test.mjs`, `test/child-processes.test.mjs`

#### Scenario: Two tasks in one directory
- **WHEN** a task runs in the directory `a`, and a second task in `a` is queued
- **THEN** the second task starts only after the end of the first task, and a task in the directory `b` does not wait

#### Scenario: The next task after the processes of a cancelled run
- **WHEN** the run of the stand-in ACP agent in the directory `a` has a shell that ends 500 ms after SIGTERM, the user cancels the run, and a second task in `a` is queued
- **THEN** the agent of the second task starts only after the shell ended

### Requirement: Conflict of two runs
Two runs MUST conflict when the real path of the directory of one run is the real path of the other, or a directory in it. The rule MUST compare path segments, so `/work/app2` is not in `/work/app`, and a symbolic link to a directory is that directory.

Tests: `test/parallel.test.mjs`

#### Scenario: A subdirectory and a sibling with a common prefix
- **WHEN** a run in `/work/app` runs
- **THEN** a run in `/work/app/server` waits, and a run in `/work/app2` starts

#### Scenario: A symbolic link to the directory of a running task
- **WHEN** a task runs in the directory `a`, and a second task names a symbolic link to `a`
- **THEN** the second task starts only after the end of the first task

### Requirement: Wait of a queued run
A queued run MUST wait while a conflicting run runs, and behind a conflicting run that is earlier in the queue and waits, so a run in a directory with many subdirectories gets its turn. It MUST NOT stop a queued run behind it that conflicts with no earlier run.

Tests: `test/parallel.test.mjs`

#### Scenario: A queued run in the checkout keeps its turn
- **WHEN** a run in `app/server` runs, and the queue holds a run in `app`, then a later run in `app/server`, then a run in `other`
- **THEN** only the run in `other` starts, and after the end of the running run the run in `app` starts before the later run in `app/server`

### Requirement: Order of the queue
Among the runs that can start, the queue order MUST hold across the ACP and the pi runs. A continuation for a message of the user MUST come before the older queued runs of both kinds.

Tests: `test/parallel.test.mjs`, `test/integration.test.mjs`

#### Scenario: The first runs that can start
- **WHEN** the limit is 3, and the queue holds two runs in `a`, a run through a symbolic link to `a`, and runs in `b`, `c` and `d`
- **THEN** the first run in `a` and the runs in `b` and `c` get a place, and the other runs wait

#### Scenario: A continuation for a message of the user
- **WHEN** a message of the user stops a running Claude child, and a task in the same directory was queued before the message
- **THEN** the continuation with the message runs before the queued task

### Requirement: No exception for a broad directory
The rule MUST have no exception for the Megachat workspace or for a broad directory. The tasks without a project share the workspace, so they run one after the other. A task in a listed directory that holds other listed directories, such as a home directory that an IDE opened, waits for each task in them, and they wait for it, because its child can change each of them.

Tests: `test/parallel.test.mjs`

#### Scenario: A listed directory in another listed directory
- **WHEN** a task runs in the listed directory `a`, and a task in the listed directory `a/server` is queued
- **THEN** the task in `a/server` starts only after the end of the task in `a`

### Requirement: One pi child at a time
At most one pi child MUST run at a time, inside the limit. A queued pi run that waits for this place MUST NOT stop a queued run of another agent in another checkout behind it. A daemon of v0.3.0 follows a dispatched pi run after a restart only when no other child is active. With two dispatched pi runs, it would start no child again. Pi Durable can run two child conversations at the same time.

Tests: `test/parallel.test.mjs`

#### Scenario: Two pi tasks and a Claude task
- **WHEN** the main agent starts a pi task in `a`, a pi task in `b` and a Claude task in `c`
- **THEN** the pi child of `a` and the Claude child run, the pi task of `b` stays `admitted`, and it starts only after the end of the pi child of `a`

### Requirement: Place of a continued pi run
A dispatched pi run that continues after a restart MUST take its place also over the limit, because Pi Durable continues it. It MUST count for each later start.

Tests: `test/parallel.test.mjs`

#### Scenario: Two continued runs with the limit 1
- **WHEN** `children.parallel` is 1 and two dispatched runs continue after a restart
- **THEN** each of the two runs takes its place, and a queued run starts only after the end of both runs

### Requirement: Start time of a run
Each run MUST keep the time of its start, `startedAt`, so the state shows which children ran at the same time.

Tests: `test/parallel.test.mjs`

#### Scenario: A task that waited for a place
- **WHEN** the task in `d` waits for a place and starts after the end of the task in `b`
- **THEN** the `startedAt` of the task in `d` is not earlier than the `finishedAt` of the task in `b`

### Requirement: Separate state of each run
The deadline, the permission requests, the messages of the user, a cancel and the output MUST stay for each run. A permission request of one run MUST NOT stop another run. A stop of a main task MUST cancel each child that it owns and no other child.

Tests: `test/parallel.test.mjs`, `test/integration.test.mjs`

#### Scenario: A deadline while another run waits for a permission
- **WHEN** a run in `a` waits for a permission, and the deadline ends a run in `b`
- **THEN** the run in `b` becomes `interrupted`, and the run in `a` stays in `approval` with its pending request

#### Scenario: A stop of a main task
- **WHEN** a main task started two children in `c` and `d`, a child of an earlier main task runs in `b`, and the user stops the main task
- **THEN** the children in `c` and `d` become `cancelled`, and the child in `b` stays `dispatched`

#### Scenario: The Stop of one of two parallel children
- **WHEN** two children run at the same time and the user stops one of them
- **THEN** only that child becomes `cancelled`, and the main agent gets the result `cancelled` for it

### Requirement: Limits of the child tasks
The daemon MAY retain at most eight unfinished child tasks, including queued tasks. Claude background tasks MUST be disabled. A child run ends with its ACP prompt. A main task MAY create at most eight child runs.

Tests: `test/launch.test.mjs`, `test/state.test.mjs`, `test/projects.test.mjs`

#### Scenario: The environment of a Claude child
- **WHEN** the daemon makes the environment of a Claude child
- **THEN** `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS` is `1`

#### Scenario: A ninth child run of one main task
- **WHEN** a main task created eight child runs, and it starts one more child run
- **THEN** the daemon refuses the ninth child run

#### Scenario: A ninth unfinished child task
- **WHEN** eight child tasks are unfinished, and the next main task starts one more child task
- **THEN** the daemon refuses the new task, and after the end of one of the eight tasks it admits the new task

### Requirement: Conversation without a lifetime limit
The conversation MUST have no lifetime limit. The daemon MUST drop old settled records and keep the work.

Tests: `test/transport.test.mjs`, `test/recovery.test.mjs`

#### Scenario: A large retained conversation
- **WHEN** the retained conversation holds an entry of 2 MiB and the view is idle
- **THEN** the event stream of the view stays connected and gets a heartbeat

#### Scenario: A bridge exit and a kill of the daemon
- **WHEN** a child waits for a permission, the bridge exits, and the daemon gets `SIGKILL`
- **THEN** the next daemon continues the child in the same provider session, and the request ID `original` gives the submission of the first input

### Requirement: Prune of the main inputs
At 1,000 main inputs, the daemon MUST drop the oldest settled inputs until 500 stay. A request ID that the daemon dropped MUST start a new input.

Tests: `test/state.test.mjs`

#### Scenario: Input 1001
- **WHEN** the state holds 1,000 settled inputs and the input `input-1000` arrives
- **THEN** the input runs, and the inputs from `input-500` to `input-1000` stay

#### Scenario: A dropped request ID
- **WHEN** the daemon dropped the input `input-0`, and the request ID `input-0` arrives again
- **THEN** the daemon starts a new input with a new submission ID

### Requirement: Prune of the child runs
At 64 child runs, the daemon MUST drop the oldest reported runs and their permission requests until 48 stay. It MUST keep each run that an unfinished continuation descends from, and each run that the current result report names. A follow-up to a child session without a retained run MUST fail, as a follow-up to an unknown session does.

Tests: `test/state.test.mjs`

#### Scenario: Child run 65
- **WHEN** the state holds 64 reported runs and the main agent starts one more run
- **THEN** the new run is `admitted`, at most 48 of the newest old runs stay, and each permission request that stays has its run

#### Scenario: A follow-up to a dropped run
- **WHEN** the prune dropped the run of a child session, and the main agent sends a follow-up to that session
- **THEN** the follow-up fails with the code `missing`

#### Scenario: A run that a continuation or the report names
- **WHEN** the prune runs while an interrupted run has a continuation and the current result report names another run
- **THEN** both runs stay, and the oldest filler runs go

### Requirement: Prune of the permission requests and the proposal decisions
The daemon MUST refuse permission requests after 32 requests per child. At 256 permission requests, it MUST drop the oldest requests of finished runs until 128 stay. A pending request MUST stay. At 2,000 proposal decisions, it MUST drop the oldest decisions until 1,000 stay.

Tests: `test/state.test.mjs`

#### Scenario: Permission request 33 of one child
- **WHEN** a running child made 32 permission requests, and it makes one more request
- **THEN** the daemon refuses the request

#### Scenario: Permission request 257
- **WHEN** the state holds 256 permission requests, one of them pending, and a new request arrives
- **THEN** the pending request, the 127 newest other requests and the new request stay

#### Scenario: Proposal decision 2001
- **WHEN** the state holds 2,000 proposal decisions and the decision `feedback-2000` arrives
- **THEN** the decisions from `feedback-1000` to `feedback-2000` stay

### Requirement: Records without an admission time
A stored record without its admission time MUST count as older than each record with one.

Tests: `test/state.test.mjs`

#### Scenario: Inputs of the code before the retention
- **WHEN** the state holds the input `timed` with `admittedAt`, 999 inputs without a time field, and a new input arrives
- **THEN** 501 inputs stay, the input `timed` and the new input among them, and the oldest inputs without a time field go

### Requirement: Retained child output
Child output MUST stop growing at the configured retention limit. The daemon MUST keep the end of a longer output. The state MUST keep only the text that a child agent wrote. An open of the state MUST drop the stored updates of an earlier build.

Tests: `test/state.test.mjs`

#### Scenario: A long output
- **WHEN** a child writes eight texts of 16,000 characters
- **THEN** the output holds the last four texts, and the run has `truncated` set

#### Scenario: An update without text
- **WHEN** a child sends a tool call update
- **THEN** the state does not change

#### Scenario: Updates of an earlier build
- **WHEN** the state holds runs with `updates` and `updateBytes`, and the daemon opens it
- **THEN** no run has `updates` or `updateBytes`

### Requirement: Deadline during permission waits
Permission waits MUST suspend the child execution deadline. The deadline MUST start again only when no permission request of the child waits.

Tests: `test/integration.test.mjs`, `test/parallel.test.mjs`

#### Scenario: One of two permission requests is pending
- **WHEN** a child has two pending permission requests, the deadline is 200 ms, and the user answers the first request
- **THEN** the run does not end while the second request waits

### Requirement: Error output of an ACP child
An ACP child that writes more than 10 MB of error output MUST stop. Its run MUST become interrupted with no continuation.

Tests: `test/parallel.test.mjs`

#### Scenario: A child that writes 10 MB and one byte of error output
- **WHEN** the agent of a Claude child writes 10,485,761 bytes of error output and then waits
- **THEN** the run becomes `interrupted` with no continuation

### Requirement: Refusal code of each limit
Each limit of the work MUST have a refusal code and a text of its own. The limits are
- eight child runs of one main task (`turnChildLimit`),
- eight unfinished child tasks (`unfinishedLimit`),
- 32 permission requests of one run (`permissionLimit`),
- 100 known repositories (`projectLimit`),
- 16 messages of the user for one task (`steerLimit`),
- 32 views of one ACP connection (`viewLimit`),
- and 32 MB for one event line of the daemon stream (`eventLimit`).

Tests: `test/state.test.mjs`

#### Scenario: The limits of the child runs and of the permission requests
- **WHEN** a main task starts a ninth child run, the next main task starts a ninth unfinished child task, and a child makes a permission request after 32 requests
- **THEN** the refusals have the codes `turnChildLimit`, `unfinishedLimit` and `permissionLimit`

#### Scenario: The limit of the messages of the user
- **WHEN** a task got 16 messages of the user, and the main agent steers it one more time
- **THEN** the refusal has the code `steerLimit`

### Requirement: Text of the refusal of a limit
The text of the refusal of a limit MUST give the number of the limit from the constant in the code, and it MUST tell the main agent what it can do.

Tests: `test/state.test.mjs`, `test/projects.test.mjs`, `test/integration.test.mjs`, `test/transport.test.mjs`

#### Scenario: The limit of one main task
- **WHEN** a main task starts a ninth child run
- **THEN** the text of the refusal starts with "This turn started 8 child runs already, and one turn can start at most 8."

#### Scenario: The limit of the known repositories
- **WHEN** the list of the known repositories holds 100 repositories, and the main agent adds one more
- **THEN** the tool result of the main agent holds the text of the refusal, which starts with "The list of the known repositories has 100 repositories, and it can hold at most 100.", and the list keeps 100 repositories

#### Scenario: The limit of the views
- **WHEN** a connection has 32 open views, and it opens one more view
- **THEN** the refusal has the code `viewLimit` and a text that starts with "This connection has 32 open Megachat chats, and it can have at most 32."

### Requirement: Errors of a run at a limit
The error of a run at its deadline MUST give the deadline in minutes. The error of a run above the limit of the error output MUST name that limit.

Tests: `test/parallel.test.mjs`

#### Scenario: The deadline
- **WHEN** a deadline of 300 ms ends a run
- **THEN** the error of the run names a time limit of 0.005 minutes

#### Scenario: The error output
- **WHEN** a child writes more than 10 MB of error output
- **THEN** the error of the run starts with "The child agent wrote more than 10 MB of error output"

### Requirement: Codes of the limits in the client of the daemon
The client of the daemon MUST give each refusal code of a limit to the bridge as `invalid`, as it gives each other code that is not in its list, so a bridge and a daemon of different builds keep their behavior.

Tests: `test/transport.test.mjs`

#### Scenario: A refusal with the code of a limit
- **WHEN** the daemon refuses an input with `limit`, `turnChildLimit`, `unfinishedLimit`, `permissionLimit`, `projectLimit`, `steerLimit`, `viewLimit`, `eventLimit` or `outputLimit`
- **THEN** the client gives the code `invalid` to the bridge, and it keeps the code `busy`

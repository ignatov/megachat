# pi-child Specification

## Purpose
A pi child is a child task that only reads. It runs as a conversation in the harness of the main agent, in the daemon process, and it reads only the files of the directory of its run.

## Requirements

### Requirement: Start of a pi child
`agents_spawn` with `agent` `pi` MUST start a pi child: an ownerless conversation in the harness of the main agent, in the daemon process, with no new process. The ID of that conversation MUST be the provider session ID of the run. `agents_list` MUST name `pi` as an agent.

Tests: `test/pi-child.test.mjs`

#### Scenario: A pi child reads the README
- **WHEN** the main agent calls `agents_spawn` with `agent` `pi` and the title `README summary`
- **THEN** the run has the agent `pi`, no process ID, and a provider session ID that is a number, and it completes with the output of the child

### Requirement: States and report of a pi run
A pi run MUST go through the same states as an ACP run, and the main agent MUST get one report of its result. The limits, the queue and the prune rules of the runs MUST apply to it (see the capability `child-scheduling`).

Tests: `test/pi-child.test.mjs`

#### Scenario: One report
- **WHEN** a pi run completes
- **THEN** the main conversation holds one report of the children

#### Scenario: A pi run and an ACP run in one directory
- **WHEN** a Claude child waits for a permission in a directory, and a pi run in the same directory is queued
- **THEN** the pi run stays `admitted` and makes no model request until the Claude child ends

### Requirement: Model of a pi child
A pi child MUST use the model of the setting `children.piModel`, `provider/model`, which the model registry MUST know. The default is `anthropic/claude-haiku-5-5`.

The setting `cache.ttl` applies to the requests of a pi child too. Pi Durable 1.5.1 reads the stream options of the harness without the conversation, so a child cannot get a cache lifetime of its own without a rewrite of the provider request.

Tests: `test/settings.test.mjs`

#### Scenario: The default value
- **WHEN** no value of `children.piModel` is stored
- **THEN** the setting gives `anthropic/claude-haiku-5-5`

#### Scenario: A value that is not a known model
- **WHEN** the registry has only the `faux` models
- **THEN** the setting accepts `faux/fast` and refuses `anthropic/claude-haiku-5-5`, `small` and `faux/`

### Requirement: Fallback and change of the model of a pi child
When the registry does not know the effective value, as in a test, a pi child MUST use the model of the main agent. The model of the main agent MUST NOT change. A change MUST apply to the next pi run, also to a follow-up.

Tests: `test/pi-child.test.mjs`

#### Scenario: A model that the registry does not know
- **WHEN** the registry does not know the value of `children.piModel`, and the main agent uses `faux/big`
- **THEN** a pi child sends its requests to `faux/big`

#### Scenario: A change before a follow-up
- **WHEN** the main agent sets `children.piModel` to `faux/small` and then sends a follow-up to a pi child
- **THEN** the follow-up uses `faux/small`, and each request of the main agent still uses `faux/big`

### Requirement: Tool of a pi child
A pi child MUST have only the tool `read`. It MUST get none of the `agents_*` tools, not the rules of the main agent, not the section `settings`, not the instructions of the user, and not the hooks of the main agent.

Tests: `test/pi-child.test.mjs`

#### Scenario: The request of a pi child
- **WHEN** a pi child runs
- **THEN** each request of the child has only the tool `read` and only the section `instructions`, and the instructions hold no rule of the main agent

### Requirement: Instructions of a pi child
The instructions of a pi child MUST say what it can do, and they MUST hold the content of `AGENTS.md` of the directory of the run, else of `CLAUDE.md`, at most 32,000 bytes, marked as the rules of the repository. A rules file that is not a regular file, such as a FIFO, MUST NOT count, and its read MUST NOT wait.

Tests: `test/pi-child.test.mjs`

#### Scenario: The rules of the repository
- **WHEN** a pi child runs in a directory whose `AGENTS.md` holds "Name each file that you read."
- **THEN** the instructions of the child hold that text in `<repository_rules file="AGENTS.md">`

#### Scenario: An AGENTS.md that is a FIFO
- **WHEN** the `AGENTS.md` of the directory of the run is a FIFO
- **THEN** the pi child starts and completes, and its instructions hold no repository rules

### Requirement: Paths that the environment of a pi child reads
The environment of a pi child MUST read only the files of the directory of its run. It MUST compare real paths, so `..`, an absolute path, `~` and a symbolic link MUST NOT lead out of the directory.

Tests: `test/pi-child.test.mjs`

#### Scenario: Paths in and out of the directory
- **WHEN** a pi child reads `docs/notes.txt`, `inside-link` and `docs/../README.md`, and then `../secret.txt`, `outside-link`, `/etc/hosts` and `~/.ssh/id_rsa`
- **THEN** the first three reads give the files of the directory, and each other read fails

### Requirement: Check of a read after the open
After the open, a read of the environment of a pi child MUST refuse the file when the path has another real path, or when the open file is not the file at its real path. So another process that swaps a directory of the path cannot lead a read out of the directory. The read of the rules file MUST go through the same environment.

Tests: `test/pi-child.test.mjs`

#### Scenario: A directory that another process swaps
- **WHEN** another process swaps a directory of the path for a symbolic link out of the directory of the run after the path check
- **THEN** the read of `docs/notes.txt` fails when the swapped directory is `docs`, and the read of the rules file gives no rules when the swapped directory is the directory of the run

### Requirement: Errors of a read
An error of a read MUST NOT tell whether a path out of the directory exists: such a path MUST get the same error, whether it exists or not, and no error may hold a path out of the directory other than the requested path.

Tests: `test/pi-child.test.mjs`

#### Scenario: An outside path that exists and one that does not
- **WHEN** a pi child reads `../secret.txt`, which exists, and `../missing.txt`, which does not exist
- **THEN** both reads fail with the same error, which says that the path is outside the project directory, and each error names only its requested path

### Requirement: Operations that the environment of a pi child refuses
The environment of a pi child MUST refuse each write, command, watch and temporary file. The main conversation MUST get no environment. A read-only child needs no sandbox, because this environment is its only way to a file.

Tests: `test/pi-child.test.mjs`

#### Scenario: A change
- **WHEN** a pi child tries to write a file, remove a file or run `touch new.txt`
- **THEN** the environment refuses each operation, and the files do not change

#### Scenario: The main conversation
- **WHEN** the daemon gets the environment of the main conversation and of a pi child
- **THEN** the main conversation gets no environment, and the pi child gets the read-only environment of its directory

### Requirement: Read and turn limits of a pi child
`read` MUST return at most 2,000 lines or 50 KB of a text file, or one image of at most 4.5 MB, in each call. A run of a pi child MUST end after 20 tool rounds, as `failed` with the reason code.

A pi child shares the event loop and the memory of the daemon. The turn limit, the deadline, the size of a read and the size of the stored output bound it.

Tests: `test/pi-child.test.mjs`

#### Scenario: A child that reads without an end
- **WHEN** a pi child calls `read` in each answer
- **THEN** the run ends after 20 model requests as `failed` with the stop reason `turn_limit`

### Requirement: Output of a pi run
The output of a pi run MUST keep the text of each answer of the child within the retention limit of a child output. A pi continuation MUST keep a copy of the output of the run before it only for a restart of its dispatched run. At its end the copy MUST go, and `agents_inspect` and `agents_wait` MUST return the output one time.

Tests: `test/pi-child.test.mjs`

#### Scenario: A continuation after the text "Reading the README."
- **WHEN** a pi child wrote "Reading the README.", a message with the mode `interrupt` restarts it, and the continuation answers "Redirected."
- **THEN** the output of the continuation holds both texts, no run keeps the copy, and the read of the continuation holds "Reading the README." one time

### Requirement: Follow-up of a pi child
`agents_send` MUST submit a follow-up to the same conversation. A pi run MUST refuse a session of the pi command-line agent.

Tests: `test/pi-child.test.mjs`

#### Scenario: A follow-up
- **WHEN** the main agent sends "And the license?" to a pi child that answered "First answer."
- **THEN** the new run has the provider session ID of the first run, and its request holds the first exchange

#### Scenario: A session of the pi command-line agent
- **WHEN** the main agent starts a pi run with the provider session ID `cli-session`
- **THEN** the state refuses the run with the code `invalid`

### Requirement: Cancel and deadline of a pi run
`agents_cancel` and the deadline of 30 minutes MUST abort the conversation of the child. The main conversation MUST continue. A run at the deadline MUST become interrupted with no continuation. Before the dispatch, in `launching` and `ready`, `agents_cancel`, the deadline and a daemon stop MUST also end a run whose step waits, so the run cannot hold the place of a child.

Tests: `test/pi-child.test.mjs`

#### Scenario: A cancel
- **WHEN** the main agent calls `agents_cancel` for a pi child that waits for its model
- **THEN** the run becomes `cancelled`, and the next message of the user completes

#### Scenario: The deadline
- **WHEN** the deadline ends a pi child
- **THEN** the run becomes `interrupted` with no continuation, and the next message of the user completes

#### Scenario: A run whose start waits
- **WHEN** a pi run waits in `launching`, and the main agent cancels it
- **THEN** the run becomes `cancelled`

### Requirement: Daemon restart during a pi run
A daemon restart during a dispatched pi run MUST NOT lose the run. Pi Durable continues the conversation, and the next daemon MUST follow the same run to its end. A pi run that had not sent its prompt MUST become interrupted and continue, as an ACP run does.

Tests: `test/pi-child.test.mjs`

#### Scenario: A restart during a model request
- **WHEN** the daemon stops while a dispatched pi child waits for its model, and a new daemon opens the same `conversation.sqlite`
- **THEN** the same run completes in the same conversation, and the main agent gets one report

#### Scenario: A stop before the prompt
- **WHEN** the daemon stops while a pi run waits in `launching`
- **THEN** the run becomes `resumed` with `plannedStop`

### Requirement: Pi child in the chat
A pi child MUST NOT be a service session, so Megachat MUST send no `_session/service/record` for it. The chat MUST list it as a background task of the agent `Pi`.

Tests: `test/pi-child.test.mjs`

#### Scenario: The row of a pi child
- **WHEN** a pi run with the title `README` runs in `/work/project`
- **THEN** the chat shows the row `README` with the text of a running child of the agent `Pi` in `project`, and the state has no service session

### Requirement: Session history of a pi child
`agents_session_history` with the agent `pi` and the session ID of a pi run in its directory MUST read the transcript of that child, also without the index of past sessions.

Tests: `test/pi-child.test.mjs`

#### Scenario: The transcript of a child with a follow-up
- **WHEN** the index of past sessions is off, and the main agent reads the history of a pi child with a follow-up
- **THEN** the history gives the two messages of the user and the two answers of the child in order

### Requirement: Conversation of a pi child after the prune
Pi Durable 1.5.1 cannot delete or archive a conversation. So `conversation.sqlite` MUST keep the conversation of a pi child after the prune drops its last run.

#### Scenario: The last run goes
- **WHEN** the prune drops the last run of a pi child
- **THEN** `conversation.sqlite` still holds the conversation of that child

### Requirement: Steering of a pi run
`agents_steer` MUST work for a pi run with the same record, limit, outcomes and refusals as for an ACP run (see the capability `steering`). For a pi run, the submission of a message is a commit in the same storage as the state: the commit that submits the message to the conversation of the child also marks it `delivered`, with the request ID of the tool call, so a message arrives one time, also after a restart.

Tests: `test/pi-child.test.mjs`

#### Scenario: A repeated tool call
- **WHEN** the main agent steers a working pi child two times with the same tool call
- **THEN** both calls give the outcome `injected` and the same steer ID, and the next model request of the child holds the message one time

#### Scenario: A turn of a child result
- **WHEN** a turn of a child result or of the sessions summary steers a pi child
- **THEN** the state refuses it with the code `steerEvent`

### Requirement: Delivery of a message to a pi run
A message for a pi run that did not send its prompt MUST go in that prompt, as a block after the task (`queued`). A message for a pi child that works MUST go to its conversation with `whenBusy: "steer"` and `whenIdle: "reject"`, so Pi Durable places it after the current tool round (`injected`). The run MUST end only after the run of each such message.

Tests: `test/pi-child.test.mjs`

#### Scenario: A message for a queued pi run
- **WHEN** the main agent steers a pi run that waits in the queue
- **THEN** the outcome is `queued`, and the first request of the child holds the task and the message one time

#### Scenario: A message for a working pi child
- **WHEN** the main agent steers a pi child during its model request
- **THEN** the outcome is `injected`, the next model request of the child holds the message one time, and the run completes with one report

### Requirement: Message that Pi Durable did not place
When the turn ends without an answer, the run MUST withdraw each message that went to the conversation of a working pi child and that Pi Durable did not place, and it MUST NOT wait for it. A continuation MUST carry that message as a possible repeat. When no continuation follows, as after the turn limit or the deadline, the error of the run MUST tell the main agent that the child did not get it, and the run MUST keep its text.

Tests: `test/pi-child.test.mjs`

#### Scenario: A model error after a queued message
- **WHEN** the model of a pi child fails after a message was `injected`
- **THEN** the run becomes `resumed`, and its continuation completes with the message marked as a possible repeat

#### Scenario: The turn limit after a queued message
- **WHEN** a pi child reaches 20 tool rounds after a message was `injected`
- **THEN** the run is `failed` with no continuation, and its error and its report say that the child did not get one message

### Requirement: Message after the end of a turn of a pi child
A message that the conversation refuses because its turn ended MUST wait, and the end of the run MUST give a follow-up in the same conversation with the message (`followUp`). The mode `interrupt`, and each other refusal, MUST abort the turn and continue in the same conversation with the message (`restarted`).

Tests: `test/pi-child.test.mjs`

#### Scenario: A message after the end of the turn
- **WHEN** the turn of a pi child ended, and the main agent steers the run
- **THEN** a follow-up in the same conversation holds the message one time, and the message gets the outcome `followUp`

#### Scenario: The mode interrupt
- **WHEN** the main agent steers a working pi child with the mode `interrupt`
- **THEN** the outcome is `restarted`, and a continuation in the same conversation holds the message one time

### Requirement: Pending message of a pi run after a restart
After a daemon restart, a `pending` message of a pi run MUST still arrive.

Tests: `test/pi-child.test.mjs`

#### Scenario: A restart with a pending message
- **WHEN** the run service stops, the main agent steers the pi run, and the daemon restarts
- **THEN** no message stays `pending`, and the last request of the child holds the message one time

### Requirement: Continuation texts of a pi run
The continuation of an interrupted pi run, and the continuation after a stop for a message, MUST have texts of their own that name no git status, because a pi child only reads.

Tests: `test/pi-child.test.mjs`

#### Scenario: The continuation of an interrupted pi run
- **WHEN** a dispatched pi run becomes interrupted
- **THEN** the prompt of its continuation is the text of a pi continuation, and it does not contain "git"

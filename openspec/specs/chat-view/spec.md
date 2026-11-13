# chat-view Specification

## Purpose
The chat shows the conversation of the main agent and a list of the unfinished child tasks in an ACP client such as Air. It hides the work of the children and the tool calls of the main agent, and it lets the user stop one child task from its row.

## Requirements

### Requirement: Service sessions of delegated children
New delegated sessions MUST be service sessions when the client supports their registration, except a session in a directory where `children.showInProject` is `true`. The ordinary session list MUST hide these sessions. The daemon MUST retain their histories. Continuing an existing user session MUST preserve its visibility in the ordinary session list. Reconnection MUST mark earlier delegated sessions too.

Tests: `test/integration.test.mjs`

#### Scenario: A new Codex child
- **WHEN** a client that supports the registration of service sessions asks for work, and the main agent starts a Codex child
- **THEN** the client gets a registration with the agent `codex` and the provider session ID of the run

#### Scenario: A resume of an existing user session
- **WHEN** the main agent calls `agents_resume` for the Codex session `active`
- **THEN** the run has `serviceSession` false, and the client gets no registration

#### Scenario: A reconnection and a client without the support
- **WHEN** a second view with the support attaches after a Claude child ended, and a third view without the support attaches
- **THEN** the second view gets the registration of the session of the child again, and the third view gets no registration

#### Scenario: A project with children.showInProject
- **WHEN** `children.showInProject` is `true` for the directory of a new Codex child, and two views with the support attach
- **THEN** the run has `serviceSession` false, the state holds no address of it, and no view gets a registration

### Requirement: Addresses of delegated sessions
The daemon MUST keep the address of a delegated session after it drops the runs of that session. At 5,000 addresses, it MUST drop the oldest addresses until 4,000 stay.

Tests: `test/integration.test.mjs`

#### Scenario: The runs of a delegated session are dropped
- **WHEN** the state drops the runs of a delegated Claude session and of a resumed Codex session, and a view with the support of service sessions attaches
- **THEN** the view gets the registration of the delegated Claude session, and it gets no registration of the resumed Codex session

#### Scenario: The limit of the addresses
- **WHEN** the daemon has 5,000 addresses of delegated sessions
- **THEN** the 1,000 oldest addresses go away, and the 4,000 newest addresses stay

### Requirement: Hidden work in the chat
The main conversation MUST show no child lifecycle rows, tool calls, or child output. The chat MUST NOT show the main agent's own tool calls. The retained conversation MUST keep them. The chat MUST NOT show a row for the main agent's own turn.

Tests: `test/integration.test.mjs`

#### Scenario: The output of a child
- **WHEN** a child writes `hello` and ends
- **THEN** the view gets no `subagent_spawned`, no `subagent_state_update`, no `tool_call` and no text `hello`

#### Scenario: A tool call of the main agent
- **WHEN** the main agent calls `agents_spawn` and then writes `Started.`
- **THEN** the view gets the text `Started.` and no `tool_call` update, and the retained conversation keeps the call of `agents_spawn`

#### Scenario: The turn of the main agent
- **WHEN** a view attaches while a turn of the main agent runs
- **THEN** the view gets no row with the task type `turn`

### Requirement: List of the child tasks
The chat MUST list each unfinished child task with its title, agent, project, and state: queued, running, waiting for permission, or interrupted and resuming. Each child that runs at the same time as another child MUST have a row of its own with its own state.

Tests: `test/integration.test.mjs`, `test/parallel.test.mjs`

#### Scenario: A child that waits for permission
- **WHEN** the main agent starts a Claude child with the title `Fix the icon` in the project `project`, and the child asks for a permission
- **THEN** the row has the name `Fix the icon` and the description `Claude · project · waiting for permission`

#### Scenario: Four children at the same time
- **WHEN** three children wait for permission in the projects `a`, `b` and `c`, and a fourth child waits for a place in the project `d`
- **THEN** the chat has four rows, with the descriptions `Claude · a · waiting for permission`, `Claude · b · waiting for permission`, `Claude · c · waiting for permission` and `Claude · d · queued`

### Requirement: Titles and details of the child task rows
A task title MUST be at most 60 characters. Without a title from the main agent, it MUST come from the first prompt line. The list MUST show no run IDs or prompts. A finished task MUST leave the list.

Tests: `test/integration.test.mjs`

#### Scenario: A row without the prompt
- **WHEN** the main agent starts a child with the title `Fix the icon` and the prompt `approval`
- **THEN** no row holds the prompt, and each row of the child gets an `async_task_state_update` that ends it after the child ended

#### Scenario: A task without a title
- **WHEN** the main agent starts a child with the prompt `wait` and no title
- **THEN** the row has the name `wait`

### Requirement: Permission requests in the chat
Permission requests MUST appear in the main conversation. The title of a request MUST name the agent and the task, because several children can ask at the same time.

Tests: `test/integration.test.mjs`, `test/parallel.test.mjs`

#### Scenario: Two children ask at the same time
- **WHEN** the Claude children of the tasks `Fix the icon` and `Update the docs` ask for a permission to write a file at the same time
- **THEN** the client gets the two titles `Claude · Fix the icon needs permission: Write a file` and `Claude · Update the docs needs permission: Write a file`

### Requirement: Conversation after a reconnection
Reconnection MUST restore the conversation without child lifecycle rows.

Tests: `test/integration.test.mjs`

#### Scenario: A view attaches after a child ended
- **WHEN** a Claude child ended, and a new view attaches
- **THEN** the view gets no `subagent_spawned`, no `subagent_state_update` and no `tool_call`

### Requirement: Open permission request
A permission request of a child MUST be open only while the daemon takes a new answer for it: the request is pending, and its run exists, has the generation of the request, has no stop request, and is not in a terminal state. One function of the state MUST give this condition to the answer and to the bridge.

Tests: `test/state.test.mjs`

#### Scenario: A pending request
- **WHEN** a running child waits for the answer to the permission request `Write a file`
- **THEN** the request is open, and the answer `yes` is accepted

#### Scenario: A request that is no longer open
- **WHEN** the run of a pending request gets a stop request, gets a new generation, fails, or the state recovers after a restart
- **THEN** the request is not open, and the answer `yes` fails with `stale`

### Requirement: Dialog of an open permission request
Each view MUST show each open request through `session/request_permission`, also a view that attaches while the request is open. A view MUST show no dialog for a request that is not open. When Air answers `cancelled` to a request that is still open, as at the end of the prompt turn and at a Stop of the user, the view MUST show the request again after the prompt response of the view.

Tests: `test/integration.test.mjs`

#### Scenario: Two views
- **WHEN** two views are attached, and a child asks for a permission
- **THEN** each view gets `session/request_permission` with the ID of the request as the tool call ID

#### Scenario: Requests that are not open
- **WHEN** a view gets a state with an answered request, a request of a run with a stop request, and a request of a run with a new generation
- **THEN** the view shows no dialog for these three requests

#### Scenario: Air cancels an open request at the end of the prompt
- **WHEN** a child asks for a permission, and Air answers `cancelled` after the prompt response of the view
- **THEN** the view shows the request again with the same tool call ID, and the answer `yes` of the user then counts

#### Scenario: Air cancels requests during the prompt
- **WHEN** Air answers `cancelled` for three requests while the prompt of the view runs, and then the row of one run gets a Stop and another view answers the second request
- **THEN** the view shows only the third request again, and only after the prompt response

### Requirement: End of the tool call of a closed permission request
When a request that a view showed is no longer open, that view MUST end the tool call of the request one time with a final `tool_call_update`: `completed` after an answer that counts, and `failed` when the run stopped, ended or changed its generation first, when the state dropped the request, and when the user of that view gave an answer that did not count. So Air removes the dialog of each view that did not answer.

Tests: `test/integration.test.mjs`

#### Scenario: An answer in another view
- **WHEN** two views show a permission request, and the user answers `yes` in the first view
- **THEN** each of the two views ends the tool call of the request one time with `completed`

#### Scenario: A Stop of the row
- **WHEN** two views show a permission request, and the user stops the row of its run
- **THEN** each of the two views ends the tool call of the request one time with `failed`

#### Scenario: An answer that did not count
- **WHEN** the user of a view answers `no`, but the answer `yes` of another view counted first
- **THEN** the view ends the tool call of the request with `failed`

### Requirement: Causes of the end of a permission tool call
The end of the tool call of a request that is no longer open applies to a Stop of the row, `agents_cancel`, a Stop of the turn, the deadline, a failure or a restart of the child, a new generation of the run and an answer in another view. An older state that a view gets late MUST NOT end the tool call of a shown request, and a view MUST NOT show a request again after it ended its tool call.

Tests: `test/integration.test.mjs`

#### Scenario: Older states that arrive late
- **WHEN** a view showed a request, then gets an older state without the request, then a state in which the request is answered, and then an older state in which the request is pending
- **THEN** the view ends the tool call of the request one time, and it does not show the request again

### Requirement: The daemon judges each answer
The daemon MUST stay the judge of each answer. A view MUST give each selected answer to the daemon, also an answer that races the final update, and the daemon MUST refuse an answer to a request that is not open. A cancel of Air MUST send nothing to the daemon.

Tests: `test/integration.test.mjs`

#### Scenario: An answer that races the final update
- **WHEN** the user of a view answers `no` to a request that another view answered `yes` first
- **THEN** the view gives the answer `no` to the daemon

#### Scenario: Answers to a request that is not open
- **WHEN** the request is answered with `yes`, and a later answer `no` arrives
- **THEN** the daemon refuses the later answer with `conflict`, and the decision stays `yes`

#### Scenario: An answer after a Stop
- **WHEN** the run of a request is stopped, and an answer `yes` arrives after that
- **THEN** the daemon refuses the answer with `stale`, and the request has no decision

### Requirement: A view that attaches after a permission request closed
A view that attaches after a request closed MUST get no dialog and no tool call update of that request.

Tests: `test/integration.test.mjs`

#### Scenario: A view after an answer
- **WHEN** a request is answered, and a third view attaches
- **THEN** the third view gets no dialog and no update with the tool call ID of the request

#### Scenario: A view after a Stop
- **WHEN** a request became stale after a Stop of its row, and a view opens the chat again
- **THEN** the view gets no dialog and no update with the tool call ID of the request

### Requirement: Stop action of a row
Each row of a child run MUST have the Stop action of Air (`canStop: true`), in each phase: queued, resuming, waiting for permission and running. The row of the import of past sessions MUST have none.

Tests: `test/integration.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: The rows of the phases
- **WHEN** a run is queued, a run waits for a permission, and a run is running
- **THEN** each of the three rows has `canStop: true`

#### Scenario: A pi child
- **WHEN** a pi child runs in the project `project` with the title `README`
- **THEN** its row has the name `README`, the description `Pi · project` and `canStop: true`

### Requirement: Effect of a Stop
A Stop of a row MUST cancel only the child run of that row, as `agents_cancel` does, also while no turn runs. The other children and the turn MUST go on. A queued run MUST end before its start. A run that waits for a permission MUST end, and its pending permission requests MUST become stale. The run MUST get no continuation. The row MUST end with `stopped`, and the main agent MUST get the result `cancelled` in a turn of the result.

Tests: `test/integration.test.mjs`, `test/pi-child.test.mjs`

#### Scenario: One of two parallel children
- **WHEN** the children `First` and `Second` run, and the user stops the row of `First`
- **THEN** the row of `First` ends with `stopped`, `First` is `cancelled`, `Second` is still running, and the main agent gets one report with the status `cancelled`

#### Scenario: A run that waits for a permission
- **WHEN** the user stops the row of a run that waits for a permission
- **THEN** the run is `cancelled`, its permission request is `stale`, and a later answer to the request fails with `stale`

#### Scenario: A queued run
- **WHEN** the user stops the queued row of `Second` while `First` runs in the same directory
- **THEN** `Second` is `cancelled` before its start, `First` still runs, and the agent gets only the dispatch of `First`

### Requirement: Answer to a Stop
The answer to an accepted Stop MUST be `stopped: true`. A Stop of a run that ended, of an unknown run, of a row of another kind, of an unknown session, and of a client without `asyncTasks` MUST give `stopped: false` and change nothing.

Tests: `test/integration.test.mjs`

#### Scenario: Refused Stops
- **WHEN** the user stops a row of a run that ended, a row of an unknown run ID, the row `sessions:pass:1` of the import, or a row in an unknown session
- **THEN** each answer is `stopped: false`, and the other child still runs

#### Scenario: A client without asyncTasks
- **WHEN** a client without `asyncTasks` sends `_session/async_task/stop` for a running child
- **THEN** the answer is `stopped: false`, the child still runs, and the client got no `async_task` update

### Requirement: Order of a reply and the prompt response
A completed main reply MUST arrive before the prompt response.

Tests: `test/integration.test.mjs`

#### Scenario: A follow-up prompt
- **WHEN** a view sends the prompt `Follow up`, and the main agent answers `Next turn.`
- **THEN** the view has the text `Next turn.` one time when the prompt response arrives

### Requirement: Replay of the history
History replay MUST include the earlier user messages.

Tests: `test/integration.test.mjs`

#### Scenario: A conversation of 250 entries
- **WHEN** the conversation holds the user messages `Message 0` to `Message 249`, and a view loads the session
- **THEN** the replay holds the 250 user messages in order, and only the last one has `loadSessionEndOfRecordedHistory`

### Requirement: Blocks of a prompt
A prompt MAY hold the blocks `text` and `resource_link`, as ACP requires of each agent. The main agent MUST get each link as a Markdown link with its name and its URI, in the order of the blocks. Each other block type MUST be refused.

Tests: `test/integration.test.mjs`

#### Scenario: A link between two texts
- **WHEN** a prompt holds the text `Read this file:`, a `resource_link` with the name `notes.md` and the URI `file:///project/notes.md`, and the text `and say what it holds.`
- **THEN** the user message is `Read this file:`, `[notes.md](file:///project/notes.md)` and `and say what it holds.` on three lines

#### Scenario: An image
- **WHEN** a prompt holds a text block and an `image` block
- **THEN** the prompt is refused

### Requirement: Session IDs of the ACP views
Each ACP view MUST have its own session ID. Views in one pooled process MUST share the conversation and close independently.

Tests: `test/integration.test.mjs`, `test/parallel.test.mjs`

#### Scenario: Two views in one process
- **WHEN** a second view starts in the process of the first view, and the first view closes
- **THEN** the second view has another session ID, its replay holds the user message `Work` one time, and a prompt in the second view gets the reply `Next turn.`

### Requirement: A second attach of a session ID
A second attach of a session ID MUST replace the earlier view of that ID, also while the earlier view attaches. The earlier view MUST end its attach, and it MUST start no event stream after that.

Tests: `test/integration.test.mjs`

#### Scenario: A second load during the attach
- **WHEN** a second load of the session ID `megachat` arrives while the first view waits for the daemon
- **THEN** the second view is the view of `megachat`, the first attach fails, and the daemon has one event stream

### Requirement: Prompt during a turn that the view does not know
When the daemon refuses a prompt with `busy`, for example while it continues a user turn after its restart, the prompt MUST wait for the end of that turn and then start its own turn. A Stop of the waiting prompt MUST end it with `cancelled`, with no input of the prompt, and it MUST stop the running turn.

Tests: `test/prompt-wait.test.mjs`

#### Scenario: A turn of the last daemon runs
- **WHEN** the user turn `Fix the lexer` runs, and the view sends the prompt `Fix the parser`
- **THEN** the state has no input of the prompt while the first turn runs, and after its end the prompt ends with `end_turn` and the reply `The parser reads each line now.`

#### Scenario: A Stop of the waiting prompt
- **WHEN** the prompt `Fix the parser` waits for the turn `Fix the lexer`, and the user stops it
- **THEN** the prompt ends with `cancelled`, the state has no input of the prompt, and the turn `Fix the lexer` ends

### Requirement: Prompt that loses its daemon
When the connection to the daemon ends after the daemon admitted a prompt, the prompt MUST end with `cancelled` and the notice `error.daemonLost`, not with the error of the connection. A prompt that finds no daemon MUST fail with the text `error.unavailable`.

Tests: `test/prompt-wait.test.mjs`

#### Scenario: The daemon stops during the turn
- **WHEN** the turn of the prompt `Fix the parser` runs, and the daemon closes its connections
- **THEN** the prompt ends with `cancelled`, and the chat shows the notice `error.daemonLost`

#### Scenario: No daemon at the prompt
- **WHEN** the daemon closed its connections, and the view sends the prompt `Fix the parser`
- **THEN** the prompt fails with the text `error.unavailable`

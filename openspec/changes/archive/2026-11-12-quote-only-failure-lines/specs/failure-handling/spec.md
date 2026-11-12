## MODIFIED Requirements

### Requirement: Line of the error output in the error of a run
The error of a failed run MUST then hold one line, at most 300 characters, of the other lines of the answer and of the error output: the last line with a word that names a failure. When no line has such a word, the error of the run MUST NOT hold a line of the error output, and the log keeps the whole end of the error output. It MUST NOT repeat a line that the answer part holds.

Tests: `test/error-output.test.mjs`, `test/child-secrets.test.mjs`

#### Scenario: A Node.js crash
- **WHEN** the agent writes a Node.js stack with the line `Error: Cannot find module 'missing'` and the last line `Node.js v22.12.0`, and exits with the code 1 before its answer to `session/new`
- **THEN** the error of the run says that the agent process ended with the exit code 1, and it holds `Error: Cannot find module 'missing'` and not `Node.js v22.12.0`

#### Scenario: A long line
- **WHEN** the last line of the error output has 1,000 characters and starts with `Error: `
- **THEN** the error of the run holds the first 300 characters of that line

#### Scenario: An agent process killed after its debug lines
- **WHEN** the agent writes `[session/create] sessionId=fake-session phase=settings durationMs=4 totalMs=12` and `[session/create] sessionId=fake-session phase=register durationMs=1 totalMs=2683` during the prompt, and its agent process ends with the signal SIGKILL
- **THEN** the error of the run is "The agent process ended with the signal SIGKILL after it got the task, so the task can have run in part. The log of the daemon, daemon/daemon.log in the state directory, has the details.", and the log holds the two lines

#### Scenario: A secret in the line
- **WHEN** the agent writes `Error: key=` and the key of Central in two chunks, and exits before its answer to `session/new`
- **THEN** the error of the run quotes the line with the key replaced, and it does not hold the key

## ADDED Requirements

### Requirement: Words that name a failure
A line MUST name a failure when it holds, in any case: error, fail, denied, refused, invalid, unauthorized, forbidden, cannot, unable, exception, quota, segmentation or unavailable, also in a longer word; or fatal, panic, panicked, abort, aborted, killed, terminated, died, not found, no such, timed out, timeout, missing, expired, not available, log in or rate limit as a whole word; or /login.

Tests: `test/error-output.test.mjs`

#### Scenario: A cause without the word error
- **WHEN** the line between two debug lines is `Segmentation fault: 11`, `thread 'main' panicked at src/main.rs:5:3`, `Killed: 9`, `sh: claude: command not found`, `Not logged in · Please run /login`, `insufficient_quota` or `Rate limit reached for the model`
- **THEN** that line is the reason

### Requirement: Words of the debug lines of the adapter
A word that the adapter of Claude Code writes in a normal debug line MUST NOT name a failure: missing after `=`, as in `resolution=missing`, rate limit in `rate limit status`, login without the slash before it, and permission. A debug field such as `timeoutMs=5` or `permissionMode=default` MUST NOT count.

Tests: `test/error-output.test.mjs`

#### Scenario: The debug lines of the adapter of Claude Code
- **WHEN** the lines are `[session/create] sessionId=0f3e phase=settings durationMs=4 totalMs=12`, `[session/fork] sessionId=0f3e phase=full-history durationMs=3 totalMs=9 resolution=missing`, `[idle-compaction] skip: rate limit status is allowed_warning`, a line with "a probe that found a different login" and a line with "sending the Bash permission request unattributed"
- **THEN** no line is the reason

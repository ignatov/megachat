# Design

## Context

`AcpRunService.execute` starts each Claude or Codex child through `child-supervisor.mjs`, which pipes the error output
of the agent to its own error output. The daemon counts the bytes of `child.stderr` for the limit of 1 MB and drops
the text. Each failure goes to the `catch` of `execute`: a `MegachatError` keeps its fixed text, and each other error,
an error answer of `session/new` included, gives `error.interrupted` and `autoResume: true`. `refused(...)` turns an
error answer of the mode or of the model into a `MegachatError` and drops the answer. `logFailure` writes
`describeError`, which holds no message. `MegachatState.transition` applies `redactOwnSecrets` to the error of a run.
The log is the error output of the daemon: `spawnDaemon` in `src/main.mjs` opens `daemon/daemon.log` with
`open(path, 'a', 0o600)`, so only a new file gets 0600.

### How the adapters build an internal error

The places are in `node_modules`, read-only, at the versions of `package-lock.json`.

- The ACP SDK, `@agentclientprotocol/sdk/dist/core/jsonrpc.js`: `errorToResult` (lines 144 to 158) turns each error of a
  request handler that is not a `RequestError` into the code -32603 with the message `Internal error`. Its `data` is
  `{ "details": <error.message> }` from `errorDetails` (lines 106 to 117). When the message is a JSON text, the `data`
  is that JSON value. So the message of the answer never holds the cause; the `data` holds it.
- `@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`: the handler of `session/new` (line 11461) calls
  `newSession`, then `createSession` (line 9035). That function starts Claude Code with `query()` and awaits
  `q.initializationResult()` (lines 9476 to 9488). A rejection goes out as `startupFailureError(error) ?? error`.
  `dist/startup-failure.js` gives a `RequestError` for a known start failure: `authRequired` for a reason of a login,
  `invalidParams` for `cwd_unavailable`, else `internalError` with `data.startupFailureReason` and the message of Claude
  Code. Each other error goes to `errorToResult`. On this path the adapter writes nothing to its error output.
- `@anthropic-ai/claude-agent-sdk/sdk.mjs` (minified): the process transport keeps `stderrTail`, the last 2,048
  characters (`Ok=2048`) of the error output of Claude Code after its own filter (`Tf`). `getProcessExitError` gives
  `Claude Code process exited with code <N>. stderr: <tail>` or `... terminated by signal <S>. stderr: <tail>`
  (`formatStderrTail`). So for a failed start of Claude Code, `data.details` holds the exit code and the end of the
  error output of Claude Code, and the error output of the adapter holds nothing.
- `@agentclientprotocol/codex-acp/dist/index.js`: the same `errorToResult` (line 25745). `logger.error` writes
  `[SYSTEM_ERROR] <message>: <error>` to the error output of the adapter when `APP_SERVER_LOGS` is not set (lines 27939
  to 27946). An exit of the Codex app-server gives a `RequestError` with the code 1001 (line 36057) and a message that
  holds the end of the error output of the app-server (`appServerExitedError`, lines 36102 to 36111). The error output
  of the app-server itself goes only to the file of `APP_SERVER_LOGS` (`attachLogs`, line 28159).

Decision: the chat reason holds the first line of the answer: the message, then `data.details`, else the JSON text of
`data`. Reason: for the incident of 2026-11-12, `Internal error` alone tells nothing new, and the cause, when the
adapter gave one, is in `data.details`. The other lines of the answer, such as the rest of a multi-line error output of
Claude Code or of the app-server, go to the picker of the line, with the error output of the adapter.
`test/fake-acp.mjs` copies these shapes: a plain `Error` that the SDK of the fake agent turns into -32603 with
`details`, an `authRequired` answer, a `RequestError` with a multi-line message, and an error output in chunks.

### Readers and printers of the log

- `spawnDaemon` in `src/main.mjs` gives the log file to the daemon as its standard output and error output. The daemon
  is the only writer.
- `megachat daemon` in a terminal writes the same lines to that terminal. The text is the same filtered and limited
  text.
- No path gives the log to a client. `start` and `acp` print only `error.unavailable` or the text of a `MegachatError`
  on a failure, and no text of the log. The bridge reads the event stream of the daemon, not the log. The IDE gets the
  error output of the bridge process, which never holds the log.
- The main agent has no tool that reads a file. A pi child reads only in its project. A Claude or Codex child runs as
  the user and can read each file of the user, the log included, as it can read the state. The filter covers this
  case.
- `test/live/smoke.mjs` reads the log and counts the lines of the guard of the scheduler. A line of an agent can hold
  the same words, so the count skips a line that starts with `  | `.

## Goals / Non-Goals

**Goals:**
- One place that keeps, filters and cuts the error output of a run, with fixed limits.
- The same filter for the log and for the error of the run.
- A fixed text that says whether the task reached the agent.

**Non-Goals:**
- No new field in the state. The error output is not durable: a restart of the daemon loses it, and the recovery gives
  `error.interrupted` as now.
- No change of the statuses or of the limit of 1 MB. The only change of the continuation rules is `authRequired`.

## Decisions

- **A buffer of the raw text, a filter at the read.** A `StringDecoder('utf8')` decodes each chunk, so a character in
  two chunks stays whole. The buffer keeps the last 8,000 characters and a flag that it dropped a start. The cut of the
  buffer must not separate the two halves of a character. The filter runs only at the read, on the whole buffer. A
  filter of each chunk, as the alternative, keeps the second half of a secret in two chunks, as the capability
  `secrets` explains for the chat text.
- **Functions in `src/SessionText.mjs`.** `errorOutputText` applies, in this order: the drop of the first word when the
  buffer dropped a start, the drop of the last word and of `known.partialEnd` when the error output did not end, the
  removal of ANSI escape sequences and control characters, `redactSecrets` with the `KnownSecrets` of the state, and at
  last the cut to the end of the limit. The removal comes before the filter, so an escape sequence in a secret does not
  hide the secret from a pattern. `answerText` gives the text of an answer through the same removal and filter.
  `reasonLine` picks the line of the reason. The run service and the tests use these functions, so one place holds the
  rules.
- **The full filter, not only the own secret.** `redactSecrets` is the filter of the session index. The rule of the
  capability `secrets` keeps the other patterns off the chat text of a child, because the main agent needs that text
  and the provider has it already. The error output and the answer did not go to the provider, and they are diagnostic
  text, so a wrong match costs little.
- **The wait for the end of the error output.** In the `catch`, for a failure that shows the error output, the service
  waits for the `close` of the child process, at most `errorOutputWaitMs` (an option, 2,000 ms by default). Then it
  kills the agent and waits at most a quarter of that time more. An agent that closed in the first wait, and that
  Megachat did not kill, ended by itself. A cancel, a limit, a stop for a message of the user and a stop of the daemon
  do not call the wait. A failure with a fixed text of Megachat and no answer does not call it either, because the agent
  is alive and the text needs no error output. Each test that reaches the wait sets the option to a short time.
- **The answer of the agent.** An error with an integer `code` is an answer. `refused(...)` keeps the answer as the
  `cause` of its `MegachatError`, so the log gets it and the run keeps the fixed text. The service names the method of
  the request that it awaits, and the flag `dispatched` tells whether the prompt went out.
- **The log entry.** `logFailure('log.child', ...)` stays the first line. Then `log.child.answer` with the method, the
  code, the message as a JSON string (at most 1,000 characters) and the data as JSON text (at most 2,000 characters),
  then `log.child.output` and the lines of the text with the prefix `  | `, or `log.child.noOutput`. The alternative of
  one JSON line per entry is easier for a program and harder for the user who reads the log; no program reads it.
- **The error of a run.** The fixed sentence comes from the resources: `error.child.answer.before`,
  `error.child.answer.after`, `error.child.exit.before` or `error.child.exit.after`, with `error.child.exitCode` or
  `error.child.signal`, and `error.child.login` first for the ACP code `authRequired` (-32000). Then
  `error.child.reply` with the first line of the answer, then `error.child.line` with the line of the picker, and then
  `error.child.log`. A `MegachatError` keeps its text. `autoResume` gets one more term: no `authRequired` answer.
- **The mode of the log.** `spawnDaemon` calls `chmod(0o600)` on the open handle of the log before it starts the
  daemon. On Windows, the call is skipped, as for the other files of the state.
- **State and ACP.** No field of `conversation.sqlite`, `settings.json` or another state file changes. The service reads
  the error answers of `initialize`, `session/new`, `session/load`, `session/set_config_option`, `session/set_mode` and
  `session/prompt`: `code`, `message` and `data`. It adds no ACP message and no `_meta` key. A disconnect of the ACP
  client does not touch a run, so the buffer stays until the end of the run. A restart of the daemon loses the buffer.

## Risks / Trade-offs

- [The patterns of the filter are a best effort] → A secret of another shape stays in the log and in the error of the
  run. The log is private (0600 in a directory of 0700), and the error of the run holds at most 600 characters of
  agent text.
- [A cut in a private key block] → When the drop of the start falls in a `PRIVATE KEY` block, the rest of the block has
  no `BEGIN` line, and the pattern does not match it. The same limit applies to the session index.
- [The word list of the reason picks a wrong line] → The log holds the full end of the error output.
- [The wait] → It delays only the end of a failed run, by at most 2.5 seconds.
- [A longer `error` in the result report] → At most about 900 characters for each failed run.

## Migration Plan

No migration. A state of v0.2.0 or v0.3.0 opens with no change. A rollback to v0.3.0 reads the longer `error` as text.

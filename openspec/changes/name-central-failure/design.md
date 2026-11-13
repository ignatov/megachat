# Design

## Context

See `proposal.md` for the reason. The facts below come from the code at dc66365 and from the packages in
`node_modules` (`@earendil-works/pi-durable` and `pi-ai` 1.5.1).

### Where each cause shows today

- The main agent gets its configuration from `central run pi` in `CentralConfigurationService.pi`
  (`src/CentralConfigurationService.mjs:82`). The call has a time limit of 15 s (`timeout: 15000`). The provider calls
  it as the `resolve` of its key (`:129`) before each model request. A failure writes the log line
  "Central gave no configuration to the main agent:" with `describeError` (`:97`), and it throws
  `MegachatError('central')`. The error of `execFile` tells the causes apart without its message:
  - `code` `ENOENT`: the command does not exist (the live check with no `~/.local/bin/central` logged `code=ENOENT`);
  - a number in `code`: the exit code of the command;
  - `killed` true and `signal` `SIGTERM`: the time limit;
  - a `SyntaxError` of `JSON.parse`, or the `MegachatError('central')` of `validate`: a configuration that Megachat
    cannot use.
- Each model request goes through the `fetch` of `logFailedRequests` (`:57`, added by the fix of the log). It sees the
  raw error of a request without a response, and the status of each response:
  - a `TypeError` with a cause of the code `ECONNREFUSED`: nothing listens at the address. `validate` accepts only
    `http://127.0.0.1`, so this is always the local proxy of Central;
  - another rejection, such as a cause of the code `ECONNRESET` or `UND_ERR_SOCKET`, or an `AbortError` of the stream
    time limit of 60 s (`STREAM_TIMEOUT_MS`): no response. A stop of the caller is no failure;
  - a response with the status 401 or 403: Central refused the request.
- pi-ai turns each of these errors into the text `errorMessage` (`pi-ai/dist/api/anthropic-messages.js:899-902`), and
  Pi Durable settles the input `unanswered` with the reason `model_error` and that text as `detail`
  (`pi-durable/dist/harness/generation.js:648-653`). The retry of Pi Durable is off (`harnessSettings`), so one failed
  request ends the turn.
- `PiMegachatService.finish` (`src/PiMegachatService.mjs:890`) gives the reason to `MegachatState.settleInput`
  (`src/MegachatState.mjs:844`), which keeps only the reason code in `inputs[requestId].reason` (`:878`).
- The ACP bridge waits with `/wait?submission=` (`src/DaemonServer.mjs:92`), which gives the input record, and it
  selects `error.model` or `error.interrupted` from `reason` (`src/AcpBridge.mjs:254`).

## Goals / Non-Goals

**Goals:**

- One text for each cause that the code can tell apart, with a command for the next step.
- The state and the chat get a fixed cause code and a fixed text, never a text of Central or of the provider.

**Non-Goals:**

- No new request to Central to find the cause, such as `central status`. The cause comes from the failure itself.
- No parse of the output of `central run pi`. It can hold the key, and its words are not a contract of Central.

## Decisions

### 1. The service of Central records the cause of its last failure

`CentralConfigurationService` gets a field `lastFailure = { cause, at }` in memory. `pi()` sets it in its `catch`, from
the fields of the error above. `logFailedRequests` sets it for a rejection and for the status 401 or 403. A response with
another status, and a successful `pi()`, set nothing: the cause stays with its time. The log lines stay as they are.

Alternative: put the cause into the error that pi-ai gets. pi-ai keeps only the text of the error, and Pi Durable keeps
only that text as `detail`. A cause code in that text would make the text a contract between Megachat and two
packages. Rejected.

### 2. The end of a failed reply takes the cause of its own time

`main.mjs` gives the service an option `centralFailure: () => configuration.lastFailure`. `finish` reads it when the turn
ends `interrupted` with the reason `model_error`. It takes the cause only when `at` is after the admission of the input
(`admittedAt`), so a cause of an earlier turn does not change the text. `settleInput` gets the cause as a fourth
argument and writes `input.cause`, a fixed code of at most 64 characters, next to `input.reason`.

A pi child and a keep-alive request use the same service of Central. A failure of one of them during the turn can set
the cause. That cause names the same Central and the same proxy, so its text is still true.

Alternative: one cause for each model request, through the `AbortSignal` or the session ID of the request. The `fetch`
gets the request of the SDK, not the turn of Megachat, so this needs a map from requests to turns. The time check is
simpler, and the error of it is small. Rejected for now.

### 3. The bridge selects the text by the cause

`AcpBridge.prompt` selects `error.central.<cause>` when `settled.cause` is one of the five codes, else the present rule.
A daemon of an earlier build gives no `cause`, so the bridge shows the present text. A bridge of an earlier build
ignores the field.

### State, restart and disconnect

- `conversation.sqlite`: the document `air.megachat` gets the optional field `inputs[requestId].cause`. An older state
  directory has no such field, and no migration is necessary.
- `lastFailure` is in the memory of the daemon. A restart loses it. A turn that a restart interrupts ends with another
  reason, so it does not need the cause.
- A disconnect of the ACP client changes nothing. The notice goes only to the bridge that waits for the reply, as now.
  A replay does not show the notice, as now.
- No ACP message and no `_meta` key changes.

## Risks / Trade-offs

- [The output of `central run pi` with an expired login is not known.] → The case `central_command` covers each failed
  command, and its text names `central login` first and `central repair` second. The task 4.2 records the real output
  and exit code in `docs/manual-checks.md`. A later change can split the case when Central gives a fixed exit code.
- [The status 401 or 403 can come from Anthropic behind the proxy, for a reason other than the login.] → The text says
  that the login "can have expired", not that it did.
- [`ECONNREFUSED` is only the local proxy because `validate` accepts only `127.0.0.1`.] → The test of `validate` stays,
  and a comment at the classification names this dependency.
- [A cause from a concurrent pi child.] → See decision 2. The text stays true for the same Central.

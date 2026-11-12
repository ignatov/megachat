# Proposal

## Why

A Claude or Codex child that fails at its start gives only "The process stopped. The previous request will not be sent
again." On 2026-11-12, each Claude child failed for about 15 minutes, because the adapter refused `session/new` with the
JSON-RPC error -32603 "Internal error". Nobody found the cause. The daemon counts the bytes of the error output of the
agent for the limit of 1 MB and drops the text. It also drops the `data` of the answer, and there the adapter puts the
cause: the message of the error, with the end of the error output of Claude Code (issue #28).

## What Changes

Where it shows: the chat, through the main agent, which gets the error of the run in its result report; the end line of
the transcript of the run, which holds the error of the run as now; and the log of the daemon. The task list of Air
does not change: the row of a run shows no error.

- **What the daemon keeps.** For each running Claude or Codex child, the daemon keeps the last 8,000 characters of the
  error output of the agent, in its memory only. When a request of the run gets an error answer, it keeps the method,
  the code, the `message` and the `data` of the answer. Reason: the `data` of an internal error of both adapters is
  `{ "details": <the message of the error> }`, and for a failed start of Claude Code that message holds the exit code
  and the end of the error output of Claude Code. 8,000 characters is twice the size that goes to the log, so the
  filter sees a secret at the edge of the log text as a whole, as the session index reads twice its limit.
- **The log of the daemon.** The log entry of a failed child run gets the answer of the agent (the message at most
  1,000 characters, the data as JSON text at most 2,000 characters) and the last 4,000 characters of the error output.
  Each line of the error output starts with `  | `, so no line of the agent looks like a line of the daemon. An ANSI
  escape sequence and each other control character, except the tab and the line break, go. Reason: the log is the
  place for the details.
- **The error of the run.** The error of a failed run gets a fixed sentence that says whether the task reached the
  agent, because the main agent acts on that fact:
  - an error answer before the prompt, or an agent process that ended before the prompt: Megachat did not send the
    task to the agent in this run;
  - an error answer of `session/prompt`, or an agent process that ended after the prompt went out: the agent got the
    task, so the task can have run in part.

  Each text is about this run, so it stays true when an automatic continuation sends the prompt again. Then come a
  short reason, at most 300 characters for each part, and a note that the log of the daemon has the details:
  - the first line of the answer: the `message`, then the `details` of the `data`, else the JSON text of the `data`.
    Reason: for the incident, the message "Internal error" tells nothing, and the `details` give the cause;
  - for the ACP error `authRequired`, the fixed text "The agent asks for a login." first, so the rule of the main
    agent runs `agents_accounts`;
  - for an agent process that ended by itself, its exit code or its signal;
  - the last line that names an error, from the other lines of the answer and the error output, else the last line that
    is not empty, when the first part does not hold it already. The last line of a Node.js crash is "Node.js v22...",
    so the line that names an error goes first.

  Reason: the user gets a cause that a person can act on, not a wall of text. The state keeps the error of a run, and
  the conversation and the provider get it in the result report, so the reason stays short.
- **Privacy and secrets.** Before the log or the error of a run gets a text of the error output or of an answer, the
  full secret filter of the session index applies to it: the exact values that the daemon knows (the key and the base
  URL of Central), the key after `/wire/`, and the patterns of other secrets, such as an `sk-` key, a Bearer token or a
  password in a URL. Reason: this text never went to a provider before, so the argument that keeps the other patterns
  off the chat text of a child does not hold here. A wrong match costs only a part of a diagnostic text. The filter
  runs on the whole kept text and not on each chunk, so a secret in two chunks goes as a whole. Each cut comes after
  the filter. When the daemon dropped the start of the output, the kept text starts after the first white space, so no
  second half of a secret stays. The state applies the filter of its own secret to the error of a run again, as now.
  No reader gives the log to the client, to the bridge or to the main agent. A daemon that runs in a terminal writes
  the same filtered and limited text to that terminal.
- **The file mode of the log.** The start of a daemon sets the mode 0600 on `daemon/daemon.log` also when the file
  exists with another mode. Today only a new file gets 0600. The directory `daemon` has the mode 0700, as now.
- **When the error output shows.** Only for a run that ends `interrupted` on a failure: a request that gets an error
  answer (from `initialize` up to `session/prompt`), or an agent process that ends by itself. A run that completes, a
  run that the agent ends with a stop reason, a cancel, a stop for a message of the user, a deadline, the limit of
  1 MB, and a stop of the daemon show no error output, and they do not wait for it. Before the read, the daemon waits
  for the end of the error output, at most 2 seconds, then stops the agent and waits at most 0.5 seconds more, because
  an adapter can write its error just after its answer. The wait is an option of the run service, so a test makes it
  short.
- **No continuation after a login error.** An answer with the ACP error `authRequired` ends the run with no automatic
  continuation, because a login does not come back by itself in the 25 seconds of the two continuations. This is one
  more term in the condition of `autoResume`.
- **What stays as today.** The limit of 1 MB of error output and its text, the statuses of a run, and each other rule
  of the automatic continuation: an error answer of `session/new` with another code still gets up to two
  continuations, and a refusal of the mode or of the model still gets none. The fixed texts of Megachat (the refused
  mode, the refused model, the HTTP MCP server, the load, the project base URL, Central) stay with no reason. The log
  entry of a refusal gets the answer of the agent and the error output.
- **Compatibility.** The change adds no field to the state, to `settings.json` or to another state file. The error of
  a run stays a text in the field `error`. A state of v0.2.0 or v0.3.0 opens as now, and a daemon of v0.3.0 opens the
  state of this build and reads a longer `error` as a text.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `failure-handling`: the log entry of a failed child run holds the filtered answer of the agent and the filtered end
  of its error output. The error of a failed run says whether the task reached the agent, and it holds a short reason.
  The log of the daemon gets the mode 0600 at each start.
- `secrets`: a new filter rule for the error output and the answer of an agent. The rule "One filter of the own secret
  of Megachat" names this text as an exception.
- `run-recovery`: the requirement "Automatic continuation" gets no continuation after the ACP error `authRequired`.

## Impact

- Code: `src/AcpRunService.mjs` (the buffer of the error output, the wait, the reason, the log entry, `autoResume`),
  `src/SessionText.mjs` (the functions that filter and cut the error output and pick the line of the reason),
  `src/messages.mjs` (a log entry with a block of agent text), `src/main.mjs` (the mode of the log),
  `resources/Megachat.properties` (the new texts), `test/live/smoke.mjs` (its count of the lines of the guard skips
  the lines of an agent).
- Tests: `test/fake-acp.mjs` gets the shapes of the answers and of the error output of the two adapters. A new
  `test/error-output.test.mjs`, and cases in `test/child-secrets.test.mjs`, `test/child-settings.test.mjs` and
  `test/launch.test.mjs`.
- `README.md`: the row of `daemon/daemon.log` says that it has the mode 0600 and holds the end of the error output of
  a failed child run.
- No ACP extension changes, so `docs/air-contract.md` and Air do not change.
- Out of scope: the pi child, which has no agent process. The account check of `agents_accounts`, which reads no
  error output. The transcript, which gets the error of the run at its end as now, and no more of the error output. The
  error output of a run that a deadline or the limit of 1 MB stopped. A Claude or Codex child runs as the user, so it
  can read the log, as it can read the state; the filter covers this case too. No non-goal changes.

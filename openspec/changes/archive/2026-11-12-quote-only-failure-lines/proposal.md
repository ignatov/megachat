# Proposal

## Why

The error of a failed Claude or Codex child run quotes one line of the error output of the agent (issue #28). When no
line names an error, it quotes the last line. A live run with the real adapter of Claude Code showed that this last line
is often a debug line. After a SIGKILL of the agent process, the error said: "The agent process ended with the signal
SIGKILL after it got the task, so the task can have run in part. Its error output says: [session/create]
sessionId=… phase=register durationMs=1 totalMs=2683 The log of the daemon, daemon/daemon.log in the state directory,
has the details." The debug line does not help a person, and it goes to the main agent and to the provider for nothing.

## What Changes

Where it shows: the chat, through the main agent, which gets the error of the run in its result report, and the end
line of the transcript of the run, which holds the error of the run. The log of the daemon and the task list of Air do
not change.

- **No last line.** When no line of the other lines of the answer and of the error output names a failure, the error of
  the run quotes no line. The fixed text (the answer, the exit code or the signal) and the note about the log stay. The
  log keeps the whole end of the error output, as now.
- **More words that name a failure.** A real cause without the word "error" still shows. The new words are fatal,
  panic, panicked, abort, aborted, segmentation, killed, terminated, died, not found, no such, timed out, timeout,
  missing, expired, not available, unavailable, log in, /login, quota and rate limit. Reason: these words name a crash,
  a missing file or command, a time limit, a login or a limit of the provider.
- **Whole words.** A short word counts only as a whole word, so a debug field such as `timeoutMs=5` does not count.
- **Words that the adapter writes in normal lines.** The adapter of Claude Code writes some of these words in normal
  debug lines, so they are narrower:
  - `missing` does not count after `=`, because the adapter writes `resolution=missing` when it forks a session;
  - `rate limit` does not count in `rate limit status`, because the adapter writes
    `[idle-compaction] skip: rate limit status is <status>`;
  - `login` counts only in `/login`, which Claude Code names in "Please run /login", because the adapter writes "a
    probe that found a different login" when the account changes;
  - the word `permission` is not in the list, because the adapter writes "sending the Bash permission request
    unattributed" in a normal line. A real permission failure says denied, forbidden or unauthorized, which the list
    holds.

  The Codex adapter writes its normal log lines only to a file that `APP_SERVER_LOGS` names, and Megachat does not set
  this variable. Its error output holds only error lines, which hold the word "error".

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `failure-handling`: the requirement "Line of the error output in the error of a run" changes, and the new
  requirement "Words that name a failure" holds the list of the words.

## Impact

- `src/SessionText.mjs`: the words of a failure and the line of the reason.
- `test/error-output.test.mjs`, `test/child-secrets.test.mjs`, `test/fake-acp.mjs`: the cases of the line, a new case of
  an agent that SIGKILL ends after its debug lines, the new words and the debug lines of the adapter.
- `test/live/smoke.mjs`: the check of the case 14.3 expects the error with no line of the error output.
- The change does not modify an ACP extension, so Air does not change.

## Out of scope

- The filter of secrets, the limits of 300, 4,000 and 8,000 characters, the log and the fixed texts do not change.
- The first ten words (error, fail, denied, refused, invalid, unauthorized, forbidden, cannot, unable, exception) do not
  change. The adapter of Claude Code writes "denied <tool> <id>, which the cancelled work asked for" in a normal line
  after a cancel of work. That line can still show as the reason.
- A warning of the adapter that holds a word of the list, such as "Ignoring permission mode ... not available in this
  session", still shows as the reason when no later line names a failure.
- The change touches no non-goal.

# Proposal

## Why

On 2026-11-14 a follow-up of a child (`agents_send`, run `e8239ae0-2f35-4312-b442-0d0884751738`, start 08:22:52Z) left
no line in `daemon/daemon.log`. The log had lines only until 08:18Z. The diagnosis needed `idea.log` and the jsonl file of
Claude Code. The log of the daemon has only the failures of a run, so a run that starts, ends or fails without a line
about its failure is invisible.

## What Changes

Where it shows: the log of the daemon, `daemon/daemon.log`. No chat text, command, setting or file changes.

- **A start line for each run.** A line when Megachat admits a run, with the run ID, the kind (`spawn`, `send`,
  `resume`, `continue`, `recovery`, `steer-restart`, `steer-followup`), the run that it continues, the child session
  ID, the provider session ID when it is known, the agent, the directory and the title.
- **An end line for each run.** A line with the run ID, the status (`completed`, `failed`, `cancelled`,
  `interrupted` or `timeout`), the duration in milliseconds, the stop reason, and the continuation that replaced the
  run.
- **An error line.** Before the end line of a run that failed or stopped on an error: the run ID, the class (`login`,
  `timeout`, `outputLimit`, `agentAnswer`, `agentExit`, `spawn`, `daemonStop`, `daemonRestart`, `stopReason`, the code
  of a refusal of Megachat, or `other`) and the first sentence of the error of the run.
- **No content.** A line never holds the prompt, the output, a token or a key. The error line holds only the first
  sentence of the error text, which is a fixed text of Megachat.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `failure-handling`: a new requirement for the lines of the start, the end and the error of a run. No present
  requirement changes.

## ACP and Air

No ACP extension changes, and `docs/air-contract.md` does not change. Air needs no change.

## Impact

- Code: `src/RunLog.mjs` (new), `src/MegachatState.mjs` (the lines go out after the commit of each change of a run),
  `src/AcpRunService.mjs` and `src/PiRunService.mjs` (the class of the error).
- Strings: `log.run.*` in `resources/Megachat.properties`.
- Tests: `test/run-log.test.mjs`.
- Documents: `README.md` (the row of `daemon/daemon.log`).
- No field of `conversation.sqlite`, `settings.json` or another state file changes.
- Out of scope:
  - A tool that reads the log.
  - A line for each permission request, tool call or steering message.
  - A rotation of the log.
  - No non-goal changes.

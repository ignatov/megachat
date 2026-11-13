# Proposal

## Why

A walk of the path of a colleague on 2026-11-14 asked the chat "Which version is this? Where is your log file?". The
main agent answered "I don't know either one", because no tool and no rule gives it the version or the path of
`daemon.log`. `agentInfo` has the version, but nobody knows whether Air shows it. Colleagues use Megachat since v0.6.2,
and a colleague with a problem asks the chat first.

## What Changes

Where it shows: the chat. The instructions of the main agent change, and no command, setting or file changes.

- **A section `about` of the instructions.** The main agent gets a section of its own with four facts: the version
  of the build of the daemon, such as `0.6.3` or `0.6.3+2.g1a2b3c4`, the state directory, the path of
  `daemon/daemon.log` in it, and the issue address `https://github.com/ignatov/megachat/issues`. The section has no
  connection token, no port, no Central base URL and no key.
- **An answer about a problem.** When the user asks for the version, the log, or how to report a problem, the main
  agent gives these facts and the issue address. It also says that the error output of the agent process goes to the
  log of the IDE, which Help | Show Log in Finder opens.
- **The private data rules.** The log path is a local path, and the log can hold private text: project names, paths,
  task prompts, file content and the error output of the children. The main agent tells the user to read the log, and
  to remove the private text, before they share a part of it. The main agent does not put the log or a part of it into
  an issue or another public place, and it does not give a child a task that does so.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `conversation`: new requirements for the facts of the section `about`, for the answer about a problem, and for the
  log in a public place. No present requirement changes. The section `settings` and the bundled rules stay as they are.

## ACP and Air

No ACP extension changes, and `docs/air-contract.md` does not change. Air needs no change.

## Impact

- Code: `src/PiMegachatService.mjs` (the section `about` of the main extension, with the version from
  `src/MegachatBuild.mjs` and the state directory that `src/main.mjs` passes already).
- Strings: `instructions.about` and `instructions.report` in `resources/Megachat.properties`.
- Tests: cases in `test/settings.test.mjs` (the section and its text, no token and no base URL, only the section goes
  again after a new version).
- Documents: `README.md` (the chat line in "Report a problem"), `docs/manual-checks.md` (one live run).
- No field of `conversation.sqlite`, `settings.json` or another state file changes.
- Out of scope:
  - A tool that reads the log, or a summary of the log for an issue.
  - An issue that Megachat writes or sends.
  - The path of the log in the last lines of the setup line (break 6 of the walk). That is a change of `setup.sh`.
  - A view of `agentInfo` in Air.
  - No non-goal changes.

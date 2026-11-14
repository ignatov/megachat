# Proposal

## Why

The author said on 2026-11-14: "we must be able to archive any session, else we do not clear this mess". On that day
20 agent sessions ran in terminals, and 16 of 18 Claude Code sessions had no activity for more than 24 hours (see
`docs/session-orchestrator-brief.md`). The change `session-triage` finds the `abandoned` sessions, but the user still
must find each tab, close it, and remember what the session did. The CMU tab study found that people keep tabs open
from fear of loss. An archive that keeps a card of the work, closes the process, and hides the session removes that
fear.

The archive must work for each session on the machine: Claude Code and Codex in a terminal, in herdr, in an IDE, and
the children of Megachat. A check on 2026-11-14 found that the products already have an archive state:

- Codex: the column `archived` of `threads` in `~/.codex/state_5.sqlite`, the folder `~/.codex/archived_sessions`
  (126 files), and the commands `codex archive <id>` and `codex unarchive <id>` of codex-cli 0.167.0.
- Claude Code: no archive command for an interactive session. `claude rm` removes only a background session from
  agent view. Air archives a Claude Code session with a title record `[archived] <title>` (types `custom-title` and
  `agent-name`) in the session log, and the sidecar `custom-title.json`, the same records that `/rename` writes. 16
  Claude Code logs of the last 60 days have such a title.
- pi: Air appends a `session_info` record with the same prefix to the session file.
- Air: it reads these states for its list. Before the mark, Air stops the workers of a Claude Code session.

## What Changes

Where it shows: the chat and the permission dialog of Air. Air shows the hidden state in its session list with no
change, because Megachat writes the marks that Air reads.

- **A tool `agents_archive`.** The actions are `archive` (one session or up to 50), `restore`, `list` and `search`.
- **The card.** Before each other step, Megachat writes a card of the session to `session-archive.jsonl` in the state
  directory: the title, the project, the dates, the first and the last prompt of the user, the last answer, the
  commits and the tickets that the log names, the changed files, and the command to continue. No model makes the card.
- **One confirmation for a batch.** The dialog names each session with its agent, project, age and warnings. The
  options are `archive` and `keep`.
- **The close of the process.** A live session with the owner `terminal` or `multiplexer` gets SIGTERM, then SIGKILL,
  after the confirmation, as an orphan does now. A session of an IDE or of a Megachat run is not stopped: the card
  is written, and the answer tells the user to archive it in its owner.
- **The hide.** After the process is gone: `codex archive <id>` for Codex; the title record `[archived] <title>` for
  Claude Code and pi, in the format of Air. `restore` reverses the hide and keeps the card.
- **The safety rules.** A session that works, has an open step, waits for a permission, or runs a tool is refused.
  Uncommitted files, unpushed commits, another live session in the same directory, and an activity in the last hour
  give a warning in the dialog.

## Capabilities

### New Capabilities

- `session-archive`: the tool, the card, the batch, the hide, the restore and the safety rules.

### Modified Capabilities

- `stop-sessions`: "Only an orphan" allows a stop of an idle session of a terminal or a multiplexer through a
  confirmed archive.
- `session-logs`: "Read-only access to the provider files" allows the archive and restore records, and only for a
  session with no live process.

## ACP and Air

No ACP extension changes, and `docs/air-contract.md` does not change, because the dialog is the present
`session/request_permission`. Air needs no change for phase 1. An IJAI ticket asks Air to keep the title prefix
`[archived] ` as a contract that an ACP agent may write, and to refresh its list on that record (see the brief).

## Impact

- Code: a new `src/SessionArchive.mjs` (card, checks, hide, restore); the tool in `src/PiMegachatService.mjs`;
  `src/AgentStop.mjs` takes the archive route; the rule in `resources/instructions.md`.
- State: a new file `session-archive.jsonl` in the state directory. An older state directory has no file, and the
  first archive makes it.
- Strings: the tool, the dialog and the warnings in `resources/Megachat.properties`.
- Tests: a new `test/archive.test.mjs`, and cases in `test/stop.test.mjs` and `test/session-logs.test.mjs`.
- Documents: `README.md` (a section "Archive a session"), `docs/manual-checks.md` (a live run on copies of the logs).
- Depends on: the change `session-triage` (the bucket `abandoned` gives the batch).
- Out of scope:
  - A model summary in the card. Phase 2 measures if the last answer is not enough.
  - A delete of a log, a worktree or a branch; `claude rm --discard-unpushed`; a move of a file in `~/.claude`.
  - A close of a terminal tab or of a herdr pane, and a focus of a window.
  - An archive of a pi child of Megachat in Pi Durable, which cannot archive (see `docs/roadmap.md`, item 9).
  - An automatic archive. Each archive needs the confirmation of the user.
  - The non-goal "a pi child does not run a command" does not change.

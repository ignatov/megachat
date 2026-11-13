# Proposal

## Why

The user asked to make the index of past sessions on by default. Today a new user gets the index only after a yes in
the setup, so most users never see the search in past sessions, the summary of the first pass, the status of the
running sessions in `agents_running`, and the notes. Everything stays local, and the import runs in the background.

## What Changes

Where it shows: the chat (the setup question, the summary of the first pass, the background task of the import), the
output of `agents_settings`, and `settings.json`. The task list of Air shows the import as before.

- **The default of `sessions.index` is `on`.** A first start (no `settings.json`) and a `settings.json` with the
  onboarding `pending` get the index at once. A stored value wins, as before. The setting has no environment variable.
- **An earlier user keeps off.** The setup of v0.6.3 and older stored no answer that was the current value, so a user
  who answered off, or skipped the setup, has no stored value. A `settings.json` without the new key `defaults`, with
  the onboarding `done` or `skipped` and no stored `sessions.index`, keeps the default `off`. The open does not change
  the file. The first write of the file stores `sessions.index` `off` and `defaults` 2. A file that the daemon cannot
  read gives `off` too, and the daemon writes the new file at once.
- **The setup keeps its three questions.** Question 2 asks the same text. It says that the default is on, that the
  import runs in the background, and that off deletes the index and the table of the running sessions. In the mode
  `ghost`, the likely answer keeps the current value, for example "Keep the index on".
- **A first pass without a session tells nothing.** A first pass that finds no session starts no event turn. Without
  this, each first start on a machine without agent sessions gets a model request that says "0 sessions".
- **The offer of `sessions.notes` is open after the setup** for a new user, because it needs only `sessions.index` on.
- **Tests do not read the sessions of the user.** `test/state-guard.mjs` sets `CODEX_HOME` and
  `PI_CODING_AGENT_SESSION_DIR` to empty temporary directories. The Claude sessions are already in the empty
  `CLAUDE_CONFIG_DIR` of the guard. The live smoke run stores `sessions.index` `off` in each of its homes.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `settings`: "Content of the settings file" (the key `defaults`), "Unreadable settings file" (the index stays off),
  "Settings of the index of past sessions" (the default `on`). New: "Settings file of an earlier build".
- `session-index`: "Setting of the index" (the default `on`), "Consent of the user" (the text of the setup question),
  "Summary of the first pass" (no summary without a session).
- `setting-offers`: the scenario "The open offers after the setup" of "Offer rules in the rules of the main agent".

No ACP extension changes, and Air needs no change.

## Out of scope

- No environment variable for `sessions.index`. The test guard isolates the session directories instead.
- The import does not wait for the setup. It starts at the first start of the daemon, as each start with the setting
  on does.
- No change of `sessions.days` (180) or `sessions.notes` (`off`).
- No version change and no release.

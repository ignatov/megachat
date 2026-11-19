# Design

## Context

Air reads `~/.jetbrains/acp.json` (agent `acp.megachat`), `acp-agents/installed.json` in the common data directory of
the IDE (macOS `~/Library/Application Support/JetBrains`, Linux `$XDG_DATA_HOME/JetBrains` or
`~/.local/share/JetBrains`, Windows `%APPDATA%\JetBrains`), and the overlay file
`~/.jetbrains/acp-registry-installed-overlay.json`. An overlay entry `agents["acp.registry.<id>"].agent.distribution.local`
replaces the distribution of an installed registry agent. Air accepts comments and trailing commas in that file, and it
never writes it.

## Goals / Non-Goals

Goals: no second Megachat row from `install`, a checkout that runs as the registry agent, and one question to a user who
has both agents. Non-goals: a change of the daemon, of the state directory or of the ACP extensions.

## Decisions

### 1. install

Without the registry agent, `install` does what it did. With it, `install` removes its own `acp.json` entry (`ownEntry`,
with a backup), and in a checkout it first writes the overlay entry. A failed overlay entry keeps the `acp.json` entry,
so a checkout keeps a start. An entry of the user stays: the dialog asks about it.

### 2. The overlay file

`install` reads the file strictly. Air accepts comments and trailing commas, but a write of the JSON loses them, so
Megachat does not change such a file: `install` prints the entry to add by hand. The write keeps each other key, the key order and the mode, and copies the file to `<file>.before-megachat-<UTC time>`.

### 3. The dialog

The bridge asks after the answer of `session/new` or `session/load`, after a wait of 1 second, so Air binds the view.
Air shows a request outside a turn while a view is connected. A request of a view without a turn stays until an answer.
One process shows one dialog at a time. The answer `remove` waits until no turn runs, and then removes the entry with a
backup, also an entry that the user changed. `keep` goes to the daemon (`POST /acp-entry`), which writes the key
`acpEntry` with the value `keep` to `settings.json`. Each later process asks the daemon first (`GET /acp-entry`).
`cancelled` is no choice: the next attach asks again. Before the removal, the bridge reads the files again: the entry
must be the entry of the dialog, and Air must still have the registry agent. The answer ends the tool call of the
dialog with a `tool_call_update`, as for a stop request.

### 4. State files, ACP messages and `_meta` keys

`settings.json` gets the optional top-level key `acpEntry`. An older file has none, so Megachat asks. The daemon gets
the route `/acp-entry`. The dialog uses `session/request_permission` and `_meta.jetbrains.air.permission`, as the stop
dialog. No new ACP message and no new `_meta` key.

### 5. Admitted work through a disconnect and a restart

The dialog does not change the daemon or its work. The removal waits for the end of a turn. A disconnect before an
answer gives `cancelled`, and the next attach asks again.

## Risks / Trade-offs

- [Air removes the row of `acp.megachat` while it shows the chat] → The user chose the removal, and the other row shows
  the same conversation.
- [Two processes ask at the same time] → Each shows one dialog. The second removal finds no entry.

## Migration Plan

No migration. A user with both agents gets the dialog once.

## Open Questions

1. Should `install` exit with 1 when Air has the registry agent and the `acp.json` entry of the user stays?
2. Should `install` in a checkout replace the overlay entry of another checkout? Now it keeps it.

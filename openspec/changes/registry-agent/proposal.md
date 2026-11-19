# Proposal

## Why

Air gives the application session (the first row of the session list) to two agent IDs (JetBrains/ultimate#1899):
`acp.megachat` of the `acp.json` entry `Megachat`, and `acp.registry.megachat-acp` of the ACP registry of the
organization. Both use the state directory `~/.jetbrains/air/megachat`, so both rows show one conversation. Megachat is
not in the public ACP registry, so a user outside JetBrains and a local test still need the `acp.json` entry. The only
problem is a machine with both agents: two Megachat rows. Megachat must make that state short, and it must ask the user.

## What Changes

Where it shows: the output of `install` and `uninstall`, `setup.sh`, and one dialog in the chat of Air.

- **`install`** keeps its behavior when `installed.json` of Air has no registry agent. When it has the registry agent,
  `install` writes no `acp.json` entry, and it removes the entry of an earlier `install`, with a backup. In a git
  checkout, it then writes the overlay entry `acp.registry.megachat-acp` to
  `~/.jetbrains/acp-registry-installed-overlay.json`, so Air starts the checkout for the registry agent. When the
  overlay entry is not in place, the `acp.json` entry stays.
- **One summary line.** `install` prints one line that starts with "Next step" for the case that it took. `setup.sh`
  shows that line again instead of its fixed text about `acp.json`.
- **The dialog.** When a view of Air attaches, and `installed.json` has the registry agent and `acp.json` has an entry
  `Megachat`, Megachat asks with `session/request_permission`, as for a stop request: "Megachat is installed two times",
  with the options "Remove the copy" and "Keep both". Keep goes to `settings.json`, and Megachat does not ask
  again. A cancel of Air is no choice.
- **`uninstall`** also removes the overlay entry of a checkout.
- `MEGACHAT_ACP_OVERLAY` and `MEGACHAT_ACP_INSTALLED` replace the paths of the overlay file and of `installed.json`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `install`: the case of the registry agent, the overlay entry, the summary line and the dialog.
- `uninstall` (the change `uninstall`, not archived yet): the removal of the overlay entry.

No ACP extension changes. The dialog uses `session/request_permission` with `_meta.jetbrains.air.permission`, as the
stop dialog does. `docs/air-contract.md` describes both agent IDs, the overlay entry and the dialog. Air needs no other
change.

## Out of scope

- A write of an overlay file with comments or trailing commas. Megachat prints the entry to add by hand.
- An entry in the public ACP registry.
- The automatic update of a copy of the registry agent.
- The change touches no non-goal.

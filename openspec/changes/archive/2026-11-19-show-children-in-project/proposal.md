# Proposal

## Why

The author asked: "make `true` the default of `children.showInProject` for all". Now a new Claude or Codex child session
goes to the Service Sessions group of Air, unless the user sets the setting.

## What Changes

Where it shows: the session list of Air.

- **The default.** `children.showInProject` is `true`. A new Claude or Codex child session shows in the session list of
  its project.
- **A stored value stays.** A user who stored `false` keeps `false`.

## Capabilities

### Modified Capabilities
- `child-settings`: the requirement "Child sessions in the session list of the project" gets the default `true`.
- `chat-view`: the requirement "Service sessions of delegated children" holds only when `children.showInProject` is `false`.

No ACP extension changes, so Air needs no change.

## Out of scope

- A session that Megachat recorded as a service session before. Air keeps its service origin.

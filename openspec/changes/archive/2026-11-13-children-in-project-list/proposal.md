## Why

Air hides each new Claude or Codex child of Megachat from the session list of its project, because Megachat records the session with `_session/service/record`. The user sees the child only as a background task of the Megachat chat, or in the Service Sessions group after the user checks `Show Service Sessions` in `Filter Sessions` of Air. The user wants to see the sessions of the children in the ordinary session list of the project.

## What Changes

- A new setting `children.showInProject` (`true` or `false`, default `false`) can have a project value, as the other settings of one child run.
- With `true` in the directory of a new Claude or Codex child session, the run is no service session. Megachat adds no address to `serviceSessions` and sends no `_session/service/record` for it, so Air shows the session in the session list of its project as an external session.
- A next run of the same child session keeps the choice of its first run.
- With the default `false`, nothing changes.

## Capabilities

### New Capabilities

### Modified Capabilities

- `child-settings`: the new setting `children.showInProject`.
- `project-settings`: the list of the settings that can have a project value.
- `chat-view`: a new delegated session is no service session when the setting is `true`.

## Impact

- `src/Settings.mjs`, `src/MegachatState.mjs`, `src/PiMegachatService.mjs`, `resources/Megachat.properties`, `resources/instructions-onboarding.md`, `README.md`, `docs/air-contract.md`.
- No ACP extension changes, so Air needs no change.
- Out of scope: a session that Megachat recorded before. Air keeps the service origin of a recorded session (`AgentSessionOrigin.mergedWith`), so that session stays in the Service Sessions group. A pi child has no session file, so it shows in no list.

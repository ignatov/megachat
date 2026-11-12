# compatibility Specification

## Purpose
A new release of Megachat opens the state, the settings and the history of an earlier release. The data of a removed function causes no error and starts no turn.

## Requirements

### Requirement: No watch of the project files
Megachat MUST NOT watch the files of a project, and a change of a file in a project MUST start no turn. The only file watch of the daemon is the watch of the provider roots of the session index. The daemon MUST have no route `/project-event`.

Tests: `test/integration.test.mjs`

#### Scenario: A report of a project change
- **WHEN** a client sends the directory, the revision `change-1` and the path `src/main.kt` to the route `/project-event` of the daemon
- **THEN** the request fails with the code `invalid`

### Requirement: Stored settings of the project events of v0.3.0
Megachat up to v0.3.0 watched the files of each project and reported a change in an event turn, with the settings `events.enabled` and `events.ignore`. A stored value of these two settings MUST cause no error, and `agents_settings` MUST NOT give them. The next write of `settings.json` MUST drop them. Another key that this build does not know MUST stay in the file.

Tests: `test/settings.test.mjs`

#### Scenario: Stored settings of the project events
- **WHEN** `settings.json` holds `events.enabled` false, `events.ignore` `["gen/**"]` and the unknown key `future.key`, and the user sets `reply.length` to `normal`
- **THEN** the action `get` of `agents_settings` gives no key that starts with `events.`, a set or a reset of these keys fails with the code `settingKey`, and the file then holds `future.key` and `reply.length` but not the two settings

### Requirement: State and history entries of the project events of v0.3.0
A state that holds the changes that waited for their event turn (`initiative.pending`) MUST open, and these changes MUST start no turn. An old history entry of such an event turn (`air.megachat.event` with the type `project`) MUST stay readable in the replay, the history tools and the search index.

Tests: `test/state.test.mjs`, `test/search-index.test.mjs`, `test/upgrade.test.mjs`

#### Scenario: A change that waited for its event turn
- **WHEN** the state holds a change of `/workspace` with the revision `one` and the path `src/main.kt` in `initiative.pending`, and the state opens
- **THEN** `initiative.pending` is empty, and the next automatic turn is the summary of the session index, not a turn of a project event

#### Scenario: An old project event in the search index
- **WHEN** the history holds an entry `air.megachat.event` with the type `project` for the path `src/GothicIcon.kt` in `/src/megachat-workspace`
- **THEN** a search for `gothicicon` or for `megachat-workspace` finds the entry with the role `event`

#### Scenario: An old project event after an upgrade
- **WHEN** the chat of the IDE loads a conversation of v0.2.0 with a project event for `notes.md`
- **THEN** the replay holds the reply "The notes changed. Nothing to do." and not the internal prompt of the event, and the history tool finds the entry with the role `event` for the query "project changed notes.md"

### Requirement: Open of a state of the last release
A state of the last release MUST open with the new release, after a stop and after a kill of the daemon. The open MUST write no failure to the log. Each run, permission request, report, suggestion and history entry of the state MUST stay, and each field that the new release added MUST get its default. `test/fixtures/v0.2.0/generate.mjs` makes the fixture with the code of the last release.

Tests: `test/upgrade.test.mjs`

#### Scenario: A state after a stop
- **WHEN** the new release opens a state that v0.2.0 left at a stop
- **THEN** the suggestion "Add a test for the parser." stays, `projects` is empty, `projectCreations` is empty, and the log has no failure

#### Scenario: The old conversation in the chat
- **WHEN** the chat of the IDE loads the conversation after the upgrade
- **THEN** the replay holds the reply "I started two tasks."

### Requirement: Recovery of a state of the last release
A dispatched run and a pending permission request MUST recover as after a restart of the same release. The search index of the state MUST stay in use.

Tests: `test/upgrade.test.mjs`

#### Scenario: A state after a kill
- **WHEN** the new release opens a state that v0.2.0 left at a kill
- **THEN** the dispatched run "Link check" continues in its provider session `link-session`, the run "Changelog" that waited for a permission continues in its provider session, and its permission request becomes `stale`

#### Scenario: The old search index
- **WHEN** the new release opens a state of v0.2.0
- **THEN** the search index keeps its last entry ID, and a search of the history finds a turn that the summary of v0.2.0 replaced in the model context

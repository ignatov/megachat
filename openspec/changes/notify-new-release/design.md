# Design

## Context

See proposal.md, "Why". The present code:

- `UpdateCheck` in `src/MegachatUpdate.mjs` checks the release 60 seconds after the start of the daemon and then every
  24 hours. While a higher release is available, `conditions()` runs directly after the check and then every 10
  minutes, also when `update.auto` is off: `allowed()` gives false, and the timer comes again.
- `src/main.mjs` makes the `UpdateCheck` with `selfUpdating: npxCopy(<package root>)` and `values()` of the settings.
- `MegachatState.writeUpdateNote()` writes the message after an update as an entry of the kind `air.megachat.note`
  with a write submission of Pi Durable. Its commit checks that no turn runs (`state.current`), that `pi.live.run` is
  absent and that the inbox is empty. `MegachatState.sessionNote()` uses the same checks for the notes about the
  sessions that wait. `SessionNotes` holds no note while `service.sleeping()` is true.
- The bridge sends each entry of the kind `air.megachat.note` to each view at once as an `agent_message_chunk` with the
  message ID `megachat-entry-<entry>` (`src/AcpBridge.mjs`), and the replay sends it again.
- `agents_settings set` fails with `settingEvent` in an automatic turn, so the note cannot make the main agent turn on
  `update.auto` without a turn of the user.

## Goals / Non-Goals

**Goals:**

- One note for each new release, for the colleagues who use a copy of npx with the default `update.auto` off.
- The note never lands inside a run and never starts a model request.

**Non-Goals:**

- A change of the message after an update, of the automatic stop, or of `status`.
- A setting to turn the note off. The note comes one time for each release, so the design does not add a setting.

## Decisions

### D1. The note waits for the timer of the conditions

The note goes out in `UpdateCheck.conditions()`, before the decision of the stop, through a new callback `note(release)`
of the `UpdateCheck`. `src/main.mjs` gives the callback: it returns at once for a daemon that is no copy of npx or with
`update.auto` on, and else it calls `service.releaseNote(release, version)`. That method returns at once while
`service.sleeping()` is true, and else it calls `MegachatState.releaseNote()`.

Alternative: a timer of its own, or the minute check of `SessionNotes`. Both add a second clock for the same release.
The timer of the conditions already runs every 10 minutes while a release is available, and the first call comes
directly after the check that finds the release.

### D2. The commit checks the work, as the other notes do

`MegachatState.releaseNote(release, version)` commits only when `state.current` is absent, `pi.live.run` is absent and
the inbox is empty. In the same commit it writes the entry and sets `state.update.noted = release`. So two checks that
run one after the other cannot write two notes, and a crash between the write and the record is not possible.

The entry is `{ kind: "air.megachat.note", data: { type: "release", available, version }, model: [noteMessage(text)] }`.
The kind is the kind of the other notes, so the bridge, the replay, the keep-alive request and the model context need no
change. The value `release` of `data.type` is new: no present code reads `data.type` of a note (the search index
reads it only for `air.megachat.event`), so an older build shows the entry as each other note.

This change depends on the open change of the message after an update (another proposal of the same night). That
change can change how an entry of the kind `air.megachat.note` goes to Air, for example so that it does not land in
the "Worked for" block of Air. The note of a release uses the same carrier, so it takes that change with no work of its
own. When that change gives the message after an update a carrier of its own, the note of a release stays on
`air.megachat.note`.

### D3. The field `update.noted`

The state document of `conversation.sqlite` gets `update.noted`: the release of the last note, or absent. The commit
compares the release with `higherVersion(release, noted)`. A state without the field, also a state without `update`,
counts as a state with no note. `recordVersion()` creates `update` at the start of the daemon, so the field `update`
exists before the first check. An older build keeps the field: `recordVersion()` changes only its own fields of
`update`, and the state keeps each field that it does not know.

The field is not reset after an update. After an update to `0.5.0`, `noted` `0.5.0` stays, and only a higher release
gets a note.

### D4. The text

One key `update.releaseNote` in `resources/Megachat.properties` with the release, the base version of the daemon and
the address `releaseUrl(release)`. The note gives no release notes: the message after an update gives them. The log
of the daemon gets one line `log.update.noted`, "Megachat wrote the note of the release {0}.", with no text of the
conversation.

The text says "restart the IDE when no task runs", because a new bridge stops the daemon of an earlier build at once,
also while a child task runs (issue #38, risk 4). The change does not change that.

### D5. Disconnects and restarts

The note is an entry of the conversation, so a view that attaches later gets it in the replay. A restart of the daemon
before the note keeps no wait: the next daemon checks the release again after 60 seconds and writes the note then,
because `noted` is still lower. A restart after the note keeps `noted`, so no second note comes.

## Risks / Trade-offs

- [A colleague does not restart the IDE] → The note comes one time for each release. A later release gets its own note.
  `status` keeps the notice.
- [The restart of the IDE during a child task interrupts it] → The text says "when no task runs". Run recovery
  continues the task, as today.
- [A copy of npx that Air starts from another path does not get the note] → `npxCopy()` is the same rule as the rule of
  the automatic stop, so the two rules agree.
- [The main agent tells the user about the release again in its next reply] → The note is a message of the assistant
  in the context, so the model knows that the user saw it. The rules of the main agent already say what a note is.
- [The peer change about the message after an update changes the carrier] → D2 takes that change.

## Migration Plan

No migration. The field `update.noted` comes with the first note. A rollback to an older build keeps the field and
writes no note.

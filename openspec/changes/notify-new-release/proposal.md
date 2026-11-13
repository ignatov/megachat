# Proposal

## Why

Colleagues use Megachat through the npx entry of `acp.json` since v0.6.2 (issue #40). The daemon finds a new release by
itself, but with `update.auto` off (the default) it shows the release only in the output of `status`. Nobody runs
`status` in a normal day. The daemon lives for days, so a colleague stays on an old release and does not learn that a
fix is out. A short note in the chat tells the colleague about the release and what to do.

## What Changes

Where it shows: the chat, as one note of Megachat. The note is a fixed text with no model request, as the notes about
the sessions that wait and the message after an update are.

- **One note for each new release.** When the daemon of a copy of npx with `update.auto` off finds a release that is
  higher than its own version, it writes one note into the conversation: "Megachat 0.6.3 is available. This chat runs
  0.6.2. To install it, restart the IDE when no task runs. Or ask me to turn on update.auto: then Megachat installs
  each new release when no work runs. What is new: https://github.com/ignatov/megachat/releases/tag/v0.6.3".
- **Not more than one note for a release.** The state records the release of the last note. The daemon writes no
  second note for the same release or a lower one, also after a restart of the daemon. A higher release gets its own
  note.
- **The note starts no work.** It goes out only when no turn runs, no run of the main conversation is live and no
  input waits, and not while the conversation sleeps. Else it waits for the next check of the conditions of the
  update, which comes every 10 minutes. It is no turn and no input, so it ends no idle time, starts no keep-alive
  request and starts no delegated work (see the capabilities `session-notes` and `automatic-turns`). The main agent
  sees it in its next model request. A turn of a child result cannot set `update.auto`, because an automatic turn
  changes no setting.
- **No note where the update does not apply.** A git checkout, the bundle and a copy outside `_npx` get no note: a
  restart of the IDE does not install a release there. They keep the notice in `status` only, as today. A copy of npx
  with `update.auto` on gets no note, because it updates itself when no work runs.

The present defaults stay: `update.auto` stays off, and `status` gives the same notice as today.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `update`: new requirements for the note of a new release, its conditions, its text, and the record of the noted
  release. The open change `automatic-update` adds the capability `update` and is not archived yet. This change adds
  requirements next to its requirements and modifies none of them. Archive `automatic-update` first.

The change of the plan of `automatic-update`: its proposal lists "A message in the chat about a new release while the
update waits, or with `update.auto` off" as out of scope. This change adds that message for the case `update.auto`
off. The message after an update ("Megachat updated from …") stays as it is.

## ACP and Air

No ACP extension changes. The note uses the same updates as the notes about the sessions that wait: an
`agent_message_chunk` with the message ID `megachat-entry-<entry>`. Air needs no change. `docs/air-contract.md` gets one
line in the part about the end of the agent for an update.

## Impact

- Code: `src/MegachatUpdate.mjs` (the decision of the note and its text), `src/MegachatState.mjs` (the field
  `update.noted` and the write of the note), `src/main.mjs` (the connection of the note to the check),
  `resources/Megachat.properties` (the text of the note and one log line).
- Tests: cases in `test/update.test.mjs`.
- Documents: `README.md` ("Update"), `docs/air-contract.md`.
- The state: a new field `noted` in the field `update` of the state document of `conversation.sqlite`.
- Out of scope:
  - The message after an update, its requirement and how it goes out. Another open proposal changes it.
  - A note in a git checkout or in the bundle.
  - A note again after a time, for a release that the user did not install.
  - A note when an automatic update did not install a release (the requirement "Stop without an update").
  - A change of `update.auto` or of its default.
  - A restart of the daemon by Megachat. Megachat starts no daemon and no `npx` for an update.
  - No non-goal changes.

# Design

## Context

A `session/cancel` of the main turn sets `current.cancelling` in the state and aborts the root conversation of Pi
Durable. Pi Durable then appends the committed partial reply as an assistant entry with the stop reason `aborted`. When
Pi Durable makes the model context, it leaves out each assistant message with the stop reason `aborted`, `error` or
`deferred` (`EXCLUDED_STOP_REASONS` in `pi-durable/dist/harness/context.js`). The chat shows the aborted entry, so the
user sees the partial text, but the model does not.

## Decisions

### A hidden assistant entry, not a change of the next user message

Megachat writes a new entry with the Pi Durable submission `write`, as the notes about the waiting sessions do. Pi
Durable appends a `write` at once and starts no model request. The entry has the kind `air.megachat.stopped`, the data
`{ "type": "stopped" }`, and one assistant message from `noteMessage` of `src/SessionNotes.mjs`: the provider
`megachat`, no usage and the stop reason `stop`.

Other forms were possible:

- A prefix in the next user message. The chat and a replay show the content of a user message, so the user would see
  the marker in the own message. A message of the user also must stay as the user wrote it.
- A user message with the marker, as Claude Code writes "[Request interrupted by user]". Then the context has two or
  three messages of the user one after the other again, and some providers refuse or merge such messages.
- A change of the aborted entry through an edit of Pi Durable. The entry belongs to Pi Durable, and the chat reads its
  text. A new entry keeps the record of Pi Durable as it is.

An assistant message keeps the order user, assistant, user. It also keeps the partial text, so the model knows what the
user saw, and a later "continue" of the user can continue from it. The marker is the last line of the message, so the
model reads it after the partial text.

### The text of the entry

`stoppedReplyText` of `src/ReplyStream.mjs` reads the newest 20 entries, the newest first, back to the start of the
turn: an entry `pi.user`, an entry `air.megachat.event`, a summary or a user message. The newest model message of the
turn gives the text:

- an assistant message with the stop reason `aborted`, `error` or `deferred`: its text blocks without the spaces at the
  end, a blank line, and the marker. Without text, the marker only;
- a tool result or the user message: the marker only. Pi Durable gives an `aborted` result to each tool call that did
  not run, so the context ends with a tool result;
- an assistant message with another stop reason: no entry. The turn ended with its full reply before the stop, and the
  model sees that reply.

The marker is `reply.stopped` in `resources/Megachat.properties`. The model reads it, and the history tool can show it,
so it is a string of the resources.

### The write lands before the next turn

`PiMegachatService.finish` reads the entries after the submission of the turn settled, so the aborted entry is there.
It passes the text to `settleInput`. `settleInput` writes the entry in the same commit that sets `current` to null. A
new message of the user needs `current` null, so the entry always comes before the next user message. `submit` waits
for the end of an interrupted automatic turn in the same way.

### Disconnect and restart

The entry is a committed entry of the root conversation in `conversation.sqlite`, as each other entry. A disconnect of
the ACP client does not change it. A daemon stop before the end of the turn ends the turn as interrupted on the next
start, and it writes no entry: that turn is no stop of the user. An older state directory has no such entry, and it
needs no migration.

## State and protocol

- `conversation.sqlite`: the new entry kind `air.megachat.stopped`. No field of the document `MegachatDoc` changes.
- No ACP message and no `_meta` key changes.

## Risks

- The partial text is in the context two times in the storage, but only one time for the model: Pi Durable leaves out
  the aborted message. The history tool and the search index leave out the new entry.
- A reply with tool calls before the stop keeps those calls and their results in the context, as now. The marker comes
  after the last result.

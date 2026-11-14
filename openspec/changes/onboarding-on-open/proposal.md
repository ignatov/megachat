# Proposal

## Why

A new user opens Megachat in Air and sees an empty chat. The setup (the agents, the index of past sessions, the known
repositories) starts only as part of the reply to the first message of the user: the main agent answers that message,
and then offers the setup. So the user must know that a first message starts something. The update message already
comes on its own, as a note, without a turn of the user. The first setup must do the same.

## What Changes

Where it shows: the chat of Air, as the first message of a new conversation.

- **A setup note on its own.** After the start, a daemon with the onboarding `pending` and an empty conversation
  writes one note of Megachat into the conversation. It is a fixed text, with no model request. It says that the setup
  has three questions (the agents, the index of past sessions, the known repositories), that the user can skip it,
  that the defaults then apply, and that the user can answer "yes" or "skip".
- **Same path as the update note.** The note is an entry of the kind `air.megachat.note`. It goes out only when no turn
  runs, no run is live and the inbox is empty. Else the daemon tries again each 10 seconds. A client that is not
  connected gets the note with the replay at its next connection.
- **Once.** The state keeps the field `onboardingOffer`: `null` before the note, `offered` after it, `dropped` when the
  user wrote first. The write of the note and the field are one commit, so a restart or a reconnect gives no second
  note. The first input of the user sets `dropped`, so the flow of today applies: the main agent offers the setup in
  its reply, and the note never comes. A state of an earlier build with a conversation gets `dropped`.
- **The setup rules know the note.** The next message of the user answers the note. The setup rules tell the agent not
  to offer the setup again when the note is in the conversation, and to start the setup at the answer "yes" with
  question 1 in full.
- **No note without a pending setup.** With the onboarding `done` or `skipped`, the daemon writes no note. A rerun of the
  setup (`agents_settings onboarding pending` in a turn of the user) works as before.

The daemon cannot see that the user types a message in Air. The note is not a model turn and starts nothing, so a note
that lands while the user types only adds a message. The change does not modify an ACP extension: the note is a
`agent_message_chunk` as the other notes. Air does not change.

Capabilities: `settings` (modified: content of the setup rules; added: setup note on its own).

Out of scope: a model turn at the open, a note in another language than English, a setup without a model.

# Design

## Context

See `proposal.md`. The update note (capability `update`, requirement "Message after an update") already gives a fixed
message with no turn. The setup asks questions with choices and stores answers with tools. Only a model turn can do
that, so the first setup question needs the answer of the user anyway.

## Decisions

### 1. A fixed offer, not a model turn

The note offers the setup, and the answer of the user starts the model turn. A turn that the daemon starts by itself
would spend a model request for each new install, also for a user who never looks at the chat, and it would need an
open and idle client session. The fixed note needs none of this and uses the path of the update note. The text is one
paragraph in `resources/Megachat.properties` (`onboarding.offer`).

### 2. The state

The field `onboardingOffer` of the conversation state is `null`, `offered` or `dropped`.
- `initialize` gives the field `dropped` when the conversation has an entry or an input, and `null`
  otherwise. So an older install with a pending setup gets no note.
- `submit` of the first user input sets `dropped` when the field is `null`.
- `writeOnboardingNote(pending)` checks the field, the turn, the live run and the inbox in one commit, writes the note
  and sets `offered`. It gives `true` when nothing is left to write.
- With the onboarding `done` or `skipped` the field stays `null` and no note is written. A rerun of the setup comes
  from a turn of the user, which sets `dropped` first.

### 3. The driver

`MegachatOnboarding.mjs` runs after the version record at the start of the daemon. It tries `writeOnboardingNote`, and
tries again each 10 seconds while a turn or an input blocks it. `close()` ends the tries at the stop of the daemon.
The state keeps the field, so the next daemon continues.

### 4. The rules

`resources/instructions-onboarding.md` gets a paragraph: when the conversation holds the note "Welcome to Megachat",
the offer is made. The agent does not offer again, and treats the next message as the answer. The existing rules
for accept, decline and ignore stay.

## Risks

- The user types while the note lands. The note is only a message, so this is harmless.
- A note in English for a user of another language. The model answers in the language of the user after the first
  message.

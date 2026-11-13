# Proposal

## Why

A restart of the daemon during a turn gave two errors in Air on 2026-11-13. The user asked to fix them.

- `Internal error: fetch failed`. The daemon stopped while the bridge waited for the end of the turn. The bridge gave
  the raw error of the HTTP client to Air.
- `Internal error: The current task is still running.` Air started a new bridge, and the new daemon continued the
  interrupted user turn. Air knew of no running turn, so it sent the next message of the user. The daemon refused it
  with `busy`, because it interrupts only an automatic turn for a new message.

## What Changes

Where it shows: the chat. The task list of Air and the log do not change.

- **A prompt waits for a turn that the view does not know.** When the daemon refuses a prompt with `busy`, the bridge
  waits until the current turn ends, and then it sends the prompt again. Air shows the prompt as running, and the
  chat shows the reply of the continued turn, then the reply to the prompt. A Stop of the waiting prompt ends it with
  `cancelled` and stops the running turn, because the chat shows that turn as the turn of the prompt.
- **A prompt that loses its daemon ends with a notice.** When the connection to the daemon ends after the daemon
  admitted the prompt, the prompt ends with `cancelled` and the notice `error.daemonLost`. The notice tells that the
  daemon continues the task after its next start. A prompt that finds no daemon fails with `error.unavailable`.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `chat-view`: two new requirements, "Prompt during a turn that the view does not know" and "Prompt that loses its
  daemon".

No ACP extension changes, and Air needs no change.

## Out of scope

- The bridge does not connect to the next daemon itself. It still ends its ACP connection when its daemon is gone (see
  the capability `daemon`), so the next start of Megachat goes through the entry.
- Air does not show the continued turn as running before the user sends a message. That needs a change in Air.

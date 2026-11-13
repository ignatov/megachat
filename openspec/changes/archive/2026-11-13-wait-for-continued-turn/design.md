# Design

## The wait for the end of another turn

`AcpBridgeSession.prompt` sends `/input`. For the code `busy` it waits, and then it sends `/input` again with the same
request ID. The daemon refuses `busy` before it records the input, so a repeated request admits the prompt once. The
wait ends at the first `tasks` event with no current turn, at a Stop, at the close of the view, or after 2 seconds, so
a missed event cannot keep the prompt.

The daemon keeps the admitted work through a disconnect and a restart, as before. The bridge keeps no new state.

## A lost daemon

A failed request that is not a `MegachatError` after the admission means a lost daemon. The prompt then sends the
notice `error.daemonLost` as a message of its own (`megachat-notice-<turn>`) and ends with `cancelled`. The view ends
the ACP connection 100 ms after the end of the event stream, so the prompt answer goes out first.

No state file, no ACP message and no `_meta` key changes.

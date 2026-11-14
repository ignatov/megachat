# Design

## Decisions

1. **Own copy, no read of the Air cache.** The cache path has a hash of the bundle and the IDE version
   (`IntelliJIdea2027.1`). It changes with each update. Megachat keeps its own short text in `resources/air-html.md`.
   The text is a copy of the rules of `SKILL.md` (the fence name, the rules of the page, the colors), without the long
   example. A manual check compares it with the Air skill on each change of the Air major version.
2. **When the section is on.** Setting `chat.html` in `settings.json`: `auto` (default), `on`, `off`.
   - `auto`: on when the `initialize` of Air has the capability `htmlFence` in `_meta.jetbrains.air.capabilities`;
     until Air adds it, `auto` is on for a client with `_meta.jetbrains.air.version >= 1` (the same test that the
     bridge uses for `air`). A client with no Air support never gets the section.
   - The ACP view tells the daemon the answer of its test with the attach. The daemon builds the instructions for the
     turn of that view. A turn of another view (an automatic turn) uses the last known value, saved in the state.
3. **Fields of the state.** `settings.json` gets `chat.html`. An older file has no key: the reader gives `auto`.
   `conversation.sqlite` gets no field. The last value of the support is one row `chat.htmlSupport` in the existing
   key-value table of the state (the daemon already keeps there the other notes of a client; if the table is not the
   right one, decide in task 1.1).
4. **Messages.** No new ACP message. The reply text goes in `agent_message_chunk` as today. `_meta` keys: read
   `_meta.jetbrains.air.capabilities` of `initialize` (existing code), no key is written.
5. **Fence safety.** Megachat does not change the text of the model. A check must show that the stream rate limit, the
   partial text, the replay and the compaction keep the fence whole. A fence that does not close shows as code in Air,
   so the instructions say: always close the fence.
6. **Daemon and restart.** The setting is read for each turn. The admitted work does not depend on it. After a restart
   the daemon uses the saved value until the next attach. A reply that was streamed with a fence replays from the
   stored entry as plain text, as any reply.
7. **Children.** A Claude child has `settingSources` `user,project,local`. It does not get the Air directory, and the
   spawn code does not add `--add-dir`. This is on purpose: a child result goes to the main agent, not to the chat of
   Air. A child task that asks for a visual returns the data, and the main agent draws it.
8. **The text of the skill is third-party text.** `resources/air-html.md` is written in ASD-STE100 like all texts of
   the project. It is an instruction of Megachat, not a user setting.

## Risks

- Air changes the fence name or the rules. The manual check and the ticket cover it.
- The size of the section in each prompt (about 700 tokens). It is in the cached prefix, so the cost is one time per
  cache life (see the capability `keep-alive`).
- The model draws a page when a table is enough. The text says: the shortest form first.

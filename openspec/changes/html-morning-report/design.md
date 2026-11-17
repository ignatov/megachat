# Design

## Decisions

1. **One flag, no new state.** `nextMorningReport` gets `html`. The service passes `this.html`, the value of `htmlOn`
   for `chat.html` and the Air support, which also decides whether the instructions hold the `air-html` rules. So the
   prompt asks for a page only when the rules of the page are in the instructions of the same turn.
2. **Three texts.** `event.morning` is the common head. `event.morning.text` or `event.morning.page` is the form.
   `event.morning.rules` holds the rules of both forms. `morningPrompt(html)` joins them in one line, so the data
   still follows the first line break.
3. **Persistence.** The prompt is made when the turn starts. A report that runs again after an interruption makes its
   prompt again, with the setting of that time. No state field and no file changes.

# Proposal

## Why

The author liked a morning report as a page in the chat: tiles, cards and bars. The author asked: "make such HTML reports
the default for all". Now the prompt of the report asks for plain text in three parts.

## What Changes

Where it shows: the chat. The morning report comes as one `air-html` page when HTML in the chat is on (`chat.html`
`on`, or `auto` with a client that has the Air support). Else it stays the text of three parts.

- **The page.** The title has the day and the period. Tiles: the finished child tasks, the commits, the releases, and
  the failed child tasks with the waiting permission requests. Cards: Done, Open, and one for each other project. A
  Money card keeps the key of Megachat and the other sessions apart, with a bar for each project. All numbers come
  from the report JSON. The next steps follow the fence as plain text.
- **The text.** `chat.html` `off`, or `auto` without the Air support, gives the same text as before.
- **The rules stay.** Start nothing, name a `separateResult` task in a few words, the `otherWork` `notShown` wording
  and the missing `otherSessions` status are in both forms.

## Capabilities

### Modified Capabilities
- `morning-report`: the requirement "Data in the prompt" gets the two forms of the report.

No ACP extension changes, so Air needs no change.

## Out of scope

- A new setting. The report follows `chat.html`.
- A page for the other automatic turns.

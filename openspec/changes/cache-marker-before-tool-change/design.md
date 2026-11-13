# Design

## Context

See proposal.md, "Why", for the problem. The present state:

- `CentralConfigurationService.models()` wraps the Anthropic provider of pi-ai. Its payload hook `omitThinkingText`
  calls the hook of Pi Durable and then changes the body. Each Anthropic request through Central goes through it: a
  turn of the main agent, a keep-alive request, a summary request, a reflection request and a request of a pi child.
- pi-ai 1.5.1 (`buildParams` and `convertMessages` of `dist/api/anthropic-messages.js`) puts three cache markers: on the
  last tool, on the system prompt, and on the last block of the last message. The catalog gives Claude Opus 5.5
  `supportsMidConvoSystemMessages` and `supportsMidConvoToolChanges`. So the tool list at the top of the body does not
  change, and a change of the tools is a system message with `tool_addition` and `tool_removal` blocks.
- pi-ai sends a later system message after the next user message. So in the first request of a turn after a change of
  the tools, the last message with a marker is that system message, and the marker is on its last `tool_addition`
  block. A system message with the effort of the turn follows it, without a marker.
- Pi Durable 1.5.1 (`planTools` of `dist/harness/prompt.js`) removes and adds again each tool when a changed tool is not
  the last tool. So one changed description gives 20 `tool_addition` blocks.

## Usage records of the author

The records are the `pi.assistant` entries of `conversation.sqlite` from 2026-11-09 to 2026-11-13, 798 requests of
Claude Opus 5.5. The table gives the requests that follow a change of the tools.

| Request | Gap before it | Input | Cache read | Cache write |
| --- | --- | --- | --- | --- |
| 2026-11-12 13:30 UTC | 48 s | 77,917 | 8,036 | 0 |
| 2026-11-12 13:31 UTC | 42 s | 86,398 | 8,036 | 0 |
| 2026-11-13 20:48 UTC | 34 min | 56,050 | 12,080 | 0 |
| 2026-11-13 21:53 UTC | 15 s | 52,902 | 12,673 | 0 |

The cache was warm before each of these requests. The next request of the turn read the earlier prefix again. All 11
requests after a change of the tools had this form, and no other request had an input above 3,000 tokens.

## Real run

A script sent four requests to Claude Opus 5.5 through Central on 2026-11-13, with the cache retention `long`, the
reasoning level `low`, four tools and synthetic text. Request 3 had a new user message and a change of one tool
description as Pi Durable gives it. The script printed token counts only. The total cost was 0.53 USD for three runs.

| Request | pi-ai markers: input / read / write | Moved marker: input / read / write |
| --- | --- | --- |
| 1. First turn, cold cache | 4 / 0 / 24,468 | 4 / 12,680 / 11,790 |
| 2. Second turn, 30 s later | 4 / 24,468 / 1,191 | 4 / 24,470 / 1,193 |
| 3. Third turn with the tool change | 14,868 / 12,680 / 0 | 698 / 25,663 / 1,193 |
| 4. Fourth turn | 4 / 25,659 / 3,077 | 4 / 26,856 / 1,888 |

With the markers of pi-ai, request 3 read only the tools and the system prompt, and it wrote nothing. With the marker
on the last block of the user message, request 3 read the whole earlier prefix, wrote its new user message, and sent
only the 698 tokens of the tool change as uncached input. Request 4 read the prefix through the tool change. The first
request of the second run read 12,680 tokens because the tools and the system prompt of the first run were still in
the cache.

## Goals / Non-Goals

**Goals:**

- The first request after a change of the tools reads the conversation from the cache.
- Each other request keeps the body that pi-ai gives.

**Non-Goals:**

- A change of pi-ai or of Pi Durable.
- Fewer tool changes. Pi Durable decides when a change of one tool removes and adds each tool.

## Decisions

### D1. The payload hook moves the marker

A new function of `src/CentralConfigurationService.mjs` gets the body after the hook of Pi Durable, in the same chain as
`omitThinkingText`. It looks for a block of the type `tool_addition` or `tool_removal` with a `cache_control`, from the
last message to the first. When it finds one, it removes that `cache_control` and puts it on the last block of the
nearest user message before it. When no user message is before it, or when the last block of that user message has a
type that cannot have a marker, the body stays as pi-ai gives it. A body without such a block stays the same object.

The number of markers stays the same, so the limit of 4 markers of the API is not a problem.

Alternative: the compat value `supportsMidConvoToolChanges: false` for the model. Rejected: pi-ai then changes the tool
list at the top of the body, and each tool change writes the whole context to the cache again, at 2 times the input
price.

Alternative: a fourth marker on the user message, and the marker on the `tool_addition` block stays. Rejected: it uses
the last free marker for no gain, because the API does not use the marker on the `tool_addition` block.

### D2. The tool change itself stays uncached in one request

The system message with the tool change comes after the moved marker. So the first request sends it as uncached input,
and the next request writes it to the cache. The tools and the system prompt of Megachat together are about 6,200
tokens, so a change of all 20 tools costs less than 0.03 USD of uncached input.

### D3. State, restart and ACP

The change adds no field to `conversation.sqlite`, `settings.json` or another state file, and it reads none. A restart
of the daemon and a disconnect of the ACP client do not change it, because the hook works on each request body only.
The change adds no ACP message and no `_meta` key.

## Risks / Trade-offs

- A later pi-ai can put the marker on another block. The hook then finds no marker on a tool change block and does
  nothing, so the cost is the cost of pi-ai.
- The API can later use a marker on a `tool_addition` block. The moved marker then still reads the same prefix, and the
  next request writes the tool change, so the cost does not go up.

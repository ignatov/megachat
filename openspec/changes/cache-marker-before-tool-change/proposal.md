# Proposal

## Why

After a change of the tools of the main agent, the first model request of the next turn reads only the tools and the
system prompt from the prompt cache. It sends the conversation as uncached input at the full input price, and it
writes nothing to the cache. The tools change at each update of Megachat that changes a tool description, and at each
change of `reply.suggestions`, which adds, removes or changes `agents_suggest` and `agents_feedback`.

The cause is the place of the cache marker. pi-ai 1.5.1 puts the cache marker of the messages on the last block of the
last message. With Claude Opus 5.5, pi-ai sends a change of the tools as `tool_addition` and `tool_removal` blocks of a
system message after the user message. So the marker is on a `tool_addition` block, and the API does not use it there.

The usage records of 4 days of real use have 11 such requests: 1,496,186 uncached input tokens, about 6.0 USD. A real
run through Central on 2026-11-13 confirmed the cause, and it confirmed that a marker on the user message before the
tool change reads the whole prefix (see design.md).

## What Changes

Where it shows: the cost of a turn in the log and in the spend of the day. The chat does not change.

- When the cache marker of the messages of an Anthropic request is on a `tool_addition` or `tool_removal` block,
  Megachat moves the marker to the last block of the last user message before that block. The request then reads the
  conversation from the cache and writes only the new part. Only the tool change itself is uncached input.
- Each other request keeps the cache markers that pi-ai gives.
- The rule applies to each Anthropic request through Central: a turn of the main agent, a keep-alive request, and a
  request of a pi child.

The change does not modify an ACP extension. Air does not change. `docs/air-contract.md` does not change.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `keep-alive`: a new requirement "Cache marker before a change of the tools" next to "Prompt cache lifetime".

## Impact

- `src/CentralConfigurationService.mjs`: the payload hook of the Anthropic provider, next to the hook that asks for
  thinking blocks without text.
- `test/keepalive.test.mjs`: a case for each scenario of the new requirement.
- `docs/manual-checks.md`: the record of the real run.
- No change of a dependency, of the state directory or of a setting.

Saving: about 3.8 USD for each million tokens of the conversation at each tool change, because a cache read costs
0.20 USD and an uncached input token costs 4 USD for each million tokens of Claude Opus 5.5. With a context of 60,000
tokens, that is about 0.23 USD for each tool change. In the usage records, the author had 7 tool changes in 51 hours
after the 1-hour cache came, about 0.9 USD a day. A user who only gets the updates has about one tool change for each
update.

Out of scope:

- A fix in pi-ai. The upstream fix is to put the marker on the last block that is not a tool change. The hook of
  Megachat then finds no marker on such a block and changes nothing.
- The other costs of the prompt cache in the usage records: the summary request reads no prompt cache, the morning
  report does not start the keep-alive window, and each summary writes the new prefix again. Each needs a proposal of
  its own.

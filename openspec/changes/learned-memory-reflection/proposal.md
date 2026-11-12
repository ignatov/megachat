# Proposal

## Why

This is slice 2 of issue #31. The capability `learned-memory` (slice 1, the archived change
`2026-11-12-learned-memory`) gives a memory that the main agent writes only when
the user states a rule or corrects the agent in a turn. A preference that the user shows over many turns, without a
rule, does not get into the memory. A background pass that reads the conversation can find it.

The deltas of this change add requirements to the capability `learned-memory` in `openspec/specs/`, and they change
the requirement of the settings that slice 1 changed.

## What Changes

Where it shows: the chat, through the next reply of the main agent; the file `<state>/memory.md`; and the log of the
daemon.

- **Reflection.** A background request reads the messages of the user and the replies of the main agent since the
  last pass, and adds entries through the write of the tool. It reads no tool call, no tool result, no child output,
  no note and no automatic turn. It never patches, removes or forgets an entry: it gives such a proposal as text. It
  runs after a summary and after 10 user turns, 60 seconds after the last turn, when no turn runs and the conversation
  does not sleep outside the working hours. A turn that starts during a pass does not stop it, and the pass makes one
  request. The transcript is a JSON array of items with a role, so a reply cannot fake a message of the user, and only
  an item of the user can be the source of an entry. A forget stops a pass, and no later pass reads the conversation
  before the forget. The setting
  `memory.reflection` (default `true`) turns it off. Each request counts in the daily spend, and no pass starts above
  the daily limit.
- **Notice.** The next reply of the main agent tells the line of each add, with the exact text, and each proposal.
  `remove` with the text of the entry takes back an add of the reflection. `undo` takes back only the newest write.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `learned-memory`: the requirements "Input of a reflection pass", "Reflection request", "Reflection only adds",
  "Reflection with the setting off", "Time of a reflection pass", "Form of the reflection transcript", "Grounding
  rule of the reflection", "Reflection pass during a turn", "Failed reflection pass", "Reflection after a restart",
  "Notice of the reflection in the next reply", "Reflection and the daily spend", "Forget and the reflection" and
  "Forget and the notice of the reflection" are new.
- `settings`: the requirement "List of the settings of the reply" names the settings `memory.*` of the capability
  `learned-memory`, and its scenario gives the default of `memory.reflection`.
- `spend-limit`: the requirement "Count of the spend" counts each reflection request.

## Impact

- Code: a new module `src/MemoryReflection.mjs` (the transcript, the parse of the answer, the pass and its schedule);
  `src/PiMegachatService.mjs` (the request, the start and the end of the turns, the notice in the section `memory`);
  `src/MegachatState.mjs` (the field `memoryReflection`, the count of the turns and the forget); `src/MegachatMemory.mjs`
  (the hooks `proceed` and `settled` of a write, and the text of the removed entry for the hook `forgotten`);
  `src/Settings.mjs` (the setting `memory.reflection`).
- Resources: a new `resources/reflection.md`, `resources/instructions.md`, `resources/instructions-onboarding.md`,
  `resources/Megachat.properties`.
- Tests: new `test/memory-reflection.test.mjs`; cases in `test/settings.test.mjs`, `test/upgrade.test.mjs` and
  `test/spend.test.mjs`.
- `README.md`: the row of `memory.reflection` and a short paragraph about the reflection.
- No ACP extension changes, so `docs/air-contract.md` and Air do not change. No new dependency.
- Out of scope: a pass that patches, removes or forgets an entry; a reflection for a child; a pass that reads a tool
  result or an automatic turn. No non-goal changes.

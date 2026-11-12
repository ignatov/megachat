# Proposal

## Why

This is slice 2 of issue #31. The change `learned-memory` (slice 1) gives a memory that the main agent writes only when
the user states a rule or corrects the agent in a turn. A preference that the user shows over many turns, without a
rule, does not get into the memory. A background pass that reads the conversation can find it.

This change depends on the change `learned-memory`. Archive `learned-memory` first: the deltas of this change add
requirements to its capability and change the requirement of the settings that it changes.

## What Changes

Where it shows: the chat, through the next reply of the main agent; the file `<state>/memory.md`; and the log of the
daemon.

- **Reflection.** A background request reads the retained conversation since the last pass and adds entries. It never
  patches or removes an entry: it gives such a proposal as text in the next reply. It runs after a summary and after
  10 user turns, when no turn runs. A turn of the user stops it. The setting `memory.reflection` (default `true`)
  turns it off. Each request counts in the daily spend, and no pass starts above the daily limit.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `learned-memory` (from the change `learned-memory`): the requirements "Reflection", "Time of a reflection pass",
  "Notice of the reflection in the next reply" and "Reflection and the daily spend" are new.
- `settings`: the requirement "List of the settings of the reply" names `memory.reflection` next to
  `memory.characters`.
- `spend-limit`: the requirement "Count of the spend" counts each reflection request.

## Impact

- Code: `src/PiMegachatService.mjs` (the pass, its schedule, the notice in the section `memory`);
  `src/MegachatState.mjs` (the field `memoryReflection`); `src/Settings.mjs` (the setting `memory.reflection`).
- Resources: a new `resources/reflection.md`, `resources/instructions-onboarding.md`, `resources/Megachat.properties`.
- Tests: new `test/memory-reflection.test.mjs`; cases in `test/settings.test.mjs`, `test/upgrade.test.mjs` and
  `test/spend.test.mjs`.
- `README.md`: the row of `memory.reflection` and a short paragraph about the reflection.
- No ACP extension changes, so `docs/air-contract.md` and Air do not change. No new dependency.
- Out of scope: a pass that patches or removes an entry; a reflection for a child. No non-goal changes.
